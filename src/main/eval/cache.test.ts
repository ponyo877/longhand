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
  it('キーの順が違っても同じ文字列になり、undefined の項目は落とす', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }], e: undefined })).toBe(stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
    expect(stableStringify({ a: null })).toBe('{"a":null}');
  });
});

describe('音声認識のキー', () => {
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

  it('末尾の切り落としの長さが違えばキーが変わる。切り落とさなければ、指定の無いときと同じキー', () => {
    expect(asrCacheKey({ ...base, truncateTailMs: undefined })).toBe(asrCacheKey(base));
    expect(asrCacheKey({ ...base, truncateTailMs: 300 })).not.toBe(asrCacheKey(base));
    expect(asrCacheKey({ ...base, truncateTailMs: 300 })).not.toBe(asrCacheKey({ ...base, truncateTailMs: 250 }));
  });

  it('同じ入力なら同じキー。prompt の未指定と空は同じ扱い', () => {
    expect(asrCacheKey(base)).toBe(asrCacheKey({ ...base, options: { beam: 5 } }));
    expect(asrCacheKey(base)).toBe(asrCacheKey({ ...base, prompt: '' }));
    expect(asrCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('音声、エンジン、モデル、ワーカー、オプション、言語、ヒント、prompt のどれが変わってもキーが変わる', () => {
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

describe('LLM のキー', () => {
  const cfg: LlmSettings = { ...DEFAULT_SETTINGS.llm, model: 'model-a' };
  const id = llmIdentity(cfg);

  it('API キー、ヘッダ、接続先はキーに入らない', () => {
    const other = llmIdentity({ ...cfg, apiKeyEnc: 'ZW5jcnlwdGVk', headers: { authorization: 'Bearer secret-value' }, baseUrl: 'https://proxy.example.test', timeoutMs: 60000 });
    expect(other).toEqual(id);
    expect(llmCacheKey(other, req())).toBe(llmCacheKey(id, req()));
    const text = JSON.stringify(other);
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('proxy.example.test');
    expect(text).not.toContain('ZW5jcnlwdGVk');
  });

  it('extraBody は中身を持たず、ハッシュだけを持つ', () => {
    const withExtra = llmIdentity({ ...cfg, extraBody: '{"metadata":{"team":"x"}}' });
    expect(JSON.stringify(withExtra)).not.toContain('metadata');
    expect(withExtra.extraBodySha256).not.toBe(id.extraBodySha256);
    expect(llmCacheKey(withExtra, req())).not.toBe(llmCacheKey(id, req()));
  });

  it('種類、モデル、プロンプト、出力の形式、出力の上限、Anthropic の設定、試行番号のどれが変わってもキーが変わる', () => {
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

  it('時間切れと中断の指定は、キーに入らない', () => {
    expect(llmCacheKey(id, req({ timeoutMs: 60000, signal: new AbortController().signal }))).toBe(llmCacheKey(id, req()));
  });

  it('Anthropic 以外では、Anthropic の設定をキーに入れない', () => {
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

  /** 呼ばれるたびに、並べた結果を順に返す偽の LLM */
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

  it('1 回目は呼んで保存し、2 回目は保存済みの結果を返して呼ばない', async () => {
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
    // 別の包みからも読める（次の実行で使い回せる）
    const again = new CachingProvider(null, { dir, identity });
    expect((await again.complete(req())).text).toBe('{"text":"整えた文"}');
  });

  it('保存するファイルは 0600 で、プロンプトも接続の情報も含まない', async () => {
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

  it('試行番号が違えば、別の結果として呼び直す', async () => {
    const inner = fakeInner(['{"text":"一"}', '{"text":"二"}']);
    expect((await new CachingProvider(inner, { dir, identity, attempt: 0 }).complete(req())).text).toBe('{"text":"一"}');
    expect((await new CachingProvider(inner, { dir, identity, attempt: 1 }).complete(req())).text).toBe('{"text":"二"}');
    expect(inner.calls).toBe(2);
  });

  it('時間切れ、通信の失敗、利用上限、5xx は 2 回までやり直す', async () => {
    for (const err of [new LlmError('timeout', 't'), new LlmError('network', 'n'), new LlmError('rate_limit', 'r', 429), new LlmError('http', 'h', 503)]) {
      const inner = fakeInner([err, err, '{"text":"三度目"}']);
      const p = new CachingProvider(inner, { dir, identity, attempt: inner.calls + Math.random(), backoffMs: noWait });
      expect((await p.complete(req())).text).toBe('{"text":"三度目"}');
      expect(inner.calls).toBe(3);
      expect(p.takeLast()).toMatchObject({ cached: false, tries: 3 });
      expect(p.fatal).toBeNull();
    }
  });

  it('やり直しても失敗したら、保存せずに失敗を返す（実行は止めない）', async () => {
    const inner = fakeInner([new LlmError('timeout', 't')]);
    const p = new CachingProvider(inner, { dir, identity, backoffMs: noWait });
    await expect(p.complete(req())).rejects.toMatchObject({ kind: 'timeout' });
    expect(inner.calls).toBe(3);
    expect(p.takeLast()).toMatchObject({ errorKind: 'timeout', tries: 3 });
    expect(p.fatal).toBeNull();
    expect(p.stats).toMatchObject({ failures: 1, stored: 0 });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('4xx や拒否はやり直さない', async () => {
    const inner = fakeInner([new LlmError('http', 'bad request', 400)]);
    const p = new CachingProvider(inner, { dir, identity, backoffMs: noWait });
    await expect(p.complete(req())).rejects.toMatchObject({ kind: 'http' });
    expect(inner.calls).toBe(1);
    expect(p.fatal).toBeNull();
  });

  it('認証と設定の誤りは、やり直さずに実行を止める印を立てる', async () => {
    for (const kind of ['auth', 'config'] as const) {
      const inner = fakeInner([new LlmError(kind, '認証に失敗しました', 401)]);
      const p = new CachingProvider(inner, { dir, identity, backoffMs: noWait });
      await expect(p.complete(req())).rejects.toMatchObject({ kind });
      expect(inner.calls).toBe(1);
      expect(p.fatal?.kind).toBe(kind);
      // 印が立った後は、もう呼ばない
      await expect(p.complete(req({ user: '別の発話' }))).rejects.toBeInstanceOf(LlmError);
      expect(inner.calls).toBe(1);
    }
  });

  it('呼び出しの上限に達したら、それ以上は呼ばずに実行を止める印を立てる', async () => {
    const inner = fakeInner(['{"text":"一"}']);
    const budget = new CallBudget(2);
    const p = new CachingProvider(inner, { dir, identity, budget });
    await p.complete(req({ user: '一つ目' }));
    await p.complete(req({ user: '二つ目' }));
    await p.complete(req({ user: '一つ目' })); // 保存済みは数えない
    expect(budget.used).toBe(2);
    await expect(p.complete(req({ user: '三つ目' }))).rejects.toBeInstanceOf(LlmError);
    expect(inner.calls).toBe(2);
    expect(p.fatal?.kind).toBe('budget');
    expect(p.takeLast()).toMatchObject({ errorKind: 'budget' });
  });

  it('やり直しも上限に数える', async () => {
    const inner = fakeInner([new LlmError('network', 'n')]);
    const budget = new CallBudget(2);
    const p = new CachingProvider(inner, { dir, identity, budget, backoffMs: noWait });
    await expect(p.complete(req())).rejects.toBeInstanceOf(LlmError);
    expect(inner.calls).toBe(2);
    expect(p.fatal?.kind).toBe('budget');
  });

  it('通信の入口で数えているときは、自分では数えず、上限に達したかだけを見る', async () => {
    const budget = new CallBudget(1);
    const inner: LlmProvider = {
      kind: 'fake',
      async complete() {
        budget.take(); // 通信の入口（fetch）に当たる
        return { text: '{"text":"一"}', model: 'm', elapsedMs: 1 };
      },
    };
    const p = new CachingProvider(inner, { dir, identity, budget, countCalls: false });
    await p.complete(req({ user: '一つ目' }));
    expect(budget.used).toBe(1);
    await expect(p.complete(req({ user: '二つ目' }))).rejects.toBeInstanceOf(LlmError);
    expect(p.fatal?.kind).toBe('budget');
  });

  it('保存済みの結果だけを使う指定では、無ければ失敗を返して数える（実行は止めない）', async () => {
    const p = new CachingProvider(null, { dir, identity });
    await expect(p.complete(req())).rejects.toBeInstanceOf(LlmError);
    expect(p.takeLast()).toMatchObject({ errorKind: 'cache-miss', tries: 0 });
    expect(p.fatal).toBeNull();
    expect(p.stats).toMatchObject({ hits: 0, misses: 1, calls: 0 });
  });
});

describe('JsonCache', () => {
  it('無いキーと壊れたファイルは null', () => {
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
