/**
 * Protocol between Electron main and the ASR workers (longhand-asr-*).
 *
 * Each ASR engine is built as its own executable (worker), and all of them speak the same stdio protocol.
 * main keeps the worker running (with the model loaded) and sends transcribe for each recording.
 * This way, switching engines only takes settings: which executable to start and which model to pass.
 *
 * - JSON Lines (one message per line, UTF-8) over stdin / stdout. stdout is for the protocol only; logs go to stderr.
 * - The envelope is {type, id?, payload}. A response carries the same id as its request.
 * - Right after starting, the worker sends {type: "ready", payload: {engine, version}}.
 * - The worker exits when stdin reaches EOF.
 * - Requests may be handled one at a time in order (main sends only one at a time).
 * - A failure is {type: "error", id, payload: {code, message}}.
 * - {type: "cancel", payload: {}} cancels the requests sent so far (no id, no response).
 *   A cancelled transcribe returns an error (code: "cancelled"). stdin is read on a separate thread so that cancel arrives during work.
 *   A worker that does not support it may return an unknown type error (main ignores errors without an id).
 * - Optional features the worker supports are listed in the features of ready ("cancel").
 *
 * The implementation lives in asr/.
 */

export const ASR_PROTOCOL_VERSION = 1;

export type AsrLanguage = 'ja' | 'en' | 'auto';

export interface AsrReadyPayload {
  /** "whisper" | "apple" | "parakeet" and so on */
  engine: string;
  version: string;
  protocol: number;
  /** Optional features the worker supports ("cancel"). Older workers do not send it */
  features?: string[];
}

export interface AsrLoadPayload {
  /** Absolute path of the model file or directory. May be empty when the engine uses the system's model (apple) */
  modelPath: string;
  language: AsrLanguage;
  /** Engine-specific options (thread count, beam width, path of the VAD model and so on) */
  options?: Record<string, unknown>;
}

export interface AsrLoadedPayload {
  elapsedMs: number;
  /** Description of the loaded model (for logs) */
  model: string;
}

export interface AsrTranscribePayload {
  /** Base64 of 16 kHz mono Float32 little-endian samples. Either this or wavPath */
  pcm?: string;
  /** Absolute path of a 16 kHz mono 16-bit WAV file */
  wavPath?: string;
  language: AsrLanguage;
  /**
   * Words to recognize, such as dictionary words. Used as vocabulary hints if the engine supports them
   * (the initial prompt for whisper, contextualStrings for apple and so on).
   */
  hints?: string[];
  /** Preceding context (put at the start of whisper's initial prompt, for example). Optional */
  prompt?: string;
  /**
   * Prompt text built on the main side (only workers with "promptText" in features use it).
   * When present, the worker uses this text as is instead of building a prompt from hints and prompt (dropping the start if it is too long).
   * hints are passed along to count the words that went into the prompt and to detect parroting
   */
  promptText?: string;
  /** Adds the top alternative candidates to low-confidence spots ("alternatives" in features). Up to topK, at spots with a probability below below */
  alternatives?: { topK: number; below: number };
  /**
   * Listens again under other conditions and returns different results as separate hypotheses ("hypotheses" in features).
   * noHints: listen again without the prompt. temperatures: listen again at each temperature (each takes as long as one recognition)
   */
  rehear?: { noHints?: boolean; temperatures?: number[] };
}

/** Alternative candidates at a low-confidence spot. index is the index into tokens */
export interface AsrAlternative {
  index: number;
  candidates: [string, number][];
}

/** Another hypothesis for the whole sentence, from listening again under other conditions */
export interface AsrHypothesis {
  text: string;
  /** hinted is set on the main side (the transcription with vocabulary hints, asr/selectiveHints.ts). Workers do not send it */
  source: 'no-hints' | 'temperature' | 'hinted';
  temperature?: number;
  avgLogprob: number;
}

export interface AsrSegment {
  /** Seconds */
  start: number;
  end: number;
  text: string;
}

export interface AsrResultPayload {
  text: string;
  /** Detected language ("ja" and so on). undefined when unknown */
  language?: string;
  /** Inference time (excluding loading) */
  elapsedMs: number;
  segments?: AsrSegment[];
  /** How many of the given vocabulary hints went into the prompt, and how many were given (only when hints were given. Workers that do not support it do not send these) */
  hintsUsed?: number;
  hintsGiven?: number;
  /**
   * Confidence per token, as [text, probability 0 to 1] pairs (only workers with "tokens" in features send it).
   * The text is grouped at UTF-8 character boundaries, and joined it is nearly the same as text (removal of repeated segments and the like is not reflected)
   */
  tokens?: [string, number][];
  /** Alternative candidates at low-confidence spots (only when transcribe asked for alternatives) */
  alternatives?: AsrAlternative[];
  /** Other hypotheses for the whole sentence from listening again (only when transcribe asked for rehear and a different result came out) */
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
