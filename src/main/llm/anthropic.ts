import Anthropic from '@anthropic-ai/sdk';
import type { LlmSettings } from '../../shared/settings';
import { parseExtraBody } from './http';
import { LlmError, timeoutMessage, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse } from './types';

type ThinkingParam = Anthropic.Messages.ThinkingConfigParam;

/**
 * 「思考を止める」指定をモデルごとに選ぶ。モデルによって受け付ける値が違うため。
 * - Claude Sonnet 5.5: {type: "disabled"} は 400。{type: "between_tools"} で止める
 * - Claude Opus 5.5 / Fable / Mythos: 止められない。送らずに effort で浅くする
 * - それ以外の Claude（Haiku 5.5、Sonnet 5、Opus 5、4.x）: {type: "disabled"}
 * - プロキシの別名など判断できないもの: 送らない
 */
export function thinkingForOff(model: string): ThinkingParam | undefined {
  const m = model.toLowerCase();
  if (m.includes('sonnet-5-5')) return { type: 'between_tools' };
  if (m.includes('opus-5-5') || m.includes('fable') || m.includes('mythos')) return undefined;
  if (/claude-(haiku|sonnet|opus)/.test(m)) return { type: 'disabled' };
  return undefined;
}

/**
 * Anthropic の Messages API。公式 SDK を使い、通信は Electron の net.fetch に通す
 * （システムのプロキシ設定とキーチェーンに入れた独自の CA がそのまま効く）。
 *
 * サンプリングのパラメータ（temperature など）は送らない。新しいモデルは拒否するため。
 * effort / thinking / 構造化出力が 400 で拒否されたら、その項目を外して 1 回だけ再試行し、以後も外す。
 */
export class AnthropicProvider implements LlmProvider {
  readonly kind = 'anthropic';
  private readonly client: Anthropic;
  private useEffort = true;
  private useThinking = true;
  private useFormat = true;
  /** プロンプトのキャッシュを 1 時間保つ指定を送るか。拒否されたら外して、既定（5 分）に戻す */
  private useLongCache = true;

  constructor(
    private readonly cfg: LlmSettings,
    apiKey: string,
    fetchImpl: FetchLike,
  ) {
    if (!apiKey && !cfg.headers['authorization'] && !cfg.headers['Authorization']) {
      throw new LlmError('config', 'API キーが設定されていません');
    }
    this.client = new Anthropic({
      apiKey: apiKey || null,
      baseURL: cfg.baseUrl || undefined,
      fetch: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
      timeout: cfg.timeoutMs,
      defaultHeaders: cfg.headers,
    });
  }

  private buildParams(req: LlmRequest): Anthropic.Messages.MessageCreateParamsNonStreaming {
    const { anthropic } = this.cfg;
    if (!this.cfg.model) throw new LlmError('config', 'モデル名が設定されていません');
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.cfg.model,
      max_tokens: req.maxOutputTokens,
      system: [
        {
          type: 'text',
          text: req.system,
          // 音声入力は間が空くので、キャッシュを 1 時間保つ。5 分のままだと、間が空くたびに読み直しになって最初の応答が遅くなる
          ...(anthropic.promptCaching ? { cache_control: this.useLongCache ? { type: 'ephemeral' as const, ttl: '1h' as const } : { type: 'ephemeral' as const } } : {}),
        },
      ],
      messages: [{ role: 'user', content: req.user }],
    };
    const outputConfig: Anthropic.Messages.OutputConfig = {};
    if (this.useEffort && anthropic.effort) outputConfig.effort = anthropic.effort;
    if (this.useFormat && req.jsonSchema) outputConfig.format = { type: 'json_schema', schema: req.jsonSchema };
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;
    if (this.useThinking) {
      if (anthropic.thinking === 'off') {
        const t = thinkingForOff(this.cfg.model);
        if (t) params.thinking = t;
      } else if (anthropic.thinking === 'adaptive') {
        params.thinking = { type: 'adaptive' };
      }
    }
    Object.assign(params, parseExtraBody(this.cfg.extraBody));
    return params;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    for (let attempt = 0; attempt < 4; attempt++) {
      const params = this.buildParams(req);
      const remaining = req.timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new LlmError('timeout', timeoutMessage(req.timeoutMs));
      try {
        const msg = await this.client.messages.create(params, { timeout: remaining, signal: req.signal });
        if (msg.stop_reason === 'refusal') throw new LlmError('refusal', 'モデルが応答を拒否しました');
        const text = msg.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (msg.stop_reason === 'max_tokens' && !text) throw new LlmError('truncated', '出力が上限で切れました');
        return { text, model: msg.model, elapsedMs: Date.now() - started };
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if (e instanceof Anthropic.APIUserAbortError) {
          throw new LlmError('aborted', '中断しました');
        }
        if (e instanceof Anthropic.APIConnectionTimeoutError) {
          throw new LlmError('timeout', timeoutMessage(req.timeoutMs));
        }
        if (e instanceof Anthropic.APIConnectionError) {
          throw new LlmError('network', `接続できませんでした: ${e.message}`);
        }
        if (e instanceof Anthropic.APIError) {
          const status = e.status ?? 0;
          const m = (e.message ?? '').toLowerCase();
          if (status === 400) {
            if (this.useThinking && m.includes('thinking')) {
              this.useThinking = false;
              continue;
            }
            if (this.useEffort && m.includes('effort')) {
              this.useEffort = false;
              continue;
            }
            if (this.useLongCache && (/\bttl\b/.test(m) || m.includes('cache_control'))) {
              this.useLongCache = false;
              continue;
            }
            if (this.useFormat && (m.includes('output_config') || m.includes('format') || m.includes('schema'))) {
              this.useFormat = false;
              continue;
            }
          }
          if (status === 401 || status === 403) throw new LlmError('auth', `認証に失敗しました（${status}）: ${e.message}`, status);
          if (status === 429) throw new LlmError('rate_limit', `利用上限に達しました（429）: ${e.message}`, status);
          throw new LlmError('http', `HTTP ${status}: ${e.message}`, status);
        }
        throw new LlmError('network', (e as Error).message);
      }
    }
    throw new LlmError('http', 'LLM の呼び出しに失敗しました（再試行の上限）');
  }
}
