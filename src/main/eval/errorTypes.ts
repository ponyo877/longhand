/**
 * 誤りの種類の内訳。正解と出力を 1 字ずつ突き合わせ、連続した誤りをまとめて、種類に分ける。
 *
 * 突き合わせ（editOps）とまとめ方（errorGroups）は 以前の採点スクリプトから移したもの。
 * 位置を持たせてあるので、まとめた誤りが文のどこにあるかが分かる。
 *
 * 種類（上から順に当てはめる）:
 * - number         数字が絡む（算用数字、漢数字どうし）
 * - filler         つなぎ言葉（えー、あの、など）が足された、または落ちた
 * - particle       助詞が足された、落ちた、入れ替わった
 * - notation       表記だけの違い（読みが同じで、かなと漢字の使い分けや送りがなが違う）
 * - homophone      同音異義語（読みが同じで、漢字が違う）。単語分割があるときだけ分かる
 * - latinKatakana  英字かカタカナの語が絡む（製品名や技術用語の聞き違い、綴りの違い）
 * - deletion       そのほかの脱落（正解にある字が出力にない）
 * - insertion      そのほかの挿入（正解にない字が出力にある）
 * - other          そのほかの置き換え
 *
 * 読みは単語分割（lindera、IPADIC）で調べる。単語分割がなければ、ひらがなとカタカナの違いだけを表記の違いとして扱う。
 */
import type { Token, Tokenizer } from '../textfix/types';
import { normContent } from './metrics';

export type Op = '=' | 'S' | 'D' | 'I';

export interface EditOp {
  op: Op;
  /** 正解の字（I なら空） */
  ref: string;
  /** 出力の字（D なら空） */
  hyp: string;
  /** この操作の前の位置（正解の添字、出力の添字） */
  i: number;
  j: number;
}

/** レーベンシュタイン距離の突き合わせ。= は一致、S は置き換え、D は脱落、I は挿入 */
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

/** 連続した誤りをまとめたもの。位置は正規化した文字の並びの添字 [start, end) */
export interface ErrorGroup {
  ref: string;
  hyp: string;
  refStart: number;
  refEnd: number;
  hypStart: number;
  hypEnd: number;
  /** この誤りの編集の数（距離への寄与） */
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
  latinKatakana: '英字とカタカナ',
  number: '数字',
  particle: '助詞',
  filler: 'つなぎ言葉',
  notation: '表記だけ',
  homophone: '同音異義語',
  deletion: '脱落',
  insertion: '挿入',
  other: 'その他',
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

/** ひらがなをカタカナにする */
function toKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

type Range = [number, number];

/** 片方の文（正規化した字の並び）と、その単語分割 */
interface Side {
  chars: readonly string[];
  /** 単語の範囲（字の並びの添字）と読み。単語分割がなければ null */
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
  // 単語分割の位置は文字列の添字（UTF-16）なので、字の並びの添字に直す
  const toChar = new Int32Array(text.length + 1);
  let unit = 0;
  chars.forEach((c, k) => {
    for (let u = 0; u < c.length; u++) toChar[unit + u] = k;
    unit += c.length;
  });
  toChar[unit] = chars.length;
  return { chars, tokens: raw.map((token) => ({ start: toChar[token.start], end: toChar[token.end], token })) };
}

/** 範囲に重なる単語。長さ 0 の範囲は、その位置をまたぐ単語だけ */
function overlapping(side: Side, [s, e]: Range) {
  if (!side.tokens) return [];
  return side.tokens.filter((t) => (s === e ? t.start < s && t.end > s : t.start < e && t.end > s));
}

/** 範囲を単語の切れ目まで広げる */
function expand(side: Side, r: Range): Range {
  const over = overlapping(side, r);
  if (!over.length) return r;
  return [Math.min(r[0], over[0].start), Math.max(r[1], over[over.length - 1].end)];
}

function union(a: Range, b: Range): Range {
  return b[0] > b[1] ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

/** 突き合わせの経路から、片方の切れ目に対応する、もう片方の切れ目の範囲（最小と最大）を作る */
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

/** 範囲の読み（カタカナ）。読みの分からない単語は表層形を使う */
function readingOf(side: Side, r: Range): string {
  if (r[0] >= r[1]) return '';
  return overlapping(side, r)
    .map((t) => toKatakana(t.token.reading || t.token.surface))
    .join('');
}

/** 読みを比べるために広げる範囲の上限（字）。表記の違いは語の中で起きるので、広がりすぎたら比べない */
const MAX_EXPANDED = 16;

/**
 * まとめた誤りの前後を単語の切れ目まで広げ、正解の側と出力の側の読みを比べる。
 * 読みが同じなら、かなと漢字の使い分けか（notation）、同音異義語か（homophone）を返す。違えば null
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
  // どちらかがかなだけ、または漢字が同じ（送りがなの違い）なら、表記の違い。漢字が違えば同音異義語
  if (!ka.length || !kb.length || ka.join('') === kb.join('')) return 'notation';
  return 'homophone';
}

/** 範囲が助詞の単語だけでできているか。単語分割がなければ、一覧にあるかだけで決める */
function isParticle(side: Side, text: string, r: Range): boolean {
  if (!PARTICLES.has(text)) return false;
  if (!side.tokens) return true;
  const over = overlapping(side, r);
  return over.length > 0 && over[0].start === r[0] && over[over.length - 1].end === r[1] && over.every((t) => t.token.pos === '助詞');
}

function hasKatakana(side: Side, text: string, start: number): boolean {
  if (KATAKANA.test(text)) return true;
  // 長音だけの違いは、カタカナの語の中にあるときだけ数える（「えー」の長音は数えない）
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

/** 正規化した字の並びどうしの誤りを、種類に分ける */
export function classifyErrors(ref: readonly string[], hyp: readonly string[], tokenizer?: Tokenizer | null): { group: ErrorGroup; kind: ErrorKind }[] {
  const ops = editOps(ref, hyp);
  const groups = errorGroups(ops);
  if (!groups.length) return [];
  const refSide = makeSide(ref, tokenizer);
  const hypSide = makeSide(hyp, tokenizer);
  const maps = boundaryMaps(ops, ref.length, hyp.length);
  return groups.map((group) => ({ group, kind: classify(group, refSide, hypSide, maps) }));
}

/** 正解と出力の文から、誤りの種類ごとの件数と編集の数を出す（中身だけを比べる。句読点と空白は見ない） */
export function errorBreakdown(reference: string, output: string, tokenizer?: Tokenizer | null): ErrorBreakdown {
  const out = emptyBreakdown();
  for (const { group, kind } of classifyErrors(normContent(reference), normContent(output), tokenizer)) {
    out[kind].groups++;
    out[kind].edits += group.edits;
  }
  return out;
}
