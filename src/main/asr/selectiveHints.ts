/**
 * 語彙ヒントの使い方を、ヒントが効いた所だけに絞る。
 *
 * whisper に語彙ヒント（辞書の語）を渡すと、その語は聞き取れるようになるが、ヒントと関係のない所の書き起こしまで変わる
 * （ヒントの語に引っ張られて、普通の語が珍しい漢字の名前になる、など）。辞書の語を含まない発話では、誤りが増える。
 *
 * そこで、同じ音声を、ヒントなしとヒントありの 2 回書き起こす。ヒントなしの書き起こしを土台にして、
 * ヒントありの書き起こしから、次の所だけを取り込む。
 * - 辞書の語が新しく現れた所
 * - 英字の語が新しく現れた所（ヒントに英字の語があると、製品名などが英字の表記で出るようになる）
 * ほかの違いは、ヒントなしのほうを使う。
 *
 * 評価の結果は docs/evaluation.md にある。書き起こしが 2 回になるので、その分だけ時間がかかる。
 */
import type { AsrHypothesis, AsrResultPayload } from '../../shared/asr-protocol';
import { diffHunks } from '../learn/diff';
import type { TranscribeOptions } from './AsrService';

/** always: いつもヒントありの書き起こしを使う。selective: ヒントが効いた所だけを取り込む */
export type HintMode = 'always' | 'selective';

const key = (s: string) => s.normalize('NFKC').toLowerCase();
const hasLatinWord = (s: string) => /[A-Za-z]{2,}/.test(s);

/** 文字の種類の連続に分ける（英字と数字の語、カタカナ、漢字、ひらがな、空白。ほかは 1 字ずつ） */
export function scriptTokens(text: string): string[] {
  return text.match(/[A-Za-z0-9][A-Za-z0-9.+#'_-]*|[ァ-ヺー]+|[一-龠々〆ヶ]+|[ぁ-ゖ]+|\s+|./gsu) ?? [];
}

export interface SpliceResult {
  text: string;
  /** ヒントありの書き起こしから取り込んだ所の数 */
  taken: number;
}

/**
 * ヒントなしの書き起こし（plain）を土台にして、ヒントありの書き起こし（hinted）から、ヒントが効いた所だけを取り込む。
 * vocabulary は、ヒントとして渡した語。
 */
export function spliceHinted(plain: string, hinted: string, vocabulary: readonly string[]): SpliceResult {
  if (plain === hinted || !hinted.trim()) return { text: plain, taken: 0 };
  // ヒントなしでは何も聞き取れなかったときは、ヒントありのほうを使う
  if (!plain.trim()) return { text: hinted, taken: 1 };
  const a = scriptTokens(plain);
  const b = scriptTokens(hinted);
  const hunks = diffHunks(a, b);
  if (!hunks) return { text: plain, taken: 0 };
  const words = vocabulary.map((w) => w.trim()).filter(Boolean);
  const out: string[] = [];
  let at = 0;
  let taken = 0;
  for (const h of hunks) {
    out.push(...a.slice(at, h.aStart));
    const from = a.slice(h.aStart, h.aEnd).join('');
    const to = b.slice(h.bStart, h.bEnd).join('');
    // 辞書の語が、この場所に新しく現れた（大文字と小文字だけを直した場合も含む）
    const word = words.some((w) => key(to).includes(key(w)) && !from.normalize('NFKC').includes(w.normalize('NFKC')));
    // かなや漢字で書かれていた所が、英字の語になった
    const latin = hasLatinWord(to) && !hasLatinWord(from);
    if (word || latin) {
      out.push(to);
      taken++;
    } else {
      out.push(from);
    }
    at = h.aEnd;
  }
  out.push(...a.slice(at));
  return { text: out.join(''), taken };
}

/**
 * 2 回書き起こして、ヒントが効いた所だけを取り込んだ結果を返す。
 * run は、同じ音声を、渡した指定で書き起こす関数。hinted はヒントありの指定、plain はヒントなしの指定。
 * 確信度（tokens）は、ヒントなしの書き起こしのものを返す（取り込んだ所の確信度は、分からないものとして扱われる）。
 * 取り込まなかった食い違いが残るときは、ヒントありの書き起こしを別の仮説（hypotheses）として添える。
 * 整形で、食い違う箇所を LLM に選ばせるのに使える（設定の formatUncertain）
 */
export async function transcribeSelective(run: (opts: TranscribeOptions) => Promise<AsrResultPayload>, hinted: TranscribeOptions, plain: TranscribeOptions): Promise<AsrResultPayload> {
  const p = await run(plain);
  const h = await run(hinted);
  const elapsedMs = p.elapsedMs + h.elapsedMs;
  const counts = { hintsGiven: h.hintsGiven, hintsUsed: h.hintsUsed };
  const { text, taken } = spliceHinted(p.text, h.text, hinted.hints);
  // 全部を取り込んだ結果がヒントありの書き起こしと同じなら、確信度もそのまま使える
  if (taken && text === h.text) return { ...h, elapsedMs };
  const hypotheses: AsrHypothesis[] = [...(p.hypotheses ?? [])];
  if (h.text.trim() && h.text !== text) hypotheses.push({ text: h.text, source: 'hinted', avgLogprob: 0 });
  const extra = hypotheses.length ? { hypotheses } : {};
  if (!taken) return { ...p, ...counts, ...extra, elapsedMs };
  return { ...p, ...counts, ...extra, text, elapsedMs, segments: undefined };
}
