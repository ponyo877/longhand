import { describe, expect, it } from 'vitest';
import type { Replacement } from '../../shared/types';
import { applyReplacements, applySpacing, hasSubstance, isCodeLikeApp, normalizeText, replacementTriggerKey } from './postprocess';

const ja = (s: string) => normalizeText(s, { language: 'ja' });
const term = (s: string) => normalizeText(s, { language: 'ja', codeLike: true });

describe('normalizeText (N1)', () => {
  it('removes spaces between Japanese characters', () => {
    expect(ja('明日 の 会議 は 午後 から')).toBe('明日の会議は午後から');
    expect(ja('はい 、 わかりました 。')).toBe('はい、わかりました。');
  });

  it('removes spaces between Japanese and Latin text and keeps spaces inside English phrases', () => {
    expect(ja('Slack で 共有 しました')).toBe('Slackで共有しました');
    expect(ja('Google Docs に まとめて 5 分後 に送る')).toBe('Google Docsにまとめて5分後に送る');
    expect(ja('です。 Next の 予定')).toBe('です。Nextの予定');
    expect(ja('（ API ）を使う')).toBe('（API）を使う');
  });

  it('makes half-width marks right after kana or kanji full-width', () => {
    expect(ja('本当に?')).toBe('本当に？');
    expect(ja('はい,わかりました.')).toBe('はい、わかりました。');
    expect(ja('了解. 明日やります')).toBe('了解。明日やります');
  });

  it('leaves decimals, URLs and punctuation in English sentences unchanged', () => {
    expect(ja('バージョン 5.5 を入れた')).toBe('バージョン5.5を入れた');
    expect(ja('詳細は example.com を見て')).toBe('詳細はexample.comを見て');
    expect(ja('Is it OK? 大丈夫')).toBe('Is it OK? 大丈夫');
  });

  it('keeps spaces between Japanese and Latin text in terminals and code editors (so command arguments are not broken)', () => {
    expect(term('mkdir 資料')).toBe('mkdir 資料');
    expect(term('git status を 実行して')).toBe('git status を実行して');
  });

  it('removes only spaces between Japanese characters with the English setting', () => {
    expect(normalizeText('Hello world , ok', { language: 'en' })).toBe('Hello world , ok');
  });

  it('keeps blank lines between paragraphs and removes trailing spaces', () => {
    expect(ja('一行目です。 \n\n二行目です。')).toBe('一行目です。\n\n二行目です。');
  });

  it('returns empty for empty or whitespace-only text', () => {
    expect(ja('   ')).toBe('');
  });
});

describe('isCodeLikeApp', () => {
  it('recognizes terminals and code editors', () => {
    for (const name of ['Terminal', 'iTerm2', 'Warp', 'Ghostty', 'Visual Studio Code', 'Code', 'Cursor', 'Xcode', 'IntelliJ IDEA']) {
      expect(isCodeLikeApp(name)).toBe(true);
    }
    for (const name of ['Slack', 'Google Chrome', 'メモ', 'Mail', undefined]) {
      expect(isCodeLikeApp(name)).toBe(false);
    }
  });
});

describe('hasSubstance (N4)', () => {
  it('keeps an utterance of only 「うん」 as content', () => {
    expect(hasSubstance('うん')).toBe(true);
    expect(hasSubstance('うん。')).toBe(true);
  });

  it('treats an utterance of only hesitation sounds as empty', () => {
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

describe('applyReplacements (N3, G4-12)', () => {
  it('tries longer triggers first (regardless of table order)', () => {
    const a = rep('どっかー', 'Docker');
    const b = rep('どっかーこんぽーず', 'Docker Compose');
    expect(applyReplacements('どっかーこんぽーずとどっかーを使う', [a, b])).toBe('Docker ComposeとDockerを使う');
    expect(applyReplacements('どっかーこんぽーずとどっかーを使う', [b, a])).toBe('Docker ComposeとDockerを使う');
  });

  it('does not rescan replacement text (no chaining)', () => {
    expect(applyReplacements('ほげです', [rep('ほげ', 'ふが'), rep('ふが', 'ぴよ')])).toBe('ふがです');
    expect(applyReplacements('ほげです', [rep('ふが', 'ぴよ'), rep('ほげ', 'ふが')])).toBe('ふがです');
  });

  it('matches a Japanese trigger even with one space between characters', () => {
    expect(applyReplacements('じー めーるで送る', [rep('じーめーる', 'Gmail')])).toBe('Gmailで送る');
  });

  it('matches regardless of full-width/half-width and case', () => {
    expect(applyReplacements('ＡＰＩキーを設定', [rep('APIキー', 'API key')])).toBe('API keyを設定');
    expect(applyReplacements('ＡＰＩを呼ぶ', [rep('api', 'API')])).toBe('APIを呼ぶ');
    expect(applyReplacements('Github に置く', [rep('github', 'GitHub')])).toBe('GitHub に置く');
  });

  it('matches triggers of only Latin letters and digits on word boundaries', () => {
    expect(applyReplacements('rapid api', [rep('api', 'API')])).toBe('rapid API');
    expect(applyReplacements('pull  request を出す', [rep('pull request', 'PR')])).toBe('PR を出す');
  });

  it('inserts the replacement exactly as written with preserveCase on', () => {
    expect(applyReplacements('あいおーえすで動く', [rep('あいおーえす', 'iOS')])).toBe('iOSで動く');
  });

  it('capitalizes a leading lowercase Latin letter only at a sentence start with preserveCase off', () => {
    const r = rep('えぬぴーえむ', 'npm', { preserveCase: false });
    expect(applyReplacements('えぬぴーえむで入れる。えぬぴーえむを使う', [r])).toBe('Npmで入れる。Npmを使う');
    expect(applyReplacements('まずえぬぴーえむで入れる', [r])).toBe('まずnpmで入れる');
    expect(applyReplacements('一行目\nえぬぴーえむ', [r])).toBe('一行目\nNpm');
  });

  it('removes one following punctuation mark with noPunctuation', () => {
    expect(applyReplacements('URL はれいどっとこむ。', [rep('れいどっとこむ', 'example.com', { noPunctuation: true })])).toBe('URL はexample.com');
  });

  it('matches triggers containing regular expression characters literally', () => {
    expect(applyReplacements('C++ と c＋＋', [rep('C++', 'C++言語')])).toBe('C++言語 と C++言語');
    expect(applyReplacements('a.b と axb', [rep('a.b', 'X')])).toBe('X と axb');
  });

  it('ignores empty triggers and returns the text unchanged without replacements', () => {
    expect(applyReplacements('そのまま', [rep('  ', 'x')])).toBe('そのまま');
    expect(applyReplacements('そのまま', [])).toBe('そのまま');
  });

  it('does not break surrogate pair characters', () => {
    expect(applyReplacements('𠮷野家でほげ', [rep('ほげ', 'ふが')])).toBe('𠮷野家でふが');
  });
});

describe('replacementTriggerKey', () => {
  it('gives the same key regardless of width, case and whitespace', () => {
    expect(replacementTriggerKey('ＡＰＩ キー')).toBe(replacementTriggerKey('apiキー'));
    expect(replacementTriggerKey('ほげ')).not.toBe(replacementTriggerKey('ホゲ'));
  });
});

describe('applySpacing (N2)', () => {
  it('adds a space before text starting with a letter or digit when a letter, digit or closing mark comes before', () => {
    expect(applySpacing('world', 'hello', undefined)).toBe(' world');
    expect(applySpacing('next', 'done)', undefined)).toBe(' next');
    expect(applySpacing('next', '100%', undefined)).toBe(' next');
    expect(applySpacing('(see)', 'text', undefined)).toBe(' (see)');
  });

  it('adds no leading space when Japanese or whitespace comes before', () => {
    expect(applySpacing('API', '設定の', undefined)).toBe('API');
    expect(applySpacing('API', 'the ', undefined)).toBe('API');
    expect(applySpacing('設定', 'abc', undefined)).toBe('設定');
  });

  it('adds a trailing space to text without Japanese at the end of the field (so sentences do not run together when dictating on)', () => {
    expect(applySpacing('Sounds good.', '', '')).toBe('Sounds good. ');
    expect(applySpacing('Sounds good.', '', undefined)).toBe('Sounds good.');
    expect(applySpacing('Sounds good.', '', 'next')).toBe('Sounds good. ');
    expect(applySpacing('Sounds good.', '', ' next')).toBe('Sounds good.');
    expect(applySpacing('Sounds good.', '', '。')).toBe('Sounds good.');
  });

  it('adds no trailing space to text with Japanese, even at the end of the field', () => {
    expect(applySpacing('設定はON', '', '')).toBe('設定はON');
    expect(applySpacing('了解です。', '', '')).toBe('了解です。');
  });

  it('adds a space after text with Japanese when a letter or digit follows and the text ends with a letter, digit or sentence-ending mark', () => {
    expect(applySpacing('設定はON', '', 'next')).toBe('設定はON ');
    expect(applySpacing('了解です', '', 'next')).toBe('了解です');
  });
});
