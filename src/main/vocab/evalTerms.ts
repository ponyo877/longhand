/**
 * Evaluation helpers for dictionary words (G4-19). Used by evaluation (src/main/eval).
 * - termRecall: share of dictionary words in the reference that appear in the output with the same spelling (recall)
 * - falseInsertions: number of dictionary words that appear in the output more often than in the reference (false insertions)
 * - inventedTerms: made-up words for simulating a large dictionary
 * - orderHintsForEval: hint order for evaluation (the current newest-first order, or by score)
 */
import { countTerm, rankVocabulary, type VocabEntry } from './hints';

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

export interface TermCount {
  term: string;
  reference: number;
  output: number;
}

/** Occurrences of each term (ignoring NFKC differences and case. Latin terms only where not surrounded by letters or digits) */
export function termCounts(reference: string, output: string, terms: string[]): TermCount[] {
  const r = norm(reference);
  const o = norm(output);
  return terms
    .map((t) => t.trim())
    .filter(Boolean)
    .map((term) => ({ term, reference: countTerm(r, norm(term)), output: countTerm(o, norm(term)) }));
}

/** Numerator and denominator of recall. The numerator sums min(output count, reference count) over the terms */
export function termRecall(reference: string, output: string, terms: string[]): { hit: number; total: number } {
  let hit = 0;
  let total = 0;
  for (const c of termCounts(reference, output, terms)) {
    total += c.reference;
    hit += Math.min(c.reference, c.output);
  }
  return { hit, total };
}

/** Number of false insertions. Sums max(0, output count - reference count) over the terms */
export function falseInsertions(reference: string, output: string, terms: string[]): number {
  return termCounts(reference, output, terms).reduce((n, c) => n + Math.max(0, c.output - c.reference), 0);
}

/** Lists of missed terms and wrongly inserted terms (kept in the results file) */
export function termDetails(reference: string, output: string, terms: string[]): { missed: string[]; inserted: string[] } {
  const cs = termCounts(reference, output, terms);
  return {
    missed: cs.filter((c) => c.output < c.reference).map((c) => c.term),
    inserted: cs.filter((c) => c.output > c.reference).map((c) => c.term),
  };
}

const ONSETS = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'br', 'dr', 'kl', 'pr', 'st', 'tr', 'qu', 'x'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'y'];
const CODAS = ['', '', 'n', 'r', 'x', 'l', 'm', 'k', 'th', 'sk'];

/**
 * Makes n made-up words (the same seed gives the same words). Two- or three-syllable words that look like Latin product names.
 * Added after the real dictionary words (as the newest words) to simulate a large dictionary in evaluation.
 */
export function inventedTerms(n: number, seed = 1): string[] {
  let x = seed >>> 0 || 1;
  const rand = (k: number) => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x % k;
  };
  const out = new Set<string>();
  let guard = 0;
  while (out.size < n && guard++ < n * 50) {
    const syll = 2 + rand(2);
    let w = '';
    for (let i = 0; i < syll; i++) w += ONSETS[rand(ONSETS.length)] + VOWELS[rand(VOWELS.length)];
    w += CODAS[rand(CODAS.length)];
    out.add(w.charAt(0).toUpperCase() + w.slice(1));
  }
  return [...out];
}

/**
 * Orders hints for evaluation.
 * - recent: imitates the current method (newest added words first). terms are assumed to be oldest first
 * - score: by score. Evaluation data has no field context, so the references of the other utterances count as recent transcripts
 *   (do not include the utterance itself; the caller removes it)
 */
export function orderHintsForEval(terms: string[], otherReferences: string[], order: 'recent' | 'score', limit = 64): string[] {
  if (order === 'recent') return [...terms].reverse().slice(0, limit);
  const n = terms.length;
  const entries: VocabEntry[] = terms.map((word, i) => ({ word, recency: n > 1 ? i / (n - 1) : 1 }));
  const now = Date.now();
  const recent = otherReferences.map((text) => ({ text, timestamp: now }));
  return rankVocabulary(entries, { recent, now })
    .slice(0, limit)
    .map((s) => s.word);
}
