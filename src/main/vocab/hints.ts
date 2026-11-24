/**
 * 辞書の語に、今の音声入力との関係の深さで得点を付ける（G4-09、G4-10）。
 * whisper のプロンプトに入る語は 120 トークン分（数十語）しかないので、新しい順ではなく得点順に渡す。
 * 整形の LLM に渡す語も、辞書が大きいときは得点の高いものに絞る。
 */
import { matchForm } from './kana';

/** 入力先の文脈。入力欄はパスワード欄でないときだけ入れる */
export interface HintContext {
  beforeCursor?: string;
  afterCursor?: string;
  windowTitle?: string;
  host?: string;
  bundleId?: string;
}

/** 最近の書き起こし（HistoryItem をそのまま渡せる） */
export interface RecentText {
  text: string;
  rawText?: string;
  timestamp: number;
  app?: { bundleId: string };
}

export interface VocabEntry {
  word: string;
  /** 学習した語なら学習した時刻 */
  learnedAt?: number;
  /** 辞書に登録した順の新しさ（0 が最も古く、1 が最も新しい） */
  recency: number;
  /** 照合用の読み（カタカナ、ひらがな、誤認識の形）。最近の生テキストに出ていれば使われているとみなす */
  readings?: string[];
}

export interface HintOptions {
  limit?: number;
  context?: HintContext;
  recent?: RecentText[];
  now?: number;
}

const DAY = 24 * 60 * 60 * 1000;
/** 最近の書き起こしとして見る範囲 */
const RECENT_DAYS = 14;
const RECENT_MAX = 100;

/** 得点の重み。合計の大小だけに意味がある */
const W = {
  field: 3,
  titleOrHost: 2,
  recentMax: 3,
  learned: 1,
  learnedWeek: 1.5,
  learnedMonth: 0.5,
  recency: 0.5,
  /** 学習の記録がないのに、最近の生テキストにそのまま何度も出ている語（ヒントがなくても書ける可能性が高い） */
  easyPenalty: -0.5,
};

function isLatinTerm(term: string): boolean {
  return /^[\x20-\x7e]+$/.test(term);
}

/** text（小文字にしたもの）に term が出てくる回数。英字の語は前後が英数字でない位置だけを数える */
export function countTerm(textLower: string, term: string): number {
  const t = term.toLowerCase();
  if (!t) return 0;
  const latin = isLatinTerm(t);
  let n = 0;
  for (let i = textLower.indexOf(t); i >= 0; i = textLower.indexOf(t, i + t.length)) {
    if (latin) {
      const before = textLower[i - 1];
      const after = textLower[i + t.length];
      if ((before && /[a-z0-9]/.test(before)) || (after && /[a-z0-9]/.test(after))) continue;
    }
    n++;
  }
  return n;
}

export interface ScoredWord {
  word: string;
  score: number;
}

/** 語ごとの得点を付けて、高い順に並べる。同点なら新しい語を先にする */
export function rankVocabulary(entries: VocabEntry[], opts: HintOptions = {}): ScoredWord[] {
  const now = opts.now ?? Date.now();
  const ctx = opts.context ?? {};
  const field = `${ctx.beforeCursor ?? ''}\n${ctx.afterCursor ?? ''}`.toLowerCase();
  const title = `${ctx.windowTitle ?? ''}\n${ctx.host ?? ''}`.toLowerCase();
  const recent = (opts.recent ?? [])
    .filter((r) => now - r.timestamp <= RECENT_DAYS * DAY)
    .slice(0, RECENT_MAX)
    .map((r) => ({
      text: (r.text ?? '').toLowerCase(),
      raw: (r.rawText ?? '').toLowerCase(),
      rawForm: matchForm(r.rawText ?? ''),
      weight: Math.exp(-(now - r.timestamp) / (7 * DAY)) * (ctx.bundleId && r.app?.bundleId === ctx.bundleId ? 1 : 0.4),
    }));

  const scored = entries.map((e) => {
    let score = 0;
    if (field.trim() && countTerm(field, e.word)) score += W.field;
    if (title.trim() && countTerm(title, e.word)) score += W.titleOrHost;
    let use = 0;
    let rawHits = 0;
    const readingForms = (e.readings ?? []).map(matchForm).filter((f) => f.length >= 3);
    for (const r of recent) {
      const inText = countTerm(r.text, e.word) > 0;
      const inRaw = countTerm(r.raw, e.word) > 0;
      const heardAsReading = readingForms.some((f) => r.rawForm.includes(f));
      if (inText || heardAsReading) use += r.weight;
      if (inRaw) rawHits++;
    }
    score += Math.min(W.recentMax, use * 1.5);
    if (e.learnedAt !== undefined) {
      score += W.learned;
      const age = now - e.learnedAt;
      if (age <= 7 * DAY) score += W.learnedWeek;
      else if (age <= 30 * DAY) score += W.learnedMonth;
    } else if (rawHits >= 3) {
      score += W.easyPenalty;
    }
    score += W.recency * e.recency;
    return { word: e.word, score, tie: e.learnedAt ?? e.recency };
  });
  scored.sort((a, b) => b.score - a.score || b.tie - a.tie);
  return scored.map(({ word, score }) => ({ word, score }));
}
