import { describe, expect, it } from 'vitest';
import { falseInsertions, inventedTerms, orderHintsForEval, termDetails, termRecall } from './evalTerms';

describe('evaluation helpers (G4-19)', () => {
  const terms = ['Grafana', 'Datadog', 'Postgres'];

  it('caps recall at the count in the reference', () => {
    expect(termRecall('Grafana と Grafana と Datadog', 'grafana と Datadog と Datadog', terms)).toEqual({ hit: 2, total: 3 });
  });

  it('counts false insertions as occurrences beyond the reference count', () => {
    expect(falseInsertions('Grafana を開く', 'Grafana と Postgres を開く', terms)).toBe(1);
  });

  it('returns missed terms and wrongly inserted terms', () => {
    expect(termDetails('Grafana と Datadog', 'Grafana と Postgres', terms)).toEqual({ missed: ['Datadog'], inserted: ['Postgres'] });
  });

  it('makes the same made-up words for the same seed', () => {
    const a = inventedTerms(50, 7);
    expect(a).toHaveLength(50);
    expect(inventedTerms(50, 7)).toEqual(a);
    expect(new Set(a).size).toBe(50);
  });

  it('orders hints', () => {
    expect(orderHintsForEval(terms, [], 'recent', 2)).toEqual(['Postgres', 'Datadog']);
    expect(orderHintsForEval(terms, ['Grafana を見る', 'Grafana の設定'], 'score', 1)).toEqual(['Grafana']);
  });
});
