/**
 * The evaluation flow for one utterance. Audio → transcription → post-transcription processing (postAsr) → the text at each stage.
 *
 * It follows the same steps as the app (DictationController.runPipeline).
 * - Recordings of 28 seconds or less are transcribed whole. Longer recordings are cut at pauses, transcribed in order and joined
 * - Recordings that are too short or silent are not transcribed (the app enters nothing)
 * - Post-transcription processing goes through the same function as the app (postAsr)
 *
 * Differences from the app: speculation during pauses (speculative) and the target's context (app name, text around the cursor) are not reproduced.
 * Paste assembly (replacements, spacing fixes) is not applied either.
 */
import type { AsrLanguage, AsrResultPayload } from '../../shared/asr-protocol';
import type { TranscribeOptions } from '../asr/AsrService';
import type { Uncertain } from '../asr/hypotheses';
import { asrRequestExtras, uncertainOf } from '../asr/requestOptions';
import { isNoSpeechByLevel, Segmenter, WHOLE_MAX_SEC } from '../asr/Segmenter';
import { transcribeSelective, type HintMode } from '../asr/selectiveHints';
import { joinTexts } from '../format/postprocess';
import type { LlmProvider } from '../llm/types';
import { postAsr, type PostAsrCustomizations, type PostAsrResult, type PostAsrSettings } from '../session/postAsr';
import type { Tokenizer } from '../textfix';
import { charConfidence } from '../textfix/align';
import type { HintContext, RecentText } from '../vocab/hints';

const SR = 16000;

/** Entry point for transcription (an AsrService can be passed as is) */
export interface Transcriber {
  transcribe(samples: Float32Array, opts: TranscribeOptions): Promise<AsrResultPayload>;
}

export interface AppAsrOptions {
  language: AsrLanguage;
  hints: string[];
  /** Prompt for whole transcription. The app does not pass one (for experiments) */
  prompt?: string;
  /** The asr.incremental setting. When off, long recordings are also transcribed whole */
  incremental: boolean;
  minRecordingMs: number;
  silenceDetection: boolean;
  /** The asr.engine setting. Decides whether recordings without voice are dropped by loudness (defaults to whisper) */
  engine?: string;
  /** Timeout for one transcription. Evaluation has no wait limit, so it is longer */
  timeoutMs?: number;
  /** The asr.hintMode setting. With selective, transcribes twice, without and with hints, and takes only the parts where the hints helped */
  hintMode?: HintMode;
  /** Optional request settings from the asr settings (prompt style, rehearing, alternatives). Turned into a request by the same function as the app */
  asr?: { promptStyle?: 'legacy' | 'list' | 'sentence' | 'spoken'; promptTerms?: number; rehear?: { noHints: boolean; temperatures: number[] }; alternativesTopK?: number };
}

export interface AsrOutcome {
  /** Raw transcription output (trimmed). Empty for recordings the app does not transcribe */
  text: string;
  /** Per-word confidence when transcribed whole */
  tokens?: [string, number][];
  /** How many transcriptions it took (1 when whole, 0 when not transcribed) */
  segments: number;
  hintsUsed?: number;
  hintsGiven?: number;
  /** Total time spent transcribing */
  computeMs: number;
  /** Recordings the app drops without transcribing (too short, no sound, no speech) */
  skipped?: 'too-short' | 'silent' | 'no-speech';
  /** Spots that may be misheard (only for whole transcription with rehearing or alternatives requested) */
  uncertain?: Uncertain[];
}

/** Transcribes with the same steps as the app */
export async function transcribeLikeApp(asr: Transcriber, samples: Float32Array, o: AppAsrOptions): Promise<AsrOutcome> {
  const cuts: [number, number][] = [];
  const seg = new Segmenter((s, e) => cuts.push([s, e]));
  for (let i = 0; i < samples.length; i += 1600) seg.push(samples.subarray(i, Math.min(samples.length, i + 1600)));
  const none = (skipped: AsrOutcome['skipped']): AsrOutcome => ({ text: '', segments: 0, computeMs: 0, skipped });

  // Too-short and silent recording checks (REC-5)
  if ((samples.length / SR) * 1000 < o.minRecordingMs) return none('too-short');
  const stats = seg.stats();
  if (stats.peak < 0.0005) return none('silent');
  if (isNoSpeechByLevel(stats, { silenceDetection: o.silenceDetection, engine: o.engine ?? 'whisper' })) return none('no-speech');

  const timeoutMs = o.timeoutMs ?? 120_000;
  let computeMs = 0;
  const run = async (audio: Float32Array, prompt: string | undefined, whole = false) => {
    const t0 = Date.now();
    // Like the app, whole transcription gets every optional setting, and segment transcription uses only the prompt building
    const build = (hints: string[]): TranscribeOptions => {
      const extras = whole
        ? asrRequestExtras(o.asr ?? {}, hints, prompt)
        : { promptText: asrRequestExtras({ promptStyle: o.asr?.promptStyle, promptTerms: o.asr?.promptTerms }, hints, prompt).promptText };
      return { language: o.language, hints, prompt, timeoutMs, ...extras };
    };
    const res =
      o.hintMode === 'selective' && o.hints.length ? await transcribeSelective((opts) => asr.transcribe(audio, opts), build(o.hints), build([])) : await asr.transcribe(audio, build(o.hints));
    computeMs += Date.now() - t0;
    return res;
  };

  // When it fits in whisper's window (30 seconds), transcribe it whole without cutting
  if (!o.incremental || !cuts.length || samples.length <= WHOLE_MAX_SEC * SR) {
    const res = await run(samples, o.prompt, true);
    const uncertain = uncertainOf(res);
    return {
      text: res.text.trim(),
      tokens: res.tokens,
      segments: 1,
      hintsUsed: res.hintsUsed,
      hintsGiven: res.hintsGiven,
      computeMs,
      ...(uncertain.length ? { uncertain } : {}),
    };
  }
  // Long recordings are transcribed cut by cut, in order. The end of the previous cut is passed as the prompt
  const texts: string[] = [];
  for (const [s, e] of cuts) {
    const res = await run(seg.slice(s, e), texts[texts.length - 1]?.slice(-200) || undefined);
    texts.push(res.text);
  }
  const tail = seg.slice(seg.lastCut);
  let tailText = '';
  if (tail.length > SR * 0.3 && seg.hasPendingSpeech) {
    tailText = (await run(tail, texts[texts.length - 1]?.slice(-200))).text;
  }
  return { text: joinTexts([...texts, tailText], o.language), segments: cuts.length + 1, computeMs };
}

/** Text at each stage */
export interface StageTexts {
  /** Raw transcription output */
  asr: string;
  /** After matching against dictionary readings (the replaced text when the LLM is not used) */
  match: string;
  /** After per-word correction and normalization. The text entered when the LLM is not used */
  noLlm: string;
  /** After LLM formatting. The text entered (same as noLlm in runs without the LLM) */
  final: string;
}

export interface StagesInput {
  rawText: string;
  tokens?: [string, number][];
  /** Spots that may be misheard (from the transcription result) */
  uncertain?: readonly Uncertain[];
  settings: PostAsrSettings;
  customizations: PostAsrCustomizations;
  vocab: () => { context: HintContext; recent: RecentText[]; now?: number };
  tokenizer: Tokenizer | null;
  /** null to not use the LLM */
  provider: LlmProvider | null;
}

export interface StagesOutput {
  stages: StageTexts;
  /** Result of the path without the LLM. null when the transcript is empty */
  noLlm: PostAsrResult | null;
  /** Result of the path with the LLM. null in runs without the LLM or when the transcript is empty */
  llm: PostAsrResult | null;
}

/**
 * Runs post-transcription processing through both the path without the LLM and the path with it, and returns the text at each stage.
 * Both call the same postAsr as the app (the path without the LLM behaves like the app when no LLM is configured)
 */
export async function postAsrStages(input: StagesInput): Promise<StagesOutput> {
  const rawText = input.rawText.trim();
  // When the transcript is empty, the app enters nothing
  if (!rawText) return { stages: { asr: '', match: '', noLlm: '', final: '' }, noLlm: null, llm: null };
  const base = {
    mode: 'dictation' as const,
    rawText,
    confidence: charConfidence(rawText, input.tokens),
    uncertain: input.uncertain,
    settings: input.settings,
    customizations: input.customizations,
    ctx: null,
    vocab: input.vocab,
    tokenizer: () => input.tokenizer,
  };
  const noLlm = await postAsr({ ...base, provider: null });
  const llm = input.provider ? await postAsr({ ...base, provider: input.provider }) : null;
  return {
    stages: { asr: rawText, match: noLlm.matchedText, noLlm: noLlm.fmt.text, final: (llm ?? noLlm).fmt.text },
    noLlm,
    llm,
  };
}
