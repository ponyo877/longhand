import { describe, expect, it } from 'vitest';
import { detectNumberStyles } from './numberStyle';

const found = (before: string, after: string) => detectNumberStyles(before, after).map((o) => [o.kind, o.value, o.before, o.after]);

describe('detectNumberStyles', () => {
  it('recognizes each kind from a correction in a sentence', () => {
    expect(found('お願いが2つあります。', 'お願いが二つあります。')).toEqual([['counters', 'kanji', '2つ', '二つ']]);
    expect(found('予算は10000円です。', '予算は1万円です。')).toEqual([['units', 'kanji', '10000円', '1万円']]);
    expect(found('予算は10000円です。', '予算は10,000円です。')).toEqual([['grouping', 'comma', '10000円', '10,000円']]);
    expect(found('会議は10:30からです。', '会議は10時30分からです。')).toEqual([['time', 'kanji', '10:30', '10時30分']]);
    expect(found('締め切りは11月24日です。', '締め切りは11/24です。')).toEqual([['date', 'slash', '11月24日', '11/24']]);
    expect(found('締め切りは11/24です。', '締め切りは11月24日です。')).toEqual([['date', 'kanji', '11/24', '11月24日']]);
    expect(found('成長率は3%でした。', '成長率は3パーセントでした。')).toEqual([['percent', 'word', '3%', '3パーセント']]);
    expect(found('参加者は10人です。', '参加者は１０人です。')).toEqual([['width', 'full', '10人', '１０人']]);
  });

  it('learns nothing when the value changes', () => {
    expect(found('お願いが2つあります。', 'お願いが三つあります。')).toEqual([]);
    expect(found('予算は10000円です。', '予算は2万円です。')).toEqual([]);
    expect(found('iPhone15を買いました。', 'iPhone16を買いました。')).toEqual([]);
  });

  it('learns nothing from text without numbers', () => {
    expect(found('資料を公正に回します。', '資料を校正に回します。')).toEqual([]);
  });

  it('ignores a span that needs two kinds to explain', () => {
    expect(found('予算は１００００円です。', '予算は1万円です。')).toEqual([]);
  });

  it('drops a kind when two spans ask for different notations', () => {
    expect(found('2つと三つ', '二つと3つ')).toEqual([]);
  });

  it('keeps one observation per kind when several spans agree', () => {
    expect(found('2つと3つ', '二つと三つ')).toEqual([['counters', 'kanji', '2つ', '二つ']]);
  });

  it('finds a notation change next to an unrelated edit', () => {
    expect(found('スラックで2つ共有します。', 'Slackで二つ共有します。')).toEqual([['counters', 'kanji', '2つ', '二つ']]);
  });
});
