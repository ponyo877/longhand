/**
 * Finds candidate words for the dictionary in text.
 *
 * Product names and technical terms written in Latin letters are the words most easily broken by transcription (they come out in katakana).
 * So this picks Latin words from the user's history and local documents, and lists those not yet in the dictionary, most frequent first.
 * The user does the choosing; this only offers candidates.
 *
 * - From English prose (runs of 4 or more Latin words), only name-like words are picked (words with an uppercase letter or a digit inside,
 *   words starting with an uppercase letter other than at the start of a sentence). Latin words mixed into Japanese text are all picked,
 *   except common words (the, and and so on).
 * - Runs of capitalized words separated by a single space (Google Chrome and so on) become one candidate when they appear twice or more.
 * - Spellings that differ only in case are merged into one, using the most frequent spelling.
 *
 * A pure function with no network or file access, usable from both main and the renderer.
 */

export interface DictCandidate {
  /** Spelling to put in the dictionary (the spelling that appeared most often) */
  word: string;
  /** Number of times it appeared */
  count: number;
  /** Text around its first appearance (a hint for choosing) */
  sample: string;
}

export interface CandidateOptions {
  /** Words already in the dictionary (left out of the candidates) */
  existing?: string[];
  /** Maximum number of candidates returned */
  limit?: number;
  /** Maximum length of one word (in characters) */
  maxLength?: number;
  /**
   * Picks only name-like words (words with an uppercase letter or a digit inside, and words starting with an uppercase letter).
   * Used when picking words from the text on screen (lowercase-only words are left out because many command and variable names get mixed in)
   */
  namesOnly?: boolean;
}

/** Form used to treat words as the same (ignores full-width / half-width and case) */
const keyOf = (w: string) => w.normalize('NFKC').trim().toLowerCase();

/** Common English words. Adding them to the dictionary does not change transcription, so they are not candidates */
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

/** A number with only a unit attached, such as 「10ms」「24GB」「5x」. 「3D」「5G」「4K」 (digits and one uppercase letter) stay as words */
const UNIT = /^\d+(?:\.\d+)?(?:ms|sec|min|hr|kb|mb|gb|tb|px|pt|fps|hz|khz|mhz|ghz|kg|mg|cm|mm|km|ml|kw|st|nd|rd|th)$/i;
const UNIT_ONE_LETTER = /^\d+(?:\.\d+)?[a-z]$/;

const URL_OR_MAIL = /https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** A Latin word. Includes . - _ + # inside it and + # at the end (C++ or C#). Also picks words starting with a digit, such as 「3D」 */
const TOKEN = /(?:\d+[A-Za-z]|[A-Za-z])[A-Za-z0-9]*(?:[.\-_+#'][A-Za-z0-9]+)*[+#]{0,2}/g;

/** Length counted as English prose (runs of at least this many Latin words) */
const PROSE_MIN_TOKENS = 4;
/** Maximum number of words in one phrase candidate */
const PHRASE_MAX_WORDS = 4;

interface Tok {
  text: string;
  start: number;
  end: number;
  /** Characters between this word and the previous one */
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

/** Takes the 14 characters around a word. If an edge falls in the middle of a Latin word, that word is left out (to avoid 「…afana を」) */
function sampleOf(text: string, start: number, end: number): string {
  let from = Math.max(0, start - 14);
  while (from > 0 && from < start && WORD_CHAR.test(text[from]) && WORD_CHAR.test(text[from - 1])) from++;
  let to = Math.min(text.length, end + 14);
  while (to < text.length && to > end && WORD_CHAR.test(text[to - 1]) && WORD_CHAR.test(text[to])) to--;
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

/** Splits text into runs of Latin words. Japanese characters or line breaks between words start a new run */
function spansOf(text: string): Tok[][] {
  const spans: Tok[][] = [];
  let cur: Tok[] = [];
  let prevEnd = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index;
    const gap = text.slice(prevEnd, start);
    const tok: Tok = { text: m[0], start, end: start + m[0].length, gap };
    // If only spaces and symbols are in between, it is the same run (English prose continuing)
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
  /** For a phrase candidate, the words in it */
  parts?: Tok[];
}

/** Takes the candidate words and phrase candidates from one run */
function pick(span: Tok[], maxLength: number, namesOnly: boolean): Found[] {
  const prose = span.length >= PROSE_MIN_TOKENS;
  const keep = span.map((t, i) => {
    if (!acceptable(t.text, maxLength)) return false;
    if (!prose) return !namesOnly || hasInnerUpperOrDigit(t.text) || isCapitalized(t.text);
    // In English prose, only name-like words are picked
    if (hasInnerUpperOrDigit(t.text)) return true;
    const sentenceStart = i === 0 || /[.!?]\s*$/.test(t.gap);
    return isCapitalized(t.text) && !sentenceStart;
  });
  const out: Found[] = [];
  for (let i = 0; i < span.length; i++) {
    if (!keep[i]) continue;
    // Runs of capitalized words separated by a single space become one phrase
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

  // Phrase candidates are taken only when they appear twice or more. If only once, the words in them are counted one by one
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
    // Use the most frequent spelling. On a tie, the one with more uppercase letters (GitHub over github)
    const word = [...g.forms.entries()].sort((a, b) => b[1] - a[1] || upperCount(b[0]) - upperCount(a[0]))[0][0];
    out.push({ word, count: g.count, sample: g.sample });
  }
  out.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'en'));
  return out.slice(0, opts.limit ?? 300);
}

/** Whether a string looks like prose (contains whitespace or Japanese characters). Used to leave out IDs, type names and paths in JSON */
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
 * Takes the prose out of the content of a loaded file.
 * Plain text is used as is. For JSON and JSON Lines (history exported by other apps and so on), only prose-like values are used
 * (so that key names and IDs do not get mixed into the candidates).
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
      // Try reading it as one JSON value per line (JSON Lines)
    }
    try {
      for (const line of t.split('\n')) if (line.trim()) collectStrings(JSON.parse(line), out);
      return out;
    } catch {
      // Not JSON, so read it as text
    }
  }
  return [t];
}
