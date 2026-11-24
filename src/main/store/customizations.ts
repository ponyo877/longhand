import { EventEmitter } from 'node:events';
import { CUSTOMIZATION_LIMITS, EMPTY_CUSTOMIZATIONS, type Customizations, type KeptPhrase, type LearnedWord, type PastCorrection } from '../../shared/types';
import { createLogger } from '../log';
import { rankVocabulary, type HintContext, type HintOptions, type RecentText, type VocabEntry } from '../vocab/hints';
import { countMorae, hasKanji, isKanaOnly } from '../vocab/kana';
import { applyConfirmedMatches, findDictionaryCandidates, type MatchEntry, type Reading } from '../vocab/match';
import { needsReading } from '../vocab/readings';
import { JsonStore } from './json-store';

const log = createLogger('customizations');

/** 辞書の件数の上限（スタイル画面の表示と検査も同じ値を使う） */
export const DICTIONARY_LIMIT = CUSTOMIZATION_LIMITS.dictionary;
/** 辞書の 1 語の長さの上限 */
export const WORD_MAX_LENGTH = CUSTOMIZATION_LIMITS.wordLength;
/** 学習語の件数の上限。超えたら古い語から外す（G4-10） */
export const LEARNED_LIMIT = CUSTOMIZATION_LIMITS.learned;
/** 整形の LLM に渡す語の上限（G4-10） */
export const FORMATTER_VOCAB_LIMIT = 300;
/** ASR に渡すヒントの上限（whisper のワーカーがさらに 120 トークンで打ち切る） */
export const ASR_HINT_LIMIT = 64;
/** 整形の辞書の行に添える、聞き違えた形の数（1 語あたり） */
export const FORMATTER_FORMS_PER_WORD = 3;
/** 整形に渡す、書き換えない語句の数（新しい順） */
export const FORMATTER_KEPT_LIMIT = 40;
/** 1 回の整形に渡す、取り違えの組の数 */
export const FORMATTER_CORRECTIONS_LIMIT = 6;

/** 比べるときの形（全角と半角、大文字と小文字、空白の違いを無視する） */
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

/** 新しい順に limit 件まで残す（並びは変えない） */
function capByTime<T extends { at: number }>(list: T[], limit: number): T[] {
  if (list.length <= limit) return list;
  const keep = new Set([...list].sort((a, b) => b.at - a.at).slice(0, limit));
  return list.filter((x) => keep.has(x));
}

/** 学習語の誤認識の形を、利用者が確かめた読みとして使えるか（かなか英字で、短すぎない） */
function usableFromForm(from: string): boolean {
  const f = from.trim();
  if (!f || hasKanji(f)) return false;
  if (isKanaOnly(f.replace(/\s/g, ''))) return countMorae(f) >= 3;
  return /^[A-Za-z][A-Za-z0-9 .+#-]{3,}$/.test(f);
}

export interface PrepareOptions {
  /** 整形に LLM を使うか。使わないときは、確かめた読みの完全一致だけを置き換える */
  useLlm: boolean;
  context?: HintContext;
  recent?: RecentText[];
  /** 得点を付ける基準の時刻。省けば今（評価では、発話を録音した時刻を渡して結果を固定する） */
  now?: number;
  vocabularyLimit?: number;
}

export interface PreparedFormatting {
  /** 整形に渡す生テキスト（LLM を使わないときは置き換え済み） */
  text: string;
  /** 整形のプロンプトに入れる語（得点順） */
  vocabulary: string[];
  /** 整形に渡す照合の候補（LLM を使うときだけ） */
  candidates: { heard: string; word: string }[];
  /** LLM を使わないときに置き換えた数 */
  replaced: number;
  /** 辞書の語ごとの、聞き違えた形（vocabulary にある語だけ）。整形の辞書の行に添える */
  misheard?: Record<string, string[]>;
  /** 生テキストに出ている、以前の取り違えの組。整形に候補として渡す（LLM を使うときだけ） */
  corrections?: { heard: string; corrected: string }[];
  /** 整形が書き換えてはいけない語句（利用者が元に戻したもの） */
  kept?: { phrase: string; changedTo: string }[];
  /** 利用者が、取り違えの組を 1 つでも持っているか（整形の規則に説明を足すかどうかを決める） */
  hasCorrections?: boolean;
}

/** 読みを作る関数。LLM を使えないときは null を返す（次に辞書が変わったときに作り直す） */
type ReadingGenerator = (words: string[]) => Promise<Record<string, string[]> | null>;

export class CustomizationsStore extends EventEmitter {
  private value: Customizations;
  private readonly store: JsonStore<Customizations>;
  private readingGenerator: ReadingGenerator | null = null;
  private readingTimer: NodeJS.Timeout | null = null;
  private readingBusy = false;
  /** LLM を使えなかった（次に辞書が変わるまで作らない） */
  private readingUnavailable = false;
  /** 読みの生成に失敗した語（同じ起動中は作り直さない） */
  private readingFailed = new Set<string>();

  constructor(file: string) {
    super();
    this.store = new JsonStore<Customizations>(file);
    const saved = this.store.read() as Partial<Customizations> | undefined;
    this.value = { ...EMPTY_CUSTOMIZATIONS, ...saved, version: 1 };
    this.value.learnedWords = uniqLearned(this.value.learnedWords ?? []);
    if (!this.value.replacementCaseMigrated) {
      // 置換の preserveCase の意味が逆になった（G4-12）。以前のオフは「書いたとおりに入れる」、オンは「形を引き継ぐ」だった。
      // 新しい意味ではオンが「書いたとおり」、オフが「文頭で先頭の英小文字を大文字にする」なので、1 回だけ反転する
      const flipped = this.value.replacements.length > 0;
      this.value = {
        ...this.value,
        replacements: this.value.replacements.map((r) => ({ ...r, preserveCase: !r.preserveCase })),
        replacementCaseMigrated: true,
      };
      if (saved) this.store.write(this.value);
      if (flipped) log.info(`置換 ${this.value.replacements.length} 件の大文字小文字の設定を、新しい意味に移しました`);
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
      log.warn(`${WORD_MAX_LENGTH} 字を超える語を ${tooLong.length} 件、辞書に入れませんでした`);
      dict = dict.filter((w) => Array.from(w).length <= WORD_MAX_LENGTH);
    }
    if (dict.length > DICTIONARY_LIMIT) {
      // 画面で上限を検査しているので、ここに来るのは読み込みなど画面を通らない場合だけ
      log.warn(`辞書が上限（${DICTIONARY_LIMIT} 語）を超えたため、${dict.length - DICTIONARY_LIMIT} 語を入れませんでした`);
      dict = dict.slice(0, DICTIONARY_LIMIT);
    }
    next.dictionary = dict;
    next.learnedWords = this.capLearned(uniqLearned(next.learnedWords));
    next.blockedLearnedWords = uniq(next.blockedLearnedWords);
    // 消えた語の読みを片づける
    const alive = new Set([...next.dictionary, ...next.learnedWords.map((w) => w.word)]);
    const prune = (m?: Record<string, string[]>) => (m ? Object.fromEntries(Object.entries(m).filter(([k, v]) => alive.has(k) && Array.isArray(v) && v.length)) : undefined);
    next.readings = prune(next.readings);
    next.suggestedReadings = prune(next.suggestedReadings);
    next.misheard = prune(next.misheard);
    // 学習しない語にした語は、取り違えの組からも外す
    const blockedKeys = new Set(next.blockedLearnedWords.map((w) => w.toLowerCase()));
    if (next.pastCorrections) next.pastCorrections = next.pastCorrections.filter((c) => !blockedKeys.has(c.corrected.toLowerCase()));
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
    log.info(`学習語が上限（${LEARNED_LIMIT} 語）を超えたため、古い ${words.length - LEARNED_LIMIT} 語を外しました`);
    return words.filter((w) => keep.has(w));
  }

  /** プロンプトと ASR の語彙ヒントに使う語（辞書と学習語） */
  vocabulary(): string[] {
    return uniq([...this.value.dictionary, ...this.value.learnedWords.map((w) => w.word)]);
  }

  /** 得点付けに使う語の一覧（辞書と学習語） */
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
   * ASR に語彙ヒントとして渡す語（G4-09）。今の入力先と最近の書き起こしとの関係で得点を付け、高い順に返す。
   * 文脈を渡さなければ、最近学習した語、学習語、新しく登録した語の順になる。
   */
  asrHints(opts: number | HintOptions = {}): string[] {
    const o: HintOptions = typeof opts === 'number' ? { limit: opts } : opts;
    return rankVocabulary(this.entries(), o)
      .slice(0, o.limit ?? ASR_HINT_LIMIT)
      .map((s) => s.word);
  }

  /** 整形の LLM に渡す語（G4-10）。辞書が大きいときは得点の高い語に絞る */
  formatterVocabulary(opts: HintOptions = {}): string[] {
    return rankVocabulary(this.entries(), opts)
      .slice(0, opts.limit ?? FORMATTER_VOCAB_LIMIT)
      .map((s) => s.word);
  }

  /** 照合に使う語と読み（G4-11）。学習語の誤認識の形と、利用者の読みは確かめた読みとして扱う */
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
    // 手直しから学んだ、聞き違えた形（辞書の語にも学習語にも付く）。利用者が直した形なので、学習語の形と同じ扱いにする
    for (const [word, forms] of Object.entries(this.value.misheard ?? {})) {
      for (const f of forms) {
        const from = f.trim();
        if (from && from !== word) add(word, { text: from, confirmed: usableFromForm(from) });
      }
    }
    return [...map.entries()].map(([word, rs]) => ({ word, readings: rs }));
  }

  /** 語ごとの、聞き違えた形（学習語の最初の形と、後から学んだ形）。新しい形を先にする */
  misheardForms(word: string): string[] {
    const lw = this.value.learnedWords.find((w) => w.word === word);
    const later = [...(this.value.misheard?.[word] ?? [])].reverse();
    const all = [...later, ...(lw?.from ? [lw.from] : [])].map((f) => f.trim()).filter((f) => f && normKey(f) !== normKey(word));
    return uniq(all);
  }

  /** 整形に渡す、聞き違えた形（words にある語だけ） */
  private formsFor(words: readonly string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const w of words) {
      const forms = this.misheardForms(w).slice(0, FORMATTER_FORMS_PER_WORD);
      if (forms.length) out[w] = forms;
    }
    return out;
  }

  /** 生テキストに出ている、以前の取り違えの組（回数の多い順、新しい順） */
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

  /** 整形に渡す、書き換えない語句。古い順に並べる（新しい語句を足しても、前のほうが変わらないように） */
  keptPhrases(): { phrase: string; changedTo: string }[] {
    // 同じ時刻のものは、足した順を保つ
    return (this.value.keptPhrases ?? [])
      .map((k, i) => ({ k, i }))
      .sort((a, b) => b.k.at - a.k.at || b.i - a.i)
      .slice(0, FORMATTER_KEPT_LIMIT)
      .reverse()
      .map(({ k }) => ({ phrase: k.phrase, changedTo: k.changedTo }));
  }

  /**
   * 書き起こしの後、整形の前に呼ぶ（G4-10、G4-11）。
   * 辞書の語との照合の候補を作り、LLM を使うなら候補を整形に渡し、使わないなら確かめた読みだけを置き換える。
   * 整形に渡す語は、得点の高い順に絞り、照合で見つかった語は必ず入れる。
   */
  prepareFormatting(rawText: string, opts: PrepareOptions): PreparedFormatting {
    const matches = findDictionaryCandidates(rawText, this.matchEntries());
    const ranked = this.formatterVocabulary({ context: opts.context, recent: opts.recent, now: opts.now, limit: opts.vocabularyLimit });
    const chosen = uniq([...matches.map((m) => m.word), ...ranked]).slice(0, Math.max(ranked.length, matches.length));
    // 並びは、辞書に入っている順（辞書の語、学習語の順）にそろえる。得点の順のままにすると、発話ごとに並びが変わり、
    // 整形のシステムプロンプトが毎回変わって、プロンプトキャッシュが効かなくなる。並びの違いで、LLM の出力もゆらぐ
    const position = new Map(this.vocabulary().map((w, i) => [w.toLowerCase(), i]));
    const vocabulary = [...chosen].sort((a, b) => (position.get(a.toLowerCase()) ?? Infinity) - (position.get(b.toLowerCase()) ?? Infinity));
    const learned = {
      misheard: this.formsFor(vocabulary),
      kept: this.keptPhrases(),
      hasCorrections: (this.value.pastCorrections?.length ?? 0) > 0,
    };
    if (!opts.useLlm) {
      const { text, replaced } = applyConfirmedMatches(rawText, matches);
      if (replaced) log.info(`辞書の読みと一致した ${replaced} か所を置き換えました`);
      // 取り違えの組は、文脈を見ないと決められないので、LLM を使わないときは使わない
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
   * すでに辞書にある語（辞書の語と学習語）の、新しい聞き違えた形を足す。足した形を返す。
   * 学習語の最初の形（learnedWords の from）と同じ形、語そのものと同じ形は足さない。
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

  /** 聞き違えた形を外す（学習の取り消し） */
  removeMisheardForm(word: string, from: string): void {
    const cur = this.value.misheard?.[word];
    if (!cur) return;
    this.update({ misheard: { ...this.value.misheard, [word]: cur.filter((x) => x !== from) } });
  }

  /**
   * 取り違えの組を足す。足した組（新しく覚えたものと、回数を増やしたもの）を返す。
   * 同じ組は回数を増やす。逆向きの組（直した語を、元の語に直した）があれば、古いほうを外す。
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

  /** 書き換えない語句を足す。足した語句を返す。同じ語句は回数を増やす */
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
   * 学習した語を足す。足した語を返す。
   * - 同じ語は 1 つにまとめ、辞書にある語と学習しない語は足さない
   * - 新しい語の誤認識の形が既存の学習語と同じなら（学習語を別の語に直したなら）、古い学習語を外して学習しない語に入れる（G4-06）
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
    if (takenBack.size) log.info(`学習語 ${takenBack.size} 語を、新しい手直しに合わせて取り下げました`);
    this.update({
      learnedWords: [...this.value.learnedWords.filter((x) => !takenBack.has(x.word)), ...added],
      blockedLearnedWords: [...this.value.blockedLearnedWords, ...takenBack],
    });
    return added;
  }

  /** 学習を取り消し、同じ語を二度と学習しないようにする（LRN-2） */
  undoLearnedWord(word: string): void {
    this.update({
      learnedWords: this.value.learnedWords.filter((w) => w.word !== word),
      blockedLearnedWords: [...this.value.blockedLearnedWords, word],
    });
  }

  /**
   * 読みを作る関数を設定する（main で LLM の接続を渡す）。
   * 設定すると、読みのない英字の辞書の語について、少し待ってからまとめて読みを作る。
   */
  setReadingGenerator(fn: ReadingGenerator | null): void {
    this.readingGenerator = fn;
    this.readingUnavailable = false;
    this.scheduleReadings();
  }

  /** 読みがまだない英字の辞書の語 */
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

  /** 読みのない語の読みを今すぐ作る（最大 50 語ずつ） */
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
      log.info(`辞書の ${entries.length} 語に読みの候補を作りました`);
      return entries.length;
    } catch (e) {
      for (const w of words) this.readingFailed.add(w);
      log.warn('読みの候補を作れませんでした', e);
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
