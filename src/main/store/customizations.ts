import { EventEmitter } from 'node:events';
import { isNumberStyleKind, isNumberStyleValue, NUMBER_STYLE_KINDS, type NumberStyleKind, type NumberStylePreference, type NumberStyles } from '../../shared/numberStyle';
import { CUSTOMIZATION_LIMITS, EMPTY_CUSTOMIZATIONS, type Customizations, type KeptPhrase, type LearnedWord, type PastCorrection } from '../../shared/types';
import { createLogger } from '../log';
import { rankVocabulary, type HintContext, type HintOptions, type RecentText, type VocabEntry } from '../vocab/hints';
import { countMorae, hasKanji, isKanaOnly } from '../vocab/kana';
import { applyConfirmedMatches, findDictionaryCandidates, type MatchEntry, type Reading } from '../vocab/match';
import { needsReading } from '../vocab/readings';
import { JsonStore } from './json-store';

const log = createLogger('customizations');

/** Maximum number of dictionary words (the Style page shows and checks the same value) */
export const DICTIONARY_LIMIT = CUSTOMIZATION_LIMITS.dictionary;
/** Maximum length of one dictionary word */
export const WORD_MAX_LENGTH = CUSTOMIZATION_LIMITS.wordLength;
/** Maximum number of learned words. Beyond it, the oldest words are dropped (G4-10) */
export const LEARNED_LIMIT = CUSTOMIZATION_LIMITS.learned;
/** Maximum number of words passed to the formatting LLM (G4-10) */
export const FORMATTER_VOCAB_LIMIT = 300;
/** Maximum number of hints passed to ASR (the whisper worker also cuts them off at 120 tokens) */
export const ASR_HINT_LIMIT = 64;
/** Number of misheard forms added to a word's line in the formatting dictionary (per word) */
export const FORMATTER_FORMS_PER_WORD = 3;
/** Number of phrases to keep as they are passed to formatting (newest first) */
export const FORMATTER_KEPT_LIMIT = 40;
/** Number of correction pairs passed to one formatting call */
export const FORMATTER_CORRECTIONS_LIMIT = 6;

/** Form used for comparison (ignores full-width vs half-width, upper vs lower case, and whitespace) */
const normKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function uniq(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words.map((x) => x.trim()).filter(Boolean)) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

function uniqLearned(words: LearnedWord[]): LearnedWord[] {
  const seen = new Set<string>();
  const out: LearnedWord[] = [];
  for (const w of words) {
    const k = w.word.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ ...w, word: w.word.trim() });
  }
  return out;
}

/** Keeps up to limit items, newest first (the order is unchanged) */
function capByTime<T extends { at: number }>(list: T[], limit: number): T[] {
  if (list.length <= limit) return list;
  const keep = new Set([...list].sort((a, b) => b.at - a.at).slice(0, limit));
  return list.filter((x) => keep.has(x));
}

/** Whether a learned word's misrecognized form can serve as a reading the user confirmed (kana or Latin letters, and not too short) */
function usableFromForm(from: string): boolean {
  const f = from.trim();
  if (!f || hasKanji(f)) return false;
  if (isKanaOnly(f.replace(/\s/g, ''))) return countMorae(f) >= 3;
  return /^[A-Za-z][A-Za-z0-9 .+#-]{3,}$/.test(f);
}

export interface PrepareOptions {
  /** Whether formatting uses the LLM. Without it, only exact matches of confirmed readings are replaced */
  useLlm: boolean;
  context?: HintContext;
  recent?: RecentText[];
  /** Reference time for scoring. Defaults to now (the evaluation passes the time of the recording to make results repeatable) */
  now?: number;
  vocabularyLimit?: number;
}

export interface PreparedFormatting {
  /** Raw text passed to formatting (already replaced when the LLM is not used) */
  text: string;
  /** Words to put in the formatting prompt (by score) */
  vocabulary: string[];
  /** Match candidates passed to formatting (only when the LLM is used) */
  candidates: { heard: string; word: string }[];
  /** Number of replacements made when the LLM is not used */
  replaced: number;
  /** Misheard forms per dictionary word (only words in vocabulary). Added to the word's line in the formatting dictionary */
  misheard?: Record<string, string[]>;
  /** Earlier correction pairs that appear in the raw text. Passed to formatting as candidates (only when the LLM is used) */
  corrections?: { heard: string; corrected: string }[];
  /** Phrases formatting must not rewrite (ones the user changed back) */
  kept?: { phrase: string; changedTo: string }[];
  /** Whether the user has at least one correction pair (decides whether the formatting rules get an explanation) */
  hasCorrections?: boolean;
  /** How the user writes numbers. Described in the formatter prompt and applied to the output */
  numberStyle?: NumberStyles;
}

/** A number notation preference changed by learning, with the one it replaced (to undo the change) */
export interface AppliedNumberStyle {
  kind: NumberStyleKind;
  value: string;
  example: { before: string; after: string };
  previous?: NumberStylePreference;
}

/** Keeps only known kinds with known values (the file may come from an older or newer version) */
function cleanNumberStyles(styles: unknown): NumberStyles | undefined {
  if (!styles || typeof styles !== 'object') return undefined;
  const out: NumberStyles = {};
  for (const [kind, pref] of Object.entries(styles as Record<string, unknown>)) {
    if (!isNumberStyleKind(kind) || !pref || typeof pref !== 'object') continue;
    const p = pref as Partial<NumberStylePreference>;
    if (!isNumberStyleValue(kind, p.value)) continue;
    out[kind] = {
      value: p.value as string,
      count: typeof p.count === 'number' && p.count > 0 ? p.count : 1,
      at: typeof p.at === 'number' ? p.at : 0,
      ...(p.example && typeof p.example.before === 'string' && typeof p.example.after === 'string' ? { example: { before: p.example.before, after: p.example.after } } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Function that makes readings. Returns null when the LLM cannot be used (they are made again the next time the dictionary changes) */
type ReadingGenerator = (words: string[]) => Promise<Record<string, string[]> | null>;

export class CustomizationsStore extends EventEmitter {
  private value: Customizations;
  private readonly store: JsonStore<Customizations>;
  private readingGenerator: ReadingGenerator | null = null;
  private readingTimer: NodeJS.Timeout | null = null;
  private readingBusy = false;
  /** The LLM could not be used (nothing is made until the dictionary changes) */
  private readingUnavailable = false;
  /** Words whose readings could not be made (not retried until the next launch) */
  private readingFailed = new Set<string>();

  constructor(file: string) {
    super();
    this.store = new JsonStore<Customizations>(file);
    const saved = this.store.read() as Partial<Customizations> | undefined;
    this.value = { ...EMPTY_CUSTOMIZATIONS, ...saved, version: 1 };
    this.value.learnedWords = uniqLearned(this.value.learnedWords ?? []);
    if (!this.value.replacementCaseMigrated) {
      // The meaning of a replacement's preserveCase was inverted (G4-12). Off used to mean “insert as written” and on meant “carry over the case”.
      // Now on means “as written” and off means “capitalize a leading lowercase letter at the start of a sentence”, so flip it once
      const flipped = this.value.replacements.length > 0;
      this.value = {
        ...this.value,
        replacements: this.value.replacements.map((r) => ({ ...r, preserveCase: !r.preserveCase })),
        replacementCaseMigrated: true,
      };
      if (saved) this.store.write(this.value);
      if (flipped) log.info(`moved the case setting of ${this.value.replacements.length} replacements to the new meaning`);
    }
  }

  get(): Customizations {
    return this.value;
  }

  update(patch: Partial<Customizations>): Customizations {
    const next = { ...this.value, ...patch, version: 1 as const };
    let dict = uniq(next.dictionary);
    const tooLong = dict.filter((w) => Array.from(w).length > WORD_MAX_LENGTH);
    if (tooLong.length) {
      log.warn(`left ${tooLong.length} words longer than ${WORD_MAX_LENGTH} characters out of the dictionary`);
      dict = dict.filter((w) => Array.from(w).length <= WORD_MAX_LENGTH);
    }
    if (dict.length > DICTIONARY_LIMIT) {
      // The window checks the limit, so this only happens when the window is bypassed, as in an import
      log.warn(`the dictionary exceeded its limit (${DICTIONARY_LIMIT} words), so ${dict.length - DICTIONARY_LIMIT} words were left out`);
      dict = dict.slice(0, DICTIONARY_LIMIT);
    }
    next.dictionary = dict;
    next.learnedWords = this.capLearned(uniqLearned(next.learnedWords));
    next.blockedLearnedWords = uniq(next.blockedLearnedWords);
    // Clean up the readings of removed words
    const alive = new Set([...next.dictionary, ...next.learnedWords.map((w) => w.word)]);
    const prune = (m?: Record<string, string[]>) => (m ? Object.fromEntries(Object.entries(m).filter(([k, v]) => alive.has(k) && Array.isArray(v) && v.length)) : undefined);
    next.readings = prune(next.readings);
    next.suggestedReadings = prune(next.suggestedReadings);
    next.misheard = prune(next.misheard);
    // Words set to never learn are also removed from the correction pairs
    const blockedKeys = new Set(next.blockedLearnedWords.map((w) => w.toLowerCase()));
    if (next.pastCorrections) next.pastCorrections = next.pastCorrections.filter((c) => !blockedKeys.has(c.corrected.toLowerCase()));
    next.numberStyle = cleanNumberStyles(next.numberStyle);
    if (!next.numberStyle) delete next.numberStyle;
    this.value = next;
    this.store.write(next);
    this.emit('change', next);
    this.readingUnavailable = false;
    this.scheduleReadings();
    return next;
  }

  private capLearned(words: LearnedWord[]): LearnedWord[] {
    if (words.length <= LEARNED_LIMIT) return words;
    const keep = new Set([...words].sort((a, b) => b.learnedAt - a.learnedAt).slice(0, LEARNED_LIMIT));
    log.info(`learned words exceeded the limit (${LEARNED_LIMIT} words), so the ${words.length - LEARNED_LIMIT} oldest were dropped`);
    return words.filter((w) => keep.has(w));
  }

  /** Words used in the prompt and as ASR vocabulary hints (dictionary and learned words) */
  vocabulary(): string[] {
    return uniq([...this.value.dictionary, ...this.value.learnedWords.map((w) => w.word)]);
  }

  /** Words used for scoring (dictionary and learned words) */
  private entries(): VocabEntry[] {
    const n = this.value.dictionary.length;
    const learned = new Map(this.value.learnedWords.map((w) => [w.word.toLowerCase(), w]));
    const readings = this.value.readings ?? {};
    const suggested = this.value.suggestedReadings ?? {};
    const misheard = this.value.misheard ?? {};
    const out: VocabEntry[] = this.value.dictionary.map((word, i) => ({
      word,
      recency: n > 1 ? i / (n - 1) : 1,
      learnedAt: learned.get(word.toLowerCase())?.learnedAt,
      readings: [...(readings[word] ?? []), ...(suggested[word] ?? []), ...(misheard[word] ?? [])],
    }));
    const inDict = new Set(this.value.dictionary.map((w) => w.toLowerCase()));
    for (const w of this.value.learnedWords) {
      if (inDict.has(w.word.toLowerCase())) continue;
      out.push({
        word: w.word,
        recency: 1,
        learnedAt: w.learnedAt,
        readings: [w.from, ...(misheard[w.word] ?? []), ...(readings[w.word] ?? []), ...(suggested[w.word] ?? [])],
      });
    }
    return out;
  }

  /**
   * Words passed to ASR as vocabulary hints (G4-09). Scored by how they relate to the current input target and recent transcripts, highest first.
   * Without a context, the order is recently learned words, learned words, then newly added words.
   */
  asrHints(opts: number | HintOptions = {}): string[] {
    const o: HintOptions = typeof opts === 'number' ? { limit: opts } : opts;
    return rankVocabulary(this.entries(), o)
      .slice(0, o.limit ?? ASR_HINT_LIMIT)
      .map((s) => s.word);
  }

  /** Words passed to the formatting LLM (G4-10). A large dictionary is narrowed to the highest-scoring words */
  formatterVocabulary(opts: HintOptions = {}): string[] {
    return rankVocabulary(this.entries(), opts)
      .slice(0, opts.limit ?? FORMATTER_VOCAB_LIMIT)
      .map((s) => s.word);
  }

  /** Words and readings used for matching (G4-11). Misrecognized forms of learned words and the user's readings count as confirmed readings */
  matchEntries(): MatchEntry[] {
    const readings = this.value.readings ?? {};
    const suggested = this.value.suggestedReadings ?? {};
    const map = new Map<string, Reading[]>();
    const add = (word: string, r: Reading) => {
      const list = map.get(word) ?? [];
      if (!list.some((x) => x.text === r.text)) list.push(r);
      else if (r.confirmed) list.forEach((x) => x.text === r.text && (x.confirmed = true));
      map.set(word, list);
    };
    for (const w of this.vocabulary()) {
      for (const r of readings[w] ?? []) add(w, { text: r, confirmed: true });
      for (const r of suggested[w] ?? []) add(w, { text: r, confirmed: false });
    }
    for (const lw of this.value.learnedWords) {
      const from = lw.from.trim();
      if (!from || from === lw.word) continue;
      add(lw.word, { text: from, confirmed: usableFromForm(from) });
    }
    // Misheard forms learned from corrections (on dictionary words and learned words alike). The user made the correction, so treat them like a learned word's form
    for (const [word, forms] of Object.entries(this.value.misheard ?? {})) {
      for (const f of forms) {
        const from = f.trim();
        if (from && from !== word) add(word, { text: from, confirmed: usableFromForm(from) });
      }
    }
    return [...map.entries()].map(([word, rs]) => ({ word, readings: rs }));
  }

  /** Misheard forms of a word (a learned word's first form and forms learned later). Newest first */
  misheardForms(word: string): string[] {
    const lw = this.value.learnedWords.find((w) => w.word === word);
    const later = [...(this.value.misheard?.[word] ?? [])].reverse();
    const all = [...later, ...(lw?.from ? [lw.from] : [])].map((f) => f.trim()).filter((f) => f && normKey(f) !== normKey(word));
    return uniq(all);
  }

  /** Misheard forms passed to formatting (only for the given words) */
  private formsFor(words: readonly string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const w of words) {
      const forms = this.misheardForms(w).slice(0, FORMATTER_FORMS_PER_WORD);
      if (forms.length) out[w] = forms;
    }
    return out;
  }

  /** Earlier correction pairs that appear in the raw text (most frequent first, then newest) */
  private correctionsIn(rawText: string): { heard: string; corrected: string }[] {
    const list = this.value.pastCorrections ?? [];
    if (!list.length) return [];
    const key = normKey(rawText);
    return list
      .filter((c) => key.includes(normKey(c.heard)))
      .sort((a, b) => b.count - a.count || b.at - a.at)
      .slice(0, FORMATTER_CORRECTIONS_LIMIT)
      .map((c) => ({ heard: c.heard, corrected: c.corrected }));
  }

  /** Phrases to keep as they are, passed to formatting. Oldest first (so adding a new phrase leaves the earlier part unchanged) */
  keptPhrases(): { phrase: string; changedTo: string }[] {
    // Entries with the same time keep the order they were added in
    return (this.value.keptPhrases ?? [])
      .map((k, i) => ({ k, i }))
      .sort((a, b) => b.k.at - a.k.at || b.i - a.i)
      .slice(0, FORMATTER_KEPT_LIMIT)
      .reverse()
      .map(({ k }) => ({ phrase: k.phrase, changedTo: k.changedTo }));
  }

  /**
   * Called after transcription and before formatting (G4-10, G4-11).
   * Finds match candidates for dictionary words. With the LLM, the candidates go to formatting; without it, only confirmed readings are replaced.
   * Words passed to formatting are narrowed by score, and words found by matching are always included.
   */
  prepareFormatting(rawText: string, opts: PrepareOptions): PreparedFormatting {
    const matches = findDictionaryCandidates(rawText, this.matchEntries());
    const ranked = this.formatterVocabulary({ context: opts.context, recent: opts.recent, now: opts.now, limit: opts.vocabularyLimit });
    const chosen = uniq([...matches.map((m) => m.word), ...ranked]).slice(0, Math.max(ranked.length, matches.length));
    // Order the words as they are in the dictionary (dictionary words, then learned words). Ordered by score, they would change with every utterance,
    // so the formatting system prompt would change every time and the prompt cache would stop working. A different order also makes the LLM output waver
    const position = new Map(this.vocabulary().map((w, i) => [w.toLowerCase(), i]));
    const vocabulary = [...chosen].sort((a, b) => (position.get(a.toLowerCase()) ?? Infinity) - (position.get(b.toLowerCase()) ?? Infinity));
    const learned = {
      misheard: this.formsFor(vocabulary),
      kept: this.keptPhrases(),
      hasCorrections: (this.value.pastCorrections?.length ?? 0) > 0,
      numberStyle: this.value.numberStyle,
    };
    if (!opts.useLlm) {
      const { text, replaced } = applyConfirmedMatches(rawText, matches);
      if (replaced) log.info(`replaced ${replaced} spots that matched dictionary readings`);
      // Correction pairs cannot be decided without looking at the context, so they are not used without the LLM
      return { text, vocabulary, candidates: [], replaced, ...learned, corrections: [] };
    }
    return {
      text: rawText,
      vocabulary,
      candidates: matches.map((m) => ({ heard: m.heard, word: m.word })),
      replaced: 0,
      ...learned,
      corrections: this.correctionsIn(rawText),
    };
  }

  /**
   * Adds new misheard forms of words already in the dictionary (dictionary words and learned words). Returns the forms added.
   * A form equal to a learned word's first form (from in learnedWords), or to the word itself, is not added.
   */
  addMisheardForms(forms: { word: string; from: string }[]): { word: string; from: string }[] {
    const vocab = new Map(this.vocabulary().map((w) => [w.toLowerCase(), w]));
    const next: Record<string, string[]> = { ...this.value.misheard };
    const added: { word: string; from: string }[] = [];
    for (const f of forms) {
      const word = vocab.get(f.word.trim().toLowerCase());
      const from = f.from.trim();
      if (!word || !from || normKey(from) === normKey(word)) continue;
      const have = this.misheardForms(word).map(normKey);
      if (have.includes(normKey(from)) || (next[word] ?? []).some((x) => normKey(x) === normKey(from))) continue;
      next[word] = [...(next[word] ?? []), from].slice(-CUSTOMIZATION_LIMITS.misheardPerWord);
      added.push({ word, from });
    }
    if (added.length) this.update({ misheard: next });
    return added;
  }

  /** Removes a misheard form (undoing learning) */
  removeMisheardForm(word: string, from: string): void {
    const cur = this.value.misheard?.[word];
    if (!cur) return;
    this.update({ misheard: { ...this.value.misheard, [word]: cur.filter((x) => x !== from) } });
  }

  /**
   * Adds correction pairs. Returns the pairs added (newly learned ones and ones whose count went up).
   * The same pair raises the count. If the reverse pair exists (the corrected word was changed back to the original), the older one is removed.
   */
  addPastCorrections(pairs: { heard: string; corrected: string }[], now = Date.now()): PastCorrection[] {
    let list = [...(this.value.pastCorrections ?? [])];
    const added: PastCorrection[] = [];
    for (const p of pairs) {
      const heard = p.heard.trim();
      const corrected = p.corrected.trim();
      if (!heard || !corrected || normKey(heard) === normKey(corrected)) continue;
      list = list.filter((c) => !(normKey(c.heard) === normKey(corrected) && normKey(c.corrected) === normKey(heard)));
      const i = list.findIndex((c) => normKey(c.heard) === normKey(heard) && normKey(c.corrected) === normKey(corrected));
      const item: PastCorrection = i >= 0 ? { ...list[i], count: list[i].count + 1, at: now } : { heard, corrected, count: 1, at: now };
      if (i >= 0) list[i] = item;
      else list.push(item);
      added.push(item);
    }
    if (!added.length) return [];
    this.update({ pastCorrections: capByTime(list, CUSTOMIZATION_LIMITS.pastCorrections) });
    return added;
  }

  removePastCorrection(heard: string, corrected: string): void {
    this.update({ pastCorrections: (this.value.pastCorrections ?? []).filter((c) => !(c.heard === heard && c.corrected === corrected)) });
  }

  /** How the user writes numbers (undefined when nothing has been learned) */
  numberStyles(): NumberStyles | undefined {
    return this.value.numberStyle;
  }

  /**
   * Records number notations seen in a correction. The same notation again raises the count; a different notation of the same kind
   * replaces the old one, because the latest correction says how the user writes now. Returns what changed, with the previous preference.
   */
  addNumberStyles(observations: readonly { kind: NumberStyleKind; value: string; before: string; after: string }[], now = Date.now()): AppliedNumberStyle[] {
    const styles: NumberStyles = { ...this.value.numberStyle };
    const applied: AppliedNumberStyle[] = [];
    for (const o of observations) {
      if (!isNumberStyleKind(o.kind) || !isNumberStyleValue(o.kind, o.value)) continue;
      const previous = styles[o.kind];
      const example = { before: o.before, after: o.after };
      styles[o.kind] = { value: o.value, count: previous?.value === o.value ? previous.count + 1 : 1, at: now, example };
      applied.push({ kind: o.kind, value: o.value, example, ...(previous ? { previous } : {}) });
    }
    if (applied.length) this.update({ numberStyle: styles });
    return applied;
  }

  /** Sets or removes one number notation preference (undoing a learned change, or the Style page) */
  setNumberStyle(kind: NumberStyleKind, pref: NumberStylePreference | undefined): void {
    const styles: NumberStyles = { ...this.value.numberStyle };
    if (pref) styles[kind] = pref;
    else delete styles[kind];
    this.update({ numberStyle: NUMBER_STYLE_KINDS.some((k) => styles[k]) ? styles : undefined });
  }

  /** Adds phrases to keep as they are. Returns the phrases added. The same phrase raises the count */
  addKeptPhrases(pairs: { phrase: string; changedTo: string }[], now = Date.now()): KeptPhrase[] {
    const list = [...(this.value.keptPhrases ?? [])];
    const added: KeptPhrase[] = [];
    for (const p of pairs) {
      const phrase = p.phrase.trim();
      const changedTo = p.changedTo.trim();
      if (!phrase || !changedTo || normKey(phrase) === normKey(changedTo)) continue;
      const i = list.findIndex((k) => normKey(k.phrase) === normKey(phrase) && normKey(k.changedTo) === normKey(changedTo));
      const item: KeptPhrase = i >= 0 ? { ...list[i], count: list[i].count + 1, at: now } : { phrase, changedTo, count: 1, at: now };
      if (i >= 0) list[i] = item;
      else list.push(item);
      added.push(item);
    }
    if (!added.length) return [];
    this.update({ keptPhrases: capByTime(list, CUSTOMIZATION_LIMITS.keptPhrases) });
    return added;
  }

  removeKeptPhrase(phrase: string, changedTo: string): void {
    this.update({ keptPhrases: (this.value.keptPhrases ?? []).filter((k) => !(k.phrase === phrase && k.changedTo === changedTo)) });
  }

  /**
   * Adds learned words. Returns the words added.
   * - Merges duplicates, and skips words already in the dictionary and words set to never learn
   * - If a new word's misrecognized form equals an existing learned word (the learned word was corrected to another word), removes the old learned word and sets it to never learn (G4-06)
   */
  addLearnedWords(words: LearnedWord[]): LearnedWord[] {
    const known = new Set(this.vocabulary().map((w) => w.toLowerCase()));
    const blocked = new Set(this.value.blockedLearnedWords.map((w) => w.toLowerCase()));
    const batch = uniqLearned(words);
    const takenBack = new Set<string>();
    for (const w of batch) {
      const from = w.from.trim().toLowerCase();
      const old = this.value.learnedWords.find((x) => x.word.toLowerCase() === from && x.word.toLowerCase() !== w.word.toLowerCase());
      if (old) takenBack.add(old.word);
    }
    const added = batch.filter((w) => !known.has(w.word.toLowerCase()) && !blocked.has(w.word.toLowerCase()));
    if (!added.length && !takenBack.size) return [];
    if (takenBack.size) log.info(`withdrew ${takenBack.size} learned words to follow a new correction`);
    this.update({
      learnedWords: [...this.value.learnedWords.filter((x) => !takenBack.has(x.word)), ...added],
      blockedLearnedWords: [...this.value.blockedLearnedWords, ...takenBack],
    });
    return added;
  }

  /** Undoes learning a word, and never learns the same word again (LRN-2) */
  undoLearnedWord(word: string): void {
    this.update({
      learnedWords: this.value.learnedWords.filter((w) => w.word !== word),
      blockedLearnedWords: [...this.value.blockedLearnedWords, word],
    });
  }

  /**
   * Sets the function that makes readings (main passes the LLM connection).
   * Once set, readings for Latin-letter dictionary words without readings are made in a batch after a short wait.
   */
  setReadingGenerator(fn: ReadingGenerator | null): void {
    this.readingGenerator = fn;
    this.readingUnavailable = false;
    this.scheduleReadings();
  }

  /** Latin-letter dictionary words that have no reading yet */
  wordsNeedingReadings(): string[] {
    const r = this.value.readings ?? {};
    const s = this.value.suggestedReadings ?? {};
    return this.value.dictionary.filter((w) => needsReading(w) && !r[w]?.length && !s[w]?.length && !this.readingFailed.has(w));
  }

  private scheduleReadings(): void {
    if (!this.readingGenerator || this.readingTimer || this.readingBusy || this.readingUnavailable) return;
    if (!this.wordsNeedingReadings().length) return;
    this.readingTimer = setTimeout(() => {
      this.readingTimer = null;
      void this.generateReadingsNow();
    }, 2000);
    this.readingTimer.unref?.();
  }

  /** Makes readings for words without one right away (up to 50 words at a time) */
  async generateReadingsNow(): Promise<number> {
    const gen = this.readingGenerator;
    const words = this.wordsNeedingReadings().slice(-50);
    if (!gen || !words.length || this.readingBusy) return 0;
    this.readingBusy = true;
    try {
      const made = await gen(words);
      if (!made) {
        this.readingUnavailable = true;
        return 0;
      }
      for (const w of words) if (!made[w]?.length) this.readingFailed.add(w);
      const entries = Object.entries(made).filter(([, v]) => v.length);
      if (!entries.length) return 0;
      this.update({ suggestedReadings: { ...this.value.suggestedReadings, ...Object.fromEntries(entries) } });
      log.info(`made reading candidates for ${entries.length} dictionary words`);
      return entries.length;
    } catch (e) {
      for (const w of words) this.readingFailed.add(w);
      log.warn('could not make reading candidates', e);
      return 0;
    } finally {
      this.readingBusy = false;
      this.scheduleReadings();
    }
  }

  flush(): void {
    if (this.readingTimer) clearTimeout(this.readingTimer);
    this.readingTimer = null;
    this.store.flush();
  }
}
