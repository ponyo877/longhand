/**
 * Matches the transcript against dictionary words (G4-11).
 * Whisper sometimes writes Latin product names and the like in katakana or hiragana (「ぐらふぁな」).
 * Each dictionary word has readings (kana spellings speech recognition is likely to write), matched against kana runs in the raw text to make candidates.
 * - With the LLM: candidates are passed to formatting, and the LLM decides from context (nothing is replaced)
 * - Without the LLM: only spots that exactly match a reading the user confirmed are replaced
 */
import { countMorae, editDistance, hasKanji, isKanaOnly, matchForm } from './kana';

export interface Reading {
  text: string;
  /** Whether the user confirmed the reading (typed it, or corrected a misrecognized form themselves). false for readings made by the LLM */
  confirmed: boolean;
}

export interface MatchEntry {
  word: string;
  readings: Reading[];
}

export interface DictionaryMatch {
  /** Position in the raw text (string indices, not code points) */
  start: number;
  end: number;
  /** The part of the raw text as heard */
  heard: string;
  /** The dictionary word */
  word: string;
  /** Whether it matched a reading exactly (false means a fuzzy match within edit distance 1) */
  exact: boolean;
  /** Whether the matched reading is one the user confirmed */
  confirmed: boolean;
}

/** Maximum number of candidates passed to formatting */
export const MAX_CANDIDATES = 8;
/** Minimum number of morae for a reading to allow fuzzy matches */
const FUZZY_MIN_MORAE = 4;

interface Run {
  start: number;
  /** For each character of the matching form, its [start, end) in the original string */
  map: [number, number][];
  form: string;
}

/** A katakana run (used by textfix rule a) */
export interface KatakanaRun {
  /** Position in the raw text [start, end) */
  start: number;
  end: number;
  text: string;
}

/**
 * Extracts katakana runs from the raw text. Long-vowel marks (ー) and middle dots (・) are included only inside a run, never at its ends.
 * Names joined with a middle dot, such as 「クロード・モネ」, count as one run (so only part of it is never fixed)
 */
export function katakanaRuns(text: string): KatakanaRun[] {
  const out: KatakanaRun[] = [];
  const re = /[ァ-ヺ][ァ-ヺー・]*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[0].replace(/・+$/, '');
    out.push({ start: m.index, end: m.index + body.length, text: body });
  }
  return out;
}

/** Extracts kana runs from the raw text and maps the matching form back to the original positions */
function kanaRuns(text: string): Run[] {
  const runs: Run[] = [];
  const re = /[ぁ-ゖ゠-ヿー]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const map: [number, number][] = [];
    let form = '';
    // Convert one character at a time (two for ヴァ and the like) into the matching form, remembering positions
    let i = 0;
    const s = m[0];
    while (i < s.length) {
      const two = s.slice(i, i + 2);
      const f2 = /^ヴ[ァィェォ]$/.test(two) ? matchForm(two) : null;
      const len = f2 !== null ? 2 : 1;
      const f = f2 ?? matchForm(s[i]);
      for (let k = 0; k < f.length; k++) map.push([m.index + i, m.index + i + len]);
      form += f;
      i += len;
    }
    if (form) runs.push({ start: m.index, map, form });
  }
  return runs;
}

function overlaps(a: DictionaryMatch, b: DictionaryMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Candidate priority: exact match, confirmed reading, longer match */
function better(a: DictionaryMatch, b: DictionaryMatch): boolean {
  if (a.exact !== b.exact) return a.exact;
  if (a.confirmed !== b.confirmed) return a.confirmed;
  return a.end - a.start > b.end - b.start;
}

/**
 * Finds dictionary word candidates in the raw text.
 * - Kana readings: an exact match on the matching form (long vowels, small tsu, small characters and ヴ normalized), or within edit distance 1 for 4 or more morae
 * - Misrecognized kanji forms (from of a learned word): a candidate if contained as is (not used for replacement)
 * - Latin words: differing only in case, or by one letter for words of 6 or more letters
 * Spots where the word is already written correctly are not candidates.
 */
export function findDictionaryCandidates(raw: string, entries: MatchEntry[]): DictionaryMatch[] {
  if (!raw.trim() || !entries.length) return [];
  const found: DictionaryMatch[] = [];
  const runs = kanaRuns(raw);
  const lower = raw.toLowerCase();

  for (const e of entries) {
    for (const r of e.readings) {
      const text = r.text.trim();
      if (!text || text === e.word) continue;
      if (isKanaOnly(text.replace(/[・\s]/g, ''))) {
        const form = matchForm(text);
        const morae = countMorae(text);
        if (form.length < 2) continue;
        for (const run of runs) {
          // Exact match (short readings only when they match the whole kana run)
          const whole = morae < 3;
          for (let i = run.form.indexOf(form); i >= 0; i = run.form.indexOf(form, i + 1)) {
            if (whole && (i !== 0 || form.length !== run.form.length)) continue;
            const start = run.map[i][0];
            const end = run.map[i + form.length - 1][1];
            found.push({ start, end, heard: raw.slice(start, end), word: e.word, exact: true, confirmed: r.confirmed });
          }
          // Fuzzy match
          if (morae >= FUZZY_MIN_MORAE && form.length >= FUZZY_MIN_MORAE) {
            const fa = Array.from(form);
            const ra = Array.from(run.form);
            for (let len = fa.length - 1; len <= fa.length + 1; len++) {
              if (len < 2) continue;
              for (let i = 0; i + len <= ra.length; i++) {
                const win = ra.slice(i, i + len);
                if (win.join('') === form) continue;
                if (editDistance(win, fa) <= 1) {
                  const start = run.map[i][0];
                  const end = run.map[i + len - 1][1];
                  found.push({ start, end, heard: raw.slice(start, end), word: e.word, exact: false, confirmed: r.confirmed });
                }
              }
            }
          }
        }
      } else if (hasKanji(text)) {
        for (let i = raw.indexOf(text); i >= 0; i = raw.indexOf(text, i + 1)) {
          found.push({ start: i, end: i + text.length, heard: text, word: e.word, exact: true, confirmed: false });
        }
      }
    }
    // Spelling and case of Latin words
    if (/^[A-Za-z][A-Za-z0-9.+#-]*$/.test(e.word)) {
      const w = e.word.toLowerCase();
      const re = /[A-Za-z][A-Za-z0-9.+#-]*/g;
      for (let m = re.exec(raw); m; m = re.exec(raw)) {
        const tok = m[0];
        if (tok === e.word) continue;
        const tl = tok.toLowerCase();
        if (tl === w) {
          found.push({ start: m.index, end: m.index + tok.length, heard: tok, word: e.word, exact: true, confirmed: /[a-z][A-Z]/.test(e.word) });
        } else if (w.length >= 6 && Math.abs(tl.length - w.length) <= 1 && editDistance(tl, w) <= 1) {
          found.push({ start: m.index, end: m.index + tok.length, heard: tok, word: e.word, exact: false, confirmed: false });
        }
      }
    }
  }

  // Of overlapping candidates, keep the better one
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: DictionaryMatch[] = [];
  for (const m of found) {
    const i = kept.findIndex((k) => overlaps(k, m));
    if (i < 0) kept.push(m);
    else if (better(m, kept[i])) kept[i] = m;
  }
  // Drop spots identical to a correctly written word (duplicates when the raw text already has the word)
  const result = kept.filter((m) => lower.slice(m.start, m.end) !== m.word.toLowerCase() || m.heard !== m.word);
  result.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.confirmed) - Number(a.confirmed) || a.start - b.start);
  return result.slice(0, MAX_CANDIDATES).sort((a, b) => a.start - b.start);
}

/**
 * Replacement without the LLM. Only spots that exactly match a reading the user confirmed become the dictionary word.
 * Also returns the number of replacements.
 */
export function applyConfirmedMatches(raw: string, matches: DictionaryMatch[]): { text: string; replaced: number } {
  const targets = matches.filter((m) => m.exact && m.confirmed).sort((a, b) => b.start - a.start);
  let text = raw;
  for (const m of targets) text = text.slice(0, m.start) + m.word + text.slice(m.end);
  return { text, replaced: targets.length };
}
