/**
 * 貼り付けた文と、ユーザーが手直しした後の文を比べて、「置き換えられた語」の組を取り出す（LRN-1）。
 */
import type { Tokenizer } from '../textfix/types';
import { editDistance, hasKanji, hiraToKata, soundForm } from '../vocab/kana';

export interface Replacement {
  /** 貼り付けたときの語（誤認識） */
  from: string;
  /** 手直し後の語 */
  to: string;
  /** 手直し後の文のうち、この置き換えを含む前後（LLM に判定させるときの文脈） */
  context: string;
  /** 文の中での読み（カタカナ）。単語分割で分かったときだけ入る（extractRewrites） */
  fromReading?: string;
  toReading?: string;
}

export interface EditedRegion {
  original: string;
  edited: string;
  /**
   * 範囲の見つけ方。diff: 変わっていない部分を錨にして位置を写した / prefix: 前後の共通部分（錨が使えないときの代替）/
   * search: 貼り付けた文を探した（貼り付けが遅れて反映された場合）
   */
  method: 'diff' | 'prefix' | 'search';
}

export interface RegionOptions {
  /** 貼り付けた文（コマンド記法を除いたもの）。貼り付けの位置が前後の比較で分からないときに探す */
  inserted?: string;
  /** before の中の貼り付けの位置（文字単位）。貼り付けた文が複数見つかったときに、近いものを選ぶ */
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

/** 文字単位の差分の塊（a の [aStart, aEnd) が b の [bStart, bEnd) に変わった） */
interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Myers の差分。変更が少ないほど速い（O((N+M)D)）。変更の量が maxD を超えたら null。
 * 長い入力欄（最大 2 万字）の全文どうしを比べても、手直しが少なければすぐ終わる。
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

  // 後ろからたどって、削除と挿入の 1 文字ずつの操作を集める
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

  // 隣り合う操作を塊にまとめる
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
 * a の位置を b の位置に写す。範囲の始まり（start）と終わり（end）で、境界にかかる塊の扱いを変える。
 * - 範囲の中の文字を消した（置き換えた）塊は範囲に含める
 * - 範囲の端にちょうど足しただけの塊（純粋な挿入）は範囲に含めない（貼り付けの前後に書き足した文）
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

/** 文字単位の差分（LCS）。手直しの対象は短いので O(n*m) で足りる。長すぎる場合は null */
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

/** 2 つの文がどれだけ残っているか（一致した文字数 ÷ 長い方の文字数） */
export function keptRatio(a: string, b: string): number {
  const ops = charDiff(a, b);
  if (!ops) return 0;
  const kept = ops.filter((o) => o.kind === 'eq').reduce((n, o) => n + Array.from(o.text).length, 0);
  return kept / Math.max(Array.from(a).length, Array.from(b).length, 1);
}

/** 貼り付けた文から、コマンド記法と前後の空白を除く */
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

/** needle の出現のうち、near に一番近いものの位置 */
function closestIndexOf(hay: string[], needle: string[], near: number): number {
  let best = -1;
  for (let i = indexOfSeq(hay, needle); i >= 0; i = indexOfSeq(hay, needle, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

/** 貼り付けで入った範囲を ref（貼り付け後の全文）の中で探す */
function locateInsertion(before: string[], ref: string[], inserted: string[] | null, near?: number): [number, number] | null {
  const p = commonPrefix(before, ref);
  const s = commonSuffix(before, ref, p, p);
  const start = p;
  const end = ref.length - s;
  if (end > start) {
    if (!inserted?.length) return [start, end];
    // 範囲の中に貼り付けた文がそのままあれば、そこに絞る（アプリが貼り付けの近くを書き換えた分を除く）
    const seg = ref.slice(start, end);
    const i = indexOfSeq(seg, inserted);
    if (i >= 0) return [start + i, start + i + inserted.length];
    // 貼り付けた文と大きく違わなければ、前後の比較で見つかった範囲を使う。大きく違えば、貼り付けた文を探す
    if (keptRatio(seg.join('').trim(), inserted.join('')) >= 0.5) return [start, end];
  }
  if (inserted?.length) {
    const i = closestIndexOf(ref, inserted, near ?? p);
    if (i >= 0) return [i, i + inserted.length];
  }
  return end > start ? [start, end] : null;
}

/** 以前の方法: 前後の共通部分で範囲を決め、範囲の外に手直しが及んでいたら null */
function regionByPrefix(ref: string[], final: string[], insStart: number, insEnd: number): [number, number] | null {
  const ep = commonPrefix(ref, final);
  const es = commonSuffix(ref, final, ep, ep);
  if (ep < insStart || ref.length - es > insEnd) return null;
  const p2 = Math.min(insStart, ep);
  const s2 = Math.min(ref.length - insEnd, commonSuffix(ref, final, p2, p2));
  return [p2, final.length - s2];
}

/**
 * 入力欄の全文の変化から、貼り付けた部分が手直しでどう変わったかを取り出す（G4-02）。
 * before: 貼り付け前、afterPaste: 貼り付け直後（または利用者が打ち始める直前）、final: 監視の終わり。
 * afterPaste と final の差分を取り、変わっていない部分を錨にして、貼り付けた範囲の位置を final に写す。
 * 範囲の外（件名や宛名など）を直していても、範囲の中の手直しだけを取り出せる。
 */
export function locateEditedRegion(before: string, afterPaste: string, final: string, opts: RegionOptions = {}): EditedRegion | null {
  const B0 = Array.from(before);
  const R = Array.from(afterPaste);
  const F = Array.from(final);
  const inserted = opts.inserted ? Array.from(stripPasteTokens(opts.inserted)) : null;

  const ins = locateInsertion(B0, R, inserted, opts.near);
  if (!ins) {
    // 貼り付け直後の読み取りに貼り付けが入っていなかった（反映が遅れた）。貼り付け前と最後の差分を、貼り付けた文と比べる
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
    // 範囲の端にちょうど接する置き換えの塊に、範囲の外へ書き足した語や文がくっついていたら切り離す
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

/** locateEditedRegion の結果から original と edited だけを返す（以前からの呼び出し方） */
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

/** 位置 [start, end) を、同じ文字種の連続（語らしい単位）まで左右に広げる。ひらがなは語の切れ目とみなして広げない */
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
  // 漢字の直後のカタカナ／英字、英字の直後のカタカナなど、複合語もひとまとまりにする
  const word = (c: string | undefined) => !!c && ['kanji', 'kata', 'latin'].includes(scriptOf(c));
  while (a > 0 && a < chars.length && word(chars[a - 1]) && word(chars[a])) a--;
  while (b > 0 && b < chars.length && word(chars[b]) && word(chars[b - 1])) b++;
  return [a, b];
}

/** 1 文字の一致が語の途中にあるか（前後が同じ文字種）。語の途中なら、その前後の差分を 1 つの塊につなぐ */
function insideWord(chars: string[], pos: number): boolean {
  const c = chars[pos];
  if (!c) return false;
  const s = scriptOf(c);
  return s !== 'other' && pos > 0 && scriptOf(chars[pos - 1]) === s && pos + 1 < chars.length && scriptOf(chars[pos + 1]) === s;
}

/** 2 つの語の近さ（0〜1）。音の形と文字の両方で比べ、近いほうを使う */
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
 * 置き換えの塊の挿入側（ins）から、消した文字（del）に対応する部分を選ぶ。残りは書き足した部分とみなす。
 * left なら先頭側を、right なら末尾側を切り離してよい。挿入を語（漢字、カタカナ、英字の連続）、ひらがな、
 * 記号と空白の連続に分け、del と一番近い連続した部分を選ぶ。戻り値は ins の中の [開始, 終了)。
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

/** 推敲（書き直し）とみなす変化の量 */
const MAX_HUNKS = 5;
const MAX_CHANGED_CHARS = 40;

/** 大文字小文字の形に意味がある英字の語か（iPhone、macOS、CPU など）。文頭の大文字化だけの直しは除く */
export function hasDistinctiveCase(word: string): boolean {
  if (!/^[A-Za-z0-9 .+#&'_-]+$/.test(word)) return false;
  const letters = word.replace(/[^A-Za-z0-9]/g, '');
  return /[a-z][A-Z]/.test(word) || (/^[A-Z0-9]{2,}$/.test(letters) && /[A-Z]/.test(letters));
}

/** 語ではなく文や句らしいか（ひらがなを含んで長い、文の区切りを含む） */
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
 * 元の文と手直し後の文から、語の置き換えを取り出す（G4-04）。
 * - 置き換えの塊が 1 つなら、文の長さに関係なく候補にする（短い発話や、語だけの発話も学習する）
 * - 塊が多すぎる、変わった文字が多すぎる、違う置き換えが 2 つ以上あって元の文がほとんど残っていない場合は、推敲とみなして何も返さない
 * - 文の前後に書き足しただけの部分は数えない
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
    if (/^[぀-ゟ]+$/.test(to)) continue; // ひらがなだけの語は辞書に入れる意味が薄い
    if (looksLikePhrase(to) || looksLikePhrase(from)) continue; // 語ではなく文や句の書き直し
    const ctxStart = Math.max(0, p.b0 - 40);
    const ctxEnd = Math.min(B.length, p.b1 + 40);
    out.push({ from, to, context: B.slice(ctxStart, ctxEnd).join('') });
  }
  // 同じ語の重複を除く（最初の組を残す）
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = r.to.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 語句の書き換えとして扱う長さの上限（これより長いものは、文の書き直しとみなす） */
const MAX_REWRITE_CHARS = 24;

/**
 * 元の文と手直し後の文から、語句の書き換えを取り出す。辞書に入れる語に限らず、かなの表記や、同じ読みの語への直しも拾う。
 * 整形の書き換えを元に戻した手直しと、同じ読みの語の取り違えを見つけるために使う。
 * - 単語分割があれば、塊を語の単位に広げる（「何」→「なん」ではなく、「何か」→「なんか」として取り出す）
 * - 間に 2 字以下しか挟まない塊は、1 つの書き換えにまとめる（「分からないので」→「わかんないんで」）
 * - 推敲とみなす条件は extractReplacements と同じ
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

/** 中身のある書き換えか（空、同じ、記号だけ、全角と半角だけ、文頭の大文字化だけ、句読点と空白だけの違いを除く） */
function isRealChange(from: string, to: string): boolean {
  if (!from || !to || from === to) return false; // 純粋な追加や削除は手直しの学習に使わない
  if (PUNCT_ONLY.test(to) || PUNCT_ONLY.test(from)) return false;
  const nf = from.normalize('NFKC');
  const nt = to.normalize('NFKC');
  if (nf === nt) return false; // 全角と半角だけの違い
  if (nf.toLowerCase() === nt.toLowerCase() && !hasDistinctiveCase(nt)) return false; // 文頭の大文字化など、大文字小文字だけの違い
  if (nf.replace(/\p{P}/gu, '').replace(/\s/g, '') === nt.replace(/\p{P}/gu, '').replace(/\s/g, '') && !/^[A-Za-z0-9]+$/.test(nt)) return false; // 句読点と空白だけの違い
  if (nf.replace(/[\s\p{P}]/gu, '') === nt.replace(/[\s\p{P}]/gu, '') && /\p{P}/u.test(nf + nt)) return false;
  return true;
}

interface PairOptions {
  /** 単語分割。あれば、塊を語（形態素）の単位にも広げる */
  tokenizer?: Tokenizer | null;
  /** 2 つの組の間の一致がこの字数以下なら、1 つの組にまとめる */
  mergeGap?: number;
}

/** 語の範囲 [開始, 終了)（文字の位置）と、その読み */
type Span = [number, number, string];

/** 文字（コードポイント）の位置で表した、語の範囲の一覧。単語分割が使えなければ null */
function tokenSpans(text: string, tokenizer?: Tokenizer | null): Span[] | null {
  let tokens: { start: number; end: number; surface: string; reading: string }[] | null = null;
  try {
    tokens = tokenizer?.tokenize(text) ?? null;
  } catch {
    tokens = null;
  }
  if (!tokens?.length) return null;
  // 単語分割の位置は文字列の添字（UTF-16）なので、コードポイントの位置に直す
  const cp: number[] = [];
  let n = 0;
  for (let i = 0; i < text.length; n++) {
    const step = text.codePointAt(i)! > 0xffff ? 2 : 1;
    for (let k = 0; k < step; k++) cp[i + k] = n;
    i += step;
  }
  cp[text.length] = n;
  // 読みの分からない漢字の語は、読みを空にしておく（その語を含む範囲の読みは分からないとする）
  return tokens.map((t) => [cp[t.start] ?? 0, cp[t.end] ?? n, t.reading || (hasKanji(t.surface) ? '' : hiraToKata(t.surface))]);
}

/** 範囲 [start, end) の読み。範囲が語の切れ目に合っていない、読みの分からない語がある、単語分割が使えないときは null */
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
  // 空白は単語分割に出てこないことがあるので、語が範囲のほとんどを覆っていればよいとする
  return out && covered >= (end - start) * 0.8 ? out : null;
}

/**
 * 組の両端から、両方の文で同じ語を落とす（「期間システム」→「基幹システム」を、「期間」→「基幹」にする）。
 * 語の単位で比べるので、「何か」→「なんか」の「か」は落とさない（「なんか」で 1 語のため）。
 * どちらかの側が 1 語になったら、そこで止める。残りが 1 字になる語も落とさない（「3時」→「三時」を、「3」→「三」にしない）。
 * 単語分割が使えなければ、そのまま返す。
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

/** 位置 [start, end) に重なる語の範囲まで広げる。空の範囲（純粋な挿入や削除）は広げない */
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
 * 差分の塊を、語の単位の組にする（extractReplacements と extractRewrites の共通部分）。
 * 推敲とみなしたときと、差分が取れなかったときは null。
 */
function buildPairs(original: string, edited: string, opts: PairOptions = {}): { A: string[]; B: string[]; pairs: Pair[]; spansA: Span[] | null; spansB: Span[] | null } | null {
  const ops = charDiff(original, edited);
  if (!ops) return null;
  const A = Array.from(original);
  const B = Array.from(edited);

  // 塊（隣り合う del / ins）を位置つきで集める。語の途中の 1 文字だけが一致して細切れになった差分はつなぐ
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
  // 塊の前後の一致の長さ（語の単位に広げるときの上限）
  for (let i = 0; i < hunks.length; i++) {
    const end = hunks[i].ai + hunks[i].del;
    const nextStart = i + 1 < hunks.length ? hunks[i + 1].ai : A.length;
    hunks[i].eqAfter = nextStart - end;
    const prevEnd = i > 0 ? hunks[i - 1].ai + hunks[i - 1].del : 0;
    hunks[i].eqBefore = hunks[i].ai - prevEnd;
  }

  // 文の端の置き換えに、書き足した語や文がくっついていたら切り離す（「でーたどっぐ」→「Datadogで確認します」）
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

  // 前後に書き足しただけの塊（純粋な挿入で、文の端にあるもの）は除く
  const core = hunks.filter((h, i) => {
    if (h.del > 0) return true;
    const atStart = i === 0 && h.ai === 0;
    const atEnd = i === hunks.length - 1 && h.ai === A.length;
    return !(atStart || atEnd);
  });
  if (!core.length) return null;

  // 推敲かどうか
  const appended = hunks.filter((h) => !core.includes(h)).reduce((n, h) => n + h.ins, trimmed);
  const changed = core.reduce((n, h) => n + Math.max(h.del, h.ins), 0);
  if (core.length > MAX_HUNKS || changed > MAX_CHANGED_CHARS) return null;
  // 違う置き換えが 2 つ以上あって、元の文がほとんど残っていなければ推敲（同じ直しの繰り返しは 1 つと数える）
  const distinct = new Set(core.map((h) => `${A.slice(h.ai, h.ai + h.del).join('')}\u0000${B.slice(h.bi, h.bi + h.ins).join('')}`));
  if (distinct.size >= 2) {
    const kept = ops.filter((o) => o.kind === 'eq').reduce((n, o) => n + Array.from(o.text).length, 0);
    const longer = Math.max(A.length, B.length - appended, 1);
    if (kept / longer < 0.4) return null;
  }

  // 塊を語の単位に広げる。広げた分の一致部分は、元の文と手直し後の文の両方に同じだけ含める（「Post Grace」→「Postgres」）
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
  // 手直し後の範囲が重なる組（同じ語に対応する複数の塊）は 1 組にまとめる（「Grow fauna」→「Grafana」）
  // mergeGap があれば、間の一致が短い組もまとめる（間の一致は、両方の文で同じ長さ）
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
