import { describe, expect, it } from 'vitest';
import { asrRequestExtras, uncertainOf } from './requestOptions';

describe('asrRequestExtras', () => {
  it('adds nothing by default (legacy, no listening again, no alternatives)', () => {
    expect(asrRequestExtras({}, ['GitHub'])).toEqual({});
    expect(asrRequestExtras({ promptStyle: 'legacy', promptTerms: 32, rehear: { noHints: false, temperatures: [] }, alternativesTopK: 0 }, ['GitHub'])).toEqual({});
  });

  it('passes the terms as a sentence when the prompt is built in main', () => {
    const r = asrRequestExtras({ promptStyle: 'sentence', promptTerms: 2 }, ['GitHub', 'Slack', 'Notion']);
    expect(r.promptText).toBe('SlackとGitHubを使っています。');
  });

  it('adds no prompt without terms', () => {
    expect(asrRequestExtras({ promptStyle: 'sentence' }, [])).toEqual({});
  });

  it('adds listening again and alternatives, without temperatures of 0.5 or more (the worker drops the prompt at those)', () => {
    const r = asrRequestExtras({ rehear: { noHints: true, temperatures: [0.2, 0.6, 0] }, alternativesTopK: 3 }, []);
    expect(r).toEqual({ alternatives: { topK: 3, below: 0.5 }, rehear: { noHints: true, temperatures: [0.2] } });
  });
});

describe('uncertainOf', () => {
  it('merges differences from listening again with alternative candidates where confidence is low', () => {
    const r = uncertainOf({
      text: '来月から新しい期間システムに移行します',
      tokens: [
        ['来月', 0.9],
        ['から', 0.9],
        ['新しい', 0.9],
        ['期', 0.3],
        ['間', 0.8],
        ['システムに', 0.9],
        ['移行', 0.9],
        ['します', 0.9],
      ],
      alternatives: [{ index: 3, candidates: [['基', 0.4]] }],
      hypotheses: [{ text: '来月から新しい基幹システムに移行します', source: 'no-hints', avgLogprob: -0.1 }],
    });
    expect(r).toEqual([{ heard: '期間', alternatives: ['基幹', '基間'], source: 'rehear' }]);
  });

  it('returns nothing without input', () => {
    expect(uncertainOf({ text: '了解です' })).toEqual([]);
    expect(uncertainOf({ text: '' })).toEqual([]);
  });
});
