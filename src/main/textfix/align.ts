/**
 * Turns Whisper's per-token confidence into per-character confidence for the transcript.
 *
 * The worker sends a list of [text, probability] pairs. The joined text is nearly the same as the transcript, but differs where repeated segments were removed or in leading and trailing whitespace.
 * The character sequences are aligned; only matching characters get a confidence, and characters with no counterpart get null (no confidence).
 * Rules that use confidence do not act on spans containing null characters.
 */

export type Confidence = (number | null)[];

/** Maximum length (in characters) of the part to align. Longer parts get no confidence (fine, since the targets are short utterances) */
const MAX_ALIGN = 2000;

/** Moves per-character values from `from` onto the characters of `to`. After removing the common prefix and suffix, aligns the rest by longest common subsequence */
export function realign(from: string, conf: readonly (number | null)[], to: string): Confidence {
  if (from === to) return [...conf];
  const out: Confidence = Array.from({ length: to.length }, () => null);
  let pre = 0;
  while (pre < from.length && pre < to.length && from[pre] === to[pre]) {
    out[pre] = conf[pre] ?? null;
    pre++;
  }
  let suf = 0;
  while (suf < from.length - pre && suf < to.length - pre && from[from.length - 1 - suf] === to[to.length - 1 - suf]) {
    out[to.length - 1 - suf] = conf[from.length - 1 - suf] ?? null;
    suf++;
  }
  const a = from.slice(pre, from.length - suf);
  const b = to.slice(pre, to.length - suf);
  if (!a.length || !b.length || a.length > MAX_ALIGN || b.length > MAX_ALIGN) return out;
  // Longest common subsequence table (from the end)
  const n = a.length;
  const m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      out[pre + j] = conf[pre + i] ?? null;
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i++;
    else j++;
  }
  return out;
}

/** Builds per-character confidence for text from the worker's [text, probability] pairs. null if there are none */
export function charConfidence(text: string, tokens: readonly (readonly [string, number])[] | null | undefined): Confidence | null {
  if (!tokens?.length || !text) return null;
  let joined = '';
  const conf: number[] = [];
  for (const [piece, p] of tokens) {
    if (typeof piece !== 'string' || typeof p !== 'number' || !Number.isFinite(p)) return null;
    joined += piece;
    for (let k = 0; k < piece.length; k++) conf.push(Math.max(0, Math.min(1, p)));
  }
  return realign(joined, conf, text);
}

/** Confidence of a range (the minimum). null if it contains a character without confidence, or there is no confidence */
export function rangeConfidence(conf: readonly (number | null)[] | null | undefined, start: number, end: number): number | null {
  if (!conf || start >= end) return null;
  let min = 1;
  for (let i = start; i < end; i++) {
    const c = conf[i];
    if (c === null || c === undefined) return null;
    min = Math.min(min, c);
  }
  return min;
}

/** Minimum confidence over the content characters (letters and digits) of the utterance. null if no character has a confidence */
export function minContentConfidence(text: string, conf: readonly (number | null)[] | null | undefined): number | null {
  if (!conf) return null;
  let min: number | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = conf[i];
    if (c === null || c === undefined || !/[\p{L}\p{N}]/u.test(text[i])) continue;
    min = min === null ? c : Math.min(min, c);
  }
  return min;
}

/**
 * If the utterance has a character with lower confidence than this, it skips the fast path and goes to the LLM (llmReason low-confidence).
 *
 * A character below 0.3 almost always marks an error. Among evaluation utterances of 60 characters or less, 8 of the 9 with a character below 0.3 had an error next to it.
 * Characters from 0.3 up to 0.5 are no clue to errors. Of the 21 utterances whose low-confidence characters all fall in this range, 10 (48%) had errors,
 * hardly different from all utterances of 60 characters or less (42%), and only 6 had an error next to such a character.
 * Sending to the LLM adds 1.5-2 seconds, so the range that is no clue is not sent (docs/evaluation.md).
 */
export const LOW_CONFIDENCE = 0.3;
