/**
 * Tests for rule a (katakana to Latin letters) and the glossary. All sentences are made-up examples.
 */
import { describe, expect, it } from 'vitest';
import { matchForm } from '../vocab/kana';
import { fixText, type FixInput } from './index';
import { buildLexiconIndex, segmentForm } from './latin';
import { LATIN_LEXICON } from './lexicon/latin';

const fix = (text: string, extra: Partial<FixInput> = {}) => fixText({ text, language: 'ja', rules: { latin: true }, ...extra });

describe('glossary', () => {
  it('has 300-500 words with readings written only in katakana', () => {
    expect(LATIN_LEXICON.length).toBeGreaterThanOrEqual(300);
    expect(LATIN_LEXICON.length).toBeLessThanOrEqual(500);
    for (const e of LATIN_LEXICON) {
      expect(e.readings.length, e.word).toBeGreaterThan(0);
      for (const r of e.readings) expect(r, e.word).toMatch(/^[ァ-ヺー・]+$/);
    }
  });

  it('has no normalized reading shared by different words', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const e of LATIN_LEXICON) {
      for (const r of e.readings) {
        const f = matchForm(r);
        const prev = seen.get(f);
        if (prev && prev !== e.word) clashes.push(`${r}: ${prev} / ${e.word}`);
        seen.set(f, e.word);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('puts readings that are also ordinary words in tier 2 (or leaves them out)', () => {
    // Loanwords in everyday use. Compared with long-vowel marks removed, so 「レディース」 equals 「レディス」
    // prettier-ignore
    const common = [
      'ライン', 'ズーム', 'ラスト', 'ゴー', 'ルビー', 'ノード', 'ビュー', 'バン', 'ワード', 'マック', 'アップル', 'エッジ',
      'ボックス', 'シグナル', 'ミート', 'メッセンジャー', 'リニア', 'ラムダ', 'スパーク', 'ピクセル', 'ギャラクシー', 'スチーム',
      'ファインダー', 'スポットライト', 'オフィス', 'アマゾン', 'メタ', 'テスラ', 'ジャバ', 'スウィフト', 'ダート', 'カーソル',
      'ヤーン', 'アナコンダ', 'ブートストラップ', 'カフカ', 'スノーフレーク', 'エレクトロン', 'レディース', 'マークダウン',
      'エアフロー', 'ミディアム', 'サーフェス', 'ルーム', 'クロージャ', 'ウィンドウ', 'ビート', 'スケッチ', 'ユニティ', 'ブレンダー',
      'ポストマン', 'バッシュ', 'ハイク', 'ソネット', 'ラマ', 'シリ', 'ジェイソン', 'ブレイブ', 'オペラ', 'アーク', 'サファリ',
      'クローム', 'ストライプ', 'スレッズ', 'イラストレーター', 'キーノート', 'カーソル', 'コパイロット', 'ウィスパー',
    ];
    const index = buildLexiconIndex(LATIN_LEXICON);
    const tier1 = common.filter((w) => index.byForm.get(matchForm(w))?.tier === 1);
    expect(tier1).toEqual([]);
  });

  it('covers a run with the fewest words and returns null when it cannot', () => {
    const index = buildLexiconIndex(LATIN_LEXICON);
    expect(segmentForm(matchForm('グーグルクローム'), index)?.map((e) => e.word)).toEqual(['Google Chrome']);
    expect(segmentForm(matchForm('スラックギットハブ'), index)?.map((e) => e.word)).toEqual(['Slack', 'GitHub']);
    expect(segmentForm(matchForm('スラックス'), index)).toBeNull();
  });
});

describe('rule a', () => {
  it.each([
    ['スラックで送っておいて', 'Slackで送っておいて'],
    ['グーグルクロームを開く', 'Google Chromeを開く'],
    ['ギットハブとスラックを見る', 'GitHubとSlackを見る'],
    ['パイソンのエーピーアイを呼ぶ', 'PythonのAPIを呼ぶ'],
    ['ドッカーの設定', 'Dockerの設定'],
    ['iPhoneとアイパッド', 'iPhoneとiPad'],
  ])('%s', (input, expected) => {
    expect(fix(input).text).toBe(expected);
  });

  it.each([
    'オンラインで会議する',
    'ガイドラインを読む',
    'スラックスを買った',
    'クロード・モネの絵を見た',
    'レディースの服',
    'すらっくで送る',
    'ルームに入る',
    'エーピーアイキーを発行する',
    'データをサーバーに送る',
    'スラックスラックスラックスラック',
  ])('leaves unchanged: %s', (input) => {
    expect(fix(input).text).toBe(input);
  });

  it('does not fix tier 2 words and makes them candidates for the LLM', () => {
    const out = fix('ラインで送ります');
    expect(out.text).toBe('ラインで送ります');
    expect(out.candidates).toEqual([{ heard: 'ライン', word: 'LINE' }]);
  });

  it('fixes tier 2 words in the user dictionary or when the target app matches', () => {
    expect(fix('ラインで送ります', { vocabulary: ['LINE'] }).text).toBe('LINEで送ります');
    expect(fix('ラインで送ります', { app: { bundleId: 'jp.naver.line.mac', name: 'LINE' } }).text).toBe('LINEで送ります');
    expect(fix('ズームで話す', { app: { bundleId: 'us.zoom.xos' } }).text).toBe('Zoomで話す');
    expect(fix('ミートで話す', { app: { bundleId: 'com.google.Chrome', host: 'meet.google.com' } }).text).toBe('Meetで話す');
    // App names match exactly only (do not fix LINE inside Linear)
    expect(fix('ラインで送ります', { app: { name: 'Linear' } }).text).toBe('ラインで送ります');
  });

  it('uses the user dictionary spelling and leaves dictionary and replacement phrases alone', () => {
    expect(fix('ギットハブを開く', { vocabulary: ['Github'] }).text).toBe('Githubを開く');
    expect(fix('スラックで送る', { protectedPhrases: ['スラック'] }).text).toBe('スラックで送る');
  });

  it('adds a space only next to Latin letters or digits', () => {
    expect(fix('Macとスラック').text).toBe('MacとSlack');
    expect(fix('AWSのクラウドフロント').text).toBe('AWSのCloudFront');
    expect(fix('Aスラック').text).toBe('A Slack');
  });

  it('gives the same result when applied twice', () => {
    const once = fix('グーグルドライブとスラックとエクセル').text;
    expect(once).toBe('Google DriveとSlackとExcel');
    expect(fix(once).text).toBe(once);
  });

  it('records fixes at their positions before fixing', () => {
    const out = fix('今日はスラックで');
    expect(out.edits).toEqual([{ rule: 'latin', start: 3, end: 7, before: 'スラック', after: 'Slack' }]);
  });
});
