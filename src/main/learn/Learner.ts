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

/** 1 回の手直しで学習する語の上限。これを超える置き換えは推敲とみなして何も学習しない（G4-16） */
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

/** 大文字小文字だけの直し（iPhone、macOS など、形に意味がある語に限る） */
function caseOnlyFix(r: Replacement): boolean {
  const f = r.from.normalize('NFKC');
  const t = r.to.normalize('NFKC');
  return f !== t && f.toLowerCase() === t.toLowerCase() && hasDistinctiveCase(t);
}

/**
 * LLM を使えないときの判定（G4-05）。聞き取った語と直した語の音が近いものだけを採る。
 * - 英字の語: 大文字小文字の形に意味があるか（iPhone、CPU）、かなで聞き取られた語を英字に直したもの
 * - カタカナの語: 3 文字以上で、かなで聞き取られた語を直したもの
 * 漢字を含む語は読みが分からないので採らない。言い換え（「打ち合わせ」→「ミーティング」）は音が違うので採らない。
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
  /** 貼り付けた文（コマンド記法を除いたもの） */
  inserted: string;
  vocabulary: string[];
  blocked: string[];
  provider: LlmProvider | null;
  timeoutMs: number;
  /** 整形の前の書き起こし（音声認識の出力）。整形の書き換えを元に戻した手直しを見分けるのに使う。なければ見分けない */
  rawText?: string;
  /** 読みを調べるための単語分割。なければ、漢字を含む語句の読みは分からないものとして扱う */
  tokenizer?: Tokenizer | null;
  /** 学習した時刻。省けば今（評価では、結果が実行のたびに変わらないように、決まった時刻を渡す） */
  now?: number;
}

/** すでに辞書にある語の、新しい聞き違えた形 */
export interface MisheardForm {
  word: string;
  from: string;
}

/** 音声認識の取り違えを直した組（辞書には入れない） */
export interface CorrectionPair {
  heard: string;
  corrected: string;
}

/** 整形の書き換えを元に戻した語句 */
export interface KeptPair {
  phrase: string;
  changedTo: string;
}

/** 1 回の手直しで覚える、取り違えの組と、書き換えない語句の上限（それぞれ）。超えたら推敲とみなして覚えない */
export const MAX_PAIRS_PER_EDIT = 3;

/** 比べるときの形（全角と半角、大文字と小文字、空白と句読点の違いを無視する） */
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '');

/** 数が違うか。数の直しは、聞き違いでも文脈からは決められないので、取り違えの組にしない */
function numbersDiffer(a: string, b: string): boolean {
  const digits = (s: string) => s.normalize('NFKC').replace(/[^0-9]/g, '');
  if (digits(a) !== digits(b)) return true;
  const kanji = (s: string) => s.replace(/[^〇一二三四五六七八九十百千万億]/g, '');
  return !!kanji(a) && !!kanji(b) && kanji(a) !== kanji(b);
}

/** 語句の読み。漢字を含むのに読みが分からなければ null */
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
 * 音が同じか、ごく近いか（同じ読みの別の語、表記の違い、1 音だけの聞き違い）。
 * 1 音だけの違いは、ある程度の長さの語に限る。短い語（「出し」と「足し」など）は、たまたま似ているだけのことが多い
 */
export function closeSound(a: string, b: string): boolean {
  const fa = soundForm(a);
  const fb = soundForm(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  return Math.min(fa.length, fb.length) >= 5 && editDistance(fa, fb) <= 1;
}

/** 句読点をまたぐ組は、語句の直しではなく、文の区切りの直しが混ざっている */
const crossesPunctuation = (r: Replacement) => /[、。，．,]/.test(r.from + r.to);

/** 覚える語句として短すぎないか（2 字以上か、漢字 1 字） */
const longEnough = (s: string) => Array.from(s).length >= 2 || hasKanji(s);

/** 学習しなかった理由（ログ用） */
export type SkipReason = 'unreadable' | 'no_keystrokes' | 'no_region' | 'removed' | 'no_candidates' | 'too_many' | 'declined';

/** 何も学習しなかったときの結果 */
const nothing = (): Pick<LearnResult, 'words' | 'forms' | 'corrections' | 'kept' | 'numbers'> => ({ words: [], forms: [], corrections: [], kept: [], numbers: [] });

export interface LearnResult {
  words: LearnedWord[];
  /** すでに辞書にある語の、新しい聞き違えた形 */
  forms: MisheardForm[];
  /** 音声認識の取り違えを直した組（同じ読みの別の語、表記の好み） */
  corrections: CorrectionPair[];
  /** 整形の書き換えを元に戻した語句 */
  kept: KeptPair[];
  /** Number notations the correction asked for ("2つ" to "二つ") */
  numbers: NumberStyleObservation[];
  skipped?: SkipReason;
  /** 範囲の見つけ方（ログ用） */
  method?: string;
  candidates: number;
}

/**
 * 監視の結果から、手直しの前後の文を取り出す。
 * 利用者が打ち始める前の読み取り（baseline）があれば、それを基準にする（アプリによる変化を除く、G4-03）。
 * 送信（enter、sent）では final が送信直前の読み取りになっている。古いヘルパーとの互換のため、
 * final で範囲が消えていて preSend が別にあれば、preSend も試す（G4-01）。
 */
export function regionFromWatch(w: FieldWatchResultPayload, inserted: string) {
  const ref = w.baseline || w.afterPaste;
  // ヘルパーが報告した貼り付けの位置（UTF-16）を、文字（コードポイント）の位置にする
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
 * 貼り付け後の手直しから語を学習する（LRN-1）。理由つきの結果を返す。
 * 差分の抽出は端末内で行い、LLM には直した語の組と前後の短い文脈だけを送って採否を判定させる。
 */
export async function learnFromWatchDetailed(w: FieldWatchResultPayload, ctx: LearnContext): Promise<LearnResult> {
  if (w.reason === 'unreadable') return { ...nothing(), skipped: 'unreadable', candidates: 0 };
  // 利用者がキーを押していない変化は、アプリの自動整形や遅れて入った貼り付けなので学習しない
  if (w.keystrokes === 0) return { ...nothing(), skipped: 'no_keystrokes', candidates: 0 };

  const region = regionFromWatch(w, ctx.inserted);
  if (!region) return { ...nothing(), skipped: 'no_region', candidates: 0 };
  // 貼り付けた範囲が消えた（送信された、別の文に置き換わった）場合は学習しない
  if (!region.edited.trim()) return { ...nothing(), skipped: 'removed', method: region.method, candidates: 0 };

  const r = await learnFromEdit(region.original, region.edited, ctx);
  return { ...r, method: region.method };
}

/**
 * 元の文と手直し後の文から学習する。貼り付け後の監視と、履歴の画面での手直し（G4-08）の両方から使う。
 * ctx.inserted は使わない。手直しを、次の 5 つに振り分ける。
 * - 新しい語（words）: 辞書に入れる語。LLM が使えれば LLM が、使えなければ規則が採否を決める
 * - 聞き違えた形（forms）: すでに辞書にある語に直した手直し。音が近ければ、その語の聞き違えた形として覚える
 * - 取り違えの組（corrections）: 辞書に入れない語句への直しのうち、読みが同じか、ごく近いもの（同じ読みの別の語、表記の好み）
 * - 書き換えない語句（kept）: 整形が書き換えた所を、書き起こしのとおりに戻した手直し
 * - Number notations (numbers): changes that only rewrite how a number is written, such as "2つ" to "二つ"
 */
export async function learnFromEdit(original: string, edited: string, ctx: Omit<LearnContext, 'inserted'>): Promise<LearnResult> {
  const known = new Set(ctx.vocabulary.map((x) => x.toLowerCase()));
  const blocked = new Set(ctx.blocked.map((x) => x.toLowerCase()));
  const tokenizer = ctx.tokenizer ?? null;
  const raw = ctx.rawText ? norm(ctx.rawText) : '';
  // 書き起こしにあった語句（to）を、整形が別の形（from）に変えていて、利用者がそれを戻した
  const reverted = (r: Replacement) => !!raw && raw.includes(norm(r.to)) && !raw.includes(norm(r.from));

  // 取り違えの組と、書き換えない語句は、語の単位に切り出せるときだけ覚える。
  // 単語分割が無いと、語の途中で切れた組（「何」→「なん」）を覚えてしまう
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

  // すでに辞書にある語への直し。音が近ければ、聞き違えた形として覚える（別の語への言い換えは覚えない）
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
    log.info(`手直しから候補を ${candidates.length} 件見つけました`);
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
        log.warn('学習語の判定に失敗しました。規則で判定します', e);
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

  // 辞書に入れなかった直しのうち、読みが同じか、ごく近いものは、取り違えの組として覚える。
  // 辞書の語どうしの取り違えも、ここに入る（どちらも正しい語なので、文脈で決める）
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

/** 貼り付け後の手直しから語を学習する（LRN-1）。学習した語だけを返す（以前からの呼び出し方） */
export async function learnFromWatch(watch: FieldWatchResultPayload, ctx: LearnContext): Promise<LearnedWord[]> {
  const r = await learnFromWatchDetailed(watch, ctx);
  if (r.skipped && r.skipped !== 'no_candidates') {
    log.info(`学習しませんでした（${r.skipped}${r.method ? `、範囲: ${r.method}` : ''}${r.candidates ? `、候補 ${r.candidates} 件` : ''}）`);
  }
  return r.words;
}
