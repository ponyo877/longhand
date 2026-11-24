/**
 * 2 つの実行の差を、発話を単位にした対のブートストラップで見積もる。
 *
 * 同じ発話を両方の実行で測っているので、発話を重複ありで取り直し、取り直すたびに誤り数の合計の差を出す。
 * 差の分布の両端 2.5% を落とした範囲を 95% 区間とする。区間が 0 をまたがなければ、差は偶然ではないとみてよい。
 * 乱数は種から作るので、同じ入力なら同じ結果になる。
 */

/** 1 つの発話の、実行 A と実行 B の誤り数と、正解の文字数 */
export interface PairedItem {
  a: number;
  b: number;
  len: number;
}

export interface BootstrapResult {
  n: number;
  editsA: number;
  editsB: number;
  /** 誤り数の差（B − A）。負なら B のほうが良い */
  diff: number;
  /** 誤り数の差の 95% 区間 */
  ci: [number, number];
  /** 誤り率（合計どうしの割り算）。正解が空なら null */
  rateA: number | null;
  rateB: number | null;
  /** 誤り率の差（B − A）とその 95% 区間 */
  rateDiff: number | null;
  rateCi: [number, number] | null;
  /** 取り直しのうち、B の誤り数が A より少なかった割合 */
  bBetter: number;
}

/** 種から作る乱数（mulberry32）。0 以上 1 未満 */
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
