import { describe, expect, it } from 'vitest';
import { bestCer, cer, exactMatchAny, latinWordRecall, levenshtein, llmEffect, normContent, normFull, pct, quantile, rate } from './metrics';

describe('文字誤り率', () => {
  it('編集距離を数える', () => {
    expect(levenshtein([...'abc'], [...'abc'])).toBe(0);
    expect(levenshtein([...'abc'], [...'axc'])).toBe(1);
    expect(levenshtein([...'abc'], [...'ac'])).toBe(1);
    expect(levenshtein([], [...'ab'])).toBe(2);
    expect(levenshtein([...'ab'], [])).toBe(2);
  });

  it('中身の正規化は、句読点と空白を除き、全角半角と大文字小文字をそろえる', () => {
    expect(normContent('ＡＰＩ の 設計、です。').join('')).toBe('apiの設計です');
    expect(normContent('えー、そうですね！').join('')).toBe('えーそうですね');
  });

  it('句読点込みの正規化は、空白だけを除く', () => {
    expect(normFull('API の設計、です。').join('')).toBe('APIの設計、です。');
  });

  it('誤り数と正解の文字数を返す', () => {
    expect(cer('今日は雨です', '今日は晴れです。', normContent)).toEqual({ edits: 2, len: 7 });
    expect(cer('今日は晴れです', '今日は晴れです。', normFull)).toEqual({ edits: 1, len: 8 });
    expect(rate({ edits: 2, len: 8 })).toBe(0.25);
    expect(rate({ edits: 2, len: 0 })).toBeNull();
    expect(pct(1, 8)).toBe('12.5%');
    expect(pct(1, 0)).toBe('-');
  });

  it('別解があれば、距離の小さいほうを採る', () => {
    const refs = ['資料をください。', '資料を下さい。'];
    expect(bestCer('資料を下さい', refs, normContent)).toEqual({ edits: 0, len: 6, ref: 1 });
    expect(bestCer('資料をください', refs, normContent)).toEqual({ edits: 0, len: 7, ref: 0 });
    // 同じ距離なら先のもの（target）
    expect(bestCer('資料', ['資料A', '資料B'], normContent).ref).toBe(0);
    expect(exactMatchAny('資料を下さい。', refs)).toBe(true);
    expect(exactMatchAny('資料を下さい', refs)).toBe(false);
  });

  it('分位点', () => {
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('latinWordRecall', () => {
  it('正解に出る英字の語が、出力にも出たかを数える（大文字小文字と全角半角は無視）', () => {
    expect(latinWordRecall('SlackとGitHubで共有する', 'slackとギットハブで共有する')).toEqual({ hit: 1, total: 2 });
    expect(latinWordRecall('今日は晴れです', '今日は晴れです')).toEqual({ hit: 0, total: 0 });
  });
});

describe('llmEffect', () => {
  it('整形の前に正しかった発話を壊した数と、誤りのあった発話を良くした数を数える', () => {
    const e = llmEffect([
      { before: 0, after: 0 }, // 正しいまま
      { before: 0, after: 2 }, // 壊した
      { before: 3, after: 1 }, // 良くした
      { before: 3, after: 0 }, // 良くして、誤りがなくなった
      { before: 2, after: 2 }, // 変わらない
      { before: 1, after: 4 }, // 悪くした
    ]);
    expect(e).toEqual({ clean: 2, broke: 1, errored: 4, improved: 2, worsened: 1, fixed: 1 });
  });
});
