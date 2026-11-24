/**
 * Scoring per utterance, and its totals.
 *
 * For each stage (raw transcription output, after reading match, final without the LLM, final with the LLM), counts the differences from the reference.
 * The totals are numbers only and contain no text (they may go to summary.json and standard output).
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
  asr: 'raw transcription',
  match: 'after reading match',
  noLlm: 'final without LLM',
  final: 'final with LLM',
};

export type LlmMode = 'off' | 'live' | 'cache-only';

interface Hit {
  hit: number;
  total: number;
}

export interface StageScore {
  /** Content errors (NFKC, lowercase, without punctuation and whitespace) */
  content: Cer;
  /** Errors including punctuation (only whitespace removed) */
  full: Cer;
  /** Exactly matches the reference or an alternative */
  exact: boolean;
  errors: ErrorBreakdown;
  /** How many Latin words in the reference appear in the output */
  latin: Hit;
}

/** Record per utterance (one line of rows.jsonl). It contains text, so it never leaves the evaluation folder */
export interface RowRecord {
  id: string;
  dataset: string;
  split: Split;
  chunk: number;
  durationSec: number;
  /** Whether the reference is provisional */
  provisional: boolean;
  tags: string[];
  /** Kind of script sentence (lexicon, number, ...). Absent for datasets without it */
  category?: string;
  target: string;
  spoken: string;
  alt: string[];
  stages: StageTexts;
  scores: Record<StageName, StageScore>;
  /** The raw transcription output compared with the sentence as spoken */
  asrVsSpoken: { content: Cer; full: Cer; exact: boolean };
  asr: {
    cached: boolean;
    segments: number;
    skipped?: string;
    computeMs: number;
    hintsUsed?: number;
    hintsGiven?: number;
    minConfidence: number | null;
    /** Spots that may be misheard and their alternative candidates (only for runs that asked for rehearing or alternatives) */
    uncertain?: Uncertain[];
    /** Length cut from the end of the audio before transcribing (ms). Absent when nothing was cut */
    truncatedMs?: number;
  };
  llm: {
    mode: LlmMode;
    /** The LLM was asked (including when a saved result was used) */
    called: boolean;
    cached: boolean;
    /** Took the fast path and skipped the LLM */
    fastPath: boolean;
    formatted: boolean;
    /** Kind of failure (the text itself is not kept) */
    errorKind?: string;
    /** Time the LLM took to respond */
    ms: number;
    tries: number;
    /** Exceeded the app's timeout (8 seconds by default). In the app, the text without the LLM would have been used */
    overAppTimeout: boolean;
    lowConfidence: boolean;
    /** Result of checking the LLM's output (when formatGuard in the settings is not off) */
    guard?: GuardSummary;
    /** The LLM's output before the check (only when the check found something) */
    llmText?: string;
  };
  match: { replaced: number; candidates: number };
  textfix: { edits: number; byRule: Record<string, number>; candidates: number };
  terms: {
    /** Dictionary words (--vocab) */
    vocab: { asr: Hit; final: Hit; insertedAsr: number; insertedFinal: number; missedFinal: string[]; insertedFinalTerms: string[] };
    /** Terms attached to the utterance (script readings) */
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

/** Builds the scoring part from an utterance's reference and the text of each stage */
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
// Totals
// ---------------------------------------------------------------------------

export interface StageSummary {
  contentEdits: number;
  contentLen: number;
  /** Content error rate (total divided by total). null if the reference is empty */
  contentCer: number | null;
  fullEdits: number;
  fullLen: number;
  fullCer: number | null;
  exact: number;
  exactRate: number | null;
}

export interface GroupSummary {
  n: number;
  /** Utterances with a provisional reference, and utterances checked by a person */
  provisional: number;
  reviewed: number;
  durationSec: number;
  stages: Record<StageName, StageSummary>;
  asrVsSpoken: StageSummary;
  llm: {
    /** Utterances the LLM was asked about (including those that used saved results) */
    called: number;
    cached: number;
    live: number;
    /** Utterances that took the fast path and skipped the LLM */
    fastPath: number;
    /** Utterances that fell back to the text without the LLM because the LLM failed */
    failed: number;
    /** Utterances with no saved result (in runs that use only saved results) */
    cacheMiss: number;
    overAppTimeout: number;
    lowConfidence: number;
    /** Comparison before formatting (final without the LLM) and after (final with the LLM). All utterances */
    effect: LlmEffect;
    /** Of those, only the utterances the LLM was asked about */
    effectCalled: LlmEffect;
    /** Share broken among the utterances that were correct before formatting */
    brokeRate: number | null;
    /** Share improved among the utterances that had errors before formatting */
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
  /** Names such as "<dataset>/dev" */
  byDatasetSplit: Record<string, GroupSummary>;
  /** Per kind of script sentence. Only when some utterances have a kind (utterances without one are left out) */
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
// Display (numbers only)
// ---------------------------------------------------------------------------

const rateText = (h: Hit) => `${h.hit}/${h.total}${h.total ? ` (${((h.hit / h.total) * 100).toFixed(1)}%)` : ''}`;

/** Aligns display width, counting a full-width character as two columns */
function padDisplay(label: string, width: number): string {
  const w = Array.from(label).reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return label + ' '.repeat(Math.max(0, width - w));
}

function stageLine(label: string, s: StageSummary, n: number): string {
  return (
    `  ${padDisplay(label, 22)} content ${pct(s.contentEdits, s.contentLen).padStart(6)} (${s.contentEdits}/${s.contentLen}) ` +
    `with punctuation ${pct(s.fullEdits, s.fullLen).padStart(6)} exact ${s.exact}/${n}`
  );
}

/** Table of stages per group (a few lines per group) */
export function formatGroup(name: string, g: GroupSummary, llmMode: LlmMode): string[] {
  const out = [`[${name}] n=${g.n} (provisional reference ${g.provisional}, reviewed ${g.reviewed}, ${g.durationSec} s)`];
  for (const s of STAGES) {
    if (s === 'final' && llmMode === 'off') continue;
    out.push(stageLine(STAGE_LABELS[s], g.stages[s], g.n));
  }
  out.push(stageLine('raw vs as spoken', g.asrVsSpoken, g.n));
  return out;
}

/** Order of the kinds of script sentence (the order in the script's definition). Kinds not listed here go after, sorted by name */
const CATEGORY_ORDER = ['lexicon', 'unlisted', 'number', 'homophone', 'particle', 'short', 'long', 'mixed'];

/** One line per kind of sentence with the final error rate (for runs without the LLM, the final without the LLM) */
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
        `[category ${padDisplay(k, 9)}] n=${String(g.n).padStart(3)}  final content ${pct(s.contentEdits, s.contentLen).padStart(6)} (${s.contentEdits}/${s.contentLen}) ` +
        `with punctuation ${pct(s.fullEdits, s.fullLen).padStart(6)} exact ${s.exact}/${g.n}  raw content ${pct(a.contentEdits, a.contentLen).padStart(6)}`
      );
    });
}

/** Detailed display of the whole */
export function formatDetail(g: GroupSummary, llmMode: LlmMode, vocabWords: number): string[] {
  const out: string[] = [];
  const l = g.llm;
  if (llmMode !== 'off') {
    out.push(`LLM              asked ${l.called} (cached ${l.cached}, called now ${l.live}), fast path ${l.fastPath}, failed ${l.failed}` + (l.cacheMiss ? `, no saved result ${l.cacheMiss}` : ''));
    out.push(`                 over the app's timeout ${l.overAppTimeout}, with low-confidence characters ${l.lowConfidence}`);
    const e = l.effect;
    out.push(`Broken by LLM    ${e.broke} of ${e.clean} correct before formatting${e.clean ? ` (${((e.broke / e.clean) * 100).toFixed(1)}%)` : ''}`);
    out.push(
      `Improved by LLM  ${e.improved} of ${e.errored} with errors before formatting${e.errored ? ` (${((e.improved / e.errored) * 100).toFixed(1)}%)` : ''}` +
        `, errors removed ${e.fixed}, worsened ${e.worsened}`,
    );
  }
  out.push(`Reading match    utterances ${g.match.utterances} (replaced ${g.match.replaced} spots, candidates for the LLM ${g.match.candidates})`);
  const rules = Object.entries(g.textfix.byRule)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  out.push(`Word fixes       edits ${g.textfix.edits} (utterances ${g.textfix.utterances})${rules ? `: ${rules}` : ''}`);
  const last: StageName = llmMode === 'off' ? 'noLlm' : 'final';
  out.push(`Latin words      raw ${rateText(g.terms.latin.asr)} / without LLM ${rateText(g.terms.latin.noLlm)}${llmMode === 'off' ? '' : ` / with LLM ${rateText(g.terms.latin.final)}`}`);
  if (vocabWords) {
    out.push(`Dictionary recall raw ${rateText(g.terms.vocab.asr)} / final ${rateText(g.terms.vocab.final)} (dictionary of ${vocabWords} words)`);
    out.push(`Dictionary false insertions raw ${g.terms.vocab.insertedAsr} / final ${g.terms.vocab.insertedFinal}`);
  }
  if (g.terms.row.asr.total) out.push(`Utterance term recall raw ${rateText(g.terms.row.asr)} / final ${rateText(g.terms.row.final)}`);
  out.push(`Style violations output ${formatViolations(g.style.final)} / reference ${formatViolations(g.style.target)}, more formal tone ${g.style.toneShift}`);
  const kinds = (b: ErrorBreakdown) =>
    ERROR_KINDS.filter((k) => b[k].edits)
      .map((k) => `${ERROR_KIND_LABELS[k]} ${b[k].edits} (${b[k].groups} spots)`)
      .join(', ') || 'none';
  out.push(`Error types (raw output) ${kinds(g.errors.asr)}`);
  out.push(`Error types (${llmMode === 'off' ? 'final without LLM' : 'final with LLM'}) ${kinds(g.errors[last])}`);
  return out;
}
