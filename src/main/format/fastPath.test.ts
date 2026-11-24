import { describe, expect, it } from 'vitest';
import { FAST_PATH_MAX_CHARS, llmReason, needsLlm, type FastPathContext } from './fastPath';

const ctx: FastPathContext = { mode: 'dictation', language: 'ja', customInstructions: '' };
const reason = (text: string, over: Partial<FastPathContext> = {}) => llmReason(text, { ...ctx, ...over });

describe('needsLlm (N6)', () => {
  it('skips the LLM for short sentences clean down to the period and for trailing-off endings', () => {
    expect(needsLlm('明日の会議は午後からです。', ctx)).toBe(false);
    expect(needsLlm('資料は共有しておきました。確認してください。', ctx)).toBe(false);
    expect(needsLlm('見積もりの件なんですけど', ctx)).toBe(false);
    expect(needsLlm('今日は早めに帰るので', ctx)).toBe(false);
    expect(needsLlm('来週でも大丈夫ですか？', ctx)).toBe(false);
  });

  it('sends to the LLM when the language is not Japanese, or is auto without hiragana', () => {
    expect(reason('了解です。', { language: 'en' })).toBe('language');
    expect(reason('Sounds good.', { language: 'auto' })).toBe('no-hiragana');
    expect(reason('了解です。', { language: 'auto' })).toBeNull();
  });

  it('sends to the LLM when some characters have low recognition confidence', () => {
    expect(reason('明日の会議は午後からです。', { lowConfidence: true })).toBe('low-confidence');
    expect(reason('明日の会議は午後からです。', { lowConfidence: false })).toBeNull();
  });

  it('sends to the LLM in edit mode and with custom instructions', () => {
    expect(reason('了解です。', { mode: 'edit' })).toBe('mode');
    expect(reason('了解です。', { customInstructions: '敬体で書く' })).toBe('custom-instructions');
  });

  it('sends to the LLM when the text is too short, too long, or contains newlines or spaces', () => {
    expect(reason('は')).toBe('length');
    expect(reason(`${'あ'.repeat(FAST_PATH_MAX_CHARS)}。`)).toBe('length');
    expect(reason('一行目です。\n二行目です。')).toBe('newline');
    expect(reason('明日 行きます。')).toBe('space');
  });

  it('sends to the LLM without punctuation, with 「。」 after a trailing-off ending, or when a question needs judging', () => {
    expect(reason('明日の会議は午後からです')).toBe('ending');
    expect(reason('見積もりの件なんですけど。')).toBe('period-after-conjunction');
    expect(reason('明日は来られますか。')).toBe('question');
    expect(reason('明日は晴れるかな？')).toBe('question');
    expect(reason('すごいですね！')).toBe('exclamation');
  });

  it('sends to the LLM with hesitations, self-repairs or spoken symbols', () => {
    expect(reason('えーと明日行きます。')).toBe('filler');
    expect(reason('まあ明日でいいです。')).toBe('filler');
    expect(reason('明日、いや明後日行きます。')).toBe('self-repair');
    expect(reason('三時じゃなくて四時です。')).toBe('self-repair');
    expect(reason('ここで改行してください。')).toBe('spoken-format');
  });

  it('sends to the LLM with 3 or more katakana (possibly a product name) or kanji numerals that should become Arabic numerals', () => {
    expect(reason('スラックで送ります。')).toBe('katakana');
    expect(reason('会議は十時からです。')).toBe('kanji-digits');
    expect(reason('一旦保留にします。')).toBeNull();
  });

  it('lets Latin words through only when spelled as in the dictionary', () => {
    expect(reason('Slackで送ります。')).toBe('latin');
    expect(reason('Slackで送ります。', { vocabulary: ['Slack'] })).toBeNull();
    expect(reason('slackで送ります。', { vocabulary: ['Slack'] })).toBe('latin');
  });

  it('sends to the LLM when there are dictionary word candidates', () => {
    expect(reason('明日行きます。', { dictionaryCandidates: [{ heard: '明日', word: 'Asuka' }] })).toBe('dictionary-candidate');
    expect(reason('明日行きます。', { dictionaryCandidates: [] })).toBeNull();
  });

  it('sends to the LLM when the text contains a replacement trigger', () => {
    expect(reason('ほげを使います。', { protectedPhrases: ['ほげ'] })).toBe('replacement');
    expect(reason('ほ げを使います。', { protectedPhrases: ['ほげ'] })).toBe('space');
    expect(reason('明日行きます。', { protectedPhrases: ['ほげ', ' '] })).toBeNull();
  });

  it('sends to the LLM when inserting mid-sentence', () => {
    expect(reason('午後からです。', { beforeCursor: '会議は' })).toBe('mid-sentence');
    expect(reason('午後からです。', { beforeCursor: '了解です。' })).toBeNull();
    expect(reason('午後からです。', { beforeCursor: '件名\n' })).toBeNull();
    expect(reason('午後からです。', { afterCursor: 'よろしく' })).toBe('mid-sentence');
    expect(reason('午後からです。', { afterCursor: '\nよろしく' })).toBeNull();
  });
});
