/**
 * 2 つの実行の比較。発話ごとの誤り数を id で突き合わせ、対のブートストラップで差と 95% 区間を出す。
 * 正解が実行の間で変わった発話は、同じ物差しで比べられないので除く（件数を返す）。
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
  /** 両方の実行にあり、正解が同じだった発話の比較 */
  all: BootstrapResult;
  byDataset: Record<string, BootstrapResult>;
  bySplit: Record<string, BootstrapResult>;
  /** 片方の実行にしかない発話 */
  onlyA: number;
  onlyB: number;
  /** 正解が変わっていたので除いた発話 */
  truthChanged: number;
  /** 正解が仮の発話（比較した発話のうち） */
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
    // 別解があると、採った正解の長さが実行ごとに違うことがある。長さは A のものを使う
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

/** 比較の 1 行（数だけ） */
export function formatComparison(name: string, r: BootstrapResult): string {
  const ci = `[${signed(r.ci[0])}, ${signed(r.ci[1])}]`;
  const rateCi = r.rateCi ? `[${signedPt(r.rateCi[0])}, ${signedPt(r.rateCi[1])}]` : '-';
  const verdict = r.ci[1] < 0 ? 'B が良い' : r.ci[0] > 0 ? 'A が良い' : '差があるとは言えない';
  return (
    `[${name}] ${r.n} 件  誤り数 A ${r.editsA} → B ${r.editsB}（差 ${signed(r.diff)}、95% 区間 ${ci}）  ` +
    `誤り率 A ${pt(r.rateA)} → B ${pt(r.rateB)}（差 ${signedPt(r.rateDiff)} ポイント、95% 区間 ${rateCi}）  ` +
    `取り直しで B が良かった割合 ${(r.bBetter * 100).toFixed(1)}%  判定: ${verdict}`
  );
}
