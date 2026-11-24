/**
 * 設定から、書き起こしの要求に付ける任意の指定を作る。アプリ（DictationController）と評価（eval/pipeline）が同じ関数を通る。
 * どれも既定ではオフで、評価で効果を確かめた設定だけを既定にする。
 */
import type { AsrResultPayload } from '../../shared/asr-protocol';
import type { AsrSettings } from '../../shared/settings';
import { buildAsrPrompt } from '../vocab/promptBuilder';
import type { TranscribeOptions } from './AsrService';
import { mergeUncertain, uncertainFromHypotheses, uncertainFromTokens, type Uncertain } from './hypotheses';

export type AsrRequestExtras = Pick<TranscribeOptions, 'promptText' | 'alternatives' | 'rehear'>;

/** 別候補を付ける箇所の確信度の上限 */
const ALTERNATIVES_BELOW = 0.5;

type ExtraSettings = Partial<Pick<AsrSettings, 'promptStyle' | 'promptTerms' | 'rehear' | 'alternativesTopK'>>;

/**
 * hints は大事な順（得点順）で渡す。context は直前の文脈（長い録音の、前の区間の書き起こし）。
 * プロンプトを main で組むのは、丸ごとの書き起こしと、区間ごとの書き起こしの両方で同じにする
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

/** 書き起こしの結果から、聞き違いかもしれない箇所を取り出す（聞き直しの食い違いを先に、確信度の低い箇所の別候補を後に） */
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
