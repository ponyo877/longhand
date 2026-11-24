/**
 * Small kana and romaji helpers for comparing how words sound (learning decisions, dictionary matching).
 * Not an exact transcription, just an approximation good enough to spot recognition mishearings.
 */

const SMALL = new Set(['ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ', 'ヮ']);

/** Converts hiragana to katakana */
export function hiraToKata(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

export function isKanaChar(c: string): boolean {
  return /[ぁ-ゖ゠-ヿー]/.test(c);
}

export function isKanaOnly(s: string): boolean {
  return s.length > 0 && /^[ぁ-ゖ゠-ヿー]+$/.test(s);
}

export function hasKanji(s: string): boolean {
  return /[一-鿿㐀-䶿々〆]/.test(s);
}

export function isLatinWord(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9 .+#&'_-]*$/.test(s) && /[A-Za-z]/.test(s);
}

/** Number of katakana morae (small ャュョァィゥェォ form one mora with the preceding character) */
export function countMorae(s: string): number {
  let n = 0;
  for (const c of hiraToKata(s)) if (!SMALL.has(c) && isKanaChar(c)) n++;
  return n;
}

/**
 * Form used for matching. Applies NFKC, converts to katakana, removes long-vowel marks, small tsu, middle dots and whitespace, makes small vowels full-size, and turns ヴ into the バ row.
 * 「グラファーナ」 and 「グラファナ」, or 「ヴィム」 and 「ビム」, get the same form.
 */
export function matchForm(s: string): string {
  return hiraToKata(s.normalize('NFKC'))
    .replace(/ヴァ/g, 'バ')
    .replace(/ヴィ/g, 'ビ')
    .replace(/ヴェ/g, 'ベ')
    .replace(/ヴォ/g, 'ボ')
    .replace(/ヴ/g, 'ブ')
    .replace(/[ァィゥェォ]/g, (c) => ({ ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ' })[c] ?? c)
    .replace(/[ヵ]/g, 'カ')
    .replace(/[ヶ]/g, 'ケ')
    .replace(/[ーッ・\s]/g, '');
}

// Arranged by rows of the kana table. Keep the formatter from putting one entry per line
// prettier-ignore
const BASE: Record<string, string> = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
  カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
  ワ: 'wa', ヰ: 'i', ヱ: 'e', ヲ: 'o', ン: 'n', ヴ: 'vu',
  ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ャ: 'ya', ュ: 'yu', ョ: 'yo', ヮ: 'wa', ヵ: 'ka', ヶ: 'ke',
};

/** Two-character combinations (contracted sounds and sounds from loanwords) */
// Arranged by rows of the kana table. Keep the formatter from putting one entry per line
// prettier-ignore
const PAIR: Record<string, string> = {
  キャ: 'kya', キュ: 'kyu', キョ: 'kyo', ギャ: 'gya', ギュ: 'gyu', ギョ: 'gyo',
  シャ: 'sha', シュ: 'shu', ショ: 'sho', シェ: 'she', ジャ: 'ja', ジュ: 'ju', ジョ: 'jo', ジェ: 'je',
  チャ: 'cha', チュ: 'chu', チョ: 'cho', チェ: 'che', ニャ: 'nya', ニュ: 'nyu', ニョ: 'nyo',
  ヒャ: 'hya', ヒュ: 'hyu', ヒョ: 'hyo', ビャ: 'bya', ビュ: 'byu', ビョ: 'byo', ピャ: 'pya', ピュ: 'pyu', ピョ: 'pyo',
  ミャ: 'mya', ミュ: 'myu', ミョ: 'myo', リャ: 'rya', リュ: 'ryu', リョ: 'ryo',
  ファ: 'fa', フィ: 'fi', フェ: 'fe', フォ: 'fo', フュ: 'fyu',
  ティ: 'ti', ディ: 'di', トゥ: 'tu', ドゥ: 'du', テュ: 'tyu', デュ: 'dyu',
  ウィ: 'wi', ウェ: 'we', ウォ: 'wo', ヴァ: 'va', ヴィ: 'vi', ヴェ: 've', ヴォ: 'vo',
  ツァ: 'tsa', ツィ: 'tsi', ツェ: 'tse', ツォ: 'tso', スィ: 'si', ズィ: 'zi', クァ: 'kwa', グァ: 'gwa',
};

/** Converts kana to romaji (close to Hepburn). Other characters are lowercased and kept */
export function romanize(s: string): string {
  const chars = Array.from(hiraToKata(s.normalize('NFKC')));
  let out = '';
  let geminate = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === 'ッ') {
      geminate = true;
      continue;
    }
    if (c === 'ー') {
      const v = out.match(/[aeiou]$/);
      if (v) out += v[0];
      continue;
    }
    let r: string | undefined;
    if (i + 1 < chars.length && PAIR[c + chars[i + 1]]) {
      r = PAIR[c + chars[i + 1]];
      i++;
    } else {
      r = BASE[c];
    }
    if (r === undefined) {
      out += c.toLowerCase();
      geminate = false;
      continue;
    }
    if (geminate && /^[bcdfghjkmpqrstvwxyz]/.test(r)) out += r[0];
    geminate = false;
    out += r;
  }
  return out;
}

/**
 * Form used for comparing sounds. Converts kana to romaji, evens out spelling quirks in Latin letters (c and k, l and r, v and b, ph and f and so on),
 * and collapses repeated consonants and repeated vowels to one.
 */
export function soundForm(s: string): string {
  let r = romanize(s).toLowerCase();
  r = r
    .replace(/[^a-z0-9]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'ku')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/l/g, 'r')
    .replace(/v/g, 'b')
    .replace(/shi/g, 'si')
    .replace(/chi/g, 'ti')
    .replace(/tsu/g, 'tu')
    .replace(/fu/g, 'hu')
    .replace(/(.)\1+/g, '$1');
  return r;
}

/** Consonant skeleton (the first character, then every non-vowel after it) */
export function consonantSkeleton(s: string): string {
  const f = soundForm(s);
  if (!f) return '';
  return f[0] + f.slice(1).replace(/[aeiou]/g, '');
}

/** Edit distance (Levenshtein). Works on arrays or strings */
export function editDistance(a: ArrayLike<string>, b: ArrayLike<string>): number {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  let prev: number[] = Array.from({ length: m + 1 }, () => 0);
  let cur: number[] = Array.from({ length: m + 1 }, () => 0);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/**
 * Whether from (the heard word) and to (the corrected word) sound alike.
 * false for words with kanji, since their reading is unknown. Compares both the consonant skeleton and the romaji form.
 */
export function soundsSimilar(from: string, to: string): boolean {
  if (hasKanji(from) || hasKanji(to)) return false;
  const a = soundForm(from);
  const b = soundForm(to);
  if (!a || !b) return false;
  if (a === b) return true;
  const ka = consonantSkeleton(from);
  const kb = consonantSkeleton(to);
  const kd = editDistance(ka, kb);
  const kAllowed = Math.max(1, Math.floor(Math.max(ka.length, kb.length) * 0.25));
  const d = editDistance(a, b);
  return kd <= kAllowed && d <= Math.max(a.length, b.length) * 0.5;
}
