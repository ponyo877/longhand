/**
 * 文字の種類（英字、カタカナ、漢字）が続く範囲。
 * 日本語は語の間に空白が無いので、差分の塊を「語らしい範囲」に広げるときに、字の種類の切れ目を語の切れ目の代わりに使う。
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
 * [start, end) を、端の字と同じ種類の字が続く範囲まで広げる。ひらがなや記号（other）の側には広げない。
 * 空の範囲はそのまま返す。
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
