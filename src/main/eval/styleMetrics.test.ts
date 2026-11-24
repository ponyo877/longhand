// 文体の指標（完全一致、文体の違反、口調の硬化）のテスト
import { describe, expect, it } from 'vitest';
import { EMPTY_VIOLATIONS, addViolations, exactMatch, exactMatchRate, formatViolations, styleViolations, toneShift, totalViolations } from './metrics';

describe('exactMatch', () => {
  it('前後の空白と Unicode の合成だけを揃え、句読点や全角半角の違いは不一致とする', () => {
    expect(exactMatch(' 了解です。\n', '了解です。')).toBe(true);
    expect(exactMatch('が゙', 'ぎ'.replace('ぎ', 'が゙').normalize('NFC'))).toBe(true);
    expect(exactMatch('了解です', '了解です。')).toBe(false);
    expect(exactMatch('ＡＰＩ', 'API')).toBe(false);
  });

  it('完全一致率を返す。空なら 0', () => {
    expect(
      exactMatchRate([
        { hyp: 'a', ref: 'a' },
        { hyp: 'a', ref: 'b' },
      ]),
    ).toBe(0.5);
    expect(exactMatchRate([])).toBe(0);
  });
});

describe('styleViolations', () => {
  it('整った文は違反なし', () => {
    expect(styleViolations('Slackの件なんですけど、明日5分だけ話せますか？\n\n資料はGoogle Docsに置きました。')).toEqual(EMPTY_VIOLATIONS);
  });

  it('「！」、和英間の空白、和文の空白、半角の句読点を数える', () => {
    const v = styleViolations('すごい！ Slack で 共有 しました?');
    expect(v.exclamation).toBe(1);
    expect(v.jaLatinSpace).toBe(2);
    expect(v.jaSpace).toBe(2);
    expect(v.halfWidthPunct).toBe(1);
  });

  it('小数や URL の「.」は半角の句読点として数えない', () => {
    expect(styleViolations('バージョン5.5とexample.comを確認').halfWidthPunct).toBe(0);
    expect(styleViolations('確認しました.').halfWidthPunct).toBe(1);
  });

  it('言いさしの末尾の「。」を行ごとに数える', () => {
    expect(styleViolations('見積もりの件なんですけど。\n\n明日でもいいので。').periodAfterConjunction).toBe(2);
    expect(styleViolations('見積もりの件なんですけど').periodAfterConjunction).toBe(0);
  });

  it('箇条書き、記法、1 行だけの改行を数える', () => {
    const v = styleViolations('**買うもの**\n- 牛乳\n・卵\n1. パン');
    expect(v.bullets).toBe(3);
    expect(v.markdown).toBe(1);
    expect(v.singleNewline).toBe(3);
    expect(styleViolations('段落1。\n\n段落2。').singleNewline).toBe(0);
  });

  it('足し合わせと合計と表示', () => {
    const a = styleViolations('すごい！');
    const sum = addViolations(a, a);
    expect(sum.exclamation).toBe(2);
    expect(totalViolations(sum)).toBe(2);
    expect(formatViolations(sum)).toBe('「！」 2');
    expect(formatViolations(EMPTY_VIOLATIONS)).toBe('なし');
  });
});

describe('toneShift', () => {
  it('生テキストに無い改まった言い方が増えた数を返す', () => {
    expect(toneShift('よろしくお願いします', 'よろしくお願いいたします。')).toBe(1);
    expect(toneShift('定例なんですけど', '定例ですが、11時からでしょうか？')).toBe(2);
    expect(toneShift('よろしくお願いいたします', 'よろしくお願いいたします。')).toBe(0);
  });
});
