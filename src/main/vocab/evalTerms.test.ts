import { describe, expect, it } from 'vitest';
import { falseInsertions, inventedTerms, orderHintsForEval, termDetails, termRecall } from './evalTerms';

describe('評価の補助（G4-19）', () => {
  const terms = ['Grafana', 'Datadog', 'Postgres'];

  it('再現率は参照文に出た回数を上限に数える', () => {
    expect(termRecall('Grafana と Grafana と Datadog', 'grafana と Datadog と Datadog', terms)).toEqual({ hit: 2, total: 3 });
  });

  it('誤挿入は参照文より多く出た回数を数える', () => {
    expect(falseInsertions('Grafana を開く', 'Grafana と Postgres を開く', terms)).toBe(1);
  });

  it('再現できなかった語と誤って出た語を返す', () => {
    expect(termDetails('Grafana と Datadog', 'Grafana と Postgres', terms)).toEqual({ missed: ['Datadog'], inserted: ['Postgres'] });
  });

  it('実在しない語は seed が同じなら同じ語になる', () => {
    const a = inventedTerms(50, 7);
    expect(a).toHaveLength(50);
    expect(inventedTerms(50, 7)).toEqual(a);
    expect(new Set(a).size).toBe(50);
  });

  it('ヒントの並べ方', () => {
    expect(orderHintsForEval(terms, [], 'recent', 2)).toEqual(['Postgres', 'Datadog']);
    expect(orderHintsForEval(terms, ['Grafana を見る', 'Grafana の設定'], 'score', 1)).toEqual(['Grafana']);
  });
});
