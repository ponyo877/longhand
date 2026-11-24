/**
 * Limits the effect of vocabulary hints to the places where the hints helped.
 *
 * Passing vocabulary hints (dictionary words) to whisper makes those words recognizable, but also changes the transcript in places
 * unrelated to the hints (a common word pulled toward a hint becomes a rare kanji name, for example). Utterances without any
 * dictionary word get more errors.
 *
 * So the same audio is transcribed twice, without and with hints. The transcript without hints is the base, and only these parts
 * are taken from the transcript with hints:
 * - places where a dictionary word newly appears
 * - places where a Latin-letter word newly appears (with Latin words among the hints, product names and the like come out in Latin letters)
 * For other differences, the version without hints is used.
 *
 * Evaluation results are in docs/evaluation.md. Transcribing twice takes correspondingly longer.
 */
import type { AsrHypothesis, AsrResultPayload } from '../../shared/asr-protocol';
import { diffHunks } from '../learn/diff';
import type { TranscribeOptions } from './AsrService';

/** always: always use the transcript with hints. selective: take only the places where the hints helped */
export type HintMode = 'always' | 'selective';

const key = (s: string) => s.normalize('NFKC').toLowerCase();
const hasLatinWord = (s: string) => /[A-Za-z]{2,}/.test(s);

/** Splits text into runs of the same kind of character (Latin-letter and digit words, katakana, kanji, hiragana, spaces; anything else one character at a time) */
export function scriptTokens(text: string): string[] {
  return text.match(/[A-Za-z0-9][A-Za-z0-9.+#'_-]*|[ァ-ヺー]+|[一-龠々〆ヶ]+|[ぁ-ゖ]+|\s+|./gsu) ?? [];
}

export interface SpliceResult {
  text: string;
  /** Number of places taken from the transcript with hints */
  taken: number;
}

/**
 * Uses the transcript without hints (plain) as the base and takes only the places where the hints helped from the transcript with
 * hints (hinted). vocabulary is the words passed as hints.
 */
export function spliceHinted(plain: string, hinted: string, vocabulary: readonly string[]): SpliceResult {
  if (plain === hinted || !hinted.trim()) return { text: plain, taken: 0 };
  // When nothing was recognized without hints, use the version with hints
  if (!plain.trim()) return { text: hinted, taken: 1 };
  const a = scriptTokens(plain);
  const b = scriptTokens(hinted);
  const hunks = diffHunks(a, b);
  if (!hunks) return { text: plain, taken: 0 };
  const words = vocabulary.map((w) => w.trim()).filter(Boolean);
  const out: string[] = [];
  let at = 0;
  let taken = 0;
  for (const h of hunks) {
    out.push(...a.slice(at, h.aStart));
    const from = a.slice(h.aStart, h.aEnd).join('');
    const to = b.slice(h.bStart, h.bEnd).join('');
    // A dictionary word newly appears here (including when only its letter case was fixed)
    const word = words.some((w) => key(to).includes(key(w)) && !from.normalize('NFKC').includes(w.normalize('NFKC')));
    // What was written in kana or kanji became a Latin-letter word
    const latin = hasLatinWord(to) && !hasLatinWord(from);
    if (word || latin) {
      out.push(to);
      taken++;
    } else {
      out.push(from);
    }
    at = h.aEnd;
  }
  out.push(...a.slice(at));
  return { text: out.join(''), taken };
}

/**
 * Transcribes twice and returns the result with only the places where the hints helped taken in.
 * run transcribes the same audio with the given options. hinted is the options with hints, plain the options without.
 * The confidence (tokens) returned is that of the transcript without hints (the confidence of the places taken in is treated as unknown).
 * When differences that were not taken in remain, the transcript with hints is attached as another hypothesis (hypotheses).
 * Formatting can use it to let the LLM choose at the differing places (the formatUncertain setting)
 */
export async function transcribeSelective(run: (opts: TranscribeOptions) => Promise<AsrResultPayload>, hinted: TranscribeOptions, plain: TranscribeOptions): Promise<AsrResultPayload> {
  const p = await run(plain);
  const h = await run(hinted);
  const elapsedMs = p.elapsedMs + h.elapsedMs;
  const counts = { hintsGiven: h.hintsGiven, hintsUsed: h.hintsUsed };
  const { text, taken } = spliceHinted(p.text, h.text, hinted.hints);
  // If taking everything in gives the transcript with hints, its confidence can be used as it is
  if (taken && text === h.text) return { ...h, elapsedMs };
  const hypotheses: AsrHypothesis[] = [...(p.hypotheses ?? [])];
  if (h.text.trim() && h.text !== text) hypotheses.push({ text: h.text, source: 'hinted', avgLogprob: 0 });
  const extra = hypotheses.length ? { hypotheses } : {};
  if (!taken) return { ...p, ...counts, ...extra, elapsedMs };
  return { ...p, ...counts, ...extra, text, elapsedMs, segments: undefined };
}
