/**
 * Compares two runs. Matches per-utterance edit counts by id and gives the difference and its 95% interval with a paired bootstrap.
 * Utterances whose reference changed between the runs cannot be compared on the same scale, so they are left out (and counted).
 */
import { pairedBootstrap, type BootstrapResult, type PairedItem } from './bootstrap';
import type { RowRecord, StageName } from './score';

export type CompareMetric = 'content' | 'full';

export interface CompareOptions {
  stage: StageName;
  metric: CompareMetric;
  iterations?: number;
  seed?: number;
}

export interface CompareResult {
  /** Utterances in both runs with the same reference */
  all: BootstrapResult;
  byDataset: Record<string, BootstrapResult>;
  bySplit: Record<string, BootstrapResult>;
  /** Utterances in only one of the runs */
  onlyA: number;
  onlyB: number;
  /** Utterances left out because the reference changed */
  truthChanged: number;
  /** Utterances with a provisional reference (among the compared ones) */
  provisional: number;
}

type Row = Pick<RowRecord, 'id' | 'dataset' | 'split' | 'target' | 'alt' | 'scores' | 'provisional'>;

export function compareRuns(a: readonly Row[], b: readonly Row[], opts: CompareOptions): CompareResult {
  const mapB = new Map(b.map((r) => [r.id, r]));
  const idsA = new Set(a.map((r) => r.id));
  const pairs: { item: PairedItem; dataset: string; split: string }[] = [];
  let onlyA = 0;
  let truthChanged = 0;
  let provisional = 0;
  for (const ra of a) {
    const rb = mapB.get(ra.id);
    if (!rb) {
      onlyA++;
      continue;
    }
    if (ra.target !== rb.target || JSON.stringify(ra.alt ?? []) !== JSON.stringify(rb.alt ?? [])) {
      truthChanged++;
      continue;
    }
    const sa = ra.scores[opts.stage][opts.metric];
    const sb = rb.scores[opts.stage][opts.metric];
    // With alternative references, the chosen reference's length can differ between runs. Use A's length
    pairs.push({ item: { a: sa.edits, b: sb.edits, len: sa.len }, dataset: ra.dataset, split: ra.split });
    if (ra.provisional) provisional++;
  }
  const boot = (items: PairedItem[]) => pairedBootstrap(items, { iterations: opts.iterations, seed: opts.seed });
  const group = (key: (p: (typeof pairs)[number]) => string) => {
    const m = new Map<string, PairedItem[]>();
    for (const p of pairs) m.set(key(p), [...(m.get(key(p)) ?? []), p.item]);
    return Object.fromEntries([...m].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, items]) => [k, boot(items)]));
  };
  return {
    all: boot(pairs.map((p) => p.item)),
    byDataset: group((p) => p.dataset),
    bySplit: group((p) => p.split),
    onlyA,
    onlyB: b.filter((r) => !idsA.has(r.id)).length,
    truthChanged,
    provisional,
  };
}

const pt = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(2)}%`);
const signed = (x: number) => `${x > 0 ? '+' : ''}${Number.isInteger(x) ? x : x.toFixed(1)}`;
const signedPt = (x: number | null) => (x === null ? '-' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(2)}`);

/** One comparison line (numbers only) */
export function formatComparison(name: string, r: BootstrapResult): string {
  const ci = `[${signed(r.ci[0])}, ${signed(r.ci[1])}]`;
  const rateCi = r.rateCi ? `[${signedPt(r.rateCi[0])}, ${signedPt(r.rateCi[1])}]` : '-';
  const verdict = r.ci[1] < 0 ? 'B is better' : r.ci[0] > 0 ? 'A is better' : 'no clear difference';
  return (
    `[${name}] ${r.n} utterances  edits A ${r.editsA} → B ${r.editsB} (diff ${signed(r.diff)}, 95% interval ${ci})  ` +
    `error rate A ${pt(r.rateA)} → B ${pt(r.rateB)} (diff ${signedPt(r.rateDiff)} points, 95% interval ${rateCi})  ` +
    `resamples where B was better ${(r.bBetter * 100).toFixed(1)}%  verdict: ${verdict}`
  );
}
