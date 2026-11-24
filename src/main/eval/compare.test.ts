import { describe, expect, it } from 'vitest';
import { compareRuns, formatComparison } from './compare';
import type { RowRecord, StageScore } from './score';

type Row = Pick<RowRecord, 'id' | 'dataset' | 'split' | 'target' | 'alt' | 'scores' | 'provisional'>;

function row(id: string, edits: number, over: Partial<Row> = {}): Row {
  const s = { content: { edits, len: 20 }, full: { edits: edits + 1, len: 22 } } as StageScore;
  return { id, dataset: 'd1', split: 'dev', target: '同じ正解の文です。', alt: [], provisional: false, scores: { asr: s, match: s, noLlm: s, final: s }, ...over };
}

describe('compareRuns', () => {
  it('発話を id で突き合わせ、誤り数の差と区間を出す', () => {
    const a = Array.from({ length: 12 }, (_, i) => row(`u${i}`, 4));
    const b = Array.from({ length: 12 }, (_, i) => row(`u${i}`, 1));
    const r = compareRuns(a, b, { stage: 'final', metric: 'content', iterations: 500 });
    expect(r.all).toMatchObject({ n: 12, editsA: 48, editsB: 12, diff: -36 });
    expect(r.all.ci[1]).toBeLessThan(0);
    expect(r.byDataset.d1.n).toBe(12);
    expect(r.bySplit.dev.n).toBe(12);
    expect(r).toMatchObject({ onlyA: 0, onlyB: 0, truthChanged: 0, provisional: 0 });
  });

  it('句読点込みの誤りでも比べられる', () => {
    const r = compareRuns([row('u1', 4)], [row('u1', 1)], { stage: 'noLlm', metric: 'full', iterations: 100 });
    expect(r.all).toMatchObject({ editsA: 5, editsB: 2 });
  });

  it('片方にしかない発話と、正解が変わった発話は除く', () => {
    const a = [row('u1', 3), row('u2', 3), row('u3', 3, { provisional: true }), row('u4', 3)];
    const b = [row('u1', 2), row('u2', 2, { target: '直した正解の文です。' }), row('u3', 2, { provisional: true }), row('u4', 2, { alt: ['別解です。'] }), row('u9', 0)];
    const r = compareRuns(a, b, { stage: 'final', metric: 'content', iterations: 100 });
    expect(r.all.n).toBe(2);
    expect(r).toMatchObject({ onlyA: 0, onlyB: 1, truthChanged: 2, provisional: 1 });
  });

  it('データセットと、開発用か確認用かで分けて出す', () => {
    const a = [row('u1', 3), row('u2', 3, { dataset: 'd2', split: 'holdout' })];
    const b = [row('u1', 3), row('u2', 1, { dataset: 'd2', split: 'holdout' })];
    const r = compareRuns(a, b, { stage: 'final', metric: 'content', iterations: 100 });
    expect(Object.keys(r.byDataset)).toEqual(['d1', 'd2']);
    expect(r.byDataset.d2.diff).toBe(-2);
    expect(r.bySplit.holdout.diff).toBe(-2);
    expect(r.bySplit.dev.diff).toBe(0);
  });

  it('表示は数だけで、区間が 0 をまたぐかで判定を書く', () => {
    const better = compareRuns(
      Array.from({ length: 10 }, (_, i) => row(`u${i}`, 4)),
      Array.from({ length: 10 }, (_, i) => row(`u${i}`, 1)),
      { stage: 'final', metric: 'content', iterations: 200 },
    );
    expect(formatComparison('全体', better.all)).toContain('B が良い');
    const same = compareRuns([row('u1', 2)], [row('u1', 2)], { stage: 'final', metric: 'content', iterations: 50 });
    const line = formatComparison('全体', same.all);
    expect(line).toContain('差があるとは言えない');
    expect(line).not.toContain('同じ正解の文');
  });
});
