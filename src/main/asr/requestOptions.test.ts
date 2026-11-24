import { describe, expect, it } from 'vitest';
import { asrRequestExtras, uncertainOf } from './requestOptions';

describe('asrRequestExtras', () => {
  it('既定（legacy、聞き直しなし、別候補なし）では何も付けない', () => {
    expect(asrRequestExtras({}, ['GitHub'])).toEqual({});
    expect(asrRequestExtras({ promptStyle: 'legacy', promptTerms: 32, rehear: { noHints: false, temperatures: [] }, alternativesTopK: 0 }, ['GitHub'])).toEqual({});
  });

  it('プロンプトを main で組む設定では、語を文にして渡す', () => {
    const r = asrRequestExtras({ promptStyle: 'sentence', promptTerms: 2 }, ['GitHub', 'Slack', 'Notion']);
    expect(r.promptText).toBe('SlackとGitHubを使っています。');
  });

  it('語が無ければ、プロンプトを付けない', () => {
    expect(asrRequestExtras({ promptStyle: 'sentence' }, [])).toEqual({});
  });

  it('聞き直しと別候補の指定を付ける。0.5 以上の温度は使わない（ワーカーがプロンプトを外すため）', () => {
    const r = asrRequestExtras({ rehear: { noHints: true, temperatures: [0.2, 0.6, 0] }, alternativesTopK: 3 }, []);
    expect(r).toEqual({ alternatives: { topK: 3, below: 0.5 }, rehear: { noHints: true, temperatures: [0.2] } });
  });
});

describe('uncertainOf', () => {
  it('聞き直しの食い違いと、確信度の低い箇所の別候補をまとめる', () => {
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

  it('材料が無ければ空を返す', () => {
    expect(uncertainOf({ text: '了解です' })).toEqual([]);
    expect(uncertainOf({ text: '' })).toEqual([]);
  });
});
