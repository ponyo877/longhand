import { describe, expect, it } from 'vitest';
import { FAST_PATH_MAX_CHARS, llmReason, needsLlm, type FastPathContext } from './fastPath';

const ctx: FastPathContext = { mode: 'dictation', language: 'ja', customInstructions: '' };
const reason = (text: string, over: Partial<FastPathContext> = {}) => llmReason(text, { ...ctx, ...over });

describe('needsLlm（N6）', () => {
  it('句点まで整った短い文と、言いさしで終わる文は LLM を飛ばす', () => {
    expect(needsLlm('明日の会議は午後からです。', ctx)).toBe(false);
    expect(needsLlm('資料は共有しておきました。確認してください。', ctx)).toBe(false);
    expect(needsLlm('見積もりの件なんですけど', ctx)).toBe(false);
    expect(needsLlm('今日は早めに帰るので', ctx)).toBe(false);
    expect(needsLlm('来週でも大丈夫ですか？', ctx)).toBe(false);
  });

  it('言語が日本語でなければ、または auto でひらがなが無ければ LLM に回す', () => {
    expect(reason('了解です。', { language: 'en' })).toBe('language');
    expect(reason('Sounds good.', { language: 'auto' })).toBe('no-hiragana');
    expect(reason('了解です。', { language: 'auto' })).toBeNull();
  });

  it('音声認識の確信度の低い字があるときは LLM に回す', () => {
    expect(reason('明日の会議は午後からです。', { lowConfidence: true })).toBe('low-confidence');
    expect(reason('明日の会議は午後からです。', { lowConfidence: false })).toBeNull();
  });

  it('編集モードとカスタム指示があるときは LLM に回す', () => {
    expect(reason('了解です。', { mode: 'edit' })).toBe('mode');
    expect(reason('了解です。', { customInstructions: '敬体で書く' })).toBe('custom-instructions');
  });

  it('短すぎる、長すぎる、改行や空白を含むときは LLM に回す', () => {
    expect(reason('は')).toBe('length');
    expect(reason(`${'あ'.repeat(FAST_PATH_MAX_CHARS)}。`)).toBe('length');
    expect(reason('一行目です。\n二行目です。')).toBe('newline');
    expect(reason('明日 行きます。')).toBe('space');
  });

  it('句読点が無い、言いさしに「。」が付いている、問いかけの判断が要るときは LLM に回す', () => {
    expect(reason('明日の会議は午後からです')).toBe('ending');
    expect(reason('見積もりの件なんですけど。')).toBe('period-after-conjunction');
    expect(reason('明日は来られますか。')).toBe('question');
    expect(reason('明日は晴れるかな？')).toBe('question');
    expect(reason('すごいですね！')).toBe('exclamation');
  });

  it('言いよどみ、言い直し、記号の読み上げを含むときは LLM に回す', () => {
    expect(reason('えーと明日行きます。')).toBe('filler');
    expect(reason('まあ明日でいいです。')).toBe('filler');
    expect(reason('明日、いや明後日行きます。')).toBe('self-repair');
    expect(reason('三時じゃなくて四時です。')).toBe('self-repair');
    expect(reason('ここで改行してください。')).toBe('spoken-format');
  });

  it('3 字以上のカタカナ（製品名の可能性）や、算用数字に直すべき漢数字を含むときは LLM に回す', () => {
    expect(reason('スラックで送ります。')).toBe('katakana');
    expect(reason('会議は十時からです。')).toBe('kanji-digits');
    expect(reason('一旦保留にします。')).toBeNull();
  });

  it('英字の語は、辞書と同じ表記のときだけ通す', () => {
    expect(reason('Slackで送ります。')).toBe('latin');
    expect(reason('Slackで送ります。', { vocabulary: ['Slack'] })).toBeNull();
    expect(reason('slackで送ります。', { vocabulary: ['Slack'] })).toBe('latin');
  });

  it('辞書の語の候補があるときは LLM に回す', () => {
    expect(reason('明日行きます。', { dictionaryCandidates: [{ heard: '明日', word: 'Asuka' }] })).toBe('dictionary-candidate');
    expect(reason('明日行きます。', { dictionaryCandidates: [] })).toBeNull();
  });

  it('置換のきっかけを含むときは LLM に回す', () => {
    expect(reason('ほげを使います。', { protectedPhrases: ['ほげ'] })).toBe('replacement');
    expect(reason('ほ げを使います。', { protectedPhrases: ['ほげ'] })).toBe('space');
    expect(reason('明日行きます。', { protectedPhrases: ['ほげ', ' '] })).toBeNull();
  });

  it('文の途中に差し込むときは LLM に回す', () => {
    expect(reason('午後からです。', { beforeCursor: '会議は' })).toBe('mid-sentence');
    expect(reason('午後からです。', { beforeCursor: '了解です。' })).toBeNull();
    expect(reason('午後からです。', { beforeCursor: '件名\n' })).toBeNull();
    expect(reason('午後からです。', { afterCursor: 'よろしく' })).toBe('mid-sentence');
    expect(reason('午後からです。', { afterCursor: '\nよろしく' })).toBeNull();
  });
});
