import type { Binding, HotkeyAction } from './protocol';
import type { DeepPartial } from './types';

export type LlmProviderKind = 'openai-compatible' | 'azure-openai' | 'anthropic' | 'custom-http';

export interface LlmSettings {
  provider: LlmProviderKind;
  /**
   * openai-compatible: `https://host/v1` まで（`/chat/completions` は付けない）
   * azure-openai: `https://<resource>.openai.azure.com`
   * anthropic: 空なら公式の API。プロキシを通す場合はその URL
   * custom-http: リクエストを送る URL そのもの
   */
  baseUrl: string;
  model: string;
  /** safeStorage で暗号化した API キー（base64）。平文では保存しない */
  apiKeyEnc: string;
  /** ゲートウェイが求める追加ヘッダ */
  headers: Record<string, string>;
  timeoutMs: number;
  maxOutputTokens: number;
  /** openai-compatible / azure-openai の構造化出力の方式 */
  structuredOutput: 'json_schema' | 'json_object' | 'none';
  /** リクエスト本文に追加でマージする JSON（ゲートウェイ固有のパラメータ用）。空文字なら何もしない */
  extraBody: string;
  azure: {
    deployment: string;
    apiVersion: string;
  };
  anthropic: {
    /** 空文字ならモデルの既定 */
    effort: '' | 'low' | 'medium' | 'high';
    /**
     * off: 思考を止める（モデルごとに適切な指定を選ぶ）
     * adaptive: モデルに任せる
     * omit: thinking を送らない
     */
    thinking: 'off' | 'adaptive' | 'omit';
    /** システムプロンプトをキャッシュする */
    promptCaching: boolean;
  };
  custom: {
    /** {{system}} {{user}} {{model}} {{max_tokens}} を JSON 文字列として埋め込むテンプレート */
    bodyTemplate: string;
    /** 応答 JSON から本文を取り出すパス（例: choices.0.message.content） */
    responsePath: string;
    /** 認証ヘッダ名。空なら API キーは送らない（headers に直接書く） */
    authHeader: string;
    /** 認証ヘッダの値の接頭辞（例: "Bearer "） */
    authPrefix: string;
  };
}

export interface AsrSettings {
  /** ワーカーの種類。asr/build/longhand-asr-<engine> を起動する */
  engine: string;
  /** ワーカーの実行ファイルを明示する場合の絶対パス（空なら同梱のものを使う） */
  workerPath: string;
  /** モデルファイルの絶対パス（空なら既定の場所） */
  modelPath: string;
  /** load.options に渡す値 */
  options: Record<string, unknown>;
  /** 録音中に区切りごとに書き起こしておき、離してからの待ち時間を減らす */
  incremental: boolean;
  /**
   * 話の間（0.3 秒の無音）で録音全体を先に書き起こしておき、離すまで話さなければその結果を使う。
   * 既定はオフ。51 件の評価で、待ちの中央値は 30〜100 ms 縮むが、90% の値が 150〜320 ms 悪くなり
   * （控えが使えないとき、途中の計算の取り消しを待つため）、辞書の語を渡した条件では誤り率が 0.4 ポイント上がった。
   * 整形まで先回りできるようになったら、既定を見直す。
   */
  speculative: boolean;
  /**
   * キーを離した（または停止した）後も、録音を続ける時間（ms）。0 なら続けない。
   * 話し終わりとほぼ同時にキーを離すと、文末の音（「〜ます」の無声の「す」など）が録音に入りきらず、文末を誤る。
   * 末尾に余裕のある録音 40 件の末尾を、声の終わりから 90 ms で切り詰めると、誤り率が 8.1% から 12.3% に上がった
   * （増えた誤りの大半は文末。無音を足しても戻らない）。届いている音声の末尾が 1 秒以上無音なら、話し終えているので続けない。
   */
  tailMs: number;
  /**
   * 音声認識のプロンプトの作り方。
   * legacy: ワーカーが辞書の語を「、」で並べる（従来）。list / sentence / spoken: main で文を組んで渡す（vocab/promptBuilder.ts）。
   * sentence と spoken は、句読点のある文に語を埋める。対応していないワーカーでは legacy と同じ動きになる
   */
  promptStyle: 'legacy' | 'list' | 'sentence' | 'spoken';
  /** プロンプトに入れる語の数の上限（promptStyle が legacy 以外のとき） */
  promptTerms: number;
  /**
   * 聞き直し。同じ音声を、条件を変えてもう一度書き起こし、食い違う箇所を「聞き違いかもしれない箇所」として整形に渡す。
   * noHints: プロンプトなしで聞き直す。temperatures: その温度で聞き直す。1 回につき、書き起こし 1 回分の時間がかかる
   */
  rehear: { noHints: boolean; temperatures: number[] };
  /** 確信度の低い箇所の別候補の数（0 なら求めない）。整形に渡す */
  alternativesTopK: number;
  /** 入力欄の文から、名前らしい英字の語を拾って、その発話のヒントに足す（vocab/screenTerms.ts） */
  screenTerms: boolean;
  /**
   * 語彙ヒント（辞書の語）の使い方（asr/selectiveHints.ts）。
   * always: いつもヒントありで書き起こす。
   * selective: ヒントなしとヒントありの 2 回書き起こし、ヒントが効いた所（辞書の語、英字の語）だけを取り込む。
   * ヒントと関係のない所まで書き起こしが変わるのを防ぐ。辞書が空のときは 1 回だけ書き起こす。
   * 既定は selective（評価の結果は docs/evaluation.md）
   */
  hintMode: 'always' | 'selective';
  /** モデルの取得元（Hugging Face か、そのミラー） */
  downloadBaseUrl: string;
}

export interface TextFixSettings {
  enabled: boolean;
  /** カタカナの製品名や技術用語を英字の綴りにする（スラック → Slack） */
  latin: boolean;
  /** 「えっと」「あのー」などのつなぎの言葉を取り除く */
  fillers: boolean;
  /** 表記をそろえる（下さい → ください など、漢字をかなにする向きだけ） */
  notation: boolean;
  /** 助詞の明らかな誤りを直す（こんにちわ → こんにちは、音声認識が足した確信度の低い「を」を取り除く など） */
  particles: boolean;
  /** 利用者が「今後は直さない」を選んだ箇所（規則:直す前の文字列） */
  blocked: string[];
}

export interface NotificationState {
  muted: boolean;
  count: number;
  last: number;
  /** 直近の表示時刻（期間あたりの上限の判定に使う） */
  times?: number[];
}

export interface Settings {
  version: 1;

  // 一般（SET-2）
  launchAtLogin: boolean;
  showFloater: boolean;
  /** スヌーズの期限（ms エポック）。-1 は「戻すまで」 */
  floaterSnoozeUntil: number | null;
  appearance: 'system' | 'light' | 'dark';
  avoidClipboardHistory: boolean;
  /** ⌘Q で UI だけ閉じる（完全終了はトレイから） */
  quitOnlyFromTray: boolean;

  // キーバインド（SET-3）
  hotkeys: Record<HotkeyAction, Binding[]>;
  /** ダブルタップとみなす間隔（1 回目を押してから 2 回目を押すまで） */
  doubleTapMs: number;
  /** doubleTapMs の測り方。'press' は押下から押下まで（以前の 350ms の既定は「離してから」の値だったので、読み込み時に 400ms に直す） */
  doubleTapMeasure?: 'press';
  /**
   * 既定値の版。既定値を変えたとき、保存済みの設定にも新しい既定値を 1 回だけ当てるための印。
   * 2: 整った短い発話は LLM を通さない（llmFastPath）をオンに、話の間での先回り（asr.speculative）をオフにした
   * 3: llmFastPath をオフに戻した。LLM 込みの評価で、近道を通った発話の誤りが、LLM を通すと 3 割ほど減った
   *    （悪くなった発話は無かった。docs/evaluation.md）
   */
  defaultsRev?: number;
  doubleTapToLock: boolean;
  suppressGlobe: boolean;
  /** Chromium 系ブラウザで入力欄を読むために AXEnhancedUserInterface を立ててよいか（ウィンドウ整列ツールとぶつかることがある） */
  chromiumEnhancedUI: boolean;

  // 音声入力（SET-4）
  language: 'ja' | 'en' | 'auto';
  editModeEnabled: boolean;
  /** アプリ名、ブラウザのホスト名、入力欄の種類を LLM に送る */
  sendAppContext: boolean;
  /** カーソル前後の文字列を LLM に送る */
  sendFieldContext: boolean;
  skipLlm: boolean;
  /**
   * 整った短い発話は LLM を飛ばし、正規化した生テキストをそのまま使う（N6）。待ち時間が LLM の 1 回分だけ減る。
   * 既定はオフ。オフラインの評価で、近道に入った発話の参照との完全一致が 50〜70% にとどまったため（差は主に音声認識の誤り）
   */
  llmFastPath: boolean;
  /**
   * 整形の規則の版（format/prompts.ts）。v2 は、変えてよいことを閉じた一覧にし、聞き違いの訂正に根拠を求める。
   * 既定は v1。評価で v2 が上回ったら切り替える
   */
  formatRules: 'v1' | 'v2';
  /**
   * LLM の出力の検査（format/guards.ts）。off: しない。shadow: 調べて記録するだけ。
   * enforce: 根拠のない書き換えを整形前の文に戻し、数や否定が変わったままなら整形前の文を使う
   */
  formatGuard: 'off' | 'shadow' | 'enforce';
  /**
   * 音声認識の結果が食い違った箇所（語彙ヒントありとなし、聞き直し）を、整形の LLM に渡して選ばせる。
   * オフなら渡さない（規則が v2 のときは、この設定によらず渡す）
   */
  formatUncertain: boolean;
  /**
   * 書き起こしの語ごとの補正（textfix）。LLM を通さずに貼る文（近道、LLM なし、LLM の失敗）を、決まった規則だけで直す。
   * LLM には直す前の書き起こしを渡す。規則ごとに、評価で基準を満たしたものだけを既定でオンにしている
   */
  textFix: TextFixSettings;

  // オーディオ（SET-5）
  microphoneId: string | null;
  excludedMicrophones: string[];
  playSounds: boolean;
  soundVolume: number;
  silenceDetection: boolean;
  saveRecordings: boolean;
  recordingRetentionHours: number;
  recordingMaxMB: number;
  minRecordingMs: number;

  // 接続（SET-1）
  llm: LlmSettings;
  asr: AsrSettings;

  // 学習（LRN-1、LRN-2）
  learning: {
    enabled: boolean;
    /** 貼り付け後に入力欄を監視する秒数 */
    watchSeconds: number;
  };

  // 履歴（HIS-1）
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
  // particles（助詞）は評価の基準を満たしたので既定でオンにする（docs/evaluation.md）。
  // latin（カタカナを英字の綴りに直す）も既定でオンにする。辞書の語を渡した評価では直す対象がなく、採用の基準
  // （違いを 15 文字以上減らす）には届かなかった。しかし辞書の語を渡さない評価では違いが 10 文字減り、
  // 誤った書き換えは両方の評価で 0 件だった。カタカナの連なり全体が用語集に一致したときだけ直すので、害が出にくい。
  // fillers と notation は、直す対象がほとんどなかったのでオフ（docs/evaluation.md）。
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
    // 整形のモデルの比較で、誤りがいちばん少なかった（docs/evaluation.md）
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

/** 既定値の版（Settings.defaultsRev を参照） */
const DEFAULTS_REV = 3;

/** 保存された設定に既定値を補う（新しい項目が増えても古い設定ファイルを読めるようにする） */
export function mergeSettings(saved: unknown): Settings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  // ダブルタップの窓の測り方を「離してから」から「押してから」に変えたので、旧来の既定値だけを新しい既定値に移す
  const doubleTapMs = s.doubleTapMeasure !== 'press' && s.doubleTapMs === 350 ? d.doubleTapMs : (s.doubleTapMs ?? d.doubleTapMs);
  // 既定値を変えた項目は、保存済みの設定にも 1 回だけ新しい既定値を当てる。当てた後に利用者が変えた値は、そのまま残る
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
    version: 1,
  };
}

/** 値がプレーンなオブジェクトか（配列は値として丸ごと置き換える） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 設定に上書きを重ねる（保存先の更新と、評価の設定の上書きで使う） */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    // headers と options と notifications は辞書なので丸ごと置き換える
    if (isPlainObject(v) && isPlainObject(cur) && !['headers', 'options', 'hotkeys'].includes(k)) {
      out[k] = deepMerge(cur, v as DeepPartial<typeof cur>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
