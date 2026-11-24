/**
 * 評価の指標（純粋関数）。src/main/eval/run.ts から使う。
 *
 * - 文字誤り率（中身だけ、句読点込み）と完全一致
 * - 文体の違反数（「！」、和英間の空白、言いさしの「。」、箇条書き、1 行だけの改行、口調の硬化など。F-24）
 * - LLM の整形が、発話を壊したか良くしたか
 *
 * 誤りの種類の内訳は errorTypes.ts、実行どうしの比較は bootstrap.ts にある。
 */

// ---------------------------------------------------------------------------
// 文字誤り率
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

/** 中身の一致を見るための正規化。句読点、記号、空白を落とし、全角半角と大文字小文字をそろえる */
export function normContent(s: string): string[] {
  return Array.from(
    s
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, ''),
  );
}

/** 体裁まで含めて見るための正規化。空白だけ落とす */
export function normFull(s: string): string[] {
  return Array.from(s.normalize('NFKC').replace(/\s/g, ''));
}

export type Normalizer = (s: string) => string[];

/** 文字誤り数と参照の文字数（全体の誤り率は合計どうしで割る） */
export interface Cer {
  edits: number;
  len: number;
}

export function cer(hyp: string, ref: string, norm: Normalizer): Cer {
  const r = norm(ref);
  return { edits: levenshtein(norm(hyp), r), len: r.length };
}

/**
 * 正解に表記ゆれの別解があるときの誤り数。距離の小さいほうを採る（同じなら先のもの）。
 * ref は採った正解の番号（0 が target）
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

/** 誤り率（0〜）。参照が空なら null */
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
// 完全一致と文体
// ---------------------------------------------------------------------------

/** かなと漢字 */
const JA = 'ぁ-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿々〆ヵヶ';
const JA_OR_PUNCT = `${JA}、。，．？！：；「」『』（）【】`;

/** 比較の前に揃えるのは、前後の空白と Unicode の合成だけ（全角半角や句読点の違いは不一致として数える） */
export function exactMatch(hyp: string, ref: string): boolean {
  return hyp.trim().normalize('NFC') === ref.trim().normalize('NFC');
}

export function exactMatchRate(pairs: readonly { hyp: string; ref: string }[]): number {
  if (!pairs.length) return 0;
  return pairs.filter((p) => exactMatch(p.hyp, p.ref)).length / pairs.length;
}

/** 正解か別解のどれかと完全に一致するか */
export function exactMatchAny(hyp: string, refs: readonly string[]): boolean {
  return refs.some((r) => exactMatch(hyp, r));
}

export interface StyleViolations {
  /** 「！」と「!」（指示されない限り使わない） */
  exclamation: number;
  /** 日本語と英数字の間の空白 */
  jaLatinSpace: number;
  /** 日本語の文字どうしの間の空白 */
  jaSpace: number;
  /** かなや漢字の直後の半角の「? ! , .」 */
  halfWidthPunct: number;
  /** 「〜けど。」「〜ので。」のように、言いさしの末尾に付いた「。」（行末ごとに数える） */
  periodAfterConjunction: number;
  /** 箇条書きの行（「- 」「・」「* 」「1. 」で始まる行） */
  bullets: number;
  /** 見出しや太字などの記法 */
  markdown: number;
  /** 空行でない、1 行だけの改行 */
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

/** 改まった言い方。生テキストに無いのに出力に増えていたら、口調を硬くしたとみなす */
const FORMAL = /(いたします|いただけますでしょうか|でしょうか|ございます|ですが、|おります)/g;

/** 生テキストに比べて増えた改まった言い方の数（F-03） */
export function toneShift(raw: string, out: string): number {
  return Math.max(0, count(out, FORMAL) - count(raw, FORMAL));
}

/** 1 行の表示用。0 の項目は省く */
export function formatViolations(v: StyleViolations): string {
  const labels: Record<keyof StyleViolations, string> = {
    exclamation: '「！」',
    jaLatinSpace: '和英間の空白',
    jaSpace: '和文の空白',
    halfWidthPunct: '半角の句読点',
    periodAfterConjunction: '言いさしの「。」',
    bullets: '箇条書き',
    markdown: '記法',
    singleNewline: '1 行の改行',
  };
  const parts = (Object.keys(labels) as (keyof StyleViolations)[]).filter((k) => v[k] > 0).map((k) => `${labels[k]} ${v[k]}`);
  return parts.length ? parts.join('、') : 'なし';
}

// ---------------------------------------------------------------------------
// 英字の語
// ---------------------------------------------------------------------------

const LATIN_WORD = /[A-Za-z][A-Za-z0-9]+/g;

/** 正解に出る英字の語（2 字以上）のうち、出力にも出た数。辞書がなくても、製品名や技術用語の書け方の目安になる */
export function latinWordRecall(reference: string, output: string): { hit: number; total: number } {
  const out = normContent(output).join('');
  const words = reference.normalize('NFKC').match(LATIN_WORD) ?? [];
  return { hit: words.filter((w) => out.includes(w.toLowerCase())).length, total: words.length };
}

// ---------------------------------------------------------------------------
// LLM の整形の効き目
// ---------------------------------------------------------------------------

/** 発話ごとの、整形の前（LLM なしの最終）と後（LLM ありの最終）の中身の誤り数 */
export interface BeforeAfter {
  before: number;
  after: number;
}

export interface LlmEffect {
  /** 整形の前に中身が正しかった発話 */
  clean: number;
  /** そのうち、整形の後に誤りができた発話（壊した） */
  broke: number;
  /** 整形の前に誤りがあった発話 */
  errored: number;
  /** そのうち、整形の後に誤りが減った発話（良くした） */
  improved: number;
  /** そのうち、誤りが増えた発話 */
  worsened: number;
  /** そのうち、誤りがなくなった発話 */
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
