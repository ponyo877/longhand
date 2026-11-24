/**
 * LLM を飛ばす近道（N6）。
 * 音声認識の結果がすでに整っている短い発話は、LLM を呼んでも結果が変わらないことが多い。
 * そうした発話だけを決定的な規則で見分け、正規化（N1）した生テキストをそのまま結果にする。
 *
 * 規則は安全側に倒してある。少しでも LLM の手が要りそうなら LLM に回す。
 * 判定は正規化の後の文字列に対して行う。
 */
import { replacementTriggerKey } from './postprocess';

export interface FastPathContext {
  mode: 'dictation' | 'edit';
  /** 設定の言語（ja / en / auto） */
  language: string;
  customInstructions: string;
  /** 置換のきっかけの語句 */
  protectedPhrases?: readonly string[];
  /** 辞書の語（英字の語の表記が辞書と同じかを見る） */
  vocabulary?: readonly string[];
  /** 辞書の語の候補（G4-11）。候補があれば LLM に判断させる */
  dictionaryCandidates?: readonly unknown[];
  /** 音声認識の確信度の低い字がある（textfix の確信度）。聞き違いがありそうなので LLM に判断させる */
  lowConfidence?: boolean;
  beforeCursor?: string;
  afterCursor?: string;
}

export const FAST_PATH_MAX_CHARS = 60;

/** 言いよどみの音。文中も含めて探す */
export const FILLER_IN_TEXT = /(えー|えっと|ええと|えと[、。]|あのー|あの[、。]|あのね|うーん|うーむ|まあ|なんか|そのー|その[、。]|あー|んー|\bum+\b|\buh+\b|\bhmm+\b)/i;
/** 言い直しの印 */
export const SELF_REPAIR = /(いや|じゃなくて|じゃなく|ではなくて|ではなく|じゃない[、。]|間違え|まちがえ|訂正|言い直|いいなお|やっぱ|違う[、。]|ちがう)/;
/** 記号や書式の読み上げ */
const SPOKEN_FORMAT = /(改行|段落|箇条書き|かっこ|カッコ|括弧|まる|マル|てん|テン|句点|読点|びっくり|はてな|コロン|スラッシュ|ハイフン|ドット)/;
/** 3 字以上のカタカナの連続（製品名や辞書の語がカタカナで出ている可能性がある） */
const KATAKANA_RUN = /[ァ-ヺー]{3,}/;
/** 漢数字。算用数字に直す必要があるかもしれない */
const KANJI_DIGITS = /[〇一二三四五六七八九十百千万億](?=[時分秒日月年回個件人円%％つ])/;
/** 文の終わり方。言い切り（。？）か、言いさし（けど、が、ので、んで） */
const GOOD_END = /(。|？|けど|けれど|けれども|が|ので|んで)$/;
/** 言いさしなのに「。」が付いている（規則 9 に反する） */
const TRAILING_CONJ_WITH_PERIOD = /(けど|けれど|けれども|ので|んで|が)。$/;
/** 尋ねる文なのに「。」で終わっている、または独り言なのに「？」で終わっている（規則 6 の判断が要る） */
const QUESTION_MISMATCH = /(か。|っけ。|(かな|かね|だろう|でしょう|よね|かも)？)$/;
/** 文の途中に差し込む位置か（直前が文の終わりでも改行でもない） */
const SENTENCE_BOUNDARY_BEFORE = /(^|[。？！.!?\n])\s*$/;

/**
 * LLM に回す理由を返す。null なら LLM は要らない（近道に入れてよい）。
 * eval で理由ごとの件数を数えるために、理由を文字列で返す。
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

/** LLM が要るか。false なら、正規化した生テキストをそのまま結果にしてよい */
export function needsLlm(text: string, ctx: FastPathContext): boolean {
  return llmReason(text, ctx) !== null;
}
