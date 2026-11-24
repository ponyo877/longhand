/**
 * 確信度の位置合わせのテスト。文はすべて作った例文である。
 */
import { describe, expect, it } from 'vitest';
import { charConfidence, minContentConfidence, rangeConfidence, realign } from './align';

describe('確信度の位置合わせ', () => {
  it('つなげた文字列が書き起こしと同じなら、字ごとにそのまま割り当てる', () => {
    expect(
      charConfidence('今日は', [
        ['今日', 0.9],
        ['は', 0.5],
      ]),
    ).toEqual([0.9, 0.9, 0.5]);
  });

  it('先頭の空白や区間の繰り返しの除去で文字列がずれても、一致した字だけに割り当てる', () => {
    // ワーカーは先頭に空白を付けることがあり、書き起こしは前後の空白を除いてある
    expect(
      charConfidence('明日行く', [
        [' 明日', 0.8],
        ['行く', 0.6],
      ]),
    ).toEqual([0.8, 0.8, 0.6, 0.6]);
    // ワーカーの側にだけある字（繰り返しの除去で消えた字）は飛ばし、書き起こしの側にだけある字は null
    expect(
      charConfidence('はいそう', [
        ['はいはい', 0.9],
        ['そう', 0.4],
      ]),
    ).toEqual([0.9, 0.9, 0.4, 0.4]);
    expect(
      charConfidence('はい、そう', [
        ['はい', 0.9],
        ['そう', 0.4],
      ]),
    ).toEqual([0.9, 0.9, null, 0.4, 0.4]);
  });

  it('並びがない、または形が壊れていれば null', () => {
    expect(charConfidence('今日', undefined)).toBeNull();
    expect(charConfidence('今日', [])).toBeNull();
    expect(charConfidence('今日', [['今日', Number.NaN]])).toBeNull();
  });

  it('置き換えた後の文字列に移すと、置き換えた所は確信度なしになる', () => {
    const conf = [0.9, 0.9, 0.9, 0.9, 0.3, 0.9];
    expect(realign('すらっくで', conf, 'Slackで')).toEqual([null, null, null, null, null, 0.3]);
    expect(realign('ABC', [0.1, 0.2, 0.3], 'ABC')).toEqual([0.1, 0.2, 0.3]);
  });

  it('範囲の最小値と、中身の字の最小値を出す。確信度のない字を含む範囲は null', () => {
    const conf = [0.9, 0.4, null, 0.8];
    expect(rangeConfidence(conf, 0, 2)).toBe(0.4);
    expect(rangeConfidence(conf, 1, 3)).toBeNull();
    expect(rangeConfidence(null, 0, 1)).toBeNull();
    // 句読点の確信度は数えない
    expect(minContentConfidence('はい。', [0.9, 0.8, 0.1])).toBe(0.8);
    expect(minContentConfidence('はい', [null, null])).toBeNull();
  });
});
