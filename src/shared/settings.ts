import { isUiLanguage, type UiLanguage } from './i18n/locale';
import type { Binding, HotkeyAction } from './protocol';
import type { DeepPartial } from './types';

export type LlmProviderKind = 'openai-compatible' | 'azure-openai' | 'anthropic' | 'custom-http';

export interface LlmSettings {
  provider: LlmProviderKind;
  /**
   * openai-compatible: up to `https://host/v1` (without `/chat/completions`)
   * azure-openai: `https://<resource>.openai.azure.com`
   * anthropic: empty for the official API. The proxy's URL when going through a proxy
   * custom-http: the exact URL requests are sent to
   */
  baseUrl: string;
  model: string;
  /** API key encrypted with safeStorage (base64). Never saved in plain text */
  apiKeyEnc: string;
  /** Extra headers the gateway requires */
  headers: Record<string, string>;
  timeoutMs: number;
  maxOutputTokens: number;
  /** How structured output works for openai-compatible / azure-openai */
  structuredOutput: 'json_schema' | 'json_object' | 'none';
  /** JSON merged into the request body (for gateway-specific parameters). Nothing happens when empty */
  extraBody: string;
  azure: {
    deployment: string;
    apiVersion: string;
  };
  anthropic: {
    /** Empty for the model's default */
    effort: '' | 'low' | 'medium' | 'high';
    /**
     * off: turn thinking off (picks the right parameter for each model)
     * adaptive: leave it to the model
     * omit: do not send thinking
     */
    thinking: 'off' | 'adaptive' | 'omit';
    /** Caches the system prompt */
    promptCaching: boolean;
  };
  custom: {
    /** Template that embeds {{system}} {{user}} {{model}} {{max_tokens}} as JSON strings */
    bodyTemplate: string;
    /** Path to the text in the response JSON (for example choices.0.message.content) */
    responsePath: string;
    /** Name of the authentication header. When empty, the API key is not sent (write it in headers directly) */
    authHeader: string;
    /** Prefix of the authentication header's value (for example "Bearer ") */
    authPrefix: string;
  };
}

export interface AsrSettings {
  /** Kind of worker. Starts asr/build/longhand-asr-<engine> */
  engine: string;
  /** Absolute path of the worker executable, to set it explicitly (empty uses the bundled one) */
  workerPath: string;
  /** Absolute path of the model file (empty uses the default location) */
  modelPath: string;
  /** Values passed to load.options */
  options: Record<string, unknown>;
  /** Transcribes each segment during recording, to shorten the wait after the key is released */
  incremental: boolean;
  /**
   * At a pause in speech (0.3 seconds of silence), transcribes the whole recording ahead of time, and uses that result if nothing more is said before the release.
   * Off by default. In an evaluation of 51 items, the median wait shrank by 30 to 100 ms, but the 90th percentile got 150 to 320 ms worse
   * (when the early result cannot be used, it waits for the computation in progress to be cancelled), and with dictionary words given, the error rate rose by 0.4 points.
   * Reconsider the default once formatting can also run ahead.
   */
  speculative: boolean;
  /**
   * How long to keep recording after the key is released (or recording is stopped), in ms. 0 means not to keep recording.
   * Releasing the key at almost the same moment speech ends cuts off the sound at the end of the sentence (such as the voiceless 「す」 of 「〜ます」) and the end is misrecognized.
   * Trimming the ends of 40 recordings with room at the end to 90 ms after the voice ended raised the error rate from 8.1% to 12.3%
   * (most of the added errors were at the end of the sentence, and adding silence did not bring them back).
   * If the last 1 second or more of the audio received is silent, speech has ended, so recording does not continue.
   */
  tailMs: number;
  /**
   * How the speech recognition prompt is built.
   * legacy: the worker lists the dictionary words separated by 「、」 (the original way). list / sentence / spoken: main builds the text and passes it (vocab/promptBuilder.ts).
   * sentence and spoken embed the words in sentences with punctuation. Workers that do not support it behave as legacy
   */
  promptStyle: 'legacy' | 'list' | 'sentence' | 'spoken';
  /** Maximum number of words in the prompt (when promptStyle is not legacy) */
  promptTerms: number;
  /**
   * Listening again. Transcribes the same audio once more under other conditions, and passes the spots that disagree to formatting as "spots that may be misheard".
   * noHints: listen again without the prompt. temperatures: listen again at each temperature. Each takes as long as one transcription
   */
  rehear: { noHints: boolean; temperatures: number[] };
  /** Number of alternative candidates for low-confidence spots (0 asks for none). Passed to formatting */
  alternativesTopK: number;
  /** Picks name-like Latin words from the text in the field and adds them to that utterance's hints (vocab/screenTerms.ts) */
  screenTerms: boolean;
  /**
   * How vocabulary hints (dictionary words) are used (asr/selectiveHints.ts).
   * always: always transcribe with hints.
   * selective: transcribe twice, without and with hints, and take only the spots where the hints made a difference (dictionary words, Latin words).
   * This keeps the transcription from changing in places unrelated to the hints. With an empty dictionary, transcribes only once.
   * The default is selective (evaluation results in docs/evaluation.md)
   */
  hintMode: 'always' | 'selective';
  /** Where models are downloaded from (Hugging Face or a mirror of it) */
  downloadBaseUrl: string;
}

export interface TextFixSettings {
  enabled: boolean;
  /** Writes katakana product names and technical terms in Latin spelling (スラック → Slack) */
  latin: boolean;
  /** Removes fillers such as 「えっと」 and 「あのー」 */
  fillers: boolean;
  /** Makes spelling consistent (下さい → ください and so on, only in the direction from kanji to kana) */
  notation: boolean;
  /** Fixes obvious particle errors (こんにちわ → こんにちは, removing a low-confidence 「を」 added by speech recognition, and so on) */
  particles: boolean;
  /** Spots where the user chose "do not fix this again" (rule:text before the fix) */
  blocked: string[];
}

export interface NotificationState {
  muted: boolean;
  count: number;
  last: number;
  /** Recent times it was shown (used for the limit per period) */
  times?: number[];
}

export interface Settings {
  version: 1;

  // General (SET-2)
  launchAtLogin: boolean;
  showFloater: boolean;
  /** When the snooze ends (ms epoch). -1 means "until turned back on" */
  floaterSnoozeUntil: number | null;
  appearance: 'system' | 'light' | 'dark';
  /** Interface language. 'system' follows the macOS language order (shared/i18n) */
  uiLanguage: UiLanguage;
  avoidClipboardHistory: boolean;
  /** ⌘Q closes only the interface (quitting fully is done from the tray) */
  quitOnlyFromTray: boolean;

  // Key bindings (SET-3)
  hotkeys: Record<HotkeyAction, Binding[]>;
  /** Interval counted as a double tap (from pressing the first time to pressing the second time) */
  doubleTapMs: number;
  /** How doubleTapMs is measured. 'press' is from press to press (the old default of 350ms was a "from release" value, so it is changed to 400ms on load) */
  doubleTapMeasure?: 'press';
  /**
   * Version of the defaults. A marker for applying a new default once to saved settings when a default changes.
   * 2: turned on skipping the LLM for clean short utterances (llmFastPath), and turned off running ahead at pauses (asr.speculative)
   * 3: turned llmFastPath back off. In an evaluation with the LLM, errors in utterances that took the shortcut dropped by about 30% when they went through the LLM
   *    (no utterance got worse. docs/evaluation.md)
   */
  defaultsRev?: number;
  doubleTapToLock: boolean;
  suppressGlobe: boolean;
  /** Whether AXEnhancedUserInterface may be set to read fields in Chromium-based browsers (it can conflict with window management tools) */
  chromiumEnhancedUI: boolean;

  // Dictation (SET-4)
  language: 'ja' | 'en' | 'auto';
  editModeEnabled: boolean;
  /** Sends the app name, the browser's host name and the kind of field to the LLM */
  sendAppContext: boolean;
  /** Sends the text around the cursor to the LLM */
  sendFieldContext: boolean;
  skipLlm: boolean;
  /**
   * Skips the LLM for clean short utterances and uses the normalized raw text as is (N6). The wait gets shorter by one LLM call.
   * Off by default. In an offline evaluation, only 50 to 70% of the utterances that took the shortcut matched the reference exactly (the difference was mostly speech recognition errors)
   */
  llmFastPath: boolean;
  /**
   * Version of the formatting rules (format/prompts.ts). v2 makes the allowed changes a closed list and requires grounds for correcting a mishearing.
   * The default is v1. Switch when v2 does better in evaluation
   */
  formatRules: 'v1' | 'v2';
  /**
   * Checking the LLM's output (format/guards.ts). off: no checks. shadow: check and only record.
   * enforce: revert ungrounded rewrites to the text before formatting, and use the text before formatting if a number or a negation is still changed
   */
  formatGuard: 'off' | 'shadow' | 'enforce';
  /**
   * Passes the spots where speech recognition results disagreed (with and without vocabulary hints, listening again) to the formatting LLM to choose from.
   * When off, they are not passed (with v2 rules they are passed regardless of this setting)
   */
  formatUncertain: boolean;
  /**
   * Per-word correction of the transcription (textfix). Fixes text pasted without the LLM (the shortcut, no LLM, LLM failure) with fixed rules only.
   * The LLM gets the transcription from before the fixes. Only the rules that met the bar in evaluation are on by default
   */
  textFix: TextFixSettings;

  // Audio (SET-5)
  microphoneId: string | null;
  excludedMicrophones: string[];
  playSounds: boolean;
  soundVolume: number;
  silenceDetection: boolean;
  saveRecordings: boolean;
  recordingRetentionHours: number;
  recordingMaxMB: number;
  minRecordingMs: number;

  // Connection (SET-1)
  llm: LlmSettings;
  asr: AsrSettings;

  // Learning (LRN-1, LRN-2)
  learning: {
    enabled: boolean;
    /** Seconds to watch the field after pasting */
    watchSeconds: number;
  };

  // History (HIS-1)
  historyLimit: number;

  onboardingComplete: boolean;
  notifications: Record<string, NotificationState>;
}

export const DEFAULT_HOTKEYS: Record<HotkeyAction, Binding[]> = {
  activate: [['Fn']],
  lock: [['Fn', 'Space']],
  cancel: [['Escape']],
  paste_last: [['Meta', 'Control', 'KeyV']],
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  launchAtLogin: false,
  showFloater: true,
  floaterSnoozeUntil: null,
  appearance: 'system',
  uiLanguage: 'system',
  avoidClipboardHistory: true,
  quitOnlyFromTray: true,

  hotkeys: DEFAULT_HOTKEYS,
  doubleTapMs: 400,
  doubleTapToLock: true,
  suppressGlobe: false,
  chromiumEnhancedUI: true,

  language: 'ja',
  editModeEnabled: true,
  sendAppContext: true,
  sendFieldContext: true,
  skipLlm: false,
  llmFastPath: false,
  formatRules: 'v1',
  formatGuard: 'off',
  formatUncertain: false,
  // particles is on by default because it met the evaluation bar (docs/evaluation.md).
  // latin (rewriting katakana in Latin spelling) is also on by default. In the evaluation with dictionary words given, there was nothing to fix, and it did not reach
  // the adoption bar (reducing differences by 15 characters or more). But in the evaluation without dictionary words, differences dropped by 10 characters,
  // and there were no wrong rewrites in either evaluation. It only fixes when a whole run of katakana matches the glossary, so it is unlikely to do harm.
  // fillers and notation are off because there was almost nothing for them to fix (docs/evaluation.md).
  textFix: { enabled: true, latin: true, fillers: false, notation: false, particles: true, blocked: [] },

  microphoneId: null,
  excludedMicrophones: [],
  playSounds: true,
  soundVolume: 0.5,
  silenceDetection: true,
  saveRecordings: true,
  recordingRetentionHours: 72,
  recordingMaxMB: 300,
  minRecordingMs: 300,

  llm: {
    provider: 'anthropic',
    baseUrl: '',
    // Had the fewest errors in the comparison of formatting models (docs/evaluation.md)
    model: 'claude-opus-5-5',
    apiKeyEnc: '',
    headers: {},
    timeoutMs: 8000,
    maxOutputTokens: 2048,
    structuredOutput: 'json_schema',
    extraBody: '',
    azure: { deployment: '', apiVersion: '2024-10-21' },
    anthropic: { effort: 'low', thinking: 'off', promptCaching: true },
    custom: {
      bodyTemplate: '{"model": {{model}}, "messages": [{"role": "system", "content": {{system}}}, {"role": "user", "content": {{user}}}], "max_tokens": {{max_tokens}}}',
      responsePath: 'choices.0.message.content',
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
    },
  },
  asr: {
    engine: 'whisper',
    workerPath: '',
    modelPath: '',
    options: {},
    incremental: true,
    speculative: false,
    tailMs: 300,
    promptStyle: 'legacy',
    promptTerms: 32,
    rehear: { noHints: false, temperatures: [] },
    alternativesTopK: 0,
    screenTerms: false,
    hintMode: 'selective',
    downloadBaseUrl: 'https://huggingface.co',
  },

  learning: { enabled: true, watchSeconds: 30 },

  historyLimit: 100,
  onboardingComplete: false,
  notifications: {},
};

/** Version of the defaults (see Settings.defaultsRev) */
const DEFAULTS_REV = 3;

/** Fills saved settings with defaults (so that old settings files can still be read when new fields are added) */
export function mergeSettings(saved: unknown): Settings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  // The double-tap window is now measured from press instead of from release, so only the old default moves to the new default
  const doubleTapMs = s.doubleTapMeasure !== 'press' && s.doubleTapMs === 350 ? d.doubleTapMs : (s.doubleTapMs ?? d.doubleTapMs);
  // For fields whose default changed, the new default is applied to saved settings once. Values the user changes afterwards stay as they are
  const applyRev2 = (s.defaultsRev ?? 1) < 2;
  const applyRev3 = (s.defaultsRev ?? 1) < 3;
  return {
    ...d,
    ...s,
    ...(applyRev3 ? { llmFastPath: d.llmFastPath } : {}),
    defaultsRev: DEFAULTS_REV,
    doubleTapMs,
    doubleTapMeasure: 'press',
    hotkeys: { ...d.hotkeys, ...s.hotkeys },
    llm: {
      ...d.llm,
      ...s.llm,
      headers: { ...(s.llm?.headers ?? d.llm.headers) },
      azure: { ...d.llm.azure, ...s.llm?.azure },
      anthropic: { ...d.llm.anthropic, ...s.llm?.anthropic },
      custom: { ...d.llm.custom, ...s.llm?.custom },
    },
    asr: {
      ...d.asr,
      ...s.asr,
      ...(applyRev2 ? { speculative: d.asr.speculative } : {}),
      options: { ...(s.asr?.options ?? d.asr.options) },
      rehear: { ...d.asr.rehear, ...s.asr?.rehear, temperatures: [...(s.asr?.rehear?.temperatures ?? d.asr.rehear.temperatures)] },
    },
    learning: { ...d.learning, ...s.learning },
    textFix: { ...d.textFix, ...s.textFix, blocked: [...(s.textFix?.blocked ?? d.textFix.blocked)] },
    notifications: { ...s.notifications },
    uiLanguage: isUiLanguage(s.uiLanguage) ? s.uiLanguage : d.uiLanguage,
    version: 1,
  };
}

/** Whether the value is a plain object (arrays are replaced whole as values) */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Lays overrides on settings (used to update the store and to override settings for evaluation) */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    // headers, options and notifications are dictionaries, so they are replaced whole
    if (isPlainObject(v) && isPlainObject(cur) && !['headers', 'options', 'hotkeys'].includes(k)) {
      out[k] = deepMerge(cur, v as DeepPartial<typeof cur>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
