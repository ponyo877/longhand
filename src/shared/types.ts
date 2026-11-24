import type { Locale } from './i18n/locale';
import type { NumberStyles } from './numberStyle';
import type { Settings } from './settings';

// ---------------------------------------------------------------------------
// Customizations (dictionary, replacements, custom instructions, learned words)
// ---------------------------------------------------------------------------

export interface Replacement {
  id: string;
  /** Text to replace (as written for speech) */
  from: string;
  /** Replacement (up to 5000 characters) */
  to: string;
  /**
   * On (default): the replacement is inserted exactly as written.
   * Off: at the start of a sentence, if the replacement starts with a lowercase Latin letter, that letter is capitalized.
   * Either way, matching ignores case and full-width / half-width differences (applyReplacements in main/format/postprocess.ts)
   */
  preserveCase: boolean;
  /** Removes punctuation right after the replacement (for URLs, commands and so on) */
  noPunctuation: boolean;
}

export interface LearnedWord {
  word: string;
  /** The misrecognition it was learned from (for example 「くばねてす」) */
  from: string;
  learnedAt: number;
}

/** A speech recognition mix-up the user corrected by hand (another word with the same reading, a preferred spelling and so on). Not added to the dictionary; passed to formatting as a candidate */
export interface PastCorrection {
  /** Phrase the speech recognizer wrote */
  heard: string;
  /** Phrase the user corrected it to */
  corrected: string;
  /** How many times the same correction was made */
  count: number;
  /** When it was last corrected */
  at: number;
}

/** A phrase the user changed back by hand after formatting rewrote it. Passed to formatting as a phrase not to rewrite */
export interface KeptPhrase {
  /** Phrase the user restored (as spoken) */
  phrase: string;
  /** What formatting rewrote it to */
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
  /** Learned words the user removed (never learned again) */
  blockedLearnedWords: string[];
  /** Readings per word (katakana), typed or accepted by the user. Used for matching after transcription (G4-11) */
  readings?: Record<string, string[]>;
  /** Reading candidates made by the LLM (unconfirmed. Used only as matching candidates, never for replacing) */
  suggestedReadings?: Record<string, string[]>;
  /**
   * Per word, the forms the speech recognizer misheard it as (learned from the user's corrections). Attached to both dictionary words and learned words.
   * The first form of a learned word is in its from in learnedWords; this holds the forms from the second one on, and the forms of dictionary words
   */
  misheard?: Record<string, string[]>;
  /** Speech recognition mix-ups the user corrected */
  pastCorrections?: PastCorrection[];
  /** Phrases where the user undid a rewrite by formatting */
  keptPhrases?: KeptPhrase[];
  /** How the user writes numbers, learned from corrections (shared/numberStyle.ts) */
  numberStyle?: NumberStyles;
  /** Whether preserveCase of replacements was moved to its new meaning (on means as written) (G4-12. main/store/customizations.ts) */
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

/** Customization limits (the same values are used by the checks in the app and by the Style page) */
export const CUSTOMIZATION_LIMITS = {
  /** Number of dictionary words */
  dictionary: 2000,
  /** Length of one dictionary word */
  wordLength: 100,
  /** Number of learned words. Beyond this, the oldest are dropped */
  learned: 500,
  /** Length of a replacement */
  replacementTo: 5000,
  /** Number of misheard forms per word. Beyond this, the oldest forms are dropped */
  misheardPerWord: 6,
  /** Number of mix-up pairs. Beyond this, the oldest pairs are dropped */
  pastCorrections: 200,
  /** Number of phrases not to rewrite. Beyond this, the oldest are dropped */
  keptPhrases: 200,
} as const;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Processing times for one dictation (ms). asrMs / llmMs / totalMs are the time of each stage.
 * The ...DoneMs values are the time since main received the key release (a breakdown of the latency per stage)
 */
export interface HistoryTimings {
  asrMs: number;
  llmMs: number;
  totalMs: number;
  /** From releasing the key to main receiving it (estimated from the helper's event time) */
  releaseLagMs?: number;
  /** Until the recording was confirmed stopped */
  stoppedMs?: number;
  /** How long recording went on after the key was released (asr.tailMs). Absent when it did not. The last this-long part of the recording is the audio after the release */
  postRollMs?: number;
  /** Until the transcription was complete */
  asrDoneMs?: number;
  /** Until formatting finished */
  llmDoneMs?: number;
  /** Time spent waiting for the previous recording's paste */
  pasteWaitMs?: number;
  /** Until ⌘V was sent (only when the helper reported it) */
  keyPostedMs?: number;
  /** Until the paste ACK arrived */
  ackMs?: number;
  /** Whether the speculative transcription was used (hit) or could not be used (miss) */
  speculative?: 'hit' | 'miss';
}

export interface HistoryItem {
  id: string;
  timestamp: number;
  mode: 'dictation' | 'edit';
  /** Text pasted (or that was to be pasted) */
  text: string;
  /** Raw ASR text */
  rawText: string;
  /** Text selected in edit mode */
  selectedText?: string;
  /** Whether the LLM formatted it. false means the raw text was kept (skipLlm, failure, timeout) */
  formatted: boolean;
  llmError?: string;
  app?: { name: string; bundleId: string };
  host?: string;
  durationSec: number;
  /** Path relative to recordings/ */
  audioFile?: string;
  language: string;
  timings: HistoryTimings;
  /** Result of the paste */
  paste: 'pasted' | 'failed' | 'skipped' | 'stale' | 'cancelled';
  /** In edit mode, the instruction could not be read as an edit (the history shows it as an unclear edit. N5) */
  editUnclear?: boolean;
  /** Finished by the shortcut that skips the LLM (llmFastPath) (N6) */
  fastPath?: boolean;
  /** Spots fixed by the per-word correction of the transcription (textfix). Kept only when the fixed text was pasted (the history shows them as automatic fixes) */
  autoFixes?: AutoFix[];
  /** Name-like Latin words found in the text on the target screen (only when recordings are kept. Kept so that evaluation can check the effect of using them as hints) */
  contextTerms?: string[];
}

/** One spot fixed by textfix (for the history display and for "do not fix this again") */
export interface AutoFix {
  rule: 'latin' | 'fillers' | 'notation' | 'particles';
  before: string;
  after: string;
}

// ---------------------------------------------------------------------------
// Floating bar
// ---------------------------------------------------------------------------

export type FloaterPhase = 'idle' | 'recording' | 'locked' | 'finalizing';

export interface FloaterState {
  phase: FloaterPhase;
  mode: 'dictation' | 'edit';
  /** Number of characters selected in edit mode */
  selectionChars: number;
  /** Reference for the time since recording started (ms epoch) */
  startedAt: number | null;
  /** Current processing stage (for display) */
  stage?: 'transcribing' | 'formatting' | 'pasting';
  /** Whether to show it (after applying the setting and snoozing) */
  visible: boolean;
  /**
   * Whether sound from the microphone has actually started arriving during recording (the first audio chunk arrived).
   * While false, the recording display is toned down. undefined is treated as true
   */
  micReady?: boolean;
  /** Name of the microphone used for recording (sent once known) */
  micName?: string;
  /** Shown briefly while idle. pasted means a successful paste */
  flash?: 'pasted' | null;
}

export type HudKind = 'info' | 'success' | 'warning' | 'error';

export interface HudAction {
  id: string;
  label: string;
}

export interface HudMessage {
  id: string;
  /** Kind of notification (used for muting and for counting how often it was shown) */
  key: string;
  kind: HudKind;
  title: string;
  body?: string;
  actions?: HudAction[];
  /** Milliseconds until it disappears by itself. 0 means it stays */
  durationMs: number;
  mutable: boolean;
  /** card is a notification with a title and a body, pill is a small one-line notification */
  style?: 'card' | 'pill';
}

// ---------------------------------------------------------------------------
// IPC with the windows
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

/** Downloading the speech recognition model (ASR-5) */
export interface ModelDownloadState {
  state: 'idle' | 'downloading' | 'waiting' | 'done' | 'failed' | 'cancelled';
  /** Whether the default engine's model is complete */
  installed: boolean;
  /** Whether the model bundled with the app is used (not in the user's folder) */
  bundled?: boolean;
  receivedBytes: number;
  totalBytes: number;
  /** Name of the file being downloaded */
  file?: string;
  error?: string;
  /** Seconds until the retry (when state is waiting) */
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
  /** Language the interface is shown in, resolved from settings.uiLanguage and the system languages */
  locale: Locale;
}

/** API exposed to the renderer (preload exposes it as window.longhand) */
export interface LonghandApi {
  // Common
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(cb: (s: AppSnapshot) => void): () => void;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  setApiKey(key: string): Promise<void>;
  updateCustomizations(patch: Partial<Customizations>): Promise<Customizations>;
  openExternal(target: 'accessibility' | 'microphone' | 'keyboard' | 'logs' | 'recordings' | 'models'): Promise<void>;
  requestPermission(kind: 'accessibility' | 'microphone'): Promise<PermissionStatus>;
  refreshPermissions(): Promise<PermissionStatus>;

  // History
  listHistory(query?: string): Promise<HistoryItem[]>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  copyText(text: string): Promise<void>;
  readAudio(id: string): Promise<ArrayBuffer | null>;
  saveAudioAs(id: string): Promise<boolean>;
  onHistoryChanged(cb: () => void): () => void;
  /**
   * Redoes a history item (H1).
   * transcribe transcribes the recording again and formats again. format keeps the transcription and only formats again
   */
  redoHistory(id: string, opts: { kind: 'transcribe' | 'format'; language?: Settings['language'] }): Promise<{ ok: boolean; error?: string }>;
  /** Corrects the text of a history item by hand (G4-08). If learning is on, learns the corrected words into the dictionary and returns them */
  /** learned is the words added to the dictionary; remembered is the number of corrections remembered without adding a word (misheard forms, mix-up pairs, phrases not to rewrite) */
  editHistory(id: string, text: string): Promise<{ ok: boolean; error?: string; learned?: string[]; remembered?: number; tooMany?: boolean }>;

  // Connection
  testLlm(): Promise<ConnectionTestResult>;
  testAsr(): Promise<AsrTestResult>;
  restartAsr(): Promise<void>;
  /** Downloads the speech recognition model (ASR-5). Progress shows in modelDownload of the snapshot */
  downloadModel(): Promise<boolean>;
  cancelModelDownload(): Promise<void>;
  /** Imports a model file or folder, downloaded on another Mac, that the user picks */
  importModel(): Promise<{ ok: boolean; imported: string[]; rejected: string[] }>;
  importConnection(): Promise<{ ok: boolean; error?: string }>;
  /** removedHeaders: headers not exported because they look like credentials */
  exportConnection(): Promise<{ ok: boolean; error?: string; removedHeaders?: string[] }>;

  // Key bindings (HK-8)
  recordShortcut(active: boolean): Promise<void>;
  onShortcutKeys(cb: (p: { keys: string[]; combo: string[]; done: boolean }) => void): () => void;
  onHotkeyTest(cb: (p: { action: string; phase: string }) => void): () => void;
  /** Sends hotkeys to the window only while onboarding tests the keys */
  hotkeyTest(active: boolean): Promise<void>;

  // Audio
  listMicrophones(): Promise<{ id: string; name: string; isDefault: boolean; isVirtual: boolean; transport: string }[]>;
  testMicrophone(seconds: number): Promise<{ ok: boolean; peak: number; rms: number; error?: string }>;
  onMicLevel(cb: (rms: number) => void): () => void;

  // Learning
  undoLearnedWord(word: string): Promise<void>;

  // Floating bar
  onFloaterState(cb: (s: FloaterState) => void): () => void;
  onLevel(cb: (rms: number) => void): () => void;
  onHud(cb: (m: HudMessage) => void): () => void;
  onHudDismiss(cb: (id: string) => void): () => void;
  onPlaySound(cb: (p: { name: SoundName; volume: number }) => void): () => void;
  floaterAction(action: 'start' | 'finish' | 'cancel' | 'menu' | 'hud-action', arg?: string): void;
  setMouseInteractive(interactive: boolean): void;
  hudMute(key: string): void;

  // Management window
  onNavigate(cb: (page: string) => void): () => void;
  completeOnboarding(): Promise<void>;
}

export type SoundName = 'start' | 'stop' | 'cancel' | 'error' | 'notify' | 'lock';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
