/**
 * Rule d: fixes obvious particle mistakes. Does not add particles the speaker left out.
 *
 * - Fixed spellings (「こんにちわ」→「こんにちは」 and so on) are fixed even without confidence
 * - 「お」→「を」 and 「え」→「へ」 are fixed only between a noun and an independent verb, and only when that character's confidence is low
 * - Removes a 「を」 added by Whisper (between a noun and an independent verb, with low confidence).
 *   In evaluation, every real 「を」 had a confidence of 0.9 or more, and every added one less than 0.7 (docs/evaluation.md)
 * Confidence is available only for utterances transcribed in one piece (28 seconds or less). Spans with characters lacking confidence are not fixed.
 */
import { rangeConfidence } from './align';
import type { RuleContext, RuleResult } from './index';
import type { FixEdit, Token } from './types';

/** Misspellings of fixed expressions */
const FIXED_WORDS: Record<string, string> = {
  こんにちわ: 'こんにちは',
  こんばんわ: 'こんばんは',
};

/** Confidence below which 「お」 and 「え」 become particles */
export const PARTICLE_LOW_CONFIDENCE = 0.6;
/** Confidence below which a 「を」 counts as added */
export const DROP_WO_LOW_CONFIDENCE = 0.8;
/** Default for removing an added 「を」 (on, since it met the evaluation criteria) */
export const DROP_WO_DEFAULT = true;

/** Whether the token sits directly between a noun and an independent verb, with no gaps */
function betweenNounAndVerb(tokens: readonly Token[], i: number): boolean {
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  const t = tokens[i];
  return !!prev && !!next && prev.pos === '名詞' && next.pos === '動詞' && next.pos1 === '自立' && prev.end === t.start && t.end === next.start;
}

export function fixParticles(ctx: RuleContext): RuleResult {
  const tokens = ctx.tokens();
  if (!tokens) return { edits: [], skipped: 'no-tokenizer' };
  const conf = ctx.input.confidence ?? null;
  const dropWo = ctx.input.dropWo ?? DROP_WO_DEFAULT;
  const edits: FixEdit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const fixed = FIXED_WORDS[t.surface];
    if (fixed) {
      edits.push({ rule: 'particles', start: t.start, end: t.end, before: t.surface, after: fixed });
      continue;
    }
    if (!conf || !betweenNounAndVerb(tokens, i)) continue;
    const c = rangeConfidence(conf, t.start, t.end);
    if (c === null) continue;
    if ((t.surface === 'お' || t.surface === 'え') && c < PARTICLE_LOW_CONFIDENCE) {
      edits.push({ rule: 'particles', start: t.start, end: t.end, before: t.surface, after: t.surface === 'お' ? 'を' : 'へ' });
    } else if (dropWo && t.surface === 'を' && t.pos === '助詞' && c < DROP_WO_LOW_CONFIDENCE) {
      edits.push({ rule: 'particles', start: t.start, end: t.end, before: t.surface, after: '' });
    }
  }
  return { edits, skipped: conf ? undefined : 'no-confidence' };
}
