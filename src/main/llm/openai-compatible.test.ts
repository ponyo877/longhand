import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type LlmSettings } from '../../shared/settings';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { LlmRequest } from './types';

const cfg: LlmSettings = { ...DEFAULT_SETTINGS.llm, provider: 'openai-compatible', baseUrl: 'https://gw.example.internal/v1', model: 'm' };

const req: LlmRequest = {
  system: 's',
  user: 'u',
  jsonSchema: { type: 'object', properties: { text: { type: 'string' } } },
  maxOutputTokens: 256,
  timeoutMs: 5000,
};

function ok(text: string): Response {
  return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 });
}

function bad(message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status: 400 });
}

/** Records the request bodies and returns the prepared responses in order */
function fakeFetch(responses: ((body: Record<string, unknown>) => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next(body);
  };
  return { fetchImpl, bodies };
}

describe('OpenAiCompatibleProvider fallbacks', () => {
  it('switches to max_completion_tokens when max_tokens is not supported, and keeps using it', async () => {
    const f = fakeFetch([() => bad("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), () => ok('{"text":"a"}'), () => ok('{"text":"b"}')]);
    const p = new OpenAiCompatibleProvider(cfg, 'k', f.fetchImpl);
    expect((await p.complete(req)).text).toBe('{"text":"a"}');
    await p.complete(req);
    expect(f.bodies[1].max_completion_tokens).toBe(256);
    expect(f.bodies[1].max_tokens).toBeUndefined();
    expect(f.bodies[2].max_completion_tokens).toBe(256);
  });

  it('does not switch when max_tokens is too large', async () => {
    const f = fakeFetch([() => bad('max_tokens is too large: 20000. This model supports at most 8192 completion tokens.'), () => ok('{"text":"a"}')]);
    const p = new OpenAiCompatibleProvider(cfg, 'k', f.fetchImpl);
    await expect(p.complete(req)).rejects.toThrow(/too large/);
    await p.complete(req);
    expect(f.bodies[1].max_tokens).toBe(256);
  });

  it('steps structured output down from json_schema to json_object to none', async () => {
    const f = fakeFetch([
      () => bad('response_format type json_schema is not supported'),
      () => bad("'response_format' of type 'json_object' is not supported with this model"),
      () => ok('{"text":"a"}'),
    ]);
    const p = new OpenAiCompatibleProvider(cfg, 'k', f.fetchImpl);
    await p.complete(req);
    expect((f.bodies[0].response_format as { type: string }).type).toBe('json_schema');
    expect((f.bodies[1].response_format as { type: string }).type).toBe('json_object');
    expect(f.bodies[2].response_format).toBeUndefined();
  });

  it('keeps structured output on a 400 that says the body JSON is malformed', async () => {
    const f = fakeFetch([() => bad('Invalid JSON payload received.')]);
    const p = new OpenAiCompatibleProvider(cfg, 'k', f.fetchImpl);
    await expect(p.complete(req)).rejects.toThrow(/Invalid JSON/);
  });

  it('sends the API key in the Authorization header, along with the extra headers', async () => {
    let headers: Record<string, string> = {};
    const p = new OpenAiCompatibleProvider({ ...cfg, headers: { 'x-tenant': 't1' } }, 'secret', async (_u, init) => {
      headers = init?.headers as Record<string, string>;
      return ok('{"text":"a"}');
    });
    await p.complete(req);
    expect(headers.authorization).toBe('Bearer secret');
    expect(headers['x-tenant']).toBe('t1');
  });
});
