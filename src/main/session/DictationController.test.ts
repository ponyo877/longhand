/**
 * DictationController の結合テスト。ヘルパー、ASR、LLM、保存先を偽物にして、
 * ホットキーと音声のイベントを流し込み、貼り付けと履歴までを確かめる。
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextPayload, HelperToMain, PasteAckPayload } from '../../shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import type { Customizations, FloaterState, HistoryItem, LearnedWord } from '../../shared/types';
import type { LlmProvider, LlmRequest } from '../llm/types';
import { AsrCancelledError, floatToBase64, type TranscribeOptions } from '../asr/AsrService';
import { createLinderaTokenizer } from '../textfix/tokenizer';
import type { Tokenizer } from '../textfix/types';
import { DictationController, type ControllerDeps } from './DictationController';

const SR = 16000;

function speech(sec: number): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < out.length; i++) out[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}

class FakeHelper extends EventEmitter {
  running = true;
  sent: { type: string; payload: unknown }[] = [];
  pastes: Record<string, unknown>[] = [];
  started: number[] = [];
  context: ContextPayload = {
    app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 1 },
    field: { role: 'AXTextArea', subrole: '', description: '', isSecure: false, editable: true, beforeCursor: '', afterCursor: '', selectedText: '', totalLength: 0 },
    canPaste: true,
    elapsedMs: 1,
  } as unknown as ContextPayload;
  pasteAck: Partial<PasteAckPayload> = { success: true, landed: 'confirmed' };

  syncState(): void {}
  send(type: string, payload: unknown): void {
    this.sent.push({ type, payload });
  }
  async request(type: string, payload: Record<string, unknown>): Promise<unknown> {
    if (type === 'get_context') return this.context;
    if (type === 'list_audio_devices') return { devices: [] };
    if (type === 'paste') {
      this.pastes.push(payload);
      return { retried: false, elapsedMs: 1, ...this.pasteAck };
    }
    throw new Error(`unexpected request ${type}`);
  }
  async startAudio(sessionId: number) {
    this.started.push(sessionId);
    return { sessionId, deviceId: 'mic', deviceName: 'Mic', transport: 'builtin' };
  }
  /** 録音の停止の返事を遅らせるときに差し替える */
  stopGate: Promise<void> = Promise.resolve();
  async stopAudio(sessionId: number) {
    await this.stopGate;
    return { sessionId, status: 'flushed', chunks: 0 };
  }

  emitMsg(m: unknown): void {
    this.emit('message', m as HelperToMain);
  }
  hotkey(action: string, phase: string, t: number): void {
    this.emitMsg({ type: 'hotkey', payload: { action, phase, t } });
  }
  audio(sessionId: number, samples: Float32Array, peak = 0.1): void {
    for (let i = 0, seq = 0; i < samples.length; i += 1600, seq++) {
      const chunk = samples.subarray(i, i + 1600);
      this.emitMsg({ type: 'audio_chunk', payload: { sessionId, seq, pcm: floatToBase64(chunk), rms: 0.07, peak } });
    }
  }
}

/** 話の間での先回りの書き起こしは既定でオフなので、そのテストでは明示的に有効にする */
const SPECULATIVE: Partial<Settings> = { asr: { ...DEFAULT_SETTINGS.asr, speculative: true, tailMs: 0 } };
/** キーを離した後も録音を続ける設定 */
const TAIL: Partial<Settings> = { asr: { ...DEFAULT_SETTINGS.asr, tailMs: 120 } };

function setup(opts: { settings?: Partial<Settings>; asrText?: string; llm?: (req: LlmRequest) => Promise<string> | string; tokenizer?: Tokenizer } = {}) {
  const helper = new FakeHelper();
  const settings: Settings = { ...DEFAULT_SETTINGS, playSounds: false, saveRecordings: false, asr: { ...DEFAULT_SETTINGS.asr, tailMs: 0 }, ...opts.settings };
  const asr = {
    ready: true,
    idle: true,
    status: 'ready',
    message: '',
    transcribe: vi.fn(async (_samples: Float32Array, _opts: TranscribeOptions) => ({ text: opts.asrText ?? 'えーと今日は晴れです', elapsedMs: 5 })),
    waitReady: vi.fn(async () => true),
  };
  const cust: Customizations = { version: 1, dictionary: [], replacements: [], customInstructions: '', learnedWords: [], blockedLearnedWords: [] };
  const learned: LearnedWord[] = [];
  const remembered = {
    forms: [] as { word: string; from: string }[],
    corrections: [] as { heard: string; corrected: string }[],
    kept: [] as { phrase: string; changedTo: string }[],
  };
  const customizations = {
    get: () => cust,
    vocabulary: () => cust.dictionary,
    asrHints: vi.fn((_o?: unknown) => cust.dictionary),
    prepareFormatting: vi.fn((raw: string, _o: unknown) => ({ text: raw, vocabulary: cust.dictionary, candidates: [] as { heard: string; word: string }[], replaced: 0 })),
    addLearnedWords: vi.fn((w: LearnedWord[]) => {
      learned.push(...w);
      return w;
    }),
    // 辞書に語を足さない学習（聞き違えた形、取り違えの組、書き換えない語句）。渡された分をそのまま覚えたことにする
    addMisheardForms: vi.fn((f: { word: string; from: string }[]) => {
      remembered.forms.push(...f);
      return f;
    }),
    addPastCorrections: vi.fn((p: { heard: string; corrected: string }[]) => {
      remembered.corrections.push(...p);
      return p.map((x) => ({ ...x, count: 1, at: 0 }));
    }),
    addKeptPhrases: vi.fn((p: { phrase: string; changedTo: string }[]) => {
      remembered.kept.push(...p);
      return p.map((x) => ({ ...x, count: 1, at: 0 }));
    }),
    undoLearnedWord: vi.fn(),
    removeMisheardForm: vi.fn(),
    removePastCorrection: vi.fn(),
    removeKeptPhrase: vi.fn(),
  };
  const history: HistoryItem[] = [];
  const huds: string[] = [];
  const floaters: Partial<FloaterState>[] = [];
  const sounds: string[] = [];
  const llmCalls: LlmRequest[] = [];
  const provider: LlmProvider | null = opts.llm
    ? {
        kind: 'fake',
        complete: async (req: LlmRequest) => {
          llmCalls.push(req);
          return { text: await opts.llm!(req), model: 'fake', elapsedMs: 1 };
        },
      }
    : null;
  const deps = {
    helper,
    asr,
    settings: { get: () => settings },
    customizations,
    history: {
      add: (h: HistoryItem) => history.push(h),
      last: () => history[history.length - 1],
      list: () => [...history].sort((a, b) => b.timestamp - a.timestamp),
    },
    recordings: { save: () => 'rec.wav' },
    ui: {
      floater: (st: Partial<FloaterState>) => floaters.push(st),
      level: () => undefined,
      hud: (k: string) => huds.push(k),
      sound: (n: string) => sounds.push(n),
      preconnect: () => undefined,
    },
    provider: () => provider,
    tokenizer: () => opts.tokenizer ?? null,
  } as unknown as ControllerDeps;
  const controller = new DictationController(deps);
  return { controller, helper, asr, history, huds, llmCalls, learned, remembered, settings, floaters, sounds, customizations };
}

/** 非同期の処理が進むまで待つ */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const formatted = (text: string) => JSON.stringify({ text });

describe('DictationController', () => {
  beforeEach(() => vi.useRealTimers());

  it('押しっぱなしで話すと、書き起こして整形した文を貼り付け、履歴に残す', async () => {
    const t = setup({ llm: () => formatted('今日は晴れです。') });
    t.helper.hotkey('activate', 'down', 0);
    expect(t.helper.started).toEqual([1]);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.helper.pastes).toHaveLength(1);
    expect(t.helper.pastes[0].text).toBe('今日は晴れです。');
    expect(t.history[0]).toMatchObject({ rawText: 'えーと今日は晴れです', text: '今日は晴れです。', paste: 'pasted', formatted: true });
    // 整形には書き起こしと入力先のアプリ名が渡る
    expect(t.llmCalls[0].user).toContain('えーと今日は晴れです');
    expect(t.llmCalls[0].user).toContain('TextEdit');
  });

  it('離した後の録音を続ける設定では、離してからも届いた音声を書き起こしに含め、続けた時間を履歴に残す', async () => {
    const t = setup({ settings: TAIL, llm: () => formatted('今日は晴れです。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    await new Promise((r) => setTimeout(r, 10));
    t.helper.hotkey('activate', 'up', 2000);
    // 離した直後は、まだ録音を止めていない（文末の音を待っている）
    await new Promise((r) => setTimeout(r, 40));
    expect(t.asr.transcribe).not.toHaveBeenCalled();
    t.helper.audio(1, speech(0.1)); // 離した後に届いた音声
    await until(() => t.history.length === 1);
    const samples = t.asr.transcribe.mock.calls[0][0];
    expect(samples.length).toBe(SR * 2.1);
    expect(t.history[0].timings.postRollMs).toBe(120);
  });

  it('離した後の録音を続ける設定でも、1 秒以上黙ってから離したら続けない', async () => {
    const t = setup({ settings: TAIL, llm: () => formatted('今日は晴れです。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 1.2)); // 1.2 秒の無音
    await new Promise((r) => setTimeout(r, 10));
    t.helper.hotkey('activate', 'up', 3200);
    await until(() => t.history.length === 1);
    expect(t.history[0].timings.postRollMs).toBeUndefined();
  });

  it('画面の文から拾った語を、設定がオンのときだけ音声認識のヒントに足し、録音を残す設定なら履歴にも残す', async () => {
    const withContext = (t: ReturnType<typeof setup>) => {
      t.helper.context = {
        ...t.helper.context,
        windowTitle: 'Grafana のダッシュボード',
        field: { ...t.helper.context.field!, beforeCursor: 'さっき Sentry に通知が来ていたので、git status を見ました。' },
      } as ContextPayload;
    };
    const off = setup({ llm: () => formatted('今日は晴れです。') });
    withContext(off);
    off.helper.hotkey('activate', 'down', 0);
    off.helper.audio(1, speech(2));
    off.helper.hotkey('activate', 'up', 2000);
    await until(() => off.history.length === 1);
    expect(off.asr.transcribe.mock.calls[0][1].hints).toEqual([]);
    expect(off.history[0].contextTerms).toBeUndefined();

    const on = setup({
      settings: { saveRecordings: true, asr: { ...DEFAULT_SETTINGS.asr, tailMs: 0, screenTerms: true } },
      llm: () => formatted('今日は晴れです。'),
    });
    withContext(on);
    on.helper.hotkey('activate', 'down', 0);
    on.helper.audio(1, speech(2));
    on.helper.hotkey('activate', 'up', 2000);
    await until(() => on.history.length === 1);
    // 名前らしい語だけを拾う（小文字だけのコマンドは拾わない）
    // 既定では、ヒントなしとヒントありの 2 回書き起こす。ヒントありのほうに、画面の語が入る
    const hinted = on.asr.transcribe.mock.calls.map((c) => c[1].hints).find((h) => h.length) ?? [];
    expect([...hinted].sort()).toEqual(['Grafana', 'Sentry']);
    expect([...(on.history[0].contextTerms ?? [])].sort()).toEqual(['Grafana', 'Sentry']);
  });

  it('辞書に語があるときは、ヒントなしとヒントありの 2 回書き起こし、ヒントが効いた所だけを取り込む', async () => {
    const t = setup({ llm: (req) => formatted(JSON.parse(req.user).raw_text) });
    t.customizations.get().dictionary.push('Docker');
    t.asr.transcribe.mockImplementation(async (_samples: Float32Array, o: TranscribeOptions) => ({
      text: o.hints.length ? '三森の件、Dockerで確認します。' : '見積もりの件、どっかで確認します。',
      elapsedMs: 5,
    }));
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.asr.transcribe.mock.calls.map((c) => c[1].hints)).toEqual([[], ['Docker']]);
    // 辞書の語は取り込み、ヒントに引っ張られた所（見積もり → 三森）は取り込まない
    expect(t.history[0].rawText).toBe('見積もりの件、Dockerで確認します。');
  });

  it('ヒントの使い方を always にすると、ヒントありで 1 回だけ書き起こす', async () => {
    const t = setup({
      settings: { asr: { ...DEFAULT_SETTINGS.asr, tailMs: 0, hintMode: 'always' } },
      llm: (req) => formatted(JSON.parse(req.user).raw_text),
    });
    t.customizations.get().dictionary.push('Docker');
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.asr.transcribe.mock.calls.map((c) => c[1].hints)).toEqual([['Docker']]);
  });

  it('話し終えてから離したら、録音の停止の返事を待たずに進む', async () => {
    const t = setup({ llm: () => formatted('今日は晴れです。') });
    t.helper.stopGate = new Promise(() => undefined); // 返事が来ない
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 0.4)); // 0.4 秒の無音
    await new Promise((r) => setTimeout(r, 10));
    t.helper.hotkey('activate', 'up', 2400);
    await until(() => t.history.length === 1);
    expect(t.helper.pastes).toHaveLength(1);
  });

  it('話している途中で離したら、離した瞬間までの音声が届くのを待つ', async () => {
    const t = setup({ llm: () => formatted('今日は晴れです。') });
    let release!: () => void;
    t.helper.stopGate = new Promise<void>((r) => (release = r));
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    await new Promise((r) => setTimeout(r, 10));
    t.helper.hotkey('activate', 'up', 2000);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.asr.transcribe).not.toHaveBeenCalled();
    release();
    await until(() => t.history.length === 1);
  });

  it('LLM が失敗したら、書き起こしをそのまま貼り付けて知らせる', async () => {
    const t = setup({
      llm: () => {
        throw new Error('boom');
      },
    });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.helper.pastes[0].text).toContain('今日は晴れです');
    expect(t.history[0].formatted).toBe(false);
    expect(t.huds).toContain('LlmFailed');
  });

  it('esc で取り消すと、書き起こしも貼り付けもしない', async () => {
    const t = setup({ llm: () => formatted('x') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(1));
    t.helper.hotkey('cancel', 'down', 900);
    t.helper.hotkey('activate', 'up', 1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.asr.transcribe).not.toHaveBeenCalled();
    expect(t.helper.pastes).toHaveLength(0);
    expect(t.helper.sent.some((m) => m.type === 'audio_stop')).toBe(true);
  });

  it('前の結果の整形中に同じアプリで次の録音を始めたら、前の結果を先に貼り、次の結果をその後に貼る', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({
      llm: async (req) => {
        if (req.user.includes('一つ目')) await gate;
        return formatted(req.user.includes('一つ目') ? '一つ目。' : '二つ目。');
      },
    });
    t.asr.transcribe.mockResolvedValueOnce({ text: '一つ目', elapsedMs: 1 }).mockResolvedValueOnce({ text: '二つ目', elapsedMs: 1 });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.llmCalls.length === 1);
    // 1 つ目の整形を待っている間に 2 つ目を話し終える
    t.helper.hotkey('activate', 'down', 3000);
    t.helper.audio(2, speech(2));
    t.helper.hotkey('activate', 'up', 5000);
    await until(() => t.llmCalls.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    // 2 つ目は整形が終わっても、1 つ目の貼り付けを待つ
    expect(t.helper.pastes).toHaveLength(0);
    release();
    await until(() => t.history.length === 2);
    expect(t.helper.pastes.map((p) => p.text)).toEqual(['一つ目。', '二つ目。']);
    expect(t.history.map((h) => h.paste)).toEqual(['pasted', 'pasted']);
    expect(t.huds).not.toContain('StaleResult');
    expect(t.history[1].timings.pasteWaitMs).toBeGreaterThan(0);
  });

  it('次の録音が別のアプリ向けなら、前の結果は貼らずに履歴へ残す', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({
      llm: async (req) => {
        if (req.user.includes('一つ目')) await gate;
        return formatted(req.user.includes('一つ目') ? '一つ目。' : '二つ目。');
      },
    });
    t.asr.transcribe.mockResolvedValueOnce({ text: '一つ目', elapsedMs: 1 }).mockResolvedValueOnce({ text: '二つ目', elapsedMs: 1 });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.llmCalls.length === 1);
    t.helper.context = { ...t.helper.context, app: { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', pid: 2 } } as ContextPayload;
    t.helper.hotkey('activate', 'down', 3000);
    t.helper.audio(2, speech(2));
    t.helper.hotkey('activate', 'up', 5000);
    await until(() => t.llmCalls.length === 2);
    release();
    await until(() => t.history.length === 2);
    expect(t.helper.pastes.map((p) => p.text)).toEqual(['二つ目。']);
    expect(t.history.find((h) => h.text === '一つ目。')?.paste).toBe('stale');
    expect(t.huds).toContain('StaleResult');
  });

  it('話の間で先に書き起こし、離すまで話さなければその結果を使う', async () => {
    const t = setup({ settings: SPECULATIVE, llm: () => formatted('今日は晴れです。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 0.6));
    // 0.3 秒の間で投機が始まっている
    expect(t.asr.transcribe).toHaveBeenCalledTimes(1);
    expect(t.asr.transcribe.mock.calls[0][0].length).toBe(Math.round(SR * 2.3));
    t.helper.hotkey('activate', 'up', 2600);
    await until(() => t.history.length === 1);
    expect(t.asr.transcribe).toHaveBeenCalledTimes(1);
    expect(t.history[0]).toMatchObject({ text: '今日は晴れです。', paste: 'pasted' });
    expect(t.history[0].timings.speculative).toBe('hit');
    expect(t.history[0].timings.asrDoneMs).toBeTypeOf('number');
  });

  it('ヘルパーが報告した ⌘V の時刻を、離してからの経過に直して履歴に残す', async () => {
    const t = setup({ llm: () => formatted('今日は晴れです。') });
    // hotkey の t と同じ時計で、離してから 150ms 後に ⌘V を送ったことにする
    t.helper.pasteAck = { success: true, landed: 'confirmed', keyPostedAt: 2000 + 150, keyPostedAfterMs: 3, preReadMs: 2 };
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    const tm = t.history[0].timings;
    expect(tm.keyPostedMs).toBeGreaterThanOrEqual(140);
    expect(tm.keyPostedMs).toBeLessThanOrEqual(160);
    expect(tm.ackMs).toBeTypeOf('number');
  });

  it('先に書き起こした後に話したら、その結果は捨てて全体を書き起こし直す', async () => {
    const t = setup({ settings: SPECULATIVE, llm: () => formatted('続けて話した。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 0.4));
    expect(t.asr.transcribe).toHaveBeenCalledTimes(1);
    const specSignal = t.asr.transcribe.mock.calls[0][1].signal!;
    t.helper.audio(1, speech(1));
    // 後から話したので投機は取り消される
    expect(specSignal.aborted).toBe(true);
    t.helper.hotkey('activate', 'up', 3400);
    await until(() => t.history.length === 1);
    const last = t.asr.transcribe.mock.calls[t.asr.transcribe.mock.calls.length - 1][0];
    expect(last.length).toBe(Math.round(SR * 3.4));
    expect(t.history[0].timings.speculative).toBe('miss');
  });

  it('ASR が処理中なら投機しない', async () => {
    const t = setup({ llm: () => formatted('x') });
    t.asr.idle = false;
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 0.5));
    expect(t.asr.transcribe).not.toHaveBeenCalled();
    t.helper.hotkey('activate', 'up', 2500);
    await until(() => t.history.length === 1);
    expect(t.history[0].timings.speculative).toBeUndefined();
  });

  it('確定中に esc を押すと、書き起こし中の ASR も取り消す', async () => {
    const t = setup({ llm: () => formatted('x') });
    t.asr.transcribe.mockImplementation((_s: Float32Array, o: TranscribeOptions) => new Promise((_res, rej) => o.signal?.addEventListener('abort', () => rej(new AsrCancelledError()))));
    t.asr.idle = false;
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(1));
    t.helper.hotkey('activate', 'up', 1000);
    await until(() => t.asr.transcribe.mock.calls.length === 1);
    const signal = t.asr.transcribe.mock.calls[0][1].signal!;
    t.helper.hotkey('cancel', 'down', 1100);
    expect(signal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.helper.pastes).toHaveLength(0);
    expect(t.huds).not.toContain('AsrFailed');
  });

  it('2 秒を超える録音を esc で取り消したら、書き起こさずに音声を履歴に残す', async () => {
    const t = setup({ settings: { saveRecordings: true }, llm: () => formatted('x') });
    t.asr.idle = false;
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(3));
    t.helper.hotkey('cancel', 'down', 3000);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.asr.transcribe).not.toHaveBeenCalled();
    expect(t.history).toHaveLength(1);
    expect(t.history[0]).toMatchObject({ paste: 'cancelled', text: '', audioFile: 'rec.wav' });
    expect(t.history[0].durationSec).toBeCloseTo(3, 1);
    expect(t.huds).toContain('Cancelled');
  });

  it('エラーで録音を閉じたとき（利用者の取り消しでないとき）は、取り消しの通知を出さない', async () => {
    const t = setup({ settings: { saveRecordings: true } });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(3));
    t.helper.emitMsg({ type: 'audio_error', payload: { sessionId: 1, code: 'permission_denied', message: 'x', fatal: true } });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.history[0]).toMatchObject({ paste: 'cancelled' });
    expect(t.huds).not.toContain('Cancelled');
  });

  it('録音中に音声が途絶えたら（engine_failed）、それまでの分を書き起こす', async () => {
    const t = setup({ llm: () => formatted('ここまで。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.emitMsg({ type: 'audio_error', payload: { sessionId: 1, code: 'engine_failed', message: 'no audio received for 2000 ms', fatal: true } });
    await until(() => t.history.length === 1);
    expect(t.history[0].text).toBe('ここまで。');
  });

  it('最初の音声が届いたら micReady を立てて開始音を鳴らし、2.5 秒音が届かなければ知らせて録音を続ける', async () => {
    const t = setup({ settings: { playSounds: true }, llm: () => formatted('x') });
    t.helper.hotkey('activate', 'down', 0);
    expect(t.sounds).toEqual([]);
    t.helper.audio(1, new Float32Array(1600), 0);
    expect(t.sounds).toEqual(['start']);
    expect(t.floaters.some((f) => f.micReady === true)).toBe(true);
    t.helper.audio(1, new Float32Array(SR * 2.5), 0);
    expect(t.huds.filter((h) => h === 'MicNoSignal')).toHaveLength(1);
    t.helper.audio(1, speech(1));
    expect(t.huds.filter((h) => h === 'MicNoSignal')).toHaveLength(1);
    expect(t.controller.isRecording).toBe(true);
  });

  it('音声が届かなくても、開始音は 600ms で鳴らす', async () => {
    const t = setup({ settings: { playSounds: true }, llm: () => formatted('x') });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 700));
    expect(t.sounds).toEqual(['start']);
    t.helper.audio(1, speech(0.2));
    expect(t.sounds).toEqual(['start']);
  });

  it('確定するときに ASR が準備中なら、準備ができるまで待って書き起こす', async () => {
    const t = setup({ llm: () => formatted('待った。') });
    t.asr.ready = false;
    t.asr.waitReady.mockImplementation(async () => {
      t.asr.ready = true;
      return true;
    });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.asr.waitReady).toHaveBeenCalled();
    expect(t.history[0].text).toBe('待った。');
    expect(t.huds).not.toContain('AsrNotReady');
  });

  it('マイクが切り替わっただけ（fatal: false）なら、録音を続ける', async () => {
    const t = setup({ llm: () => formatted('続き。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(1.5));
    t.helper.emitMsg({ type: 'audio_error', payload: { sessionId: 1, code: 'device_lost', message: '内蔵マイクに切り替えました', fatal: false } });
    t.helper.audio(1, speech(1));
    expect(t.huds).toContain('MicrophoneSwitched');
    expect(t.asr.transcribe).not.toHaveBeenCalled();
    t.helper.hotkey('activate', 'up', 3000);
    await until(() => t.history.length === 1);
    expect(t.history[0].durationSec).toBeCloseTo(2.5, 1);
  });

  it('録音中にヘルパーが落ちたら、それまでの分を書き起こす', async () => {
    const t = setup({ llm: () => formatted('ここまで。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.emit('exit');
    await until(() => t.history.length === 1);
    expect(t.huds).toContain('HelperCrashed');
    expect(t.history[0].text).toBe('ここまで。');
    // 次の fn で新しい録音を始められる
    t.helper.hotkey('activate', 'down', 5000);
    expect(t.helper.started).toEqual([1, 2]);
  });

  it('文字を選択して話すと編集モードになり、選択範囲を書き換える', async () => {
    const t = setup({ llm: () => JSON.stringify({ text: 'ご確認をお願いいたします。', deleted: false, unclear: false }) });
    t.helper.context = { ...t.helper.context, field: { ...t.helper.context.field!, selectedText: '確認して' } } as ContextPayload;
    t.asr.transcribe.mockResolvedValue({ text: 'もっと丁寧に', elapsedMs: 1 });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.history[0].mode).toBe('edit');
    expect(t.helper.pastes[0]).toMatchObject({ text: 'ご確認をお願いいたします。', expectSelectedText: '確認して' });
    // 辞書の照合は書き取りのときだけ
    expect(t.customizations.prepareFormatting).not.toHaveBeenCalled();
  });

  it('編集の指示が分からなかったら、書き換えずに履歴に残す（N5）', async () => {
    const t = setup({ llm: () => JSON.stringify({ text: '', deleted: false, unclear: true }) });
    t.helper.context = { ...t.helper.context, field: { ...t.helper.context.field!, selectedText: 'こんにちは 世界\n' } } as ContextPayload;
    t.asr.transcribe.mockResolvedValue({ text: 'あのー', elapsedMs: 1 });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    // 選択の文字数は空白を除いて数える
    expect(t.floaters.filter((f) => f.selectionChars !== undefined).at(-1)?.selectionChars).toBe(7);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.huds).toContain('EditUnclear');
    expect(t.helper.pastes).toHaveLength(0);
    expect(t.history[0]).toMatchObject({ mode: 'edit', text: '', rawText: 'あのー', paste: 'skipped', editUnclear: true });
    expect(t.history[0].selectedText).toBeUndefined();
  });

  it('語彙ヒントと辞書の照合に、入力先の文脈と最近の書き起こしを渡し、照合の結果を整形に使う', async () => {
    const t = setup({ llm: () => formatted('Kubernetes を使います。') });
    t.helper.context = {
      ...t.helper.context,
      windowTitle: 'メモ',
      field: { ...t.helper.context.field!, beforeCursor: '前の文', afterCursor: '後の文' },
    } as ContextPayload;
    t.customizations.prepareFormatting.mockImplementation((raw: string) => ({
      text: raw,
      vocabulary: ['Kubernetes'],
      candidates: [{ heard: 'くばねてす', word: 'Kubernetes' }],
      replaced: 0,
    }));
    t.asr.transcribe.mockResolvedValue({ text: 'くばねてすを使います', elapsedMs: 1 });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    const hintArg = t.customizations.asrHints.mock.calls.at(-1)?.[0] as { context: Record<string, unknown>; recent: unknown[] };
    expect(hintArg.context).toMatchObject({ bundleId: 'com.apple.TextEdit', windowTitle: 'メモ', beforeCursor: '前の文', afterCursor: '後の文' });
    expect(Array.isArray(hintArg.recent)).toBe(true);
    expect(t.customizations.prepareFormatting).toHaveBeenCalledWith('くばねてすを使います', expect.objectContaining({ useLlm: true }));
    // 照合の候補は整形の LLM に渡り、履歴の rawText は書き起こしのまま
    expect(t.llmCalls[0].user).toContain('くばねてす');
    expect(t.llmCalls[0].system).toContain('Kubernetes');
    expect(t.history[0].rawText).toBe('くばねてすを使います');
  });

  it('パスワード欄では、入力欄の文字を語彙ヒントの文脈に入れない', async () => {
    const t = setup({ llm: () => formatted('x') });
    t.helper.context = { ...t.helper.context, field: { ...t.helper.context.field!, isSecure: true, beforeCursor: '秘密' } } as ContextPayload;
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    const hintArg = t.customizations.asrHints.mock.calls.at(-1)?.[0] as { context: Record<string, unknown> };
    expect(hintArg.context.beforeCursor).toBeUndefined();
  });

  it('LLM なしでは、照合で置き換えた文を貼り、履歴の rawText は置き換える前のまま残す', async () => {
    const t = setup();
    t.customizations.prepareFormatting.mockImplementation((raw: string) => ({ text: raw.replace('くばねてす', 'Kubernetes'), vocabulary: [], candidates: [], replaced: 1 }));
    t.asr.transcribe.mockResolvedValue({ text: 'くばねてすを使います', elapsedMs: 1 });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.customizations.prepareFormatting).toHaveBeenCalledWith('くばねてすを使います', expect.objectContaining({ useLlm: false }));
    expect(String(t.helper.pastes[0].text)).toContain('Kubernetes');
    expect(t.history[0].rawText).toBe('くばねてすを使います');
  });

  it('自動修正（textfix）は、LLM なしでは直した文を貼って履歴に残し、LLM には直す前の文と候補を渡す', async () => {
    const TEXTFIX: Partial<Settings> = { textFix: { ...DEFAULT_SETTINGS.textFix, latin: true } };
    // LLM なし: 直した文を貼り、履歴に直した箇所を残す。rawText は書き起こしのまま
    const a = setup({ settings: TEXTFIX, asrText: 'スラックで送ります' });
    a.helper.hotkey('activate', 'down', 0);
    a.helper.audio(1, speech(2));
    a.helper.hotkey('activate', 'up', 2000);
    await until(() => a.history.length === 1);
    expect(String(a.helper.pastes[0].text)).toContain('Slackで送ります');
    expect(a.history[0].autoFixes).toEqual([{ rule: 'latin', before: 'スラック', after: 'Slack' }]);
    expect(a.history[0].rawText).toBe('スラックで送ります');

    // LLM あり: LLM には直す前の文と候補を渡し、LLM の結果を使ったときは履歴に直した箇所を残さない
    const b = setup({ settings: { ...TEXTFIX, llmFastPath: false }, asrText: 'スラックで送ります', llm: () => formatted('Slackで送ります。') });
    b.helper.hotkey('activate', 'down', 0);
    b.helper.audio(1, speech(2));
    b.helper.hotkey('activate', 'up', 2000);
    await until(() => b.history.length === 1);
    const user = JSON.parse(b.llmCalls[0].user) as { raw_text: string; lexicon_candidates?: unknown };
    expect(user.raw_text).toBe('スラックで送ります');
    expect(user.lexicon_candidates).toEqual([{ heard: 'スラック', word: 'Slack' }]);
    expect(b.history[0].autoFixes).toBeUndefined();

    // 止めた箇所（今後は直さない）と、規則がすべてオフのときは直さない
    const c = setup({ settings: { textFix: { ...TEXTFIX.textFix!, blocked: ['latin:スラック'] } }, asrText: 'スラックで送ります' });
    c.helper.hotkey('activate', 'down', 0);
    c.helper.audio(1, speech(2));
    c.helper.hotkey('activate', 'up', 2000);
    await until(() => c.history.length === 1);
    expect(String(c.helper.pastes[0].text)).toContain('スラック');
    expect(c.history[0].autoFixes).toBeUndefined();
  });

  it('書き起こしの確信度の低い字がある発話は、近道に入れずに LLM に回す', async () => {
    const text = '明日の会議は午後からです。';
    const tokens = (p: number): [string, number][] => [
      ['明日の会議は', 0.99],
      ['午後', p],
      ['からです。', 0.99],
    ];
    const sure = setup({ settings: { llmFastPath: true }, asrText: text, llm: () => formatted(text) });
    sure.asr.transcribe.mockResolvedValue({ text, elapsedMs: 1, tokens: tokens(0.98) } as never);
    sure.helper.hotkey('activate', 'down', 0);
    sure.helper.audio(1, speech(2));
    sure.helper.hotkey('activate', 'up', 2000);
    await until(() => sure.history.length === 1);
    expect(sure.llmCalls).toHaveLength(0);
    expect(sure.history[0].fastPath).toBe(true);

    const shaky = setup({ settings: { llmFastPath: true }, asrText: text, llm: () => formatted(text) });
    shaky.asr.transcribe.mockResolvedValue({ text, elapsedMs: 1, tokens: tokens(0.2) } as never);
    shaky.helper.hotkey('activate', 'down', 0);
    shaky.helper.audio(1, speech(2));
    shaky.helper.hotkey('activate', 'up', 2000);
    await until(() => shaky.history.length === 1);
    expect(shaky.llmCalls).toHaveLength(1);
    expect(shaky.history[0].fastPath).toBeUndefined();

    // 0.3 以上 0.5 未満の字は誤りの手がかりにならないので、近道のままにする（LOW_CONFIDENCE）
    const unsure = setup({ settings: { llmFastPath: true }, asrText: text, llm: () => formatted(text) });
    unsure.asr.transcribe.mockResolvedValue({ text, elapsedMs: 1, tokens: tokens(0.4) } as never);
    unsure.helper.hotkey('activate', 'down', 0);
    unsure.helper.audio(1, speech(2));
    unsure.helper.hotkey('activate', 'up', 2000);
    await until(() => unsure.history.length === 1);
    expect(unsure.llmCalls).toHaveLength(0);
    expect(unsure.history[0].fastPath).toBe(true);
  });

  it('ターミナルでは貼り付けの着地確認をしない（PST-3）', async () => {
    const t = setup({ llm: () => formatted('ls -la') });
    t.helper.context = { ...t.helper.context, app: { name: 'Terminal', bundleId: 'com.apple.Terminal', pid: 2 } } as ContextPayload;
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.helper.pastes[0].verifyLanding).toBe(false);
  });

  it('マイクの名前が分かったらフローティングバーに送り、ロックせずに 40 秒押し続けたらロックを案内する', async () => {
    const t = setup();
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.floaters.some((f) => f.micName === 'Mic')).toBe(true);
    t.helper.audio(1, new Float32Array(SR * 39), 0.1);
    expect(t.huds).not.toContain('HoldLongHint');
    t.helper.audio(1, new Float32Array(SR * 1), 0.1);
    expect(t.huds.filter((h) => h === 'HoldLongHint')).toHaveLength(1);
    t.helper.audio(1, new Float32Array(SR * 1), 0.1);
    expect(t.huds.filter((h) => h === 'HoldLongHint')).toHaveLength(1);
  });

  it('貼り付けた直後の手直しから語を学習し、通知する', async () => {
    const t = setup({
      asrText: 'くばねてすを更新しました',
      llm: (req) => (req.user.includes('pairs') ? JSON.stringify({ words: [{ word: 'Kubernetes', add: true }] }) : formatted('くばねてすを更新しました。')),
    });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    const pasteId = t.helper.pastes[0].pasteId as string;
    expect(t.helper.pastes[0].watchMs).toBe(t.settings.learning.watchSeconds * 1000);
    t.helper.emitMsg({
      type: 'field_watch_result',
      payload: { pasteId, before: '', afterPaste: 'くばねてすを更新しました。', final: 'Kubernetesを更新しました。', reason: 'timeout' },
    });
    await until(() => t.learned.length === 1);
    expect(t.learned[0]).toMatchObject({ word: 'Kubernetes', from: 'くばねてす' });
    expect(t.huds).toContain('WordsLearned');
  });

  it('整形の書き換えを元に戻した手直しは、書き換えない語句として覚え、通知する', async () => {
    // 語の単位に切り出すために、本物の単語分割を使う
    const tokenizer = await createLinderaTokenizer(fs.readFileSync(path.join(process.cwd(), 'node_modules/lindera-wasm-ipadic-web/lindera_wasm_bg.wasm')));
    const t = setup({ asrText: 'なんか食べたいものはありますか', llm: () => formatted('何か食べたいものはありますか？'), tokenizer });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    const pasteId = t.helper.pastes[0].pasteId as string;
    t.helper.emitMsg({
      type: 'field_watch_result',
      payload: { pasteId, before: '', afterPaste: '何か食べたいものはありますか？', final: 'なんか食べたいものはありますか？', reason: 'timeout' },
    });
    await until(() => t.remembered.kept.length === 1);
    expect(t.remembered.kept).toEqual([{ phrase: 'なんか', changedTo: '何か' }]);
    expect(t.learned).toEqual([]);
    expect(t.huds).toContain('CorrectionLearned');
  });

  it('パスワード欄では、手直しの監視を頼まない', async () => {
    const t = setup({ llm: () => formatted('ひみつ') });
    t.helper.context = { ...t.helper.context, field: { ...t.helper.context.field!, isSecure: true } } as ContextPayload;
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.helper.pastes[0].watchMs ?? 0).toBe(0);
  });
});
