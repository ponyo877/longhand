import { describe, expect, it } from 'vitest';
import { countMorae, editDistance, hiraToKata, isKanaOnly, matchForm, romanize, soundForm, soundsSimilar } from './kana';

describe('kana normalization', () => {
  it('converts hiragana to katakana', () => {
    expect(hiraToKata('ぐらふぁな')).toBe('グラファナ');
  });

  it('evens out long vowels, small tsu, small characters and ヴ in the matching form', () => {
    expect(matchForm('でーたどっぐ')).toBe(matchForm('データドッグ'));
    expect(matchForm('データドッグ')).toBe(matchForm('データドグ'));
    expect(matchForm('ヴァリデータ')).toBe(matchForm('バリデータ'));
  });

  it('counts morae (a contracted sound is one mora)', () => {
    expect(countMorae('グラファナ')).toBe(4);
    expect(countMorae('しゃしん')).toBe(3);
  });

  it('tells whether a string is kana only', () => {
    expect(isKanaOnly('ぐらふぁな')).toBe(true);
    expect(isKanaOnly('Grafana')).toBe(false);
    expect(isKanaOnly('日鷹')).toBe(false);
  });
});

describe('sound comparison', () => {
  it('converts kana to romaji', () => {
    expect(romanize('グラファナ')).toBe('gurafana');
    expect(romanize('でーたどっぐ')).toBe('deetadoggu');
  });

  it('evens out Latin spelling quirks', () => {
    expect(soundForm('Click')).toBe(soundForm('Klik'));
    expect(soundForm('Phone')).toBe(soundForm('Fone'));
    expect(soundForm('Vault')).toBe(soundForm('Bault'));
  });

  it('treats heard kana and a Latin word that sound alike as similar', () => {
    expect(soundsSimilar('ぐらふぁな', 'Grafana')).toBe(true);
    expect(soundsSimilar('グラファナ', 'Grafana')).toBe(true);
    expect(soundsSimilar('でーたどっぐ', 'Datadog')).toBe(true);
    expect(soundsSimilar('ぽすぐれす', 'Postgres')).toBe(true);
    expect(soundsSimilar('iphone', 'iPhone')).toBe(true);
  });

  it('treats rewordings and different words as not similar', () => {
    expect(soundsSimilar('ミーティング', 'Grafana')).toBe(false);
    expect(soundsSimilar('うちあわせ', 'ミーティング')).toBe(false);
    expect(soundsSimilar('でーたどっぐ', 'Postgres')).toBe(false);
  });

  it('never treats words with kanji as similar, since their reading is unknown', () => {
    expect(soundsSimilar('日高', '日鷹')).toBe(false);
  });

  it('computes edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance(['ア', 'イ'], ['ア', 'イ', 'ウ'])).toBe(1);
  });
});
