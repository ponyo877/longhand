/**
 * Evaluation metrics (pure functions). Used from src/main/eval/run.ts.
 *
 * - Character error rate (content only, and with punctuation) and exact match
 * - Style violations (「！」, spaces between Japanese and Latin text, 「。」 after a trailing-off clause, bullets, single line breaks, a more formal tone, and so on. F-24)
 * - Whether the LLM's formatting broke or improved the utterance
 *
 * The breakdown by error type is in errorTypes.ts, and the comparison between runs is in bootstrap.ts.
 */

// ---------------------------------------------------------------------------
// Character error rate
// ---------------------------------------------------------------------------

export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Normalization for comparing content. Drops punctuation, symbols and whitespace, and folds full/half width and case */
export function normContent(s: string): string[] {
  return Array.from(
    s
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, ''),
  );
}

/** Normalization that includes presentation. Drops only whitespace */
export function normFull(s: string): string[] {
  return Array.from(s.normalize('NFKC').replace(/\s/g, ''));
}

export type Normalizer = (s: string) => string[];

/** Character edits and the reference length in characters (the overall error rate divides total by total) */
export interface Cer {
  edits: number;
  len: number;
}

export function cer(hyp: string, ref: string, norm: Normalizer): Cer {
  const r = norm(ref);
  return { edits: levenshtein(norm(hyp), r), len: r.length };
}

/**
 * Edit count when the reference has alternative spellings. Takes the smaller distance (the earlier one on a tie).
 * ref is the index of the chosen reference (0 is target)
 */
export function bestCer(hyp: string, refs: readonly string[], norm: Normalizer): Cer & { ref: number } {
  const h = norm(hyp);
  let best: (Cer & { ref: number }) | null = null;
  refs.forEach((ref, i) => {
    const r = norm(ref);
    const edits = levenshtein(h, r);
    if (!best || edits < best.edits) best = { edits, len: r.length, ref: i };
  });
  return best ?? { edits: h.length, len: 0, ref: 0 };
}

export function addCer(a: Cer, b: Cer): Cer {
  return { edits: a.edits + b.edits, len: a.len + b.len };
}

/** Error rate (0 or more). null if the reference is empty */
export function rate(c: Cer): number | null {
  return c.len ? c.edits / c.len : null;
}

export function pct(edits: number, len: number): string {
  return len ? `${((edits / len) * 100).toFixed(1)}%` : '-';
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// ---------------------------------------------------------------------------
// Exact match and style
// ---------------------------------------------------------------------------

/** Kana and kanji */
const JA = 'ぁ-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿々〆ヵヶ';
const JA_OR_PUNCT = `${JA}、。，．？！：；「」『』（）【】`;

/** Only surrounding whitespace and Unicode composition are normalized before comparing (full/half width and punctuation differences count as mismatches) */
export function exactMatch(hyp: string, ref: string): boolean {
  return hyp.trim().normalize('NFC') === ref.trim().normalize('NFC');
}

export function exactMatchRate(pairs: readonly { hyp: string; ref: string }[]): number {
  if (!pairs.length) return 0;
  return pairs.filter((p) => exactMatch(p.hyp, p.ref)).length / pairs.length;
}

/** Whether it exactly matches the reference or one of the alternatives */
export function exactMatchAny(hyp: string, refs: readonly string[]): boolean {
  return refs.some((r) => exactMatch(hyp, r));
}

export interface StyleViolations {
  /** 「！」 and 「!」 (not used unless asked for) */
  exclamation: number;
  /** Spaces between Japanese and Latin letters or digits */
  jaLatinSpace: number;
  /** Spaces between Japanese characters */
  jaSpace: number;
  /** Half-width 「? ! , .」 right after kana or kanji */
  halfWidthPunct: number;
  /** 「。」 at the end of a trailing-off clause such as 「〜けど。」 or 「〜ので。」 (counted per line end) */
  periodAfterConjunction: number;
  /** Bullet lines (lines starting with 「- 」, 「・」, 「* 」 or 「1. 」) */
  bullets: number;
  /** Markup such as headings and bold */
  markdown: number;
  /** A single line break that is not a blank line */
  singleNewline: number;
}

export const EMPTY_VIOLATIONS: StyleViolations = {
  exclamation: 0,
  jaLatinSpace: 0,
  jaSpace: 0,
  halfWidthPunct: 0,
  periodAfterConjunction: 0,
  bullets: 0,
  markdown: 0,
  singleNewline: 0,
};

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

export function styleViolations(text: string): StyleViolations {
  const t = text.replace(/\r\n?/g, '\n');
  return {
    exclamation: count(t, /[!！]/g),
    jaLatinSpace: count(t, new RegExp(`[${JA_OR_PUNCT}][ \\t]+(?=[A-Za-z0-9])`, 'gu')) + count(t, new RegExp(`[A-Za-z0-9][ \\t]+(?=[${JA_OR_PUNCT}])`, 'gu')),
    jaSpace: count(t, new RegExp(`[${JA_OR_PUNCT}][ \\t\\u3000]+(?=[${JA_OR_PUNCT}])`, 'gu')),
    halfWidthPunct: count(t, new RegExp(`[${JA}](?:[?!]|[,.](?=[ \\t]|$|[${JA}]))`, 'gmu')),
    periodAfterConjunction: count(t, /(けど|けれど|けれども|ので|んで|が)。[ \t]*$/gm),
    bullets: count(t, /^[ \t]*(?:[-*][ \t]+|[・•][ \t]*|\d+[.)][ \t]+)\S/gm),
    markdown: count(t, /\*\*[^*\n]+\*\*|^#{1,6}[ \t]/gm),
    singleNewline: count(t, /(?<!\n)\n(?!\n)/g),
  };
}

export function addViolations(a: StyleViolations, b: StyleViolations): StyleViolations {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof StyleViolations)[]) out[k] += b[k];
  return out;
}

export function totalViolations(v: StyleViolations): number {
  return Object.values(v).reduce((n, x) => n + x, 0);
}

/** Formal phrasing. If the output has more of it than the raw text, the tone was made more formal */
const FORMAL = /(いたします|いただけますでしょうか|でしょうか|ございます|ですが、|おります)/g;

/** How many more formal phrases the output has than the raw text (F-03) */
export function toneShift(raw: string, out: string): number {
  return Math.max(0, count(out, FORMAL) - count(raw, FORMAL));
}

/** For a one-line display. Omits items that are 0 */
export function formatViolations(v: StyleViolations): string {
  const labels: Record<keyof StyleViolations, string> = {
    exclamation: 'exclamation',
    jaLatinSpace: 'Japanese-Latin space',
    jaSpace: 'space in Japanese',
    halfWidthPunct: 'half-width punctuation',
    periodAfterConjunction: 'period after trailing-off clause',
    bullets: 'bullets',
    markdown: 'markup',
    singleNewline: 'single line break',
  };
  const parts = (Object.keys(labels) as (keyof StyleViolations)[]).filter((k) => v[k] > 0).map((k) => `${labels[k]} ${v[k]}`);
  return parts.length ? parts.join(', ') : 'none';
}

// ---------------------------------------------------------------------------
// Latin words
// ---------------------------------------------------------------------------

const LATIN_WORD = /[A-Za-z][A-Za-z0-9]+/g;

/** How many Latin words (2 or more letters) in the reference also appear in the output. A rough guide to how product names and technical terms are written, even without a dictionary */
export function latinWordRecall(reference: string, output: string): { hit: number; total: number } {
  const out = normContent(output).join('');
  const words = reference.normalize('NFKC').match(LATIN_WORD) ?? [];
  return { hit: words.filter((w) => out.includes(w.toLowerCase())).length, total: words.length };
}

// ---------------------------------------------------------------------------
// Effect of the LLM's formatting
// ---------------------------------------------------------------------------

/** Content edits per utterance before formatting (final without the LLM) and after (final with the LLM) */
export interface BeforeAfter {
  before: number;
  after: number;
}

export interface LlmEffect {
  /** Utterances whose content was correct before formatting */
  clean: number;
  /** Of those, utterances with errors after formatting (broken) */
  broke: number;
  /** Utterances with errors before formatting */
  errored: number;
  /** Of those, utterances with fewer errors after formatting (improved) */
  improved: number;
  /** Of those, utterances with more errors */
  worsened: number;
  /** Of those, utterances with no errors left */
  fixed: number;
}

export function llmEffect(pairs: readonly BeforeAfter[]): LlmEffect {
  const e: LlmEffect = { clean: 0, broke: 0, errored: 0, improved: 0, worsened: 0, fixed: 0 };
  for (const p of pairs) {
    if (p.before === 0) {
      e.clean++;
      if (p.after > 0) e.broke++;
    } else {
      e.errored++;
      if (p.after < p.before) e.improved++;
      if (p.after > p.before) e.worsened++;
      if (p.after === 0) e.fixed++;
    }
  }
  return e;
}
