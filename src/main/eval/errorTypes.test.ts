import { describe, expect, it } from 'vitest';
import type { Token, Tokenizer } from '../textfix/types';
import { classifyErrors, editOps, errorBreakdown, errorGroups } from './errorTypes';

const chars = (s: string) => Array.from(s);

/** 決まった分け方をする偽の単語分割。words は [表層形, 読み, 品詞] */
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

describe('editOps と errorGroups', () => {
  it('一致、置き換え、脱落、挿入を並べる', () => {
    const ops = editOps(chars('あいうえ'), chars('あうえお'));
    expect(ops.map((o) => o.op).join('')).toBe('=D==I');
    expect(ops.filter((o) => o.op !== '=').length).toBe(2);
  });

  it('連続した誤りを 1 つにまとめ、位置を持たせる', () => {
    const groups = errorGroups(editOps(chars('今日は雨です'), chars('今日は晴れです')));
    expect(groups).toEqual([{ ref: '雨', hyp: '晴れ', refStart: 3, refEnd: 4, hypStart: 3, hypEnd: 5, edits: 2 }]);
  });

  it('同じ文なら誤りはない', () => {
    expect(errorGroups(editOps(chars('同じ文'), chars('同じ文')))).toEqual([]);
  });

  it('編集の数の合計は、編集距離と同じ', () => {
    const groups = errorGroups(editOps(chars('資料を送ります'), chars('資料送りました')));
    expect(groups.reduce((n, g) => n + g.edits, 0)).toBe(3);
  });
});

describe('誤りの種類（単語分割なし）', () => {
  const kinds = (ref: string, hyp: string) => classifyErrors(chars(ref), chars(hyp)).map((x) => x.kind);

  it('数字', () => {
    expect(kinds('3時に集合', '三時に集合')).toEqual(['number']);
    expect(kinds('二回', '三回')).toEqual(['number']);
  });

  it('つなぎ言葉', () => {
    expect(kinds('明日行きます', 'えーと明日行きます')).toEqual(['filler']);
    expect(kinds('あのー明日行きます', '明日行きます')).toEqual(['filler']);
  });

  it('助詞', () => {
    expect(kinds('資料を送る', '資料送る')).toEqual(['particle']);
    expect(kinds('私は行く', '私が行く')).toEqual(['particle']);
  });

  it('英字とカタカナ', () => {
    expect(kinds('slackで送る', 'スラックで送る')).toEqual(['latinKatakana']);
    expect(kinds('サーバーを見る', 'サーバを見る')).toEqual(['latinKatakana']);
  });

  it('ひらがなとカタカナの違いは、表記だけ', () => {
    expect(kinds('メモをとる', 'めもをとる')).toEqual(['notation']);
  });

  it('そのほかの脱落、挿入、置き換え', () => {
    expect(kinds('今日は晴れです', '今日晴れです')).toEqual(['particle']);
    expect(kinds('とても良い天気', '良い天気')).toEqual(['deletion']);
    expect(kinds('良い天気', 'とても良い天気')).toEqual(['insertion']);
    expect(kinds('雨が降る', '飴が降る')).toEqual(['other']);
  });

  it('「えー」の長音が落ちても、英字とカタカナには数えない', () => {
    expect(kinds('ええそうです', 'えーそうです')).not.toContain('latinKatakana');
  });
});

describe('誤りの種類（単語分割あり）', () => {
  it('読みが同じで、かなと漢字の使い分けだけが違えば、表記だけ', () => {
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

  it('送りがなの違いは、表記だけ', () => {
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

  it('読みが同じで漢字が違えば、同音異義語', () => {
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

  it('読みが違えば、表記の違いにしない', () => {
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

  it('助詞は、単語として助詞のときだけ数える（語の一部の「が」は数えない）', () => {
    const tk = fakeTokenizer({
      がんばる: [['がんばる', 'ガンバル', '動詞']],
      んばる: [['んばる', 'ンバル', '動詞']],
    });
    expect(classifyErrors(chars('がんばる'), chars('んばる'), tk).map((x) => x.kind)).toEqual(['deletion']);
  });
});

describe('errorBreakdown', () => {
  it('句読点と空白は見ずに、種類ごとの件数と編集の数を出す', () => {
    const b = errorBreakdown('Slackで、資料を送ります。', 'スラックで資料送ります');
    expect(b.latinKatakana).toEqual({ groups: 1, edits: 5 });
    expect(b.particle).toEqual({ groups: 1, edits: 1 });
    expect(b.other).toEqual({ groups: 0, edits: 0 });
  });
});
