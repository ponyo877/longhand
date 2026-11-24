import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import type { AudioDevice, ConfigurePayload, HelperToMain, PermissionsResultPayload } from '../shared/protocol';
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

declare const UI_VITE_DEV_SERVER_URL: string | undefined;

// ---------------------------------------------------------------------------
// 起動の前提
// ---------------------------------------------------------------------------

/**
 * 開発用の評価（LONGHAND_EVAL）。評価の設定（JSON のファイルのパスか、JSON そのもの）を渡すと、評価だけを走らせて終了する。
 * 使い方は scripts/eval-run.ts の先頭にある。
 *
 * 動いている開発版と並べて起動できるように、二重起動の確認より前に、保存先（userData とログ）を評価用のフォルダに移す。
 * 実際の保存先の設定は、評価の中で読み取りだけで開く（接続先とキーを借りるため。書き戻さない）。
 */
const EVAL_SPEC = !app.isPackaged ? process.env.LONGHAND_EVAL : undefined;
/** 実際の保存先（評価用に移す前の userData） */
const REAL_USER_DATA = app.getPath('userData');
if (EVAL_SPEC) {
  const profile = path.join(evalRoot(), 'app-profile');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
  app.setAppLogsPath(path.join(profile, 'logs'));
  // 評価は画面を出さない。Dock のアイコンも出さない
  app.dock?.hide();
}

if (!app.requestSingleInstanceLock()) {
  // 二重起動を防ぐ（CORE-2）
  app.quit();
  process.exit(0);
}

initLogs(paths.logs);
const log = createLogger('main');

const settings = new SettingsStore(paths.file('settings.json'));
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
const asr = new AsrService(
  () => settings.get().asr,
  (engine) => paths.asrWorker(engine),
  paths.models,
  () => settings.get().language,
  paths.bundledModels,
);
// textfix の単語分割。単語分割を使う規則（つなぎの言葉、表記、助詞）か、手直しからの学習がオンのときだけ、裏で読み込む（メモリが約 200MB 増えるため）
const textfix = new TextFixService(() => paths.linderaWasm);
// 手直しからの学習も、語の切り出しと読みに単語分割を使う
const needsTokenizer = (s: Settings) => s.language === 'ja' && ((s.textFix.enabled && (s.textFix.fillers || s.textFix.notation || s.textFix.particles)) || s.learning.enabled);
const models = new ModelDownloader({ modelsDir: paths.models, bundledDir: paths.bundledModels, fetch: (url, init) => modelFetch(url, init) });
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

function getProvider(): LlmProvider | null {
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
    log.warn('LLM のプロバイダを作れませんでした', e);
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
/** 呼び出し側が渡したボタンの動作（`${通知の id}:${ボタンの id}`） */
const hudActions = new Map<string, () => void>();
/** 通知に決まって付くボタンの動作（N2） */
const BUILTIN_ACTIONS: Record<string, () => void> = {
  'open-history': () => management.open('history'),
  'open-audio': () => management.open('settings/audio'),
  'open-connection': () => management.open('settings/connection'),
  'open-mic-privacy': () => void shell.openExternal(SYSTEM_SETTINGS.microphone),
  'open-accessibility': () => void shell.openExternal(SYSTEM_SETTINGS.accessibility),
  'restart-helper': () => void helper.restart().catch((e) => log.error('ヘルパーの再起動に失敗', e)),
};
/** 解決するまで出しておく通知（key から表示中の id） */
const stickyHuds = new Map<string, string>();
/** この起動で出した通知（起動ごとに 1 回の判定） */
const shownThisRun = new Set<string>();
/** 録音中と処理中は保留している通知（学習語など） */
let deferredHuds: { key: NotificationKey; vars: Record<string, string>; actions: HudRun[]; at: number }[] = [];
/** 保留した通知は、これより古くなったら捨てる */
const DEFER_MAX_MS = 30_000;

/** 設定から作る差し込み（F4。通知の文言に実際のキーの割り当てを出す） */
function hotkeyVars(): Record<string, string> {
  const h = settings.get().hotkeys;
  const paste = bindingLabel(h.paste_last[0]);
  return {
    activate: bindingLabel(h.activate[0]) || 'fn',
    cancel: bindingLabel(h.cancel[0]) || 'esc',
    lockExtra: bindingLabel(extraKeys(h.lock[0] ?? [], h.activate[0] ?? [])),
    paste: paste ? `${paste} で直前の書き起こしを貼り付けられます` : 'フローティングバーを右クリックして「直前の書き起こしを貼り付け」を選んでください',
  };
}

function micVars(mic: string): Record<string, string> {
  const hint = /macbook/i.test(mic) ? 'ノート PC を閉じているときは、外付けのマイクを使ってください' : 'ミュートと入力音量を確認してください';
  return {
    mic: mic || '新しいマイク',
    micParen: mic ? `（${mic}）` : '',
    silenceDetail: `${mic ? `${mic} からの音声` : '録音した音声'}が無音でした。${hint}`,
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
  // 整形の失敗が続くときは、2 回目からは小さく出す（N9）
  if (key === 'LlmFailed') {
    const last = s.notifications.LlmFailed?.last ?? 0;
    if (now - last < 10 * 60_000) {
      showHud('LlmFailedRepeat');
      return;
    }
  }
  if (key === 'HoldLongHint' && !s.hotkeys.lock[0]?.length) return;
  // 学習した語が複数なら、件数の形にして 1 行に収める（N10）
  if (key === 'WordsLearned' && vars.words?.includes('」「')) {
    const words = vars.words.split('」「');
    showHud('WordsLearnedMany', { first: words[0], count: String(words.length) }, actions);
    return;
  }
  if (!shouldShow(key, def, s.notifications[key], now, shownThisRun)) return;
  const msg = buildHud(
    key,
    // 呼び出し側の空の値（マイク名が分からないときの '' など）は、こちらで分かる値を上書きしない
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

/** 解決した通知を消す（権限が戻った、マイクがつながった、など） */
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
  // 続けて学習した語は 1 件にまとめる（N10）
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
// 録音の様子から出す表示（F1 の補助、F5、N6、N7、N12）
// ---------------------------------------------------------------------------

const micHealth = new MicHealth(paths.file('mic-health.json'));
/** 録音中のセッションの記録 */
const session = { active: false, startedAt: 0, mic: '', changeShown: false };
/** 音声認識の準備中に録音しようとしたか（準備ができたら知らせる） */
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

  // 前回と違うマイクで録り始めたら知らせる（N7）
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
    // 音が小さいマイクを知らせる（N6）。controller からマイク名が届いていなければ、設定から推定する
    session.mic ||= guessMicName();
    const verdict = micHealth.end(session.mic, Date.now() - session.startedAt);
    if (verdict?.quiet) showHud('QuietMicrophone', { mic: session.mic });
  }

  if (prev.phase !== 'idle' && next.phase === 'idle') {
    flushDeferredHuds();
    // 貼り付けに成功したら、待機のバーで短く知らせる（F5）
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

/** 録音に使っているはずのマイクの名前（選んだマイク、なければシステムの既定） */
function guessMicName(): string {
  const id = settings.get().microphoneId;
  return (id && devices.find((d) => d.id === id)?.name) || devices.find((d) => d.isDefault)?.name || '';
}

function onLevel(rms: number): void {
  floater.level(rms);
  if (!session.active) return;
  // 録音中に音が届かないこと（MicNoSignal）は controller がピークで判定して知らせる
  micHealth.push(rms);
}

/** 音声認識の準備ができたことを知らせる（N12） */
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
// 状態の配信
// ---------------------------------------------------------------------------

function engineStatus(): EngineStatus {
  return {
    helper: helper.status,
    asr: asr.status,
    asrMessage: asr.message || asr.modelDescription,
    llmConfigured: !!getProvider() || settings.get().skipLlm,
  };
}

/** 画面の書き出し（LONGHAND_DEBUG_CAPTURE）で、権限と状態を仮に変えて表示を確かめるためのもの */
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
  if (controller?.isRecording) return '● 録音中';
  if (helper.status !== 'running') return 'ヘルパーを起動しています…';
  if (asr.status === 'loading' || asr.status === 'starting') return '音声認識を準備しています…';
  return `${hotkeyVars().activate} を押しながら話してください`;
}

function warnings(): TrayWarning[] {
  const w: TrayWarning[] = [];
  if (helper.status === 'failed') w.push({ label: 'ヘルパーが動いていません', page: 'settings/about' });
  if (asr.status === 'failed' || asr.status === 'missing') w.push({ label: '音声認識が使えません', page: 'settings/connection' });
  if (!permissions.accessibility) w.push({ label: 'アクセシビリティの許可が必要です', page: 'settings/about' });
  if (permissions.microphone === 'denied') w.push({ label: 'マイクの許可が必要です', page: 'settings/about' });
  if (!getProvider() && !settings.get().skipLlm) w.push({ label: 'LLM が未設定です（整形なし）', page: 'settings/connection' });
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

// スヌーズの期限切れを拾う
setInterval(() => {
  const s = settings.get();
  if (s.floaterSnoozeUntil !== null && s.floaterSnoozeUntil !== -1 && s.floaterSnoozeUntil <= Date.now()) {
    settings.update({ floaterSnoozeUntil: null });
  }
}, 15_000).unref();

// ---------------------------------------------------------------------------
// ヘルパー
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
    // ヘルパーが動いていなければ、本体から分かる範囲で埋める
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

/** 起動後に一度でも権限を確かめたか（起動直後の既定値からの変化を「外れた」と誤解しないため） */
let permissionsKnown = false;
/** この起動でアクセシビリティが外れたことを知らせたか */
let accessibilityLostShown = false;

/** 権限の変化に応じた案内（N13）。許可が外れたら消えない通知を出し、戻ったらヘルパーを設定し直す */
function onPermissionsChanged(prev: PermissionStatus, next: PermissionStatus): void {
  if (next.microphone === 'granted') resolveHud('MicPermissionDenied');
  if (!permissionsKnown || prev.accessibility === next.accessibility) return;
  if (!next.accessibility) {
    log.warn('アクセシビリティの許可が外れました');
    if (settings.get().onboardingComplete) {
      accessibilityLostShown = true;
      showHud('AccessibilityRevoked');
    }
    return;
  }
  log.info('アクセシビリティが許可されました');
  resolveHud('AccessibilityRevoked');
  if (accessibilityLostShown) showHud('AccessibilityRestored');
  accessibilityLostShown = false;
  // 許可がない間に作れなかったキーの監視を作り直す
  if (helper.status === 'running') void helper.restart().catch((e) => log.error('ヘルパーの再起動に失敗', e));
  // 初回の案内の途中なら、システム設定から Longhand の画面に戻す（O2）
  if (!settings.get().onboardingComplete) management.open();
}

/** アクセシビリティの許可を 2 秒ごとに確かめる。変わったときだけヘルパーにも問い合わせる */
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
    log.error('ヘルパーを起動できませんでした', e);
    showHud('HelperFailed');
  }
}

helper.on('ready', async () => {
  try {
    const res = await helper.configure(helperConfig());
    if (res.errors.length) log.warn('ホットキーの設定の一部を受け付けませんでした', res.errors);
  } catch (e) {
    log.warn('ヘルパーの設定に失敗しました', e);
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
      // 「マイクが見つかりません」の表示中につながったら、その通知を置き換える（N7）
      const added = devices.filter((d) => !d.isVirtual && !before.has(d.id));
      if (added.length && resolveHud('NoMicrophone')) showHud('MicrophoneConnected', { name: added.map((d) => d.name).join('、') });
      broadcast();
      break;
    }
    case 'event_tap':
      log.info(`event tap: ${m.payload.status}${m.payload.pid ? ` (pid ${m.payload.pid} ${m.payload.name ?? ''})` : ''}`);
      if (m.payload.status === 'rival_in_front') showHud('HotkeyRival', { name: m.payload.name ?? '別のアプリ' });
      if (m.payload.status === 'rival_in_front') log.warn(`別のアプリ（${m.payload.name ?? m.payload.pid}）がキー入力を先に受け取っています。ホットキーが効かないときはそのアプリを終了してください`);
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

// 設定が変わったら、関係する部分に反映する
settings.on('change', (next: Settings, prev: Settings) => {
  if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys) || next.suppressGlobe !== prev.suppressGlobe || next.chromiumEnhancedUI !== prev.chromiumEnhancedUI) {
    helper.configure(helperConfig()).catch((e) => log.warn('ホットキーの再設定に失敗', e));
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
  if (needsTokenizer(next) && !needsTokenizer(prev)) void textfix.load();
  broadcast();
});
customizations.on('change', () => broadcast());
// 辞書の英字の語の読みの候補を LLM で作る（G4-11）。LLM を使えなければ作らない
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
  if (!provider) return { ok: false, elapsedMs: 0, error: '接続先、モデル名、API キーのいずれかが未設定です' };
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
  if (!asr.ready) return { ok: false, error: asr.message || '音声認識が準備できていません' };
  // 直近の録音があればそれで、なければ 1 秒の無音で動作を確かめる
  const last = history.list().find((h) => h.audioFile);
  let samples: Float32Array = new Float32Array(16000);
  if (last?.audioFile) {
    const buf = recordings.read(last.audioFile);
    if (buf) samples = decodeWav(buf).samples;
  }
  try {
    const res = await asr.transcribe(samples, { language: settings.get().language, hints: customizations.asrHints(), timeoutMs: 60000 });
    return { ok: true, text: res.text || '（無音）', elapsedMs: res.elapsedMs };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const CONNECTION_FIELDS = ['provider', 'baseUrl', 'model', 'headers', 'timeoutMs', 'maxOutputTokens', 'structuredOutput', 'extraBody', 'azure', 'anthropic', 'custom'] as const;

/** マイクのテスト。数秒録音して、音の大きさを返す（録音は保存しない） */
async function testMicrophone(seconds: number): Promise<{ ok: boolean; peak: number; rms: number; chunks?: number; error?: string }> {
  if (controller?.isRecording) return { ok: false, peak: 0, rms: 0, error: '録音中は試せません' };
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
    // 開始が遅れて時間切れになっても、後から始まった録音を残さない
    if (!stopped) helper.send('audio_stop', { sessionId });
  }
}

/** 履歴の項目をやり直す（H1）。書き起こし直す場合は録音から、整形だけなら残っている書き起こしから */
async function redoHistory(id: string, opts: Parameters<LonghandApi['redoHistory']>[1]): Promise<{ ok: boolean; error?: string }> {
  const item = history.get(id);
  if (!item) return { ok: false, error: '履歴が見つかりません' };
  if (item.mode === 'edit') return { ok: false, error: '編集の結果はやり直せません' };
  const cfg = settings.get();
  const language = (opts.language ?? item.language) as Settings['language'];
  let rawText = item.rawText;
  let asrMs = item.timings.asrMs;
  if (opts.kind === 'transcribe') {
    if (!item.audioFile) return { ok: false, error: '録音が残っていません' };
    if (!asr.ready) return { ok: false, error: asr.message || '音声認識の準備ができていません' };
    const buf = recordings.read(item.audioFile);
    if (!buf) return { ok: false, error: '録音を読み込めませんでした' };
    const { samples } = decodeWav(buf);
    const started = Date.now();
    try {
      const build = (hints: string[]) => ({ language, hints, timeoutMs: 15000 + Math.ceil(samples.length / 16000 / 60) * 4000 });
      const hints = customizations.asrHints();
      // 語彙ヒントの使い方は、音声入力のときと同じにする（asr/selectiveHints.ts）
      const res =
        cfg.asr.hintMode === 'selective' && hints.length ? await transcribeSelective((opts) => asr.transcribe(samples, opts), build(hints), build([])) : await asr.transcribe(samples, build(hints));
      rawText = res.text.trim();
    } catch (e) {
      return { ok: false, error: `書き起こしに失敗しました: ${(e as Error).message}` };
    }
    asrMs = Date.now() - started;
    if (!rawText) {
      history.update(id, { rawText: '', text: '', language, llmError: '音声を聞き取れませんでした' });
      return { ok: false, error: '音声を聞き取れませんでした' };
    }
  }
  if (!rawText.trim()) return { ok: false, error: '書き起こしがありません。先に書き起こし直してください' };
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

/** 履歴の文を手で直す（G4-08）。直した語は、貼り付け後の手直しと同じ規則（候補の数の上限、LLM の判定）で辞書に学習する */
async function editHistory(id: string, text: string): ReturnType<LonghandApi['editHistory']> {
  const item = history.get(id);
  if (!item) return { ok: false, error: '履歴が見つかりません' };
  const edited = text.trim();
  if (!edited) return { ok: false, error: '空にはできません。消すときは「削除」を使ってください' };
  const original = item.text || item.rawText;
  if (edited === original.trim()) return { ok: true, learned: [] };
  history.update(id, { text: edited });
  const cfg = settings.get();
  // 編集モードの結果は LLM が書いた文なので、聞き間違いの学習には使わない
  if (!cfg.learning.enabled || item.mode === 'edit' || !original.trim()) return { ok: true, learned: [] };
  try {
    const r = await learnFromEdit(original, edited, {
      vocabulary: customizations.vocabulary(),
      blocked: customizations.get().blockedLearnedWords,
      provider: cfg.skipLlm ? null : getProvider(),
      timeoutMs: cfg.llm.timeoutMs,
      // 整形の前の書き起こし。整形した文を直したときだけ、整形の書き換えを戻した手直しを見分ける
      rawText: item.formatted ? item.rawText : undefined,
      tokenizer: textfix.get(),
    });
    const applied = applyLearning(customizations, r);
    log.info(
      `履歴の手直しから学習しました（語 ${applied.words.length}、聞き違えた形 ${applied.forms.length}、取り違えの組 ${applied.corrections.length}、` +
        `書き換えない語句 ${applied.kept.length}、number styles ${applied.numbers.length}）${r.skipped ? `（${r.skipped}）` : ''}`,
    );
    return {
      ok: true,
      learned: applied.words.map((w) => w.word),
      remembered: applied.forms.length + applied.corrections.length + applied.kept.length + applied.numbers.length,
      tooMany: r.skipped === 'too_many',
    };
  } catch (e) {
    log.warn('履歴の手直しからの学習に失敗しました', e);
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
      title: 'モデルのファイルかフォルダを選ぶ',
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
    // 認証情報らしいヘッダは書き出さない（ファイルは人に渡す前提なので、API キーと同じ扱いにする）
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

/** フローティングバーの右クリックメニュー（UI-5） */
function showFloaterMenu(): void {
  const s = settings.get();
  const recording = !!controller?.isRecording;
  Menu.buildFromTemplate([
    { label: recording ? '確定して貼り付け' : '録音を開始（ハンズフリー）', click: () => controller?.uiAction(recording ? 'finish' : 'start') },
    { label: '直前の書き起こしを貼り付け', click: () => void controller?.pasteLast() },
    { type: 'separator' },
    {
      label: 'マイク',
      submenu: [
        { label: 'システムの既定', type: 'radio', checked: !s.microphoneId, click: () => settings.update({ microphoneId: null }) },
        ...devices.filter((d) => !d.isVirtual).map((d) => ({ label: d.name, type: 'radio' as const, checked: s.microphoneId === d.id, click: () => settings.update({ microphoneId: d.id }) })),
      ],
    },
    {
      label: '言語',
      submenu: (['ja', 'en', 'auto'] as const).map((l) => ({
        label: { ja: '日本語', en: 'English', auto: '自動判定' }[l],
        type: 'radio' as const,
        checked: s.language === l,
        click: () => settings.update({ language: l }),
      })),
    },
    { type: 'separator' },
    { label: '履歴を開く…', click: () => management.open('history') },
    { label: '設定…', click: () => management.open('settings') },
    { type: 'separator' },
    {
      label: 'フローティングバーを隠す',
      submenu: [
        ...[1, 15, 60].map((min) => ({
          label: min < 60 ? `${min} 分間` : '1 時間',
          click: () => settings.update({ floaterSnoozeUntil: Date.now() + min * 60_000 }),
        })),
        { label: '戻すまで', click: () => settings.update({ floaterSnoozeUntil: -1 }) },
      ],
    },
  ]).popup();
}

// ---------------------------------------------------------------------------
// 起動と終了
// ---------------------------------------------------------------------------

function setAppMenu(): void {
  // メニューバーは出ないが、編集のショートカット（⌘C / ⌘V / ⌘A など）と ⌘Q / ⌘W のために定義する
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Longhand',
        submenu: [
          { label: '設定…', accelerator: 'Command+,', click: () => management.open('settings') },
          { type: 'separator' },
          { label: 'ウィンドウを閉じる', accelerator: 'Command+Q', click: () => quitOrHide() },
        ],
      },
      { role: 'editMenu' },
      { label: 'ウィンドウ', submenu: [{ role: 'close' }, { role: 'minimize' }, { role: 'reload', visible: !app.isPackaged }, { role: 'toggleDevTools', visible: !app.isPackaged }] },
    ]),
  );
}

/** ⌘Q は UI だけを閉じて常駐を続ける（CORE-5）。完全な終了はトレイから */
function quitOrHide(): void {
  if (settings.get().quitOnlyFromTray) management.close();
  else quitCompletely();
}

/** 完全に終了する。後始末は before-quit で行う */
function quitCompletely(): void {
  if (quitting) return;
  app.quit();
}

app.on('second-instance', () => management.open());
app.on('window-all-closed', () => {
  // 常駐アプリなので、ウィンドウを閉じても終了しない
});
// ここに来るのは、完全な終了の要求だけである。⌘Q はメニューの項目（quitOrHide）が先に受けるので、ここには来ない。
// 来るのは、トレイの「終了」、ターミナルからの信号（SIGTERM、SIGINT、SIGHUP）、ログアウトやシステムの終了、
// アクティビティモニタの「終了」である。ここで終了を取り消すと、ログアウトやシステムの終了まで止めてしまう。
//
// 信号は、Electron が自分で受けて app.quit() と同じ処理に回す。process.on('SIGTERM') は効かない
// （main のスクリプトを読んだ後に、Electron が信号の受け口を自分のものに付け替えるため）。
app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  log.info('終了します');
  models.cancel();
  controller?.dispose();
  helper.stop();
  asr.stop();
  settings.flush();
  customizations.flush();
  history.flush();
  recordings.stop();
  micHealth.flush();
  // 後始末（ウィンドウ、ヘルパー、ASR ワーカー）が終わらなくても、必ず終了する
  setTimeout(() => {
    log.warn('終了の処理が 3 秒で終わらなかったので、強制的に終了します');
    app.exit(0);
  }, 3000).unref();
});

app.whenReady().then(async () => {
  app.dock?.hide();
  if (EVAL_SPEC) {
    // 評価だけを走らせて終了する。ヘルパー、トレイ、フローティングバー、通常の ASR は起動しない
    // （2 つ目のヘルパーが動くと、キー入力の取り合いが起きる）
    let code = 1;
    try {
      const { runEvalInApp } = await import('./evalInApp');
      code = await runEvalInApp(EVAL_SPEC, REAL_USER_DATA);
    } catch (e) {
      console.error(`評価に失敗しました: ${redact((e as Error).message)}`);
    }
    app.exit(code);
    return;
  }
  nativeTheme.themeSource = settings.get().appearance;
  lockDownRendererNetwork(typeof UI_VITE_DEV_SERVER_URL !== 'undefined' ? UI_VITE_DEV_SERVER_URL : undefined);
  setAppMenu();
  registerIpc();

  // 設定ファイルの古い形式を補正しておく
  settings.update(mergeSettings(settings.get()) as DeepPartial<Settings>);
  applyLoginItem(settings.get().launchAtLogin);

  floater.create();
  controller = new DictationController({
    helper,
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
    restartHelper: () => void helper.restart().catch((e) => log.error('ヘルパーの再起動に失敗', e)),
    restartAsr: () => void asr.restart(),
    quit: () => quitCompletely(),
  });
  tray.create({ recording: false, statusLine: statusLine(), warnings: [], settings: settings.get(), devices });

  recordings.start();
  await startHelper();
  void asr.start();
  watchAccessibility();
  // 起動の直後は避けて、少し後に読み込む（辞書の展開で約 120ms メインスレッドが止まる）
  if (needsTokenizer(settings.get())) setTimeout(() => void textfix.load(), 3000);

  if (process.env.LONGHAND_DEBUG_SELFTEST === 'mouse-hold' && !app.isPackaged) {
    // 開発用。通知を出して消すあいだ、実際のポインタでの当たり判定を外の道具で確かめる
    void runMouseHoldSelfTest(floater, (line) => log.info(`selftest: ${line}`)).then(() => quitCompletely());
  } else if (process.env.LONGHAND_DEBUG_SELFTEST === 'mouse' && !app.isPackaged) {
    // 開発用の自己診断。フローティングバーが、マウスの操作を受け取る状態のまま戻らなくならないかを確かめて終了する
    void runMouseRoutingSelfTest(floater).then((line) => {
      log.info(`selftest: ${line}`);
      quitCompletely();
    });
  } else if (process.env.LONGHAND_DEBUG_SELFTEST && !app.isPackaged) {
    // 開発用の自己診断。ヘルパーとの録音のやり取り、ASR、単語分割の状態をログに書いて終了する
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
  log.info(`起動しました（version=${app.getVersion()}）`);
});

process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
