/**
 * Tests for postAsr (processing after transcription). The app and the evaluation run through the same function, so this checks what it decides.
 * The stores, the LLM and the tokenizer are fakes.
 */
import { describe, expect, it } from 'vitest';
import type { ContextPayload } from '../../shared/protocol';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { LlmProvider, LlmRequest } from '../llm/types';
import type { PrepareOptions } from '../store/customizations';
import { planPostAsr, postAsr, TERMINAL_BUNDLES, type PostAsrInput, type PostAsrSettings } from './postAsr';

const SETTINGS: PostAsrSettings = {
  language: 'ja',
  sendAppContext: true,
  sendFieldContext: true,
  llmFastPath: true,
  textFix: { ...DEFAULT_SETTINGS.textFix },
  llm: { timeoutMs: 8000, maxOutputTokens: 2048 },
};

function fakeCustomizations(over: { replace?: [string, string]; candidates?: { heard: string; word: string }[]; replacements?: string[]; dictionary?: string[]; instructions?: string } = {}) {
  const prepared: { raw: string; opts: PrepareOptions }[] = [];
  const dictionary = over.dictionary ?? [];
  return {
    prepared,
    get: () => ({ replacements: (over.replacements ?? []).map((from) => ({ from, to: '置換先', preserveCase: true })), customInstructions: over.instructions ?? '' }),
    vocabulary: () => dictionary,
    prepareFormatting: (raw: string, opts: PrepareOptions) => {
      prepared.push({ raw, opts });
      // Like the real one, replace only when the LLM is not used, and pass candidates when it is
      if (!opts.useLlm && over.replace) return { text: raw.replace(over.replace[0], over.replace[1]), vocabulary: dictionary, candidates: [], replaced: 1 };
      return { text: raw, vocabulary: dictionary, candidates: opts.useLlm ? (over.candidates ?? []) : [], replaced: 0 };
    },
  };
}

function fakeProvider(reply: (req: LlmRequest) => string | Error): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    kind: 'fake',
    calls,
    async complete(req) {
      calls.push(req);
      const r = reply(req);
      if (r instanceof Error) throw r;
      return { text: r, model: 'fake', elapsedMs: 1 };
    },
  };
}

function context(over: { bundleId?: string; name?: string; secure?: boolean; before?: string; after?: string; selected?: string } = {}): ContextPayload {
  return {
    app: { name: over.name ?? 'メモ', bundleId: over.bundleId ?? 'com.example.notes', pid: 1 },
    host: 'docs.example.test',
    field: {
      role: 'AXTextArea',
      subrole: '',
      description: '本文',
      isSecure: over.secure ?? false,
      editable: true,
      beforeCursor: over.before ?? '前の文。',
      afterCursor: over.after ?? '',
      selectedText: over.selected ?? '',
      totalLength: 4,
    },
    canPaste: 'yes',
    elapsedMs: 1,
  } as unknown as ContextPayload;
}

function input(over: Partial<PostAsrInput> = {}): PostAsrInput {
  return {
    mode: 'dictation',
    rawText: '明日の会議は午後からです',
    settings: SETTINGS,
    customizations: fakeCustomizations(),
    ctx: null,
    vocab: () => ({ context: {}, recent: [] }),
    provider: null,
    ...over,
  };
}

describe('planPostAsr', () => {
  it('passes the text replaced by reading matches to the fixes and formatting when the LLM is not used', () => {
    const c = fakeCustomizations({ replace: ['くばねてす', 'Kubernetes'] });
    const plan = planPostAsr(input({ rawText: 'くばねてすを使います', customizations: c }));
    expect(c.prepared).toEqual([{ raw: 'くばねてすを使います', opts: { useLlm: false, context: {}, recent: [] } }]);
    expect(plan.matchedText).toBe('Kubernetesを使います');
    expect(plan.format.rawText).toBe('Kubernetesを使います');
    expect(plan.format.provider).toBeNull();
    expect(plan.format.dictionaryCandidates).toEqual([]);
  });

  it('passes match candidates to formatting without replacing the text when the LLM is used', () => {
    const provider = fakeProvider(() => '{}');
    const c = fakeCustomizations({ replace: ['くばねてす', 'Kubernetes'], candidates: [{ heard: 'くばねてす', word: 'Kubernetes' }] });
    const plan = planPostAsr(input({ rawText: 'くばねてすを使います', customizations: c, provider }));
    expect(c.prepared[0].opts.useLlm).toBe(true);
    expect(plan.matchedText).toBe('くばねてすを使います');
    expect(plan.format.dictionaryCandidates).toEqual([{ heard: 'くばねてす', word: 'Kubernetes' }]);
    expect(plan.format.provider).toBe(provider);
    expect(provider.calls).toEqual([]);
  });

  it('passes the scoring context (input target, recent transcripts, reference time) to matching as it is', () => {
    const c = fakeCustomizations();
    const recent = [{ text: '前の発話', timestamp: 1000 }];
    planPostAsr(input({ customizations: c, vocab: () => ({ context: { bundleId: 'com.example.notes' }, recent, now: 2000 }) }));
    expect(c.prepared[0].opts).toEqual({ useLlm: false, context: { bundleId: 'com.example.notes' }, recent, now: 2000 });
  });

  it('skips matching and fixes in edit mode, and passes the selection to formatting', () => {
    const c = fakeCustomizations({ dictionary: ['Longhand'] });
    let vocabCalls = 0;
    const plan = planPostAsr(
      input({
        mode: 'edit',
        rawText: 'スラックを太字にして',
        customizations: c,
        ctx: context({ selected: '選んだ文' }),
        vocab: () => {
          vocabCalls++;
          return { context: {}, recent: [] };
        },
        confidence: Array.from({ length: 10 }, () => 0.1),
      }),
    );
    expect(c.prepared).toEqual([]);
    expect(vocabCalls).toBe(0);
    expect(plan.prep).toBeNull();
    expect(plan.fix).toBeNull();
    expect(plan.minConfidence).toBeNull();
    expect(plan.format).toMatchObject({ mode: 'edit', rawText: 'スラックを太字にして', selectedText: '選んだ文', vocabulary: ['Longhand'], textFix: undefined, lowConfidence: undefined });
  });

  it('passes only the input target context the settings allow, and never text from password fields', () => {
    const all = planPostAsr(input({ ctx: context({ before: '前の文。', after: '後ろ' }) }));
    expect(all.format.context).toEqual({ appName: 'メモ', host: 'docs.example.test', field: '本文', beforeCursor: '前の文。', afterCursor: '後ろ' });
    const noApp = planPostAsr(input({ ctx: context(), settings: { ...SETTINGS, sendAppContext: false } }));
    expect(noApp.format.context).toEqual({ beforeCursor: '前の文。', afterCursor: '' });
    const noField = planPostAsr(input({ ctx: context(), settings: { ...SETTINGS, sendFieldContext: false } }));
    expect(noField.format.context).toEqual({ appName: 'メモ', host: 'docs.example.test', field: '本文' });
    const secure = planPostAsr(input({ ctx: context({ secure: true }) }));
    expect(secure.format.context.beforeCursor).toBeUndefined();
    expect(planPostAsr(input()).format.context).toEqual({});
  });

  it('always formats for code in a terminal, and leaves other apps to the formatter’s guess', () => {
    const term = [...TERMINAL_BUNDLES][0];
    expect(planPostAsr(input({ ctx: context({ bundleId: term }) })).format.codeLike).toBe(true);
    expect(planPostAsr(input({ ctx: context() })).format.codeLike).toBeUndefined();
    expect(planPostAsr(input()).format.codeLike).toBeUndefined();
  });

  it('passes the settings (fast path, timeout, output limit, language), replacement triggers and instructions to formatting', () => {
    const c = fakeCustomizations({ replacements: ['署名'], instructions: '丁寧に' });
    const plan = planPostAsr(input({ customizations: c, settings: { ...SETTINGS, llmFastPath: false, llm: { timeoutMs: 60000, maxOutputTokens: 512 } } }));
    expect(plan.format).toMatchObject({ fastPath: false, timeoutMs: 60000, maxOutputTokens: 512, language: 'ja', protectedPhrases: ['署名'], customInstructions: '丁寧に' });
    expect(planPostAsr(input({ settings: { ...SETTINGS, language: 'auto' } })).format.language).toBe('auto');
  });

  it('fixes words with the default rule (Latin spelling) and keeps both the fixed and the original text', () => {
    const plan = planPostAsr(input({ rawText: 'スラックで送ります' }));
    expect(plan.fix?.text).toBe('Slackで送ります');
    expect(plan.fix?.edits.map((e) => [e.rule, e.before, e.after])).toEqual([['latin', 'スラック', 'Slack']]);
    expect(plan.format.rawText).toBe('スラックで送ります');
    expect(plan.format.textFix).toBe(plan.fix);
  });

  it('does not fix words for other languages, when the setting is off, or at blocked spots', () => {
    expect(planPostAsr(input({ rawText: 'スラックで送ります', settings: { ...SETTINGS, language: 'en' } })).fix).toBeNull();
    expect(planPostAsr(input({ rawText: 'スラックで送ります', settings: { ...SETTINGS, textFix: { ...SETTINGS.textFix, enabled: false } } })).fix).toBeNull();
    const allOff = { ...SETTINGS.textFix, latin: false, particles: false };
    expect(planPostAsr(input({ rawText: 'スラックで送ります', settings: { ...SETTINGS, textFix: allOff } })).fix).toBeNull();
    const blocked = planPostAsr(input({ rawText: 'スラックで送ります', settings: { ...SETTINGS, textFix: { ...SETTINGS.textFix, blocked: ['latin:スラック'] } } }));
    expect(blocked.fix?.edits).toEqual([]);
  });

  it('leaves dictionary words, replacement triggers and match candidates alone', () => {
    const byDictionary = planPostAsr(input({ rawText: 'スラックで送ります', customizations: fakeCustomizations({ dictionary: ['スラック'] }) }));
    expect(byDictionary.fix?.edits).toEqual([]);
    const byReplacement = planPostAsr(input({ rawText: 'スラックで送ります', customizations: fakeCustomizations({ replacements: ['スラック'] }) }));
    expect(byReplacement.fix?.edits).toEqual([]);
    const byCandidate = planPostAsr(
      input({ rawText: 'スラックで送ります', provider: fakeProvider(() => '{}'), customizations: fakeCustomizations({ candidates: [{ heard: 'スラック', word: 'Slack' }] }) }),
    );
    expect(byCandidate.fix?.edits).toEqual([]);
  });

  it('keeps fixing words when the tokenizer throws', () => {
    const plan = planPostAsr(
      input({
        rawText: 'スラックで送ります',
        tokenizer: () => {
          throw new Error('failed to load');
        },
      }),
    );
    expect(plan.fix?.text).toBe('Slackで送ります');
  });

  it('marks low-confidence utterances to skip the fast path, and leaves utterances without confidence unmarked', () => {
    const raw = '明日の会議は午後からです';
    const conf = (p: number) => Array.from(raw, (_, i) => (i === 6 ? p : 0.95));
    const low = planPostAsr(input({ rawText: raw, confidence: conf(0.1) }));
    expect(low.minConfidence).toBeCloseTo(0.1);
    expect(low.lowConfidence).toBe(true);
    expect(low.format.lowConfidence).toBe(true);
    const high = planPostAsr(input({ rawText: raw, confidence: conf(0.5) }));
    expect(high.minConfidence).toBeCloseTo(0.5);
    expect(high.lowConfidence).toBe(false);
    expect(high.format.lowConfidence).toBeUndefined();
    const none = planPostAsr(input({ rawText: raw }));
    expect(none.minConfidence).toBeNull();
    expect(none.lowConfidence).toBe(false);
  });

  it('maps confidence onto the text after replacement when matching replaced it', () => {
    const raw = 'くばねてすを使います';
    const confidence = Array.from(raw, (_, i) => (i === 7 ? 0.2 : 0.9)); // 「い」 is low
    const plan = planPostAsr(input({ rawText: raw, confidence, customizations: fakeCustomizations({ replace: ['くばねてす', 'Kubernetes'] }) }));
    // The replaced part has no confidence. The minimum comes from the remaining characters
    expect(plan.matchedText).toBe('Kubernetesを使います');
    expect(plan.minConfidence).toBeCloseTo(0.2);
  });

  it('logs counts only, never the text', () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
    const raw = 'スラックで送ります';
    planPostAsr(input({ rawText: raw, log, provider: fakeProvider(() => '{}'), confidence: Array.from(raw, () => 0.1) }));
    expect(lines.length).toBe(2);
    expect(lines.join('\n')).not.toContain('スラック');
    expect(lines.join('\n')).not.toContain('送ります');
  });
});

describe('postAsr', () => {
  it('calls onPlan before formatting and returns the LLM result', async () => {
    const order: string[] = [];
    const provider = fakeProvider(() => {
      order.push('llm');
      return '{"text":"明日の会議は午後からです。"}';
    });
    const out = await postAsr(input({ provider, onPlan: () => order.push('plan') }));
    expect(order).toEqual(['plan', 'llm']);
    expect(out.fmt).toMatchObject({ text: '明日の会議は午後からです。', formatted: true });
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].timeoutMs).toBe(8000);
  });

  it('takes the fast path for a short clean utterance without calling the LLM, and calls it when the fast path is off', async () => {
    const provider = fakeProvider(() => '{"text":"明日の会議は午後からです。"}');
    const fast = await postAsr(input({ rawText: '明日の会議は午後からです。', provider }));
    expect(fast.fmt).toMatchObject({ text: '明日の会議は午後からです。', fastPath: true, formatted: true });
    expect(provider.calls.length).toBe(0);
    await postAsr(input({ rawText: '明日の会議は午後からです。', provider, settings: { ...SETTINGS, llmFastPath: false } }));
    expect(provider.calls.length).toBe(1);
  });

  it('sends an utterance with low-confidence characters to the LLM instead of the fast path', async () => {
    const raw = '明日の会議は午後からです。';
    const provider = fakeProvider(() => `{"text":"${raw}"}`);
    const out = await postAsr(input({ rawText: raw, provider, confidence: Array.from(raw, (_, i) => (i === 6 ? 0.1 : 0.95)) }));
    expect(provider.calls.length).toBe(1);
    expect(out.fmt.fastPath).toBeUndefined();
  });

  it('returns the fixed text normalized when the LLM is not used', async () => {
    const out = await postAsr(input({ rawText: 'スラック で送ります' }));
    expect(out.fmt).toMatchObject({ text: 'Slackで送ります', formatted: false, autoFixed: true });
  });

  it('falls back to the fixed text without throwing when the LLM fails', async () => {
    const provider = fakeProvider(() => new Error('could not connect'));
    const out = await postAsr(input({ rawText: 'スラックで送ります', provider }));
    expect(out.fmt).toMatchObject({ text: 'Slackで送ります', formatted: false, errorKind: 'network' });
    // The LLM got the text before the fixes and the candidates for words fixed to Latin letters
    const user = JSON.parse(provider.calls[0].user) as { raw_text: string; lexicon_candidates?: unknown };
    expect(user.raw_text).toBe('スラックで送ります');
    expect(user.lexicon_candidates).toEqual([{ heard: 'スラック', word: 'Slack' }]);
  });
});
