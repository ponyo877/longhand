import type { Replacement } from '../../shared/types';

const CJK = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

export function isCjk(ch: string | undefined): boolean {
  return !!ch && CJK.test(ch);
}

/** Normalization for comparison. Removes whitespace, punctuation and symbols, applies NFKC and lowercases */
export function normalizeForCompare(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

// 「うん」 is left out because as a reply it is part of the text (same for 「はい」 and 「ええ」)
export const FILLERS = /^(え+|えー+と?|えっと|えーっと|あの+ー*|あー+|うー+ん|まあ|ま+ー|なんか|その+ー*|um+|uh+|er+|ah+|hmm+)$/i;

/**
 * Minimal cleanup when the LLM is skipped (skipLlm, failure, timeout).
 * - Removes spaces between CJK characters (ASR sometimes puts a space after each word)
 * - Trims leading and trailing whitespace
 */
export function basicCleanup(raw: string): string {
  let s = raw.replace(/\r\n?/g, '\n').trim();
  // Remove spaces between CJK characters (run twice to handle consecutive ones)
  for (let i = 0; i < 2; i++) s = s.replace(new RegExp(`(${CJK.source}) +(?=${CJK.source})`, 'gu'), '$1');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s;
}

/** Kana and kanji (no symbols) */
const JA = 'ぁ-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿々〆ヵヶ';
/** Japanese full-width punctuation and brackets */
const JA_PUNCT = '、。，．？！：；…「」『』（）【】〔〕';

/** Terminals and code editors. Spaces between Japanese and Latin text are kept so command arguments are not broken */
const CODE_APPS =
  /\b(terminal|iterm2?|warp|ghostty|wezterm|alacritty|kitty|hyper|tabby|xcode|visual studio code|code|vscodium|cursor|windsurf|zed|intellij|pycharm|webstorm|goland|rider|clion|rubymine|phpstorm|android studio|sublime text|nova|bbedit|neovim|vim|emacs)\b/i;

export function isCodeLikeApp(appName: string | undefined): boolean {
  return !!appName && CODE_APPS.test(appName);
}

export interface NormalizeOptions {
  /** Language setting (ja / en / auto) */
  language: string;
  /** Whether the target is a terminal or code editor */
  codeLike?: boolean;
}

/**
 * Deterministic normalization (N1) applied after the LLM and when the LLM is skipped. Runs before replacements.
 * - Removes spaces between Japanese characters
 * - Makes half-width 「? ! , .」 full-width right after kana or kanji (「,」 and 「.」 only when followed by whitespace, end of line, kana or kanji, so decimals and URLs stay intact)
 * - Except in terminals and code editors, removes spaces between Japanese and Latin letters or digits (「Slack で」→「Slackで」)
 * With the English setting, only spaces between Japanese characters are removed.
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
  // Remove again any spaces left right after the symbols made full-width
  for (let i = 0; i < 2; i++) s = s.replace(new RegExp(`(${CJK.source})[ \\t]+(?=${CJK.source})`, 'gu'), '$1');
  return s.replace(/[ \t]+\n/g, '\n');
}

/** Whether there is meaningful content (false if only fillers and punctuation) */
export function hasSubstance(raw: string): boolean {
  const tokens = raw
    .split(/[\s、。,.!?！？…]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.some((t) => !FILLERS.test(t));
}

/**
 * Checks for signs that the LLM answered instead of formatting (length ratio).
 * Skipped for short raw text, where the ratio is unreliable.
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
 * Key for comparing replacement trigger phrases (NFKC, lowercase, no whitespace). Used to detect duplicates.
 * renderer/management/Style.tsx has a copy of the same definition (the renderer does not import main). Change both together
 */
export function replacementTriggerKey(from: string): string {
  return from.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** Turns one character into a pattern that matches both its half-width and full-width forms */
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
  /** Length of the trigger (without whitespace). Longer ones are tried first */
  size: number;
}

function compileReplacement(r: Replacement): CompiledReplacement | null {
  const from = r.from.trim().normalize('NFKC');
  if (!from) return null;
  let pattern: string;
  if (/^[\w\s.-]+$/.test(from)) {
    // Match Latin words on word boundaries (so "api" does not match "rapid")
    const body = from
      .split(/\s+/)
      .map((w) => [...w].map(charPattern).join(''))
      .join('\\s+');
    pattern = `(?<![\\w])${body}(?![\\w])`;
  } else {
    // Otherwise, match even with one space between characters (speech recognition sometimes adds spaces)
    pattern = [...from.replace(/\s+/g, '')].map(charPattern).join('[ \\t\\u3000]?');
  }
  if (r.noPunctuation) pattern += `${PUNCT_AFTER}?`;
  return { r, re: new RegExp(pattern, 'iuy'), size: [...from.replace(/\s+/g, '')].length };
}

/** Whether the output so far ends at a sentence start (start of the text, or right after a sentence-ending mark or newline) */
function atSentenceStart(out: string): boolean {
  const prev = out.replace(/[ \t\u3000]+$/, '');
  return prev === '' || /[。．.!?！？\n]$/.test(prev);
}

/**
 * Applies the replacement table (FMT-7, CUS-2). Applied deterministically after the LLM and normalization.
 * - Scans the text once from the start. At each position, tries the longest triggers first; on a match, outputs the replacement and advances past the match.
 *   Replacement text is not scanned again (replacements do not chain and do not depend on the table order)
 * - Case and full-width/half-width differences are ignored. Triggers of only Latin letters and digits match on word boundaries;
 *   other triggers allow one space between characters
 * - preserveCase on (default): inserts the replacement exactly as written
 * - preserveCase off: at a sentence start, capitalizes the first letter of the replacement if it is a lowercase Latin letter
 * - noPunctuation: removes one punctuation character right after the trigger
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

/** Whether the text contains Japanese characters (kana, kanji, full-width symbols) */
function hasCjk(s: string): boolean {
  return CJK.test(s);
}

/**
 * Adds half-width spaces to fit the characters around the cursor (PST-5, N2). Never next to Japanese characters.
 * - Start: when the character before is a letter, digit or closing mark (`!%),.:;>?]}`) that is neither Japanese nor whitespace, and the text starts with a letter, digit or 「(」
 * - End (text without Japanese): when the next character is a letter or digit, or at the end of the field (after is an empty string).
 *   Keeps sentences from running together when the user keeps speaking English. Nothing is added if after is unknown (undefined)
 * - End (text with Japanese): only when the next character is a letter or digit and the text ends with a letter, digit or sentence-ending mark
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

/** Extracts JSON from the LLM output. Works even when it is wrapped in a code block or surrounded by prose */
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

/** Joins per-segment transcripts. Japanese is joined without spaces; a space goes in only between adjacent Latin letters or digits */
export function joinTexts(parts: string[], language: string): string {
  const trimmed = parts.map((p) => p.trim()).filter(Boolean);
  if (language === 'en') return trimmed.join(' ');
  return trimmed.reduce((acc, p) => (acc && /[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(p) ? `${acc} ${p}` : acc + p), '');
}
