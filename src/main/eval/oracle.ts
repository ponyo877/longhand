/**
 * Estimates the potential of alternatives. From the results of a run, estimates how useful the alternatives for the transcript's "spots that may be misheard"
 * (rehearing, alternatives at low-confidence spots) could be.
 *
 * For each spot, tries replacing the phrase in the transcript (heard) with each candidate, and adopts only candidates that reduce the edit distance (content) to the reference.
 * It chooses by looking at the reference, so it is the upper bound that the actual formatting (LLM) can reach. If errors barely drop here, passing rehearing and
 * alternatives to formatting gains little.
 * As a baseline, it also reports the errors when the first candidate is adopted at every spot (rewriting without looking at the reference).
 * Only counts are reported (no sentences).
 */
import type { Uncertain } from '../asr/hypotheses';
import { addCer, bestCer, normContent, type Cer } from './metrics';
import type { RowRecord } from './score';

/** The part of a row used for the calculation (a row of rows.jsonl can be passed as is) */
export type OracleRow = Pick<RowRecord, 'dataset' | 'target' | 'alt'> & {
  stages: Pick<RowRecord['stages'], 'asr'>;
  asr: Pick<RowRecord['asr'], 'uncertain'>;
};

export interface SourceCount {
  /** Number of spots */
  spots: number;
  /** Number adopted because a candidate was closer to the reference */
  adopted: number;
  /** Number of errors removed by adopting */
  editsSaved: number;
}

export interface OracleRowResult {
  /** Transcript with only the candidates closer to the reference adopted */
  text: string;
  before: Cer;
  oracle: Cer;
  /** When the first candidate is adopted at every spot */
  first: Cer;
  spots: number;
  adopted: number;
  /** Spots whose heard was not found in the transcript (removed by an earlier spot's replacement, for example) */
  notFound: number;
  bySource: Record<string, SourceCount>;
}

function indexesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const replaceAt = (text: string, at: number, len: number, by: string) => text.slice(0, at) + by + text.slice(at + len);

/**
 * For one utterance, looks at the spots in order and adopts only candidates that reduce the edit distance to the reference (one spot at a time, building on what earlier spots adopted).
 * When the same phrase appears several times, it also picks the occurrence to replace that reduces the distance the most
 */
export function oracleRow(text: string, refs: readonly string[], uncertain: readonly Uncertain[]): OracleRowResult {
  const score = (t: string): Cer => {
    const c = bestCer(t, refs, normContent);
    return { edits: c.edits, len: c.len };
  };
  const before = score(text);
  const bySource: Record<string, SourceCount> = {};
  let cur = text;
  let curScore = before;
  let blind = text;
  let adopted = 0;
  let notFound = 0;
  for (const u of uncertain) {
    const src = (bySource[u.source] ??= { spots: 0, adopted: 0, editsSaved: 0 });
    src.spots++;
    // Rewriting without looking at the reference: replace the first occurrence with the first candidate
    const blindAt = blind.indexOf(u.heard);
    if (u.heard && blindAt >= 0 && u.alternatives[0] !== undefined) blind = replaceAt(blind, blindAt, u.heard.length, u.alternatives[0]);
    const positions = indexesOf(cur, u.heard);
    if (!positions.length) {
      notFound++;
      continue;
    }
    let best: { text: string; score: Cer } | null = null;
    for (const at of positions) {
      for (const alt of u.alternatives) {
        const cand = replaceAt(cur, at, u.heard.length, alt);
        const s = score(cand);
        if (s.edits < (best?.score.edits ?? curScore.edits)) best = { text: cand, score: s };
      }
    }
    if (!best) continue;
    src.adopted++;
    src.editsSaved += curScore.edits - best.score.edits;
    adopted++;
    cur = best.text;
    curScore = best.score;
  }
  return { text: cur, before, oracle: curScore, first: score(blind), spots: uncertain.length, adopted, notFound, bySource };
}

export interface OracleTotals {
  before: Cer;
  oracle: Cer;
  first: Cer;
}

export interface OracleSummary {
  /** Utterances read */
  rows: number;
  /** Utterances with spots that may be misheard */
  utterances: number;
  /** Of those, utterances whose errors dropped by adopting candidates */
  improved: number;
  spots: number;
  adopted: number;
  notFound: number;
  /** Errors over all utterances */
  all: OracleTotals;
  /** Errors over the utterances with spots only */
  target: OracleTotals;
  bySource: Record<string, SourceCount>;
}

const zero = (): OracleTotals => ({ before: { edits: 0, len: 0 }, oracle: { edits: 0, len: 0 }, first: { edits: 0, len: 0 } });

export function oracleSummary(rows: readonly OracleRow[]): OracleSummary {
  const s: OracleSummary = { rows: rows.length, utterances: 0, improved: 0, spots: 0, adopted: 0, notFound: 0, all: zero(), target: zero(), bySource: {} };
  const add = (t: OracleTotals, r: OracleRowResult) => {
    t.before = addCer(t.before, r.before);
    t.oracle = addCer(t.oracle, r.oracle);
    t.first = addCer(t.first, r.first);
  };
  for (const row of rows) {
    const uncertain = row.asr.uncertain ?? [];
    const r = oracleRow(row.stages.asr, [row.target, ...(row.alt ?? [])], uncertain);
    add(s.all, r);
    if (!uncertain.length) continue;
    add(s.target, r);
    s.utterances++;
    if (r.oracle.edits < r.before.edits) s.improved++;
    s.spots += r.spots;
    s.adopted += r.adopted;
    s.notFound += r.notFound;
    for (const [k, v] of Object.entries(r.bySource)) {
      const t = (s.bySource[k] ??= { spots: 0, adopted: 0, editsSaved: 0 });
      t.spots += v.spots;
      t.adopted += v.adopted;
      t.editsSaved += v.editsSaved;
    }
  }
  return s;
}

const SOURCE_LABELS: Record<string, string> = { rehear: 'rehearing', engine2: 'second engine', token: 'low-confidence alternatives' };

const pct2 = (c: Cer) => (c.len ? `${((c.edits / c.len) * 100).toFixed(2)}%` : '-');
const share = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');

function totalsLine(label: string, t: OracleTotals): string {
  const saved = t.before.edits - t.oracle.edits;
  const points = t.before.len ? ` ${((saved / t.before.len) * 100).toFixed(2)} points` : '';
  return (
    `${label}: before ${t.before.edits} (${pct2(t.before)}) → adopting only candidates closer to the reference ${t.oracle.edits} (${pct2(t.oracle)})` +
    `, errors removed ${saved}${points ? ` (${points.trim()})` : ''}` +
    `. For reference: adopting the first candidate at every spot ${t.first.edits} (${pct2(t.first)})`
  );
}

/** Potential, for display (counts only) */
export function formatOracle(name: string, s: OracleSummary): string[] {
  const out = [
    `[${name}] ${s.utterances} of ${s.rows} utterances have spots that may be misheard (errors dropped in ${s.improved})`,
    `  spots ${s.spots}, adopted ${s.adopted} (${share(s.adopted, s.spots)})${s.notFound ? `, spots not found in the transcript ${s.notFound}` : ''}`,
    `  ${totalsLine('Errors (all utterances)', s.all)}`,
    `  ${totalsLine('Errors (utterances with spots only)', s.target)}`,
  ];
  for (const [k, v] of Object.entries(s.bySource).sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push(`  by source, ${SOURCE_LABELS[k] ?? k}: spots ${v.spots}, adopted ${v.adopted} (${share(v.adopted, v.spots)}), errors removed ${v.editsSaved}`);
  }
  return out;
}
