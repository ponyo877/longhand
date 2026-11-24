/**
 * 規則 d: 助詞の明らかな誤りを直す。話し手が省いた助詞は補わない。
 *
 * - 語の決まり（「こんにちわ」→「こんにちは」など）は、確信度がなくても直す
 * - 「お」→「を」、「え」→「へ」は、名詞と自立語の動詞の間にあり、その字の確信度が低いときだけ直す
 * - Whisper が足した「を」（名詞と自立語の動詞の間で、確信度が低いもの）を消す。
 *   評価では、本物の「を」の確信度はどれも 0.9 以上、足された「を」は 0.7 未満だった（docs/evaluation.md）
 * 確信度は丸ごと書き起こした発話（28 秒以下）でだけ取れる。確信度のない文字を含む所は直さない。
 */
import { rangeConfidence } from './align';
import type { RuleContext, RuleResult } from './index';
import type { FixEdit, Token } from './types';

/** 語の決まりの誤り */
const FIXED_WORDS: Record<string, string> = {
  こんにちわ: 'こんにちは',
  こんばんわ: 'こんばんは',
};

/** 「お」「え」を助詞に直す確信度の上限 */
export const PARTICLE_LOW_CONFIDENCE = 0.6;
/** 足された「を」とみなす確信度の上限 */
export const DROP_WO_LOW_CONFIDENCE = 0.8;
/** 足された「を」を消すかの既定（評価の基準を満たしたのでオン） */
export const DROP_WO_DEFAULT = true;

/** 名詞と自立語の動詞の間に、隙間なく挟まっているか */
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
