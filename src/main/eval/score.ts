/**
 * 発話ごとの採点と、その集計。
 *
 * 段階ごと（書き起こしの生の出力、読みの照合の後、LLM なしの最終、LLM ありの最終）に、正解との違いを数える。
 * 集計は数だけでできていて、文は含まない（summary.json と標準出力に出してよい）。
 */
import type { Uncertain } from '../asr/hypotheses';
import type { GuardSummary } from '../format/Formatter';
import type { Tokenizer } from '../textfix/types';
import { falseInsertions, termDetails, termRecall } from '../vocab/evalTerms';
import type { Split, Utterance } from './datasets';
import { addBreakdown, emptyBreakdown, ERROR_KIND_LABELS, ERROR_KINDS, errorBreakdown, type ErrorBreakdown } from './errorTypes';
import {
  addViolations,
  bestCer,
  EMPTY_VIOLATIONS,
  exactMatchAny,
  formatViolations,
  latinWordRecall,
  llmEffect,
  normContent,
  normFull,
  pct,
  styleViolations,
  toneShift,
  type Cer,
  type LlmEffect,
  type StyleViolations,
} from './metrics';
import type { StageTexts } from './pipeline';

export type StageName = keyof StageTexts;
export const STAGES: readonly StageName[] = ['asr', 'match', 'noLlm', 'final'];
export const STAGE_LABELS: Record<StageName, string> = {
  asr: '書き起こしの生の出力',
  match: '読みの照合の後',
  noLlm: 'LLM なしの最終',
  final: 'LLM ありの最終',
};

export type LlmMode = 'off' | 'live' | 'cache-only';

interface Hit {
  hit: number;
  total: number;
}

export interface StageScore {
  /** 中身の誤り（NFKC、小文字、句読点と空白を除く） */
  content: Cer;
  /** 句読点込みの誤り（空白だけ除く） */
  full: Cer;
  /** 正解か別解と完全に一致 */
  exact: boolean;
  errors: ErrorBreakdown;
  /** 正解に出る英字の語のうち、出力に出た数 */
  latin: Hit;
}

/** 発話ごとの記録（rows.jsonl の 1 行）。文を含むので、評価のフォルダの外には出さない */
export interface RowRecord {
  id: string;
  dataset: string;
  split: Split;
  chunk: number;
  durationSec: number;
  /** 正解が仮か */
  provisional: boolean;
  tags: string[];
  /** 台本の文の種類（lexicon、number など）。無いデータセットでは付かない */
  category?: string;
  target: string;
  spoken: string;
  alt: string[];
  stages: StageTexts;
  scores: Record<StageName, StageScore>;
  /** 書き起こしの生の出力を、話したままの文と比べたもの */
  asrVsSpoken: { content: Cer; full: Cer; exact: boolean };
  asr: {
    cached: boolean;
    segments: number;
    skipped?: string;
    computeMs: number;
    hintsUsed?: number;
    hintsGiven?: number;
    minConfidence: number | null;
    /** 聞き違いかもしれない箇所と別候補（聞き直しか別候補を求めた実行だけ） */
    uncertain?: Uncertain[];
    /** 書き起こす前に、音声の末尾から切り落とした長さ（ms）。切り落とさなければ付かない */
    truncatedMs?: number;
  };
  llm: {
    mode: LlmMode;
    /** LLM に頼んだ（保存済みの結果を使った場合を含む） */
    called: boolean;
    cached: boolean;
    /** 近道に入り、LLM を通さなかった */
    fastPath: boolean;
    formatted: boolean;
    /** 失敗の種類（本文は残さない） */
    errorKind?: string;
    /** LLM の応答にかかった時間 */
    ms: number;
    tries: number;
    /** アプリの時間切れ（既定 8 秒）を超えた。アプリなら LLM なしの文が入っていた */
    overAppTimeout: boolean;
    lowConfidence: boolean;
    /** LLM の出力の検査の結果（設定の formatGuard が off でないとき） */
    guard?: GuardSummary;
    /** 検査の前の LLM の出力（検査が何かを見つけたときだけ） */
    llmText?: string;
  };
  match: { replaced: number; candidates: number };
  textfix: { edits: number; byRule: Record<string, number>; candidates: number };
  terms: {
    /** 辞書の語（--vocab） */
    vocab: { asr: Hit; final: Hit; insertedAsr: number; insertedFinal: number; missedFinal: string[]; insertedFinalTerms: string[] };
    /** その発話に付いた用語（台本の読み上げ） */
    row: { asr: Hit; final: Hit; missedFinal: string[] };
  };
  style: { final: StyleViolations; target: StyleViolations; toneShift: number };
}

export function scoreStage(text: string, refs: readonly string[], tokenizer: Tokenizer | null): StageScore {
  const content = bestCer(text, refs, normContent);
  const full = bestCer(text, refs, normFull);
  const ref = refs[content.ref] ?? '';
  return {
    content: { edits: content.edits, len: content.len },
    full: { edits: full.edits, len: full.len },
    exact: exactMatchAny(text, refs),
    errors: errorBreakdown(ref, text, tokenizer),
    latin: latinWordRecall(ref, text),
  };
}

/** 発話の正解と段階ごとの文から、採点の部分を作る */
export function scoreUtterance(u: Utterance, stages: StageTexts, vocabTerms: string[], tokenizer: Tokenizer | null): Pick<RowRecord, 'scores' | 'asrVsSpoken' | 'terms' | 'style'> {
  const refs = [u.target, ...u.alt];
  const scores = Object.fromEntries(STAGES.map((s) => [s, scoreStage(stages[s], refs, tokenizer)])) as Record<StageName, StageScore>;
  const spoken = [u.spoken];
  const vocabDetail = termDetails(u.target, stages.final, vocabTerms);
  return {
    scores,
    asrVsSpoken: {
      content: bestCer(stages.asr, spoken, normContent),
      full: bestCer(stages.asr, spoken, normFull),
      exact: exactMatchAny(stages.asr, spoken),
    },
    terms: {
      vocab: {
        asr: termRecall(u.target, stages.asr, vocabTerms),
        final: termRecall(u.target, stages.final, vocabTerms),
        insertedAsr: falseInsertions(u.target, stages.asr, vocabTerms),
        insertedFinal: falseInsertions(u.target, stages.final, vocabTerms),
        missedFinal: vocabDetail.missed,
        insertedFinalTerms: vocabDetail.inserted,
      },
      row: {
        asr: termRecall(u.target, stages.asr, u.terms),
        final: termRecall(u.target, stages.final, u.terms),
        missedFinal: termDetails(u.target, stages.final, u.terms).missed,
      },
    },
    style: { final: styleViolations(stages.final), target: styleViolations(u.target), toneShift: toneShift(stages.asr, stages.final) },
  };
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

export interface StageSummary {
  contentEdits: number;
  contentLen: number;
  /** 中身の誤り率（合計どうしの割り算）。正解が空なら null */
  contentCer: number | null;
  fullEdits: number;
  fullLen: number;
  fullCer: number | null;
  exact: number;
  exactRate: number | null;
}

export interface GroupSummary {
  n: number;
  /** 正解が仮の発話と、人が確かめた発話 */
  provisional: number;
  reviewed: number;
  durationSec: number;
  stages: Record<StageName, StageSummary>;
  asrVsSpoken: StageSummary;
  llm: {
    /** LLM に頼んだ発話（保存済みの結果を使った分を含む） */
    called: number;
    cached: number;
    live: number;
    /** 近道に入り、LLM を通さなかった発話 */
    fastPath: number;
    /** LLM の失敗で、LLM なしの文に落ちた発話 */
    failed: number;
    /** 保存済みの結果が無かった発話（保存済みの結果だけを使う実行） */
    cacheMiss: number;
    overAppTimeout: number;
    lowConfidence: number;
    /** 整形の前（LLM なしの最終）と後（LLM ありの最終）の比較。全部の発話 */
    effect: LlmEffect;
    /** そのうち、LLM に頼んだ発話だけ */
    effectCalled: LlmEffect;
    /** 整形の前に正しかった発話のうち、壊した割合 */
    brokeRate: number | null;
    /** 整形の前に誤りがあった発話のうち、良くした割合 */
    improvedRate: number | null;
  };
  match: { utterances: number; replaced: number; candidates: number };
  textfix: { utterances: number; edits: number; byRule: Record<string, number> };
  terms: {
    vocab: { asr: Hit; final: Hit; insertedAsr: number; insertedFinal: number };
    row: { asr: Hit; final: Hit };
    latin: Record<StageName, Hit>;
  };
  errors: Record<StageName, ErrorBreakdown>;
  style: { final: StyleViolations; target: StyleViolations; toneShift: number };
}

const div = (a: number, b: number) => (b ? a / b : null);
const addHit = (a: Hit, b: Hit): Hit => ({ hit: a.hit + b.hit, total: a.total + b.total });

function stageSummary(rows: readonly { content: Cer; full: Cer; exact: boolean }[]): StageSummary {
  const s = { contentEdits: 0, contentLen: 0, fullEdits: 0, fullLen: 0, exact: 0 };
  for (const r of rows) {
    s.contentEdits += r.content.edits;
    s.contentLen += r.content.len;
    s.fullEdits += r.full.edits;
    s.fullLen += r.full.len;
    if (r.exact) s.exact++;
  }
  return { ...s, contentCer: div(s.contentEdits, s.contentLen), fullCer: div(s.fullEdits, s.fullLen), exactRate: div(s.exact, rows.length) };
}

export function summarizeGroup(rows: readonly RowRecord[]): GroupSummary {
  const effectOf = (rs: readonly RowRecord[]) => llmEffect(rs.map((r) => ({ before: r.scores.noLlm.content.edits, after: r.scores.final.content.edits })));
  const effect = effectOf(rows);
  const byRule: Record<string, number> = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.textfix.byRule)) byRule[k] = (byRule[k] ?? 0) + n;
  const zero: Hit = { hit: 0, total: 0 };
  return {
    n: rows.length,
    provisional: rows.filter((r) => r.provisional).length,
    reviewed: rows.filter((r) => !r.provisional).length,
    durationSec: Math.round(rows.reduce((n, r) => n + r.durationSec, 0)),
    stages: Object.fromEntries(STAGES.map((s) => [s, stageSummary(rows.map((r) => r.scores[s]))])) as Record<StageName, StageSummary>,
    asrVsSpoken: stageSummary(rows.map((r) => r.asrVsSpoken)),
    llm: {
      called: rows.filter((r) => r.llm.called).length,
      cached: rows.filter((r) => r.llm.called && r.llm.cached).length,
      live: rows.filter((r) => r.llm.called && !r.llm.cached && r.llm.tries > 0).length,
      fastPath: rows.filter((r) => r.llm.fastPath).length,
      failed: rows.filter((r) => r.llm.errorKind && r.llm.errorKind !== 'cache-miss').length,
      cacheMiss: rows.filter((r) => r.llm.errorKind === 'cache-miss').length,
      overAppTimeout: rows.filter((r) => r.llm.overAppTimeout).length,
      lowConfidence: rows.filter((r) => r.llm.lowConfidence).length,
      effect,
      effectCalled: effectOf(rows.filter((r) => r.llm.called)),
      brokeRate: div(effect.broke, effect.clean),
      improvedRate: div(effect.improved, effect.errored),
    },
    match: {
      utterances: rows.filter((r) => r.match.replaced || r.match.candidates).length,
      replaced: rows.reduce((n, r) => n + r.match.replaced, 0),
      candidates: rows.reduce((n, r) => n + r.match.candidates, 0),
    },
    textfix: { utterances: rows.filter((r) => r.textfix.edits).length, edits: rows.reduce((n, r) => n + r.textfix.edits, 0), byRule },
    terms: {
      vocab: {
        asr: rows.reduce((a, r) => addHit(a, r.terms.vocab.asr), zero),
        final: rows.reduce((a, r) => addHit(a, r.terms.vocab.final), zero),
        insertedAsr: rows.reduce((n, r) => n + r.terms.vocab.insertedAsr, 0),
        insertedFinal: rows.reduce((n, r) => n + r.terms.vocab.insertedFinal, 0),
      },
      row: { asr: rows.reduce((a, r) => addHit(a, r.terms.row.asr), zero), final: rows.reduce((a, r) => addHit(a, r.terms.row.final), zero) },
      latin: Object.fromEntries(STAGES.map((s) => [s, rows.reduce((a, r) => addHit(a, r.scores[s].latin), zero)])) as Record<StageName, Hit>,
    },
    errors: Object.fromEntries(STAGES.map((s) => [s, rows.reduce((a, r) => addBreakdown(a, r.scores[s].errors), emptyBreakdown())])) as Record<StageName, ErrorBreakdown>,
    style: {
      final: rows.reduce((a, r) => addViolations(a, r.style.final), { ...EMPTY_VIOLATIONS }),
      target: rows.reduce((a, r) => addViolations(a, r.style.target), { ...EMPTY_VIOLATIONS }),
      toneShift: rows.reduce((n, r) => n + r.style.toneShift, 0),
    },
  };
}

export interface Groups {
  all: GroupSummary;
  byDataset: Record<string, GroupSummary>;
  bySplit: Record<string, GroupSummary>;
  /** 「データセット/dev」のような名前 */
  byDatasetSplit: Record<string, GroupSummary>;
  /** 台本の文の種類ごと。種類の付いた発話があるときだけ（種類の無い発話は入らない） */
  byCategory?: Record<string, GroupSummary>;
}

export function summarize(rows: readonly RowRecord[]): Groups {
  const group = (key: (r: RowRecord) => string, of: readonly RowRecord[] = rows) => {
    const m = new Map<string, RowRecord[]>();
    for (const r of of) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, rs]) => [k, summarizeGroup(rs)]));
  };
  const withCategory = rows.filter((r) => r.category);
  return {
    all: summarizeGroup(rows),
    byDataset: group((r) => r.dataset),
    bySplit: group((r) => r.split),
    byDatasetSplit: group((r) => `${r.dataset}/${r.split}`),
    ...(withCategory.length ? { byCategory: group((r) => r.category!, withCategory) } : {}),
  };
}

// ---------------------------------------------------------------------------
// 表示（数だけ）
// ---------------------------------------------------------------------------

const rateText = (h: Hit) => `${h.hit}/${h.total}${h.total ? `（${((h.hit / h.total) * 100).toFixed(1)}%）` : ''}`;

/** 全角の字を 2 桁として、表示の幅をそろえる */
function padDisplay(label: string, width: number): string {
  const w = Array.from(label).reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return label + ' '.repeat(Math.max(0, width - w));
}

function stageLine(label: string, s: StageSummary, n: number): string {
  return `  ${padDisplay(label, 22)} 中身 ${pct(s.contentEdits, s.contentLen).padStart(6)}（${s.contentEdits}/${s.contentLen}） 句読点込み ${pct(s.fullEdits, s.fullLen).padStart(6)} 完全一致 ${s.exact}/${n}`;
}

/** まとまりごとの段階の表（1 つのまとまりにつき数行） */
export function formatGroup(name: string, g: GroupSummary, llmMode: LlmMode): string[] {
  const out = [`[${name}] ${g.n} 件（正解が仮 ${g.provisional} 件、確認済み ${g.reviewed} 件、${g.durationSec} 秒）`];
  for (const s of STAGES) {
    if (s === 'final' && llmMode === 'off') continue;
    out.push(stageLine(STAGE_LABELS[s], g.stages[s], g.n));
  }
  out.push(stageLine('生の出力と話したまま', g.asrVsSpoken, g.n));
  return out;
}

/** 台本の文の種類の並び（台本の定義の順）。ここに無い種類は、名前の順で後ろに並べる */
const CATEGORY_ORDER = ['lexicon', 'unlisted', 'number', 'homophone', 'particle', 'short', 'long', 'mixed'];

/** 文の種類ごとに、最終の誤り率を 1 行ずつ（LLM なしの実行では、LLM なしの最終） */
export function formatCategories(byCategory: Record<string, GroupSummary>, llmMode: LlmMode): string[] {
  const last: StageName = llmMode === 'off' ? 'noLlm' : 'final';
  const rank = (k: string) => (CATEGORY_ORDER.includes(k) ? CATEGORY_ORDER.indexOf(k) : CATEGORY_ORDER.length);
  return Object.keys(byCategory)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
    .map((k) => {
      const g = byCategory[k];
      const s = g.stages[last];
      const a = g.stages.asr;
      return (
        `[種類 ${padDisplay(k, 9)}] ${String(g.n).padStart(3)} 件  最終 中身 ${pct(s.contentEdits, s.contentLen).padStart(6)}（${s.contentEdits}/${s.contentLen}） ` +
        `句読点込み ${pct(s.fullEdits, s.fullLen).padStart(6)} 完全一致 ${s.exact}/${g.n}  生の出力 中身 ${pct(a.contentEdits, a.contentLen).padStart(6)}`
      );
    });
}

/** 全体の詳しい表示 */
export function formatDetail(g: GroupSummary, llmMode: LlmMode, vocabWords: number): string[] {
  const out: string[] = [];
  const l = g.llm;
  if (llmMode !== 'off') {
    out.push(
      `LLM            頼んだ ${l.called} 件（保存済み ${l.cached}、今回呼んだ ${l.live}）、近道 ${l.fastPath} 件、失敗 ${l.failed} 件` + (l.cacheMiss ? `、保存済みの結果なし ${l.cacheMiss} 件` : ''),
    );
    out.push(`               アプリの時間切れを超えた ${l.overAppTimeout} 件、確信度の低い字がある ${l.lowConfidence} 件`);
    const e = l.effect;
    out.push(`整形が壊した    整形の前に正しかった ${e.clean} 件のうち ${e.broke} 件${e.clean ? `（${((e.broke / e.clean) * 100).toFixed(1)}%）` : ''}`);
    out.push(
      `整形が良くした  整形の前に誤りのあった ${e.errored} 件のうち ${e.improved} 件${e.errored ? `（${((e.improved / e.errored) * 100).toFixed(1)}%）` : ''}、誤りがなくなった ${e.fixed} 件、悪くした ${e.worsened} 件`,
    );
  }
  out.push(`読みの照合      見つかった発話 ${g.match.utterances} 件（置き換え ${g.match.replaced} か所、LLM への候補 ${g.match.candidates} 件）`);
  const rules = Object.entries(g.textfix.byRule)
    .map(([k, n]) => `${k} ${n}`)
    .join('、');
  out.push(`語ごとの補正    ${g.textfix.edits} か所（${g.textfix.utterances} 件の発話）${rules ? `: ${rules}` : ''}`);
  const last: StageName = llmMode === 'off' ? 'noLlm' : 'final';
  out.push(`英字の語        生の出力 ${rateText(g.terms.latin.asr)} / LLM なし ${rateText(g.terms.latin.noLlm)}${llmMode === 'off' ? '' : ` / LLM あり ${rateText(g.terms.latin.final)}`}`);
  if (vocabWords) {
    out.push(`辞書の語の再現  生の出力 ${rateText(g.terms.vocab.asr)} / 最終 ${rateText(g.terms.vocab.final)}（辞書 ${vocabWords} 語）`);
    out.push(`辞書の語の誤挿入 生の出力 ${g.terms.vocab.insertedAsr} / 最終 ${g.terms.vocab.insertedFinal}`);
  }
  if (g.terms.row.asr.total) out.push(`発話の用語の再現 生の出力 ${rateText(g.terms.row.asr)} / 最終 ${rateText(g.terms.row.final)}`);
  out.push(`文体の違反      出力 ${formatViolations(g.style.final)} / 正解 ${formatViolations(g.style.target)}、口調の硬化 ${g.style.toneShift}`);
  const kinds = (b: ErrorBreakdown) =>
    ERROR_KINDS.filter((k) => b[k].edits)
      .map((k) => `${ERROR_KIND_LABELS[k]} ${b[k].edits}（${b[k].groups} か所）`)
      .join('、') || 'なし';
  out.push(`誤りの種類（生の出力） ${kinds(g.errors.asr)}`);
  out.push(`誤りの種類（${llmMode === 'off' ? 'LLM なしの最終' : 'LLM ありの最終'}） ${kinds(g.errors[last])}`);
  return out;
}
