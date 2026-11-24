import type { Replacement } from '../../shared/types';

const CJK = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

export function isCjk(ch: string | undefined): boolean {
  return !!ch && CJK.test(ch);
}

/** 比較用の正規化。空白と句読点と記号を除き、NFKC して小文字にする */
export function normalizeForCompare(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

// 「うん」は返事として本文になるので含めない（「はい」「ええ」も同じ）
export const FILLERS = /^(え+|えー+と?|えっと|えーっと|あの+ー*|あー+|うー+ん|まあ|ま+ー|なんか|その+ー*|um+|uh+|er+|ah+|hmm+)$/i;

/**
 * LLM を通さないとき（skipLlm、失敗、タイムアウト）の最低限の清書。
 * - CJK 文字どうしの間の空白を詰める（ASR が単語ごとに空白を入れる場合がある）
 * - 前後の空白を除く
 */
export function basicCleanup(raw: string): string {
  let s = raw.replace(/\r\n?/g, '\n').trim();
  // CJK と CJK の間の空白を詰める（2 回回して連続に対応）
  for (let i = 0; i < 2; i++) s = s.replace(new RegExp(`(${CJK.source}) +(?=${CJK.source})`, 'gu'), '$1');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s;
}

/** かなと漢字（記号は含まない） */
const JA = 'ぁ-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿々〆ヵヶ';
/** 日本語の全角の句読点と括弧 */
const JA_PUNCT = '、。，．？！：；…「」『』（）【】〔〕';

/** ターミナルとコードエディタ。コマンドの引数の空白を壊さないよう、和英間の空白を詰めない */
const CODE_APPS =
  /\b(terminal|iterm2?|warp|ghostty|wezterm|alacritty|kitty|hyper|tabby|xcode|visual studio code|code|vscodium|cursor|windsurf|zed|intellij|pycharm|webstorm|goland|rider|clion|rubymine|phpstorm|android studio|sublime text|nova|bbedit|neovim|vim|emacs)\b/i;

export function isCodeLikeApp(appName: string | undefined): boolean {
  return !!appName && CODE_APPS.test(appName);
}

export interface NormalizeOptions {
  /** 設定の言語（ja / en / auto） */
  language: string;
  /** 入力先がターミナルかコードエディタか */
  codeLike?: boolean;
}

/**
 * LLM の後と、LLM を通さないときに掛ける決定的な正規化（N1）。置換より前に掛ける。
 * - 日本語の文字どうしの間の空白を詰める
 * - かなと漢字の直後の半角の「? ! , .」を全角にする（「,」「.」は直後が空白か行末か、かなと漢字のときだけ。小数や URL を壊さない）
 * - ターミナルとコードエディタ以外では、日本語と英数字の間の空白を詰める（「Slack で」→「Slackで」）
 * 英語の設定では日本語の文字どうしの空白だけを詰める。
 */
export function normalizeText(text: string, opts: NormalizeOptions): string {
  let s = basicCleanup(text);
  if (!s || opts.language === 'en') return s;
  s = s
    .replace(new RegExp(`([${JA}])\\?`, 'gu'), '$1？')
    .replace(new RegExp(`([${JA}])!`, 'gu'), '$1！')
    .replace(new RegExp(`([${JA}]),(?=[ \\t]|$|[${JA}])`, 'gmu'), '$1、')
    .replace(new RegExp(`([${JA}])\\.(?=[ \\t]|$|[${JA}])`, 'gmu'), '$1。');
  if (!opts.codeLike) {
    s = s.replace(new RegExp(`([${JA}${JA_PUNCT}])[ \\t]+(?=[A-Za-z0-9])`, 'gu'), '$1').replace(new RegExp(`([A-Za-z0-9])[ \\t]+(?=[${JA}${JA_PUNCT}])`, 'gu'), '$1');
  }
  // 全角にした記号の直後の空白などを、もう一度詰める
  for (let i = 0; i < 2; i++) s = s.replace(new RegExp(`(${CJK.source})[ \\t]+(?=${CJK.source})`, 'gu'), '$1');
  return s.replace(/[ \t]+\n/g, '\n');
}

/** 意味のある内容があるか（フィラーと句読点だけなら false） */
export function hasSubstance(raw: string): boolean {
  const tokens = raw
    .split(/[\s、。,.!?！？…]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.some((t) => !FILLERS.test(t));
}

/**
 * LLM が整形ではなく応答を返した疑いを検査する（長さの比率）。
 * 生テキストが短いときは比率がぶれるので見ない。
 */
export function looksLikeAnswer(raw: string, out: string): boolean {
  const r = normalizeForCompare(raw).length;
  const o = normalizeForCompare(out).length;
  if (r < 10) return o > r * 4 + 30;
  return o < r * 0.3 || o > r * 3 + 20;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 置換のきっかけの語句を比べるための鍵（NFKC、小文字、空白なし）。重複の検出に使う。
 * renderer/management/Style.tsx に同じ定義の写しがある（renderer は main を読み込まないため）。変えるときは両方を変える
 */
export function replacementTriggerKey(from: string): string {
  return from.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 1 文字を、半角と全角のどちらにも一致するパターンにする */
function charPattern(c: string): string {
  const code = c.codePointAt(0)!;
  if (code >= 0x21 && code <= 0x7e) {
    const full = String.fromCodePoint(code + 0xfee0);
    return `[${c.replace(/[\]\\^-]/g, '\\$&')}${full}]`;
  }
  return escapeRegExp(c);
}

const PUNCT_AFTER = '[。、．，.,!?！？]';

interface CompiledReplacement {
  r: Replacement;
  re: RegExp;
  /** きっかけの長さ（空白を除く）。長いものから試す */
  size: number;
}

function compileReplacement(r: Replacement): CompiledReplacement | null {
  const from = r.from.trim().normalize('NFKC');
  if (!from) return null;
  let pattern: string;
  if (/^[\w\s.-]+$/.test(from)) {
    // 英数字の語は単語境界で一致させる（"api" が "rapid" に一致しないように）
    const body = from
      .split(/\s+/)
      .map((w) => [...w].map(charPattern).join(''))
      .join('\\s+');
    pattern = `(?<![\\w])${body}(?![\\w])`;
  } else {
    // それ以外は、文字の間に空白が 1 つ入っていても一致させる（音声認識が空白を入れることがある）
    pattern = [...from.replace(/\s+/g, '')].map(charPattern).join('[ \\t\\u3000]?');
  }
  if (r.noPunctuation) pattern += `${PUNCT_AFTER}?`;
  return { r, re: new RegExp(pattern, 'iuy'), size: [...from.replace(/\s+/g, '')].length };
}

/** 直前までの出力から見て、文の始まりか（本文の先頭、文末記号か改行の直後） */
function atSentenceStart(out: string): boolean {
  const prev = out.replace(/[ \t\u3000]+$/, '');
  return prev === '' || /[。．.!?！？\n]$/.test(prev);
}

/**
 * 置換表を適用する（FMT-7、CUS-2）。LLM と正規化の後に決定的に適用する。
 * - 本文を先頭から 1 回だけ走査する。各位置で長いきっかけから順に試し、一致したら置換後を出力して一致した分だけ進む。
 *   置換後の文字列は走査し直さない（置換が連鎖しない。表の並び順にもよらない）
 * - 大文字小文字、全角と半角の違いは区別しない。英数字だけのきっかけは単語境界で一致させ、
 *   それ以外のきっかけは文字の間の空白 1 つを許す
 * - preserveCase がオン（既定）: 置換後の文字列を書いたとおりに入れる
 * - preserveCase がオフ: 文頭に入り、置換後の先頭が英小文字なら、その 1 文字を大文字にする
 * - noPunctuation: きっかけの直後にある句読点 1 文字を取り除く
 */
export function applyReplacements(text: string, replacements: Replacement[]): string {
  const compiled = replacements
    .map(compileReplacement)
    .filter((c): c is CompiledReplacement => c !== null)
    .sort((a, b) => b.size - a.size);
  if (!compiled.length || !text) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    let hit: { c: CompiledReplacement; len: number } | null = null;
    for (const c of compiled) {
      c.re.lastIndex = i;
      const m = c.re.exec(text);
      if (m && m[0].length > 0) {
        hit = { c, len: m[0].length };
        break;
      }
    }
    if (hit) {
      const to = hit.c.r.to;
      out += !hit.c.r.preserveCase && /^[a-z]/.test(to) && atSentenceStart(out) ? to[0].toUpperCase() + to.slice(1) : to;
      i += hit.len;
    } else {
      const ch = String.fromCodePoint(text.codePointAt(i)!);
      out += ch;
      i += ch.length;
    }
  }
  return out;
}

/** 本文に日本語の文字（かな、漢字、全角の記号）が含まれるか */
function hasCjk(s: string): boolean {
  return CJK.test(s);
}

/**
 * カーソル前後の文字に合わせて半角スペースを足す（PST-5、N2）。日本語の文字の隣には足さない。
 * - 先頭: 直前が日本語の文字でも空白でもない英数字か閉じ記号（`!%),.:;>?]}`）で、本文が英数字か「(」で始まるとき
 * - 末尾（本文に日本語が無いとき）: 直後が英数字のとき、または入力欄の末尾（after が空文字）のとき。
 *   続けて英語を話したときに文がくっつかないようにする。after が不明（undefined）なら足さない
 * - 末尾（本文に日本語があるとき）: 直後が英数字で、本文が英数字か文末記号で終わるときだけ
 */
export function applySpacing(text: string, before: string | undefined, after: string | undefined): string {
  if (!text) return text;
  let out = text;
  const prev = before ? before[before.length - 1] : undefined;
  const next = after ? after[0] : undefined;
  const first = out[0];
  const last = out[out.length - 1];
  const wordish = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c) && !isCjk(c);
  const space = (c: string | undefined) => !!c && /\s/.test(c);
  if (prev && !space(prev) && !isCjk(prev) && /[\p{L}\p{N}!%),.:;>?\]}]/u.test(prev) && !isCjk(first) && (wordish(first) || first === '(')) {
    out = ' ' + out;
  }
  if (space(last) || isCjk(last) || space(next) || isCjk(next)) return out;
  if (!hasCjk(text)) {
    if ((next === undefined && after === '') || wordish(next)) out = out + ' ';
  } else if (wordish(next) && (wordish(last) || /[.!?:;,]/.test(last))) {
    out = out + ' ';
  }
  return out;
}

/** LLM の出力から JSON を取り出す。コードブロックで囲まれていたり前後に文章があっても拾う */
export function parseJsonObject(output: string): Record<string, unknown> | null {
  const s = output
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const tryParse = (x: string) => {
    try {
      const v = JSON.parse(x);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(s);
  if (direct) return direct;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(s.slice(start, end + 1));
  return null;
}

/** 区切りごとの書き起こしをつなぐ。日本語は空白なしでつなぎ、英数字どうしが隣り合うときだけ空白を入れる */
export function joinTexts(parts: string[], language: string): string {
  const trimmed = parts.map((p) => p.trim()).filter(Boolean);
  if (language === 'en') return trimmed.join(' ');
  return trimmed.reduce((acc, p) => (acc && /[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(p) ? `${acc} ${p}` : acc + p), '');
}
