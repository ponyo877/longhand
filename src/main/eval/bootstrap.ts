/**
 * Estimates the difference between two runs with a paired bootstrap over utterances.
 *
 * Both runs measure the same utterances, so utterances are resampled with replacement, and each resample gives the difference of the total edit counts.
 * The range left after dropping 2.5% at each end of the distribution of differences is the 95% interval. If the interval does not cross 0, the difference is not chance.
 * Random numbers come from a seed, so the same input gives the same result.
 */

/** Edit counts of runs A and B for one utterance, and the length of the reference in characters */
export interface PairedItem {
  a: number;
  b: number;
  len: number;
}

export interface BootstrapResult {
  n: number;
  editsA: number;
  editsB: number;
  /** Difference in edit counts (B − A). Negative means B is better */
  diff: number;
  /** 95% interval of the difference in edit counts */
  ci: [number, number];
  /** Error rate (total divided by total). null if the reference is empty */
  rateA: number | null;
  rateB: number | null;
  /** Difference in error rate (B − A) and its 95% interval */
  rateDiff: number | null;
  rateCi: [number, number] | null;
  /** Share of resamples in which B had fewer edits than A */
  bBetter: number;
}

/** Seeded random numbers (mulberry32). At least 0 and below 1 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const k = (sorted.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.ceil(k);
  return f === c ? sorted[f] : sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

export function pairedBootstrap(items: readonly PairedItem[], opts: { iterations?: number; seed?: number; level?: number } = {}): BootstrapResult {
  const iterations = opts.iterations ?? 10000;
  const level = opts.level ?? 0.95;
  const n = items.length;
  const sum = (f: (x: PairedItem) => number) => items.reduce((acc, x) => acc + f(x), 0);
  const editsA = sum((x) => x.a);
  const editsB = sum((x) => x.b);
  const len = sum((x) => x.len);
  const base: BootstrapResult = {
    n,
    editsA,
    editsB,
    diff: editsB - editsA,
    ci: [0, 0],
    rateA: len ? editsA / len : null,
    rateB: len ? editsB / len : null,
    rateDiff: len ? (editsB - editsA) / len : null,
    rateCi: null,
    bBetter: 0,
  };
  if (!n) return base;
  const rand = seededRandom(opts.seed ?? 1);
  const diffs: number[] = [];
  const rateDiffs: number[] = [];
  let better = 0;
  for (let it = 0; it < iterations; it++) {
    let a = 0;
    let b = 0;
    let l = 0;
    for (let k = 0; k < n; k++) {
      const x = items[Math.floor(rand() * n)];
      a += x.a;
      b += x.b;
      l += x.len;
    }
    diffs.push(b - a);
    if (l) rateDiffs.push((b - a) / l);
    if (b < a) better++;
  }
  diffs.sort((x, y) => x - y);
  rateDiffs.sort((x, y) => x - y);
  const lo = (1 - level) / 2;
  base.ci = [percentile(diffs, lo), percentile(diffs, 1 - lo)];
  base.rateCi = rateDiffs.length ? [percentile(rateDiffs, lo), percentile(rateDiffs, 1 - lo)] : null;
  base.bBetter = better / iterations;
  return base;
}
