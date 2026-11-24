import type { Settings } from './settings';

// ---------------------------------------------------------------------------
// カスタマイズ（辞書、置換、カスタム指示、学習語）
// ---------------------------------------------------------------------------

export interface Replacement {
  id: string;
  /** 置換前（話し言葉としての表記） */
  from: string;
  /** 置換後（最大 5000 字） */
  to: string;
  /**
   * オン（既定）: 置換後の文字列を書いたとおりに入れる。
   * オフ: 文頭に入り、置換後の先頭が英小文字なら、その 1 文字を大文字にする。
   * 一致はどちらでも大文字小文字と全角半角を区別しない（main/format/postprocess.ts の applyReplacements）
   */
  preserveCase: boolean;
  /** 置換後の直後にある句読点を取り除く（URL やコマンドなど） */
  noPunctuation: boolean;
}

export interface LearnedWord {
  word: string;
  /** 学習のもとになった誤認識（例: 「くばねてす」） */
  from: string;
  learnedAt: number;
}

/** 音声認識の取り違えを、利用者が手で直した組（同じ読みの別の語、表記の好みなど）。辞書には入れず、整形に候補として渡す */
export interface PastCorrection {
  /** 音声認識が書いた語句 */
  heard: string;
  /** 利用者が直した語句 */
  corrected: string;
  /** 同じ直しをした回数 */
  count: number;
  /** 最後に直した時刻 */
  at: number;
}

/** 整形が書き換えたあと、利用者が手で元に戻した語句。整形に「書き換えない語句」として渡す */
export interface KeptPhrase {
  /** 利用者が戻した語句（話したとおりの形） */
  phrase: string;
  /** 整形が書き換えた形 */
  changedTo: string;
  count: number;
  at: number;
}

export interface Customizations {
  version: 1;
  dictionary: string[];
  replacements: Replacement[];
  customInstructions: string;
  learnedWords: LearnedWord[];
  /** 取り消した学習語（同じ語を二度と学習しない） */
  blockedLearnedWords: string[];
  /** 語ごとの読み（カタカナ）。利用者が入力または採用したもので、書き起こしの後の照合に使う（G4-11） */
  readings?: Record<string, string[]>;
  /** LLM が作った読みの候補（未確認。照合の候補にだけ使い、置き換えには使わない） */
  suggestedReadings?: Record<string, string[]>;
  /**
   * 語ごとの、音声認識が聞き違えた形（利用者の手直しから学んだもの）。辞書の語にも学習語にも付く。
   * 学習語の最初の形は learnedWords の from にあり、ここには 2 つ目からの形と、辞書の語の形が入る
   */
  misheard?: Record<string, string[]>;
  /** 利用者が直した、音声認識の取り違えの組 */
  pastCorrections?: PastCorrection[];
  /** 整形の書き換えを、利用者が元に戻した語句 */
  keptPhrases?: KeptPhrase[];
  /** 置換の preserveCase を新しい意味（オンで書いたとおり）に移したか（G4-12。main/store/customizations.ts） */
  replacementCaseMigrated?: boolean;
}

export const EMPTY_CUSTOMIZATIONS: Customizations = {
  version: 1,
  dictionary: [],
  replacements: [],
  customInstructions: '',
  learnedWords: [],
  blockedLearnedWords: [],
};

/** カスタマイズの上限（本体の検査とスタイル画面の表示で同じ値を使う） */
export const CUSTOMIZATION_LIMITS = {
  /** 辞書の件数 */
  dictionary: 2000,
  /** 辞書の 1 語の長さ */
  wordLength: 100,
  /** 学習語の件数。超えたら古い語から外す */
  learned: 500,
  /** 置換後の文字列の長さ */
  replacementTo: 5000,
  /** 1 語が持つ、聞き違えた形の数。超えたら古い形から外す */
  misheardPerWord: 6,
  /** 取り違えの組の件数。超えたら古い組から外す */
  pastCorrections: 200,
  /** 書き換えない語句の件数。超えたら古い語句から外す */
  keptPhrases: 200,
} as const;

// ---------------------------------------------------------------------------
// 履歴
// ---------------------------------------------------------------------------

/**
 * 1 回分の処理時間（ms）。asrMs / llmMs / totalMs は各段の所要時間。
 * 〜DoneMs は、main がキーを離す操作を受けた時刻からの経過（区間ごとの遅延の内訳）
 */
export interface HistoryTimings {
  asrMs: number;
  llmMs: number;
  totalMs: number;
  /** キーを離してから main が受け取るまで（ヘルパーのイベント時刻からの推定） */
  releaseLagMs?: number;
  /** 録音の停止を確認するまで */
  stoppedMs?: number;
  /** キーを離した後も録音を続けた時間（asr.tailMs）。続けなかったときは無い。録音の末尾のこの長さが、離した後の音声 */
  postRollMs?: number;
  /** 書き起こしが揃うまで */
  asrDoneMs?: number;
  /** 整形が終わるまで */
  llmDoneMs?: number;
  /** 前の録音の貼り付けを待った時間 */
  pasteWaitMs?: number;
  /** ⌘V を送るまで（ヘルパーが報告したときだけ） */
  keyPostedMs?: number;
  /** 貼り付けの ACK を受け取るまで */
  ackMs?: number;
  /** 投機的な書き起こしの結果を使ったか（hit）、使えなかったか（miss） */
  speculative?: 'hit' | 'miss';
}

export interface HistoryItem {
  id: string;
  timestamp: number;
  mode: 'dictation' | 'edit';
  /** 貼り付けた（または貼り付けるはずだった）文 */
  text: string;
  /** ASR の生テキスト */
  rawText: string;
  /** 編集モードで選択されていた文 */
  selectedText?: string;
  /** LLM で整形したか。false なら生テキストのまま（skipLlm、失敗、タイムアウト） */
  formatted: boolean;
  llmError?: string;
  app?: { name: string; bundleId: string };
  host?: string;
  durationSec: number;
  /** recordings/ からの相対パス */
  audioFile?: string;
  language: string;
  timings: HistoryTimings;
  /** 貼り付けの結果 */
  paste: 'pasted' | 'failed' | 'skipped' | 'stale' | 'cancelled';
  /** 編集モードで、指示を編集として解釈できなかった（履歴に「不明確な編集」と出す。N5） */
  editUnclear?: boolean;
  /** LLM を飛ばす近道（llmFastPath）で確定した（N6） */
  fastPath?: boolean;
  /** 書き起こしの語ごとの補正（textfix）で直した箇所。直した文を貼ったときだけ残す（履歴に「自動修正」と出す） */
  autoFixes?: AutoFix[];
  /** 入力先の画面の文から拾えた、名前らしい英字の語（録音を残す設定のときだけ。評価で、ヒントにした場合の効果を確かめるために残す） */
  contextTerms?: string[];
}

/** textfix で直した 1 か所（履歴の表示と「今後は直さない」に使う） */
export interface AutoFix {
  rule: 'latin' | 'fillers' | 'notation' | 'particles';
  before: string;
  after: string;
}

// ---------------------------------------------------------------------------
// フローティングバー
// ---------------------------------------------------------------------------

export type FloaterPhase = 'idle' | 'recording' | 'locked' | 'finalizing';

export interface FloaterState {
  phase: FloaterPhase;
  mode: 'dictation' | 'edit';
  /** 編集モードで選択されている文字数 */
  selectionChars: number;
  /** 録音開始からの経過時間の基準（ms エポック） */
  startedAt: number | null;
  /** 処理中の段階（表示用） */
  stage?: 'transcribing' | 'formatting' | 'pasting';
  /** 表示するかどうか（設定とスヌーズの反映後） */
  visible: boolean;
  /**
   * 録音中に、マイクの音が実際に届き始めたか（最初の音声チャンクの到着）。
   * false の間は録音中の表示を控えめにする。undefined は true と同じ扱い
   */
  micReady?: boolean;
  /** 録音に使っているマイクの名前（分かった時点で送る） */
  micName?: string;
  /** 待機中に一時的に出す表示。pasted は貼り付けの成功 */
  flash?: 'pasted' | null;
}

export type HudKind = 'info' | 'success' | 'warning' | 'error';

export interface HudAction {
  id: string;
  label: string;
}

export interface HudMessage {
  id: string;
  /** 通知の種類（ミュートと表示回数の記録に使う） */
  key: string;
  kind: HudKind;
  title: string;
  body?: string;
  actions?: HudAction[];
  /** 自動で消えるまでのミリ秒。0 なら消えない */
  durationMs: number;
  mutable: boolean;
  /** card は見出しと本文のある通知、pill は 1 行の小さな通知 */
  style?: 'card' | 'pill';
}

// ---------------------------------------------------------------------------
// 画面との IPC
// ---------------------------------------------------------------------------

export interface PermissionStatus {
  accessibility: boolean;
  microphone: 'granted' | 'denied' | 'undetermined' | 'restricted';
  helperRunning: boolean;
}

export interface EngineStatus {
  helper: 'starting' | 'running' | 'restarting' | 'failed';
  asr: 'starting' | 'loading' | 'ready' | 'failed' | 'missing';
  asrMessage?: string;
  llmConfigured: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  elapsedMs: number;
  model?: string;
  output?: string;
  error?: string;
}

export interface AsrTestResult {
  ok: boolean;
  text?: string;
  elapsedMs?: number;
  error?: string;
}

/** 音声認識のモデルの取得（ASR-5） */
export interface ModelDownloadState {
  state: 'idle' | 'downloading' | 'waiting' | 'done' | 'failed' | 'cancelled';
  /** 既定のエンジンのモデルがそろっているか */
  installed: boolean;
  /** アプリに同梱されたモデルを使っているか（利用者のフォルダにはない） */
  bundled?: boolean;
  receivedBytes: number;
  totalBytes: number;
  /** 取得中のファイル名 */
  file?: string;
  error?: string;
  /** 再試行までの秒数（state が waiting のとき） */
  retryInSec?: number;
}

export interface AppSnapshot {
  settings: Settings;
  hasApiKey: boolean;
  customizations: Customizations;
  status: EngineStatus;
  modelDownload: ModelDownloadState;
  permissions: PermissionStatus;
  version: string;
  paths: { userData: string; logs: string; recordings: string; models: string };
}

/** レンダラに公開する API（preload で window.longhand として出す） */
export interface LonghandApi {
  // 共通
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(cb: (s: AppSnapshot) => void): () => void;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  setApiKey(key: string): Promise<void>;
  updateCustomizations(patch: Partial<Customizations>): Promise<Customizations>;
  openExternal(target: 'accessibility' | 'microphone' | 'keyboard' | 'logs' | 'recordings' | 'models'): Promise<void>;
  requestPermission(kind: 'accessibility' | 'microphone'): Promise<PermissionStatus>;
  refreshPermissions(): Promise<PermissionStatus>;

  // 履歴
  listHistory(query?: string): Promise<HistoryItem[]>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  copyText(text: string): Promise<void>;
  readAudio(id: string): Promise<ArrayBuffer | null>;
  saveAudioAs(id: string): Promise<boolean>;
  onHistoryChanged(cb: () => void): () => void;
  /**
   * 履歴の項目をやり直す（H1）。
   * transcribe は録音から書き起こし直して整形もやり直す。format は書き起こしはそのままで整形だけやり直す
   */
  redoHistory(id: string, opts: { kind: 'transcribe' | 'format'; language?: Settings['language'] }): Promise<{ ok: boolean; error?: string }>;
  /** 履歴の文を手で直す（G4-08）。学習がオンなら、直した語を辞書に学習し、その語を返す */
  /** learned は辞書に足した語、remembered は語を足さずに覚えた直し方（聞き違えた形、取り違えの組、書き換えない語句）の数 */
  editHistory(id: string, text: string): Promise<{ ok: boolean; error?: string; learned?: string[]; remembered?: number; tooMany?: boolean }>;

  // 接続
  testLlm(): Promise<ConnectionTestResult>;
  testAsr(): Promise<AsrTestResult>;
  restartAsr(): Promise<void>;
  /** 音声認識のモデルを取得する（ASR-5）。進みぐあいは snapshot の modelDownload に出る */
  downloadModel(): Promise<boolean>;
  cancelModelDownload(): Promise<void>;
  /** 別の PC で取得したモデルのファイルかフォルダを選んで取り込む */
  importModel(): Promise<{ ok: boolean; imported: string[]; rejected: string[] }>;
  importConnection(): Promise<{ ok: boolean; error?: string }>;
  /** removedHeaders: 認証情報らしいので書き出さなかったヘッダ */
  exportConnection(): Promise<{ ok: boolean; error?: string; removedHeaders?: string[] }>;

  // キーバインド（HK-8）
  recordShortcut(active: boolean): Promise<void>;
  onShortcutKeys(cb: (p: { keys: string[]; combo: string[]; done: boolean }) => void): () => void;
  onHotkeyTest(cb: (p: { action: string; phase: string }) => void): () => void;
  /** オンボーディングのキーのテスト中だけ hotkey を画面に流す */
  hotkeyTest(active: boolean): Promise<void>;

  // オーディオ
  listMicrophones(): Promise<{ id: string; name: string; isDefault: boolean; isVirtual: boolean; transport: string }[]>;
  testMicrophone(seconds: number): Promise<{ ok: boolean; peak: number; rms: number; error?: string }>;
  onMicLevel(cb: (rms: number) => void): () => void;

  // 学習
  undoLearnedWord(word: string): Promise<void>;

  // フローティングバー
  onFloaterState(cb: (s: FloaterState) => void): () => void;
  onLevel(cb: (rms: number) => void): () => void;
  onHud(cb: (m: HudMessage) => void): () => void;
  onHudDismiss(cb: (id: string) => void): () => void;
  onPlaySound(cb: (p: { name: SoundName; volume: number }) => void): () => void;
  floaterAction(action: 'start' | 'finish' | 'cancel' | 'menu' | 'hud-action', arg?: string): void;
  setMouseInteractive(interactive: boolean): void;
  hudMute(key: string): void;

  // 管理ウィンドウ
  onNavigate(cb: (page: string) => void): () => void;
  completeOnboarding(): Promise<void>;
}

export type SoundName = 'start' | 'stop' | 'cancel' | 'error' | 'notify' | 'lock';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
