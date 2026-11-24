/**
 * Finds number notation preferences in a correction ("2つ" changed to "二つ", "10000円" to "1万円").
 *
 * The correction is split into changed spans, each span is widened to the whole number expression around it, and a kind
 * is recognized when converting the original span to one of its notations gives exactly the corrected span.
 * Spans that change the value, or need two kinds at once to explain, teach nothing.
 */
import { NUMBER_STYLE_KINDS, NUMBER_STYLE_VALUES, type NumberStyleKind } from '../../shared/numberStyle';
import { convertNumbers, QUANTITY_UNITS } from '../format/numberStyle';
import { diffHunks } from './diff';

export interface NumberStyleObservation {
  kind: NumberStyleKind;
  value: string;
  /** The number expression before and after the correction */
  before: string;
  after: string;
}

/** Characters that belong to a number expression */
const NUMBER_CHAR = /[0-9０-９〇一二三四五六七八九十百千万億兆,.:/，．：／¥￥$€£%％]/u;
/** Counters, units and date and time markers that a number expression may include */
const TOKENS = ['パーセント', ...QUANTITY_UNITS, 'つ', '時', '分', '半', '月', '日', '年'].sort((a, b) => b.length - a.length);
/** Longer spans are rewrites rather than notation changes */
const MAX_SPAN = 40;

const HAS_NUMBER = /[0-9０-９〇一二三四五六七八九]/u;

function tokenAt(chars: string[], pos: number): number {
  for (const t of TOKENS) {
    const n = Array.from(t).length;
    if (chars.slice(pos, pos + n).join('') === t) return n;
  }
  return 0;
}

function tokenEndingAt(chars: string[], pos: number): number {
  for (const t of TOKENS) {
    const n = Array.from(t).length;
    if (pos - n >= 0 && chars.slice(pos - n, pos).join('') === t) return n;
  }
  return 0;
}

function widenLeft(chars: string[], pos: number): number {
  while (pos > 0) {
    if (NUMBER_CHAR.test(chars[pos - 1])) {
      pos--;
      continue;
    }
    // A marker counts only between numbers ("10時30分"), not in a word before the number ("毎日")
    const n = tokenEndingAt(chars, pos);
    if (n && pos - n > 0 && NUMBER_CHAR.test(chars[pos - n - 1])) {
      pos -= n;
      continue;
    }
    break;
  }
  return pos;
}

function widenRight(chars: string[], pos: number): number {
  while (pos < chars.length) {
    if (NUMBER_CHAR.test(chars[pos])) {
      pos++;
      continue;
    }
    const n = tokenAt(chars, pos);
    if (!n) break;
    pos += n;
  }
  return pos;
}

/** The kinds and notations that explain the correction from before to after. At most one per kind */
export function detectNumberStyles(before: string, after: string): NumberStyleObservation[] {
  if (before === after || !HAS_NUMBER.test(before) || !HAS_NUMBER.test(after)) return [];
  const A = Array.from(before);
  const B = Array.from(after);
  const hunks = diffHunks(A, B, 400);
  if (!hunks?.length) return [];

  // Widen each changed span to the number expression around it, and merge spans that overlap
  const spans: { a0: number; a1: number; b0: number; b1: number }[] = [];
  for (const h of hunks) {
    const span = { a0: widenLeft(A, h.aStart), a1: widenRight(A, h.aEnd), b0: widenLeft(B, h.bStart), b1: widenRight(B, h.bEnd) };
    const last = spans[spans.length - 1];
    if (last && (span.a0 < last.a1 || span.b0 < last.b1)) {
      last.a0 = Math.min(last.a0, span.a0);
      last.a1 = Math.max(last.a1, span.a1);
      last.b0 = Math.min(last.b0, span.b0);
      last.b1 = Math.max(last.b1, span.b1);
    } else {
      spans.push(span);
    }
  }

  const found = new Map<NumberStyleKind, NumberStyleObservation | null>();
  for (const s of spans) {
    const a = A.slice(s.a0, s.a1).join('');
    const b = B.slice(s.b0, s.b1).join('');
    if (a === b || !HAS_NUMBER.test(a) || s.a1 - s.a0 > MAX_SPAN || s.b1 - s.b0 > MAX_SPAN) continue;
    for (const kind of NUMBER_STYLE_KINDS) {
      for (const value of NUMBER_STYLE_VALUES[kind]) {
        if (convertNumbers(a, kind, value, true) !== b) continue;
        const seen = found.get(kind);
        // Two spans asking for different notations of the same kind: learn neither
        if (seen === undefined) found.set(kind, { kind, value, before: a, after: b });
        else if (seen && seen.value !== value) found.set(kind, null);
      }
    }
  }
  return [...found.values()].filter((o): o is NumberStyleObservation => o !== null);
}

/** Whether a replacement pair is only a number notation change (so the other learners should ignore it) */
export function isNumberNotationChange(from: string, to: string): boolean {
  return detectNumberStyles(from, to).length > 0;
}
