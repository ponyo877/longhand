import type { FieldWatchResultPayload } from '../../shared/protocol';
import type { LearnedWord } from '../../shared/types';
import { parseJsonObject } from '../format/postprocess';
import type { LlmProvider } from '../llm/types';
import { createLogger } from '../log';
import type { Tokenizer } from '../textfix/types';
import { editDistance, hasKanji, isKanaOnly, soundForm, soundsSimilar } from '../vocab/kana';
import { extractReplacements, extractRewrites, hasDistinctiveCase, locateEditedRegion, type Replacement } from './diff';
import { detectNumberStyles, isNumberNotationChange, type NumberStyleObservation } from './numberStyle';

const log = createLogger('learn');

/** Maximum number of words learned from one correction. More replacements than this count as rewriting, and nothing is learned (G4-16) */
export const MAX_WORDS_PER_EDIT = 3;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    words: {
      type: 'array',
      items: {
        type: 'object',
        properties: { word: { type: 'string' }, add: { type: 'boolean' } },
        required: ['word', 'add'],
        additionalProperties: false,
      },
    },
  },
  required: ['words'],
  additionalProperties: false,
};

const JUDGE_SYSTEM = `あなたは音声入力アプリの辞書係です。
ユーザーは音声入力の結果を手で直しました。直した語の組（heard: 音声認識が出した語、corrected: ユーザーが直した語）から、
今後の音声認識のためにユーザー辞書へ登録すべき語を選びます。

登録すべき語:
- 人名、社名、製品名、サービス名、プロジェクト名などの固有名詞
- 専門用語、業界や組織の用語、略語、英字表記の技術用語
- 音声認識が今後も聞き間違えそうな、一般的でない表記

登録しない語:
- 文法、言い回し、語尾、敬語の手直し
- 一般的な語や、単なる打ち間違いの修正
- 意味ごと変えた書き換え（heard と corrected の音が似ていない）
- 文や句そのもの（語ではないもの）

出力は {"words": [{"word": "<corrected の語>", "add": true または false}]} の JSON だけにしてください。`;

/** A case-only fix (limited to words whose case carries meaning, such as iPhone and macOS) */
function caseOnlyFix(r: Replacement): boolean {
  const f = r.from.normalize('NFKC');
  const t = r.to.normalize('NFKC');
  return f !== t && f.toLowerCase() === t.toLowerCase() && hasDistinctiveCase(t);
}

/**
 * Judgment when the LLM is unavailable (G4-05). Accepts only pairs where the heard word and the corrected word sound alike.
 * - Latin words: ones whose case carries meaning (iPhone, CPU), or a word heard as kana corrected into Latin letters
 * - Katakana words: 3 or more characters, corrected from a word heard as kana
 * Words with kanji are not accepted because their reading is unknown. Rewordings (「打ち合わせ」→「ミーティング」) sound different and are not accepted.
 */
export function heuristicAccept(r: Replacement): boolean {
  if (hasKanji(r.from) || hasKanji(r.to)) return false;
  if (caseOnlyFix(r)) return true;
  if (!soundsSimilar(r.from, r.to)) return false;
  if (/^[A-Za-z][A-Za-z0-9.+#_ -]{1,}$/.test(r.to)) {
    if (hasDistinctiveCase(r.to) || /[0-9]/.test(r.to)) return true;
    return isKanaOnly(r.from.replace(/\s/g, '')) && r.to.replace(/[^A-Za-z]/g, '').length >= 3;
  }
  if (/^[゠-ヿー]{3,}$/.test(r.to)) return isKanaOnly(r.from);
  return false;
}

export interface LearnContext {
  /** The pasted text (without command syntax) */
  inserted: string;
  vocabulary: string[];
  blocked: string[];
  provider: LlmProvider | null;
  timeoutMs: number;
  /** Transcript before formatting (speech recognition output). Used to spot corrections that undo a formatter rewrite. Without it, no such check */
  rawText?: string;
  /** Tokenizer for looking up readings. Without it, readings of phrases with kanji are treated as unknown */
  tokenizer?: Tokenizer | null;
  /** Time of learning. Now if omitted (evaluation passes a fixed time so results do not change between runs) */
  now?: number;
}

/** A new misheard form of a word already in the dictionary */
export interface MisheardForm {
  word: string;
  from: string;
}

/** A pair that fixes a recognition mix-up (not added to the dictionary) */
export interface CorrectionPair {
  heard: string;
  corrected: string;
}

/** A phrase whose formatter rewrite was undone */
export interface KeptPair {
  phrase: string;
  changedTo: string;
}

/** Maximum number of mix-up pairs and of phrases not to rewrite learned from one correction (each). Beyond this it counts as rewriting, and none are learned */
export const MAX_PAIRS_PER_EDIT = 3;

/** Form used for comparison (ignores full-width/half-width, case, whitespace and punctuation) */
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '');

/** Whether the numbers differ. A number fix cannot be decided from context even if it was a mishearing, so it does not become a mix-up pair */
function numbersDiffer(a: string, b: string): boolean {
  const digits = (s: string) => s.normalize('NFKC').replace(/[^0-9]/g, '');
  if (digits(a) !== digits(b)) return true;
  const kanji = (s: string) => s.replace(/[^〇一二三四五六七八九十百千万億]/g, '');
  return !!kanji(a) && !!kanji(b) && kanji(a) !== kanji(b);
}

/** Reading of a phrase. null if it contains kanji and the reading is unknown */
function readingOf(text: string, known: string | undefined, tokenizer: Tokenizer | null | undefined): string | null {
  if (known) return known;
  if (!hasKanji(text)) return text;
  let tokens: ReturnType<Tokenizer['tokenize']> = null;
  try {
    tokens = tokenizer?.tokenize(text) ?? null;
  } catch {
    tokens = null;
  }
  if (!tokens?.length) return null;
  let out = '';
  for (const t of tokens) {
    if (!t.reading && hasKanji(t.surface)) return null;
    out += t.reading || t.surface;
  }
  return out || null;
}

/**
 * Whether two phrases sound the same or very close (another word with the same reading, a spelling difference, a one-sound mishearing).
 * A one-sound difference counts only for reasonably long words. Short words (「出し」 and 「足し」, for example) are often alike by chance
 */
export function closeSound(a: string, b: string): boolean {
  const fa = soundForm(a);
  const fb = soundForm(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  return Math.min(fa.length, fb.length) >= 5 && editDistance(fa, fb) <= 1;
}

/** A pair spanning punctuation mixes in a fix to sentence breaks, not just to a phrase */
const crossesPunctuation = (r: Replacement) => /[、。，．,]/.test(r.from + r.to);

/** Whether a phrase is long enough to learn (2 or more characters, or a single kanji) */
const longEnough = (s: string) => Array.from(s).length >= 2 || hasKanji(s);

/** Why nothing was learned (for logs) */
export type SkipReason = 'unreadable' | 'no_keystrokes' | 'no_region' | 'removed' | 'no_candidates' | 'too_many' | 'declined';

/** Result when nothing was learned */
const nothing = (): Pick<LearnResult, 'words' | 'forms' | 'corrections' | 'kept' | 'numbers'> => ({ words: [], forms: [], corrections: [], kept: [], numbers: [] });

export interface LearnResult {
  words: LearnedWord[];
  /** New misheard forms of words already in the dictionary */
  forms: MisheardForm[];
  /** Pairs that fix recognition mix-ups (another word with the same reading, a spelling preference) */
  corrections: CorrectionPair[];
  /** Phrases whose formatter rewrite was undone */
  kept: KeptPair[];
  /** Number notations the correction asked for ("2つ" to "二つ") */
  numbers: NumberStyleObservation[];
  skipped?: SkipReason;
  /** How the region was found (for logs) */
  method?: string;
  candidates: number;
}

/**
 * Extracts the text before and after the correction from the watch result.
 * If there is a reading from before the user started typing (baseline), it is the reference (excluding changes made by the app, G4-03).
 * On send (enter, sent), final is the reading right before sending. For compatibility with older helpers,
 * if the region is gone in final and preSend differs, preSend is tried too (G4-01).
 */
export function regionFromWatch(w: FieldWatchResultPayload, inserted: string) {
  const ref = w.baseline || w.afterPaste;
  // Convert the paste position reported by the helper (UTF-16) to a character (code point) position
  const near = typeof w.insertOffset === 'number' ? Array.from(w.before.slice(0, w.insertOffset)).length : undefined;
  const opts = { inserted: w.inserted || inserted, near };
  let region = locateEditedRegion(w.before, ref, w.final, opts);
  if ((!region || !region.edited.trim()) && w.preSend && w.preSend !== w.final) {
    const pre = locateEditedRegion(w.before, ref, w.preSend, opts);
    if (pre?.edited.trim()) region = pre;
  }
  return region;
}

/**
 * Learns words from corrections after a paste (LRN-1). Returns the result with reasons.
 * The diff is extracted on the device; the LLM gets only the corrected word pairs and short surrounding context to judge them.
 */
export async function learnFromWatchDetailed(w: FieldWatchResultPayload, ctx: LearnContext): Promise<LearnResult> {
  if (w.reason === 'unreadable') return { ...nothing(), skipped: 'unreadable', candidates: 0 };
  // Changes without user keystrokes come from the app's auto-formatting or a late paste, so nothing is learned
  if (w.keystrokes === 0) return { ...nothing(), skipped: 'no_keystrokes', candidates: 0 };

  const region = regionFromWatch(w, ctx.inserted);
  if (!region) return { ...nothing(), skipped: 'no_region', candidates: 0 };
  // Nothing is learned when the pasted region is gone (sent, or replaced with other text)
  if (!region.edited.trim()) return { ...nothing(), skipped: 'removed', method: region.method, candidates: 0 };

  const r = await learnFromEdit(region.original, region.edited, ctx);
  return { ...r, method: region.method };
}

/**
 * Learns from the original text and the corrected text. Used both by the post-paste watch and by corrections in the history page (G4-08).
 * ctx.inserted is not used. Corrections are sorted into these five groups:
 * - New words (words): words for the dictionary. The LLM decides if available, otherwise the rules do
 * - Misheard forms (forms): corrections to a word already in the dictionary. If they sound alike, learned as a misheard form of that word
 * - Mix-up pairs (corrections): fixes to phrases not added to the dictionary whose readings are the same or very close (another word with the same reading, a spelling preference)
 * - Phrases not to rewrite (kept): corrections that put a formatter rewrite back the way it was transcribed
 * - Number notations (numbers): changes that only rewrite how a number is written, such as "2つ" to "二つ"
 */
export async function learnFromEdit(original: string, edited: string, ctx: Omit<LearnContext, 'inserted'>): Promise<LearnResult> {
  const known = new Set(ctx.vocabulary.map((x) => x.toLowerCase()));
  const blocked = new Set(ctx.blocked.map((x) => x.toLowerCase()));
  const tokenizer = ctx.tokenizer ?? null;
  const raw = ctx.rawText ? norm(ctx.rawText) : '';
  // The formatter changed a phrase from the transcript (to) into another form (from), and the user changed it back
  const reverted = (r: Replacement) => !!raw && raw.includes(norm(r.to)) && !raw.includes(norm(r.from));

  // Mix-up pairs and phrases not to rewrite are learned only when they can be cut at word boundaries.
  // Without a tokenizer, pairs cut mid-word (「何」→「なん」) would be learned
  let canSplit = false;
  try {
    canSplit = !!tokenizer?.tokenize(edited)?.length;
  } catch {
    canSplit = false;
  }
  // Number notation changes are learned as a style of their own, not as words or corrections
  const numbers = detectNumberStyles(original, edited);
  const notNumberStyle = (r: Replacement) => !numbers.length || !isNumberNotationChange(r.from, r.to);
  const rewrites = (canSplit ? extractRewrites(original, edited, tokenizer) : []).filter(notNumberStyle);
  let kept: KeptPair[] = rewrites.filter((r) => reverted(r) && longEnough(r.to) && !crossesPunctuation(r)).map((r) => ({ phrase: r.to, changedTo: r.from }));
  if (kept.length > MAX_PAIRS_PER_EDIT) kept = [];

  const wordPairs = extractReplacements(original, edited).filter((r) => !reverted(r) && notNumberStyle(r));
  const candidates = wordPairs.filter((r) => !known.has(r.to.toLowerCase()) && !blocked.has(r.to.toLowerCase()));
  if (candidates.length > MAX_WORDS_PER_EDIT) return { ...nothing(), skipped: 'too_many', candidates: candidates.length };

  // Fixes to a word already in the dictionary. If they sound alike, learn a misheard form (rewording into another word is not learned)
  const forms: MisheardForm[] = wordPairs
    .filter((r) => known.has(r.to.toLowerCase()) && !known.has(r.from.toLowerCase()))
    .filter((r) => {
      const a = readingOf(r.from, undefined, tokenizer);
      const b = readingOf(r.to, undefined, tokenizer);
      return (a !== null && b !== null && soundsSimilar(a, b)) || caseOnlyFix(r);
    })
    .map((r) => ({ word: r.to, from: r.from }));

  let accepted: Replacement[] = [];
  if (candidates.length) {
    log.info(`Found ${candidates.length} candidate(s) in the correction`);
    if (ctx.provider) {
      try {
        const res = await ctx.provider.complete({
          system: JUDGE_SYSTEM,
          user: JSON.stringify({ pairs: candidates.map((c) => ({ heard: c.from, corrected: c.to, context: c.context })) }),
          jsonSchema: JUDGE_SCHEMA,
          maxOutputTokens: 512,
          timeoutMs: Math.max(ctx.timeoutMs, 10000),
        });
        const parsed = parseJsonObject(res.text);
        const words = Array.isArray(parsed?.words) ? (parsed!.words as { word?: unknown; add?: unknown }[]) : [];
        const yes = new Set(words.filter((x) => x.add === true && typeof x.word === 'string').map((x) => String(x.word)));
        accepted = candidates.filter((c) => yes.has(c.to));
      } catch (e) {
        log.warn('Could not judge the learned words. Judging with the rules instead', e);
        accepted = candidates.filter(heuristicAccept);
      }
    } else {
      accepted = candidates.filter(heuristicAccept);
    }
  }
  const now = ctx.now ?? Date.now();
  const seen = new Set<string>();
  const words = accepted
    .filter((c) => {
      const k = c.to.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => ({ word: c.to, from: c.from, learnedAt: now }));

  // Fixes not added to the dictionary whose readings are the same or very close are learned as mix-up pairs.
  // Mix-ups between two dictionary words land here too (both are real words, so context decides)
  const taken = [...words.map((w) => w.word), ...forms.map((f) => f.word), ...kept.map((k) => k.phrase)].map(norm);
  let corrections: CorrectionPair[] = rewrites
    .filter((r) => !reverted(r) && !blocked.has(r.to.toLowerCase()) && longEnough(r.from) && longEnough(r.to) && !crossesPunctuation(r))
    .filter((r) => !taken.some((t) => norm(r.to).includes(t) || t.includes(norm(r.to))))
    .filter((r) => !known.has(r.to.toLowerCase()) || known.has(r.from.toLowerCase()))
    .filter((r) => !numbersDiffer(r.from, r.to))
    .filter((r) => {
      const a = readingOf(r.from, r.fromReading, tokenizer);
      const b = readingOf(r.to, r.toReading, tokenizer);
      return a !== null && b !== null && closeSound(a, b);
    })
    .map((r) => ({ heard: r.from, corrected: r.to }));
  if (corrections.length > MAX_PAIRS_PER_EDIT) corrections = [];

  const learned = words.length + forms.length + corrections.length + kept.length + numbers.length;
  const skipped: SkipReason | undefined = learned ? undefined : candidates.length ? 'declined' : 'no_candidates';
  return { words, forms, corrections, kept, numbers, skipped, candidates: candidates.length };
}

/** Learns words from corrections after a paste (LRN-1). Returns only the learned words (the older calling style) */
export async function learnFromWatch(watch: FieldWatchResultPayload, ctx: LearnContext): Promise<LearnedWord[]> {
  const r = await learnFromWatchDetailed(watch, ctx);
  if (r.skipped && r.skipped !== 'no_candidates') {
    log.info(`Learned nothing (${r.skipped}${r.method ? `, region: ${r.method}` : ''}${r.candidates ? `, ${r.candidates} candidate(s)` : ''})`);
  }
  return r.words;
}
