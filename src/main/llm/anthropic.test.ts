import { describe, expect, it } from 'vitest';
import { DICTATION_SCHEMA, dictationSystemPrompt, dictationUserMessage } from '../format/prompts';
import { DEFAULT_SETTINGS, type LlmSettings } from '../../shared/settings';
import { AnthropicProvider, thinkingForOff } from './anthropic';
import { timeoutMessage, type LlmRequest } from './types';

function message(text: string, model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function bad(msg: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(responses: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  };
  return { fetchImpl, bodies };
}

const req: LlmRequest = {
  system: dictationSystemPrompt(['Longhand'], '', ['ほげ']),
  user: dictationUserMessage('明日行きます', 'ja', { appName: 'Slack' }),
  jsonSchema: DICTATION_SCHEMA as unknown as Record<string, unknown>,
  maxOutputTokens: 256,
  timeoutMs: 5000,
};

describe('thinkingForOff', () => {
  it('picks the setting that turns thinking off for each model', () => {
    expect(thinkingForOff('claude-haiku-5-5')).toEqual({ type: 'disabled' });
    expect(thinkingForOff('claude-sonnet-5-5')).toEqual({ type: 'between_tools' });
    expect(thinkingForOff('claude-opus-5-5')).toBeUndefined();
    expect(thinkingForOff('internal-alias')).toBeUndefined();
  });
});

describe('timeoutMessage', () => {
  it('writes the timeout in seconds (shown as is in the notification body)', () => {
    expect(timeoutMessage(8000)).toBe('The LLM did not respond within 8 seconds');
    expect(timeoutMessage(15000)).toBe('The LLM did not respond within 15 seconds');
    expect(timeoutMessage(300)).toBe('The LLM did not respond within 1 second');
  });
});

describe('AnthropicProvider (sending the new prompt to a small fast model, F-19)', () => {
  const cfg: LlmSettings = { ...DEFAULT_SETTINGS.llm, provider: 'anthropic', model: 'claude-haiku-5-5' };

  it('sends Haiku 5.5 a cached system prompt, structured output, effort and thinking turned off', async () => {
    const f = fakeFetch([() => message('{"text":"明日行きます。"}', 'claude-haiku-5-5')]);
    const p = new AnthropicProvider(cfg, 'k', f.fetchImpl);
    const res = await p.complete(req);
    expect(res.text).toBe('{"text":"明日行きます。"}');
    const body = f.bodies[0];
    expect(body.model).toBe('claude-haiku-5-5');
    // Dictation has long gaps, so the cache is kept for 1 hour
    expect(body.system).toEqual([{ type: 'text', text: req.system, cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: DICTATION_SCHEMA } });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.temperature).toBeUndefined();
    // The transcript, which changes every time, goes only into the user message. The system prompt is the same for every utterance (so the cache works)
    expect(req.system).not.toContain('明日行きます');
  });

  it('retries once without the thinking setting when it is rejected, and leaves it off afterwards', async () => {
    const f = fakeFetch([() => bad('thinking.type: disabled is not supported with effort max'), () => message('{"text":"a"}', 'claude-haiku-5-5'), () => message('{"text":"b"}', 'claude-haiku-5-5')]);
    const p = new AnthropicProvider(cfg, 'k', f.fetchImpl);
    await p.complete(req);
    await p.complete(req);
    expect(f.bodies[0].thinking).toEqual({ type: 'disabled' });
    expect(f.bodies[1].thinking).toBeUndefined();
    expect(f.bodies[2].thinking).toBeUndefined();
  });
});
