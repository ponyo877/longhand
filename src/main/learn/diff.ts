/**
 * Compares the pasted text with the text after the user's correction and extracts pairs of replaced words (LRN-1).
 */
import type { Tokenizer } from '../textfix/types';
import { editDistance, hasKanji, hiraToKata, soundForm } from '../vocab/kana';

export interface Replacement {
  /** The word as pasted (misrecognized) */
  from: string;
  /** The word after the correction */
  to: string;
  /** The part of the corrected text around this replacement (context for the LLM's judgment) */
  context: string;
  /** Reading in the sentence (katakana). Set only when the tokenizer found it (extractRewrites) */
  fromReading?: string;
  toReading?: string;
}

export interface EditedRegion {
  original: string;
  edited: string;
  /**
   * How the region was found. diff: positions mapped using unchanged parts as anchors / prefix: common prefix and suffix (fallback when anchors cannot be used) /
   * search: searched for the pasted text (when the paste showed up late)
   */
  method: 'diff' | 'prefix' | 'search';
}

export interface RegionOptions {
  /** The pasted text (without command syntax). Searched for when comparing before and after does not reveal the paste position */
  inserted?: string;
  /** Paste position in before (in characters). When the pasted text is found more than once, the closest one is chosen */
  near?: number;
}

function commonPrefix(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string[], b: string[], limitA: number, limitB: number): number {
  let i = 0;
  while (i < a.length - limitA && i < b.length - limitB && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** A character-level diff hunk ([aStart, aEnd) in a became [bStart, bEnd) in b) */
interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Myers diff. Faster with fewer changes (O((N+M)D)). null if the amount of change exceeds maxD.
 * Comparing the full text of a long field (up to 20,000 characters) finishes quickly when the corrections are few.
 */
export function diffHunks(a: string[], b: string[], maxD = 2000): Hunk[] | null {
  const pre = commonPrefix(a, b);
  const suf = commonSuffix(a, b, pre, pre);
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const N = A.length;
  const M = B.length;
  if (N === 0 && M === 0) return [];
  if (N === 0 || M === 0) return [{ aStart: pre, aEnd: pre + N, bStart: pre, bEnd: pre + M }];

  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(maxD, N + M); d++) {
    const v = new Int32Array(2 * d + 1);
    const prev = trace[d - 1];
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && prev[k - 1 + (d - 1)] < prev[k + 1 + (d - 1)])) x = prev[k + 1 + (d - 1)];
      else x = prev[k - 1 + (d - 1)] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[k + d] = x;
      if (x >= N && y >= M) {
        found = d;
        break;
      }
    }
    trace.push(v);
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Walk back from the end, collecting single-character delete and insert operations
  type Edit = { kind: 'del' | 'ins'; a: number; b: number };
  const edits: Edit[] = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + (d - 1)] < prev[k + 1 + (d - 1)]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + (d - 1)];
    const prevY = prevX - prevK;
    if (down) edits.push({ kind: 'ins', a: prevX, b: prevY });
    else edits.push({ kind: 'del', a: prevX, b: prevY });
    x = prevX;
    y = prevY;
  }
  edits.reverse();

  // Group adjacent operations into hunks
  const hunks: Hunk[] = [];
  for (const e of edits) {
    const last = hunks[hunks.length - 1];
    const aPos = pre + e.a;
    const bPos = pre + e.b;
    if (last && last.aEnd === aPos && last.bEnd === bPos) {
      if (e.kind === 'del') last.aEnd++;
      else last.bEnd++;
    } else {
      hunks.push({ aStart: aPos, aEnd: aPos + (e.kind === 'del' ? 1 : 0), bStart: bPos, bEnd: bPos + (e.kind === 'ins' ? 1 : 0) });
    }
  }
  return hunks;
}

/**
 * Maps a position in a to a position in b. Hunks on the boundary are treated differently for the start and the end of the region.
 * - Hunks that delete (replace) characters inside the region are included
 * - Hunks that only add text right at the edge of the region (pure insertions) are not included (text added before or after the paste)
 */
function mapPosition(hunks: Hunk[], pos: number, side: 'start' | 'end'): number {
  let delta = 0;
  for (const h of hunks) {
    if (pos < h.aStart) return pos + delta;
    if (side === 'start') {
      if (pos === h.aStart) return h.aEnd > h.aStart ? h.bStart : h.bEnd;
      if (pos < h.aEnd) return h.bStart;
    } else {
      if (pos === h.aStart) return h.bStart;
      if (pos <= h.aEnd) return h.bEnd;
    }
    delta = h.bEnd - h.aEnd;
  }
  return pos + delta;
}

type Op = { kind: 'eq' | 'del' | 'ins'; text: string };

/** Character-level diff (LCS). Corrections are short, so O(n*m) is enough. null if too long */
export function charDiff(a: string, b: string): Op[] | null {
  const A = Array.from(a);
  const B = Array.from(b);
  if (A.length * B.length > 4_000_000) return null;
  const n = A.length;
  const m = B.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  const push = (kind: Op['kind'], ch: string) => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) last.text += ch;
    else ops.push({ kind, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('eq', A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', A[i++]);
    } else {
      push('ins', B[j++]);
    }
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return ops;
}

/** How much of two texts is kept (matching characters ÷ length of the longer one) */
export function keptRatio(a: string, b: string): number {
  const ops = charDiff(a, b);
  if (!ops) return 0;
  const kept = ops.filter((o) => o.kind === 'eq').reduce((n, o) => n + Array.from(o.text).length, 0);
  return kept / Math.max(Array.from(a).length, Array.from(b).length, 1);
}

/** Removes command syntax and leading and trailing whitespace from the pasted text */
export function stripPasteTokens(s: string): string {
  return s
    .replace(/<\|[A-Z_0-9]+\|>/g, '')
    .replace(/<​\|/g, '<|')
    .trim();
}

function indexOfSeq(hay: string[], needle: string[], from = 0): number {
  if (!needle.length) return -1;
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Position of the occurrence of needle closest to near */
function closestIndexOf(hay: string[], needle: string[], near: number): number {
  let best = -1;
  for (let i = indexOfSeq(hay, needle); i >= 0; i = indexOfSeq(hay, needle, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

/** Finds the range added by the paste in ref (the full text after the paste) */
function locateInsertion(before: string[], ref: string[], inserted: string[] | null, near?: number): [number, number] | null {
  const p = commonPrefix(before, ref);
  const s = commonSuffix(before, ref, p, p);
  const start = p;
  const end = ref.length - s;
  if (end > start) {
    if (!inserted?.length) return [start, end];
    // If the pasted text appears as is within the range, narrow to it (excluding changes the app made near the paste)
    const seg = ref.slice(start, end);
    const i = indexOfSeq(seg, inserted);
    if (i >= 0) return [start + i, start + i + inserted.length];
    // If it is not very different from the pasted text, use the range found by comparing before and after. Otherwise, search for the pasted text
    if (keptRatio(seg.join('').trim(), inserted.join('')) >= 0.5) return [start, end];
  }
  if (inserted?.length) {
    const i = closestIndexOf(ref, inserted, near ?? p);
    if (i >= 0) return [i, i + inserted.length];
  }
  return end > start ? [start, end] : null;
}

/** The older method: determines the range from the common prefix and suffix, null if the correction reaches outside the range */
function regionByPrefix(ref: string[], final: string[], insStart: number, insEnd: number): [number, number] | null {
  const ep = commonPrefix(ref, final);
  const es = commonSuffix(ref, final, ep, ep);
  if (ep < insStart || ref.length - es > insEnd) return null;
  const p2 = Math.min(insStart, ep);
  const s2 = Math.min(ref.length - insEnd, commonSuffix(ref, final, p2, p2));
  return [p2, final.length - s2];
}

/**
 * From changes to the field's full text, extracts how the corrections changed the pasted part (G4-02).
 * before: before the paste, afterPaste: right after the paste (or right before the user starts typing), final: end of the watch.
 * Diffs afterPaste and final, and maps the pasted range onto final using the unchanged parts as anchors.
 * Even if the user also edited outside the range (a subject line or recipient, for example), only the corrections inside the range are extracted.
 */
export function locateEditedRegion(before: string, afterPaste: string, final: string, opts: RegionOptions = {}): EditedRegion | null {
  const B0 = Array.from(before);
  const R = Array.from(afterPaste);
  const F = Array.from(final);
  const inserted = opts.inserted ? Array.from(stripPasteTokens(opts.inserted)) : null;

  const ins = locateInsertion(B0, R, inserted, opts.near);
  if (!ins) {
    // The reading right after the paste did not include it (it showed up late). Compare the diff between before and final with the pasted text
    if (!inserted?.length) return null;
    const p = commonPrefix(B0, F);
    const s = commonSuffix(B0, F, p, p);
    const edited = F.slice(p, F.length - s).join('');
    const original = inserted.join('');
    if (!edited || keptRatio(original, edited) < 0.5) return null;
    return original === edited ? null : { original, edited, method: 'search' };
  }
  const [insStart, insEnd] = ins;
  const original = R.slice(insStart, insEnd).join('');

  const hunks = diffHunks(R, F);
  let range: [number, number] | null;
  let method: EditedRegion['method'] = 'diff';
  if (hunks) {
    let s = mapPosition(hunks, insStart, 'start');
    let e = mapPosition(hunks, insEnd, 'end');
    // If a replacement hunk touching the edge of the range carries words or text added outside the range, cut them off
    const hs = hunks.find((h) => h.aStart === insStart && h.aEnd > h.aStart && h.bEnd > h.bStart);
    const he = hunks.find((h) => h.aEnd === insEnd && h.aEnd > h.aStart && h.bEnd > h.bStart);
    const cut = (h: Hunk, left: boolean, right: boolean) => trimInsertion(R.slice(h.aStart, h.aEnd).join(''), F.slice(h.bStart, h.bEnd), left, right);
    if (hs) s = hs.bStart + cut(hs, true, hs === he)[0];
    if (he) e = he.bStart + cut(he, hs === he, true)[1];
    range = [s, Math.max(s, e)];
  } else {
    range = regionByPrefix(R, F, insStart, insEnd);
    method = 'prefix';
  }
  if (!range) return null;
  const edited = F.slice(range[0], range[1]).join('');
  if (original === edited) return null;
  return { original, edited, method };
}

/** Returns only original and edited from locateEditedRegion's result (the older calling style) */
export function extractEditedRegion(before: string, afterPaste: string, final: string, opts: RegionOptions = {}): { original: string; edited: string } | null {
  const r = locateEditedRegion(before, afterPaste, final, opts);
  return r ? { original: r.original, edited: r.edited } : null;
}

type Script = 'kanji' | 'hira' | 'kata' | 'latin' | 'other';

function scriptOf(ch: string): Script {
  if (/[一-鿿㐀-䶿々〆]/.test(ch)) return 'kanji';
  if (/[぀-ゟ]/.test(ch)) return 'hira';
  if (/[゠-ヿー]/.test(ch)) return 'kata';
  if (/[A-Za-z0-9_.+#-]/.test(ch)) return 'latin';
  return 'other';
}

/** Expands [start, end) left and right over the run of the same script (a word-like unit). Hiragana counts as a word break and is not expanded into */
function expandToWord(chars: string[], start: number, end: number): [number, number] {
  let a = start;
  let b = end;
  const growable = (c: string | undefined, ref: Script) => !!c && scriptOf(c) === ref && ref !== 'hira' && ref !== 'other';
  if (a < chars.length) {
    const ref = scriptOf(chars[Math.min(a, chars.length - 1)]);
    while (a > 0 && growable(chars[a - 1], ref)) a--;
  }
  if (b > 0) {
    const ref = scriptOf(chars[b - 1]);
    while (b < chars.length && growable(chars[b], ref)) b++;
  }
  // Also keep compounds together, such as katakana or Latin right after kanji, or katakana right after Latin
  const word = (c: string | undefined) => !!c && ['kanji', 'kata', 'latin'].includes(scriptOf(c));
  while (a > 0 && a < chars.length && word(chars[a - 1]) && word(chars[a])) a--;
  while (b > 0 && b < chars.length && word(chars[b]) && word(chars[b - 1])) b++;
  return [a, b];
}

/** Whether a one-character match is inside a word (same script on both sides). If so, the diffs around it are joined into one hunk */
function insideWord(chars: string[], pos: number): boolean {
  const c = chars[pos];
  if (!c) return false;
  const s = scriptOf(c);
  return s !== 'other' && pos > 0 && scriptOf(chars[pos - 1]) === s && pos + 1 < chars.length && scriptOf(chars[pos + 1]) === s;
}

/** Similarity of two words (0 to 1). Compares both sound forms and characters, and uses the closer one */
function similarity(a: string, b: string): number {
  const sa = soundForm(a);
  const sb = soundForm(b);
  const sound = sa && sb ? 1 - editDistance(sa, sb) / Math.max(sa.length, sb.length) : 0;
  const ca = Array.from(a.normalize('NFKC').toLowerCase());
  const cb = Array.from(b.normalize('NFKC').toLowerCase());
  const chars = 1 - editDistance(ca, cb) / Math.max(ca.length, cb.length, 1);
  return Math.max(sound, chars);
}

/**
 * From the insertion side (ins) of a replacement hunk, picks the part that corresponds to the deleted characters (del). The rest counts as added text.
 * With left, the start may be cut off; with right, the end. Splits the insertion into runs of words (kanji, katakana, Latin), hiragana,
 * and symbols and whitespace, and picks the contiguous part closest to del. Returns [start, end) within ins.
 */
export function trimInsertion(del: string, ins: string[], left: boolean, right: boolean): [number, number] {
  const full: [number, number] = [0, ins.length];
  if (!left && !right) return full;
  type Tok = { s: number; e: number; cls: 'word' | 'hira' | 'other' };
  const toks: Tok[] = [];
  const cls = (c: string): Tok['cls'] => {
    const sc = scriptOf(c);
    return sc === 'hira' ? 'hira' : sc === 'other' ? 'other' : 'word';
  };
  for (let i = 0; i < ins.length; i++) {
    const c = cls(ins[i]);
    const last = toks[toks.length - 1];
    if (last && last.cls === c) last.e = i + 1;
    else toks.push({ s: i, e: i + 1, cls: c });
  }
  const content = toks.filter((t) => t.cls !== 'other');
  if (content.length <= 1 || toks.length > 40) return full;
  const firstIdx = toks.indexOf(content[0]);
  const lastIdx = toks.indexOf(content[content.length - 1]);
  let best = full;
  let bestSim = similarity(del, ins.join(''));
  for (let i = firstIdx; i <= lastIdx; i++) {
    if (toks[i].cls === 'other' || (!left && i !== firstIdx)) continue;
    for (let j = lastIdx; j >= i; j--) {
      if (toks[j].cls === 'other' || (!right && j !== lastIdx)) continue;
      const span: [number, number] = [toks[i].s, toks[j].e];
      const sim = similarity(del, ins.slice(span[0], span[1]).join(''));
      if (sim > bestSim + 1e-9) {
        best = span;
        bestSim = sim;
      }
    }
  }
  return bestSim >= 0.34 ? best : full;
}

const PUNCT_ONLY = /^[\s\p{P}\p{S}]*$/u;

/** Amount of change that counts as rewriting */
const MAX_HUNKS = 5;
const MAX_CHANGED_CHARS = 40;

/** Whether a Latin word's case carries meaning (iPhone, macOS, CPU and so on). Capitalizing the start of a sentence does not count */
export function hasDistinctiveCase(word: string): boolean {
  if (!/^[A-Za-z0-9 .+#&'_-]+$/.test(word)) return false;
  const letters = word.replace(/[^A-Za-z0-9]/g, '');
  return /[a-z][A-Z]/.test(word) || (/^[A-Z0-9]{2,}$/.test(letters) && /[A-Z]/.test(letters));
}

/** Whether it looks like a sentence or phrase rather than a word (long with hiragana, or containing a sentence break) */
function looksLikePhrase(s: string): boolean {
  if (/[。、！？!?\n]/.test(s)) return true;
  return /[぀-ゟ]/.test(s) && Array.from(s).length > 8;
}

interface Pair {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/**
 * Extracts word replacements from the original text and the corrected text (G4-04).
 * - With a single replacement hunk, it is a candidate regardless of text length (short utterances and single-word utterances are learned too)
 * - With too many hunks, too many changed characters, or two or more different replacements leaving little of the original, it counts as rewriting and nothing is returned
 * - Text only added before or after does not count
 */
export function extractReplacements(original: string, edited: string): Replacement[] {
  const set = buildPairs(original, edited);
  if (!set) return [];
  const { A, B, pairs: merged } = set;

  const out: Replacement[] = [];
  for (const p of merged) {
    const from = A.slice(p.a0, p.a1).join('').trim();
    const to = B.slice(p.b0, p.b1).join('').trim();
    if (!isRealChange(from, to)) continue;
    const toLen = Array.from(to).length;
    if (toLen < 2 || toLen > 40) continue;
    if (/^[぀-ゟ]+$/.test(to)) continue; // A hiragana-only word is of little use in the dictionary
    if (looksLikePhrase(to) || looksLikePhrase(from)) continue; // A rewrite of a sentence or phrase, not a word
    const ctxStart = Math.max(0, p.b0 - 40);
    const ctxEnd = Math.min(B.length, p.b1 + 40);
    out.push({ from, to, context: B.slice(ctxStart, ctxEnd).join('') });
  }
  // Drop duplicates of the same word (keep the first pair)
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = r.to.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Maximum length treated as a phrase rewrite (anything longer counts as rewriting a sentence) */
const MAX_REWRITE_CHARS = 24;

/**
 * Extracts phrase rewrites from the original text and the corrected text. Not limited to dictionary words: also picks up kana spellings and fixes to words with the same reading.
 * Used to find corrections that undo a formatter rewrite and mix-ups between words with the same reading.
 * - With a tokenizer, hunks are expanded to whole words (extracted as 「何か」→「なんか」, not 「何」→「なん」)
 * - Hunks separated by 2 characters or fewer are merged into one rewrite (「分からないので」→「わかんないんで」)
 * - The conditions for rewriting are the same as in extractReplacements
 */
export function extractRewrites(original: string, edited: string, tokenizer?: Tokenizer | null): Replacement[] {
  const set = buildPairs(original, edited, { tokenizer: tokenizer ?? null, mergeGap: 2 });
  if (!set) return [];
  const { A, B, pairs } = set;
  const out: Replacement[] = [];
  const seen = new Set<string>();
  for (const wide of pairs) {
    const p = trimCommonTokens(A, set.spansA, B, set.spansB, wide);
    const from = A.slice(p.a0, p.a1).join('').trim();
    const to = B.slice(p.b0, p.b1).join('').trim();
    if (!isRealChange(from, to)) continue;
    if (/[\n。！？!?]/.test(from + to)) continue;
    if (Array.from(from).length > MAX_REWRITE_CHARS || Array.from(to).length > MAX_REWRITE_CHARS) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      from,
      to,
      context: B.slice(Math.max(0, p.b0 - 40), Math.min(B.length, p.b1 + 40)).join(''),
      fromReading: rangeReading(set.spansA, p.a0, p.a1) ?? undefined,
      toReading: rangeReading(set.spansB, p.b0, p.b1) ?? undefined,
    });
  }
  return out;
}

/** Whether it is a real rewrite (excluding empty, identical, symbols only, full-width/half-width only, sentence-start capitalization only, and punctuation and whitespace only) */
function isRealChange(from: string, to: string): boolean {
  if (!from || !to || from === to) return false; // Pure additions and deletions are not used for learning from corrections
  if (PUNCT_ONLY.test(to) || PUNCT_ONLY.test(from)) return false;
  const nf = from.normalize('NFKC');
  const nt = to.normalize('NFKC');
  if (nf === nt) return false; // Only full-width/half-width differences
  if (nf.toLowerCase() === nt.toLowerCase() && !hasDistinctiveCase(nt)) return false; // Only case differences, such as sentence-start capitalization
  if (nf.replace(/\p{P}/gu, '').replace(/\s/g, '') === nt.replace(/\p{P}/gu, '').replace(/\s/g, '') && !/^[A-Za-z0-9]+$/.test(nt)) return false; // Only punctuation and whitespace differences
  if (nf.replace(/[\s\p{P}]/gu, '') === nt.replace(/[\s\p{P}]/gu, '') && /\p{P}/u.test(nf + nt)) return false;
  return true;
}

interface PairOptions {
  /** Tokenizer. If present, hunks are also expanded to whole words (morphemes) */
  tokenizer?: Tokenizer | null;
  /** Two pairs are merged when the match between them is this many characters or fewer */
  mergeGap?: number;
}

/** A word's range [start, end) (character positions) and its reading */
type Span = [number, number, string];

/** Word ranges in character (code point) positions. null if the tokenizer is unavailable */
function tokenSpans(text: string, tokenizer?: Tokenizer | null): Span[] | null {
  let tokens: { start: number; end: number; surface: string; reading: string }[] | null = null;
  try {
    tokens = tokenizer?.tokenize(text) ?? null;
  } catch {
    tokens = null;
  }
  if (!tokens?.length) return null;
  // Tokenizer positions are string indices (UTF-16), so convert them to code point positions
  const cp: number[] = [];
  let n = 0;
  for (let i = 0; i < text.length; n++) {
    const step = text.codePointAt(i)! > 0xffff ? 2 : 1;
    for (let k = 0; k < step; k++) cp[i + k] = n;
    i += step;
  }
  cp[text.length] = n;
  // Kanji words with unknown readings get an empty reading (ranges containing them have no known reading)
  return tokens.map((t) => [cp[t.start] ?? 0, cp[t.end] ?? n, t.reading || (hasKanji(t.surface) ? '' : hiraToKata(t.surface))]);
}

/** Reading of [start, end). null if the range does not align with word breaks, contains a word with an unknown reading, or the tokenizer is unavailable */
function rangeReading(spans: Span[] | null, start: number, end: number): string | null {
  if (!spans || end <= start) return null;
  let out = '';
  let covered = 0;
  for (const [s, e, reading] of spans) {
    if (e <= start || s >= end) continue;
    if (s < start || e > end || !reading) return null;
    out += reading;
    covered += e - s;
  }
  // Whitespace sometimes does not appear in the tokens, so it is enough for the words to cover most of the range
  return out && covered >= (end - start) * 0.8 ? out : null;
}

/**
 * Drops words that are the same in both texts from both ends of a pair (「期間システム」→「基幹システム」 becomes 「期間」→「基幹」).
 * Compares whole words, so the 「か」 in 「何か」→「なんか」 is not dropped (「なんか」 is one word).
 * Stops once either side is down to one word. Does not drop a word if only one character would remain (「3時」→「三時」 does not become 「3」→「三」).
 * Returns the pair unchanged if the tokenizer is unavailable.
 */
function trimCommonTokens(A: string[], spansA: Span[] | null, B: string[], spansB: Span[] | null, p: Pair): Pair {
  if (!spansA || !spansB) return p;
  const inside = (spans: Span[], s: number, e: number) => spans.filter(([ts, te]) => ts >= s && te <= e);
  const out = { ...p };
  for (;;) {
    const ta = inside(spansA, out.a0, out.a1);
    const tb = inside(spansB, out.b0, out.b1);
    if (ta.length < 2 || tb.length < 2) return out;
    const la = ta[ta.length - 1];
    const lb = tb[tb.length - 1];
    const fa = ta[0];
    const fb = tb[0];
    const surf = (chars: string[], t: Span) => chars.slice(t[0], t[1]).join('');
    const roomy = (a0: number, a1: number, b0: number, b1: number) => a1 - a0 >= 2 && b1 - b0 >= 2;
    if (la[1] === out.a1 && lb[1] === out.b1 && surf(A, la) === surf(B, lb) && roomy(out.a0, la[0], out.b0, lb[0])) {
      out.a1 = la[0];
      out.b1 = lb[0];
    } else if (fa[0] === out.a0 && fb[0] === out.b0 && surf(A, fa) === surf(B, fb) && roomy(fa[1], out.a1, fb[1], out.b1)) {
      out.a0 = fa[1];
      out.b0 = fb[1];
    } else {
      return out;
    }
  }
}

/** Expands [start, end) to the words it overlaps. Empty ranges (pure insertions or deletions) are not expanded */
function expandToTokens(spans: Span[] | null, start: number, end: number): [number, number] {
  if (!spans || end <= start) return [start, end];
  let a = start;
  let b = end;
  for (const [s, e] of spans) {
    if (e <= start || s >= end) continue;
    a = Math.min(a, s);
    b = Math.max(b, e);
  }
  return [a, b];
}

/**
 * Turns diff hunks into word-level pairs (shared by extractReplacements and extractRewrites).
 * null when it counts as rewriting or the diff could not be computed.
 */
function buildPairs(original: string, edited: string, opts: PairOptions = {}): { A: string[]; B: string[]; pairs: Pair[]; spansA: Span[] | null; spansB: Span[] | null } | null {
  const ops = charDiff(original, edited);
  if (!ops) return null;
  const A = Array.from(original);
  const B = Array.from(edited);

  // Collect hunks (adjacent del / ins) with positions. Diffs split up by a single matching character inside a word are joined
  type H = { ai: number; del: number; bi: number; ins: number; eqBefore: number; eqAfter: number };
  const hunks: H[] = [];
  let ai = 0;
  let bi = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const len = Array.from(op.text).length;
    if (op.kind === 'eq') {
      ai += len;
      bi += len;
      continue;
    }
    const h: H = { ai, del: 0, bi, ins: 0, eqBefore: 0, eqAfter: 0 };
    let kk = k;
    const take = () => {
      while (kk < ops.length && ops[kk].kind !== 'eq') {
        const l = Array.from(ops[kk].text).length;
        if (ops[kk].kind === 'del') h.del += l;
        else h.ins += l;
        kk++;
      }
    };
    take();
    while (kk + 1 < ops.length && ops[kk].kind === 'eq' && Array.from(ops[kk].text).length <= 1 && ops[kk + 1].kind !== 'eq' && insideWord(A, h.ai + h.del) && insideWord(B, h.bi + h.ins)) {
      h.del += 1;
      h.ins += 1;
      kk++;
      take();
    }
    k = kk - 1;
    ai = h.ai + h.del;
    bi = h.bi + h.ins;
    hunks.push(h);
  }
  // Lengths of the matches before and after each hunk (the limit when expanding to whole words)
  for (let i = 0; i < hunks.length; i++) {
    const end = hunks[i].ai + hunks[i].del;
    const nextStart = i + 1 < hunks.length ? hunks[i + 1].ai : A.length;
    hunks[i].eqAfter = nextStart - end;
    const prevEnd = i > 0 ? hunks[i - 1].ai + hunks[i - 1].del : 0;
    hunks[i].eqBefore = hunks[i].ai - prevEnd;
  }

  // If a replacement at the edge of the text carries added words or text, cut them off (「でーたどっぐ」→「Datadogで確認します」)
  let trimmed = 0;
  for (const h of hunks) {
    if (!h.del || !h.ins) continue;
    const left = h.ai === 0;
    const right = h.ai + h.del === A.length;
    if (!left && !right) continue;
    const [s0, s1] = trimInsertion(A.slice(h.ai, h.ai + h.del).join(''), B.slice(h.bi, h.bi + h.ins), left, right);
    trimmed += h.ins - (s1 - s0);
    h.bi += s0;
    h.ins = s1 - s0;
  }

  // Drop hunks that only add text before or after (pure insertions at the edge of the text)
  const core = hunks.filter((h, i) => {
    if (h.del > 0) return true;
    const atStart = i === 0 && h.ai === 0;
    const atEnd = i === hunks.length - 1 && h.ai === A.length;
    return !(atStart || atEnd);
  });
  if (!core.length) return null;

  // Whether it is rewriting
  const appended = hunks.filter((h) => !core.includes(h)).reduce((n, h) => n + h.ins, trimmed);
  const changed = core.reduce((n, h) => n + Math.max(h.del, h.ins), 0);
  if (core.length > MAX_HUNKS || changed > MAX_CHANGED_CHARS) return null;
  // Two or more different replacements leaving little of the original count as rewriting (repeats of the same fix count as one)
  const distinct = new Set(core.map((h) => `${A.slice(h.ai, h.ai + h.del).join('')}\u0000${B.slice(h.bi, h.bi + h.ins).join('')}`));
  if (distinct.size >= 2) {
    const kept = ops.filter((o) => o.kind === 'eq').reduce((n, o) => n + Array.from(o.text).length, 0);
    const longer = Math.max(A.length, B.length - appended, 1);
    if (kept / longer < 0.4) return null;
  }

  // Expand hunks to whole words. The matching part added by the expansion is included equally in the original and the corrected text (「Post Grace」→「Postgres」)
  const spansA = tokenSpans(original, opts.tokenizer);
  const spansB = tokenSpans(edited, opts.tokenizer);
  const grow = (chars: string[], spans: Span[] | null, start: number, end: number): [number, number] => {
    const [w0, w1] = expandToWord(chars, start, end);
    const [t0, t1] = expandToTokens(spans, start, end);
    return [Math.min(w0, t0), Math.max(w1, t1)];
  };
  const pairs: Pair[] = core.map((h) => {
    const [a0, a1] = grow(A, spansA, h.ai, h.ai + h.del);
    const [b0, b1] = grow(B, spansB, h.bi, h.bi + h.ins);
    const L = Math.min(h.eqBefore, Math.max(h.ai - a0, h.bi - b0));
    const R = Math.min(h.eqAfter, Math.max(a1 - (h.ai + h.del), b1 - (h.bi + h.ins)));
    return { a0: h.ai - L, a1: h.ai + h.del + R, b0: h.bi - L, b1: h.bi + h.ins + R };
  });
  // Merge pairs whose corrected ranges overlap (several hunks for the same word) into one (「Grow fauna」→「Grafana」)
  // With mergeGap, also merge pairs separated by a short match (the match between them has the same length in both texts)
  const gap = opts.mergeGap ?? 0;
  const merged: Pair[] = [];
  for (const p of pairs) {
    const last = merged[merged.length - 1];
    const between = last ? B.slice(last.b1, p.b0) : [];
    const joinable = !!last && between.length <= gap && p.a0 - last.a1 === between.length && between.every((ch) => scriptOf(ch) !== 'other');
    if (last && (p.b0 <= last.b1 || joinable)) {
      last.a1 = Math.max(last.a1, p.a1);
      last.b1 = Math.max(last.b1, p.b1);
    } else {
      merged.push({ ...p });
    }
  }

  return { A, B, pairs: merged, spansA, spansB };
}
