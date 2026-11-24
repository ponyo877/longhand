import { describe, expect, it } from 'vitest';
import type { Token, Tokenizer } from '../textfix/types';
import { classifyErrors, editOps, errorBreakdown, errorGroups } from './errorTypes';

const chars = (s: string) => Array.from(s);

/** A fake word segmenter with fixed splits. words is [surface form, reading, part of speech] */
function fakeTokenizer(dict: Record<string, [string, string, string][]>): Tokenizer {
  return {
    tokenize(text: string): Token[] | null {
      const words = dict[text];
      if (!words) return null;
      let pos = 0;
      return words.map(([surface, reading, p]) => {
        const start = pos;
        pos += surface.length;
        return { surface, start, end: pos, pos: p, pos1: '', base: surface, reading };
      });
    },
  };
}

describe('editOps and errorGroups', () => {
  it('lists matches, substitutions, deletions and insertions', () => {
    const ops = editOps(chars('あいうえ'), chars('あうえお'));
    expect(ops.map((o) => o.op).join('')).toBe('=D==I');
    expect(ops.filter((o) => o.op !== '=').length).toBe(2);
  });

  it('groups consecutive errors into one and gives it a position', () => {
    const groups = errorGroups(editOps(chars('今日は雨です'), chars('今日は晴れです')));
    expect(groups).toEqual([{ ref: '雨', hyp: '晴れ', refStart: 3, refEnd: 4, hypStart: 3, hypEnd: 5, edits: 2 }]);
  });

  it('finds no errors for the same sentence', () => {
    expect(errorGroups(editOps(chars('同じ文'), chars('同じ文')))).toEqual([]);
  });

  it('sums edits to the edit distance', () => {
    const groups = errorGroups(editOps(chars('資料を送ります'), chars('資料送りました')));
    expect(groups.reduce((n, g) => n + g.edits, 0)).toBe(3);
  });
});

describe('error types (without word segmentation)', () => {
  const kinds = (ref: string, hyp: string) => classifyErrors(chars(ref), chars(hyp)).map((x) => x.kind);

  it('numbers', () => {
    expect(kinds('3時に集合', '三時に集合')).toEqual(['number']);
    expect(kinds('二回', '三回')).toEqual(['number']);
  });

  it('fillers', () => {
    expect(kinds('明日行きます', 'えーと明日行きます')).toEqual(['filler']);
    expect(kinds('あのー明日行きます', '明日行きます')).toEqual(['filler']);
  });

  it('particles', () => {
    expect(kinds('資料を送る', '資料送る')).toEqual(['particle']);
    expect(kinds('私は行く', '私が行く')).toEqual(['particle']);
  });

  it('Latin letters and katakana', () => {
    expect(kinds('slackで送る', 'スラックで送る')).toEqual(['latinKatakana']);
    expect(kinds('サーバーを見る', 'サーバを見る')).toEqual(['latinKatakana']);
  });

  it('treats a hiragana and katakana difference as notation only', () => {
    expect(kinds('メモをとる', 'めもをとる')).toEqual(['notation']);
  });

  it('other deletions, insertions and substitutions', () => {
    expect(kinds('今日は晴れです', '今日晴れです')).toEqual(['particle']);
    expect(kinds('とても良い天気', '良い天気')).toEqual(['deletion']);
    expect(kinds('良い天気', 'とても良い天気')).toEqual(['insertion']);
    expect(kinds('雨が降る', '飴が降る')).toEqual(['other']);
  });

  it('does not count a dropped long vowel in 「えー」 as Latin letters and katakana', () => {
    expect(kinds('ええそうです', 'えーそうです')).not.toContain('latinKatakana');
  });
});

describe('error types (with word segmentation)', () => {
  it('treats a different choice of kana and kanji with the same reading as notation only', () => {
    const tk = fakeTokenizer({
      資料をください: [
        ['資料', 'シリョウ', '名詞'],
        ['を', 'ヲ', '助詞'],
        ['ください', 'クダサイ', '動詞'],
      ],
      資料を下さい: [
        ['資料', 'シリョウ', '名詞'],
        ['を', 'ヲ', '助詞'],
        ['下さい', 'クダサイ', '動詞'],
      ],
    });
    expect(classifyErrors(chars('資料をください'), chars('資料を下さい'), tk).map((x) => x.kind)).toEqual(['notation']);
  });

  it('treats an okurigana difference as notation only', () => {
    const tk = fakeTokenizer({
      会議を行う: [
        ['会議', 'カイギ', '名詞'],
        ['を', 'ヲ', '助詞'],
        ['行う', 'オコナウ', '動詞'],
      ],
      会議を行なう: [
        ['会議', 'カイギ', '名詞'],
        ['を', 'ヲ', '助詞'],
        ['行なう', 'オコナウ', '動詞'],
      ],
    });
    expect(classifyErrors(chars('会議を行う'), chars('会議を行なう'), tk).map((x) => x.kind)).toEqual(['notation']);
  });

  it('treats different kanji with the same reading as a homophone', () => {
    const tk = fakeTokenizer({
      期間を決める: [
        ['期間', 'キカン', '名詞'],
        ['を', 'ヲ', '助詞'],
        ['決める', 'キメル', '動詞'],
      ],
      機関を決める: [
        ['機関', 'キカン', '名詞'],
        ['を', 'ヲ', '助詞'],
        ['決める', 'キメル', '動詞'],
      ],
    });
    expect(classifyErrors(chars('期間を決める'), chars('機関を決める'), tk).map((x) => x.kind)).toEqual(['homophone']);
  });

  it('does not treat different readings as notation', () => {
    const tk = fakeTokenizer({
      雨が降る: [
        ['雨', 'アメ', '名詞'],
        ['が', 'ガ', '助詞'],
        ['降る', 'フル', '動詞'],
      ],
      風が降る: [
        ['風', 'カゼ', '名詞'],
        ['が', 'ガ', '助詞'],
        ['降る', 'フル', '動詞'],
      ],
    });
    expect(classifyErrors(chars('雨が降る'), chars('風が降る'), tk).map((x) => x.kind)).toEqual(['other']);
  });

  it('counts a particle only when it is a particle as a word (not が inside a word)', () => {
    const tk = fakeTokenizer({
      がんばる: [['がんばる', 'ガンバル', '動詞']],
      んばる: [['んばる', 'ンバル', '動詞']],
    });
    expect(classifyErrors(chars('がんばる'), chars('んばる'), tk).map((x) => x.kind)).toEqual(['deletion']);
  });
});

describe('errorBreakdown', () => {
  it('counts groups and edits per type, ignoring punctuation and spaces', () => {
    const b = errorBreakdown('Slackで、資料を送ります。', 'スラックで資料送ります');
    expect(b.latinKatakana).toEqual({ groups: 1, edits: 5 });
    expect(b.particle).toEqual({ groups: 1, edits: 1 });
    expect(b.other).toEqual({ groups: 0, edits: 0 });
  });
});
