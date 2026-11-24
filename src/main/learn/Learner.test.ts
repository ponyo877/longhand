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

describe('heuristicAccept（LLM を使わないときの判定、G4-05）', () => {
  const r = (from: string, to: string) => ({ from, to, context: '' });

  it('かなで聞き取った語を、音の近い英字の語に直したものは採る', () => {
    expect(heuristicAccept(r('ぐらふぁな', 'Grafana'))).toBe(true);
    expect(heuristicAccept(r('でーたどっぐ', 'Datadog'))).toBe(true);
  });

  it('形に意味がある英字の語の大文字小文字の直しは採る', () => {
    expect(heuristicAccept(r('iphone', 'iPhone'))).toBe(true);
  });

  it('音の違う言い換えは採らない', () => {
    expect(heuristicAccept(r('打ち合わせ', 'ミーティング'))).toBe(false);
    expect(heuristicAccept(r('うちあわせ', 'ミーティング'))).toBe(false);
  });

  it('漢字の語は読みが分からないので採らない', () => {
    expect(heuristicAccept(r('日高', '日鷹'))).toBe(false);
  });

  it('漢字で聞き取られた語を英字に直したものも採らない', () => {
    expect(heuristicAccept(r('公正', 'Grafana'))).toBe(false);
  });
});

describe('learnFromWatch', () => {
  const base = { before: '', afterPaste: 'ぐらふぁなを見てください。', final: 'Grafanaを見てください。' };

  it('LLM なしでも、音の近い直しから語を学習する', async () => {
    const words = await learnFromWatch(watch(base), ctx({ inserted: base.afterPaste }));
    expect(words.map((w) => [w.from, w.word])).toEqual([['ぐらふぁな', 'Grafana']]);
  });

  it('利用者がキーを押していなければ学習しない（G4-03）', async () => {
    const r = await learnFromWatchDetailed(watch({ ...base, keystrokes: 0 }), ctx());
    expect(r.words).toEqual([]);
    expect(r.skipped).toBe('no_keystrokes');
  });

  it('入力欄を読めなかったときは学習しない', async () => {
    const r = await learnFromWatchDetailed(watch({ ...base, reason: 'unreadable' } as never), ctx());
    expect(r.skipped).toBe('unreadable');
  });

  it('打ち始める前の読み取りを基準にして、アプリによる変化を除く（G4-03）', async () => {
    // 貼り付けの後にアプリが末尾に署名を足し、そのあと利用者が語を直した
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

  it('送信で欄が空になったら、送信直前の読み取りから学習する（G4-01）', async () => {
    const r = await learnFromWatchDetailed(watch({ ...base, final: '', preSend: 'Grafanaを見てください。', reason: 'sent', keystrokes: 3 } as never), ctx({ inserted: base.afterPaste }));
    expect(r.words.map((w) => w.word)).toEqual(['Grafana']);
  });

  it('貼り付けた範囲が消えて送信直前の読み取りもなければ学習しない', async () => {
    const r = await learnFromWatchDetailed(watch({ ...base, final: '' }), ctx({ inserted: base.afterPaste }));
    expect(r.skipped).toBe('removed');
  });

  it(`1 回の手直しで ${MAX_WORDS_PER_EDIT} 語を超える置き換えがあれば、何も学習しない（G4-16）`, async () => {
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

  it('辞書にある語と、学習しない語は候補から除く', async () => {
    expect(await learnFromWatch(watch(base), ctx({ vocabulary: ['grafana'] }))).toEqual([]);
    expect(await learnFromWatch(watch(base), ctx({ blocked: ['Grafana'] }))).toEqual([]);
  });

  it('LLM があれば、LLM が登録すべきとした語だけを学習する', async () => {
    const p = provider(() => ({ words: [{ word: 'Grafana', add: true }] }));
    const words = await learnFromWatch(watch(base), ctx({ provider: p }));
    expect(words.map((w) => w.word)).toEqual(['Grafana']);
    const p2 = provider(() => ({ words: [{ word: 'Grafana', add: false }] }));
    expect(await learnFromWatch(watch(base), ctx({ provider: p2 }))).toEqual([]);
  });

  it('LLM が失敗したら規則で判定する', async () => {
    const p = { complete: vi.fn(async () => Promise.reject(new Error('timeout'))) } as unknown as LlmProvider;
    const words = await learnFromWatch(watch(base), ctx({ provider: p }));
    expect(words.map((w) => w.word)).toEqual(['Grafana']);
  });

  it('同じ直しが 2 か所あっても、学習する語は 1 つ', async () => {
    const words = await learnFromWatch(watch({ before: '', afterPaste: 'ぐらふぁなとぐらふぁなの設定', final: 'GrafanaとGrafanaの設定' }), ctx());
    expect(words.map((w) => w.word)).toEqual(['Grafana']);
  });
});

describe('learnFromEdit（履歴の画面での手直し、G4-08）', () => {
  it('履歴の文を直したときも、同じ規則で学習する', async () => {
    const r = await learnFromEdit('でーたどっぐで共有します', 'Datadogで共有します', ctx());
    expect(r.words.map((w) => [w.from, w.word])).toEqual([['でーたどっぐ', 'Datadog']]);
  });
});
