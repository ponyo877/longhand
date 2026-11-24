/**
 * Builds the optional fields of a transcription request from the settings. The app (DictationController) and the evaluation
 * (eval/pipeline) go through the same function.
 * All of them are off by default; only settings whose effect has been confirmed by evaluation become defaults.
 */
import type { AsrResultPayload } from '../../shared/asr-protocol';
import type { AsrSettings } from '../../shared/settings';
import { buildAsrPrompt } from '../vocab/promptBuilder';
import type { TranscribeOptions } from './AsrService';
import { mergeUncertain, uncertainFromHypotheses, uncertainFromTokens, type Uncertain } from './hypotheses';

export type AsrRequestExtras = Pick<TranscribeOptions, 'promptText' | 'alternatives' | 'rehear'>;

/** Confidence below which alternative candidates are requested */
const ALTERNATIVES_BELOW = 0.5;

type ExtraSettings = Partial<Pick<AsrSettings, 'promptStyle' | 'promptTerms' | 'rehear' | 'alternativesTopK'>>;

/**
 * hints are passed most important first (by score). context is the preceding text (the previous segment's transcript in a long recording).
 * The prompt is built in main so that it is the same for whole and per-segment transcription
 */
export function asrRequestExtras(asr: ExtraSettings, hints: readonly string[], context?: string): AsrRequestExtras {
  const out: AsrRequestExtras = {};
  const style = asr.promptStyle ?? 'legacy';
  if (style !== 'legacy') {
    const text = buildAsrPrompt(hints, { style, maxTerms: asr.promptTerms ?? 32, context });
    if (text) out.promptText = text;
  }
  if ((asr.alternativesTopK ?? 0) > 0) out.alternatives = { topK: asr.alternativesTopK!, below: ALTERNATIVES_BELOW };
  const temperatures = (asr.rehear?.temperatures ?? []).filter((t) => t > 0 && t < 0.5);
  if (asr.rehear?.noHints || temperatures.length) out.rehear = { noHints: !!asr.rehear?.noHints, temperatures };
  return out;
}

/** Takes the places that may be misheard from a transcription result (differences from listening again first, then alternative candidates where confidence is low) */
export function uncertainOf(result: Pick<AsrResultPayload, 'text' | 'tokens' | 'alternatives' | 'hypotheses'>): Uncertain[] {
  const text = result.text.trim();
  if (!text) return [];
  return mergeUncertain([
    uncertainFromHypotheses(
      text,
      (result.hypotheses ?? []).map((h) => h.text.trim()),
    ),
    uncertainFromTokens(text, result.tokens, result.alternatives),
  ]);
}
