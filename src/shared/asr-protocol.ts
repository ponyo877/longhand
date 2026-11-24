/**
 * Electron main <-> ASR ワーカー（longhand-asr-*）の通信仕様。
 *
 * ASR エンジンは、エンジンごとに 1 つの実行ファイル（ワーカー）として作り、すべて同じ stdio プロトコルで話す。
 * main はワーカーを常駐させ（モデルを読み込んだまま保持し）、録音ごとに transcribe を送る。
 * こうしておけば、エンジンの差し替えは「どの実行ファイルを起動するか」と「どのモデルを渡すか」の設定だけで済む。
 *
 * - stdin / stdout で JSON Lines（1 行 1 メッセージ、UTF-8）。stdout はプロトコル専用、ログは stderr。
 * - エンベロープは {type, id?, payload}。応答は要求と同じ id を付ける。
 * - 起動直後に {type: "ready", payload: {engine, version}} を送る。
 * - stdin が EOF になったら終了する。
 * - 要求は 1 つずつ順に処理してよい（main は同時に 1 件しか送らない）。
 * - 失敗は {type: "error", id, payload: {code, message}}。
 * - {type: "cancel", payload: {}} は、それまでに送った要求の処理を取り消す（id なし、応答なし）。
 *   取り消した transcribe には error（code: "cancelled"）を返す。処理中でも届くように stdin は別スレッドで読む。
 *   対応していないワーカーは unknown type の error を返してよい（main は id のない error を無視する）。
 * - 対応している任意の機能は ready の features に並べる（"cancel"）。
 *
 * 実装は asr/ にある。
 */

export const ASR_PROTOCOL_VERSION = 1;

export type AsrLanguage = 'ja' | 'en' | 'auto';

export interface AsrReadyPayload {
  /** "whisper" | "apple" | "parakeet" など */
  engine: string;
  version: string;
  protocol: number;
  /** 対応している任意の機能（"cancel"）。古いワーカーは送らない */
  features?: string[];
}

export interface AsrLoadPayload {
  /** モデルファイルまたはディレクトリの絶対パス。エンジンが OS のモデルを使う場合（apple）は空でよい */
  modelPath: string;
  language: AsrLanguage;
  /** エンジン固有の設定（スレッド数、ビーム幅、VAD モデルのパスなど） */
  options?: Record<string, unknown>;
}

export interface AsrLoadedPayload {
  elapsedMs: number;
  /** 読み込んだモデルの説明（ログ用） */
  model: string;
}

export interface AsrTranscribePayload {
  /** 16kHz モノラル Float32 リトルエンディアンの base64。wavPath とどちらか一方 */
  pcm?: string;
  /** 16kHz モノラル 16bit の WAV ファイルの絶対パス */
  wavPath?: string;
  language: AsrLanguage;
  /**
   * 辞書語など、認識させたい語のリスト。エンジンが対応していれば語彙ヒントとして使う
   * （whisper は initial prompt、apple は contextualStrings など）。
   */
  hints?: string[];
  /** 直前の文脈（whisper の initial prompt の先頭に入れるなど）。任意 */
  prompt?: string;
  /**
   * main の側で組み立てたプロンプトの文（features に "promptText" を持つワーカーだけが使う）。
   * あれば、ワーカーは hints と prompt からプロンプトを組まず、この文をそのまま使う（長ければ先頭を落とす）。
   * hints は、プロンプトに入った語の数の集計と、おうむ返しの検出のために一緒に渡す
   */
  promptText?: string;
  /** 確信度の低い箇所に、上位の別候補を付ける（features に "alternatives"）。below 未満の確率の箇所に、topK 個まで */
  alternatives?: { topK: number; below: number };
  /**
   * 条件を変えて聞き直し、違う結果を別の仮説として返す（features に "hypotheses"）。
   * noHints: プロンプトなしで聞き直す。temperatures: その温度で聞き直す（1 つにつき、音声認識 1 回分の時間がかかる）
   */
  rehear?: { noHints?: boolean; temperatures?: number[] };
}

/** 確信度の低い箇所の別候補。index は tokens の添字 */
export interface AsrAlternative {
  index: number;
  candidates: [string, number][];
}

/** 条件を変えて聞き直した、文全体の別の仮説 */
export interface AsrHypothesis {
  text: string;
  /** hinted は、main の側で付ける（語彙ヒントありの書き起こし。asr/selectiveHints.ts）。ワーカーは送らない */
  source: 'no-hints' | 'temperature' | 'hinted';
  temperature?: number;
  avgLogprob: number;
}

export interface AsrSegment {
  /** 秒 */
  start: number;
  end: number;
  text: string;
}

export interface AsrResultPayload {
  text: string;
  /** 自動判定した言語（"ja" など）。分からなければ undefined */
  language?: string;
  /** 推論にかかった時間（読み込みを除く） */
  elapsedMs: number;
  segments?: AsrSegment[];
  /** 渡した語彙ヒントのうちプロンプトに入った数と、渡した数（ヒントを渡したときだけ。対応していないワーカーは送らない） */
  hintsUsed?: number;
  hintsGiven?: number;
  /**
   * 語ごとの確信度。[文字列, 確率 0〜1] の並び（features に "tokens" を持つワーカーだけが送る）。
   * 文字列は UTF-8 の文字の切れ目でまとめてあり、つなげると text とほぼ同じになる（区間の繰り返しの除去などは反映しない）
   */
  tokens?: [string, number][];
  /** 確信度の低い箇所の別候補（transcribe で alternatives を指定したときだけ） */
  alternatives?: AsrAlternative[];
  /** 聞き直しで得た、文全体の別の仮説（transcribe で rehear を指定し、違う結果が出たときだけ） */
  hypotheses?: AsrHypothesis[];
}

export interface AsrErrorPayload {
  code: 'not_loaded' | 'bad_request' | 'model_not_found' | 'inference_failed' | 'cancelled' | 'unknown';
  message: string;
}

export type MainToAsr =
  | { type: 'load'; id: string; payload: AsrLoadPayload }
  | { type: 'transcribe'; id: string; payload: AsrTranscribePayload }
  | { type: 'ping'; id: string; payload: Record<string, never> }
  | { type: 'cancel'; payload: Record<string, never> };

export type AsrToMain =
  | { type: 'ready'; payload: AsrReadyPayload }
  | { type: 'loaded'; id: string; payload: AsrLoadedPayload }
  | { type: 'result'; id: string; payload: AsrResultPayload }
  | { type: 'pong'; id: string; payload: Record<string, never> }
  | { type: 'error'; id?: string; payload: AsrErrorPayload };
