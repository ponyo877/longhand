import { randomUUID } from 'node:crypto';
import { rawMessage, type Message, type MessageKey } from '../../shared/i18n';
import type { NotificationState } from '../../shared/settings';
import type { HudAction, HudKind, HudMessage } from '../../shared/types';
import { currentLocale, t } from '../i18n';

/** A button in a notification's definition. label is a catalog key, translated when the notification is shown */
export interface DefAction {
  id: string;
  label: MessageKey;
}

/**
 * Fixed buttons attached to notifications. Each id maps to a built-in action in main (BUILTIN_ACTIONS).
 * Buttons passed by the caller (undoing a learned word, for example) come after these.
 */
export const ACTION = {
  openHistory: { id: 'open-history', label: 'hud.action.openHistory' },
  openAudio: { id: 'open-audio', label: 'hud.action.openAudio' },
  openConnection: { id: 'open-connection', label: 'hud.action.openConnection' },
  openMicPrivacy: { id: 'open-mic-privacy', label: 'hud.action.openMicPrivacy' },
  openAccessibility: { id: 'open-accessibility', label: 'hud.action.openAccessibility' },
  restartHelper: { id: 'restart-helper', label: 'hud.action.restartHelper' },
} satisfies Record<string, DefAction>;

/** How a notification behaves. Its text is in the catalog: `hud.<Key>.title` and, if it has one, `hud.<Key>.body` (shared/i18n/messages/hud.ts) */
export interface Def {
  kind: HudKind;
  /** Milliseconds until it disappears by itself. 0 keeps it until it is resolved or closed */
  durationMs?: number;
  /** Whether to offer "Don't show again" (off by default; only for notifications that are tips) */
  mutable?: boolean;
  /** card by default */
  style?: 'card' | 'pill';
  actions?: DefAction[];
  /** Maximum number of times to show it. Without windowMs, the count is over the whole lifetime */
  limit?: { count: number; windowMs?: number };
  /** Minimum time since it was last shown */
  minIntervalMs?: number;
  /** Only once per launch */
  oncePerRun?: boolean;
  /** Play the notification sound when it is shown (follows the sound effects setting) */
  sound?: boolean;
  /** Not shown while recording or processing; shown once back to idle */
  deferWhileBusy?: boolean;
}

const DAY = 24 * 3600_000;

/**
 * HUD notifications (UI-6).
 * Placeholders of the form {name} in the text are filled from the vars passed to show().
 * main fills in {paste} (how to paste the last transcript), {activate}, {cancel}, {lockExtra}, {mic} and others automatically.
 */
export const NOTIFICATIONS = {
  // Formatting and editing
  LlmFailed: { kind: 'warning', durationMs: 6000 },
  LlmFailedRepeat: { kind: 'warning', style: 'pill', durationMs: 3000 },
  LlmNotConfigured: {
    kind: 'info',
    durationMs: 6000,
    actions: [ACTION.openConnection],
    oncePerRun: true,
    mutable: true,
  },
  EditFailed: { kind: 'error', durationMs: 6000, sound: true, actions: [ACTION.openHistory] },
  /** Shown briefly inside the bar (not as a card) */
  EditUnclear: { kind: 'warning', style: 'pill', durationMs: 3200 },
  EditTargetChanged: { kind: 'warning', style: 'pill', durationMs: 6000, actions: [ACTION.openHistory] },

  // Typing
  NoPaste: { kind: 'warning', durationMs: 7000, actions: [ACTION.openHistory], sound: true },
  PasteUnconfirmed: { kind: 'warning', durationMs: 7000, actions: [ACTION.openHistory] },
  PasteFailed: { kind: 'error', durationMs: 7000, actions: [ACTION.openHistory], sound: true },
  PastedLast: { kind: 'success', style: 'pill', durationMs: 2500 },
  NoLastTranscript: { kind: 'info', style: 'pill', durationMs: 3000 },
  StaleResult: { kind: 'info', durationMs: 6000, actions: [ACTION.openHistory] },
  Cancelled: {
    kind: 'info',
    style: 'pill',
    durationMs: 5000,
    actions: [ACTION.openHistory],
    limit: { count: 3, windowMs: 14 * DAY },
  },

  // Recording and the microphone
  AllSilence: {
    kind: 'warning',
    durationMs: 9000,
    actions: [ACTION.openAudio],
    mutable: true,
    sound: true,
  },
  MicNoSignal: { kind: 'warning', style: 'pill', durationMs: 5000, sound: true },
  QuietMicrophone: {
    kind: 'warning',
    durationMs: 9000,
    actions: [ACTION.openAudio],
    mutable: true,
    limit: { count: 3, windowMs: 7 * DAY },
    minIntervalMs: DAY,
  },
  MicrophoneChanged: { kind: 'info', style: 'pill', durationMs: 4000, mutable: true },
  NoSpeech: { kind: 'info', style: 'pill', durationMs: 3000 },
  MicPermissionDenied: {
    kind: 'error',
    durationMs: 0,
    actions: [ACTION.openMicPrivacy],
    sound: true,
  },
  NoMicrophone: { kind: 'error', durationMs: 0, actions: [ACTION.openAudio], sound: true },
  MicrophoneConnected: { kind: 'success', style: 'pill', durationMs: 5000 },
  MicrophoneLost: { kind: 'error', durationMs: 7000, actions: [ACTION.openAudio], sound: true },
  MicrophoneSwitched: { kind: 'warning', style: 'pill', durationMs: 6000, sound: true },
  MicrophoneError: { kind: 'error', durationMs: 7000, actions: [ACTION.openAudio], sound: true },
  BluetoothMic: {
    kind: 'info',
    durationMs: 7000,
    actions: [ACTION.openAudio],
    mutable: true,
    limit: { count: 3 },
    minIntervalMs: DAY,
  },

  // Speech recognition
  AsrFailed: { kind: 'error', durationMs: 7000, actions: [ACTION.openHistory], sound: true },
  AsrNotReady: {
    kind: 'error',
    durationMs: 8000,
    actions: [ACTION.openHistory],
    sound: true,
  },
  AsrWaiting: { kind: 'info', style: 'pill', durationMs: 4000 },
  AsrReady: { kind: 'success', style: 'pill', durationMs: 5000 },

  // The helper and permissions
  HelperCrashed: { kind: 'error', durationMs: 7000 },
  HelperFailed: {
    kind: 'error',
    durationMs: 0,
    actions: [ACTION.restartHelper],
    sound: true,
  },
  AccessibilityMissing: {
    kind: 'error',
    durationMs: 10000,
    actions: [ACTION.openAccessibility],
    sound: true,
  },
  AccessibilityRevoked: {
    kind: 'error',
    durationMs: 0,
    actions: [ACTION.openAccessibility],
    sound: true,
  },
  AccessibilityRestored: { kind: 'success', style: 'pill', durationMs: 3000 },
  /** Another app keeps receiving key presses first (the helper's event_tap: rival_in_front) */
  HotkeyRival: {
    kind: 'warning',
    durationMs: 10000,
    oncePerRun: true,
    minIntervalMs: DAY,
    mutable: true,
  },

  // Learning and tips
  WordsLearned: { kind: 'success', style: 'pill', durationMs: 6000, deferWhileBusy: true },
  /** When several words were learned (main switches to this from WordsLearned) */
  WordsLearnedMany: { kind: 'success', style: 'pill', durationMs: 6000 },
  WordsLearnedUndone: { kind: 'info', style: 'pill', durationMs: 2000 },
  /** Learning that adds no word to the dictionary (misheard forms, swapped pairs, phrases to keep). text is the corrected form */
  CorrectionLearned: { kind: 'success', style: 'pill', durationMs: 6000, deferWhileBusy: true },
  CorrectionsLearnedMany: { kind: 'success', style: 'pill', durationMs: 6000, deferWhileBusy: true },
  /** A correction that only changed how a number is written. text is the corrected number */
  NumberStyleLearned: { kind: 'success', style: 'pill', durationMs: 6000, deferWhileBusy: true },
  HandsFreeInfo: {
    kind: 'info',
    durationMs: 4000,
    mutable: true,
    limit: { count: 3 },
  },
  HoldLongHint: {
    kind: 'info',
    style: 'pill',
    durationMs: 5000,
    mutable: true,
    limit: { count: 3 },
  },
} satisfies Record<string, Def>;

export type NotificationKey = keyof typeof NOTIFICATIONS;

export function notificationDef(key: string): Def | undefined {
  return (NOTIFICATIONS as Record<string, Def>)[key];
}

/** Number of display times to keep in the record (only as many as the limit check needs) */
const MAX_TIMES = 10;

/**
 * Checks the display limits (N4).
 * runShown is the set of notifications already shown in this launch.
 */
export function shouldShow(key: string, def: Def, st: NotificationState | undefined, now: number, runShown: ReadonlySet<string>): boolean {
  if (st?.muted) return false;
  if (def.oncePerRun && runShown.has(key)) return false;
  if (def.minIntervalMs && st?.last && now - st.last < def.minIntervalMs) return false;
  if (def.limit) {
    const times = st?.times ?? (st?.last ? Array.from({ length: Math.min(st.count, MAX_TIMES) }, () => st.last) : []);
    const inWindow = def.limit.windowMs ? times.filter((t) => now - t < def.limit!.windowMs!) : times;
    const used = def.limit.windowMs ? inWindow.length : Math.max(inWindow.length, st?.count ?? 0);
    if (used >= def.limit.count) return false;
  }
  return true;
}

/** A new state that records one more display */
export function recordShown(st: NotificationState | undefined, now: number): NotificationState {
  return {
    muted: st?.muted ?? false,
    count: (st?.count ?? 0) + 1,
    last: now,
    times: [...(st?.times ?? []), now].slice(-MAX_TIMES),
  };
}

/** A notification's text in the current interface language, or undefined when the catalog has none (a notification without a body) */
function hudText(key: NotificationKey, part: 'title' | 'body'): Message | undefined {
  return rawMessage(currentLocale(), `hud.${key}.${part}` as MessageKey) as Message | undefined;
}

export function buildHud(key: NotificationKey, vars: Record<string, string> = {}, actions?: HudAction[]): HudMessage {
  const d: Def = NOTIFICATIONS[key];
  // A placeholder without a value becomes '' (an optional part such as {micParen} drops out)
  const fill = (m?: Message) => (m === undefined ? undefined : (typeof m === 'function' ? m(vars) : m).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '').trim());
  const all = [...(d.actions ?? []).map((a) => ({ id: a.id, label: t(a.label) })), ...(actions ?? [])];
  return {
    id: randomUUID(),
    key,
    kind: d.kind,
    title: fill(hudText(key, 'title')) ?? '',
    body: fill(hudText(key, 'body')) || undefined,
    actions: all.length ? all : undefined,
    durationMs: d.durationMs ?? 4000,
    mutable: d.mutable ?? false,
    style: d.style ?? 'card',
  };
}
