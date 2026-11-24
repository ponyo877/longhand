/**
 * Rewrites numbers to the notation the user prefers (learned in main/learn/numberStyle.ts).
 *
 * The rules only touch spans whose meaning is clear from the surrounding characters: a counter or unit after the number,
 * a currency sign before it, a complete date or time. Numbers inside product names, versions, URLs and codes are left alone.
 * The formatter prompt describes the same preferences, so the LLM can handle the cases these rules skip.
 */
import { NUMBER_STYLE_KINDS, type NumberStyleKind, type NumberStyles } from '../../shared/numberStyle';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (list: readonly string[]) =>
  [...list]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');

/** Counters and units that mark a number as an amount or a quantity (where separators and 万/億 are used) */
export const QUANTITY_UNITS = [
  '円',
  'ドル',
  'ユーロ',
  'ポンド',
  'ウォン',
  '元',
  '人',
  '名',
  '件',
  '個',
  '回',
  '台',
  '本',
  '枚',
  '冊',
  '社',
  '店',
  '点',
  '票',
  '株',
  '部',
  '通',
  '杯',
  '匹',
  '頭',
  '羽',
  '箱',
  '袋',
  '軒',
  '戸',
  '字',
  '文字',
  '行',
  '語',
  '歩',
  '倍',
  '曲',
  '世帯',
  'ページ',
  'ポイント',
  'ユーザー',
  '時間',
  '日間',
  '週間',
  'か月',
  'ヶ月',
  'カ月',
  '年間',
] as const;

const LATIN_UNITS = ['km', 'kg', 'mg', 'cm', 'mm', 'm', 'g', 't', 'KB', 'MB', 'GB', 'TB', 'pt', 'px', 'mL', 'ml', 'L'] as const;

const JA_UNIT = `(?:${alternation(QUANTITY_UNITS)})`;
const ANY_UNIT = `(?:${JA_UNIT}|万|億|兆|(?:${alternation(LATIN_UNITS)})(?![A-Za-z]))`;
const CURRENCY = '[¥￥$€£]';
/** A rewritten number must not continue a code, version, URL or another number */
const START = '(?<![0-9０-９,.，．/:：#A-Za-z_\\-])';

// --- Width ----------------------------------------------------------------------------

// A percent sign right after the digits follows their width
const HALF_RUN = /(?<![A-Za-z_\-./:#@0-9])[0-9]+(?:[,.:/][0-9]+)*%?(?![A-Za-z_\-0-9])/g;
const FULL_RUN = /[０-９]+(?:[，．：／][０-９]+)*％?/g;

const toFull = (s: string) => s.replace(/[0-9,.:/%]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const toHalf = (s: string) => s.replace(/[０-９，．：／％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// --- Thousands separators -------------------------------------------------------------

// The part after 万 or 億 ("1万2000円") is not grouped
const PLAIN_BEFORE_UNIT = new RegExp(`${START}(?<![万億兆])([0-9]{4,})(?=(?:\\.[0-9]+)?${ANY_UNIT})`, 'g');
const PLAIN_AFTER_CURRENCY = new RegExp(`(?<=${CURRENCY})([0-9]{4,})(?![0-9,])`, 'g');
const GROUPED_BEFORE_UNIT = new RegExp(`${START}(?<![万億兆])([0-9]{1,3}(?:,[0-9]{3})+)(?=(?:\\.[0-9]+)?${ANY_UNIT})`, 'g');
const GROUPED_AFTER_CURRENCY = new RegExp(`(?<=${CURRENCY})([0-9]{1,3}(?:,[0-9]{3})+)(?![0-9])`, 'g');

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// --- 万 and 億 ------------------------------------------------------------------------

const ROUND_BEFORE_UNIT = new RegExp(`${START}([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?=${JA_UNIT})`, 'g');
const TERM = '([0-9][0-9,]*(?:\\.[0-9]+)?)';
const WITH_UNITS = new RegExp(`${START}(?=[0-9])(?:${TERM}兆)?(?:${TERM}億)?(?:${TERM}万)?([0-9][0-9,]*)?(?![0-9,.万億兆千百十〇一二三四五六七八九])`, 'g');

/** "1.5" scaled by 10^exp as an integer, or null when the result would not be an integer */
function scaled(term: string | undefined, exp: number): number | null {
  if (!term) return 0;
  const [int, frac = ''] = term.replace(/,/g, '').split('.');
  if (frac.length > exp) return null;
  const n = Number(int + frac.padEnd(exp, '0'));
  return Number.isSafeInteger(n) ? n : null;
}

function toKanjiUnits(_m: string, digits: string): string {
  const v = Number(digits.replace(/,/g, ''));
  if (!Number.isSafeInteger(v) || v < 10_000) return _m;
  if (v % 1e12 === 0) return `${v / 1e12}兆`;
  if (v % 1e8 === 0 && v < 1e12) return `${v / 1e8}億`;
  if (v % 1e4 === 0 && v < 1e8) return `${v / 1e4}万`;
  return _m;
}

function fromKanjiUnits(m: string, cho?: string, oku?: string, man?: string, rest?: string): string {
  if (!cho && !oku && !man) return m;
  const parts = [scaled(cho, 12), scaled(oku, 8), scaled(man, 4), scaled(rest, 0)];
  if (parts.some((p) => p === null)) return m;
  const [c, o, w, r] = parts as number[];
  // Each part must fit below the next larger unit ("1億20000万" is not a number)
  if ((cho && (oku || man || rest) && o + w + r >= 1e12) || (oku && w + r >= 1e8) || (man && r >= 1e4)) return m;
  const total = c + o + w + r;
  return Number.isSafeInteger(total) ? String(total) : m;
}

// --- Counters -------------------------------------------------------------------------

const KANJI_DIGITS = '〇一二三四五六七八九';
const DIGIT_TSU = /(?<![0-9０-９,.\p{Script=Han}])([1-9])つ/gu;
const DIGIT_NIN = /(?<![0-9０-９,.\p{Script=Han}])([12])人/gu;
const KANJI_TSU = /(?<!\p{Script=Han})([一二三四五六七八九])つ/gu;
// Only ひとり and ふたり. Set phrases such as 一人娘 and 二人三脚 keep their kanji
const KANJI_NIN = /(?<!\p{Script=Han})([一二])人(?!\p{Script=Han})/gu;

// --- Percent --------------------------------------------------------------------------

const PERCENT_ANY = /([0-9０-９])[ \t]?(%|％|パーセント)/g;

// --- Time -----------------------------------------------------------------------------

const TIME_KANJI = /(?<![0-9０-９.:])([0-9]{1,2})時([0-9]{1,2})分(?![0-9間])/g;
const TIME_HALF = /(?<![0-9０-９.:])([0-9]{1,2})時半/g;
const TIME_COLON = /(?<![0-9０-９.:/])([0-9]{1,2}):([0-5][0-9])(?![0-9:])/g;

// --- Date -----------------------------------------------------------------------------

const DATE_YMD_KANJI = /(?<![0-9０-９])([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日/g;
const DATE_MD_KANJI = /(?<![0-9０-９年])([0-9]{1,2})月([0-9]{1,2})日/g;
const DATE_YMD_SLASH = /(?<![0-9０-９/.])([0-9]{4})\/([0-9]{1,2})\/([0-9]{1,2})(?![0-9/])/g;
// "1/2" may be a fraction, so month/day without a year is only read as a date when learning from a correction
const DATE_MD_SLASH = /(?<![0-9０-９/.])([0-9]{1,2})\/([0-9]{1,2})(?![0-9/])/g;

const validDate = (m: string, d: string) => +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31;

/**
 * Rewrites the numbers in text to one notation of one kind.
 * loose also converts forms that are ambiguous in general text (month/day with a slash). It is used to recognize corrections, never to rewrite output.
 */
export function convertNumbers(text: string, kind: NumberStyleKind, value: string, loose = false): string {
  switch (kind) {
    case 'width':
      return value === 'full' ? text.replace(HALF_RUN, toFull) : text.replace(FULL_RUN, toHalf);
    case 'grouping':
      if (value === 'comma') return text.replace(PLAIN_BEFORE_UNIT, group).replace(PLAIN_AFTER_CURRENCY, group);
      return text.replace(GROUPED_BEFORE_UNIT, (m) => m.replace(/,/g, '')).replace(GROUPED_AFTER_CURRENCY, (m) => m.replace(/,/g, ''));
    case 'units':
      return value === 'kanji' ? text.replace(ROUND_BEFORE_UNIT, toKanjiUnits) : text.replace(WITH_UNITS, fromKanjiUnits);
    case 'counters':
      if (value === 'kanji') {
        const toKanji = (_m: string, d: string) => _m.replace(d, KANJI_DIGITS[+d]);
        return text.replace(DIGIT_TSU, toKanji).replace(DIGIT_NIN, toKanji);
      }
      return text.replace(KANJI_TSU, (m, k: string) => m.replace(k, String(KANJI_DIGITS.indexOf(k)))).replace(KANJI_NIN, (m, k: string) => m.replace(k, String(KANJI_DIGITS.indexOf(k))));
    case 'percent':
      // A full-width digit keeps a full-width sign
      if (value === 'symbol') return text.replace(PERCENT_ANY, (_m, d: string) => d + (/[０-９]/.test(d) ? '％' : '%'));
      return text.replace(PERCENT_ANY, (_m, d: string) => `${d}パーセント`);
    case 'time':
      if (value === 'colon') {
        return text
          .replace(TIME_KANJI, (m, h: string, min: string) => (+h <= 24 && +min <= 59 ? `${+h}:${min.padStart(2, '0')}` : m))
          .replace(TIME_HALF, (m, h: string) => (+h <= 24 ? `${+h}:30` : m));
      }
      return text.replace(TIME_COLON, (m, h: string, min: string) => (+h <= 24 ? (+min === 0 ? `${+h}時` : `${+h}時${+min}分`) : m));
    case 'date':
      if (value === 'slash') {
        return text
          .replace(DATE_YMD_KANJI, (m, y: string, mo: string, d: string) => (validDate(mo, d) ? `${y}/${+mo}/${+d}` : m))
          .replace(DATE_MD_KANJI, (m, mo: string, d: string) => (validDate(mo, d) ? `${+mo}/${+d}` : m));
      }
      text = text.replace(DATE_YMD_SLASH, (m, y: string, mo: string, d: string) => (validDate(mo, d) ? `${y}年${+mo}月${+d}日` : m));
      return loose ? text.replace(DATE_MD_SLASH, (m, mo: string, d: string) => (validDate(mo, d) ? `${+mo}月${+d}日` : m)) : text;
  }
}

/** 万 and 億 are expanded or introduced before separators are added or removed. Width is handled around the others */
const APPLY_ORDER: readonly NumberStyleKind[] = ['units', 'grouping', 'counters', 'percent', 'time', 'date'];

/** Rewrites text to every preferred notation. Without preferences, returns text unchanged */
export function applyNumberStyle(text: string, styles: NumberStyles | undefined): string {
  if (!styles || !text) return text;
  const width = styles.width?.value;
  // The other rules read half-width digits. With a width preference, normalize first and convert back at the end
  let s = width ? convertNumbers(text, 'width', 'half') : text;
  for (const kind of APPLY_ORDER) {
    const pref = styles[kind];
    if (pref) s = convertNumbers(s, kind, pref.value);
  }
  return width === 'full' ? convertNumbers(s, 'width', 'full') : s;
}

/** Whether any preference is set */
export function hasNumberStyle(styles: NumberStyles | undefined): boolean {
  return !!styles && NUMBER_STYLE_KINDS.some((k) => styles[k]);
}

/** Lines for the formatter prompt, in a fixed order so that the system prompt stays cacheable. The prompt is in Japanese like the rest of the rules */
const PROMPT_LINES: Record<NumberStyleKind, Record<string, string>> = {
  width: {
    half: '数字は半角で書く（「10」）。',
    full: '日本語の文の中の数字は全角で書く（「１０」）。製品名、型番、英語の語句の中の数字は半角のままにする。',
  },
  grouping: {
    comma: '金額や数量など、単位の付いた 4 桁以上の数には、3 桁ごとに「,」を入れる（「10,000円」）。年、番号、時刻には入れない。',
    none: '数に 3 桁ごとの「,」を入れない（「10000円」）。',
  },
  units: {
    kanji: '1 万以上のきりのよい数は「万」「億」を使って書く（「1万円」「3億人」）。',
    digits: '数は「万」「億」を使わず、すべて数字で書く（「10000円」）。',
  },
  counters: {
    kanji: '「ひとつ」「ふたつ」「ひとり」「ふたり」のような数え方は漢数字で書く（「二つ」「一人」）。規則 13 より優先する。',
    digits: '「ひとつ」「ふたつ」「ひとり」「ふたり」のような数え方も算用数字で書く（「2つ」「1人」）。',
  },
  percent: {
    symbol: '百分率は「%」で書く（「3%」）。',
    word: '百分率は「パーセント」と書く（「3パーセント」）。',
  },
  time: {
    colon: '時刻は「10:30」の形で書く。',
    kanji: '時刻は「10時30分」の形で書く（「10:30」にしない）。',
  },
  date: {
    slash: '日付は「11/24」「2026/11/24」の形で書く。',
    kanji: '日付は「11月24日」の形で書く（「11/24」にしない）。',
  },
};

export function numberStylePromptLines(styles: NumberStyles | undefined): string[] {
  if (!styles) return [];
  return NUMBER_STYLE_KINDS.map((k) => (styles[k] ? PROMPT_LINES[k][styles[k].value] : '')).filter(Boolean);
}
