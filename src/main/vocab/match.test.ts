import { describe, expect, it } from 'vitest';
import { applyConfirmedMatches, findDictionaryCandidates, type MatchEntry } from './match';

const entries: MatchEntry[] = [
  { word: 'Grafana', readings: [{ text: 'グラファナ', confirmed: true }] },
  { word: 'Datadog', readings: [{ text: 'データドッグ', confirmed: false }] },
  { word: '日鷹', readings: [{ text: '日高', confirmed: false }] },
];

describe('findDictionaryCandidates（G4-11）', () => {
  it('ひらがなで聞き取られた語を読みと照合する（長音や促音の違いは無視する）', () => {
    const m = findDictionaryCandidates('ぐらふぁなとでーたどぐを見る', entries);
    expect(m.map((x) => [x.heard, x.word, x.exact])).toEqual([
      ['ぐらふぁな', 'Grafana', true],
      ['でーたどぐ', 'Datadog', true],
    ]);
  });

  it('4 拍以上の読みは 1 文字違いまで候補にする', () => {
    const m = findDictionaryCandidates('ぐらふぁにを開く', entries);
    expect(m.map((x) => [x.heard, x.word, x.exact])).toEqual([['ぐらふぁに', 'Grafana', false]]);
  });

  it('英字の語の大文字小文字の違いと、長い語の 1 文字の綴り違いを候補にする', () => {
    const list: MatchEntry[] = [
      { word: 'iPhone', readings: [] },
      { word: 'Postgres', readings: [] },
    ];
    const m = findDictionaryCandidates('iphone と Postgress', list);
    expect(m.map((x) => [x.heard, x.word, x.exact, x.confirmed])).toEqual([
      ['iphone', 'iPhone', true, true],
      ['Postgress', 'Postgres', false, false],
    ]);
  });

  it('漢字の誤認識の形も候補にするが、確かめた読みとはみなさない', () => {
    const m = findDictionaryCandidates('日高さんに送る', entries);
    expect(m.map((x) => [x.heard, x.word, x.confirmed])).toEqual([['日高', '日鷹', false]]);
  });

  it('すでに正しく書かれている語は候補にしない', () => {
    expect(findDictionaryCandidates('Grafana を開く', entries)).toEqual([]);
  });

  it('短い読みは、語の一部には一致させない', () => {
    const list: MatchEntry[] = [{ word: 'Nim', readings: [{ text: 'ニム', confirmed: true }] }];
    expect(findDictionaryCandidates('ニムロッドの話', list)).toEqual([]);
    expect(findDictionaryCandidates('ニム で書く', list).map((x) => x.word)).toEqual(['Nim']);
  });
});

describe('applyConfirmedMatches', () => {
  it('確かめた読みに完全一致した所だけを置き換える', () => {
    const raw = 'ぐらふぁなとでーたどっぐを見る';
    const m = findDictionaryCandidates(raw, entries);
    expect(applyConfirmedMatches(raw, m)).toEqual({ text: 'Grafanaとでーたどっぐを見る', replaced: 1 });
  });
});
