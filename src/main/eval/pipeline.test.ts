import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { TranscribeOptions } from '../asr/AsrService';
import type { LlmProvider, LlmRequest } from '../llm/types';
import type { PrepareOptions } from '../store/customizations';
import type { PostAsrSettings } from '../session/postAsr';
import { postAsrStages, transcribeLikeApp, type AppAsrOptions, type Transcriber } from './pipeline';

const SR = 16000;

/** 発話の代わりに、振幅の揺れる正弦波を使う */
function speech(sec: number, amp = 0.1): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / SR));
  return out;
}

function silence(sec: number, noise = 0.0005): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  let x = 1;
  for (let i = 0; i < out.length; i++) {
    x = (x * 16807) % 2147483647;
    out[i] = noise * ((x / 2147483647) * 2 - 1);
  }
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function fakeAsr(texts: string[]) {
  const calls: { seconds: number; opts: TranscribeOptions }[] = [];
  const asr: Transcriber = {
    async transcribe(samples, opts) {
      calls.push({ seconds: samples.length / SR, opts });
      return { text: texts[calls.length - 1] ?? '', elapsedMs: 1, tokens: [['字', 0.9]], hintsUsed: 1, hintsGiven: 2 };
    },
  };
  return { asr, calls };
}

const OPTS: AppAsrOptions = { language: 'ja', hints: ['Longhand'], incremental: true, minRecordingMs: 300, silenceDetection: true };

describe('transcribeLikeApp', () => {
  it('28 秒以下の録音は、丸ごと 1 回で書き起こす。prompt は渡さない', async () => {
    const { asr, calls } = fakeAsr(['  今日は晴れです  ']);
    const out = await transcribeLikeApp(asr, speech(3), OPTS);
    expect(calls.length).toBe(1);
    expect(calls[0].seconds).toBe(3);
    expect(calls[0].opts).toMatchObject({ language: 'ja', hints: ['Longhand'], prompt: undefined });
    expect(out).toMatchObject({ text: '今日は晴れです', segments: 1, tokens: [['字', 0.9]], hintsUsed: 1, hintsGiven: 2 });
    expect(out.skipped).toBeUndefined();
  });

  it('途中に区切りがあっても、28 秒以下なら丸ごと書き起こす', async () => {
    const { asr, calls } = fakeAsr(['丸ごと']);
    const out = await transcribeLikeApp(asr, concat([speech(21), silence(1), speech(3)]), OPTS);
    expect(calls.length).toBe(1);
    expect(calls[0].seconds).toBe(25);
    expect(out.segments).toBe(1);
  });

  it('28 秒を超える録音は、話の切れ目で区切って順に書き起こし、前の区切りの末尾を prompt に渡す', async () => {
    const first = 'あ'.repeat(250);
    const { asr, calls } = fakeAsr([first, '続きです']);
    const out = await transcribeLikeApp(asr, concat([speech(22), silence(1), speech(10)]), OPTS);
    expect(calls.length).toBe(2);
    expect(calls[0].seconds).toBeGreaterThanOrEqual(22);
    expect(calls[0].seconds).toBeLessThan(23);
    expect(calls[0].opts.prompt).toBeUndefined();
    expect(calls[1].opts.prompt).toBe('あ'.repeat(200));
    expect(calls[0].seconds + calls[1].seconds).toBeCloseTo(33, 5);
    expect(out.text).toBe(`${first}続きです`);
    expect(out.segments).toBe(2);
    // 区切って書き起こしたときは、確信度を持たない（アプリと同じ）
    expect(out.tokens).toBeUndefined();
  });

  it('区切りを使わない設定なら、長い録音も丸ごと書き起こす', async () => {
    const { asr, calls } = fakeAsr(['丸ごと']);
    await transcribeLikeApp(asr, concat([speech(22), silence(1), speech(10)]), { ...OPTS, incremental: false });
    expect(calls.length).toBe(1);
    expect(calls[0].seconds).toBe(33);
  });

  it('短すぎる録音、音の無い録音、話していない録音は書き起こさない', async () => {
    const { asr, calls } = fakeAsr(['出ないはず']);
    expect(await transcribeLikeApp(asr, speech(0.2), OPTS)).toMatchObject({ text: '', segments: 0, skipped: 'too-short' });
    expect(await transcribeLikeApp(asr, new Float32Array(2 * SR), OPTS)).toMatchObject({ text: '', skipped: 'silent' });
    // ワーカーが声の検出を持たないエンジンでは、音の大きさで捨てる
    expect(await transcribeLikeApp(asr, silence(2, 0.002), { ...OPTS, engine: 'apple' })).toMatchObject({ text: '', skipped: 'no-speech' });
    expect(calls.length).toBe(0);
    // 無音の判定をオフにすると、書き起こす
    await transcribeLikeApp(asr, silence(2, 0.002), { ...OPTS, engine: 'apple', silenceDetection: false });
    expect(calls.length).toBe(1);
  });

  it('whisper では、小さな音の録音を捨てずにワーカーに渡す（声の小さい録音を無音と取り違えないため。声の有無はワーカーが決める）', async () => {
    const { asr, calls } = fakeAsr(['']);
    const out = await transcribeLikeApp(asr, silence(2, 0.002), OPTS);
    expect(calls.length).toBe(1);
    expect(out).toMatchObject({ text: '', segments: 1 });
    expect(out.skipped).toBeUndefined();
  });

  it('実験用の prompt を渡せる', async () => {
    const { asr, calls } = fakeAsr(['文']);
    await transcribeLikeApp(asr, speech(2), { ...OPTS, prompt: '直前の文' });
    expect(calls[0].opts.prompt).toBe('直前の文');
  });
});

describe('postAsrStages', () => {
  const settings: PostAsrSettings = {
    language: 'ja',
    sendAppContext: true,
    sendFieldContext: true,
    llmFastPath: true,
    textFix: { ...DEFAULT_SETTINGS.textFix },
    llm: { timeoutMs: 60000, maxOutputTokens: 2048 },
  };
  const customizations = {
    get: () => ({ replacements: [], customInstructions: '' }),
    vocabulary: () => ['Kubernetes'],
    prepareFormatting: (raw: string, opts: PrepareOptions) =>
      opts.useLlm
        ? { text: raw, vocabulary: ['Kubernetes'], candidates: [{ heard: 'くばねてす', word: 'Kubernetes' }], replaced: 0 }
        : { text: raw.replace('くばねてす', 'Kubernetes'), vocabulary: ['Kubernetes'], candidates: [], replaced: 1 },
  };
  const vocab = () => ({ context: {}, recent: [] });

  function fakeProvider(text: string): LlmProvider & { calls: LlmRequest[] } {
    const calls: LlmRequest[] = [];
    return {
      kind: 'fake',
      calls,
      async complete(req) {
        calls.push(req);
        return { text: JSON.stringify({ text }), model: 'fake', elapsedMs: 1 };
      },
    };
  }

  it('段階ごとの文を返す。LLM を使わない経路では照合で置き換え、使う経路では候補を LLM に渡す', async () => {
    const provider = fakeProvider('Kubernetesとスラックを使います。');
    const out = await postAsrStages({ rawText: ' くばねてすとスラックを使います ', settings, customizations, vocab, tokenizer: null, provider });
    expect(out.stages).toEqual({
      asr: 'くばねてすとスラックを使います',
      match: 'Kubernetesとスラックを使います',
      noLlm: 'KubernetesとSlackを使います',
      final: 'Kubernetesとスラックを使います。',
    });
    expect(provider.calls.length).toBe(1);
    const user = JSON.parse(provider.calls[0].user) as { raw_text: string };
    expect(user.raw_text).toBe('くばねてすとスラックを使います');
    expect(provider.calls[0].timeoutMs).toBe(60000);
    expect(out.noLlm?.prep?.replaced).toBe(1);
    expect(out.llm?.prep?.candidates.length).toBe(1);
  });

  it('LLM を使わない実行では、最終の文は LLM なしの文と同じ', async () => {
    const out = await postAsrStages({ rawText: 'スラックで送ります', settings, customizations, vocab, tokenizer: null, provider: null });
    expect(out.stages.noLlm).toBe('Slackで送ります');
    expect(out.stages.final).toBe('Slackで送ります');
    expect(out.llm).toBeNull();
  });

  it('書き起こしが空なら、どの段階も空で、LLM を呼ばない（アプリは何も入力しない）', async () => {
    const provider = fakeProvider('何か');
    const out = await postAsrStages({ rawText: '  ', settings, customizations, vocab, tokenizer: null, provider });
    expect(out.stages).toEqual({ asr: '', match: '', noLlm: '', final: '' });
    expect(out.noLlm).toBeNull();
    expect(provider.calls.length).toBe(0);
  });

  it('語ごとの確信度を、近道の判定に使う', async () => {
    const provider = fakeProvider('明日の会議は午後からです。');
    const raw = '明日の会議は午後からです。';
    const high = await postAsrStages({
      rawText: raw,
      tokens: [[raw, 0.95]],
      settings,
      customizations: { ...customizations, prepareFormatting: (r: string) => ({ text: r, vocabulary: [], candidates: [], replaced: 0 }) },
      vocab,
      tokenizer: null,
      provider,
    });
    expect(high.llm?.fmt.fastPath).toBe(true);
    expect(provider.calls.length).toBe(0);
    const low = await postAsrStages({
      rawText: raw,
      tokens: [
        ['明日の会議は', 0.95],
        ['午後', 0.1],
        ['からです。', 0.95],
      ],
      settings,
      customizations: { ...customizations, prepareFormatting: (r: string) => ({ text: r, vocabulary: [], candidates: [], replaced: 0 }) },
      vocab,
      tokenizer: null,
      provider,
    });
    expect(low.llm?.lowConfidence).toBe(true);
    expect(provider.calls.length).toBe(1);
  });
});
