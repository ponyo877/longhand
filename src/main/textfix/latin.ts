/**
 * Rule a: rewrites katakana product names and technical terms in their Latin spelling.
 *
 * - Fixes only when the whole katakana run is covered by glossary readings (「グーグルクローム」 is Google Chrome).
 *   No partial, fuzzy or hiragana matches. Readings are normalized with matchForm before comparing
 * - Tier 1 words are always fixed. Tier 2 words are fixed only when the user dictionary has that Latin word or the target app matches;
 *   otherwise they stay as candidates for the LLM
 * - If the user dictionary has the same word, the user's spelling is used (differences in case and whitespace count as the same word)
 * - Adds a space next to Latin letters or digits. No space next to Japanese (same as the formatting rules)
 */
import { matchForm } from '../vocab/kana';
import { katakanaRuns } from '../vocab/match';
import type { RuleContext, RuleResult } from './index';
import { LATIN_LEXICON, type LatinEntry } from './lexicon/latin';
import type { FixEdit, LexiconCandidate } from './types';

/** Maximum number of words one run may be split into */
const MAX_SEGMENTS = 3;

export interface LexiconIndex {
  /** Normalized reading → word */
  byForm: Map<string, LatinEntry>;
  /** Length of the longest normalized reading */
  maxLen: number;
}

/** Indexes the glossary by reading. When several words share a reading, the first one wins (the glossary test checks there are no overlaps) */
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

/** Latin words in the glossary (treated as known Latin words when deciding on the fast path) */
export function lexiconWords(): string[] {
  return LATIN_LEXICON.map((e) => e.word);
}

/** Returns the split of a normalized reading into glossary readings that uses the fewest words. null if it cannot be covered */
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

/** Whether a tier 2 word may be fixed (it is in the user dictionary, or the target app matches) */
function activated(e: LatinEntry, vocab: Map<string, string>, app: RuleContext['input']['app']): boolean {
  if (e.tier === 1 || vocab.has(wordKey(e.word))) return true;
  const bundle = (app?.bundleId ?? '').toLowerCase();
  const host = (app?.host ?? '').toLowerCase();
  const name = (app?.name ?? '').toLowerCase();
  return (e.apps ?? []).some((a) => {
    const k = a.toLowerCase();
    // Entries with a "." match a bundle ID prefix or a host name; entries without one match the app name exactly
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
