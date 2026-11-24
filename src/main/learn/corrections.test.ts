/**
 * Learning that adds no words to the dictionary (misheard forms, mix-up pairs, phrases not to rewrite). All sentences are made-up examples.
 * Word extraction and readings use the real tokenizer (lindera, IPADIC).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomizationsStore } from '../store/customizations';
import type { Tokenizer } from '../textfix/types';
import { createLinderaTokenizer } from '../textfix/tokenizer';
import { applyLearning } from './apply';
import { extractRewrites } from './diff';
import { closeSound, learnFromEdit, type LearnContext } from './Learner';

const WASM = path.join(process.cwd(), 'node_modules/lindera-wasm-ipadic-web/lindera_wasm_bg.wasm');
let tokenizer: Tokenizer;
beforeAll(async () => {
  tokenizer = await createLinderaTokenizer(fs.readFileSync(WASM));
});

const ctx = (over: Partial<Omit<LearnContext, 'inserted'>> = {}): Omit<LearnContext, 'inserted'> => ({
  vocabulary: [],
  blocked: [],
  provider: null,
  timeoutMs: 1000,
  tokenizer,
  ...over,
});
const pairs = (list: { from: string; to: string }[]) => list.map((r) => [r.from, r.to]);

describe('extractRewrites (extracting phrase rewrites)', () => {
  it('extracts fixes to kana spelling as whole words', () => {
    expect(pairs(extractRewrites('何か食べたいものはありますか？', 'なんか食べたいものはありますか？', tokenizer))).toEqual([['何か', 'なんか']]);
  });

  it('drops identical words at both ends (when only part of a compound was fixed)', () => {
    expect(pairs(extractRewrites('新しい期間システムに移行します。', '新しい基幹システムに移行します。', tokenizer))).toEqual([['期間', '基幹']]);
  });

  it('keeps identical words when only one character would remain', () => {
    expect(pairs(extractRewrites('ミーティングは3時からです。', 'ミーティングは三時からです。', tokenizer))).toEqual([['3時', '三時']]);
  });

  it('merges nearby hunks into one, but not across punctuation', () => {
    expect(pairs(extractRewrites('分からないので、後で聞いてみます。', 'わかんないんで、あとで聞いてみます。', tokenizer))).toEqual([
      ['分からないので', 'わかんないんで'],
      ['後で', 'あとで'],
    ]);
  });

  it('attaches the reading in the sentence', () => {
    const [r] = extractRewrites('資料を公正に回します。', '資料を校正に回します。', tokenizer);
    expect([r.fromReading, r.toReading]).toEqual(['コウセイ', 'コウセイ']);
  });

  it('cuts by script even without a tokenizer', () => {
    expect(pairs(extractRewrites('資料を公正に回します。', '資料を校正に回します。', null))).toEqual([['公正', '校正']]);
  });

  it('extracts neither punctuation-only fixes nor sentence rewrites', () => {
    expect(extractRewrites('明日行きます。', '明日行きます', tokenizer)).toEqual([]);
    expect(extractRewrites('明日の会議は中止です。', '来週の打ち合わせは、場所を変えて行うことにしました。', tokenizer)).toEqual([]);
  });
});

describe('closeSound (same or very close sound)', () => {
  it('treats the same reading and a one-sound difference as close', () => {
    expect(closeSound('コウセイ', 'コウセイ')).toBe(true);
    expect(closeSound('コーティング', 'コーディング')).toBe(true);
    expect(closeSound('ナニカ', 'ナンカ')).toBe(true);
  });

  it('treats a one-sound difference in a short word, and different words, as not close', () => {
    expect(closeSound('ハ', 'ガ')).toBe(false);
    expect(closeSound('ダシ', 'タシ')).toBe(false);
    expect(closeSound('アシタ', 'ミョウゴニチ')).toBe(false);
  });
});

describe('learnFromEdit sorting', () => {
  it('learns a fix to another word with the same reading as a mix-up pair (not added to the dictionary)', async () => {
    const r = await learnFromEdit('資料を公正に回します。', '資料を校正に回します。', ctx({ rawText: '資料を公正に回します' }));
    expect(r.words).toEqual([]);
    expect(r.corrections).toEqual([{ heard: '公正', corrected: '校正' }]);
    expect(r.skipped).toBeUndefined();
  });

  it('also learns when the recognized spelling is changed to kana', async () => {
    const r = await learnFromEdit('後で確認します。', 'あとで確認します。', ctx({ rawText: '後で確認します' }));
    expect(r.corrections).toEqual([{ heard: '後で', corrected: 'あとで' }]);
    expect(r.kept).toEqual([]);
  });

  it('learns a phrase not to rewrite when a formatter rewrite is put back as transcribed', async () => {
    const r = await learnFromEdit('何か食べたいものはありますか？', 'なんか食べたいものはありますか？', ctx({ rawText: 'なんか食べたいものはありますか' }));
    expect(r.kept).toEqual([{ phrase: 'なんか', changedTo: '何か' }]);
    expect(r.corrections).toEqual([]);
  });

  it('does not treat it as undoing a rewrite when the transcript is unknown (no rawText)', async () => {
    const r = await learnFromEdit('何か食べたいものはありますか？', 'なんか食べたいものはありますか？', ctx());
    expect(r.kept).toEqual([]);
    expect(r.corrections).toEqual([{ heard: '何か', corrected: 'なんか' }]);
  });

  it('learns the form before the fix as a misheard form of a word already in the dictionary', async () => {
    const r = await learnFromEdit('クバネテスの設定を見直します。', 'Kubernetesの設定を見直します。', ctx({ vocabulary: ['Kubernetes'], rawText: 'くばねてすの設定を見直します' }));
    expect(r.forms).toEqual([{ word: 'Kubernetes', from: 'クバネテス' }]);
    expect(r.words).toEqual([]);
    expect(r.corrections).toEqual([]);
  });

  it('checks how close kanji words sound by their readings', async () => {
    const r = await learnFromEdit('伊賀らしさんに確認します。', '五十嵐さんに確認します。', ctx({ vocabulary: ['五十嵐'] }));
    expect(r.forms).toEqual([{ word: '五十嵐', from: '伊賀らし' }]);
    // Without a tokenizer the reading is unknown, so nothing is learned
    const r2 = await learnFromEdit('伊賀らしさんに確認します。', '五十嵐さんに確認します。', ctx({ vocabulary: ['五十嵐'], tokenizer: null }));
    expect(r2.forms).toEqual([]);
  });

  it('learns nothing when a dictionary word was only reworded into another word', async () => {
    const r = await learnFromEdit('Slackで送ります。', 'Teamsで送ります。', ctx({ vocabulary: ['Slack', 'Teams'] }));
    expect([r.words, r.forms, r.corrections, r.kept]).toEqual([[], [], [], []]);
  });

  it('learns neither fixes that change the meaning nor fixes to numbers', async () => {
    const a = await learnFromEdit('明日の会議は中止です。', '明後日の会議は中止です。', ctx());
    expect([a.corrections, a.kept]).toEqual([[], []]);
    const b = await learnFromEdit('8日に出発します。', '4日に出発します。', ctx({ rawText: '八日に出発します' }));
    expect([b.corrections, b.kept]).toEqual([[], []]);
  });

  it('learns neither mix-up pairs nor phrases not to rewrite without a tokenizer (to avoid pairs cut mid-word)', async () => {
    const a = await learnFromEdit('何か食べたいものはありますか？', 'なんか食べたいものはありますか？', ctx({ rawText: 'なんか食べたいものはありますか', tokenizer: null }));
    expect([a.corrections, a.kept]).toEqual([[], []]);
    const b = await learnFromEdit('資料を公正に回します。', '資料を校正に回します。', ctx({ tokenizer: null }));
    expect(b.corrections).toEqual([]);
  });

  it('learns nothing from fixes that span punctuation', async () => {
    const r = await learnFromEdit('クラスターをterraformで作ります。', 'クラスタを、Terraformで作ります。', ctx());
    expect(r.corrections.every((c) => !/[、。]/.test(c.heard + c.corrected))).toBe(true);
  });

  it('does not make a mix-up pair from a fix to a word not to learn', async () => {
    const r = await learnFromEdit('資料を公正に回します。', '資料を校正に回します。', ctx({ blocked: ['校正'] }));
    expect(r.corrections).toEqual([]);
  });

  it('does not also add a word added to the dictionary as a mix-up pair', async () => {
    const r = await learnFromEdit('ぐらふぁなを見てください。', 'Grafanaを見てください。', ctx());
    expect(r.words.map((w) => w.word)).toEqual(['Grafana']);
    expect(r.corrections).toEqual([]);
  });
});

describe('saving and handing over to formatting', () => {
  let dir: string;
  let store: CustomizationsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-learn-test-'));
    store = new CustomizationsStore(path.join(dir, 'customizations.json'));
  });
  afterEach(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts misheard forms of dictionary words into match candidates and the formatter dictionary line', () => {
    store.update({ dictionary: ['Kubernetes'] });
    const added = store.addMisheardForms([
      { word: 'kubernetes', from: 'クバネテス' },
      { word: 'Kubernetes', from: 'クバネテス' },
      { word: 'Kubernetes', from: 'Kubernetes' },
      { word: 'Unknown', from: 'あんのうん' },
    ]);
    expect(added).toEqual([{ word: 'Kubernetes', from: 'クバネテス' }]);
    const prep = store.prepareFormatting('くばねてすの設定を見直します', { useLlm: true });
    expect(prep.candidates).toEqual([{ heard: 'くばねてす', word: 'Kubernetes' }]);
    expect(prep.misheard).toEqual({ Kubernetes: ['クバネテス'] });
  });

  it('adds forms from the second one on to learned words too, up to the per-word limit', () => {
    store.addLearnedWords([{ word: 'Grafana', from: 'ぐらふぁな', learnedAt: 1 }]);
    expect(store.addMisheardForms([{ word: 'Grafana', from: 'ぐらふぁな' }])).toEqual([]);
    for (let i = 0; i < 8; i++) store.addMisheardForms([{ word: 'Grafana', from: `ぐらはな${i}` }]);
    expect(store.get().misheard?.Grafana).toHaveLength(6);
    expect(store.misheardForms('Grafana')[0]).toBe('ぐらはな7');
    // Formatting gets up to 3 forms, newest first
    expect(store.prepareFormatting('x', { useLlm: true }).misheard?.Grafana).toEqual(['ぐらはな7', 'ぐらはな6', 'ぐらはな5']);
  });

  it("cleans up a word's forms when the word leaves the dictionary", () => {
    store.update({ dictionary: ['Kubernetes'] });
    store.addMisheardForms([{ word: 'Kubernetes', from: 'クバネテス' }]);
    store.update({ dictionary: [] });
    expect(store.get().misheard).toEqual({});
  });

  it('passes only mix-up pairs that appear in the raw text to formatting, and none without the LLM', () => {
    store.addPastCorrections([
      { heard: '公正', corrected: '校正' },
      { heard: '期間', corrected: '基幹' },
    ]);
    const prep = store.prepareFormatting('資料を公正に回します', { useLlm: true });
    expect(prep.corrections).toEqual([{ heard: '公正', corrected: '校正' }]);
    expect(prep.hasCorrections).toBe(true);
    expect(store.prepareFormatting('資料を公正に回します', { useLlm: false }).corrections).toEqual([]);
    expect(store.prepareFormatting('明日行きます', { useLlm: true }).corrections).toEqual([]);
  });

  it('increases the count for the same pair and removes the older of two opposite pairs', () => {
    store.addPastCorrections([{ heard: '公正', corrected: '校正' }]);
    const again = store.addPastCorrections([{ heard: '公正', corrected: '校正' }]);
    expect(again[0].count).toBe(2);
    store.addPastCorrections([{ heard: '校正', corrected: '公正' }]);
    expect(store.get().pastCorrections?.map((c) => [c.heard, c.corrected, c.count])).toEqual([['校正', '公正', 1]]);
  });

  it('passes phrases not to rewrite to formatting, oldest first', () => {
    store.addKeptPhrases([{ phrase: 'なんか', changedTo: '何か' }]);
    store.addKeptPhrases([{ phrase: 'いちばん', changedTo: '一番' }]);
    expect(store.prepareFormatting('x', { useLlm: true }).kept).toEqual([
      { phrase: 'なんか', changedTo: '何か' },
      { phrase: 'いちばん', changedTo: '一番' },
    ]);
  });

  it('passes nothing to formatting when nothing was learned', () => {
    const prep = store.prepareFormatting('明日行きます', { useLlm: true });
    expect([prep.misheard, prep.corrections, prep.kept, prep.hasCorrections]).toEqual([{}, [], [], false]);
  });

  it('undoes saved learning all at once', async () => {
    store.update({ dictionary: ['Kubernetes'] });
    const applied = applyLearning(store, {
      words: [{ word: 'Grafana', from: 'ぐらふぁな', learnedAt: 1 }],
      forms: [{ word: 'Kubernetes', from: 'クバネテス' }],
      corrections: [{ heard: '公正', corrected: '校正' }],
      kept: [{ phrase: 'なんか', changedTo: '何か' }],
    });
    expect(applied.count).toBe(4);
    applied.undo();
    const c = store.get();
    expect(c.learnedWords).toEqual([]);
    expect(c.blockedLearnedWords).toEqual(['Grafana']);
    expect(c.misheard?.Kubernetes ?? []).toEqual([]);
    expect(c.pastCorrections).toEqual([]);
    expect(c.keptPhrases).toEqual([]);
  });

  it('keeps pairs whose count was only increased when undoing', () => {
    store.addPastCorrections([{ heard: '公正', corrected: '校正' }]);
    const applied = applyLearning(store, { words: [], forms: [], corrections: [{ heard: '公正', corrected: '校正' }], kept: [] });
    applied.undo();
    expect(store.get().pastCorrections?.map((c) => c.count)).toEqual([2]);
  });
});

describe('number notation preferences', () => {
  let dir: string;
  let store: CustomizationsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-number-style-'));
    store = new CustomizationsStore(path.join(dir, 'customizations.json'));
  });
  afterEach(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('learns a notation change as a number style, not as a word or a correction', async () => {
    const r = await learnFromEdit('お願いが2つあります。', 'お願いが二つあります。', ctx());
    expect(r.numbers.map((n) => [n.kind, n.value])).toEqual([['counters', 'kanji']]);
    expect([r.words, r.forms, r.corrections, r.kept]).toEqual([[], [], [], []]);
    expect(r.skipped).toBeUndefined();
  });

  it('learns a number style next to another correction', async () => {
    const r = await learnFromEdit('資料を公正に回して、2つ確認します。', '資料を校正に回して、二つ確認します。', ctx());
    expect(r.numbers.map((n) => n.kind)).toEqual(['counters']);
    expect(pairs(r.corrections.map((c) => ({ from: c.heard, to: c.corrected })))).toEqual([['公正', '校正']]);
  });

  it('counts the same notation and replaces a different one', () => {
    store.addNumberStyles([{ kind: 'counters', value: 'kanji', before: '2つ', after: '二つ' }], 10);
    store.addNumberStyles([{ kind: 'counters', value: 'kanji', before: '3つ', after: '三つ' }], 20);
    expect(store.numberStyles()?.counters).toMatchObject({ value: 'kanji', count: 2, at: 20, example: { before: '3つ', after: '三つ' } });
    store.addNumberStyles([{ kind: 'counters', value: 'digits', before: '四つ', after: '4つ' }], 30);
    expect(store.numberStyles()?.counters).toMatchObject({ value: 'digits', count: 1 });
  });

  it('passes the preferences to formatting', () => {
    store.addNumberStyles([{ kind: 'grouping', value: 'comma', before: '10000円', after: '10,000円' }]);
    expect(store.prepareFormatting('予算は10000円です', { useLlm: false }).numberStyle?.grouping?.value).toBe('comma');
    expect(store.prepareFormatting('予算は10000円です', { useLlm: true }).numberStyle?.grouping?.value).toBe('comma');
  });

  it('undo puts back the previous preference', () => {
    store.addNumberStyles([{ kind: 'counters', value: 'kanji', before: '2つ', after: '二つ' }], 10);
    const applied = applyLearning(store, { words: [], forms: [], corrections: [], kept: [], numbers: [{ kind: 'counters', value: 'digits', before: '四つ', after: '4つ' }] });
    expect(applied.count).toBe(1);
    expect(store.numberStyles()?.counters?.value).toBe('digits');
    applied.undo();
    expect(store.numberStyles()?.counters).toMatchObject({ value: 'kanji', at: 10 });
  });

  it('undo removes a preference that did not exist before', () => {
    const applied = applyLearning(store, { words: [], forms: [], corrections: [], kept: [], numbers: [{ kind: 'date', value: 'slash', before: '11月24日', after: '11/24' }] });
    applied.undo();
    expect(store.get().numberStyle).toBeUndefined();
  });

  it('drops unknown kinds and values from the saved file, and an empty object clears the field', () => {
    store.update({ numberStyle: { counters: { value: 'roman', count: 1, at: 0 }, time: { value: 'colon', count: 1, at: 0 } } });
    expect(Object.keys(store.get().numberStyle ?? {})).toEqual(['time']);
    store.update({ numberStyle: {} });
    expect(store.get().numberStyle).toBeUndefined();
  });
});
