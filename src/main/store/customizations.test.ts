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

describe('adding learned words', () => {
  it('merges the same word within one batch', () => {
    const added = store.addLearnedWords([lw('Grafana', 'ぐらふぁな'), lw('grafana', 'ぐらふぁな')]);
    expect(added.map((w) => w.word)).toEqual(['Grafana']);
    expect(store.get().learnedWords).toHaveLength(1);
  });

  it('removes the old learned word and sets it to never learn when it is corrected to another word (G4-06)', () => {
    store.addLearnedWords([lw('Graphana', 'ぐらふぁな')]);
    store.addLearnedWords([lw('Grafana', 'Graphana')]);
    expect(store.get().learnedWords.map((w) => w.word)).toEqual(['Grafana']);
    expect(store.get().blockedLearnedWords).toEqual(['Graphana']);
  });

  it(`drops the oldest learned words beyond ${LEARNED_LIMIT}`, () => {
    const words = Array.from({ length: LEARNED_LIMIT + 1 }, (_, i) => lw(`Term${i}`, `たーむ${i}`, 1000 + i));
    store.addLearnedWords(words);
    const kept = store.get().learnedWords;
    expect(kept).toHaveLength(LEARNED_LIMIT);
    expect(kept.some((w) => w.word === 'Term0')).toBe(false);
  });

  it('never learns an undone word again', () => {
    store.addLearnedWords([lw('Grafana', 'ぐらふぁな')]);
    store.undoLearnedWord('Grafana');
    expect(store.addLearnedWords([lw('Grafana', 'ぐらふぁな')])).toEqual([]);
  });
});

describe('dictionary checks', () => {
  it(`leaves out words longer than ${WORD_MAX_LENGTH} characters`, () => {
    store.update({ dictionary: ['Grafana', 'x'.repeat(WORD_MAX_LENGTH + 1)] });
    expect(store.get().dictionary).toEqual(['Grafana']);
  });

  it('cleans up the readings of removed words', () => {
    store.update({ dictionary: ['Grafana', 'Datadog'], readings: { Grafana: ['グラファナ'], Datadog: ['データドッグ'] } });
    store.update({ dictionary: ['Datadog'] });
    expect(store.get().readings).toEqual({ Datadog: ['データドッグ'] });
  });
});

describe('ASR hints (G4-09)', () => {
  it('accepts the limit as a number (the older call style)', () => {
    store.update({ dictionary: ['Alpha', 'Bravo', 'Charlie'] });
    expect(store.asrHints(2)).toEqual(['Charlie', 'Bravo']);
  });

  it('puts words in the input field first', () => {
    store.update({ dictionary: ['Grafana', 'Datadog', 'Postgres'] });
    expect(store.asrHints({ limit: 1, context: { beforeCursor: 'Grafana の件' } })).toEqual(['Grafana']);
  });
});

describe('matching before formatting (G4-11)', () => {
  beforeEach(() => {
    store.update({ dictionary: ['Datadog'], suggestedReadings: { Datadog: ['データドッグ'] } });
    store.addLearnedWords([lw('Grafana', 'ぐらふぁな')]);
  });

  it('replaces only matches of confirmed readings (misrecognized forms the user corrected) when the LLM is not used', () => {
    const r = store.prepareFormatting('ぐらふぁなとでーたどっぐを見る', { useLlm: false });
    expect(r.text).toBe('Grafanaとでーたどっぐを見る');
    expect(r.replaced).toBe(1);
    expect(r.candidates).toEqual([]);
  });

  it('passes candidates instead of replacing when the LLM is used', () => {
    const r = store.prepareFormatting('ぐらふぁなとでーたどっぐを見る', { useLlm: true });
    expect(r.text).toBe('ぐらふぁなとでーたどっぐを見る');
    expect(r.candidates).toEqual([
      { heard: 'ぐらふぁな', word: 'Grafana' },
      { heard: 'でーたどっぐ', word: 'Datadog' },
    ]);
    expect(r.vocabulary).toEqual(expect.arrayContaining(['Grafana', 'Datadog']));
  });

  it('narrows the words for formatting to the limit and always includes words found by matching', () => {
    store.update({ dictionary: ['Datadog', ...Array.from({ length: 20 }, (_, i) => `Term${i}`)] });
    const r = store.prepareFormatting('でーたどっぐを見る', { useLlm: true, vocabularyLimit: 5 });
    expect(r.vocabulary).toHaveLength(5);
    expect(r.vocabulary[0]).toBe('Datadog');
  });
});

describe('generating reading candidates', () => {
  it('makes readings in a batch for Latin-letter dictionary words without readings', async () => {
    store.update({ dictionary: ['Grafana', '日鷹'] });
    const gen = vi.fn(async (words: string[]) => Object.fromEntries(words.map((w) => [w, ['グラファナ']])));
    store.setReadingGenerator(gen);
    expect(store.wordsNeedingReadings()).toEqual(['Grafana']);
    await store.generateReadingsNow();
    expect(gen).toHaveBeenCalledWith(['Grafana']);
    expect(store.get().suggestedReadings).toEqual({ Grafana: ['グラファナ'] });
    expect(store.wordsNeedingReadings()).toEqual([]);
  });

  it('does not retry words that failed until the next launch', async () => {
    store.update({ dictionary: ['Grafana'] });
    store.setReadingGenerator(async () => ({}));
    await store.generateReadingsNow();
    expect(store.wordsNeedingReadings()).toEqual([]);
  });
});

describe('migrating the case setting of replacements (G4-12)', () => {
  it('flips replacements saved with the old meaning exactly once', () => {
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

  it('orders the words for formatting as in the dictionary, whatever the matches and scores (to keep the system prompt unchanged)', () => {
    store.update({ dictionary: ['Alpha', 'Grafana', 'Zeta'], readings: { Grafana: ['ぐらふぁな'] } });
    store.addLearnedWords([lw('Datadog', 'でーたどっぐ', 5000)]);
    const plain = store.prepareFormatting('今日は晴れです', { useLlm: true }).vocabulary;
    const matched = store.prepareFormatting('ぐらふぁなを見てください', { useLlm: true, context: { beforeCursor: 'Zeta の件' } }).vocabulary;
    expect(plain).toEqual(['Alpha', 'Grafana', 'Zeta', 'Datadog']);
    expect(matched).toEqual(plain);
  });

  it('only marks a newly created store as migrated', () => {
    expect(store.get().replacementCaseMigrated).toBe(true);
  });
});
