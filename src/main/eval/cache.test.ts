import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type LlmSettings } from '../../shared/settings';
import { LlmError, type LlmProvider, type LlmRequest } from '../llm/types';
import { asrCacheKey, CachingProvider, CallBudget, JsonCache, llmCacheKey, llmIdentity, type AsrKeyInput } from './cache';
import { stableStringify } from './files';

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  system: '整形の指示',
  user: 'きょうは晴れです',
  jsonSchema: { type: 'object' },
  maxOutputTokens: 256,
  timeoutMs: 1000,
  ...over,
});

describe('stableStringify', () => {
  it('produces the same string whatever the key order, and drops undefined fields', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }], e: undefined })).toBe(stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
    expect(stableStringify({ a: null })).toBe('{"a":null}');
  });
});

describe('speech recognition key', () => {
  const base: AsrKeyInput = {
    audioSha256: 'aa',
    engine: 'whisper',
    modelName: 'model.bin',
    model: { size: 100, mtimeMs: 1 },
    worker: { size: 200, mtimeMs: 2 },
    options: { beam: 5 },
    language: 'ja',
    hints: ['Longhand'],
    incremental: true,
    minRecordingMs: 300,
    silenceDetection: true,
  };

  it('changes the key when the length cut from the end differs. Without a cut, the key is the same as when none is given', () => {
    expect(asrCacheKey({ ...base, truncateTailMs: undefined })).toBe(asrCacheKey(base));
    expect(asrCacheKey({ ...base, truncateTailMs: 300 })).not.toBe(asrCacheKey(base));
    expect(asrCacheKey({ ...base, truncateTailMs: 300 })).not.toBe(asrCacheKey({ ...base, truncateTailMs: 250 }));
  });

  it('gives the same key for the same input. An unset prompt and an empty prompt are treated alike', () => {
    expect(asrCacheKey(base)).toBe(asrCacheKey({ ...base, options: { beam: 5 } }));
    expect(asrCacheKey(base)).toBe(asrCacheKey({ ...base, prompt: '' }));
    expect(asrCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the key when any of audio, engine, model, worker, options, language, hints or prompt changes', () => {
    const variants: Partial<AsrKeyInput>[] = [
      { audioSha256: 'bb' },
      { engine: 'parakeet' },
      { modelName: 'other.bin' },
      { model: { size: 101, mtimeMs: 1 } },
      { model: { size: 100, mtimeMs: 9 } },
      { worker: { size: 200, mtimeMs: 3 } },
      { options: { beam: 1 } },
      { language: 'en' },
      { hints: ['Longhand', '用語集'] },
      { hints: [] },
      { prompt: '直前の文' },
      { incremental: false },
      { minRecordingMs: 0 },
      { silenceDetection: false },
    ];
    const keys = new Set(variants.map((v) => asrCacheKey({ ...base, ...v })));
    expect(keys.size).toBe(variants.length);
    expect(keys.has(asrCacheKey(base))).toBe(false);
  });
});

describe('LLM key', () => {
  const cfg: LlmSettings = { ...DEFAULT_SETTINGS.llm, model: 'model-a' };
  const id = llmIdentity(cfg);

  it('leaves the API key, headers and endpoint out of the key', () => {
    const other = llmIdentity({ ...cfg, apiKeyEnc: 'ZW5jcnlwdGVk', headers: { authorization: 'Bearer secret-value' }, baseUrl: 'https://proxy.example.test', timeoutMs: 60000 });
    expect(other).toEqual(id);
    expect(llmCacheKey(other, req())).toBe(llmCacheKey(id, req()));
    const text = JSON.stringify(other);
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('proxy.example.test');
    expect(text).not.toContain('ZW5jcnlwdGVk');
  });

  it('holds only a hash of extraBody, not its content', () => {
    const withExtra = llmIdentity({ ...cfg, extraBody: '{"metadata":{"team":"x"}}' });
    expect(JSON.stringify(withExtra)).not.toContain('metadata');
    expect(withExtra.extraBodySha256).not.toBe(id.extraBodySha256);
    expect(llmCacheKey(withExtra, req())).not.toBe(llmCacheKey(id, req()));
  });

  it('changes the key when any of kind, model, prompt, output format, output limit, Anthropic settings or attempt number changes', () => {
    const keys = [
      llmCacheKey(id, req()),
      llmCacheKey(llmIdentity({ ...cfg, provider: 'openai-compatible' }), req()),
      llmCacheKey(llmIdentity({ ...cfg, model: 'model-b' }), req()),
      llmCacheKey(llmIdentity({ ...cfg, anthropic: { ...cfg.anthropic, effort: 'high' } }), req()),
      llmCacheKey(id, req({ system: '別の指示' })),
      llmCacheKey(id, req({ user: 'きょうは雨です' })),
      llmCacheKey(id, req({ jsonSchema: { type: 'array' } })),
      llmCacheKey(id, req({ jsonSchema: undefined })),
      llmCacheKey(id, req({ maxOutputTokens: 512 })),
      llmCacheKey(id, req(), 1),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves the timeout and abort settings out of the key', () => {
    expect(llmCacheKey(id, req({ timeoutMs: 60000, signal: new AbortController().signal }))).toBe(llmCacheKey(id, req()));
  });

  it('leaves the Anthropic settings out of the key for other providers', () => {
    const a = llmIdentity({ ...cfg, provider: 'openai-compatible' });
    const b = llmIdentity({ ...cfg, provider: 'openai-compatible', anthropic: { ...cfg.anthropic, effort: 'high' } });
    expect(a.anthropic).toBeNull();
    expect(a).toEqual(b);
  });
});

describe('CachingProvider', () => {
  let dir = '';
  const identity = llmIdentity({ ...DEFAULT_SETTINGS.llm, model: 'model-a' });
  const noWait = () => 0;

  /** A fake LLM that returns the given results in order, one per call */
  function fakeInner(results: (string | LlmError)[]): LlmProvider & { calls: number } {
    const p = {
      kind: 'fake',
      calls: 0,
      async complete() {
        const r = results[Math.min(p.calls, results.length - 1)];
        p.calls++;
        if (r instanceof LlmError) throw r;
        return { text: r, model: 'model-a-20260101', elapsedMs: 1234 };
      },
    };
    return p;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-llm-cache-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('calls and saves the first time, and returns the saved result the second time without calling', async () => {
    const inner = fakeInner(['{"text":"整えた文"}']);
    const p = new CachingProvider(inner, { dir, identity });
    const first = await p.complete(req());
    expect(p.takeLast()).toEqual({ cached: false, elapsedMs: 1234, tries: 1 });
    const second = await p.complete(req({ timeoutMs: 5 }));
    expect(second).toEqual(first);
    expect(p.takeLast()).toEqual({ cached: true, elapsedMs: 1234, tries: 0 });
    expect(p.takeLast()).toBeNull();
    expect(inner.calls).toBe(1);
    expect(p.stats).toMatchObject({ hits: 1, misses: 1, calls: 1, stored: 1, failures: 0 });
    // Another wrapper can read it too (so the next run can reuse it)
    const again = new CachingProvider(null, { dir, identity });
    expect((await again.complete(req())).text).toBe('{"text":"整えた文"}');
  });

  it('saves files with mode 0600 that contain neither the prompt nor the connection details', async () => {
    const p = new CachingProvider(fakeInner(['{"text":"整えた文"}']), { dir, identity });
    await p.complete(req());
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    const file = path.join(dir, files[0]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const saved = fs.readFileSync(file, 'utf8');
    expect(saved).toContain('整えた文');
    expect(saved).not.toContain('整形の指示');
    expect(saved).not.toContain('きょうは晴れです');
    expect(Object.keys(JSON.parse(saved)).sort()).toEqual(['attempt', 'createdAt', 'kind', 'model', 'response', 'v']);
  });

  it('calls again for a different result when the attempt number differs', async () => {
    const inner = fakeInner(['{"text":"一"}', '{"text":"二"}']);
    expect((await new CachingProvider(inner, { dir, identity, attempt: 0 }).complete(req())).text).toBe('{"text":"一"}');
    expect((await new CachingProvider(inner, { dir, identity, attempt: 1 }).complete(req())).text).toBe('{"text":"二"}');
    expect(inner.calls).toBe(2);
  });

  it('retries timeouts, network failures, rate limits and 5xx up to twice', async () => {
    for (const err of [new LlmError('timeout', 't'), new LlmError('network', 'n'), new LlmError('rate_limit', 'r', 429), new LlmError('http', 'h', 503)]) {
      const inner = fakeInner([err, err, '{"text":"三度目"}']);
      const p = new CachingProvider(inner, { dir, identity, attempt: inner.calls + Math.random(), backoffMs: noWait });
      expect((await p.complete(req())).text).toBe('{"text":"三度目"}');
      expect(inner.calls).toBe(3);
      expect(p.takeLast()).toMatchObject({ cached: false, tries: 3 });
      expect(p.fatal).toBeNull();
    }
  });

  it('returns a failure without saving when retries also fail (does not stop the run)', async () => {
    const inner = fakeInner([new LlmError('timeout', 't')]);
    const p = new CachingProvider(inner, { dir, identity, backoffMs: noWait });
    await expect(p.complete(req())).rejects.toMatchObject({ kind: 'timeout' });
    expect(inner.calls).toBe(3);
    expect(p.takeLast()).toMatchObject({ errorKind: 'timeout', tries: 3 });
    expect(p.fatal).toBeNull();
    expect(p.stats).toMatchObject({ failures: 1, stored: 0 });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not retry 4xx or refusals', async () => {
    const inner = fakeInner([new LlmError('http', 'bad request', 400)]);
    const p = new CachingProvider(inner, { dir, identity, backoffMs: noWait });
    await expect(p.complete(req())).rejects.toMatchObject({ kind: 'http' });
    expect(inner.calls).toBe(1);
    expect(p.fatal).toBeNull();
  });

  it('sets the flag that stops the run on auth and config errors, without retrying', async () => {
    for (const kind of ['auth', 'config'] as const) {
      const inner = fakeInner([new LlmError(kind, 'Authentication failed', 401)]);
      const p = new CachingProvider(inner, { dir, identity, backoffMs: noWait });
      await expect(p.complete(req())).rejects.toMatchObject({ kind });
      expect(inner.calls).toBe(1);
      expect(p.fatal?.kind).toBe(kind);
      // Once the flag is set, it does not call anymore
      await expect(p.complete(req({ user: '別の発話' }))).rejects.toBeInstanceOf(LlmError);
      expect(inner.calls).toBe(1);
    }
  });

  it('sets the flag that stops the run when the call limit is reached, without calling further', async () => {
    const inner = fakeInner(['{"text":"一"}']);
    const budget = new CallBudget(2);
    const p = new CachingProvider(inner, { dir, identity, budget });
    await p.complete(req({ user: '一つ目' }));
    await p.complete(req({ user: '二つ目' }));
    await p.complete(req({ user: '一つ目' })); // saved results are not counted
    expect(budget.used).toBe(2);
    await expect(p.complete(req({ user: '三つ目' }))).rejects.toBeInstanceOf(LlmError);
    expect(inner.calls).toBe(2);
    expect(p.fatal?.kind).toBe('budget');
    expect(p.takeLast()).toMatchObject({ errorKind: 'budget' });
  });

  it('counts retries toward the limit', async () => {
    const inner = fakeInner([new LlmError('network', 'n')]);
    const budget = new CallBudget(2);
    const p = new CachingProvider(inner, { dir, identity, budget, backoffMs: noWait });
    await expect(p.complete(req())).rejects.toBeInstanceOf(LlmError);
    expect(inner.calls).toBe(2);
    expect(p.fatal?.kind).toBe('budget');
  });

  it('does not count by itself when calls are counted at the network entry point, and only checks whether the limit is reached', async () => {
    const budget = new CallBudget(1);
    const inner: LlmProvider = {
      kind: 'fake',
      async complete() {
        budget.take(); // stands in for the network entry point (fetch)
        return { text: '{"text":"一"}', model: 'm', elapsedMs: 1 };
      },
    };
    const p = new CachingProvider(inner, { dir, identity, budget, countCalls: false });
    await p.complete(req({ user: '一つ目' }));
    expect(budget.used).toBe(1);
    await expect(p.complete(req({ user: '二つ目' }))).rejects.toBeInstanceOf(LlmError);
    expect(p.fatal?.kind).toBe('budget');
  });

  it('returns a failure and counts it when only saved results are allowed and there is none (does not stop the run)', async () => {
    const p = new CachingProvider(null, { dir, identity });
    await expect(p.complete(req())).rejects.toBeInstanceOf(LlmError);
    expect(p.takeLast()).toMatchObject({ errorKind: 'cache-miss', tries: 0 });
    expect(p.fatal).toBeNull();
    expect(p.stats).toMatchObject({ hits: 0, misses: 1, calls: 0 });
  });
});

describe('JsonCache', () => {
  it('returns null for a missing key and for a broken file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-json-cache-'));
    try {
      const c = new JsonCache<{ a: number }>(dir);
      expect(c.get('none')).toBeNull();
      c.set('k', { a: 1 });
      expect(c.get('k')).toEqual({ a: 1 });
      fs.writeFileSync(path.join(dir, 'broken.json'), '{');
      expect(c.get('broken')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
