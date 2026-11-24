/**
 * LLM の整形の出力を、整形前の文と比べて調べる。
 *
 * テキストだけを見て直す LLM は、もともと正しい書き起こしを書き換えてしまうことがある。
 * そこで、整形前の文（textfix の後、正規化の後）と出力の差分を塊ごとに分類し、
 * 「どこにも根拠のない書き換え」と「数字や否定の変化」を見つける。
 *
 * 塊の分類:
 * - form:        句読点、空白、全角と半角、大文字と小文字だけの違い
 * - filler:      つなぎ言葉の削除
 * - repair:      言い直しの前半、または言いかけの繰り返しの削除
 * - number:      数の表記だけの違い（値は同じ）
 * - evidence:    辞書、候補、別候補にある語への置き換え
 * - sound:       音が近い置き換え（カタカナを英字に、など）
 * - reading:     読みが同じ置き換え（漢字とかな、同じ読みの漢字）
 * - particle:    助詞 1 字の挿入、削除、入れ替え
 * - unsupported: どれにも当たらない（根拠なし）
 *
 * 通信もファイルの読み書きもしない純粋な関数。単語分割（読み）は、渡されたときだけ使う。
 * 出力の検査の考え方は、MIT ライセンスの音声入力アプリ Hex（anomalyco/hex）の整形の検査を参考にした（コードは写していない）。
 */
import { charDiff } from '../learn/diff';
import type { Tokenizer, Token } from '../textfix/types';
import { hiraToKata, soundsSimilar } from '../vocab/kana';
import { expandRunRange } from '../vocab/scriptRuns';
import { FILLER_IN_TEXT, SELF_REPAIR } from './fastPath';
import { FILLERS, normalizeForCompare } from './postprocess';

export type HunkKind = 'form' | 'filler' | 'repair' | 'number' | 'evidence' | 'sound' | 'reading' | 'particle' | 'unsupported';

export const HUNK_KINDS: readonly HunkKind[] = ['form', 'filler', 'repair', 'number', 'evidence', 'sound', 'reading', 'particle', 'unsupported'];

/** 差分の 1 塊。整形前の [start, end) が、出力の [outStart, outEnd) に変わった */
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
  /** 件数や長さなどの数値だけを書く（本文は入れない。ログに出してよい形にする） */
  detail: string;
}

export interface GuardReport {
  hunks: GuardHunk[];
  counts: Record<HunkKind, number>;
  violations: GuardViolation[];
  /** 根拠のない塊だけを整形前の文に戻した出力。根拠のない塊がなければ出力のまま */
  repaired: string;
}

export interface GuardOptions {
  /** 置き換えの根拠になる語（辞書の語、照合の候補、音声認識の別候補） */
  evidence?: readonly string[];
  /** 単語分割。読みが同じ置き換えの判定に使う。なければその判定を飛ばす */
  tokenizer?: Tokenizer | null;
}

// ---------------------------------------------------------------------------
// 数
// ---------------------------------------------------------------------------

const KANJI_DIGIT: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const SMALL_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const BIG_UNIT: Record<string, number> = { 万: 10_000, 億: 100_000_000 };
/** 漢数字を数として読む条件。後ろに数える言葉が続くときだけ（「一緒」「一般」などの語を数にしない） */
const COUNTER_AFTER = /^(?:時|分|秒|日|月|年|回|個|件|人|円|%|つ|階|号|台|本|枚|冊|歳|才|倍|割|点|位|週|か月|ヶ月|カ月|箇月|名|社|行|列|章|話|ページ|度目|番目|番線)/;
const NUMERAL_RUN = /(?:\d+(?:[.,]\d+)*|[〇一二三四五六七八九十百千万億])+/g;

/** 算用数字と漢数字の混ざった並び（「3万」「一万二千」「二〇二六」「3,980」）を数にする。読めなければ null */
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
      // 「二〇二六」のように位取りで並べた漢数字
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

/** 全角の数字と区切りを、字数を変えずに半角にする（位置をずらさないため、NFKC は使わない） */
function halfWidthDigits(text: string): string {
  return text.replace(/[０-９，．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 文の中の数の位置と値 */
interface NumeralSpan {
  start: number;
  end: number;
  value: string;
}

/**
 * 文の中の数を、表記によらない形で取り出す（「十時」「10時」はどちらも "10"）。
 * 版の番号や小数は、そのままの文字列で比べる（"2.4.1"、"12.5"）。
 */
function numeralSpans(text: string): NumeralSpan[] {
  const s = halfWidthDigits(text);
  const out: NumeralSpan[] = [];
  for (const m of s.matchAll(NUMERAL_RUN)) {
    const run = m[0];
    const span = { start: m.index, end: m.index + run.length };
    if (!/[〇一二三四五六七八九十百千万億]/.test(run)) {
      // 桁区切りのコンマだけを外す。「2.4.1」のような並びはそのまま
      out.push({ ...span, value: /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(run) ? run.replace(/,/g, '') : run });
      continue;
    }
    // 漢数字だけの並びは、後ろに数える言葉があるときだけ数とみなす
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
// 否定、つなぎ言葉、言い直し、返答らしさ
// ---------------------------------------------------------------------------

const NEGATION = /ない|なかっ|なく(?=[てな、。]|$)|ません|(?<=[ぁ-ん一-鿿])ず(?=に|、|。|$)/g;

/** 否定の表現の数。前後で同じ数え方をして、差だけを見る（「少ない」なども数えるが、前後で同じなら打ち消し合う） */
export function negationCount(text: string): number {
  return (text.match(NEGATION) ?? []).length;
}

const PARTICLE = /^(?:は|が|を|に|へ|で|と|も|の|って|とか)$/;
const SEPARATORS = /[\s、。，．,.!?！？…・「」『』（）()]+/u;

function isFillerOnly(text: string): boolean {
  const pieces = text.split(SEPARATORS).filter(Boolean);
  return pieces.length > 0 && pieces.every((p) => FILLERS.test(p) || /^(?:えーと|ええと|えと|あのね|んー+|うーむ)$/.test(p));
}

/** 整形が応答になったときの書き出し */
const REPLY_OPENING =
  /^(?:はい、?(?:承知|かしこまり|了解|わかり|分かり)|承知(?:いた)?しました|かしこまりました|もちろんです|以下(?:の|が|に|は)|こちらが|申し訳(?:ありません|ございません)が|お手伝い|sure[,!. ]|here(?:'s| is| are)|certainly|of course|i (?:can|will|am|cannot|can't)|as an ai)/i;

// ---------------------------------------------------------------------------
// 語の範囲と読み
// ---------------------------------------------------------------------------

/** 塊を、同じ種類の字（英字、カタカナ、漢字）が続く範囲まで広げる。語の一部だけが変わったときに、語の全体で比べるため */
function expandRun(text: string, start: number, end: number): string {
  if (start >= end) return '';
  const [s, e] = expandRunRange(text, start, end);
  return text.slice(s, e);
}

const readingOf = (t: Token) => t.reading || hiraToKata(t.surface);

/** 範囲に重なる語の読みをつないで返す */
function rangeReading(tokens: readonly Token[], start: number, end: number): string | null {
  const hit = tokens.filter((t) => t.end > start && t.start < end);
  if (!hit.length) return null;
  return hit.map(readingOf).join('');
}

const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

// ---------------------------------------------------------------------------
// 本体
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

/** 整形前の文と出力を比べて、差分の分類と、見つかった問題を返す */
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
  // 文の全体で読みが同じなら、置き換えはどれも表記だけの違い
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
      // 言いかけの繰り返し（「これは、これは」の片方を消した）
      const content = normalizeForCompare(del);
      if (content.length >= 2 && (normalizeForCompare(before.slice(h.end)).startsWith(content) || normalizeForCompare(before.slice(0, h.start)).endsWith(content))) return 'repair';
      // 言い直しの印のすぐ前を消した（「3時、いや4時」の「3時」）
      if (SELF_REPAIR.test(before.slice(h.end, h.end + 8))) return 'repair';
      if (PARTICLE.test(del.trim())) return 'particle';
      return 'unsupported';
    }
    if (!normalizeForCompare(del)) return PARTICLE.test(ins.trim()) ? 'particle' : 'unsupported';

    // 数の表記だけの違い: 塊に重なる数の値が前後で同じで、数のほかの字は変わっていない（「3時」が「3人」になっていない）
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

  // 数: 出力に、整形前に無い数があってはならない。数が減るのは、言い直しがあるときだけ
  const nums = multisetDiff(numbersOf(before), numbersOf(after));
  if (nums.added.length || (nums.dropped.length && !hasRepairCue)) {
    violations.push({ check: 'number', detail: `増えた数 ${nums.added.length}、消えた数 ${nums.dropped.length}` });
  }
  // 否定: 数が変わるのは、言い直しがあるときだけ
  const neg = negationCount(after) - negationCount(before);
  if (neg !== 0 && !hasRepairCue) violations.push({ check: 'negation', detail: `否定の数の差 ${neg}` });

  const allowance = Math.max(2, Math.ceil(beforeLen / 4));
  const unsupported = hunks.filter((h) => h.kind === 'unsupported');
  const added = unsupported.reduce((n, h) => n + normalizeForCompare(h.after).length, 0);
  const removed = unsupported.reduce((n, h) => n + normalizeForCompare(h.before).length, 0);
  if (added > allowance) violations.push({ check: 'added', detail: `根拠なく足した字 ${added}（上限 ${allowance}）` });
  if (removed > allowance) violations.push({ check: 'removed', detail: `根拠なく消した字 ${removed}（上限 ${allowance}）` });

  // 出力の半分以上が、整形前の文か、根拠のある置き換えから来ていること
  if (raw && afterLen >= 8 && 1 - added / afterLen < 0.5) {
    violations.push({ check: 'provenance', detail: `整形前の文に由来する割合 ${(1 - added / afterLen).toFixed(2)}` });
  }
  if (afterLen > beforeLen * 1.5 + 16) violations.push({ check: 'length', detail: `長さ ${beforeLen} → ${afterLen}` });
  const opening = REPLY_OPENING.exec(after.trim());
  if (opening && !key(before).startsWith(key(opening[0]))) violations.push({ check: 'reply', detail: '返答のような書き出し' });

  // 根拠のない塊だけを、整形前の文に戻す
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
