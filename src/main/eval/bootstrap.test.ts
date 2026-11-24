import { describe, expect, it } from 'vitest';
import { pairedBootstrap, seededRandom, type PairedItem } from './bootstrap';

describe('seededRandom', () => {
  it('同じ種なら同じ並びになる', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(xs[0]);
  });
});

describe('pairedBootstrap', () => {
  it('同じ結果どうしなら、差も区間も 0', () => {
    const items: PairedItem[] = Array.from({ length: 20 }, (_, i) => ({ a: i % 3, b: i % 3, len: 10 }));
    const r = pairedBootstrap(items, { iterations: 500 });
    expect(r.diff).toBe(0);
    expect(r.ci).toEqual([0, 0]);
    expect(r.bBetter).toBe(0);
  });

  it('どの発話でも B が良ければ、区間は 0 より下に収まる', () => {
    const items: PairedItem[] = Array.from({ length: 30 }, (_, i) => ({ a: 3 + (i % 2), b: 1, len: 20 }));
    const r = pairedBootstrap(items, { iterations: 2000 });
    expect(r.editsA).toBe(105);
    expect(r.editsB).toBe(30);
    expect(r.diff).toBe(-75);
    expect(r.ci[1]).toBeLessThan(0);
    expect(r.ci[0]).toBeLessThanOrEqual(r.diff);
    expect(r.ci[1]).toBeGreaterThanOrEqual(r.diff);
    expect(r.rateA).toBeCloseTo(105 / 600);
    expect(r.rateDiff).toBeCloseTo(-75 / 600);
    expect(r.rateCi![1]).toBeLessThan(0);
    expect(r.bBetter).toBe(1);
  });

  it('1 つの発話だけで付いた差は、区間が 0 をまたぐ', () => {
    const items: PairedItem[] = [{ a: 10, b: 0, len: 20 }, ...Array.from({ length: 19 }, () => ({ a: 1, b: 1, len: 20 }))];
    const r = pairedBootstrap(items, { iterations: 2000 });
    expect(r.diff).toBe(-10);
    expect(r.ci[1]).toBe(0);
    expect(r.ci[0]).toBeLessThan(-10);
  });

  it('種が同じなら結果も同じ。空なら区間を出さない', () => {
    const items: PairedItem[] = [
      { a: 2, b: 1, len: 10 },
      { a: 0, b: 3, len: 12 },
      { a: 5, b: 2, len: 30 },
    ];
    expect(pairedBootstrap(items, { iterations: 300, seed: 3 })).toEqual(pairedBootstrap(items, { iterations: 300, seed: 3 }));
    const empty = pairedBootstrap([]);
    expect(empty.n).toBe(0);
    expect(empty.rateA).toBeNull();
    expect(empty.rateCi).toBeNull();
  });
});
