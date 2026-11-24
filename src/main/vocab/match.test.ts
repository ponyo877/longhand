import { describe, expect, it } from 'vitest';
import { applyConfirmedMatches, findDictionaryCandidates, type MatchEntry } from './match';

const entries: MatchEntry[] = [
  { word: 'Grafana', readings: [{ text: 'グラファナ', confirmed: true }] },
  { word: 'Datadog', readings: [{ text: 'データドッグ', confirmed: false }] },
  { word: '日鷹', readings: [{ text: '日高', confirmed: false }] },
];

describe('findDictionaryCandidates (G4-11)', () => {
  it('matches a word heard in hiragana against readings (ignoring long vowels and small tsu)', () => {
    const m = findDictionaryCandidates('ぐらふぁなとでーたどぐを見る', entries);
    expect(m.map((x) => [x.heard, x.word, x.exact])).toEqual([
      ['ぐらふぁな', 'Grafana', true],
      ['でーたどぐ', 'Datadog', true],
    ]);
  });

  it('allows a one-character difference for readings of 4 or more morae', () => {
    const m = findDictionaryCandidates('ぐらふぁにを開く', entries);
    expect(m.map((x) => [x.heard, x.word, x.exact])).toEqual([['ぐらふぁに', 'Grafana', false]]);
  });

  it('makes candidates from case differences in Latin words and one-letter misspellings of long words', () => {
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

  it('makes candidates from misrecognized kanji forms too, but not as confirmed readings', () => {
    const m = findDictionaryCandidates('日高さんに送る', entries);
    expect(m.map((x) => [x.heard, x.word, x.confirmed])).toEqual([['日高', '日鷹', false]]);
  });

  it('makes no candidate from a word already written correctly', () => {
    expect(findDictionaryCandidates('Grafana を開く', entries)).toEqual([]);
  });

  it('does not match short readings inside a word', () => {
    const list: MatchEntry[] = [{ word: 'Nim', readings: [{ text: 'ニム', confirmed: true }] }];
    expect(findDictionaryCandidates('ニムロッドの話', list)).toEqual([]);
    expect(findDictionaryCandidates('ニム で書く', list).map((x) => x.word)).toEqual(['Nim']);
  });
});

describe('applyConfirmedMatches', () => {
  it('replaces only spots that exactly match a confirmed reading', () => {
    const raw = 'ぐらふぁなとでーたどっぐを見る';
    const m = findDictionaryCandidates(raw, entries);
    expect(applyConfirmedMatches(raw, m)).toEqual({ text: 'Grafanaとでーたどっぐを見る', replaced: 1 });
  });
});
