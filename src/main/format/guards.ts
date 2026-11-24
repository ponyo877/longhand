/**
 * Checks the LLM's formatting output against the text before formatting.
 *
 * An LLM that corrects from the text alone sometimes rewrites a transcript that was already right.
 * So the diff between the text before formatting (after textfix and normalization) and the output is classified hunk by hunk
 * to find rewrites with no support anywhere and changes in numbers or negation.
 *
 * Hunk kinds:
 * - form:        differences only in punctuation, whitespace, full-width/half-width, or case
 * - filler:      removed fillers
 * - repair:      removed first half of a self-repair, or a repeated false start
 * - number:      differences only in how a number is written (same value)
 * - evidence:    replacement with a word from the dictionary, candidates or alternatives
 * - sound:       replacement that sounds alike (katakana to Latin letters, for example)
 * - reading:     replacement with the same reading (kanji and kana, kanji with the same reading)
 * - particle:    insertion, removal or swap of a one-character particle
 * - unsupported: none of the above (no support)
 *
 * Pure functions with no network or file access. The tokenizer (readings) is used only when passed in.
 * The idea of checking the output comes from the formatting checks in Hex (anomalyco/hex), an MIT-licensed dictation app (no code was copied).
 */
import { charDiff } from '../learn/diff';
import type { Tokenizer, Token } from '../textfix/types';
import { hiraToKata, soundsSimilar } from '../vocab/kana';
import { expandRunRange } from '../vocab/scriptRuns';
import { FILLER_IN_TEXT, SELF_REPAIR } from './fastPath';
import { FILLERS, normalizeForCompare } from './postprocess';

export type HunkKind = 'form' | 'filler' | 'repair' | 'number' | 'evidence' | 'sound' | 'reading' | 'particle' | 'unsupported';

export const HUNK_KINDS: readonly HunkKind[] = ['form', 'filler', 'repair', 'number', 'evidence', 'sound', 'reading', 'particle', 'unsupported'];

/** One diff hunk. [start, end) before formatting became [outStart, outEnd) in the output */
export interface GuardHunk {
  kind: HunkKind;
  before: string;
  after: string;
  start: number;
  end: number;
  outStart: number;
  outEnd: number;
}

export type GuardCheck = 'number' | 'negation' | 'added' | 'removed' | 'provenance' | 'length' | 'reply';

export interface GuardViolation {
  check: GuardCheck;
  /** Numbers only, such as counts and lengths (no text, so it is safe to log) */
  detail: string;
}

export interface GuardReport {
  hunks: GuardHunk[];
  counts: Record<HunkKind, number>;
  violations: GuardViolation[];
  /** The output with only the unsupported hunks reverted to the text before formatting. The output unchanged if there are none */
  repaired: string;
}

export interface GuardOptions {
  /** Words that support a replacement (dictionary words, match candidates, recognition alternatives) */
  evidence?: readonly string[];
  /** Tokenizer. Used to detect replacements with the same reading. That check is skipped without it */
  tokenizer?: Tokenizer | null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const KANJI_DIGIT: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const SMALL_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const BIG_UNIT: Record<string, number> = { 万: 10_000, 億: 100_000_000 };
/** When kanji numerals are read as numbers: only when a counter follows (so words like 「一緒」 and 「一般」 are not numbers) */
const COUNTER_AFTER = /^(?:時|分|秒|日|月|年|回|個|件|人|円|%|つ|階|号|台|本|枚|冊|歳|才|倍|割|点|位|週|か月|ヶ月|カ月|箇月|名|社|行|列|章|話|ページ|度目|番目|番線)/;
const NUMERAL_RUN = /(?:\d+(?:[.,]\d+)*|[〇一二三四五六七八九十百千万億])+/g;

/** Parses a run mixing Arabic and kanji numerals (「3万」, 「一万二千」, 「二〇二六」, 「3,980」) into a number. null if it cannot be read */
export function parseJaNumber(run: string): number | null {
  const parts = run.match(/\d+(?:[.,]\d+)*|[〇一二三四五六七八九十百千万億]/g);
  if (!parts || parts.join('') !== run) return null;
  let total = 0;
  let section = 0;
  let current: number | null = null;
  let positional = false;
  for (const p of parts) {
    if (/^\d/.test(p)) {
      const n = Number(p.replace(/,/g, ''));
      if (!Number.isFinite(n) || current !== null) return null;
      current = n;
      positional = false;
    } else if (p in KANJI_DIGIT) {
      // Kanji numerals written positionally, as in 「二〇二六」
      if (current !== null && !positional) return null;
      current = current === null ? KANJI_DIGIT[p] : current * 10 + KANJI_DIGIT[p];
      positional = true;
    } else if (p in SMALL_UNIT) {
      section += (current ?? 1) * SMALL_UNIT[p];
      current = null;
      positional = false;
    } else {
      const value = section + (current ?? 0);
      total += (value || 1) * BIG_UNIT[p];
      section = 0;
      current = null;
      positional = false;
    }
  }
  return total + section + (current ?? 0);
}

/** Makes full-width digits and separators half-width without changing the length (no NFKC, so positions do not shift) */
function halfWidthDigits(text: string): string {
  return text.replace(/[０-９，．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** Position and value of a number in the text */
interface NumeralSpan {
  start: number;
  end: number;
  value: string;
}

/**
 * Extracts the numbers in the text in a form independent of notation (「十時」 and 「10時」 are both "10").
 * Version numbers and decimals are compared as written ("2.4.1", "12.5").
 */
function numeralSpans(text: string): NumeralSpan[] {
  const s = halfWidthDigits(text);
  const out: NumeralSpan[] = [];
  for (const m of s.matchAll(NUMERAL_RUN)) {
    const run = m[0];
    const span = { start: m.index, end: m.index + run.length };
    if (!/[〇一二三四五六七八九十百千万億]/.test(run)) {
      // Remove only thousands separators. Runs like 「2.4.1」 stay as they are
      out.push({ ...span, value: /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(run) ? run.replace(/,/g, '') : run });
      continue;
    }
    // A run of kanji numerals only counts as a number when a counter follows
    if (!/\d/.test(run) && !COUNTER_AFTER.test(s.slice(span.end))) continue;
    const n = parseJaNumber(run);
    if (n !== null) out.push({ ...span, value: String(n) });
  }
  return out;
}

export function numbersOf(text: string): string[] {
  return numeralSpans(text).map((n) => n.value);
}

function multisetDiff(a: readonly string[], b: readonly string[]): { added: string[]; dropped: string[] } {
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  const added: string[] = [];
  for (const x of b) {
    const n = count.get(x) ?? 0;
    if (n > 0) count.set(x, n - 1);
    else added.push(x);
  }
  const dropped: string[] = [];
  for (const [x, n] of count) for (let i = 0; i < n; i++) dropped.push(x);
  return { added, dropped };
}

// ---------------------------------------------------------------------------
// Negation, fillers, self-repair, reply-likeness
// ---------------------------------------------------------------------------

const NEGATION = /ない|なかっ|なく(?=[てな、。]|$)|ません|(?<=[ぁ-ん一-鿿])ず(?=に|、|。|$)/g;

/** Number of negative expressions. Counted the same way before and after, and only the difference matters (「少ない」 and the like are counted too, but cancel out when unchanged) */
export function negationCount(text: string): number {
  return (text.match(NEGATION) ?? []).length;
}

const PARTICLE = /^(?:は|が|を|に|へ|で|と|も|の|って|とか)$/;
const SEPARATORS = /[\s、。，．,.!?！？…・「」『』（）()]+/u;

function isFillerOnly(text: string): boolean {
  const pieces = text.split(SEPARATORS).filter(Boolean);
  return pieces.length > 0 && pieces.every((p) => FILLERS.test(p) || /^(?:えーと|ええと|えと|あのね|んー+|うーむ)$/.test(p));
}

/** Openings seen when the formatting turned into a reply */
const REPLY_OPENING =
  /^(?:はい、?(?:承知|かしこまり|了解|わかり|分かり)|承知(?:いた)?しました|かしこまりました|もちろんです|以下(?:の|が|に|は)|こちらが|申し訳(?:ありません|ございません)が|お手伝い|sure[,!. ]|here(?:'s| is| are)|certainly|of course|i (?:can|will|am|cannot|can't)|as an ai)/i;

// ---------------------------------------------------------------------------
// Word ranges and readings
// ---------------------------------------------------------------------------

/** Expands a hunk over the surrounding run of the same script (Latin, katakana, kanji), so that a change to part of a word is compared as the whole word */
function expandRun(text: string, start: number, end: number): string {
  if (start >= end) return '';
  const [s, e] = expandRunRange(text, start, end);
  return text.slice(s, e);
}

const readingOf = (t: Token) => t.reading || hiraToKata(t.surface);

/** Returns the joined readings of the tokens overlapping the range */
function rangeReading(tokens: readonly Token[], start: number, end: number): string | null {
  const hit = tokens.filter((t) => t.end > start && t.start < end);
  if (!hit.length) return null;
  return hit.map(readingOf).join('');
}

const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RawHunk {
  before: string;
  after: string;
  start: number;
  end: number;
  outStart: number;
  outEnd: number;
}

function hunksOf(before: string, after: string): RawHunk[] | null {
  const ops = charDiff(before, after);
  if (!ops) return null;
  const out: RawHunk[] = [];
  let a = 0;
  let b = 0;
  let cur: RawHunk | null = null;
  for (const op of ops) {
    if (op.kind === 'eq') {
      if (cur) out.push(cur);
      cur = null;
      a += op.text.length;
      b += op.text.length;
      continue;
    }
    cur ??= { before: '', after: '', start: a, end: a, outStart: b, outEnd: b };
    if (op.kind === 'del') {
      cur.before += op.text;
      a += op.text.length;
      cur.end = a;
    } else {
      cur.after += op.text;
      b += op.text.length;
      cur.outEnd = b;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Compares the text before formatting with the output and returns the hunk classification and the problems found */
export function inspectFormatting(before: string, after: string, opts: GuardOptions = {}): GuardReport {
  const counts = Object.fromEntries(HUNK_KINDS.map((k) => [k, 0])) as Record<HunkKind, number>;
  const violations: GuardViolation[] = [];
  const beforeLen = normalizeForCompare(before).length;
  const afterLen = normalizeForCompare(after).length;
  const hasRepairCue = SELF_REPAIR.test(before);

  const raw = hunksOf(before, after);
  const evidence = new Set((opts.evidence ?? []).map(key).filter(Boolean));
  const afterKey = key(after);
  const tokensBefore = raw?.length ? (opts.tokenizer?.tokenize(before) ?? null) : null;
  const tokensAfter = raw?.length ? (opts.tokenizer?.tokenize(after) ?? null) : null;
  // If the whole text reads the same, every replacement is a difference in notation only
  const spansBefore = numeralSpans(before);
  const spansAfter = numeralSpans(after);
  const sameReadingOverall = !!tokensBefore && !!tokensAfter && normalizeForCompare(tokensBefore.map(readingOf).join('')) === normalizeForCompare(tokensAfter.map(readingOf).join(''));

  const classify = (h: RawHunk): HunkKind => {
    if (normalizeForCompare(h.before) === normalizeForCompare(h.after)) return 'form';
    const del = h.before;
    const ins = h.after;
    if (!normalizeForCompare(ins)) {
      if (isFillerOnly(del) || (FILLER_IN_TEXT.test(del) && normalizeForCompare(del.replace(new RegExp(FILLER_IN_TEXT.source, 'gi'), '')).length === 0)) return 'filler';
      if (SELF_REPAIR.test(del)) return 'repair';
      // A repeated false start (one of 「これは、これは」 removed)
      const content = normalizeForCompare(del);
      if (content.length >= 2 && (normalizeForCompare(before.slice(h.end)).startsWith(content) || normalizeForCompare(before.slice(0, h.start)).endsWith(content))) return 'repair';
      // Removed the part right before a self-repair cue (「3時」 in 「3時、いや4時」)
      if (SELF_REPAIR.test(before.slice(h.end, h.end + 8))) return 'repair';
      if (PARTICLE.test(del.trim())) return 'particle';
      return 'unsupported';
    }
    if (!normalizeForCompare(del)) return PARTICLE.test(ins.trim()) ? 'particle' : 'unsupported';

    // Number notation only: the numbers overlapping the hunk keep their values and the other characters are unchanged (「3時」 did not become 「3人」)
    const nb = spansBefore.filter((n) => n.end > h.start && n.start < h.end);
    const na = spansAfter.filter((n) => n.end > h.outStart && n.start < h.outEnd);
    if (nb.length && nb.length === na.length && nb.every((x, i) => x.value === na[i].value)) {
      const rest = (text: string) => normalizeForCompare(halfWidthDigits(text).replace(NUMERAL_RUN, ''));
      if (rest(del) === rest(ins)) return 'number';
    }
    const wordBefore = expandRun(before, h.start, h.end);
    const wordAfter = expandRun(after, h.outStart, h.outEnd);
    const wa = key(wordAfter);
    if (wa && (evidence.has(wa) || [...evidence].some((e) => e.length > wa.length && e.includes(wa) && afterKey.includes(e)))) return 'evidence';
    if (soundsSimilar(wordBefore, wordAfter)) return 'sound';
    if (sameReadingOverall) return 'reading';
    if (tokensBefore && tokensAfter) {
      const rb = rangeReading(tokensBefore, h.start, h.end);
      const ra = rangeReading(tokensAfter, h.outStart, h.outEnd);
      if (rb && ra && rb === ra) return 'reading';
    }
    if (PARTICLE.test(del.trim()) && PARTICLE.test(ins.trim())) return 'particle';
    return 'unsupported';
  };

  const hunks: GuardHunk[] = (raw ?? []).map((h) => ({ kind: classify(h), ...h }));
  for (const h of hunks) counts[h.kind]++;

  // Numbers: the output must not have numbers absent before formatting. Numbers may drop only with a self-repair
  const nums = multisetDiff(numbersOf(before), numbersOf(after));
  if (nums.added.length || (nums.dropped.length && !hasRepairCue)) {
    violations.push({ check: 'number', detail: `numbers added ${nums.added.length}, numbers dropped ${nums.dropped.length}` });
  }
  // Negation: the count may change only with a self-repair
  const neg = negationCount(after) - negationCount(before);
  if (neg !== 0 && !hasRepairCue) violations.push({ check: 'negation', detail: `negation count change ${neg}` });

  const allowance = Math.max(2, Math.ceil(beforeLen / 4));
  const unsupported = hunks.filter((h) => h.kind === 'unsupported');
  const added = unsupported.reduce((n, h) => n + normalizeForCompare(h.after).length, 0);
  const removed = unsupported.reduce((n, h) => n + normalizeForCompare(h.before).length, 0);
  if (added > allowance) violations.push({ check: 'added', detail: `unsupported characters added ${added} (limit ${allowance})` });
  if (removed > allowance) violations.push({ check: 'removed', detail: `unsupported characters removed ${removed} (limit ${allowance})` });

  // At least half of the output must come from the text before formatting or from supported replacements
  if (raw && afterLen >= 8 && 1 - added / afterLen < 0.5) {
    violations.push({ check: 'provenance', detail: `share from the text before formatting ${(1 - added / afterLen).toFixed(2)}` });
  }
  if (afterLen > beforeLen * 1.5 + 16) violations.push({ check: 'length', detail: `length ${beforeLen} → ${afterLen}` });
  const opening = REPLY_OPENING.exec(after.trim());
  if (opening && !key(before).startsWith(key(opening[0]))) violations.push({ check: 'reply', detail: 'opening looks like a reply' });

  // Revert only the unsupported hunks to the text before formatting
  let repaired = after;
  if (unsupported.length) {
    let out = '';
    let at = 0;
    for (const h of hunks) {
      out += after.slice(at, h.outStart) + (h.kind === 'unsupported' ? h.before : h.after);
      at = h.outEnd;
    }
    repaired = out + after.slice(at);
  }
  return { hunks, counts, violations, repaired };
}
