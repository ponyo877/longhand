import { describe, expect, it, vi } from 'vitest';
import type { FieldWatchResultPayload } from '../../shared/protocol';
import type { LlmProvider } from '../llm/types';
import { heuristicAccept, learnFromEdit, learnFromWatch, learnFromWatchDetailed, MAX_WORDS_PER_EDIT, type LearnContext } from './Learner';

function watch(p: Partial<FieldWatchResultPayload> & Record<string, unknown>): FieldWatchResultPayload {
  return { pasteId: 'p1', before: '', afterPaste: '', final: '', reason: 'timeout', ...p } as FieldWatchResultPayload;
}

function ctx(over: Partial<LearnContext> = {}): LearnContext {
  return { inserted: '', vocabulary: [], blocked: [], provider: null, timeoutMs: 1000, ...over };
}

function provider(answer: (user: string) => unknown): LlmProvider {
  return {
    complete: vi.fn(async (req: { user: string }) => ({ text: JSON.stringify(answer(req.user)), model: 'test', elapsedMs: 1 })),
  } as unknown as LlmProvider;
}

describe('heuristicAccept (judgment without the LLM, G4-05)', () => {
  const r = (from: string, to: string) => ({ from, to, context: '' });

  it('accepts a word heard as kana corrected into a Latin word that sounds alike', () => {
    expect(heuristicAccept(r('ぐらふぁな', 'Grafana'))).toBe(true);
    expect(heuristicAccept(r('でーたどっぐ', 'Datadog'))).toBe(true);
  });

  it('accepts a case fix to a Latin word whose case carries meaning', () => {
    expect(heuristicAccept(r('iphone', 'iPhone'))).toBe(true);
  });

  it('rejects a rewording that sounds different', () => {
    expect(heuristicAccept(r('打ち合わせ', 'ミーティング'))).toBe(false);
    expect(heuristicAccept(r('うちあわせ', 'ミーティング'))).toBe(false);
  });

  it('rejects kanji words because their reading is unknown', () => {
    expect(heuristicAccept(r('日高', '日鷹'))).toBe(false);
  });

  it('also rejects a word heard as kanji corrected into Latin letters', () => {
    expect(heuristicAccept(r('公正', 'Grafana'))).toBe(false);
  });
});

describe('learnFromWatch', () => {
  const base = { before: '', afterPaste: 'ぐらふぁなを見てください。', final: 'Grafanaを見てください。' };

  it('learns words from corrections that sound alike, even without the LLM', async () => {
    const words = await learnFromWatch(watch(base), ctx({ inserted: base.afterPaste }));
    expect(words.map((w) => [w.from, w.word])).toEqual([['ぐらふぁな', 'Grafana']]);
  });

  it('learns nothing when the user pressed no keys (G4-03)', async () => {
    const r = await learnFromWatchDetailed(watch({ ...base, keystrokes: 0 }), ctx());
    expect(r.words).toEqual([]);
    expect(r.skipped).toBe('no_keystrokes');
  });

  it('learns nothing when the field could not be read', async () => {
    const r = await learnFromWatchDetailed(watch({ ...base, reason: 'unreadable' } as never), ctx());
    expect(r.skipped).toBe('unreadable');
  });

  it('uses the reading from before typing started as the reference, excluding changes made by the app (G4-03)', async () => {
    // After the paste, the app appended a signature, and then the user corrected a word
    const r = await learnFromWatchDetailed(
      watch({
        before: '',
        afterPaste: 'ぐらふぁなを見てください。',
        baseline: 'ぐらふぁなを見てください。\n-- 署名',
        final: 'Grafanaを見てください。\n-- 署名',
        keystrokes: 4,
      }),
      ctx({ inserted: 'ぐらふぁなを見てください。' }),
    );
    expect(r.words.map((w) => w.word)).toEqual(['Grafana']);
  });

  it('learns from the reading right before sending when sending empties the field (G4-01)', async () => {
    const r = await learnFromWatchDetailed(watch({ ...base, final: '', preSend: 'Grafanaを見てください。', reason: 'sent', keystrokes: 3 } as never), ctx({ inserted: base.afterPaste }));
    expect(r.words.map((w) => w.word)).toEqual(['Grafana']);
  });

  it('learns nothing when the pasted range is gone and there is no reading from before sending', async () => {
    const r = await learnFromWatchDetailed(watch({ ...base, final: '' }), ctx({ inserted: base.afterPaste }));
    expect(r.skipped).toBe('removed');
  });

  it(`learns nothing when one correction replaces more than ${MAX_WORDS_PER_EDIT} words (G4-16)`, async () => {
    const r = await learnFromWatchDetailed(
      watch({
        before: '',
        afterPaste: '明日はぐらふぁなの画面とでーたどっぐの通知、ぽすぐれすの設定、あいふぉーんでの表示を順番に確かめてから、午後の会議で結果をまとめて報告します。',
        final: '明日はGrafanaの画面とDatadogの通知、Postgresの設定、iPhoneでの表示を順番に確かめてから、午後の会議で結果をまとめて報告します。',
      }),
      ctx(),
    );
    expect(r.words).toEqual([]);
    expect(r.skipped).toBe('too_many');
  });

  it('leaves dictionary words and words not to learn out of the candidates', async () => {
    expect(await learnFromWatch(watch(base), ctx({ vocabulary: ['grafana'] }))).toEqual([]);
    expect(await learnFromWatch(watch(base), ctx({ blocked: ['Grafana'] }))).toEqual([]);
  });

  it('learns only the words the LLM says to add when an LLM is available', async () => {
    const p = provider(() => ({ words: [{ word: 'Grafana', add: true }] }));
    const words = await learnFromWatch(watch(base), ctx({ provider: p }));
    expect(words.map((w) => w.word)).toEqual(['Grafana']);
    const p2 = provider(() => ({ words: [{ word: 'Grafana', add: false }] }));
    expect(await learnFromWatch(watch(base), ctx({ provider: p2 }))).toEqual([]);
  });

  it('judges with the rules when the LLM fails', async () => {
    const p = { complete: vi.fn(async () => Promise.reject(new Error('timeout'))) } as unknown as LlmProvider;
    const words = await learnFromWatch(watch(base), ctx({ provider: p }));
    expect(words.map((w) => w.word)).toEqual(['Grafana']);
  });

  it('learns one word when the same fix appears twice', async () => {
    const words = await learnFromWatch(watch({ before: '', afterPaste: 'ぐらふぁなとぐらふぁなの設定', final: 'GrafanaとGrafanaの設定' }), ctx());
    expect(words.map((w) => w.word)).toEqual(['Grafana']);
  });
});

describe('learnFromEdit (corrections in the history page, G4-08)', () => {
  it('learns with the same rules when a history item is corrected', async () => {
    const r = await learnFromEdit('でーたどっぐで共有します', 'Datadogで共有します', ctx());
    expect(r.words.map((w) => [w.from, w.word])).toEqual([['でーたどっぐ', 'Datadog']]);
  });
});
