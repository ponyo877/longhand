/**
 * Scores dictionary words by how relevant they are to the current dictation (G4-09, G4-10).
 * The Whisper prompt only fits 120 tokens of words (a few dozen), so words are passed by score rather than newest first.
 * Words passed to the formatting LLM are also narrowed to the highest scores when the dictionary is large.
 */
import { matchForm } from './kana';

/** Context of the target. The field is included only when it is not a password field */
export interface HintContext {
  beforeCursor?: string;
  afterCursor?: string;
  windowTitle?: string;
  host?: string;
  bundleId?: string;
}

/** A recent transcript (a HistoryItem can be passed as is) */
export interface RecentText {
  text: string;
  rawText?: string;
  timestamp: number;
  app?: { bundleId: string };
}

export interface VocabEntry {
  word: string;
  /** Time it was learned, for a learned word */
  learnedAt?: number;
  /** How recently it was added to the dictionary (0 is the oldest, 1 the newest) */
  recency: number;
  /** Readings for matching (katakana, hiragana, misrecognized forms). If one appears in recent raw text, the word counts as used */
  readings?: string[];
}

export interface HintOptions {
  limit?: number;
  context?: HintContext;
  recent?: RecentText[];
  now?: number;
}

const DAY = 24 * 60 * 60 * 1000;
/** How far back recent transcripts go */
const RECENT_DAYS = 14;
const RECENT_MAX = 100;

/** Score weights. Only the relative size of the total matters */
const W = {
  field: 3,
  titleOrHost: 2,
  recentMax: 3,
  learned: 1,
  learnedWeek: 1.5,
  learnedMonth: 0.5,
  recency: 0.5,
  /** A word with no learning record that appears as is in recent raw text many times (likely written correctly even without a hint) */
  easyPenalty: -0.5,
};

function isLatinTerm(term: string): boolean {
  return /^[\x20-\x7e]+$/.test(term);
}

/** Number of times term appears in text (lowercased). Latin terms count only where not surrounded by letters or digits */
export function countTerm(textLower: string, term: string): number {
  const t = term.toLowerCase();
  if (!t) return 0;
  const latin = isLatinTerm(t);
  let n = 0;
  for (let i = textLower.indexOf(t); i >= 0; i = textLower.indexOf(t, i + t.length)) {
    if (latin) {
      const before = textLower[i - 1];
      const after = textLower[i + t.length];
      if ((before && /[a-z0-9]/.test(before)) || (after && /[a-z0-9]/.test(after))) continue;
    }
    n++;
  }
  return n;
}

export interface ScoredWord {
  word: string;
  score: number;
}

/** Scores each word and sorts by score, highest first. Ties go to the newer word */
export function rankVocabulary(entries: VocabEntry[], opts: HintOptions = {}): ScoredWord[] {
  const now = opts.now ?? Date.now();
  const ctx = opts.context ?? {};
  const field = `${ctx.beforeCursor ?? ''}\n${ctx.afterCursor ?? ''}`.toLowerCase();
  const title = `${ctx.windowTitle ?? ''}\n${ctx.host ?? ''}`.toLowerCase();
  const recent = (opts.recent ?? [])
    .filter((r) => now - r.timestamp <= RECENT_DAYS * DAY)
    .slice(0, RECENT_MAX)
    .map((r) => ({
      text: (r.text ?? '').toLowerCase(),
      raw: (r.rawText ?? '').toLowerCase(),
      rawForm: matchForm(r.rawText ?? ''),
      weight: Math.exp(-(now - r.timestamp) / (7 * DAY)) * (ctx.bundleId && r.app?.bundleId === ctx.bundleId ? 1 : 0.4),
    }));

  const scored = entries.map((e) => {
    let score = 0;
    if (field.trim() && countTerm(field, e.word)) score += W.field;
    if (title.trim() && countTerm(title, e.word)) score += W.titleOrHost;
    let use = 0;
    let rawHits = 0;
    const readingForms = (e.readings ?? []).map(matchForm).filter((f) => f.length >= 3);
    for (const r of recent) {
      const inText = countTerm(r.text, e.word) > 0;
      const inRaw = countTerm(r.raw, e.word) > 0;
      const heardAsReading = readingForms.some((f) => r.rawForm.includes(f));
      if (inText || heardAsReading) use += r.weight;
      if (inRaw) rawHits++;
    }
    score += Math.min(W.recentMax, use * 1.5);
    if (e.learnedAt !== undefined) {
      score += W.learned;
      const age = now - e.learnedAt;
      if (age <= 7 * DAY) score += W.learnedWeek;
      else if (age <= 30 * DAY) score += W.learnedMonth;
    } else if (rawHits >= 3) {
      score += W.easyPenalty;
    }
    score += W.recency * e.recency;
    return { word: e.word, score, tie: e.learnedAt ?? e.recency };
  });
  scored.sort((a, b) => b.score - a.score || b.tie - a.tie);
  return scored.map(({ word, score }) => ({ word, score }));
}
