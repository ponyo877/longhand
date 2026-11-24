/**
 * Breakdown of error types. Aligns the reference and the output character by character, groups consecutive errors and sorts them into types.
 *
 * The alignment (editOps) and the grouping (errorGroups) were moved from the earlier scoring script.
 * They carry positions, so it is known where in the sentence each grouped error is.
 *
 * Types (applied from the top):
 * - number         involves numbers (Arabic numerals, or kanji numerals on both sides)
 * - filler         a filler word (えー, あの and so on) was added or dropped
 * - particle       a particle was added, dropped or swapped
 * - notation       a difference in writing only (same reading, but a different choice of kana and kanji or different okurigana)
 * - homophone      a homophone (same reading, different kanji). Detected only with word segmentation
 * - latinKatakana  involves a word in Latin letters or katakana (a misheard product name or technical term, a spelling difference)
 * - deletion       any other deletion (a character in the reference is missing from the output)
 * - insertion      any other insertion (a character not in the reference is in the output)
 * - other          any other substitution
 *
 * Readings come from word segmentation (lindera, IPADIC). Without word segmentation, only differences between hiragana and katakana count as notation.
 */
import type { Token, Tokenizer } from '../textfix/types';
import { normContent } from './metrics';

export type Op = '=' | 'S' | 'D' | 'I';

export interface EditOp {
  op: Op;
  /** Reference character (empty for I) */
  ref: string;
  /** Output character (empty for D) */
  hyp: string;
  /** Position before this operation (index into the reference, index into the output) */
  i: number;
  j: number;
}

/** Levenshtein alignment. = is a match, S a substitution, D a deletion, I an insertion */
export function editOps(ref: readonly string[], hyp: readonly string[]): EditOp[] {
  const n = ref.length;
  const m = hyp.length;
  const w = m + 1;
  const d = new Uint32Array((n + 1) * w);
  for (let i = 0; i <= n; i++) d[i * w] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i * w + j] = Math.min(d[(i - 1) * w + j] + 1, d[i * w + j - 1] + 1, d[(i - 1) * w + j - 1] + c);
    }
  }
  const ops: EditOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * w + j] === d[(i - 1) * w + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? '=' : 'S', ref: ref[i - 1], hyp: hyp[j - 1], i: i - 1, j: j - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i * w + j] === d[(i - 1) * w + j] + 1) {
      ops.push({ op: 'D', ref: ref[i - 1], hyp: '', i: i - 1, j });
      i--;
    } else {
      ops.push({ op: 'I', ref: '', hyp: hyp[j - 1], i, j: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

/** Consecutive errors grouped together. Positions are indexes [start, end) into the normalized character sequence */
export interface ErrorGroup {
  ref: string;
  hyp: string;
  refStart: number;
  refEnd: number;
  hypStart: number;
  hypEnd: number;
  /** Number of edits in this error (its contribution to the distance) */
  edits: number;
}

export function errorGroups(ops: readonly EditOp[]): ErrorGroup[] {
  const groups: ErrorGroup[] = [];
  let cur: ErrorGroup | null = null;
  for (const o of ops) {
    if (o.op === '=') {
      if (cur) groups.push(cur);
      cur = null;
      continue;
    }
    cur ??= { ref: '', hyp: '', refStart: o.i, refEnd: o.i, hypStart: o.j, hypEnd: o.j, edits: 0 };
    cur.ref += o.ref;
    cur.hyp += o.hyp;
    if (o.op !== 'I') cur.refEnd++;
    if (o.op !== 'D') cur.hypEnd++;
    cur.edits++;
  }
  if (cur) groups.push(cur);
  return groups;
}

export type ErrorKind = 'number' | 'filler' | 'particle' | 'notation' | 'homophone' | 'latinKatakana' | 'deletion' | 'insertion' | 'other';

export const ERROR_KINDS: readonly ErrorKind[] = ['latinKatakana', 'number', 'particle', 'filler', 'notation', 'homophone', 'deletion', 'insertion', 'other'];

export const ERROR_KIND_LABELS: Record<ErrorKind, string> = {
  latinKatakana: 'Latin letters and katakana',
  number: 'numbers',
  particle: 'particles',
  filler: 'fillers',
  notation: 'notation only',
  homophone: 'homophones',
  deletion: 'deletions',
  insertion: 'insertions',
  other: 'other',
};

export type ErrorBreakdown = Record<ErrorKind, { groups: number; edits: number }>;

export function emptyBreakdown(): ErrorBreakdown {
  return Object.fromEntries(ERROR_KINDS.map((k) => [k, { groups: 0, edits: 0 }])) as ErrorBreakdown;
}

export function addBreakdown(a: ErrorBreakdown, b: ErrorBreakdown): ErrorBreakdown {
  const out = emptyBreakdown();
  for (const k of ERROR_KINDS) out[k] = { groups: a[k].groups + b[k].groups, edits: a[k].edits + b[k].edits };
  return out;
}

const FILLER = /^(えーっと|えっと|えーと|ええと|えと|えー+|あー+|うーん|んー+|あのー*|なんか|まあ|そのー+)+$/;
const PARTICLES = new Set(['は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'の', 'や', 'か', 'ね', 'よ', 'な', 'わ', 'って', 'から', 'まで', 'より', 'では', 'には', 'とは']);
const KANJI_NUMERALS = /^[〇一二三四五六七八九十百千万億兆]+$/;
const KANJI = /[㐀-䶿一-鿿豈-﫿々]/;
const KATAKANA = /[ァ-ヺ]/;

/** Converts hiragana to katakana */
function toKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

type Range = [number, number];

/** One side's sentence (normalized character sequence) and its word segmentation */
interface Side {
  chars: readonly string[];
  /** Word ranges (indexes into the character sequence) and readings. null without word segmentation */
  tokens: { start: number; end: number; token: Token }[] | null;
}

function makeSide(chars: readonly string[], tokenizer: Tokenizer | null | undefined): Side {
  if (!tokenizer || !chars.length) return { chars, tokens: null };
  const text = chars.join('');
  let raw: Token[] | null = null;
  try {
    raw = tokenizer.tokenize(text);
  } catch {
    raw = null;
  }
  if (!raw) return { chars, tokens: null };
  // Word segmentation positions are string indexes (UTF-16), so convert them to indexes into the character sequence
  const toChar = new Int32Array(text.length + 1);
  let unit = 0;
  chars.forEach((c, k) => {
    for (let u = 0; u < c.length; u++) toChar[unit + u] = k;
    unit += c.length;
  });
  toChar[unit] = chars.length;
  return { chars, tokens: raw.map((token) => ({ start: toChar[token.start], end: toChar[token.end], token })) };
}

/** Words that overlap the range. For an empty range, only words that span that position */
function overlapping(side: Side, [s, e]: Range) {
  if (!side.tokens) return [];
  return side.tokens.filter((t) => (s === e ? t.start < s && t.end > s : t.start < e && t.end > s));
}

/** Widens the range to word boundaries */
function expand(side: Side, r: Range): Range {
  const over = overlapping(side, r);
  if (!over.length) return r;
  return [Math.min(r[0], over[0].start), Math.max(r[1], over[over.length - 1].end)];
}

function union(a: Range, b: Range): Range {
  return b[0] > b[1] ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

/** From the alignment path, builds the range (min and max) of boundaries on one side that correspond to each boundary on the other side */
function boundaryMaps(ops: readonly EditOp[], n: number, m: number) {
  const hypMin = new Int32Array(n + 1).fill(-1);
  const hypMax = new Int32Array(n + 1).fill(-1);
  const refMin = new Int32Array(m + 1).fill(-1);
  const refMax = new Int32Array(m + 1).fill(-1);
  const visit = (i: number, j: number) => {
    if (hypMin[i] < 0) hypMin[i] = j;
    hypMax[i] = j;
    if (refMin[j] < 0) refMin[j] = i;
    refMax[j] = i;
  };
  let i = 0;
  let j = 0;
  visit(0, 0);
  for (const o of ops) {
    if (o.op !== 'I') i++;
    if (o.op !== 'D') j++;
    visit(i, j);
  }
  return { hypMin, hypMax, refMin, refMax };
}

/** Reading of the range (katakana). Uses the surface form for words without a known reading */
function readingOf(side: Side, r: Range): string {
  if (r[0] >= r[1]) return '';
  return overlapping(side, r)
    .map((t) => toKatakana(t.token.reading || t.token.surface))
    .join('');
}

/** Maximum width (characters) a range may be widened to compare readings. Notation differences happen within a word, so a range that grows too wide is not compared */
const MAX_EXPANDED = 16;

/**
 * Widens a grouped error on both sides to word boundaries, and compares the readings on the reference side and the output side.
 * When the readings match, returns whether it is a choice of kana and kanji (notation) or a homophone (homophone). Otherwise null
 */
function sameReading(g: ErrorGroup, ref: Side, hyp: Side, maps: ReturnType<typeof boundaryMaps>): 'notation' | 'homophone' | null {
  if (!ref.tokens || !hyp.tokens) return null;
  let r: Range = [g.refStart, g.refEnd];
  let h: Range = [g.hypStart, g.hypEnd];
  for (let k = 0; k < 6; k++) {
    const r2 = expand(ref, r);
    const h2 = expand(hyp, union(h, [maps.hypMax[r2[0]], maps.hypMin[r2[1]]]));
    const r3 = expand(ref, union(r2, [maps.refMax[h2[0]], maps.refMin[h2[1]]]));
    const stable = r3[0] === r[0] && r3[1] === r[1] && h2[0] === h[0] && h2[1] === h[1];
    r = r3;
    h = h2;
    if (stable) break;
  }
  if (r[1] - r[0] > MAX_EXPANDED || h[1] - h[0] > MAX_EXPANDED) return null;
  const a = readingOf(ref, r);
  const b = readingOf(hyp, h);
  if (!a || a !== b) return null;
  const kanji = (side: Side, [s, e]: Range) => side.chars.slice(s, e).filter((c) => KANJI.test(c));
  const ka = kanji(ref, r);
  const kb = kanji(hyp, h);
  // Notation if either side is kana only or the kanji are the same (an okurigana difference). Homophone if the kanji differ
  if (!ka.length || !kb.length || ka.join('') === kb.join('')) return 'notation';
  return 'homophone';
}

/** Whether the range consists only of particle words. Without word segmentation, decided only by the list */
function isParticle(side: Side, text: string, r: Range): boolean {
  if (!PARTICLES.has(text)) return false;
  if (!side.tokens) return true;
  const over = overlapping(side, r);
  return over.length > 0 && over[0].start === r[0] && over[over.length - 1].end === r[1] && over.every((t) => t.token.pos === '助詞');
}

function hasKatakana(side: Side, text: string, start: number): boolean {
  if (KATAKANA.test(text)) return true;
  // A difference in long vowel marks alone counts only inside a katakana word (the long vowel in 「えー」 does not count)
  return /^ー+$/.test(text) && start > 0 && KATAKANA.test(side.chars[start - 1]);
}

function classify(g: ErrorGroup, ref: Side, hyp: Side, maps: ReturnType<typeof boundaryMaps>): ErrorKind {
  const { ref: r, hyp: h } = g;
  if (/[0-9]/.test(r) || /[0-9]/.test(h) || (KANJI_NUMERALS.test(r) && KANJI_NUMERALS.test(h))) return 'number';
  if ((!r && FILLER.test(h)) || (!h && FILLER.test(r))) return 'filler';
  const refParticle = !r || isParticle(ref, r, [g.refStart, g.refEnd]);
  const hypParticle = !h || isParticle(hyp, h, [g.hypStart, g.hypEnd]);
  if (refParticle && hypParticle) return 'particle';
  const same = sameReading(g, ref, hyp, maps);
  if (same) return same;
  if (r && h && toKatakana(r) === toKatakana(h)) return 'notation';
  if (/[a-z]/.test(r) || /[a-z]/.test(h) || hasKatakana(ref, r, g.refStart) || hasKatakana(hyp, h, g.hypStart)) return 'latinKatakana';
  if (!h) return 'deletion';
  if (!r) return 'insertion';
  return 'other';
}

/** Sorts errors between normalized character sequences into types */
export function classifyErrors(ref: readonly string[], hyp: readonly string[], tokenizer?: Tokenizer | null): { group: ErrorGroup; kind: ErrorKind }[] {
  const ops = editOps(ref, hyp);
  const groups = errorGroups(ops);
  if (!groups.length) return [];
  const refSide = makeSide(ref, tokenizer);
  const hypSide = makeSide(hyp, tokenizer);
  const maps = boundaryMaps(ops, ref.length, hyp.length);
  return groups.map((group) => ({ group, kind: classify(group, refSide, hypSide, maps) }));
}

/** Counts groups and edits per error type from the reference and output sentences (compares content only; ignores punctuation and spaces) */
export function errorBreakdown(reference: string, output: string, tokenizer?: Tokenizer | null): ErrorBreakdown {
  const out = emptyBreakdown();
  for (const { group, kind } of classifyErrors(normContent(reference), normContent(output), tokenizer)) {
    out[kind].groups++;
    out[kind].edits += group.edits;
  }
  return out;
}
