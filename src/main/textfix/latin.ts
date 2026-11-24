/**
 * 規則 a: カタカナの製品名や技術用語を、英字の綴りに直す。
 *
 * - カタカナの連なり全体が、用語集の読みで埋まるときだけ直す（「グーグルクローム」は Google Chrome）。
 *   部分一致、あいまい一致、ひらがなの一致は使わない。読みは matchForm で正規化して比べる
 * - 段階 1 の語は常に直す。段階 2 の語は、利用者の辞書にその英字の語があるか、入力先のアプリが一致するときだけ直し、
 *   それ以外は LLM への候補にとどめる
 * - 利用者の辞書に同じ語があれば、利用者の綴りを使う（大文字と小文字、空白の違いは同じ語とみなす）
 * - 前後が英数字なら空白を挟む。日本語との間には空白を入れない（整形の規則と同じ）
 */
import { matchForm } from '../vocab/kana';
import { katakanaRuns } from '../vocab/match';
import type { RuleContext, RuleResult } from './index';
import { LATIN_LEXICON, type LatinEntry } from './lexicon/latin';
import type { FixEdit, LexiconCandidate } from './types';

/** 1 つの連なりを分けてよい語の数の上限 */
const MAX_SEGMENTS = 3;

export interface LexiconIndex {
  /** 正規化した読み → 語 */
  byForm: Map<string, LatinEntry>;
  /** 正規化した読みの最長の長さ */
  maxLen: number;
}

/** 用語集を読みで引けるようにする。同じ読みが複数の語にあるときは先の語を採る（用語集のテストで重なりがないことを確かめる） */
export function buildLexiconIndex(entries: readonly LatinEntry[]): LexiconIndex {
  const byForm = new Map<string, LatinEntry>();
  let maxLen = 0;
  for (const e of entries) {
    for (const r of e.readings) {
      const f = matchForm(r);
      if (!f || byForm.has(f)) continue;
      byForm.set(f, e);
      maxLen = Math.max(maxLen, f.length);
    }
  }
  return { byForm, maxLen };
}

let defaultIndex: LexiconIndex | null = null;
function lexiconIndex(): LexiconIndex {
  defaultIndex ??= buildLexiconIndex(LATIN_LEXICON);
  return defaultIndex;
}

/** 用語集の英字の語（近道の判定で、知っている英字の語として扱う） */
export function lexiconWords(): string[] {
  return LATIN_LEXICON.map((e) => e.word);
}

/** 正規化した読みを、用語集の読みで埋める分け方のうち、語の数が最も少ないものを返す。埋められなければ null */
export function segmentForm(form: string, index: LexiconIndex): LatinEntry[] | null {
  const n = form.length;
  if (!n) return null;
  const best: ({ count: number; prev: number; entry: LatinEntry } | null)[] = Array.from({ length: n + 1 }, () => null);
  const reach = (j: number) => (j === 0 ? 0 : (best[j]?.count ?? Infinity));
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - index.maxLen); j < i; j++) {
      const c = reach(j);
      if (c >= MAX_SEGMENTS) continue;
      const entry = index.byForm.get(form.slice(j, i));
      if (!entry) continue;
      if (!best[i] || c + 1 < best[i]!.count) best[i] = { count: c + 1, prev: j, entry };
    }
  }
  if (!best[n]) return null;
  const out: LatinEntry[] = [];
  for (let i = n; i > 0; i = best[i]!.prev) out.unshift(best[i]!.entry);
  return out;
}

const wordKey = (w: string) => w.toLowerCase().replace(/\s+/g, '');

/** 段階 2 の語を直してよいか（利用者の辞書にある、または入力先のアプリが一致する） */
function activated(e: LatinEntry, vocab: Map<string, string>, app: RuleContext['input']['app']): boolean {
  if (e.tier === 1 || vocab.has(wordKey(e.word))) return true;
  const bundle = (app?.bundleId ?? '').toLowerCase();
  const host = (app?.host ?? '').toLowerCase();
  const name = (app?.name ?? '').toLowerCase();
  return (e.apps ?? []).some((a) => {
    const k = a.toLowerCase();
    // 「.」を含むものは bundle ID の前方一致かホスト名、含まないものはアプリ名の完全一致
    if (k.includes('.')) return (!!bundle && bundle.startsWith(k)) || (!!host && (host === k || host.endsWith(`.${k}`)));
    return !!name && name === k;
  });
}

export function fixLatin(ctx: RuleContext): RuleResult {
  const { text, input } = ctx;
  const index = lexiconIndex();
  const vocab = new Map<string, string>();
  for (const w of input.vocabulary ?? []) if (/[A-Za-z]/.test(w)) vocab.set(wordKey(w), w);
  const edits: FixEdit[] = [];
  const candidates: LexiconCandidate[] = [];
  for (const run of katakanaRuns(text)) {
    const segs = segmentForm(matchForm(run.text), index);
    if (!segs) continue;
    const spell = (e: LatinEntry) => vocab.get(wordKey(e.word)) ?? e.word;
    const joined = segs.map(spell).join(' ');
    const word = vocab.get(wordKey(joined)) ?? joined;
    if (!segs.every((e) => activated(e, vocab, input.app))) {
      candidates.push({ heard: run.text, word });
      continue;
    }
    const before = run.start > 0 && /[A-Za-z0-9]/.test(text[run.start - 1]) ? ' ' : '';
    const after = run.end < text.length && /[A-Za-z0-9]/.test(text[run.end]) ? ' ' : '';
    edits.push({ rule: 'latin', start: run.start, end: run.end, before: run.text, after: before + word + after });
  }
  return { edits, candidates };
}
