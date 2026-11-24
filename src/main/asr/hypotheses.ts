/**
 * 音声認識の「聞き違いかもしれない箇所」を、整形の LLM に渡せる形にまとめる。
 *
 * 材料は 3 つある。
 * - 条件を変えて聞き直した別の仮説（ワーカーの hypotheses）、または 2 つ目のエンジンの書き起こし
 * - 確信度の低い箇所の別候補（ワーカーの alternatives）
 * どちらも、もとの書き起こしとの食い違いだけを取り出し、語らしい範囲に広げて { heard, alternatives } にする。
 * 句読点、空白、大文字と小文字だけの違いは捨てる（聞き違いの手がかりにならない）。
 *
 * 複数の候補を LLM に渡して直す方法は、日本語でも誤りを減らした報告がある。ただし、候補があると LLM は書き換えたくなるので、
 * 渡す箇所は少なく絞り、整形の規則で「候補にある語にだけ置き換えてよい」と縛る（format/prompts.ts）。
 */
import type { AsrAlternative } from '../../shared/asr-protocol';
import { normalizeForCompare } from '../format/postprocess';
import { charDiff } from '../learn/diff';
import { realign } from '../textfix/align';
import { expandRunRange } from '../vocab/scriptRuns';

export interface Uncertain {
  /** 書き起こしの中の語句 */
  heard: string;
  /** 別の聞き取り方（もとの語句を置き換える形） */
  alternatives: string[];
  /** 根拠。rehear: 聞き直し、engine2: 2 つ目のエンジン、token: 確信度の低い箇所の別候補 */
  source: 'rehear' | 'engine2' | 'token';
}

interface Entry extends Uncertain {
  start: number;
  end: number;
}

const DEFAULT_LIMIT = 8;
/** 1 か所あたりの候補の上限 */
const MAX_ALTERNATIVES = 3;
/** これより長い食い違いは、聞き違いではなく別の文なので渡さない */
const MAX_SPAN = 24;
/** 仮説として使うのに必要な、もとの書き起こしとの一致の割合（短いほうの長さに対して）。長さが 2 倍を超えて違う仮説も使わない */
const MIN_SIMILARITY = 0.5;

function addEntry(map: Map<string, Entry>, e: Entry): void {
  const key = `${e.start}:${e.end}`;
  const cur = map.get(key);
  if (!cur) {
    map.set(key, e);
    return;
  }
  for (const a of e.alternatives) if (!cur.alternatives.includes(a) && cur.alternatives.length < MAX_ALTERNATIVES) cur.alternatives.push(a);
}

function finish(map: Map<string, Entry>, limit: number): Uncertain[] {
  return [...map.values()]
    .filter((e) => e.alternatives.length > 0)
    .sort((a, b) => a.start - b.start)
    .slice(0, limit)
    .map(({ heard, alternatives, source }) => ({ heard, alternatives, source }));
}

/**
 * もとの書き起こしと、別の仮説（聞き直しや 2 つ目のエンジン）との食い違いを取り出す。
 * 食い違いは、同じ種類の字（英字、カタカナ、漢字）が続く範囲まで広げる。片方が空の食い違いは、前後 1 字を足して場所が分かるようにする。
 */
export function uncertainFromHypotheses(text: string, hypotheses: readonly string[], source: 'rehear' | 'engine2' = 'rehear', limit = DEFAULT_LIMIT): Uncertain[] {
  const map = new Map<string, Entry>();
  for (const hyp of hypotheses) {
    if (!hyp || hyp === text) continue;
    const ops = charDiff(text, hyp);
    if (!ops) continue;
    // 全体が大きく違う仮説は、聞き違いではなく別の文（幻聴など）なので使わない
    const same = ops.reduce((n, op) => n + (op.kind === 'eq' ? normalizeForCompare(op.text).length : 0), 0);
    const la = normalizeForCompare(text).length;
    const lb = normalizeForCompare(hyp).length;
    if (Math.max(la, lb) > Math.min(la, lb) * 2 + 4 || same < Math.min(la, lb) * MIN_SIMILARITY) continue;
    let a = 0;
    let b = 0;
    let cur: { aStart: number; aEnd: number; bStart: number; bEnd: number } | null = null;
    const flush = () => {
      if (!cur) return;
      const { aStart, aEnd, bStart, bEnd } = cur;
      cur = null;
      if (normalizeForCompare(text.slice(aStart, aEnd)) === normalizeForCompare(hyp.slice(bStart, bEnd))) return;
      let [s, e] = expandRunRange(text, aStart, aEnd);
      let [hs, he] = expandRunRange(hyp, bStart, bEnd);
      // 語の範囲に広げたぶんを、もう一方にも足す（食い違いの外側は同じ文字なので、同じ数だけ広げればそろう）
      const left = Math.max(aStart - s, bStart - hs);
      const right = Math.max(e - aEnd, he - bEnd);
      s = Math.max(0, aStart - left);
      hs = Math.max(0, bStart - left);
      e = Math.min(text.length, aEnd + right);
      he = Math.min(hyp.length, bEnd + right);
      // 片方が空のとき（挿入か削除）は、前後 1 字を足す
      if (s === e || hs === he) {
        if (s > 0 && hs > 0) {
          s--;
          hs--;
        }
        if (e < text.length && he < hyp.length) {
          e++;
          he++;
        }
      }
      const heard = text.slice(s, e).trim();
      const alt = hyp.slice(hs, he).trim();
      if (!heard || !alt || heard === alt || e - s > MAX_SPAN || he - hs > MAX_SPAN) return;
      if (!normalizeForCompare(heard) || !normalizeForCompare(alt)) return;
      addEntry(map, { heard, alternatives: [alt], source, start: s, end: e });
    };
    for (const op of ops) {
      if (op.kind === 'eq') {
        flush();
        a += op.text.length;
        b += op.text.length;
        continue;
      }
      cur ??= { aStart: a, aEnd: a, bStart: b, bEnd: b };
      if (op.kind === 'del') {
        a += op.text.length;
        cur.aEnd = a;
      } else {
        b += op.text.length;
        cur.bEnd = b;
      }
    }
    flush();
  }
  return finish(map, limit);
}

/**
 * 確信度の低い箇所の別候補を、語の形にして取り出す。
 * 候補は 1 つのトークン（1 字前後）なので、その字を含む語の範囲に広げ、その字だけを差し替えた語を候補にする。
 */
export function uncertainFromTokens(
  text: string,
  tokens: readonly (readonly [string, number])[] | null | undefined,
  alternatives: readonly AsrAlternative[] | null | undefined,
  opts: { minProb?: number; limit?: number } = {},
): Uncertain[] {
  if (!tokens?.length || !alternatives?.length || !text) return [];
  const minProb = opts.minProb ?? 0.05;
  // 書き起こしの文字ごとに、どのトークンから来たかを求める
  let joined = '';
  const owner: number[] = [];
  tokens.forEach(([piece], i) => {
    joined += piece;
    for (let k = 0; k < piece.length; k++) owner.push(i);
  });
  const ownerOfText = realign(joined, owner, text);
  const map = new Map<string, Entry>();
  for (const alt of alternatives) {
    const first = ownerOfText.indexOf(alt.index);
    if (first < 0) continue;
    let last = first;
    while (last + 1 < text.length && ownerOfText[last + 1] === alt.index) last++;
    const piece = text.slice(first, last + 1);
    if (!normalizeForCompare(piece)) continue;
    const [s, e] = expandRunRange(text, first, last + 1);
    const heard = text.slice(s, e);
    const cands: string[] = [];
    for (const [cand, p] of alt.candidates) {
      const c = cand.trim();
      if (p < minProb || !normalizeForCompare(c)) continue;
      const word = text.slice(s, first) + c + text.slice(last + 1, e);
      if (word !== heard && !cands.includes(word)) cands.push(word);
      if (cands.length >= MAX_ALTERNATIVES) break;
    }
    if (cands.length) addEntry(map, { heard, alternatives: cands, source: 'token', start: s, end: e });
  }
  return finish(map, opts.limit ?? DEFAULT_LIMIT);
}

/** 複数の材料をまとめる。同じ語句は 1 つにし、聞き直しや 2 つ目のエンジンの候補を先に並べる */
export function mergeUncertain(lists: readonly (readonly Uncertain[])[], limit = DEFAULT_LIMIT): Uncertain[] {
  const out: Uncertain[] = [];
  for (const list of lists) {
    for (const u of list) {
      const cur = out.find((x) => x.heard === u.heard);
      if (!cur) out.push({ heard: u.heard, alternatives: [...u.alternatives], source: u.source });
      else for (const a of u.alternatives) if (!cur.alternatives.includes(a) && cur.alternatives.length < MAX_ALTERNATIVES) cur.alternatives.push(a);
    }
  }
  return out.slice(0, limit);
}
