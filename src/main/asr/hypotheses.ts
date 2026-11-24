/**
 * Collects the places where speech recognition may have misheard, in a form that can be passed to the formatting LLM.
 *
 * There are three sources.
 * - Other hypotheses from listening again under different conditions (the worker's hypotheses), or a second engine's transcript
 * - Alternative candidates where confidence is low (the worker's alternatives)
 * In both cases only the differences from the original transcript are taken, widened to a word-like range, and turned into
 * { heard, alternatives }. Differences only in punctuation, spaces or letter case are dropped (they are no clue to a mishearing).
 *
 * Passing several candidates to the LLM for correction has been reported to reduce errors in Japanese too. But candidates tempt the
 * LLM to rewrite, so few places are passed, and the formatting rules only allow replacing with a word among the candidates (format/prompts.ts).
 */
import type { AsrAlternative } from '../../shared/asr-protocol';
import { normalizeForCompare } from '../format/postprocess';
import { charDiff } from '../learn/diff';
import { realign } from '../textfix/align';
import { expandRunRange } from '../vocab/scriptRuns';

export interface Uncertain {
  /** The phrase in the transcript */
  heard: string;
  /** Other ways it could have been heard (each replaces the original phrase) */
  alternatives: string[];
  /** Where it came from. rehear: listening again, engine2: a second engine, token: alternative candidates where confidence is low */
  source: 'rehear' | 'engine2' | 'token';
}

interface Entry extends Uncertain {
  start: number;
  end: number;
}

const DEFAULT_LIMIT = 8;
/** Maximum number of candidates per place */
const MAX_ALTERNATIVES = 3;
/** A difference longer than this is a different sentence rather than a mishearing, so it is not passed */
const MAX_SPAN = 24;
/** Share of the original transcript a hypothesis must match to be used (relative to the shorter length). A hypothesis more than twice as long or short is not used either */
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
 * Takes the differences between the original transcript and other hypotheses (listening again or a second engine).
 * A difference is widened to the run of characters of the same kind (Latin letters, katakana, kanji). When one side of a difference
 * is empty, one character on each side is added so that the place can be found.
 */
export function uncertainFromHypotheses(text: string, hypotheses: readonly string[], source: 'rehear' | 'engine2' = 'rehear', limit = DEFAULT_LIMIT): Uncertain[] {
  const map = new Map<string, Entry>();
  for (const hyp of hypotheses) {
    if (!hyp || hyp === text) continue;
    const ops = charDiff(text, hyp);
    if (!ops) continue;
    // A hypothesis that differs a lot overall is a different sentence (a hallucination, for example) rather than a mishearing, so it is not used
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
      // Widen the other side by as much as this side was widened to the word (outside the difference the characters are the same, so widening by the same count keeps them aligned)
      const left = Math.max(aStart - s, bStart - hs);
      const right = Math.max(e - aEnd, he - bEnd);
      s = Math.max(0, aStart - left);
      hs = Math.max(0, bStart - left);
      e = Math.min(text.length, aEnd + right);
      he = Math.min(hyp.length, bEnd + right);
      // When one side is empty (an insertion or a deletion), add one character on each side
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
 * Takes the alternative candidates where confidence is low, as words.
 * A candidate is a single token (about one character), so it is widened to the word containing that character, and the word with
 * only that character replaced becomes the candidate.
 */
export function uncertainFromTokens(
  text: string,
  tokens: readonly (readonly [string, number])[] | null | undefined,
  alternatives: readonly AsrAlternative[] | null | undefined,
  opts: { minProb?: number; limit?: number } = {},
): Uncertain[] {
  if (!tokens?.length || !alternatives?.length || !text) return [];
  const minProb = opts.minProb ?? 0.05;
  // Find which token each character of the transcript came from
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

/** Merges several sources. The same phrase appears once, and candidates from listening again or a second engine come first */
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
