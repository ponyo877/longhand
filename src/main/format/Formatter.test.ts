import { describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest } from '../llm/types';
import { LlmError } from '../llm/types';
import { formatText, type FormatInput } from './Formatter';

/** A fake provider that records requests and returns prepared responses */
function fake(reply: string | ((req: LlmRequest) => string) | Error) {
  const calls: LlmRequest[] = [];
  const provider: LlmProvider = {
    kind: 'fake',
    async complete(req) {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === 'function' ? reply(req) : reply, model: 'fake-model', elapsedMs: 1 };
    },
  };
  return { provider, calls };
}

const base = (over: Partial<FormatInput>): FormatInput => ({
  mode: 'dictation',
  rawText: '',
  language: 'ja',
  context: {},
  vocabulary: [],
  customInstructions: '',
  provider: null,
  timeoutMs: 1000,
  maxOutputTokens: 1024,
  ...over,
});

describe('formatText (dictation)', () => {
  it('normalizes the LLM output too (spaces between Japanese and Latin text, half-width 「?」)', async () => {
    const f = fake('{"text": "Slack で 共有しましたか?"}');
    const r = await formatText(base({ rawText: 'すらっくで共有しましたか', provider: f.provider }));
    expect(r).toMatchObject({ text: 'Slackで共有しましたか？', formatted: true });
  });

  it('returns the normalized raw text without an LLM', async () => {
    const r = await formatText(base({ rawText: 'Notion に まとめました' }));
    expect(r).toMatchObject({ text: 'Notionにまとめました', formatted: false });
  });

  it('keeps spaces between Japanese and Latin text in a terminal (guessed from the app name, or set explicitly)', async () => {
    const f = fake('{"text": "mkdir 資料"}');
    expect((await formatText(base({ rawText: 'x', provider: f.provider, context: { appName: 'Terminal' } }))).text).toBe('mkdir 資料');
    expect((await formatText(base({ rawText: 'x', provider: f.provider, codeLike: true }))).text).toBe('mkdir 資料');
    expect((await formatText(base({ rawText: 'x', provider: f.provider, context: { appName: 'Slack' } }))).text).toBe('mkdir資料');
  });

  it('passes replacement triggers in the system prompt', async () => {
    const f = fake('{"text": "ほげです。"}');
    await formatText(base({ rawText: 'ほげです', provider: f.provider, protectedPhrases: ['ほげ'] }));
    expect(f.calls[0].system).toContain('# そのまま残す語句\n');
    expect(f.calls[0].system).toContain('- ほげ');
  });

  it('skips the fast path with past mix-up pairs, passing the pairs in the user message and what was learned in the system prompt', async () => {
    const f = fake('{"text": "資料を校正に回します。"}');
    const r = await formatText(
      base({
        rawText: '資料を公正に回します。',
        provider: f.provider,
        fastPath: true,
        pastCorrections: [{ heard: '公正', corrected: '校正' }],
        learned: { hasCorrections: true, kept: [{ phrase: 'なんか', changedTo: '何か' }] },
      }),
    );
    expect(r).toMatchObject({ text: '資料を校正に回します。', formatted: true });
    expect(r.fastPath).toBeUndefined();
    expect(JSON.parse(f.calls[0].user).past_corrections).toEqual([{ heard: '公正', corrected: '校正' }]);
    expect(f.calls[0].system).toContain('# 以前の手直し（past_corrections）');
    expect(f.calls[0].system).toContain('- なんか（「何か」にしない）');
  });

  it('passes disagreeing spots to the LLM only when the setting is on, and then skips the fast path and adds the explanation to the system prompt', async () => {
    const uncertain = [{ heard: '剣', alternatives: ['件'] }];
    const off = fake('{"text": "その剣は来週です。"}');
    const r0 = await formatText(base({ rawText: 'その剣は来週です。', provider: off.provider, fastPath: true, uncertain }));
    expect(r0.fastPath).toBe(true);
    expect(off.calls).toHaveLength(0);

    const on = fake('{"text": "その件は来週です。"}');
    const r1 = await formatText(base({ rawText: 'その剣は来週です。', provider: on.provider, fastPath: true, uncertain, useUncertain: true }));
    expect(r1).toMatchObject({ text: 'その件は来週です。', formatted: true });
    expect(r1.fastPath).toBeUndefined();
    expect(JSON.parse(on.calls[0].user).uncertain).toEqual([{ heard: '剣', alternatives: ['件'] }]);
    expect(on.calls[0].system).toContain('# 聞き違いかもしれない箇所（uncertain）');
  });

  it('passes dictionary word candidates in the user message and skips the fast path when there are any', async () => {
    const f = fake('{"text": "明日の会議は午後からです。"}');
    await formatText(base({ rawText: '明日の会議は午後からです。', provider: f.provider, fastPath: true, dictionaryCandidates: [{ heard: '会議', word: 'Kaigi' }] }));
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0].user).dictionary_candidates).toEqual([{ heard: '会議', word: 'Kaigi' }]);
  });

  it('finishes a short, clean utterance without calling the LLM when the fast path is on', async () => {
    const f = fake('{"text": "呼ばれないはず"}');
    const r = await formatText(base({ rawText: '明日の会議は午後からです。', provider: f.provider, fastPath: true }));
    expect(r).toMatchObject({ text: '明日の会議は午後からです。', formatted: true, fastPath: true, llmMs: 0 });
    expect(f.calls).toHaveLength(0);
  });

  it('uses the textfix output on the fast path and on LLM failure, and treats words turned into Latin letters as known words', async () => {
    const textFix = {
      text: '明日はSlackで連絡します。',
      edits: [{ rule: 'latin' as const, start: 3, end: 7, before: 'スラック', after: 'Slack' }],
      candidates: [],
    };
    const near = fake('{"text": "呼ばれないはず"}');
    const r = await formatText(base({ rawText: '明日はスラックで連絡します。', provider: near.provider, fastPath: true, textFix }));
    expect(r).toMatchObject({ text: '明日はSlackで連絡します。', fastPath: true, autoFixed: true });
    expect(near.calls).toHaveLength(0);

    const failed = fake(new LlmError('timeout', 'timed out'));
    const r2 = await formatText(base({ rawText: '明日はスラックで連絡します。', provider: failed.provider, textFix }));
    expect(r2).toMatchObject({ text: '明日はSlackで連絡します。', formatted: false, autoFixed: true });
    // The LLM gets the text before fixing
    expect(JSON.parse(failed.calls[0].user).raw_text).toBe('明日はスラックで連絡します。');
  });

  it('skips the fast path for an utterance with low-confidence characters, even when clean', async () => {
    const f = fake('{"text": "明日の会議は午後からです。"}');
    const r = await formatText(base({ rawText: '明日の会議は午後からです。', provider: f.provider, fastPath: true, lowConfidence: true }));
    expect(f.calls).toHaveLength(1);
    expect(r.fastPath).toBeUndefined();
  });

  it('skips the fast path with unfixed glossary candidates and passes them to the LLM', async () => {
    const f = fake('{"text": "ラインで送ります。"}');
    const r = await formatText(
      base({
        rawText: 'ラインで送ります。',
        provider: f.provider,
        fastPath: true,
        textFix: { text: 'ラインで送ります。', edits: [], candidates: [{ heard: 'ライン', word: 'LINE' }] },
      }),
    );
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0].user).lexicon_candidates).toEqual([{ heard: 'ライン', word: 'LINE' }]);
    expect(r.autoFixed).toBeUndefined();
  });

  it('sends an unclean utterance to the LLM even when the fast path is on', async () => {
    const f = fake('{"text": "明日行きます。"}');
    const r = await formatText(base({ rawText: 'えーと明日行きます', provider: f.provider, fastPath: true }));
    expect(f.calls).toHaveLength(1);
    expect(r.fastPath).toBeUndefined();
  });

  it('sends even a clean utterance to the LLM when the fast path is off', async () => {
    const f = fake('{"text": "明日の会議は午後からです。"}');
    await formatText(base({ rawText: '明日の会議は午後からです。', provider: f.provider }));
    expect(f.calls).toHaveLength(1);
  });

  it('sends an utterance of only 「うん」 to the LLM as content', async () => {
    const f = fake('{"text": "うん。"}');
    expect((await formatText(base({ rawText: 'うん', provider: f.provider }))).text).toBe('うん。');
  });

  it('falls back to the normalized raw text when the LLM fails', async () => {
    const f = fake(new LlmError('timeout', 'timed out'));
    const r = await formatText(base({ rawText: '資料 は Slack に 置きました', provider: f.provider }));
    expect(r).toMatchObject({ text: '資料はSlackに置きました', formatted: false, errorKind: 'timeout' });
  });
});

describe('formatText (edit mode)', () => {
  const edit = (reply: string) => formatText(base({ mode: 'edit', rawText: '直して', selectedText: '元の文', provider: fake(reply).provider }));

  it('treats empty text without a delete instruction as unclear (N5)', async () => {
    expect(await edit('{"text": "", "deleted": false, "unclear": false}')).toMatchObject({ text: '', unclear: true, deleted: false });
  });

  it('returns deleted for a delete instruction', async () => {
    expect(await edit('{"text": "", "deleted": true, "unclear": false}')).toMatchObject({ text: '', unclear: false, deleted: true });
  });

  it('empties the text when judged unclear, even if there is text', async () => {
    expect(await edit('{"text": "元の文", "deleted": false, "unclear": true}')).toMatchObject({ text: '', unclear: true });
  });

  it('returns the rewritten text as is (edit results are not normalized)', async () => {
    expect(await edit('{"text": "Slack で送る", "deleted": false, "unclear": false}')).toMatchObject({ text: 'Slack で送る', unclear: false });
  });
});

describe('formatText applies the learned number notation', () => {
  const learned = { numberStyle: { counters: { value: 'kanji', count: 1, at: 0 } } };

  it('without an LLM', async () => {
    const r = await formatText(base({ rawText: 'お願いが2つあります', learned }));
    expect(r.text).toBe('お願いが二つあります');
  });

  it('to the LLM output', async () => {
    const f = fake('{"text": "お願いが2つあります。"}');
    const r = await formatText(base({ rawText: 'お願いがふたつあります', provider: f.provider, learned }));
    expect(r.text).toBe('お願いが二つあります。');
    expect(f.calls[0].system).toContain('# 数字の書き方');
  });

  it('not in terminals and code editors', async () => {
    const r = await formatText(base({ rawText: 'お願いが2つあります', learned, codeLike: true }));
    expect(r.text).toBe('お願いが2つあります');
  });
});
