import { randomUUID } from 'node:crypto';
import type { NotificationState } from '../../shared/settings';
import type { HudAction, HudKind, HudMessage } from '../../shared/types';

/**
 * 通知に付ける決まったボタン。id は main の組み込みの動作（BUILTIN_ACTIONS）に対応する。
 * 呼び出し側が渡すボタン（学習語の取り消しなど）は、この後ろに並ぶ。
 */
export const ACTION = {
  openHistory: { id: 'open-history', label: '履歴を開く' },
  openAudio: { id: 'open-audio', label: 'オーディオ設定' },
  openConnection: { id: 'open-connection', label: '接続を設定' },
  openMicPrivacy: { id: 'open-mic-privacy', label: 'システム設定を開く' },
  openAccessibility: { id: 'open-accessibility', label: 'システム設定を開く' },
  restartHelper: { id: 'restart-helper', label: '再起動する' },
} satisfies Record<string, HudAction>;

export interface Def {
  kind: HudKind;
  title: string;
  body?: string;
  /** 自動で消えるまでのミリ秒。0 なら、解決するか閉じるまで消えない */
  durationMs?: number;
  /** 「今後表示しない」を出すか（既定は出さない。案内の性格の通知だけ出す） */
  mutable?: boolean;
  /** 既定は card */
  style?: 'card' | 'pill';
  actions?: HudAction[];
  /** 表示回数の上限。windowMs を省くと生涯の回数 */
  limit?: { count: number; windowMs?: number };
  /** 前回の表示からの最小の間隔 */
  minIntervalMs?: number;
  /** 起動ごとに 1 回だけ */
  oncePerRun?: boolean;
  /** 表示と同時に通知音を鳴らす（効果音の設定に従う） */
  sound?: boolean;
  /** 録音中と処理中は出さずに、待機に戻ってから出す */
  deferWhileBusy?: boolean;
}

const DAY = 24 * 3600_000;

/**
 * HUD 通知の一覧（UI-6）。
 * {name} の形の差し込みは show() の vars で埋める。
 * main は {paste}（直前の書き起こしを貼り付ける方法）、{activate}、{cancel}、{lockExtra}、{mic} などを自動で補う。
 */
export const NOTIFICATIONS = {
  // 整形と編集
  LlmFailed: { kind: 'warning', title: '整形できなかったので、書き起こしをそのまま入力しました', body: '{reason}', durationMs: 6000 },
  LlmFailedRepeat: { kind: 'warning', style: 'pill', title: '整形せずに入力しました', durationMs: 3000 },
  LlmNotConfigured: {
    kind: 'info',
    title: 'LLM が未設定のため、書き起こしをそのまま入力しました',
    body: '設定の「接続」で LLM を設定すると整形されます',
    durationMs: 6000,
    actions: [ACTION.openConnection],
    oncePerRun: true,
    mutable: true,
  },
  EditFailed: { kind: 'error', title: '編集できませんでした', body: '{reason}', durationMs: 6000, sound: true, actions: [ACTION.openHistory] },
  /** 画面ではバーの中に短く出す（カードにしない） */
  EditUnclear: { kind: 'warning', style: 'pill', title: '言い直してください', durationMs: 3200 },
  EditTargetChanged: { kind: 'warning', style: 'pill', title: '選択範囲が変わったため、書き換えませんでした', durationMs: 6000, actions: [ACTION.openHistory] },

  // 入力
  NoPaste: { kind: 'warning', title: '入力先が見つかりませんでした', body: '{paste}', durationMs: 7000, actions: [ACTION.openHistory], sound: true },
  PasteUnconfirmed: { kind: 'warning', title: '入力できなかったかもしれません', body: '入っていなければ、{paste}', durationMs: 7000, actions: [ACTION.openHistory] },
  PasteFailed: { kind: 'error', title: '貼り付けに失敗しました', body: '{reason}', durationMs: 7000, actions: [ACTION.openHistory], sound: true },
  PastedLast: { kind: 'success', style: 'pill', title: '直前の書き起こしを貼り付けました', durationMs: 2500 },
  NoLastTranscript: { kind: 'info', style: 'pill', title: '貼り付けられる書き起こしがありません', durationMs: 3000 },
  StaleResult: { kind: 'info', title: '前の書き起こしは履歴に保存しました', body: '履歴からコピーできます', durationMs: 6000, actions: [ACTION.openHistory] },
  Cancelled: {
    kind: 'info',
    style: 'pill',
    title: '取り消しました',
    durationMs: 5000,
    actions: [ACTION.openHistory],
    limit: { count: 3, windowMs: 14 * DAY },
  },

  // 録音とマイク
  AllSilence: {
    kind: 'warning',
    title: 'マイクがミュートになっているかもしれません',
    body: '{silenceDetail}',
    durationMs: 9000,
    actions: [ACTION.openAudio],
    mutable: true,
    sound: true,
  },
  MicNoSignal: { kind: 'warning', style: 'pill', title: 'マイクから音が届いていません{micParen}', durationMs: 5000, sound: true },
  QuietMicrophone: {
    kind: 'warning',
    title: 'マイクの音がとても小さいです{micParen}',
    body: '認識の精度が落ちます。マイクに近づくか、入力音量を上げるか、別のマイクを選んでください',
    durationMs: 9000,
    actions: [ACTION.openAudio],
    mutable: true,
    limit: { count: 3, windowMs: 7 * DAY },
    minIntervalMs: DAY,
  },
  MicrophoneChanged: { kind: 'info', style: 'pill', title: '{mic} で録音しています', durationMs: 4000, mutable: true },
  NoSpeech: { kind: 'info', style: 'pill', title: '音声を聞き取れませんでした', durationMs: 3000 },
  MicPermissionDenied: {
    kind: 'error',
    title: 'マイクの使用が許可されていません',
    body: 'システム設定の「プライバシーとセキュリティ」で、Longhand のマイクをオンにしてください',
    durationMs: 0,
    actions: [ACTION.openMicPrivacy],
    sound: true,
  },
  NoMicrophone: { kind: 'error', title: 'マイクが見つかりません', body: 'マイクをつなぐと、すぐに使えます', durationMs: 0, actions: [ACTION.openAudio], sound: true },
  MicrophoneConnected: { kind: 'success', style: 'pill', title: '{name} をつなぎました', durationMs: 5000 },
  MicrophoneLost: { kind: 'error', title: '録音中にマイクが切断されました', durationMs: 7000, actions: [ACTION.openAudio], sound: true },
  MicrophoneSwitched: { kind: 'warning', style: 'pill', title: 'マイクが外れたので、別のマイクで録音を続けています', durationMs: 6000, sound: true },
  MicrophoneError: { kind: 'error', title: 'マイクを開けませんでした', body: '{reason}', durationMs: 7000, actions: [ACTION.openAudio], sound: true },
  BluetoothMic: {
    kind: 'info',
    title: 'Bluetooth のマイクを使っています',
    body: '音質が下がり、認識の精度が落ちることがあります。内蔵マイクも選べます',
    durationMs: 7000,
    actions: [ACTION.openAudio],
    mutable: true,
    limit: { count: 3 },
    minIntervalMs: DAY,
  },

  // 音声認識
  AsrFailed: { kind: 'error', title: '書き起こしに失敗しました', body: '{reason}', durationMs: 7000, actions: [ACTION.openHistory], sound: true },
  AsrNotReady: {
    kind: 'error',
    title: '音声認識の準備ができていませんでした',
    body: '準備ができたら、履歴の「書き起こし直す」で書き起こせます',
    durationMs: 8000,
    actions: [ACTION.openHistory],
    sound: true,
  },
  AsrWaiting: { kind: 'info', style: 'pill', title: '音声認識の準備を待って入力します', durationMs: 4000 },
  AsrReady: { kind: 'success', style: 'pill', title: '準備ができました。{activate} を押しながら話してください', durationMs: 5000 },

  // ヘルパーと権限
  HelperCrashed: { kind: 'error', title: '録音中にヘルパーが終了しました', body: 'それまでに録れた分を書き起こします。ヘルパーは自動で起動し直します', durationMs: 7000 },
  HelperFailed: {
    kind: 'error',
    title: 'ヘルパーが動いていません',
    body: 'ホットキーと貼り付けが使えません',
    durationMs: 0,
    actions: [ACTION.restartHelper],
    sound: true,
  },
  AccessibilityMissing: {
    kind: 'error',
    title: 'アクセシビリティの許可が必要です',
    body: 'システム設定の「プライバシーとセキュリティ」で、Longhand をオンにしてください',
    durationMs: 10000,
    actions: [ACTION.openAccessibility],
    sound: true,
  },
  AccessibilityRevoked: {
    kind: 'error',
    title: 'アクセシビリティの許可が外れました',
    body: 'キーの検出と入力ができません。システム設定で Longhand をオンにし直してください',
    durationMs: 0,
    actions: [ACTION.openAccessibility],
    sound: true,
  },
  AccessibilityRestored: { kind: 'success', style: 'pill', title: 'アクセシビリティが使えるようになりました', durationMs: 3000 },
  /** 別のアプリがキー入力を先に受け取り続けている（ヘルパーの event_tap: rival_in_front） */
  HotkeyRival: {
    kind: 'warning',
    title: '別のアプリがキー入力を先に受け取っています',
    body: '{name} が先にキーを受け取るため、{activate} が効かないことがあります。効かないときは {name} を終了してください',
    durationMs: 10000,
    oncePerRun: true,
    minIntervalMs: DAY,
    mutable: true,
  },

  // 学習と案内
  WordsLearned: { kind: 'success', style: 'pill', title: '「{words}」を辞書に追加しました', durationMs: 6000, deferWhileBusy: true },
  /** 学習した語が複数のとき（main が WordsLearned から切り替える） */
  WordsLearnedMany: { kind: 'success', style: 'pill', title: '「{first}」など {count} 語を辞書に追加しました', durationMs: 6000 },
  WordsLearnedUndone: { kind: 'info', style: 'pill', title: '学習を取り消しました', durationMs: 2000 },
  /** 辞書に語を足さない学習（聞き違えた形、取り違えの組、書き換えない語句）。text は直した後の形 */
  CorrectionLearned: { kind: 'success', style: 'pill', title: '「{text}」の直し方を覚えました', durationMs: 6000, deferWhileBusy: true },
  CorrectionsLearnedMany: { kind: 'success', style: 'pill', title: '「{text}」など {count} 件の直し方を覚えました', durationMs: 6000, deferWhileBusy: true },
  HandsFreeInfo: {
    kind: 'info',
    title: 'ハンズフリーで録音中',
    body: 'もう一度キーを押すと確定、{cancel} で取り消します',
    durationMs: 4000,
    mutable: true,
    limit: { count: 3 },
  },
  HoldLongHint: {
    kind: 'info',
    style: 'pill',
    title: '押したまま {lockExtra} を押すと、キーを離しても録音が続きます',
    durationMs: 5000,
    mutable: true,
    limit: { count: 3 },
  },
} satisfies Record<string, Def>;

export type NotificationKey = keyof typeof NOTIFICATIONS;

export function notificationDef(key: string): Def | undefined {
  return (NOTIFICATIONS as Record<string, Def>)[key];
}

/** 表示の記録として残す時刻の数（上限の判定に使う分だけ） */
const MAX_TIMES = 10;

/**
 * 表示回数の上限を確かめる（N4）。
 * runShown は、この起動で既に出した通知の集合。
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

/** 表示したことを記録した新しい状態 */
export function recordShown(st: NotificationState | undefined, now: number): NotificationState {
  return {
    muted: st?.muted ?? false,
    count: (st?.count ?? 0) + 1,
    last: now,
    times: [...(st?.times ?? []), now].slice(-MAX_TIMES),
  };
}

export function buildHud(key: NotificationKey, vars: Record<string, string> = {}, actions?: HudAction[]): HudMessage {
  const d: Def = NOTIFICATIONS[key];
  const fill = (s?: string) => s?.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '').trim();
  const all = [...(d.actions ?? []), ...(actions ?? [])];
  return {
    id: randomUUID(),
    key,
    kind: d.kind,
    title: fill(d.title) ?? '',
    body: fill(d.body) || undefined,
    actions: all.length ? all : undefined,
    durationMs: d.durationMs ?? 4000,
    mutable: d.mutable ?? false,
    style: d.style ?? 'card',
  };
}
