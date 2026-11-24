/**
 * 書き起こしの語ごとの補正（textfix）の型。
 * LLM を通さない経路（近道、LLM なし、LLM の失敗）で貼る文を、決まった規則だけで直す。
 */

/** 規則の名前。a: カタカナを英字に、b: つなぎの言葉、c: 表記、d: 助詞 */
export type FixRule = 'latin' | 'fillers' | 'notation' | 'particles';

export const FIX_RULES: readonly FixRule[] = ['latin', 'fillers', 'notation', 'particles'];

/** 直した 1 か所。位置は入力の文字列（直す前）の添字 */
export interface FixEdit {
  rule: FixRule;
  start: number;
  end: number;
  before: string;
  after: string;
}

/** LLM に渡す用語集の候補（直さなかったが、英字の語かもしれない所） */
export interface LexiconCandidate {
  heard: string;
  word: string;
}

/** 単語分割の 1 語（IPADIC の品詞） */
export interface Token {
  /** 表層形 */
  surface: string;
  /** 入力の文字列での位置 [start, end) */
  start: number;
  end: number;
  /** 品詞（名詞、動詞、助詞、フィラーなど）と細分類 */
  pos: string;
  pos1: string;
  /** 基本形。分からなければ表層形 */
  base: string;
  /** 読み（カタカナ）。分からなければ空 */
  reading: string;
}

/** 同期で単語に分ける。読み込みが済んでいないときは null を返す */
export interface Tokenizer {
  tokenize(text: string): Token[] | null;
}

export interface FixInput {
  text: string;
  /** 設定の言語。日本語（ja）のときだけ直す */
  language: string;
  /** 規則ごとのオンとオフ。書いていない規則はオフ */
  rules: Partial<Record<FixRule, boolean>>;
  /** 触らない語句（利用者の辞書の語、置換のきっかけ、辞書照合の候補）。文中のすべての出現を守る */
  protectedPhrases?: readonly string[];
  /** 利用者の辞書の語（英字の綴りを優先し、段階 2 の語を直す条件にも使う） */
  vocabulary?: readonly string[];
  /** 入力先のアプリとブラウザのホスト名（段階 2 の語を直す条件に使う） */
  app?: { bundleId?: string; name?: string; host?: string };
  /** 利用者が「今後は直さない」を選んだ箇所（fixKey の形） */
  blocked?: readonly string[];
  /** 単語分割。なければ単語分割を使う規則を飛ばす */
  tokenizer?: Tokenizer | null;
  /** 文字ごとの確信度（0〜1、入力の文字列の添字ごと）。分からない文字は null。なければ確信度を使う規則を飛ばす */
  confidence?: readonly (number | null)[] | null;
  /** 規則 d で、Whisper が足した「を」を消すか（未指定なら規則の既定） */
  dropWo?: boolean;
}

export interface FixOutput {
  /** 直した文。直す所がなければ入力のまま */
  text: string;
  edits: FixEdit[];
  /** LLM への候補（段階 2 の語など、直さなかった所） */
  candidates: LexiconCandidate[];
  /** 飛ばした規則と理由（単語分割がない、など） */
  skipped: string[];
}

/** 「今後は直さない」の記録に使う形。規則と直す前の文字列で決める */
export function fixKey(edit: Pick<FixEdit, 'rule' | 'before'>): string {
  return `${edit.rule}:${edit.before}`;
}
