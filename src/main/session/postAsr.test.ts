/**
 * postAsr（書き起こしの後の処理）のテスト。アプリと評価が同じ関数を通るので、ここで決まることを確かめる。
 * 保存先、LLM、単語分割は偽物を渡す。
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
      // 本物と同じく、LLM を使わないときだけ置き換え、使うときは候補を渡す
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
  it('LLM を使わないときは、読みの照合で置き換えた文を、補正と整形に渡す', () => {
    const c = fakeCustomizations({ replace: ['くばねてす', 'Kubernetes'] });
    const plan = planPostAsr(input({ rawText: 'くばねてすを使います', customizations: c }));
    expect(c.prepared).toEqual([{ raw: 'くばねてすを使います', opts: { useLlm: false, context: {}, recent: [] } }]);
    expect(plan.matchedText).toBe('Kubernetesを使います');
    expect(plan.format.rawText).toBe('Kubernetesを使います');
    expect(plan.format.provider).toBeNull();
    expect(plan.format.dictionaryCandidates).toEqual([]);
  });

  it('LLM を使うときは、文を置き換えずに、照合の候補を整形に渡す', () => {
    const provider = fakeProvider(() => '{}');
    const c = fakeCustomizations({ replace: ['くばねてす', 'Kubernetes'], candidates: [{ heard: 'くばねてす', word: 'Kubernetes' }] });
    const plan = planPostAsr(input({ rawText: 'くばねてすを使います', customizations: c, provider }));
    expect(c.prepared[0].opts.useLlm).toBe(true);
    expect(plan.matchedText).toBe('くばねてすを使います');
    expect(plan.format.dictionaryCandidates).toEqual([{ heard: 'くばねてす', word: 'Kubernetes' }]);
    expect(plan.format.provider).toBe(provider);
    expect(provider.calls).toEqual([]);
  });

  it('得点の文脈（入力先、最近の書き起こし、基準の時刻）を照合にそのまま渡す', () => {
    const c = fakeCustomizations();
    const recent = [{ text: '前の発話', timestamp: 1000 }];
    planPostAsr(input({ customizations: c, vocab: () => ({ context: { bundleId: 'com.example.notes' }, recent, now: 2000 }) }));
    expect(c.prepared[0].opts).toEqual({ useLlm: false, context: { bundleId: 'com.example.notes' }, recent, now: 2000 });
  });

  it('編集モードでは、照合も補正もしない。選択範囲を整形に渡す', () => {
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

  it('入力先の文脈は、設定で許したものだけを整形に渡す。パスワード欄の文字は渡さない', () => {
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

  it('ターミナルなら確実にコード向けにし、ほかは整形の推定に任せる', () => {
    const term = [...TERMINAL_BUNDLES][0];
    expect(planPostAsr(input({ ctx: context({ bundleId: term }) })).format.codeLike).toBe(true);
    expect(planPostAsr(input({ ctx: context() })).format.codeLike).toBeUndefined();
    expect(planPostAsr(input()).format.codeLike).toBeUndefined();
  });

  it('設定の項目（近道、時間切れ、出力の上限、言語）と、置換のきっかけ、指示を整形に渡す', () => {
    const c = fakeCustomizations({ replacements: ['署名'], instructions: '丁寧に' });
    const plan = planPostAsr(input({ customizations: c, settings: { ...SETTINGS, llmFastPath: false, llm: { timeoutMs: 60000, maxOutputTokens: 512 } } }));
    expect(plan.format).toMatchObject({ fastPath: false, timeoutMs: 60000, maxOutputTokens: 512, language: 'ja', protectedPhrases: ['署名'], customInstructions: '丁寧に' });
    expect(planPostAsr(input({ settings: { ...SETTINGS, language: 'auto' } })).format.language).toBe('auto');
  });

  it('語ごとの補正は、既定の規則（英字の綴り）で直し、直した文と直す前の文の両方を残す', () => {
    const plan = planPostAsr(input({ rawText: 'スラックで送ります' }));
    expect(plan.fix?.text).toBe('Slackで送ります');
    expect(plan.fix?.edits.map((e) => [e.rule, e.before, e.after])).toEqual([['latin', 'スラック', 'Slack']]);
    expect(plan.format.rawText).toBe('スラックで送ります');
    expect(plan.format.textFix).toBe(plan.fix);
  });

  it('語ごとの補正は、日本語以外、設定がオフ、止めた箇所では動かない', () => {
    expect(planPostAsr(input({ rawText: 'スラックで送ります', settings: { ...SETTINGS, language: 'en' } })).fix).toBeNull();
    expect(planPostAsr(input({ rawText: 'スラックで送ります', settings: { ...SETTINGS, textFix: { ...SETTINGS.textFix, enabled: false } } })).fix).toBeNull();
    const allOff = { ...SETTINGS.textFix, latin: false, particles: false };
    expect(planPostAsr(input({ rawText: 'スラックで送ります', settings: { ...SETTINGS, textFix: allOff } })).fix).toBeNull();
    const blocked = planPostAsr(input({ rawText: 'スラックで送ります', settings: { ...SETTINGS, textFix: { ...SETTINGS.textFix, blocked: ['latin:スラック'] } } }));
    expect(blocked.fix?.edits).toEqual([]);
  });

  it('辞書の語、置換のきっかけ、照合の候補の範囲は、補正で触らない', () => {
    const byDictionary = planPostAsr(input({ rawText: 'スラックで送ります', customizations: fakeCustomizations({ dictionary: ['スラック'] }) }));
    expect(byDictionary.fix?.edits).toEqual([]);
    const byReplacement = planPostAsr(input({ rawText: 'スラックで送ります', customizations: fakeCustomizations({ replacements: ['スラック'] }) }));
    expect(byReplacement.fix?.edits).toEqual([]);
    const byCandidate = planPostAsr(
      input({ rawText: 'スラックで送ります', provider: fakeProvider(() => '{}'), customizations: fakeCustomizations({ candidates: [{ heard: 'スラック', word: 'Slack' }] }) }),
    );
    expect(byCandidate.fix?.edits).toEqual([]);
  });

  it('単語分割が例外を出しても、補正は止まらない', () => {
    const plan = planPostAsr(
      input({
        rawText: 'スラックで送ります',
        tokenizer: () => {
          throw new Error('読み込みに失敗');
        },
      }),
    );
    expect(plan.fix?.text).toBe('Slackで送ります');
  });

  it('確信度の低い字があれば、近道に入れない印を付ける。確信度が無ければ付けない', () => {
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

  it('照合で文を置き換えたら、確信度を置き換えた後の文に対応付ける', () => {
    const raw = 'くばねてすを使います';
    const confidence = Array.from(raw, (_, i) => (i === 7 ? 0.2 : 0.9)); // 「い」が低い
    const plan = planPostAsr(input({ rawText: raw, confidence, customizations: fakeCustomizations({ replace: ['くばねてす', 'Kubernetes'] }) }));
    // 置き換えた部分は確信度なし。残りの字の最小値が取れる
    expect(plan.matchedText).toBe('Kubernetesを使います');
    expect(plan.minConfidence).toBeCloseTo(0.2);
  });

  it('記録するのは数だけで、本文は渡さない', () => {
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
  it('整形の前に onPlan を呼び、LLM の結果を返す', async () => {
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

  it('整った短い発話は近道に入り、LLM を呼ばない。近道がオフなら呼ぶ', async () => {
    const provider = fakeProvider(() => '{"text":"明日の会議は午後からです。"}');
    const fast = await postAsr(input({ rawText: '明日の会議は午後からです。', provider }));
    expect(fast.fmt).toMatchObject({ text: '明日の会議は午後からです。', fastPath: true, formatted: true });
    expect(provider.calls.length).toBe(0);
    await postAsr(input({ rawText: '明日の会議は午後からです。', provider, settings: { ...SETTINGS, llmFastPath: false } }));
    expect(provider.calls.length).toBe(1);
  });

  it('確信度の低い字がある発話は、近道に入れずに LLM に回す', async () => {
    const raw = '明日の会議は午後からです。';
    const provider = fakeProvider(() => `{"text":"${raw}"}`);
    const out = await postAsr(input({ rawText: raw, provider, confidence: Array.from(raw, (_, i) => (i === 6 ? 0.1 : 0.95)) }));
    expect(provider.calls.length).toBe(1);
    expect(out.fmt.fastPath).toBeUndefined();
  });

  it('LLM を使わないときは、補正した文を正規化して返す', async () => {
    const out = await postAsr(input({ rawText: 'スラック で送ります' }));
    expect(out.fmt).toMatchObject({ text: 'Slackで送ります', formatted: false, autoFixed: true });
  });

  it('LLM が失敗したら、例外にせずに、補正した文に落とす', async () => {
    const provider = fakeProvider(() => new Error('接続できませんでした'));
    const out = await postAsr(input({ rawText: 'スラックで送ります', provider }));
    expect(out.fmt).toMatchObject({ text: 'Slackで送ります', formatted: false, errorKind: 'network' });
    // LLM には直す前の文と、英字に直した語の候補を渡している
    const user = JSON.parse(provider.calls[0].user) as { raw_text: string; lexicon_candidates?: unknown };
    expect(user.raw_text).toBe('スラックで送ります');
    expect(user.lexicon_candidates).toEqual([{ heard: 'スラック', word: 'Slack' }]);
  });
});
