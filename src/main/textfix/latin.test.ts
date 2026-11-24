/**
 * 規則 a（カタカナを英字に）と用語集のテスト。文はすべて作った例文である。
 */
import { describe, expect, it } from 'vitest';
import { matchForm } from '../vocab/kana';
import { fixText, type FixInput } from './index';
import { buildLexiconIndex, segmentForm } from './latin';
import { LATIN_LEXICON } from './lexicon/latin';

const fix = (text: string, extra: Partial<FixInput> = {}) => fixText({ text, language: 'ja', rules: { latin: true }, ...extra });

describe('用語集', () => {
  it('300〜500 語で、読みはカタカナだけで書かれている', () => {
    expect(LATIN_LEXICON.length).toBeGreaterThanOrEqual(300);
    expect(LATIN_LEXICON.length).toBeLessThanOrEqual(500);
    for (const e of LATIN_LEXICON) {
      expect(e.readings.length, e.word).toBeGreaterThan(0);
      for (const r of e.readings) expect(r, e.word).toMatch(/^[ァ-ヺー・]+$/);
    }
  });

  it('正規化した読みが、別々の語で重ならない', () => {
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

  it('普通の語としても使う読みは、段階 2 に入っている（または用語集にない）', () => {
    // 外来語として普通に使う語。長音を除いた形で比べるので、「レディース」は「レディス」と同じになる
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

  it('連なりを語の数が最も少ない分け方で埋め、埋められなければ null を返す', () => {
    const index = buildLexiconIndex(LATIN_LEXICON);
    expect(segmentForm(matchForm('グーグルクローム'), index)?.map((e) => e.word)).toEqual(['Google Chrome']);
    expect(segmentForm(matchForm('スラックギットハブ'), index)?.map((e) => e.word)).toEqual(['Slack', 'GitHub']);
    expect(segmentForm(matchForm('スラックス'), index)).toBeNull();
  });
});

describe('規則 a', () => {
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
  ])('変えない: %s', (input) => {
    expect(fix(input).text).toBe(input);
  });

  it('段階 2 の語は直さず、LLM への候補にする', () => {
    const out = fix('ラインで送ります');
    expect(out.text).toBe('ラインで送ります');
    expect(out.candidates).toEqual([{ heard: 'ライン', word: 'LINE' }]);
  });

  it('段階 2 の語は、利用者の辞書にあるか、入力先のアプリが一致すれば直す', () => {
    expect(fix('ラインで送ります', { vocabulary: ['LINE'] }).text).toBe('LINEで送ります');
    expect(fix('ラインで送ります', { app: { bundleId: 'jp.naver.line.mac', name: 'LINE' } }).text).toBe('LINEで送ります');
    expect(fix('ズームで話す', { app: { bundleId: 'us.zoom.xos' } }).text).toBe('Zoomで話す');
    expect(fix('ミートで話す', { app: { bundleId: 'com.google.Chrome', host: 'meet.google.com' } }).text).toBe('Meetで話す');
    // アプリ名は完全一致だけ（Linear の中で LINE を直さない）
    expect(fix('ラインで送ります', { app: { name: 'Linear' } }).text).toBe('ラインで送ります');
  });

  it('利用者の辞書の綴りを使い、辞書と置換の語句には触らない', () => {
    expect(fix('ギットハブを開く', { vocabulary: ['Github'] }).text).toBe('Githubを開く');
    expect(fix('スラックで送る', { protectedPhrases: ['スラック'] }).text).toBe('スラックで送る');
  });

  it('英数字と接するときだけ空白を挟む', () => {
    expect(fix('Macとスラック').text).toBe('MacとSlack');
    expect(fix('AWSのクラウドフロント').text).toBe('AWSのCloudFront');
    expect(fix('Aスラック').text).toBe('A Slack');
  });

  it('2 回かけても結果が変わらない', () => {
    const once = fix('グーグルドライブとスラックとエクセル').text;
    expect(once).toBe('Google DriveとSlackとExcel');
    expect(fix(once).text).toBe(once);
  });

  it('直した箇所を、直す前の位置で記録する', () => {
    const out = fix('今日はスラックで');
    expect(out.edits).toEqual([{ rule: 'latin', start: 3, end: 7, before: 'スラック', after: 'Slack' }]);
  });
});
