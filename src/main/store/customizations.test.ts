import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomizationsStore, LEARNED_LIMIT, WORD_MAX_LENGTH } from './customizations';

let dir: string;
let store: CustomizationsStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-cust-test-'));
  store = new CustomizationsStore(path.join(dir, 'customizations.json'));
});

afterEach(() => {
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

const lw = (word: string, from: string, learnedAt = 1000) => ({ word, from, learnedAt });

describe('学習語の追加', () => {
  it('1 回の追加の中の同じ語は 1 つにまとめる', () => {
    const added = store.addLearnedWords([lw('Grafana', 'ぐらふぁな'), lw('grafana', 'ぐらふぁな')]);
    expect(added.map((w) => w.word)).toEqual(['Grafana']);
    expect(store.get().learnedWords).toHaveLength(1);
  });

  it('学習語を別の語に直したら、古い学習語を外して学習しない語に入れる（G4-06）', () => {
    store.addLearnedWords([lw('Graphana', 'ぐらふぁな')]);
    store.addLearnedWords([lw('Grafana', 'Graphana')]);
    expect(store.get().learnedWords.map((w) => w.word)).toEqual(['Grafana']);
    expect(store.get().blockedLearnedWords).toEqual(['Graphana']);
  });

  it(`学習語が ${LEARNED_LIMIT} 語を超えたら古い語から外す`, () => {
    const words = Array.from({ length: LEARNED_LIMIT + 1 }, (_, i) => lw(`Term${i}`, `たーむ${i}`, 1000 + i));
    store.addLearnedWords(words);
    const kept = store.get().learnedWords;
    expect(kept).toHaveLength(LEARNED_LIMIT);
    expect(kept.some((w) => w.word === 'Term0')).toBe(false);
  });

  it('取り消した語は二度と学習しない', () => {
    store.addLearnedWords([lw('Grafana', 'ぐらふぁな')]);
    store.undoLearnedWord('Grafana');
    expect(store.addLearnedWords([lw('Grafana', 'ぐらふぁな')])).toEqual([]);
  });
});

describe('辞書の検査', () => {
  it(`${WORD_MAX_LENGTH} 字を超える語は入れない`, () => {
    store.update({ dictionary: ['Grafana', 'x'.repeat(WORD_MAX_LENGTH + 1)] });
    expect(store.get().dictionary).toEqual(['Grafana']);
  });

  it('消した語の読みも片づける', () => {
    store.update({ dictionary: ['Grafana', 'Datadog'], readings: { Grafana: ['グラファナ'], Datadog: ['データドッグ'] } });
    store.update({ dictionary: ['Datadog'] });
    expect(store.get().readings).toEqual({ Datadog: ['データドッグ'] });
  });
});

describe('ASR のヒント（G4-09）', () => {
  it('件数を数で渡せる（以前の呼び出し方）', () => {
    store.update({ dictionary: ['Alpha', 'Bravo', 'Charlie'] });
    expect(store.asrHints(2)).toEqual(['Charlie', 'Bravo']);
  });

  it('入力欄にある語を先にする', () => {
    store.update({ dictionary: ['Grafana', 'Datadog', 'Postgres'] });
    expect(store.asrHints({ limit: 1, context: { beforeCursor: 'Grafana の件' } })).toEqual(['Grafana']);
  });
});

describe('整形の前の照合（G4-11）', () => {
  beforeEach(() => {
    store.update({ dictionary: ['Datadog'], suggestedReadings: { Datadog: ['データドッグ'] } });
    store.addLearnedWords([lw('Grafana', 'ぐらふぁな')]);
  });

  it('LLM を使わないときは、確かめた読み（自分で直した誤認識の形）に一致した所だけを置き換える', () => {
    const r = store.prepareFormatting('ぐらふぁなとでーたどっぐを見る', { useLlm: false });
    expect(r.text).toBe('Grafanaとでーたどっぐを見る');
    expect(r.replaced).toBe(1);
    expect(r.candidates).toEqual([]);
  });

  it('LLM を使うときは置き換えず、候補を渡す', () => {
    const r = store.prepareFormatting('ぐらふぁなとでーたどっぐを見る', { useLlm: true });
    expect(r.text).toBe('ぐらふぁなとでーたどっぐを見る');
    expect(r.candidates).toEqual([
      { heard: 'ぐらふぁな', word: 'Grafana' },
      { heard: 'でーたどっぐ', word: 'Datadog' },
    ]);
    expect(r.vocabulary).toEqual(expect.arrayContaining(['Grafana', 'Datadog']));
  });

  it('整形に渡す語は上限まで絞り、照合で見つかった語は必ず入れる', () => {
    store.update({ dictionary: ['Datadog', ...Array.from({ length: 20 }, (_, i) => `Term${i}`)] });
    const r = store.prepareFormatting('でーたどっぐを見る', { useLlm: true, vocabularyLimit: 5 });
    expect(r.vocabulary).toHaveLength(5);
    expect(r.vocabulary[0]).toBe('Datadog');
  });
});

describe('読みの候補の生成', () => {
  it('読みのない英字の辞書の語について、まとめて読みを作る', async () => {
    store.update({ dictionary: ['Grafana', '日鷹'] });
    const gen = vi.fn(async (words: string[]) => Object.fromEntries(words.map((w) => [w, ['グラファナ']])));
    store.setReadingGenerator(gen);
    expect(store.wordsNeedingReadings()).toEqual(['Grafana']);
    await store.generateReadingsNow();
    expect(gen).toHaveBeenCalledWith(['Grafana']);
    expect(store.get().suggestedReadings).toEqual({ Grafana: ['グラファナ'] });
    expect(store.wordsNeedingReadings()).toEqual([]);
  });

  it('作れなかった語は同じ起動中は作り直さない', async () => {
    store.update({ dictionary: ['Grafana'] });
    store.setReadingGenerator(async () => ({}));
    await store.generateReadingsNow();
    expect(store.wordsNeedingReadings()).toEqual([]);
  });
});

describe('置換の大文字小文字の設定の移行（G4-12）', () => {
  it('以前の意味で保存された置換を 1 回だけ反転する', () => {
    const file = path.join(dir, 'old.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        dictionary: [],
        customInstructions: '',
        learnedWords: [],
        blockedLearnedWords: [],
        replacements: [
          { id: 'a', from: 'めーる', to: 'mail@example.com', preserveCase: false, noPunctuation: true },
          { id: 'b', from: 'しょめい', to: 'thanks', preserveCase: true, noPunctuation: false },
        ],
      }),
    );
    const s1 = new CustomizationsStore(file);
    expect(s1.get().replacements.map((r) => r.preserveCase)).toEqual([true, false]);
    expect(s1.get().replacementCaseMigrated).toBe(true);
    s1.flush();
    const s2 = new CustomizationsStore(file);
    expect(s2.get().replacements.map((r) => r.preserveCase)).toEqual([true, false]);
    s2.flush();
  });

  it('整形に渡す語の並びは、照合の結果や得点によらず、辞書に入っている順にする（システムプロンプトを変えないため）', () => {
    store.update({ dictionary: ['Alpha', 'Grafana', 'Zeta'], readings: { Grafana: ['ぐらふぁな'] } });
    store.addLearnedWords([lw('Datadog', 'でーたどっぐ', 5000)]);
    const plain = store.prepareFormatting('今日は晴れです', { useLlm: true }).vocabulary;
    const matched = store.prepareFormatting('ぐらふぁなを見てください', { useLlm: true, context: { beforeCursor: 'Zeta の件' } }).vocabulary;
    expect(plain).toEqual(['Alpha', 'Grafana', 'Zeta', 'Datadog']);
    expect(matched).toEqual(plain);
  });

  it('新しく作った保存先には移行済みの印だけを付ける', () => {
    expect(store.get().replacementCaseMigrated).toBe(true);
  });
});
