/**
 * Runs of the same script (Latin, katakana, kanji).
 * Japanese has no spaces between words, so script boundaries stand in for word boundaries when expanding a diff hunk to a word-like range.
 */

export type CharClass = 'latin' | 'katakana' | 'kanji' | 'other';

export function charClassOf(ch: string | undefined): CharClass {
  if (!ch) return 'other';
  if (/[A-Za-z0-9.+#_'-]/.test(ch)) return 'latin';
  if (/[ァ-ヺー]/.test(ch)) return 'katakana';
  if (/[一-鿿々〆]/.test(ch)) return 'kanji';
  return 'other';
}

/**
 * Expands [start, end) over the run of characters of the same script as the edge characters. Never expands into hiragana or symbols (other).
 * Returns an empty range unchanged.
 */
export function expandRunRange(text: string, start: number, end: number): [number, number] {
  if (start >= end) return [start, end];
  let s = start;
  let e = end;
  const left = charClassOf(text[s]);
  if (left !== 'other') while (s > 0 && charClassOf(text[s - 1]) === left) s--;
  const right = charClassOf(text[e - 1]);
  if (right !== 'other') while (e < text.length && charClassOf(text[e]) === right) e++;
  return [s, e];
}
