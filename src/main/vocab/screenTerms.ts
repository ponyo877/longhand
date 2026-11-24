/**
 * Picks up terms in use on the target screen (Latin product names and technical terms) from its text.
 *
 * Even with an empty user dictionary, words in the open document or chat are likely to be spoken next.
 * The terms are added to the recognition hints and the formatting vocabulary for that utterance only (not to the dictionary).
 * The screen text itself is discarded once the terms are picked (not saved, not sent anywhere).
 *
 * The idea comes from the screen vocabulary extraction in Hex (anomalyco/hex), an MIT-licensed dictation app (no code was copied).
 */
import { extractCandidates } from '../../shared/dictCandidates';

/** English words common in menus and buttons. They are not terms, so they are left out */
const UI_WORDS = new Set(
  (
    'file edit view window help tools format insert table history bookmarks profiles tab tabs page pages ' +
    'ok cancel save open close delete copy paste cut undo redo send reply forward share search find replace ' +
    'home back next previous new add remove settings preferences options menu sign login logout log account ' +
    'yes no done apply submit continue skip retry update upgrade download upload print export import ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april june july august ' +
    'september october november december today yesterday tomorrow ' +
    'mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep oct nov dec ' +
    'untitled draft inbox sent trash spam all none more less show hide'
  ).split(' '),
);

export interface ScreenTermOptions {
  /** Words already in the dictionary (not picked up again) */
  existing?: readonly string[];
  /** Maximum number of words to return */
  limit?: number;
}

/**
 * Returns name-like Latin words from the text, most frequent first.
 * Pass texts such as the field text around the cursor, the window title and the screen text.
 */
export function extractScreenTerms(texts: readonly (string | undefined)[], opts: ScreenTermOptions = {}): string[] {
  const docs = texts.filter((t): t is string => !!t && t.trim().length > 0);
  if (!docs.length) return [];
  const limit = opts.limit ?? 24;
  return extractCandidates(docs, { existing: [...(opts.existing ?? [])], namesOnly: true, maxLength: 32, limit: limit * 3 })
    .map((c) => c.word)
    .filter((w) => !UI_WORDS.has(w.toLowerCase()))
    .filter((w) => !/^\d/.test(w) || /[A-Za-z]{2}/.test(w))
    .slice(0, limit);
}
