/**
 * 音声認識（Whisper）に渡すプロンプトの文を組み立てる。
 *
 * Whisper は指示には従わない。プロンプトを「直前に話された文」として読み、その文体と語をまねる。
 * そのため、辞書の語を並べただけの文より、句読点のある自然な文に語を埋めたほうが、
 * 語の当たりと全体の精度の両方に効くという報告がある（語の列挙は、珍しい語は当たるが全体を悪くすることがある）。
 * また、使われるのはプロンプトの末尾の約 220 トークンだけなので、大事な語ほど後ろ（音声のすぐ前）に置く。
 *
 * ここでは文字列を作るだけで、どの語を選ぶかは hints.ts が決める。最後の切り詰め（トークン数）はワーカーが行う。
 */

/** list: 語を「、」で並べた 1 文（従来の形）。sentence: 丁寧な書き言葉の文。spoken: 話し言葉に近い文 */
export type PromptStyle = 'list' | 'sentence' | 'spoken';

export const PROMPT_STYLES: readonly PromptStyle[] = ['list', 'sentence', 'spoken'];

export interface AsrPromptOptions {
  style: PromptStyle;
  /** 入れる語の数の上限 */
  maxTerms?: number;
  /** 大事な語を後ろに置く。既定は true */
  importantLast?: boolean;
  /** 語の部分の字数の上限（おおよその目安） */
  maxChars?: number;
  /** 直前の文脈（前の区間の書き起こしなど）。あれば最後に置く */
  context?: string;
}

type Template = (terms: string[]) => string;

/** 語を 1〜3 個ずつ埋める文。順に使い回す（同じ入力からは同じ文になる） */
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
 * プロンプトの文を作る。terms は大事な順（先頭がいちばん大事）で渡す。
 * 語が無く、文脈も無ければ空文字列を返す。
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
  // 大事な語を後ろに置くときは、並びを逆にしてから文にする
  const ordered = (opts.importantLast ?? true) ? [...picked].reverse() : picked;
  const context = opts.context?.trim() ?? '';

  let body = '';
  if (ordered.length) {
    if (opts.style === 'list') {
      // 字数を超えるときは、大事でない側の語を落とす
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
      // 字数を超えるときは、大事でない側の文から落とす
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
