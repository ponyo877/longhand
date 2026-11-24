/**
 * Fast path that skips the LLM (N6).
 * For short utterances whose recognition result is already clean, calling the LLM often changes nothing.
 * Only such utterances are picked out by deterministic rules, and the normalized (N1) raw text becomes the result as is.
 *
 * The rules lean to the safe side. If the LLM might be needed at all, the utterance goes to the LLM.
 * The checks run on the text after normalization.
 */
import { replacementTriggerKey } from './postprocess';

export interface FastPathContext {
  mode: 'dictation' | 'edit';
  /** Language setting (ja / en / auto) */
  language: string;
  customInstructions: string;
  /** Replacement trigger phrases */
  protectedPhrases?: readonly string[];
  /** Dictionary words (to check whether Latin words are spelled as in the dictionary) */
  vocabulary?: readonly string[];
  /** Dictionary word candidates (G4-11). If there are any, the LLM decides */
  dictionaryCandidates?: readonly unknown[];
  /** Some characters have low recognition confidence (textfix confidence). A mishearing is likely, so the LLM decides */
  lowConfidence?: boolean;
  beforeCursor?: string;
  afterCursor?: string;
}

export const FAST_PATH_MAX_CHARS = 60;

/** Hesitation sounds. Searched for anywhere in the text */
export const FILLER_IN_TEXT = /(えー|えっと|ええと|えと[、。]|あのー|あの[、。]|あのね|うーん|うーむ|まあ|なんか|そのー|その[、。]|あー|んー|\bum+\b|\buh+\b|\bhmm+\b)/i;
/** Signs of self-repair */
export const SELF_REPAIR = /(いや|じゃなくて|じゃなく|ではなくて|ではなく|じゃない[、。]|間違え|まちがえ|訂正|言い直|いいなお|やっぱ|違う[、。]|ちがう)/;
/** Spoken symbols and formatting */
const SPOKEN_FORMAT = /(改行|段落|箇条書き|かっこ|カッコ|括弧|まる|マル|てん|テン|句点|読点|びっくり|はてな|コロン|スラッシュ|ハイフン|ドット)/;
/** A run of 3 or more katakana (a product name or dictionary word may have come out in katakana) */
const KATAKANA_RUN = /[ァ-ヺー]{3,}/;
/** Kanji numerals. They may need to become Arabic numerals */
const KANJI_DIGITS = /[〇一二三四五六七八九十百千万億](?=[時分秒日月年回個件人円%％つ])/;
/** Sentence endings. A complete ending (。？) or a trailing-off ending (けど, が, ので, んで) */
const GOOD_END = /(。|？|けど|けれど|けれども|が|ので|んで)$/;
/** A trailing-off ending followed by 「。」 (breaks rule 9) */
const TRAILING_CONJ_WITH_PERIOD = /(けど|けれど|けれども|ので|んで|が)。$/;
/** A question ending in 「。」, or a musing ending in 「？」 (needs the judgment of rule 6) */
const QUESTION_MISMATCH = /(か。|っけ。|(かな|かね|だろう|でしょう|よね|かも)？)$/;
/** Whether the insertion point is mid-sentence (the text before it ends neither a sentence nor a line) */
const SENTENCE_BOUNDARY_BEFORE = /(^|[。？！.!?\n])\s*$/;

/**
 * Returns the reason to send the text to the LLM. null means the LLM is not needed (the fast path may be taken).
 * Returns the reason as a string so that eval can count cases per reason.
 */
export function llmReason(text: string, ctx: FastPathContext): string | null {
  if (ctx.mode !== 'dictation') return 'mode';
  if (ctx.language === 'en') return 'language';
  if (!/[ぁ-ゟ]/.test(text)) return 'no-hiragana';
  if (ctx.customInstructions.trim()) return 'custom-instructions';
  const len = [...text].length;
  if (len < 2 || len > FAST_PATH_MAX_CHARS) return 'length';
  if (/\n/.test(text)) return 'newline';
  if (/\s/.test(text)) return 'space';
  if (/[!！]/.test(text)) return 'exclamation';
  if (/\?/.test(text)) return 'half-width-question';
  if (!GOOD_END.test(text)) return 'ending';
  if (TRAILING_CONJ_WITH_PERIOD.test(text)) return 'period-after-conjunction';
  if (QUESTION_MISMATCH.test(text)) return 'question';
  if (FILLER_IN_TEXT.test(text)) return 'filler';
  if (SELF_REPAIR.test(text)) return 'self-repair';
  if (SPOKEN_FORMAT.test(text)) return 'spoken-format';
  if (ctx.lowConfidence) return 'low-confidence';
  if (KATAKANA_RUN.test(text)) return 'katakana';
  if (KANJI_DIGITS.test(text)) return 'kanji-digits';
  const latin = text.match(/[A-Za-z][A-Za-z0-9.+#-]*/g) ?? [];
  if (latin.length) {
    const vocab = new Set((ctx.vocabulary ?? []).map((w) => w.trim()));
    if (latin.some((w) => !vocab.has(w))) return 'latin';
  }
  if (ctx.dictionaryCandidates?.length) return 'dictionary-candidate';
  const key = replacementTriggerKey(text);
  if ((ctx.protectedPhrases ?? []).some((p) => p.trim() && key.includes(replacementTriggerKey(p)))) return 'replacement';
  if (ctx.beforeCursor && /\S/.test(ctx.beforeCursor) && !SENTENCE_BOUNDARY_BEFORE.test(ctx.beforeCursor)) return 'mid-sentence';
  if (ctx.afterCursor && /^[^\s]/.test(ctx.afterCursor)) return 'mid-sentence';
  return null;
}

/** Whether the LLM is needed. If false, the normalized raw text may be the result as is */
export function needsLlm(text: string, ctx: FastPathContext): boolean {
  return llmReason(text, ctx) !== null;
}
