/**
 * Builds the prompt text for speech recognition (Whisper).
 *
 * Whisper does not follow instructions. It reads the prompt as the text spoken just before and imitates its style and words.
 * So there are reports that embedding words in natural, punctuated sentences helps both term hits and overall accuracy
 * more than a bare list of dictionary words (a list gets rare words right but can make everything else worse).
 * Also, only the last ~220 tokens of the prompt are used, so the more important a word, the later it goes (right before the audio).
 *
 * This module only builds the string. hints.ts decides which words to use, and the worker does the final truncation (by tokens).
 */

/** list: one sentence of words separated by 「、」 (the original form). sentence: polite written sentences. spoken: sentences closer to speech */
export type PromptStyle = 'list' | 'sentence' | 'spoken';

export const PROMPT_STYLES: readonly PromptStyle[] = ['list', 'sentence', 'spoken'];

export interface AsrPromptOptions {
  style: PromptStyle;
  /** Maximum number of words */
  maxTerms?: number;
  /** Put important words last. true by default */
  importantLast?: boolean;
  /** Maximum length in characters of the word part (a rough guide) */
  maxChars?: number;
  /** Preceding context (the transcript of the previous segment, for example). Goes last if present */
  context?: string;
}

type Template = (terms: string[]) => string;

/** Sentences that hold 1-3 words each. Used in rotation (the same input gives the same sentences) */
const TEMPLATES: Record<Exclude<PromptStyle, 'list'>, Record<1 | 2 | 3, Template[]>> = {
  sentence: {
    1: [([a]) => `${a}について確認します。`, ([a]) => `${a}を使っています。`, ([a]) => `${a}の件です。`],
    2: [([a, b]) => `${a}と${b}を使っています。`, ([a, b]) => `${a}の件は、${b}で確認しました。`, ([a, b]) => `${a}から${b}に移しました。`],
    3: [([a, b, c]) => `${a}、${b}、${c}を使っています。`, ([a, b, c]) => `${a}と${b}は、${c}にまとめました。`, ([a, b, c]) => `${a}の件は、${b}と${c}で確認します。`],
  },
  spoken: {
    1: [([a]) => `${a}の話なんですけど、確認してもらえますか。`, ([a]) => `${a}を使ってます。`, ([a]) => `あとで${a}を見ておきます。`],
    2: [([a, b]) => `${a}と${b}を使ってます。`, ([a, b]) => `${a}の件、${b}で見ておいてください。`, ([a, b]) => `${a}から${b}に移そうと思ってます。`],
    3: [([a, b, c]) => `${a}とか${b}とか${c}を使ってます。`, ([a, b, c]) => `${a}と${b}は、${c}にまとめておきました。`, ([a, b, c]) => `${a}の件、${b}と${c}で確認します。`],
  },
};

const length = (s: string) => Array.from(s).length;

/**
 * Builds the prompt text. Pass terms in order of importance (the first is the most important).
 * Returns an empty string when there are no words and no context.
 */
export function buildAsrPrompt(terms: readonly string[], opts: AsrPromptOptions): string {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const t of terms) {
    const w = t.trim();
    const k = w.normalize('NFKC').toLowerCase();
    if (!w || seen.has(k)) continue;
    seen.add(k);
    picked.push(w);
    if (picked.length >= (opts.maxTerms ?? 64)) break;
  }
  const maxChars = opts.maxChars ?? 400;
  // To put important words last, reverse the order before building sentences
  const ordered = (opts.importantLast ?? true) ? [...picked].reverse() : picked;
  const context = opts.context?.trim() ?? '';

  let body = '';
  if (ordered.length) {
    if (opts.style === 'list') {
      // Over the length limit, drop words from the less important end
      let list = ordered;
      const drop = (opts.importantLast ?? true) ? (l: string[]) => l.slice(1) : (l: string[]) => l.slice(0, -1);
      while (list.length > 1 && length(`${list.join('、')}。`) > maxChars) list = drop(list);
      body = `${list.join('、')}。`;
    } else {
      const pool = TEMPLATES[opts.style];
      const sentences: string[] = [];
      for (let i = 0, n = 0; i < ordered.length; i += 3, n++) {
        const chunk = ordered.slice(i, i + 3);
        const templates = pool[chunk.length as 1 | 2 | 3];
        sentences.push(templates[n % templates.length](chunk));
      }
      // Over the length limit, drop sentences from the less important end
      const fromHead = opts.importantLast ?? true;
      while (sentences.length > 1 && length(sentences.join('')) > maxChars) {
        if (fromHead) sentences.shift();
        else sentences.pop();
      }
      body = sentences.join('');
    }
  }
  return body + context;
}
