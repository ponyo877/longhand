import { describe, expect, it } from 'vitest';
import type { NumberStyles } from '../../shared/numberStyle';
import { applyNumberStyle, convertNumbers, hasNumberStyle, numberStylePromptLines } from './numberStyle';

const pref = (value: string) => ({ value, count: 1, at: 0 });

describe('convertNumbers', () => {
  it('writes native counters in kanji or digits', () => {
    expect(convertNumbers('お願いが2つと、1人で行く件です。', 'counters', 'kanji')).toBe('お願いが二つと、一人で行く件です。');
    expect(convertNumbers('お願いが二つと、一人で行く件です。', 'counters', 'digits')).toBe('お願いが2つと、1人で行く件です。');
  });

  it('keeps counters that are part of a word or a larger number', () => {
    expect(convertNumbers('第一人者、一人娘、二人三脚、唯一つ', 'counters', 'digits')).toBe('第一人者、一人娘、二人三脚、唯一つ');
    expect(convertNumbers('12つ、21人、3人', 'counters', 'kanji')).toBe('12つ、21人、3人');
  });

  it('adds and removes thousands separators only in amounts and quantities', () => {
    expect(convertNumbers('10000円と2500000人、$12000', 'grouping', 'comma')).toBe('10,000円と2,500,000人、$12,000');
    expect(convertNumbers('10,000円と$12,000', 'grouping', 'none')).toBe('10000円と$12000');
    expect(convertNumbers('2026年、ポート8080、v1.2.3、ID 12345', 'grouping', 'comma')).toBe('2026年、ポート8080、v1.2.3、ID 12345');
    expect(convertNumbers('1, 2, 3と100,200,300', 'grouping', 'none')).toBe('1, 2, 3と100,200,300');
  });

  it('does not group the part after 万', () => {
    expect(convertNumbers('1万2000円', 'grouping', 'comma')).toBe('1万2000円');
  });

  it('uses 万 and 億 only for round amounts', () => {
    expect(convertNumbers('10000円、30,000人、200000000円、12345円、5000円', 'units', 'kanji')).toBe('1万円、3万人、2億円、12345円、5000円');
  });

  it('expands 万 and 億 to digits', () => {
    expect(convertNumbers('1万円、1.5万人、1億2000万円、100万', 'units', 'digits')).toBe('10000円、15000人、120000000円、1000000');
    expect(convertNumbers('1万2千円、1.23456万円', 'units', 'digits')).toBe('1万2千円、1.23456万円');
  });

  it('writes percent as a sign or a word, keeping the width of the digits', () => {
    expect(convertNumbers('3%と5パーセント', 'percent', 'word')).toBe('3パーセントと5パーセント');
    expect(convertNumbers('3パーセントと５パーセント', 'percent', 'symbol')).toBe('3%と５％');
  });

  it('converts times between colon and kanji forms', () => {
    expect(convertNumbers('10時30分と9時半、2時間30分', 'time', 'colon')).toBe('10:30と9:30、2時間30分');
    expect(convertNumbers('10:30と12:00、1:30:00', 'time', 'kanji')).toBe('10時30分と12時、1:30:00');
  });

  it('converts dates, but reads month/day with a slash as a date only when loose', () => {
    expect(convertNumbers('11月24日と2026年1月5日', 'date', 'slash')).toBe('11/24と2026/1/5');
    expect(convertNumbers('2026/1/5と1/2の確率', 'date', 'kanji')).toBe('2026年1月5日と1/2の確率');
    expect(convertNumbers('11/24', 'date', 'kanji', true)).toBe('11月24日');
    expect(convertNumbers('13月40日', 'date', 'slash')).toBe('13月40日');
  });

  it('changes digit width outside product names and codes', () => {
    expect(convertNumbers('10人、3%、iPhone15、GPT-4、v1.2.3、10km', 'width', 'full')).toBe('１０人、３％、iPhone15、GPT-4、v1.2.3、10km');
    expect(convertNumbers('１０人、１，０００円、３％', 'width', 'half')).toBe('10人、1,000円、3%');
  });
});

describe('applyNumberStyle', () => {
  it('returns the text unchanged without preferences', () => {
    expect(applyNumberStyle('2つ', undefined)).toBe('2つ');
    expect(applyNumberStyle('2つ', {})).toBe('2つ');
    expect(hasNumberStyle({})).toBe(false);
  });

  it('expands 万 before adding separators', () => {
    const styles: NumberStyles = { units: pref('digits'), grouping: pref('comma') };
    expect(applyNumberStyle('1万2000円と100万人', styles)).toBe('12,000円と1,000,000人');
  });

  it('applies the other rules to full-width digits and converts the width last', () => {
    const styles: NumberStyles = { width: pref('full'), counters: pref('digits'), grouping: pref('comma') };
    expect(applyNumberStyle('二つと１００００円', styles)).toBe('２つと１０，０００円');
  });
});

describe('numberStylePromptLines', () => {
  it('lists the preferences in a fixed order', () => {
    const lines = numberStylePromptLines({ date: pref('slash'), counters: pref('kanji') });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('二つ');
    expect(lines[1]).toContain('11/24');
  });
});
