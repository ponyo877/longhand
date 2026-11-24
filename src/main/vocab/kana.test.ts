import { describe, expect, it } from 'vitest';
import { countMorae, editDistance, hiraToKata, isKanaOnly, matchForm, romanize, soundForm, soundsSimilar } from './kana';

describe('かなの正規化', () => {
  it('ひらがなをカタカナにする', () => {
    expect(hiraToKata('ぐらふぁな')).toBe('グラファナ');
  });

  it('照合用の形は長音、促音、小書き文字、ヴの違いをそろえる', () => {
    expect(matchForm('でーたどっぐ')).toBe(matchForm('データドッグ'));
    expect(matchForm('データドッグ')).toBe(matchForm('データドグ'));
    expect(matchForm('ヴァリデータ')).toBe(matchForm('バリデータ'));
  });

  it('拍を数える（拗音は 1 拍）', () => {
    expect(countMorae('グラファナ')).toBe(4);
    expect(countMorae('しゃしん')).toBe(3);
  });

  it('かなだけの文字列か', () => {
    expect(isKanaOnly('ぐらふぁな')).toBe(true);
    expect(isKanaOnly('Grafana')).toBe(false);
    expect(isKanaOnly('日鷹')).toBe(false);
  });
});

describe('音の比較', () => {
  it('かなをローマ字にする', () => {
    expect(romanize('グラファナ')).toBe('gurafana');
    expect(romanize('でーたどっぐ')).toBe('deetadoggu');
  });

  it('英字の綴りの癖をそろえる', () => {
    expect(soundForm('Click')).toBe(soundForm('Klik'));
    expect(soundForm('Phone')).toBe(soundForm('Fone'));
    expect(soundForm('Vault')).toBe(soundForm('Bault'));
  });

  it('聞き取ったかなと英字の語の音が近ければ似ているとみなす', () => {
    expect(soundsSimilar('ぐらふぁな', 'Grafana')).toBe(true);
    expect(soundsSimilar('グラファナ', 'Grafana')).toBe(true);
    expect(soundsSimilar('でーたどっぐ', 'Datadog')).toBe(true);
    expect(soundsSimilar('ぽすぐれす', 'Postgres')).toBe(true);
    expect(soundsSimilar('iphone', 'iPhone')).toBe(true);
  });

  it('言い換えや別の語は似ていないとみなす', () => {
    expect(soundsSimilar('ミーティング', 'Grafana')).toBe(false);
    expect(soundsSimilar('うちあわせ', 'ミーティング')).toBe(false);
    expect(soundsSimilar('でーたどっぐ', 'Postgres')).toBe(false);
  });

  it('漢字を含む語は読みが分からないので似ているとみなさない', () => {
    expect(soundsSimilar('日高', '日鷹')).toBe(false);
  });

  it('編集距離', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance(['ア', 'イ'], ['ア', 'イ', 'ウ'])).toBe(1);
  });
});
