/**
 * 文章から、辞書に入れる語の候補を探す。
 *
 * 書き起こしで崩れやすいのは、英字で書く製品名や技術用語である（カタカナになる）。
 * そこで、利用者の履歴や手元の文書から英字の語を拾い、まだ辞書にない語を、出てきた回数の多い順に並べる。
 * 選ぶのは利用者で、ここでは候補を出すだけである。
 *
 * - 英語の文（英字の語が 4 語以上続くところ）からは、名前らしい語（途中に大文字や数字がある語、文頭以外の大文字始まり）だけを拾う。
 *   日本語の文に混ざった英字の語は、ありふれた語（the や and など）を除いてすべて拾う。
 * - 大文字で始まる語が空白 1 つで続くところ（Google Chrome など）は、2 回以上出てきたら、ひとまとまりの候補にする。
 * - 大文字と小文字だけが違う書き方は 1 つにまとめ、いちばん多い書き方を使う。
 *
 * 通信もファイルの読み書きもしない純粋な関数で、main からも renderer からも使える。
 */

export interface DictCandidate {
  /** 辞書に入れる表記（いちばん多く出てきた書き方） */
  word: string;
  /** 出てきた回数 */
  count: number;
  /** 最初に出てきた箇所の前後（選ぶときの手がかり） */
  sample: string;
}

export interface CandidateOptions {
  /** すでに辞書にある語（候補から外す） */
  existing?: string[];
  /** 返す候補の上限 */
  limit?: number;
  /** 1 語の長さの上限（字数） */
  maxLength?: number;
  /**
   * 名前らしい語だけを拾う（途中に大文字か数字がある語と、大文字で始まる語）。
   * 画面の文から語を拾うときに使う（小文字だけの語は、コマンドや変数の名前が大量に混ざるので外す）
   */
  namesOnly?: boolean;
}

/** 同じ語とみなすための形（全角半角と大文字小文字を区別しない） */
const keyOf = (w: string) => w.normalize('NFKC').trim().toLowerCase();

/** ありふれた英語の語。辞書に入れても書き起こしは変わらないので、候補にしない */
const STOPWORDS = new Set(
  (
    'a an the this that these those it its he she we you they me my your our their his her them us i ' +
    'is am are was were be been being do does did done have has had having will would can could shall should may might must ' +
    'and or but nor so yet if then else than as because while when where what which who whom whose why how ' +
    'of to in on at by for with from into onto over under about after before between through during without within against ' +
    'not no yes ok okay all any some each every both either neither more most less least many much few other another such same ' +
    'here there now just only also very too still again once ever never always often already soon ' +
    'up down out off back away new old good bad big small first last next one two three four five six seven eight nine ten ' +
    'get got go going went come came make made take took see saw say said know knew think thought want need use used like ' +
    'let lets put give gave find found tell told ask asked work try call keep look looks feel seem show ' +
    'please thanks thank hello hi hey sorry sure well oh ah um uh hmm ' +
    'am pm vs etc eg ie mr mrs ms dr st nd rd th ' +
    'e.g i.e'
  ).split(' '),
);

/** 「10ms」「24GB」「5x」のような、数に単位が付いただけのもの。「3D」「5G」「4K」（数字と大文字 1 字）は語として残す */
const UNIT = /^\d+(?:\.\d+)?(?:ms|sec|min|hr|kb|mb|gb|tb|px|pt|fps|hz|khz|mhz|ghz|kg|mg|cm|mm|km|ml|kw|st|nd|rd|th)$/i;
const UNIT_ONE_LETTER = /^\d+(?:\.\d+)?[a-z]$/;

const URL_OR_MAIL = /https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** 英字の語。途中の . - _ + # と、末尾の + #（C++ や C#）を含める。「3D」のような数字始まりも拾う */
const TOKEN = /(?:\d+[A-Za-z]|[A-Za-z])[A-Za-z0-9]*(?:[.\-_+#'][A-Za-z0-9]+)*[+#]{0,2}/g;

/** 英語の文とみなす長さ（英字の語がこの数以上続くところ） */
const PROSE_MIN_TOKENS = 4;
/** ひとまとまりの候補にする語数の上限 */
const PHRASE_MAX_WORDS = 4;

interface Tok {
  text: string;
  start: number;
  end: number;
  /** 前の語との間にある字 */
  gap: string;
}

const hasInnerUpperOrDigit = (t: string) => /\d/.test(t) || /[A-Z]/.test(t.slice(1));
const isCapitalized = (t: string) => /^[A-Z]/.test(t);

function acceptable(t: string, maxLength: number): boolean {
  if (t.includes("'")) return false;
  if (Array.from(t).length < 2 || Array.from(t).length > maxLength) return false;
  if (STOPWORDS.has(t.toLowerCase())) return false;
  if (UNIT.test(t) || UNIT_ONE_LETTER.test(t)) return false;
  if (!/[A-Za-z]{2}/.test(t) && !/[A-Z]/.test(t)) return false;
  return true;
}

const WORD_CHAR = /[A-Za-z0-9]/;

/** 語の前後 14 字を取り出す。端が英字の語の途中に当たったら、その語を含めない（「…afana を」のようにしない） */
function sampleOf(text: string, start: number, end: number): string {
  let from = Math.max(0, start - 14);
  while (from > 0 && from < start && WORD_CHAR.test(text[from]) && WORD_CHAR.test(text[from - 1])) from++;
  let to = Math.min(text.length, end + 14);
  while (to < text.length && to > end && WORD_CHAR.test(text[to - 1]) && WORD_CHAR.test(text[to])) to--;
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

/** 文章を、英字の語が続くかたまりに分ける。語の間に日本語の字や改行があれば、別のかたまりにする */
function spansOf(text: string): Tok[][] {
  const spans: Tok[][] = [];
  let cur: Tok[] = [];
  let prevEnd = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index;
    const gap = text.slice(prevEnd, start);
    const tok: Tok = { text: m[0], start, end: start + m[0].length, gap };
    // 間にあるのが空白と記号だけなら、同じかたまり（英語の文の続き）とみなす
    if (cur.length && /^[ ,.;:!?"()\-–/]*$/.test(gap)) cur.push(tok);
    else {
      if (cur.length) spans.push(cur);
      cur = [tok];
    }
    prevEnd = tok.end;
  }
  if (cur.length) spans.push(cur);
  return spans;
}

interface Found {
  text: string;
  start: number;
  end: number;
  /** ひとまとまりの候補のときの、中の語 */
  parts?: Tok[];
}

/** 1 つのかたまりから、候補になる語と、ひとまとまりの候補を取り出す */
function pick(span: Tok[], maxLength: number, namesOnly: boolean): Found[] {
  const prose = span.length >= PROSE_MIN_TOKENS;
  const keep = span.map((t, i) => {
    if (!acceptable(t.text, maxLength)) return false;
    if (!prose) return !namesOnly || hasInnerUpperOrDigit(t.text) || isCapitalized(t.text);
    // 英語の文の中では、名前らしい語だけを拾う
    if (hasInnerUpperOrDigit(t.text)) return true;
    const sentenceStart = i === 0 || /[.!?]\s*$/.test(t.gap);
    return isCapitalized(t.text) && !sentenceStart;
  });
  const out: Found[] = [];
  for (let i = 0; i < span.length; i++) {
    if (!keep[i]) continue;
    // 大文字で始まる語が空白 1 つで続くところを、ひとまとまりにする
    let j = i;
    while (j + 1 < span.length && j + 1 - i < PHRASE_MAX_WORDS && keep[j + 1] && span[j + 1].gap === ' ' && isCapitalized(span[j].text) && isCapitalized(span[j + 1].text)) j++;
    if (j > i) {
      const parts = span.slice(i, j + 1);
      out.push({ text: parts.map((p) => p.text).join(' '), start: span[i].start, end: span[j].end, parts });
      i = j;
    } else out.push({ text: span[i].text, start: span[i].start, end: span[i].end });
  }
  return out;
}

export function extractCandidates(texts: string[], opts: CandidateOptions = {}): DictCandidate[] {
  const maxLength = opts.maxLength ?? 50;
  const existing = new Set((opts.existing ?? []).map(keyOf));
  const docs = texts.map((t) => t.normalize('NFKC').replace(URL_OR_MAIL, (m) => ' '.repeat(m.length)));
  const found = docs.map((doc) => spansOf(doc).flatMap((span) => pick(span, maxLength, opts.namesOnly ?? false)));

  // ひとまとまりの候補は、2 回以上出てきたものだけを採る。1 回だけなら、中の語を 1 語ずつ数える
  const phraseCount = new Map<string, number>();
  for (const list of found) for (const f of list) if (f.parts) phraseCount.set(keyOf(f.text), (phraseCount.get(keyOf(f.text)) ?? 0) + 1);

  const groups = new Map<string, { forms: Map<string, number>; count: number; sample: string }>();
  const add = (doc: string, text: string, start: number, end: number) => {
    const key = keyOf(text);
    if (existing.has(key)) return;
    let g = groups.get(key);
    if (!g) {
      g = { forms: new Map(), count: 0, sample: sampleOf(doc, start, end) };
      groups.set(key, g);
    }
    g.count++;
    g.forms.set(text, (g.forms.get(text) ?? 0) + 1);
  };
  found.forEach((list, d) => {
    for (const f of list) {
      if (!f.parts || (phraseCount.get(keyOf(f.text)) ?? 0) >= 2) add(docs[d], f.text, f.start, f.end);
      else for (const p of f.parts) add(docs[d], p.text, p.start, p.end);
    }
  });

  const upperCount = (s: string) => (s.match(/[A-Z]/g) ?? []).length;
  const out: DictCandidate[] = [];
  for (const g of groups.values()) {
    // いちばん多い書き方を使う。同数なら、大文字の多いほう（GitHub と github なら GitHub）
    const word = [...g.forms.entries()].sort((a, b) => b[1] - a[1] || upperCount(b[0]) - upperCount(a[0]))[0][0];
    out.push({ word, count: g.count, sample: g.sample });
  }
  out.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'en'));
  return out.slice(0, opts.limit ?? 300);
}

/** 文章らしい文字列か（空白か、日本語の字を含む）。JSON の中の ID、種類の名前、パスを外すために使う */
const PROSE_LIKE = /[\s\u3040-\u30ff\u3400-\u9fff]/;

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') {
    if (PROSE_LIKE.test(v.trim())) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) collectStrings(x, out);
  }
}

/**
 * 読み込んだファイルの中身から、文章を取り出す。
 * ふつうのテキストはそのまま使う。JSON や JSON Lines（ほかのアプリが書き出した履歴など）は、文章らしい値だけを使う
 * （キーの名前や ID が候補に混ざらないようにする）。
 */
export function textsFromFile(content: string): string[] {
  const t = content.replace(/^\uFEFF/, '');
  const head = t.trimStart()[0];
  if (head === '[' || head === '{') {
    const out: string[] = [];
    try {
      collectStrings(JSON.parse(t), out);
      return out;
    } catch {
      // 1 行に 1 つの JSON（JSON Lines）として読んでみる
    }
    try {
      for (const line of t.split('\n')) if (line.trim()) collectStrings(JSON.parse(line), out);
      return out;
    } catch {
      // JSON ではないので、テキストとして読む
    }
  }
  return [t];
}
