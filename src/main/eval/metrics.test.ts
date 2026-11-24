import { describe, expect, it } from 'vitest';
import { bestCer, cer, exactMatchAny, latinWordRecall, levenshtein, llmEffect, normContent, normFull, pct, quantile, rate } from './metrics';

describe('character error rate', () => {
  it('counts the edit distance', () => {
    expect(levenshtein([...'abc'], [...'abc'])).toBe(0);
    expect(levenshtein([...'abc'], [...'axc'])).toBe(1);
    expect(levenshtein([...'abc'], [...'ac'])).toBe(1);
    expect(levenshtein([], [...'ab'])).toBe(2);
    expect(levenshtein([...'ab'], [])).toBe(2);
  });

  it('drops punctuation and whitespace and folds full/half width and case for content', () => {
    expect(normContent('ＡＰＩ の 設計、です。').join('')).toBe('apiの設計です');
    expect(normContent('えー、そうですね！').join('')).toBe('えーそうですね');
  });

  it('drops only whitespace when punctuation is included', () => {
    expect(normFull('API の設計、です。').join('')).toBe('APIの設計、です。');
  });

  it('returns the edit count and the reference length', () => {
    expect(cer('今日は雨です', '今日は晴れです。', normContent)).toEqual({ edits: 2, len: 7 });
    expect(cer('今日は晴れです', '今日は晴れです。', normFull)).toEqual({ edits: 1, len: 8 });
    expect(rate({ edits: 2, len: 8 })).toBe(0.25);
    expect(rate({ edits: 2, len: 0 })).toBeNull();
    expect(pct(1, 8)).toBe('12.5%');
    expect(pct(1, 0)).toBe('-');
  });

  it('takes the closer of the alternative references', () => {
    const refs = ['資料をください。', '資料を下さい。'];
    expect(bestCer('資料を下さい', refs, normContent)).toEqual({ edits: 0, len: 6, ref: 1 });
    expect(bestCer('資料をください', refs, normContent)).toEqual({ edits: 0, len: 7, ref: 0 });
    // On a tie, the earlier one (target)
    expect(bestCer('資料', ['資料A', '資料B'], normContent).ref).toBe(0);
    expect(exactMatchAny('資料を下さい。', refs)).toBe(true);
    expect(exactMatchAny('資料を下さい', refs)).toBe(false);
  });

  it('gives quantiles', () => {
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('latinWordRecall', () => {
  it('counts Latin words in the reference that also appear in the output, ignoring case and width', () => {
    expect(latinWordRecall('SlackとGitHubで共有する', 'slackとギットハブで共有する')).toEqual({ hit: 1, total: 2 });
    expect(latinWordRecall('今日は晴れです', '今日は晴れです')).toEqual({ hit: 0, total: 0 });
  });
});

describe('llmEffect', () => {
  it('counts correct utterances broken by formatting and erroneous utterances it improved', () => {
    const e = llmEffect([
      { before: 0, after: 0 }, // stays correct
      { before: 0, after: 2 }, // broken
      { before: 3, after: 1 }, // improved
      { before: 3, after: 0 }, // improved, with no errors left
      { before: 2, after: 2 }, // unchanged
      { before: 1, after: 4 }, // worsened
    ]);
    expect(e).toEqual({ clean: 2, broke: 1, errored: 4, improved: 2, worsened: 1, fixed: 1 });
  });
});
