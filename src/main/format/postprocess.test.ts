import { describe, expect, it } from 'vitest';
import type { Replacement } from '../../shared/types';
import { applyReplacements, applySpacing, hasSubstance, isCodeLikeApp, normalizeText, replacementTriggerKey } from './postprocess';

const ja = (s: string) => normalizeText(s, { language: 'ja' });
const term = (s: string) => normalizeText(s, { language: 'ja', codeLike: true });

describe('normalizeText（N1）', () => {
  it('日本語の文字どうしの間の空白を詰める', () => {
    expect(ja('明日 の 会議 は 午後 から')).toBe('明日の会議は午後から');
    expect(ja('はい 、 わかりました 。')).toBe('はい、わかりました。');
  });

  it('日本語と英数字の間の空白を詰め、英語の語句の中の空白は残す', () => {
    expect(ja('Slack で 共有 しました')).toBe('Slackで共有しました');
    expect(ja('Google Docs に まとめて 5 分後 に送る')).toBe('Google Docsにまとめて5分後に送る');
    expect(ja('です。 Next の 予定')).toBe('です。Nextの予定');
    expect(ja('（ API ）を使う')).toBe('（API）を使う');
  });

  it('かなと漢字の直後の半角の記号を全角にする', () => {
    expect(ja('本当に?')).toBe('本当に？');
    expect(ja('はい,わかりました.')).toBe('はい、わかりました。');
    expect(ja('了解. 明日やります')).toBe('了解。明日やります');
  });

  it('小数、URL、英語の文の記号は変えない', () => {
    expect(ja('バージョン 5.5 を入れた')).toBe('バージョン5.5を入れた');
    expect(ja('詳細は example.com を見て')).toBe('詳細はexample.comを見て');
    expect(ja('Is it OK? 大丈夫')).toBe('Is it OK? 大丈夫');
  });

  it('ターミナルとコードエディタでは、和英間の空白を残す（コマンドの引数を壊さない）', () => {
    expect(term('mkdir 資料')).toBe('mkdir 資料');
    expect(term('git status を 実行して')).toBe('git status を実行して');
  });

  it('英語の設定では、日本語の文字どうしの空白だけを詰める', () => {
    expect(normalizeText('Hello world , ok', { language: 'en' })).toBe('Hello world , ok');
  });

  it('段落の空行は残し、行末の空白は除く', () => {
    expect(ja('一行目です。 \n\n二行目です。')).toBe('一行目です。\n\n二行目です。');
  });

  it('空や空白だけは空にする', () => {
    expect(ja('   ')).toBe('');
  });
});

describe('isCodeLikeApp', () => {
  it('ターミナルとコードエディタを見分ける', () => {
    for (const name of ['Terminal', 'iTerm2', 'Warp', 'Ghostty', 'Visual Studio Code', 'Code', 'Cursor', 'Xcode', 'IntelliJ IDEA']) {
      expect(isCodeLikeApp(name)).toBe(true);
    }
    for (const name of ['Slack', 'Google Chrome', 'メモ', 'Mail', undefined]) {
      expect(isCodeLikeApp(name)).toBe(false);
    }
  });
});

describe('hasSubstance（N4）', () => {
  it('「うん」だけの発話は本文として残す', () => {
    expect(hasSubstance('うん')).toBe(true);
    expect(hasSubstance('うん。')).toBe(true);
  });

  it('言いよどみの音だけなら中身なしとする', () => {
    expect(hasSubstance('えーと')).toBe(false);
    expect(hasSubstance('あのー、えっと。')).toBe(false);
  });
});

const rep = (from: string, to: string, opts: Partial<Replacement> = {}): Replacement => ({
  id: from,
  from,
  to,
  preserveCase: true,
  noPunctuation: false,
  ...opts,
});

describe('applyReplacements（N3、G4-12）', () => {
  it('長いきっかけを先に試す（表の並び順によらない）', () => {
    const a = rep('どっかー', 'Docker');
    const b = rep('どっかーこんぽーず', 'Docker Compose');
    expect(applyReplacements('どっかーこんぽーずとどっかーを使う', [a, b])).toBe('Docker ComposeとDockerを使う');
    expect(applyReplacements('どっかーこんぽーずとどっかーを使う', [b, a])).toBe('Docker ComposeとDockerを使う');
  });

  it('置換後の文字列は走査し直さない（連鎖しない）', () => {
    expect(applyReplacements('ほげです', [rep('ほげ', 'ふが'), rep('ふが', 'ぴよ')])).toBe('ふがです');
    expect(applyReplacements('ほげです', [rep('ふが', 'ぴよ'), rep('ほげ', 'ふが')])).toBe('ふがです');
  });

  it('日本語のきっかけは、文字の間に空白が 1 つ入っていても一致する', () => {
    expect(applyReplacements('じー めーるで送る', [rep('じーめーる', 'Gmail')])).toBe('Gmailで送る');
  });

  it('全角と半角、大文字と小文字を区別せずに一致する', () => {
    expect(applyReplacements('ＡＰＩキーを設定', [rep('APIキー', 'API key')])).toBe('API keyを設定');
    expect(applyReplacements('ＡＰＩを呼ぶ', [rep('api', 'API')])).toBe('APIを呼ぶ');
    expect(applyReplacements('Github に置く', [rep('github', 'GitHub')])).toBe('GitHub に置く');
  });

  it('英数字だけのきっかけは単語境界で一致させる', () => {
    expect(applyReplacements('rapid api', [rep('api', 'API')])).toBe('rapid API');
    expect(applyReplacements('pull  request を出す', [rep('pull request', 'PR')])).toBe('PR を出す');
  });

  it('preserveCase オンは、置換後を書いたとおりに入れる', () => {
    expect(applyReplacements('あいおーえすで動く', [rep('あいおーえす', 'iOS')])).toBe('iOSで動く');
  });

  it('preserveCase オフは、文頭だけ先頭の英小文字を大文字にする', () => {
    const r = rep('えぬぴーえむ', 'npm', { preserveCase: false });
    expect(applyReplacements('えぬぴーえむで入れる。えぬぴーえむを使う', [r])).toBe('Npmで入れる。Npmを使う');
    expect(applyReplacements('まずえぬぴーえむで入れる', [r])).toBe('まずnpmで入れる');
    expect(applyReplacements('一行目\nえぬぴーえむ', [r])).toBe('一行目\nNpm');
  });

  it('noPunctuation は直後の句読点を 1 つ除く', () => {
    expect(applyReplacements('URL はれいどっとこむ。', [rep('れいどっとこむ', 'example.com', { noPunctuation: true })])).toBe('URL はexample.com');
  });

  it('正規表現の記号を含むきっかけも文字どおりに一致する', () => {
    expect(applyReplacements('C++ と c＋＋', [rep('C++', 'C++言語')])).toBe('C++言語 と C++言語');
    expect(applyReplacements('a.b と axb', [rep('a.b', 'X')])).toBe('X と axb');
  });

  it('空のきっかけは無視し、置換が無ければ本文をそのまま返す', () => {
    expect(applyReplacements('そのまま', [rep('  ', 'x')])).toBe('そのまま');
    expect(applyReplacements('そのまま', [])).toBe('そのまま');
  });

  it('サロゲートペアの文字を壊さない', () => {
    expect(applyReplacements('𠮷野家でほげ', [rep('ほげ', 'ふが')])).toBe('𠮷野家でふが');
  });
});

describe('replacementTriggerKey', () => {
  it('全角半角、大文字小文字、空白の違いを同じ鍵にする', () => {
    expect(replacementTriggerKey('ＡＰＩ キー')).toBe(replacementTriggerKey('apiキー'));
    expect(replacementTriggerKey('ほげ')).not.toBe(replacementTriggerKey('ホゲ'));
  });
});

describe('applySpacing（N2）', () => {
  it('直前が英数字や閉じ記号なら、英数字で始まる本文の前に空白を足す', () => {
    expect(applySpacing('world', 'hello', undefined)).toBe(' world');
    expect(applySpacing('next', 'done)', undefined)).toBe(' next');
    expect(applySpacing('next', '100%', undefined)).toBe(' next');
    expect(applySpacing('(see)', 'text', undefined)).toBe(' (see)');
  });

  it('直前が日本語か空白なら、先頭に空白を足さない', () => {
    expect(applySpacing('API', '設定の', undefined)).toBe('API');
    expect(applySpacing('API', 'the ', undefined)).toBe('API');
    expect(applySpacing('設定', 'abc', undefined)).toBe('設定');
  });

  it('日本語の無い本文は、入力欄の末尾なら末尾に空白を足す（続けて話しても文がくっつかない）', () => {
    expect(applySpacing('Sounds good.', '', '')).toBe('Sounds good. ');
    expect(applySpacing('Sounds good.', '', undefined)).toBe('Sounds good.');
    expect(applySpacing('Sounds good.', '', 'next')).toBe('Sounds good. ');
    expect(applySpacing('Sounds good.', '', ' next')).toBe('Sounds good.');
    expect(applySpacing('Sounds good.', '', '。')).toBe('Sounds good.');
  });

  it('日本語を含む本文は、入力欄の末尾でも空白を足さない', () => {
    expect(applySpacing('設定はON', '', '')).toBe('設定はON');
    expect(applySpacing('了解です。', '', '')).toBe('了解です。');
  });

  it('日本語を含む本文でも、直後が英数字で本文が英数字か文末記号で終わるなら足す', () => {
    expect(applySpacing('設定はON', '', 'next')).toBe('設定はON ');
    expect(applySpacing('了解です', '', 'next')).toBe('了解です');
  });
});
