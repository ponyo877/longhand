import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import type { AudioDevice, ConfigurePayload, HelperToMain, PermissionsResultPayload } from '../shared/protocol';
import { isUiLanguage } from '../shared/i18n/locale';
import { mergeSettings, type Settings } from '../shared/settings';
import type { AppSnapshot, AsrTestResult, ConnectionTestResult, Customizations, DeepPartial, EngineStatus, FloaterState, HistoryItem, LonghandApi, PermissionStatus } from '../shared/types';
import { bindingLabel, extraKeys } from '../shared/keys';
import { AsrService } from './asr/AsrService';
import { ModelDownloader } from './asr/ModelDownloader';
import { decodeWav } from './audio/wav';
import { formatText } from './format/Formatter';
import { HelperClient } from './helper/HelperClient';
import { createProvider, isLlmConfigured, type LlmProvider } from './llm';
import { evalRoot } from './eval/files';
import { currentLocale, setUiLanguage, t } from './i18n';
import { createLogger, initLogs, redact } from './log';
import { llmFetch, lockDownRendererNetwork, modelFetch, preconnect } from './net/egress';
import { paths } from './paths';
import { DictationController } from './session/DictationController';
import { TextFixService } from './textfix/TextFixService';
import { CustomizationsStore } from './store/customizations';
import { HistoryStore } from './store/history';
import { RecordingStore } from './store/recordings';
import { SettingsStore } from './store/settings';
import { MicHealth } from './ui/micHealth';
import { buildHud, notificationDef, recordShown, shouldShow, type NotificationKey } from './ui/notifications';
import { AppTray, type TrayWarning } from './ui/tray';
import { FloaterWindow, ManagementWindow } from './ui/windows';
import { runDebugCapture } from './ui/debugCapture';
import { generateReadings } from './vocab/readings';
import { transcribeSelective } from './asr/selectiveHints';
import { applyLearning } from './learn/apply';
import { learnFromEdit } from './learn/Learner';
import { applyLoginItem } from './loginItem';
import { runMouseHoldSelfTest, runMouseRoutingSelfTest } from './ui/mouseRoutingSelfTest';
import { VirtualInputHelper } from './selftest/virtualInput';

declare const UI_VITE_DEV_SERVER_URL: string | undefined;

// ---------------------------------------------------------------------------
// Startup prerequisites
// ---------------------------------------------------------------------------

/**
 * Development evaluation (LONGHAND_EVAL). Given an evaluation config (a path to a JSON file, or the JSON itself), runs only the evaluation and quits.
 * Usage is at the top of scripts/eval-run.ts.
 *
 * So that it can run next to a running development app, the data folders (userData and logs) move to the evaluation folder before
 * the single-instance check. The settings in the real data folder are opened read-only during the evaluation (to borrow the endpoint and key; never written back).
 */
const EVAL_SPEC = !app.isPackaged ? process.env.LONGHAND_EVAL : undefined;
/** The real data folder (userData before it is moved for the evaluation) */
const REAL_USER_DATA = app.getPath('userData');
if (EVAL_SPEC) {
  const profile = path.join(evalRoot(), 'app-profile');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
  app.setAppLogsPath(path.join(profile, 'logs'));
  // Evaluations show no windows and no Dock icon
  app.dock?.hide();
}

/**
 * Development end-to-end self-test (LONGHAND_DEBUG_SELFTEST=e2e, selftest/e2e.ts). It always runs in a temporary profile.
 */
const SELFTEST_E2E = !app.isPackaged && process.env.LONGHAND_DEBUG_SELFTEST === 'e2e';
/**
 * Development: run in a fresh temporary profile (LONGHAND_DEBUG_PROFILE=temp), so that the user's settings, dictionary and history
 * are neither touched nor shown (for screen captures, for example). The real profile's single-instance lock is taken first, so it
 * never runs next to a running Longhand (two helpers would compete for the keyboard). Speech models are read from the real profile.
 */
const TEMP_PROFILE = !app.isPackaged && (SELFTEST_E2E || process.env.LONGHAND_DEBUG_PROFILE === 'temp');
const haveLock = app.requestSingleInstanceLock();
if (haveLock && TEMP_PROFILE) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), SELFTEST_E2E ? 'longhand-selftest-' : 'longhand-temp-'));
  app.setPath('userData', profile);
  app.setAppLogsPath(path.join(profile, 'logs'));
}
if (!haveLock) {
  // Prevent a second instance (CORE-2)
  if (TEMP_PROFILE) console.error('Longhand is already running. Quit it before running in a temporary profile.');
  app.quit();
  process.exit(SELFTEST_E2E ? 1 : 0);
}
/** Development: show the interface in this language without saving it (LONGHAND_DEBUG_UI_LANGUAGE=en or ja) */
const DEBUG_UI_LANGUAGE = !app.isPackaged && isUiLanguage(process.env.LONGHAND_DEBUG_UI_LANGUAGE) ? process.env.LONGHAND_DEBUG_UI_LANGUAGE : null;

initLogs(paths.logs);
const log = createLogger('main');

const settings = new SettingsStore(paths.file('settings.json'));
if (SELFTEST_E2E) {
  // The self-test profile: no hotkeys (the test presses them virtually), no sounds, no change to the system's globe key setting
  settings.update({
    onboardingComplete: true,
    playSounds: false,
    suppressGlobe: false,
    learning: { enabled: false },
    hotkeys: { activate: [], lock: [], cancel: [], paste_last: [] },
  });
}
/** The system's preferred languages, most preferred first (macOS: System Settings > General > Language & Region) */
const systemLanguages = (): string[] => {
  try {
    return app.getPreferredSystemLanguages();
  } catch {
    return [];
  }
};
setUiLanguage(DEBUG_UI_LANGUAGE ?? settings.get().uiLanguage, systemLanguages());
/** Speech models. The self-test reads them from the real profile */
const modelsDir = TEMP_PROFILE ? path.join(REAL_USER_DATA, 'models') : paths.models;
const customizations = new CustomizationsStore(paths.file('customizations.json'));
const recordings = new RecordingStore(paths.recordings, () => ({
  hours: settings.get().recordingRetentionHours,
  maxMB: settings.get().recordingMaxMB,
}));
const history = new HistoryStore(
  paths.file('history.json'),
  () => settings.get().historyLimit,
  (evicted) => recordings.remove(evicted.audioFile),
);
const helper = new HelperClient(paths.helperExecutable);
/** In the end-to-end self-test, the controller gets virtual hotkeys and audio instead of the keyboard and microphone */
const virtualInput = SELFTEST_E2E ? new VirtualInputHelper(helper) : null;
const asr = new AsrService(
  () => settings.get().asr,
  (engine) => paths.asrWorker(engine),
  modelsDir,
  () => settings.get().language,
  paths.bundledModels,
);
// textfix's tokenizer. Loaded in the background only when a rule that uses it (fillers, notation, particles) or learning from edits is on (it adds about 200MB of memory)
const textfix = new TextFixService(() => paths.linderaWasm);
// Learning from edits also uses the tokenizer to cut out words and get their readings
const needsTokenizer = (s: Settings) => s.language === 'ja' && ((s.textFix.enabled && (s.textFix.fillers || s.textFix.notation || s.textFix.particles)) || s.learning.enabled);
const models = new ModelDownloader({ modelsDir, bundledDir: paths.bundledModels, fetch: (url, init) => modelFetch(url, init) });
const floater = new FloaterWindow();
const management = new ManagementWindow();
let tray: AppTray | null = null;
let controller: DictationController | null = null;
let quitting = false;
let permissions: PermissionStatus = { accessibility: false, microphone: 'undetermined', helperRunning: false };
let devices: AudioDevice[] = [];
let hotkeyTestListeners = false;

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

let cachedProvider: { key: string; provider: LlmProvider } | null = null;

/** The self-test with LONGHAND_SELFTEST_LLM=saved borrows the saved connection, read-only (the key is decrypted only in memory) */
let selfTestProvider: LlmProvider | null = null;

function getProvider(): LlmProvider | null {
  if (SELFTEST_E2E) return selfTestProvider;
  const s = settings.get();
  if (s.skipLlm) return null;
  const apiKey = settings.getApiKey();
  if (!isLlmConfigured(s.llm, !!apiKey)) return null;
  const key = JSON.stringify(s.llm) + apiKey.length;
  if (cachedProvider?.key === key) return cachedProvider.provider;
  try {
    const provider = createProvider(s.llm, apiKey, llmFetch);
    cachedProvider = { key, provider };
    return provider;
  } catch (e) {
    log.warn('Could not create the LLM provider', e);
    return null;
  }
}

function llmEndpointForPreconnect(): string | null {
  const { llm } = settings.get();
  if (llm.provider === 'anthropic') return llm.baseUrl || 'https://api.anthropic.com';
  return llm.baseUrl || null;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const SYSTEM_SETTINGS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  keyboard: 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension',
};
const DAY_MS = 24 * 3600_000;

type HudRun = { id: string; label: string; run: () => void };
/** Actions of buttons passed by callers (`${notification id}:${button id}`) */
const hudActions = new Map<string, () => void>();
/** Actions of the buttons that notifications always carry (N2) */
const BUILTIN_ACTIONS: Record<string, () => void> = {
  'open-history': () => management.open('history'),
  'open-audio': () => management.open('settings/audio'),
  'open-connection': () => management.open('settings/connection'),
  'open-mic-privacy': () => void shell.openExternal(SYSTEM_SETTINGS.microphone),
  'open-accessibility': () => void shell.openExternal(SYSTEM_SETTINGS.accessibility),
  'restart-helper': () => void helper.restart().catch((e) => log.error('Failed to restart the helper', e)),
};
/** Notifications shown until resolved (key to the id on screen) */
const stickyHuds = new Map<string, string>();
/** Notifications shown in this launch (for once-per-launch) */
const shownThisRun = new Set<string>();
/** Notifications held back while recording or processing (learned words, for example) */
let deferredHuds: { key: NotificationKey; vars: Record<string, string>; actions: HudRun[]; at: number }[] = [];
/** Held-back notifications older than this are dropped */
const DEFER_MAX_MS = 30_000;

/** Placeholder values built from the settings (F4: notifications show the actual key bindings) */
function hotkeyVars(): Record<string, string> {
  const h = settings.get().hotkeys;
  const locale = currentLocale();
  const paste = bindingLabel(h.paste_last[0], locale);
  return {
    activate: bindingLabel(h.activate[0], locale) || 'fn',
    cancel: bindingLabel(h.cancel[0], locale) || 'esc',
    lockExtra: bindingLabel(extraKeys(h.lock[0] ?? [], h.activate[0] ?? []), locale),
    paste: paste ? t('hud.paste.withKey', { key: paste }) : t('hud.paste.fromMenu'),
  };
}

function micVars(mic: string): Record<string, string> {
  const silence = !mic ? t('hud.silence.unknown') : /macbook/i.test(mic) ? t('hud.silence.laptop', { mic }) : t('hud.silence.mic', { mic });
  return {
    mic: mic || t('hud.mic.fallback'),
    micParen: mic ? t('hud.mic.paren', { mic }) : '',
    silenceDetail: silence,
  };
}

function showHud(key: NotificationKey, vars: Record<string, string> = {}, actions: HudRun[] = []): void {
  const def = notificationDef(key);
  if (!def) return;
  if (def.deferWhileBusy && floater.getState().phase !== 'idle') {
    deferHud(key, vars, actions);
    return;
  }
  const s = settings.get();
  const now = Date.now();
  // When formatting keeps failing, show it small from the second time on (N9)
  if (key === 'LlmFailed') {
    const last = s.notifications.LlmFailed?.last ?? 0;
    if (now - last < 10 * 60_000) {
      showHud('LlmFailedRepeat');
      return;
    }
  }
  if (key === 'HoldLongHint' && !s.hotkeys.lock[0]?.length) return;
  // Several learned words become a count, to fit on one line (N10)
  if (key === 'WordsLearned' && vars.words?.includes('」「')) {
    const words = vars.words.split('」「');
    showHud('WordsLearnedMany', { first: words[0], count: String(words.length) }, actions);
    return;
  }
  if (!shouldShow(key, def, s.notifications[key], now, shownThisRun)) return;
  const msg = buildHud(
    key,
    // Empty values from the caller ('' when the microphone name is unknown, for example) do not override values known here
    { ...hotkeyVars(), ...micVars(vars.mic || session.mic || micHealth.lastDevice), ...Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== '')) },
    actions.map((a) => ({ id: a.id, label: a.label })),
  );
  for (const a of actions) hudActions.set(`${msg.id}:${a.id}`, a.run);
  shownThisRun.add(key);
  settings.update({ notifications: { ...s.notifications, [key]: recordShown(s.notifications[key], now) } });
  if (msg.durationMs === 0) stickyHuds.set(key, msg.id);
  if (def.sound && s.playSounds) floater.sound(def.kind === 'error' ? 'error' : 'notify', s.soundVolume);
  floater.hud(msg);
}

/** Removes a notification that was resolved (permission restored, microphone connected, and so on) */
function resolveHud(key: NotificationKey): boolean {
  const id = stickyHuds.get(key);
  if (!id) return false;
  stickyHuds.delete(key);
  floater.dismissHud(id);
  return true;
}

function deferHud(key: NotificationKey, vars: Record<string, string>, actions: HudRun[]): void {
  const prev = deferredHuds.find((d) => d.key === key);
  if (!prev) {
    deferredHuds.push({ key, vars, actions, at: Date.now() });
    return;
  }
  // Words learned in a row are merged into one notification (N10)
  if (vars.words) prev.vars = { ...prev.vars, words: [prev.vars.words, vars.words].filter(Boolean).join('」「') };
  for (const a of actions) {
    const same = prev.actions.find((x) => x.id === a.id);
    if (same) {
      const first = same.run;
      same.run = () => {
        first();
        a.run();
      };
    } else prev.actions.push(a);
  }
  prev.at = Date.now();
}

function flushDeferredHuds(): void {
  const now = Date.now();
  const list = deferredHuds;
  deferredHuds = [];
  for (const d of list) if (now - d.at <= DEFER_MAX_MS) showHud(d.key, d.vars, d.actions);
}

// ---------------------------------------------------------------------------
// What is shown based on how recording goes (supporting F1, F5, N6, N7, N12)
// ---------------------------------------------------------------------------

const micHealth = new MicHealth(paths.file('mic-health.json'));
/** Record of the session being recorded */
const session = { active: false, startedAt: 0, mic: '', changeShown: false };
/** Whether the user tried to record while speech recognition was preparing (tell them when it is ready) */
let triedWhilePreparing = false;
let asrWasReady = false;
let flashTimer: NodeJS.Timeout | null = null;

function onFloaterState(patch: Partial<FloaterState>): void {
  const prev = floater.getState();
  floater.setState(patch);
  const next = floater.getState();
  const recording = (p: FloaterState['phase']) => p === 'recording' || p === 'locked';

  if (!recording(prev.phase) && recording(next.phase)) {
    session.active = true;
    session.startedAt = next.startedAt ?? Date.now();
    session.mic = '';
    session.changeShown = false;
    micHealth.begin();
    if (!asr.ready) triedWhilePreparing = true;
    if (next.flash) floater.setState({ flash: null });
  }

  // Tell the user when recording starts with a different microphone than last time (N7)
  if (session.active && patch.micName && patch.micName !== session.mic) {
    session.mic = patch.micName;
    const before = micHealth.lastDevice;
    micHealth.lastDevice = patch.micName;
    if (before && before !== patch.micName && !session.changeShown) {
      session.changeShown = true;
      showHud('MicrophoneChanged', { mic: patch.micName });
    }
  }

  if (session.active && recording(prev.phase) && !recording(next.phase)) {
    session.active = false;
    // Report a quiet microphone (N6). If the controller sent no microphone name, guess it from the settings
    session.mic ||= guessMicName();
    const verdict = micHealth.end(session.mic, Date.now() - session.startedAt);
    if (verdict?.quiet) showHud('QuietMicrophone', { mic: session.mic });
  }

  if (prev.phase !== 'idle' && next.phase === 'idle') {
    flushDeferredHuds();
    // After a successful paste, show it briefly on the idle bar (F5)
    if (prev.phase === 'finalizing' && prev.stage === 'pasting') {
      const last: HistoryItem | undefined = history.list()[0];
      if (last?.paste === 'pasted' && Date.now() - last.timestamp < 10 * 60_000) {
        floater.setState({ flash: 'pasted' });
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => floater.setState({ flash: null }), 1300);
      }
    }
  }
  updateTray();
}

/** Name of the microphone that should be recording (the chosen one, or else the system default) */
function guessMicName(): string {
  const id = settings.get().microphoneId;
  return (id && devices.find((d) => d.id === id)?.name) || devices.find((d) => d.isDefault)?.name || '';
}

function onLevel(rms: number): void {
  floater.level(rms);
  if (!session.active) return;
  // The controller detects no sound while recording (MicNoSignal) from the peak and reports it
  micHealth.push(rms);
}

/** Tells the user that speech recognition is ready (N12) */
function onAsrStatus(): void {
  if (asr.status !== 'ready' || asrWasReady) return;
  asrWasReady = true;
  const s = settings.get();
  if (!s.onboardingComplete) return;
  const lastUse = history.list()[0]?.timestamp ?? 0;
  const lastShown = s.notifications.AsrReady?.last ?? 0;
  const longAway = lastUse > 0 && Date.now() - lastUse > DAY_MS && Date.now() - lastShown > 7 * DAY_MS;
  if (triedWhilePreparing || longAway) showHud('AsrReady');
}

// ---------------------------------------------------------------------------
// Broadcasting state
// ---------------------------------------------------------------------------

function engineStatus(): EngineStatus {
  return {
    helper: helper.status,
    asr: asr.status,
    asrMessage: asr.message || asr.modelDescription,
    llmConfigured: !!getProvider() || settings.get().skipLlm,
  };
}

/** For screen capture (LONGHAND_DEBUG_CAPTURE): temporarily changes permissions and state to check how they are shown */
const debugOverride: { permissions?: Partial<PermissionStatus>; status?: Partial<EngineStatus>; history?: HistoryItem[] } = {};

function snapshot(): AppSnapshot {
  const s = settings.get();
  return {
    settings: { ...s, llm: { ...s.llm, apiKeyEnc: '' } },
    hasApiKey: settings.hasApiKey(),
    customizations: customizations.get(),
    status: { ...engineStatus(), ...debugOverride.status },
    modelDownload: models.state,
    permissions: { ...permissions, ...debugOverride.permissions },
    version: app.getVersion(),
    paths: { userData: paths.userData, logs: paths.logs, recordings: paths.recordings, models: paths.models },
    locale: currentLocale(),
  };
}

let broadcastTimer: NodeJS.Timeout | null = null;
function broadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const snap = snapshot();
    management.send('snapshot', snap);
    floater.win?.webContents.send('snapshot', snap);
    updateTray();
    updateFloaterVisibility();
  }, 50);
}

function statusLine(): string {
  if (controller?.isRecording) return t('tray.status.recording');
  if (helper.status !== 'running') return t('tray.status.startingHelper');
  if (asr.status === 'loading' || asr.status === 'starting') return t('tray.status.preparingAsr');
  return t('tray.status.ready', { activate: hotkeyVars().activate });
}

function warnings(): TrayWarning[] {
  const w: TrayWarning[] = [];
  if (helper.status === 'failed') w.push({ label: t('tray.warning.helper'), page: 'settings/about' });
  if (asr.status === 'failed' || asr.status === 'missing') w.push({ label: t('tray.warning.asr'), page: 'settings/connection' });
  if (!permissions.accessibility) w.push({ label: t('tray.warning.accessibility'), page: 'settings/about' });
  if (permissions.microphone === 'denied') w.push({ label: t('tray.warning.microphone'), page: 'settings/about' });
  if (!getProvider() && !settings.get().skipLlm) w.push({ label: t('tray.warning.llm'), page: 'settings/connection' });
  return w;
}

function updateTray(): void {
  tray?.update({ recording: !!controller?.isRecording, statusLine: statusLine(), warnings: warnings(), settings: settings.get(), devices });
}

function updateFloaterVisibility(): void {
  const s = settings.get();
  const snoozed = s.floaterSnoozeUntil !== null && (s.floaterSnoozeUntil === -1 || s.floaterSnoozeUntil > Date.now());
  const visible = s.showFloater && !snoozed;
  if (floater.getState().visible !== visible) floater.setState({ visible });
}

// Pick up expired snoozes
setInterval(() => {
  const s = settings.get();
  if (s.floaterSnoozeUntil !== null && s.floaterSnoozeUntil !== -1 && s.floaterSnoozeUntil <= Date.now()) {
    settings.update({ floaterSnoozeUntil: null });
  }
}, 15_000).unref();

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function helperConfig(): ConfigurePayload {
  const s = settings.get();
  return { hotkeys: s.hotkeys, suppressGlobe: s.suppressGlobe, chromiumEnhancedUI: s.chromiumEnhancedUI };
}

async function refreshPermissions(prompt?: 'accessibility' | 'microphone'): Promise<PermissionStatus> {
  const prev = permissions;
  try {
    const p = await helper.request<PermissionsResultPayload>('permissions', prompt ? { prompt } : {}, prompt === 'microphone' ? 60000 : 3000);
    permissions = { ...p, helperRunning: true };
  } catch {
    // If the helper is not running, fill in what the app itself can tell
    permissions = {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      microphone: systemPreferences.getMediaAccessStatus('microphone') as PermissionStatus['microphone'],
      helperRunning: false,
    };
  }
  onPermissionsChanged(prev, permissions);
  permissionsKnown = true;
  broadcast();
  return permissions;
}

/** Whether permissions have been checked at least once since launch (so that a change from the initial defaults is not mistaken for a revocation) */
let permissionsKnown = false;
/** Whether the loss of accessibility permission was reported in this launch */
let accessibilityLostShown = false;

/** Guidance on permission changes (N13). When a permission is revoked, shows a notification that stays; when it is back, sets up the helper again */
function onPermissionsChanged(prev: PermissionStatus, next: PermissionStatus): void {
  if (next.microphone === 'granted') resolveHud('MicPermissionDenied');
  if (!permissionsKnown || prev.accessibility === next.accessibility) return;
  if (!next.accessibility) {
    log.warn('Accessibility permission was revoked');
    if (settings.get().onboardingComplete) {
      accessibilityLostShown = true;
      showHud('AccessibilityRevoked');
    }
    return;
  }
  log.info('Accessibility permission was granted');
  resolveHud('AccessibilityRevoked');
  if (accessibilityLostShown) showHud('AccessibilityRestored');
  accessibilityLostShown = false;
  // Recreate the key monitoring that could not be set up without the permission
  if (helper.status === 'running') void helper.restart().catch((e) => log.error('Failed to restart the helper', e));
  // During first-run setup, bring the user back from System Settings to Longhand (O2)
  if (!settings.get().onboardingComplete) management.open();
}

/** Checks accessibility permission every 2 seconds. Asks the helper too only when it changes */
function watchAccessibility(): void {
  let trusted = systemPreferences.isTrustedAccessibilityClient(false);
  setInterval(() => {
    const now = systemPreferences.isTrustedAccessibilityClient(false);
    if (now === trusted) return;
    trusted = now;
    void refreshPermissions();
  }, 2000).unref();
}

async function startHelper(): Promise<void> {
  try {
    await helper.start();
  } catch (e) {
    log.error('Could not start the helper', e);
    showHud('HelperFailed');
  }
}

helper.on('ready', async () => {
  try {
    const res = await helper.configure(helperConfig());
    if (res.errors.length) log.warn('Some hotkey settings were not accepted', res.errors);
  } catch (e) {
    log.warn('Failed to configure the helper', e);
  }
  await refreshPermissions();
  devices = (await controller?.refreshDevices()) ?? [];
  broadcast();
});
helper.on('status', (s) => {
  if (s === 'failed') showHud('HelperFailed');
  if (s === 'running') resolveHud('HelperFailed');
  broadcast();
});
helper.on('message', (m: HelperToMain) => {
  switch (m.type) {
    case 'hotkey':
      if (hotkeyTestListeners) management.send('hotkey-test', { action: m.payload.action, phase: m.payload.phase });
      break;
    case 'shortcut_keys':
      management.send('shortcut-keys', m.payload);
      break;
    case 'audio_devices_changed': {
      const before = new Set(devices.map((d) => d.id));
      devices = m.payload.devices;
      // If a microphone is connected while "No microphone" is shown, replace that notification (N7)
      const added = devices.filter((d) => !d.isVirtual && !before.has(d.id));
      if (added.length && resolveHud('NoMicrophone')) showHud('MicrophoneConnected', { name: added.map((d) => d.name).join(t('common.listSeparator')) });
      broadcast();
      break;
    }
    case 'event_tap':
      log.info(`event tap: ${m.payload.status}${m.payload.pid ? ` (pid ${m.payload.pid} ${m.payload.name ?? ''})` : ''}`);
      if (m.payload.status === 'rival_in_front') showHud('HotkeyRival', { name: m.payload.name ?? t('hud.rival.unknownApp') });
      if (m.payload.status === 'rival_in_front') log.warn(`Another app (${m.payload.name ?? m.payload.pid}) receives key presses first. If the hotkeys do not work, quit that app`);
      if (m.payload.status === 'failed') void refreshPermissions();
      break;
    case 'log':
      break;
  }
});

asr.on('status', () => {
  onAsrStatus();
  broadcast();
});
models.on('change', () => broadcast());

// Apply settings changes to the parts they affect
settings.on('change', (next: Settings, prev: Settings) => {
  if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys) || next.suppressGlobe !== prev.suppressGlobe || next.chromiumEnhancedUI !== prev.chromiumEnhancedUI) {
    helper.configure(helperConfig()).catch((e) => log.warn('Failed to reconfigure the hotkeys', e));
  }
  if (next.launchAtLogin !== prev.launchAtLogin) applyLoginItem(next.launchAtLogin);
  const asrChanged =
    next.asr.engine !== prev.asr.engine ||
    next.asr.modelPath !== prev.asr.modelPath ||
    next.asr.workerPath !== prev.asr.workerPath ||
    JSON.stringify(next.asr.options) !== JSON.stringify(prev.asr.options) ||
    (next.language !== prev.language && (next.language === 'en' || prev.language === 'en'));
  if (asrChanged) void asr.restart();
  if (next.appearance !== prev.appearance) nativeTheme.themeSource = next.appearance;
  // The tray menu and the windows follow on the broadcast below; the application menu is built once, so build it again
  if (next.uiLanguage !== prev.uiLanguage && setUiLanguage(DEBUG_UI_LANGUAGE ?? next.uiLanguage, systemLanguages())) setAppMenu();
  if (needsTokenizer(next) && !needsTokenizer(prev)) void textfix.load();
  broadcast();
});
customizations.on('change', () => broadcast());
// Generate reading candidates for Latin-script dictionary words with the LLM (G4-11). None when no LLM is available
customizations.setReadingGenerator((words) => {
  const p = getProvider();
  return p ? generateReadings(words, p) : Promise.resolve(null);
});
history.on('change', () => management.send('history-changed', null));

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (_e: IpcMainInvokeEvent, ...args: unknown[]) => fn(...(args as A)));
}

async function testLlm(): Promise<ConnectionTestResult> {
  cachedProvider = null;
  const provider = getProvider();
  if (!provider) return { ok: false, elapsedMs: 0, error: t('main.test.llmNotConfigured') };
  const started = Date.now();
  const res = await formatText({
    mode: 'dictation',
    rawText: 'えーと接続のテストですあのー聞こえてますか',
    language: 'ja',
    context: { appName: 'Longhand' },
    vocabulary: [],
    customInstructions: '',
    provider,
    timeoutMs: Math.max(settings.get().llm.timeoutMs, 15000),
    maxOutputTokens: 256,
  });
  if (res.error) return { ok: false, elapsedMs: Date.now() - started, error: res.error };
  return { ok: true, elapsedMs: res.llmMs, model: res.model, output: res.text };
}

async function testAsr(): Promise<AsrTestResult> {
  if (!asr.ready) return { ok: false, error: asr.message || t('main.test.asrNotReady') };
  // Test with the latest recording if there is one, otherwise with 1 second of silence
  const last = history.list().find((h) => h.audioFile);
  let samples: Float32Array = new Float32Array(16000);
  if (last?.audioFile) {
    const buf = recordings.read(last.audioFile);
    if (buf) samples = decodeWav(buf).samples;
  }
  try {
    const res = await asr.transcribe(samples, { language: settings.get().language, hints: customizations.asrHints(), timeoutMs: 60000 });
    return { ok: true, text: res.text || t('main.test.silence'), elapsedMs: res.elapsedMs };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const CONNECTION_FIELDS = ['provider', 'baseUrl', 'model', 'headers', 'timeoutMs', 'maxOutputTokens', 'structuredOutput', 'extraBody', 'azure', 'anthropic', 'custom'] as const;

/** Microphone test. Records for a few seconds and returns the level (the recording is not kept) */
async function testMicrophone(seconds: number): Promise<{ ok: boolean; peak: number; rms: number; chunks?: number; error?: string }> {
  if (controller?.isRecording) return { ok: false, peak: 0, rms: 0, error: t('main.test.micWhileRecording') };
  const sessionId = -Date.now();
  let peak = 0;
  let sumSq = 0;
  let n = 0;
  const onMsg = (m: HelperToMain) => {
    if (m.type === 'audio_chunk' && m.payload.sessionId === sessionId) {
      peak = Math.max(peak, m.payload.peak);
      sumSq += m.payload.rms * m.payload.rms;
      n++;
      management.send('mic-level', m.payload.rms);
    }
  };
  helper.on('message', onMsg);
  let stopped = false;
  try {
    await helper.startAudio(sessionId, settings.get().microphoneId, 4000);
    await new Promise((r) => setTimeout(r, Math.min(10, Math.max(1, seconds)) * 1000));
    await helper.stopAudio(sessionId, 3000);
    stopped = true;
    return { ok: true, peak, rms: n ? Math.sqrt(sumSq / n) : 0, chunks: n };
  } catch (e) {
    return { ok: false, peak, rms: 0, error: (e as Error).message };
  } finally {
    helper.off('message', onMsg);
    // Even if the start was late and timed out, do not leave a recording that started afterwards
    if (!stopped) helper.send('audio_stop', { sessionId });
  }
}

/** Redoes a history item (H1). Transcribing again starts from the recording; formatting only starts from the saved transcript */
async function redoHistory(id: string, opts: Parameters<LonghandApi['redoHistory']>[1]): Promise<{ ok: boolean; error?: string }> {
  const item = history.get(id);
  if (!item) return { ok: false, error: t('main.history.notFound') };
  if (item.mode === 'edit') return { ok: false, error: t('main.history.editCannotRedo') };
  const cfg = settings.get();
  const language = (opts.language ?? item.language) as Settings['language'];
  let rawText = item.rawText;
  let asrMs = item.timings.asrMs;
  if (opts.kind === 'transcribe') {
    if (!item.audioFile) return { ok: false, error: t('main.history.noRecording') };
    if (!asr.ready) return { ok: false, error: asr.message || t('main.history.asrNotReady') };
    const buf = recordings.read(item.audioFile);
    if (!buf) return { ok: false, error: t('main.history.readFailed') };
    const { samples } = decodeWav(buf);
    const started = Date.now();
    try {
      const build = (hints: string[]) => ({ language, hints, timeoutMs: 15000 + Math.ceil(samples.length / 16000 / 60) * 4000 });
      const hints = customizations.asrHints();
      // Use vocabulary hints the same way as in dictation (asr/selectiveHints.ts)
      const res =
        cfg.asr.hintMode === 'selective' && hints.length ? await transcribeSelective((opts) => asr.transcribe(samples, opts), build(hints), build([])) : await asr.transcribe(samples, build(hints));
      rawText = res.text.trim();
    } catch (e) {
      return { ok: false, error: t('main.history.transcribeFailed', { error: (e as Error).message }) };
    }
    asrMs = Date.now() - started;
    if (!rawText) {
      history.update(id, { rawText: '', text: '', language, llmError: t('main.history.noSpeech') });
      return { ok: false, error: t('main.history.noSpeech') };
    }
  }
  if (!rawText.trim()) return { ok: false, error: t('main.history.noTranscript') };
  const provider = cfg.skipLlm ? null : getProvider();
  const fmt = await formatText({
    mode: 'dictation',
    rawText,
    language: language === 'auto' ? 'auto' : language,
    context: cfg.sendAppContext ? { appName: item.app?.name, host: item.host } : {},
    vocabulary: customizations.vocabulary(),
    customInstructions: customizations.get().customInstructions,
    provider,
    timeoutMs: Math.max(cfg.llm.timeoutMs, 15000),
    maxOutputTokens: cfg.llm.maxOutputTokens,
  });
  history.update(id, {
    rawText,
    text: fmt.text.trim() ? fmt.text : rawText,
    formatted: fmt.formatted,
    llmError: fmt.error,
    language,
    timings: { ...item.timings, asrMs, llmMs: fmt.llmMs },
  });
  return { ok: true };
}

/** Edits the text of a history item by hand (G4-08). Corrected words are learned into the dictionary with the same rules as edits after pasting (candidate limit, LLM check) */
async function editHistory(id: string, text: string): ReturnType<LonghandApi['editHistory']> {
  const item = history.get(id);
  if (!item) return { ok: false, error: t('main.history.notFound') };
  const edited = text.trim();
  if (!edited) return { ok: false, error: t('main.history.empty') };
  const original = item.text || item.rawText;
  if (edited === original.trim()) return { ok: true, learned: [] };
  history.update(id, { text: edited });
  const cfg = settings.get();
  // Results of edit mode were written by the LLM, so they are not used to learn mishearings
  if (!cfg.learning.enabled || item.mode === 'edit' || !original.trim()) return { ok: true, learned: [] };
  try {
    const r = await learnFromEdit(original, edited, {
      vocabulary: customizations.vocabulary(),
      blocked: customizations.get().blockedLearnedWords,
      provider: cfg.skipLlm ? null : getProvider(),
      timeoutMs: cfg.llm.timeoutMs,
      // The transcript before formatting. Only when formatted text was edited, it tells apart edits that undo the formatting's rewrites
      rawText: item.formatted ? item.rawText : undefined,
      tokenizer: textfix.get(),
    });
    const applied = applyLearning(customizations, r);
    log.info(
      `Learned from a history edit (words ${applied.words.length}, misheard forms ${applied.forms.length}, swapped pairs ${applied.corrections.length}, ` +
        `kept phrases ${applied.kept.length}, number styles ${applied.numbers.length})${r.skipped ? ` (${r.skipped})` : ''}`,
    );
    return {
      ok: true,
      learned: applied.words.map((w) => w.word),
      remembered: applied.forms.length + applied.corrections.length + applied.kept.length + applied.numbers.length,
      tooMany: r.skipped === 'too_many',
    };
  } catch (e) {
    log.warn('Failed to learn from a history edit', e);
    return { ok: true, learned: [] };
  }
}

function registerIpc(): void {
  handle('getSnapshot', () => snapshot());
  handle('updateSettings', (patch: DeepPartial<Settings>) => {
    const res = settings.update(patch);
    return { ...res, llm: { ...res.llm, apiKeyEnc: '' } };
  });
  handle('setApiKey', (key: string) => {
    settings.setApiKey(key.trim());
    cachedProvider = null;
  });
  handle('updateCustomizations', (patch: Partial<Customizations>) => customizations.update(patch));
  handle('openExternal', async (target: string) => {
    const urls: Record<string, string> = SYSTEM_SETTINGS;
    if (urls[target]) await shell.openExternal(urls[target]);
    else if (target === 'logs') await shell.openPath(paths.logs);
    else if (target === 'recordings') {
      fs.mkdirSync(paths.recordings, { recursive: true });
      await shell.openPath(paths.recordings);
    } else if (target === 'models') {
      fs.mkdirSync(paths.models, { recursive: true });
      await shell.openPath(paths.models);
    }
  });
  handle('requestPermission', (kind: 'accessibility' | 'microphone') => refreshPermissions(kind));
  handle('refreshPermissions', () => refreshPermissions());

  handle('listHistory', (q?: string) => debugOverride.history ?? history.list(q));
  handle('deleteHistory', (id: string) => {
    const removed = history.delete(id);
    recordings.remove(removed?.audioFile);
  });
  handle('clearHistory', () => {
    for (const item of history.clear()) recordings.remove(item.audioFile);
  });
  handle('copyText', (text: string) => clipboard.writeText(text));
  handle('readAudio', (id: string) => {
    const item = history.get(id);
    const buf = item?.audioFile ? recordings.read(item.audioFile) : null;
    return buf ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : null;
  });
  handle('saveAudioAs', async (id: string) => {
    const item = history.get(id);
    if (!item?.audioFile) return false;
    const res = await dialog.showSaveDialog({ defaultPath: `longhand-${item.timestamp}.wav`, filters: [{ name: 'WAV', extensions: ['wav'] }] });
    if (res.canceled || !res.filePath) return false;
    fs.copyFileSync(recordings.pathOf(item.audioFile), res.filePath);
    return true;
  });
  handle('redoHistory', (id: string, opts: Parameters<LonghandApi['redoHistory']>[1]) => redoHistory(id, opts));
  handle('editHistory', (id: string, text: string) => editHistory(id, text));

  handle('testLlm', () => testLlm());
  handle('testAsr', () => testAsr());
  handle('restartAsr', () => asr.restart());
  handle('downloadModel', async () => {
    const ok = await models.download(settings.get().asr.downloadBaseUrl);
    if (ok && asr.status !== 'ready') await asr.restart();
    return ok;
  });
  handle('cancelModelDownload', () => models.cancel());
  handle('importModel', async () => {
    const res = await dialog.showOpenDialog({
      title: t('main.dialog.importModel'),
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, imported: [], rejected: [] };
    const r = await models.importFrom(res.filePaths);
    if (r.imported.length && asr.status !== 'ready') await asr.restart();
    return { ok: r.imported.length > 0, ...r };
  });
  handle('exportConnection', async () => {
    const res = await dialog.showSaveDialog({ defaultPath: 'longhand-connection.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return { ok: false };
    const llm = settings.get().llm;
    const out: Record<string, unknown> = {};
    for (const k of CONNECTION_FIELDS) out[k] = llm[k];
    // Do not export headers that look like credentials (the file is meant to be shared, so they are treated like the API key)
    const secretHeader = (name: string) =>
      /authorization|api[-_]?key|token|secret|password|cookie/i.test(name) || (llm.provider === 'custom-http' && name.toLowerCase() === llm.custom.authHeader.toLowerCase());
    const removed = Object.keys(llm.headers).filter(secretHeader);
    out.headers = Object.fromEntries(Object.entries(llm.headers).filter(([k]) => !secretHeader(k)));
    if (removed.length) out.removedHeaders = removed;
    fs.writeFileSync(res.filePath, JSON.stringify({ longhandConnection: 1, llm: out }, null, 2), { mode: 0o600 });
    return { ok: true, removedHeaders: removed };
  });
  handle('importConnection', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    try {
      const j = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      const llm = (j.llm ?? j) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of CONNECTION_FIELDS) if (k in llm) patch[k] = llm[k];
      if (typeof llm.apiKey === 'string') settings.setApiKey(llm.apiKey);
      settings.update({ llm: patch as DeepPartial<Settings['llm']> });
      cachedProvider = null;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle('recordShortcut', (active: boolean) => {
    hotkeyTestListeners = active;
    helper.send('record_shortcut', { active });
  });
  handle('hotkeyTest', (active: boolean) => {
    hotkeyTestListeners = active;
  });

  handle('listMicrophones', async () => {
    devices = (await controller?.refreshDevices()) ?? devices;
    return devices.map((d) => ({ id: d.id, name: d.name, isDefault: d.isDefault, isVirtual: d.isVirtual, transport: d.transport }));
  });
  handle('testMicrophone', (seconds: number) => testMicrophone(seconds));

  handle('undoLearnedWord', (word: string) => customizations.undoLearnedWord(word));
  handle('completeOnboarding', () => {
    settings.update({ onboardingComplete: true });
  });

  ipcMain.on('floaterAction', (_e, action: string, arg?: string) => {
    if (action === 'start') controller?.uiAction('start');
    else if (action === 'finish') controller?.uiAction('finish');
    else if (action === 'cancel') controller?.uiAction('cancel');
    else if (action === 'menu') showFloaterMenu();
    else if (action === 'hud-action' && arg) {
      const run = hudActions.get(arg) ?? BUILTIN_ACTIONS[arg.slice(arg.indexOf(':') + 1)];
      hudActions.delete(arg);
      run?.();
    }
  });
  ipcMain.on('setMouseInteractive', (_e, interactive: boolean) => floater.setInteractive(interactive));
  ipcMain.on('hudMute', (_e, key: string) => {
    const s = settings.get();
    const st = s.notifications[key] ?? { muted: false, count: 0, last: 0 };
    settings.update({ notifications: { ...s.notifications, [key]: { ...st, muted: true } } });
  });
}

/** Right-click menu of the floating bar (UI-5) */
function showFloaterMenu(): void {
  const s = settings.get();
  const recording = !!controller?.isRecording;
  Menu.buildFromTemplate([
    { label: recording ? t('main.floaterMenu.finishAndPaste') : t('main.floaterMenu.startHandsFree'), click: () => controller?.uiAction(recording ? 'finish' : 'start') },
    { label: t('tray.menu.pasteLast'), click: () => void controller?.pasteLast() },
    { type: 'separator' },
    {
      label: t('tray.menu.microphone'),
      submenu: [
        { label: t('tray.menu.systemDefault'), type: 'radio', checked: !s.microphoneId, click: () => settings.update({ microphoneId: null }) },
        ...devices.filter((d) => !d.isVirtual).map((d) => ({ label: d.name, type: 'radio' as const, checked: s.microphoneId === d.id, click: () => settings.update({ microphoneId: d.id }) })),
      ],
    },
    {
      label: t('tray.menu.language'),
      submenu: (['ja', 'en', 'auto'] as const).map((l) => ({
        label: t(`tray.language.${l}`),
        type: 'radio' as const,
        checked: s.language === l,
        click: () => settings.update({ language: l }),
      })),
    },
    { type: 'separator' },
    { label: t('tray.menu.openHistory'), click: () => management.open('history') },
    { label: t('tray.menu.settings'), click: () => management.open('settings') },
    { type: 'separator' },
    {
      label: t('main.floaterMenu.hide'),
      submenu: [
        ...[1, 15, 60].map((min) => ({
          label: min < 60 ? t('main.floaterMenu.minutes', { minutes: min }) : t('main.floaterMenu.hour'),
          click: () => settings.update({ floaterSnoozeUntil: Date.now() + min * 60_000 }),
        })),
        { label: t('main.floaterMenu.untilShown'), click: () => settings.update({ floaterSnoozeUntil: -1 }) },
      ],
    },
  ]).popup();
}

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

function setAppMenu(): void {
  // No menu bar is shown, but the menu is defined for the editing shortcuts (⌘C / ⌘V / ⌘A and so on) and ⌘Q / ⌘W
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Longhand',
        submenu: [
          { label: t('tray.menu.settings'), accelerator: 'Command+,', click: () => management.open('settings') },
          { type: 'separator' },
          { label: t('main.appMenu.closeWindow'), accelerator: 'Command+Q', click: () => quitOrHide() },
        ],
      },
      { role: 'editMenu' },
      { label: t('main.appMenu.window'), submenu: [{ role: 'close' }, { role: 'minimize' }, { role: 'reload', visible: !app.isPackaged }, { role: 'toggleDevTools', visible: !app.isPackaged }] },
    ]),
  );
}

/** ⌘Q closes only the UI and keeps running in the background (CORE-5). Quitting completely is done from the tray */
function quitOrHide(): void {
  if (settings.get().quitOnlyFromTray) management.close();
  else quitCompletely();
}

/** Runs the end-to-end self-test and returns its exit code */
async function runSelfTestE2E(input: VirtualInputHelper): Promise<number> {
  const say = (line: string) => {
    log.info(`selftest-e2e: ${line}`);
    console.log(`[selftest-e2e] ${line}`);
  };
  say(`profile: ${paths.userData}`);
  if (process.env.LONGHAND_SELFTEST_LLM === 'saved') {
    const saved = new SettingsStore(path.join(REAL_USER_DATA, 'settings.json'), { readOnly: true });
    const apiKey = saved.getApiKey();
    if (isLlmConfigured(saved.get().llm, !!apiKey)) selfTestProvider = createProvider(saved.get().llm, apiKey, llmFetch);
    else say('the saved LLM connection cannot be used (not set up, or the key cannot be decrypted). Continuing without an LLM');
  }
  const { runEndToEndSelfTest } = await import('./selftest/e2e');
  return runEndToEndSelfTest({
    input,
    asr,
    history,
    llm: !!selfTestProvider,
    log: say,
    reportPath: process.env.LONGHAND_SELFTEST_REPORT || path.join(paths.userData, 'selftest-report.json'),
  });
}

/** Quits completely. Cleanup happens in before-quit */
function quitCompletely(): void {
  if (quitting) return;
  app.quit();
}

app.on('second-instance', () => management.open());
app.on('window-all-closed', () => {
  // A background app: closing the windows does not quit
});
// Only requests to quit completely arrive here. ⌘Q is taken first by the menu item (quitOrHide), so it never arrives here.
// What arrives is "Quit" in the tray, signals from the terminal (SIGTERM, SIGINT, SIGHUP), logging out or shutting down,
// and "Quit" in Activity Monitor. Cancelling the quit here would also block logging out and shutting down.
//
// Electron receives the signals itself and routes them to the same path as app.quit(). process.on('SIGTERM') has no effect
// (Electron replaces the signal handlers with its own after loading the main script).
app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  log.info('Quitting');
  models.cancel();
  controller?.dispose();
  helper.stop();
  asr.stop();
  settings.flush();
  customizations.flush();
  history.flush();
  recordings.stop();
  micHealth.flush();
  // Always quit, even if the cleanup (windows, helper, ASR workers) does not finish
  setTimeout(() => {
    log.warn('Quitting did not finish within 3 seconds, so forcing the exit');
    app.exit(selfTestExitCode ?? 0);
  }, 3000).unref();
});

/** Exit code of the end-to-end self-test, once it has finished */
let selfTestExitCode: number | null = null;
app.on('will-quit', (e) => {
  if (!selfTestExitCode) return;
  e.preventDefault();
  app.exit(selfTestExitCode);
});

app.whenReady().then(async () => {
  app.dock?.hide();
  setUiLanguage(DEBUG_UI_LANGUAGE ?? settings.get().uiLanguage, systemLanguages());
  if (EVAL_SPEC) {
    // Run only the evaluation and quit. The helper, tray, floating bar and regular ASR are not started
    // (a second helper would compete for key input)
    let code = 1;
    try {
      const { runEvalInApp } = await import('./evalInApp');
      code = await runEvalInApp(EVAL_SPEC, REAL_USER_DATA);
    } catch (e) {
      console.error(`Evaluation failed: ${redact((e as Error).message)}`);
    }
    app.exit(code);
    return;
  }
  nativeTheme.themeSource = settings.get().appearance;
  lockDownRendererNetwork(typeof UI_VITE_DEV_SERVER_URL !== 'undefined' ? UI_VITE_DEV_SERVER_URL : undefined);
  setAppMenu();
  registerIpc();

  // Fix up old formats in the settings file
  settings.update(mergeSettings(settings.get()) as DeepPartial<Settings>);
  applyLoginItem(settings.get().launchAtLogin);

  floater.create();
  controller = new DictationController({
    helper: virtualInput ?? helper,
    asr,
    settings,
    customizations,
    history,
    recordings,
    provider: getProvider,
    tokenizer: () => textfix.get(),
    ui: {
      floater: (st) => onFloaterState(st),
      level: (rms) => onLevel(rms),
      hud: (key, vars, actions) => showHud(key, vars, actions),
      sound: (name) => floater.sound(name, settings.get().soundVolume),
      preconnect: () => {
        const url = llmEndpointForPreconnect();
        if (url && !settings.get().skipLlm) preconnect(url);
      },
    },
  });

  tray = new AppTray({
    toggleRecording: () => controller?.uiAction('toggle'),
    pasteLast: () => void controller?.pasteLast(),
    openPage: (page) => management.open(page),
    setMicrophone: (id) => settings.update({ microphoneId: id }),
    setLanguage: (lang) => settings.update({ language: lang }),
    setFloater: (mode) => {
      if (mode === 'show') settings.update({ showFloater: true, floaterSnoozeUntil: null });
      else if (mode === 'hide') settings.update({ showFloater: false });
      else if (mode === 'resume') settings.update({ floaterSnoozeUntil: null });
      else if (mode === 'snooze-forever') settings.update({ floaterSnoozeUntil: -1 });
      else settings.update({ floaterSnoozeUntil: Date.now() + mode.snoozeMinutes * 60_000 });
    },
    restartHelper: () => void helper.restart().catch((e) => log.error('Failed to restart the helper', e)),
    restartAsr: () => void asr.restart(),
    quit: () => quitCompletely(),
  });
  tray.create({ recording: false, statusLine: statusLine(), warnings: [], settings: settings.get(), devices });

  recordings.start();
  await startHelper();
  void asr.start();
  watchAccessibility();
  // Load a little later rather than right at startup (unpacking the dictionary blocks the main thread for about 120ms)
  if (needsTokenizer(settings.get())) setTimeout(() => void textfix.load(), 3000);

  if (SELFTEST_E2E && virtualInput) {
    // Development end-to-end self-test: virtual hotkeys and synthetic speech through the real pipeline, then quit with its result
    void runSelfTestE2E(virtualInput).then((code) => {
      selfTestExitCode = code;
      quitCompletely();
    });
  } else if (process.env.LONGHAND_DEBUG_SELFTEST === 'mouse-hold' && !app.isPackaged) {
    // Development: while a notification is shown and dismissed, an external tool checks hit testing with the real pointer
    void runMouseHoldSelfTest(floater, (line) => log.info(`selftest: ${line}`)).then(() => quitCompletely());
  } else if (process.env.LONGHAND_DEBUG_SELFTEST === 'mouse' && !app.isPackaged) {
    // Development self-test: checks that the floating bar never gets stuck taking mouse events, then quits
    void runMouseRoutingSelfTest(floater).then((line) => {
      log.info(`selftest: ${line}`);
      quitCompletely();
    });
  } else if (process.env.LONGHAND_DEBUG_SELFTEST && !app.isPackaged) {
    // Development self-test: logs the state of recording through the helper, ASR and the tokenizer, then quits
    const tokenizerLoad = textfix.load();
    setTimeout(async () => {
      const mic = await testMicrophone(1);
      await tokenizerLoad;
      log.info(`selftest: helper=${helper.status} mic=${JSON.stringify({ ...mic, peak: +mic.peak.toFixed(4), rms: +mic.rms.toFixed(4) })} asr=${asr.status} ${asr.message} textfix=${textfix.status}`);
      quitCompletely();
    }, 3000);
  } else if (process.env.LONGHAND_DEBUG_CAPTURE && !app.isPackaged) {
    void runDebugCapture(process.env.LONGHAND_DEBUG_CAPTURE, {
      floater,
      management,
      quit: () => quitCompletely(),
      override: (o) => {
        debugOverride.permissions = o.permissions;
        debugOverride.status = o.status;
        debugOverride.history = o.history;
        broadcast();
        management.send('history-changed', null);
      },
      hotkeyVars,
    });
  } else if (!settings.get().onboardingComplete) management.open('onboarding');
  log.info(`Started (version=${app.getVersion()})`);
});

process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
