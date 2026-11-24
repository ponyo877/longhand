// Tests for the style metrics (exact match, style violations, a more formal tone)
import { describe, expect, it } from 'vitest';
import { EMPTY_VIOLATIONS, addViolations, exactMatch, exactMatchRate, formatViolations, styleViolations, toneShift, totalViolations } from './metrics';

describe('exactMatch', () => {
  it('normalizes only surrounding whitespace and Unicode composition, and counts punctuation and width differences as mismatches', () => {
    expect(exactMatch(' 了解です。\n', '了解です。')).toBe(true);
    expect(exactMatch('が゙', 'ぎ'.replace('ぎ', 'が゙').normalize('NFC'))).toBe(true);
    expect(exactMatch('了解です', '了解です。')).toBe(false);
    expect(exactMatch('ＡＰＩ', 'API')).toBe(false);
  });

  it('returns the exact match rate, 0 when empty', () => {
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
  it('finds no violations in well-formed text', () => {
    expect(styleViolations('Slackの件なんですけど、明日5分だけ話せますか？\n\n資料はGoogle Docsに置きました。')).toEqual(EMPTY_VIOLATIONS);
  });

  it('counts 「！」, Japanese-Latin spaces, spaces in Japanese and half-width punctuation', () => {
    const v = styleViolations('すごい！ Slack で 共有 しました?');
    expect(v.exclamation).toBe(1);
    expect(v.jaLatinSpace).toBe(2);
    expect(v.jaSpace).toBe(2);
    expect(v.halfWidthPunct).toBe(1);
  });

  it('does not count 「.」 in decimals or URLs as half-width punctuation', () => {
    expect(styleViolations('バージョン5.5とexample.comを確認').halfWidthPunct).toBe(0);
    expect(styleViolations('確認しました.').halfWidthPunct).toBe(1);
  });

  it('counts 「。」 at the end of a trailing-off clause per line', () => {
    expect(styleViolations('見積もりの件なんですけど。\n\n明日でもいいので。').periodAfterConjunction).toBe(2);
    expect(styleViolations('見積もりの件なんですけど').periodAfterConjunction).toBe(0);
  });

  it('counts bullets, markup and single line breaks', () => {
    const v = styleViolations('**買うもの**\n- 牛乳\n・卵\n1. パン');
    expect(v.bullets).toBe(3);
    expect(v.markdown).toBe(1);
    expect(v.singleNewline).toBe(3);
    expect(styleViolations('段落1。\n\n段落2。').singleNewline).toBe(0);
  });

  it('adds, totals and displays violations', () => {
    const a = styleViolations('すごい！');
    const sum = addViolations(a, a);
    expect(sum.exclamation).toBe(2);
    expect(totalViolations(sum)).toBe(2);
    expect(formatViolations(sum)).toBe('exclamation 2');
    expect(formatViolations(EMPTY_VIOLATIONS)).toBe('none');
  });
});

describe('toneShift', () => {
  it('returns how many formal phrases were added that the raw text did not have', () => {
    expect(toneShift('よろしくお願いします', 'よろしくお願いいたします。')).toBe(1);
    expect(toneShift('定例なんですけど', '定例ですが、11時からでしょうか？')).toBe(2);
    expect(toneShift('よろしくお願いいたします', 'よろしくお願いいたします。')).toBe(0);
  });
});
