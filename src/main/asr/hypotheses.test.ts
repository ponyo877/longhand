import { describe, expect, it } from 'vitest';
import { mergeUncertain, uncertainFromHypotheses, uncertainFromTokens } from './hypotheses';

describe('uncertainFromHypotheses', () => {
  it('takes a differing word, widened to the whole word', () => {
    const r = uncertainFromHypotheses('パレスティナの自治政府が同意しました', ['パレスリアの自治政府が同意しました']);
    expect(r).toEqual([{ heard: 'パレスティナ', alternatives: ['パレスリア'], source: 'rehear' }]);
  });

  it('takes a difference in a kanji word as the run of kanji', () => {
    const r = uncertainFromHypotheses('資料を公正に回します', ['資料を校正に回します']);
    expect(r).toEqual([{ heard: '公正', alternatives: ['校正'], source: 'rehear' }]);
  });

  it('drops differences only in punctuation, spaces or letter case', () => {
    expect(uncertainFromHypotheses('githubに上げておきます', ['GitHubに上げておきます。', 'github に、上げておきます'])).toEqual([]);
  });

  it('merges candidates from several hypotheses at the same place', () => {
    const r = uncertainFromHypotheses('会議は強国で行います', ['会議は峡谷で行います', '会議は教国で行います', '会議は強国で行います']);
    expect(r).toEqual([{ heard: '強国', alternatives: ['峡谷', '教国'], source: 'rehear' }]);
  });

  it('adds the characters on each side of a character missing on one side (a particle, for example) so that the place can be found', () => {
    const r = uncertainFromHypotheses('資料送っておきます', ['資料を送っておきます']);
    expect(r).toHaveLength(1);
    expect(r[0].heard).toBe('料送');
    expect(r[0].alternatives).toEqual(['料を送']);
  });

  it('takes differences between katakana and Latin letters too', () => {
    const r = uncertainFromHypotheses('ギットハブに上げました', ['GitHubに上げました'], 'engine2');
    expect(r).toEqual([{ heard: 'ギットハブ', alternatives: ['GitHub'], source: 'engine2' }]);
  });

  it('does not pass a difference that is too long (a different sentence)', () => {
    expect(uncertainFromHypotheses('今日は早めに帰ります', ['来週の打ち合わせの資料を、明日の朝までに用意しておいてください'])).toEqual([]);
  });

  it('returns up to the limit, in sentence order', () => {
    const r = uncertainFromHypotheses('雨と雪と風と雷', ['飴と行きと風と雷', '雨と雪と風邪と神鳴'], 'rehear', 2);
    expect(r.map((u) => u.heard)).toEqual(['雨', '雪']);
  });
});

describe('uncertainFromTokens', () => {
  const tokens: [string, number][] = [
    ['会議', 0.98],
    ['は', 0.99],
    ['強', 0.42],
    ['国', 0.9],
    ['で', 0.99],
    ['行', 0.97],
    ['います', 0.99],
  ];

  it('widens a low-confidence character to its word and returns the word with each candidate substituted', () => {
    const r = uncertainFromTokens('会議は強国で行います', tokens, [
      {
        index: 2,
        candidates: [
          ['峡', 0.3],
          ['共', 0.08],
          ['教', 0.02],
        ],
      },
    ]);
    expect(r).toEqual([{ heard: '強国', alternatives: ['峡国', '共国'], source: 'token' }]);
  });

  it('drops candidates that are only punctuation', () => {
    expect(uncertainFromTokens('会議は強国で行います', tokens, [{ index: 2, candidates: [['、', 0.4]] }])).toEqual([]);
  });

  it('uses only the aligned characters when the transcript and the tokens differ slightly', () => {
    const r = uncertainFromTokens('会議は強国で行います。', tokens, [{ index: 2, candidates: [['峡', 0.3]] }]);
    expect(r).toEqual([{ heard: '強国', alternatives: ['峡国'], source: 'token' }]);
  });

  it('returns nothing without input', () => {
    expect(uncertainFromTokens('会議は強国で行います', null, [])).toEqual([]);
    expect(uncertainFromTokens('会議は強国で行います', tokens, [])).toEqual([]);
  });
});

describe('mergeUncertain', () => {
  it('merges the same phrase into one and puts candidates from earlier sources first', () => {
    const r = mergeUncertain([
      [{ heard: '強国', alternatives: ['峡谷'], source: 'rehear' }],
      [
        { heard: '強国', alternatives: ['峡国', '峡谷'], source: 'token' },
        { heard: '有給', alternatives: ['要求'], source: 'token' },
      ],
    ]);
    expect(r).toEqual([
      { heard: '強国', alternatives: ['峡谷', '峡国'], source: 'rehear' },
      { heard: '有給', alternatives: ['要求'], source: 'token' },
    ]);
  });
});
