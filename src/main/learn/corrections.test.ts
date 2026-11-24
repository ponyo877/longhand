/**
 * 辞書に語を足さない学習（聞き違えた形、取り違えの組、書き換えない語句）。文はすべて作った例文である。
 * 語の切り出しと読みには、本物の単語分割（lindera、IPADIC）を使う。
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

describe('extractRewrites（語句の書き換えの取り出し）', () => {
  it('かなの表記への直しを、語の単位で取り出す', () => {
    expect(pairs(extractRewrites('何か食べたいものはありますか？', 'なんか食べたいものはありますか？', tokenizer))).toEqual([['何か', 'なんか']]);
  });

  it('両端の同じ語は落とす（複合語の一部だけを直したとき）', () => {
    expect(pairs(extractRewrites('新しい期間システムに移行します。', '新しい基幹システムに移行します。', tokenizer))).toEqual([['期間', '基幹']]);
  });

  it('残りが 1 字になるときは、同じ語を落とさない', () => {
    expect(pairs(extractRewrites('ミーティングは3時からです。', 'ミーティングは三時からです。', tokenizer))).toEqual([['3時', '三時']]);
  });

  it('近くの塊は 1 つにまとめるが、句読点はまたがない', () => {
    expect(pairs(extractRewrites('分からないので、後で聞いてみます。', 'わかんないんで、あとで聞いてみます。', tokenizer))).toEqual([
      ['分からないので', 'わかんないんで'],
      ['後で', 'あとで'],
    ]);
  });

  it('文の中での読みを添える', () => {
    const [r] = extractRewrites('資料を公正に回します。', '資料を校正に回します。', tokenizer);
    expect([r.fromReading, r.toReading]).toEqual(['コウセイ', 'コウセイ']);
  });

  it('単語分割が無くても、文字の種類で切り出す', () => {
    expect(pairs(extractRewrites('資料を公正に回します。', '資料を校正に回します。', null))).toEqual([['公正', '校正']]);
  });

  it('句読点だけの直しと、文の書き直しは取り出さない', () => {
    expect(extractRewrites('明日行きます。', '明日行きます', tokenizer)).toEqual([]);
    expect(extractRewrites('明日の会議は中止です。', '来週の打ち合わせは、場所を変えて行うことにしました。', tokenizer)).toEqual([]);
  });
});

describe('closeSound（音が同じか、ごく近いか）', () => {
  it('同じ読みと、1 音だけの違いは近い', () => {
    expect(closeSound('コウセイ', 'コウセイ')).toBe(true);
    expect(closeSound('コーティング', 'コーディング')).toBe(true);
    expect(closeSound('ナニカ', 'ナンカ')).toBe(true);
  });

  it('短い語の 1 音の違いと、別の語は近くない', () => {
    expect(closeSound('ハ', 'ガ')).toBe(false);
    expect(closeSound('ダシ', 'タシ')).toBe(false);
    expect(closeSound('アシタ', 'ミョウゴニチ')).toBe(false);
  });
});

describe('learnFromEdit の振り分け', () => {
  it('同じ読みの別の語への直しは、取り違えの組として覚える（辞書には入れない）', async () => {
    const r = await learnFromEdit('資料を公正に回します。', '資料を校正に回します。', ctx({ rawText: '資料を公正に回します' }));
    expect(r.words).toEqual([]);
    expect(r.corrections).toEqual([{ heard: '公正', corrected: '校正' }]);
    expect(r.skipped).toBeUndefined();
  });

  it('音声認識の表記を、かなに直したときも覚える', async () => {
    const r = await learnFromEdit('後で確認します。', 'あとで確認します。', ctx({ rawText: '後で確認します' }));
    expect(r.corrections).toEqual([{ heard: '後で', corrected: 'あとで' }]);
    expect(r.kept).toEqual([]);
  });

  it('整形が書き換えた所を、書き起こしのとおりに戻したら、書き換えない語句として覚える', async () => {
    const r = await learnFromEdit('何か食べたいものはありますか？', 'なんか食べたいものはありますか？', ctx({ rawText: 'なんか食べたいものはありますか' }));
    expect(r.kept).toEqual([{ phrase: 'なんか', changedTo: '何か' }]);
    expect(r.corrections).toEqual([]);
  });

  it('書き起こしが分からないとき（rawText なし）は、戻した手直しとは見なさない', async () => {
    const r = await learnFromEdit('何か食べたいものはありますか？', 'なんか食べたいものはありますか？', ctx());
    expect(r.kept).toEqual([]);
    expect(r.corrections).toEqual([{ heard: '何か', corrected: 'なんか' }]);
  });

  it('すでに辞書にある語に直したら、直す前の形を、その語の聞き違えた形として覚える', async () => {
    const r = await learnFromEdit('クバネテスの設定を見直します。', 'Kubernetesの設定を見直します。', ctx({ vocabulary: ['Kubernetes'], rawText: 'くばねてすの設定を見直します' }));
    expect(r.forms).toEqual([{ word: 'Kubernetes', from: 'クバネテス' }]);
    expect(r.words).toEqual([]);
    expect(r.corrections).toEqual([]);
  });

  it('漢字の語は、読みで音の近さを確かめる', async () => {
    const r = await learnFromEdit('伊賀らしさんに確認します。', '五十嵐さんに確認します。', ctx({ vocabulary: ['五十嵐'] }));
    expect(r.forms).toEqual([{ word: '五十嵐', from: '伊賀らし' }]);
    // 単語分割が無ければ、読みが分からないので覚えない
    const r2 = await learnFromEdit('伊賀らしさんに確認します。', '五十嵐さんに確認します。', ctx({ vocabulary: ['五十嵐'], tokenizer: null }));
    expect(r2.forms).toEqual([]);
  });

  it('辞書の語を別の語に言い換えただけなら、何も覚えない', async () => {
    const r = await learnFromEdit('Slackで送ります。', 'Teamsで送ります。', ctx({ vocabulary: ['Slack', 'Teams'] }));
    expect([r.words, r.forms, r.corrections, r.kept]).toEqual([[], [], [], []]);
  });

  it('意味を変えた直しと、数の直しは覚えない', async () => {
    const a = await learnFromEdit('明日の会議は中止です。', '明後日の会議は中止です。', ctx());
    expect([a.corrections, a.kept]).toEqual([[], []]);
    const b = await learnFromEdit('8日に出発します。', '4日に出発します。', ctx({ rawText: '八日に出発します' }));
    expect([b.corrections, b.kept]).toEqual([[], []]);
  });

  it('単語分割が無ければ、取り違えの組と、書き換えない語句は覚えない（語の途中で切れた組を覚えないため）', async () => {
    const a = await learnFromEdit('何か食べたいものはありますか？', 'なんか食べたいものはありますか？', ctx({ rawText: 'なんか食べたいものはありますか', tokenizer: null }));
    expect([a.corrections, a.kept]).toEqual([[], []]);
    const b = await learnFromEdit('資料を公正に回します。', '資料を校正に回します。', ctx({ tokenizer: null }));
    expect(b.corrections).toEqual([]);
  });

  it('句読点をまたぐ直しは覚えない', async () => {
    const r = await learnFromEdit('クラスターをterraformで作ります。', 'クラスタを、Terraformで作ります。', ctx());
    expect(r.corrections.every((c) => !/[、。]/.test(c.heard + c.corrected))).toBe(true);
  });

  it('学習しない語への直しは、取り違えの組にもしない', async () => {
    const r = await learnFromEdit('資料を公正に回します。', '資料を校正に回します。', ctx({ blocked: ['校正'] }));
    expect(r.corrections).toEqual([]);
  });

  it('辞書に入れた語は、取り違えの組に重ねて入れない', async () => {
    const r = await learnFromEdit('ぐらふぁなを見てください。', 'Grafanaを見てください。', ctx());
    expect(r.words.map((w) => w.word)).toEqual(['Grafana']);
    expect(r.corrections).toEqual([]);
  });
});

describe('保存先への反映と、整形への受け渡し', () => {
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

  it('辞書の語の聞き違えた形は、照合の候補と、整形の辞書の行に入る', () => {
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

  it('学習語にも 2 つ目からの形を足せる。形は 1 語あたりの上限まで', () => {
    store.addLearnedWords([{ word: 'Grafana', from: 'ぐらふぁな', learnedAt: 1 }]);
    expect(store.addMisheardForms([{ word: 'Grafana', from: 'ぐらふぁな' }])).toEqual([]);
    for (let i = 0; i < 8; i++) store.addMisheardForms([{ word: 'Grafana', from: `ぐらはな${i}` }]);
    expect(store.get().misheard?.Grafana).toHaveLength(6);
    expect(store.misheardForms('Grafana')[0]).toBe('ぐらはな7');
    // 整形には、新しい形から 3 つまで渡す
    expect(store.prepareFormatting('x', { useLlm: true }).misheard?.Grafana).toEqual(['ぐらはな7', 'ぐらはな6', 'ぐらはな5']);
  });

  it('語が辞書から消えたら、その語の形も片づける', () => {
    store.update({ dictionary: ['Kubernetes'] });
    store.addMisheardForms([{ word: 'Kubernetes', from: 'クバネテス' }]);
    store.update({ dictionary: [] });
    expect(store.get().misheard).toEqual({});
  });

  it('取り違えの組は、生テキストに出ているものだけを整形に渡す。LLM を使わないときは渡さない', () => {
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

  it('同じ組は回数を増やし、逆向きの組は古いほうを外す', () => {
    store.addPastCorrections([{ heard: '公正', corrected: '校正' }]);
    const again = store.addPastCorrections([{ heard: '公正', corrected: '校正' }]);
    expect(again[0].count).toBe(2);
    store.addPastCorrections([{ heard: '校正', corrected: '公正' }]);
    expect(store.get().pastCorrections?.map((c) => [c.heard, c.corrected, c.count])).toEqual([['校正', '公正', 1]]);
  });

  it('書き換えない語句は、古い順に整形に渡す', () => {
    store.addKeptPhrases([{ phrase: 'なんか', changedTo: '何か' }]);
    store.addKeptPhrases([{ phrase: 'いちばん', changedTo: '一番' }]);
    expect(store.prepareFormatting('x', { useLlm: true }).kept).toEqual([
      { phrase: 'なんか', changedTo: '何か' },
      { phrase: 'いちばん', changedTo: '一番' },
    ]);
  });

  it('何も覚えていなければ、整形に渡すものは空', () => {
    const prep = store.prepareFormatting('明日行きます', { useLlm: true });
    expect([prep.misheard, prep.corrections, prep.kept, prep.hasCorrections]).toEqual([{}, [], [], false]);
  });

  it('反映した学習を、まとめて取り消せる', async () => {
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

  it('回数を増やしただけの組は、取り消しても残す', () => {
    store.addPastCorrections([{ heard: '公正', corrected: '校正' }]);
    const applied = applyLearning(store, { words: [], forms: [], corrections: [{ heard: '公正', corrected: '校正' }], kept: [] });
    applied.undo();
    expect(store.get().pastCorrections?.map((c) => c.count)).toEqual([2]);
  });
});
