/**
 * Integration tests for DictationController. With fake helper, ASR, LLM and stores,
 * they feed in hotkey and audio events and check everything through to the paste and the history.
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
  /** Replaced to delay the reply to stopping the recording */
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

/** Speculative transcription during pauses is off by default, so its tests turn it on explicitly */
const SPECULATIVE: Partial<Settings> = { asr: { ...DEFAULT_SETTINGS.asr, speculative: true, tailMs: 0 } };
/** Settings that keep recording after the key is released */
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
    numbers: [] as { kind: string; value: string; before: string; after: string }[],
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
    // Learning that adds no dictionary word (misheard forms, correction pairs, kept phrases). Treats everything passed in as remembered
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
    addNumberStyles: vi.fn((n: { kind: string; value: string; before: string; after: string }[]) => {
      remembered.numbers.push(...n);
      return n.map((x) => ({ kind: x.kind, value: x.value, example: { before: x.before, after: x.after } }));
    }),
    undoLearnedWord: vi.fn(),
    removeMisheardForm: vi.fn(),
    removePastCorrection: vi.fn(),
    removeKeptPhrase: vi.fn(),
    setNumberStyle: vi.fn(),
  };
  const history: HistoryItem[] = [];
  const huds: string[] = [];
  const hudVars: { key: string; vars?: Record<string, string> }[] = [];
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
      hud: (k: string, vars?: Record<string, string>) => {
        huds.push(k);
        hudVars.push({ key: k, vars });
      },
      sound: (n: string) => sounds.push(n),
      preconnect: () => undefined,
    },
    provider: () => provider,
    tokenizer: () => opts.tokenizer ?? null,
  } as unknown as ControllerDeps;
  const controller = new DictationController(deps);
  return { controller, helper, asr, history, huds, hudVars, llmCalls, learned, remembered, settings, floaters, sounds, customizations };
}

/** Waits until async work has progressed */
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

  it('transcribes push-to-talk speech, pastes the formatted text and saves it to the history', async () => {
    const t = setup({ llm: () => formatted('今日は晴れです。') });
    t.helper.hotkey('activate', 'down', 0);
    expect(t.helper.started).toEqual([1]);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.helper.pastes).toHaveLength(1);
    expect(t.helper.pastes[0].text).toBe('今日は晴れです。');
    expect(t.history[0]).toMatchObject({ rawText: 'えーと今日は晴れです', text: '今日は晴れです。', paste: 'pasted', formatted: true });
    // Formatting gets the transcript and the target app's name
    expect(t.llmCalls[0].user).toContain('えーと今日は晴れです');
    expect(t.llmCalls[0].user).toContain('TextEdit');
  });

  it('includes audio that arrives after release when recording continues after release, and saves how long it continued', async () => {
    const t = setup({ settings: TAIL, llm: () => formatted('今日は晴れです。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    await new Promise((r) => setTimeout(r, 10));
    t.helper.hotkey('activate', 'up', 2000);
    // Right after release, recording has not stopped yet (it waits for the end of the sentence)
    await new Promise((r) => setTimeout(r, 40));
    expect(t.asr.transcribe).not.toHaveBeenCalled();
    t.helper.audio(1, speech(0.1)); // audio that arrived after release
    await until(() => t.history.length === 1);
    const samples = t.asr.transcribe.mock.calls[0][0];
    expect(samples.length).toBe(SR * 2.1);
    expect(t.history[0].timings.postRollMs).toBe(120);
  });

  it('does not continue recording after release when the user was silent for at least 1 second before releasing', async () => {
    const t = setup({ settings: TAIL, llm: () => formatted('今日は晴れです。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 1.2)); // 1.2 seconds of silence
    await new Promise((r) => setTimeout(r, 10));
    t.helper.hotkey('activate', 'up', 3200);
    await until(() => t.history.length === 1);
    expect(t.history[0].timings.postRollMs).toBeUndefined();
  });

  it('adds words picked from the screen text to the speech recognition hints only when the setting is on, and saves them to the history when recordings are kept', async () => {
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
    // Only name-like words are picked (lowercase-only commands are not)
    // By default it transcribes twice, without and with hints. The screen words are in the run with hints
    const hinted = on.asr.transcribe.mock.calls.map((c) => c[1].hints).find((h) => h.length) ?? [];
    expect([...hinted].sort()).toEqual(['Grafana', 'Sentry']);
    expect([...(on.history[0].contextTerms ?? [])].sort()).toEqual(['Grafana', 'Sentry']);
  });

  it('transcribes twice, without and with hints, when the dictionary has words, and takes only the spots where the hints helped', async () => {
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
    // Takes the dictionary word, but not the spot the hints pulled off course (見積もり → 三森)
    expect(t.history[0].rawText).toBe('見積もりの件、Dockerで確認します。');
  });

  it('transcribes once with hints when the hint mode is always', async () => {
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

  it('goes on without waiting for the stop reply when released after speech has ended', async () => {
    const t = setup({ llm: () => formatted('今日は晴れです。') });
    t.helper.stopGate = new Promise(() => undefined); // the reply never comes
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 0.4)); // 0.4 seconds of silence
    await new Promise((r) => setTimeout(r, 10));
    t.helper.hotkey('activate', 'up', 2400);
    await until(() => t.history.length === 1);
    expect(t.helper.pastes).toHaveLength(1);
  });

  it('waits for the audio up to the release when released mid-speech', async () => {
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

  it('pastes the transcript as is and notifies when the LLM fails', async () => {
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

  it('explains a failed paste in words instead of the helper code', async () => {
    const t = setup();
    t.helper.pasteAck = { success: false, failureReason: 'app_changed' };
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.history[0].paste).toBe('failed');
    expect(t.hudVars.find((h) => h.key === 'PasteFailed')?.vars).toEqual({ reason: 'The app in front changed before the text was pasted' });
  });

  it('neither transcribes nor pastes after a cancel with esc', async () => {
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

  it('pastes the previous result first and the next one after it when a new recording in the same app starts while the previous one is formatting', async () => {
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
    // The second recording finishes while the first is waiting for formatting
    t.helper.hotkey('activate', 'down', 3000);
    t.helper.audio(2, speech(2));
    t.helper.hotkey('activate', 'up', 5000);
    await until(() => t.llmCalls.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    // The second waits for the first paste even after its formatting is done
    expect(t.helper.pastes).toHaveLength(0);
    release();
    await until(() => t.history.length === 2);
    expect(t.helper.pastes.map((p) => p.text)).toEqual(['一つ目。', '二つ目。']);
    expect(t.history.map((h) => h.paste)).toEqual(['pasted', 'pasted']);
    expect(t.huds).not.toContain('StaleResult');
    expect(t.history[1].timings.pasteWaitMs).toBeGreaterThan(0);
  });

  it('keeps the previous result in the history without pasting when the next recording targets another app', async () => {
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

  it('transcribes ahead during a pause and uses that result when nothing more is said before release', async () => {
    const t = setup({ settings: SPECULATIVE, llm: () => formatted('今日は晴れです。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 0.6));
    // Speculation has started at the 0.3-second pause
    expect(t.asr.transcribe).toHaveBeenCalledTimes(1);
    expect(t.asr.transcribe.mock.calls[0][0].length).toBe(Math.round(SR * 2.3));
    t.helper.hotkey('activate', 'up', 2600);
    await until(() => t.history.length === 1);
    expect(t.asr.transcribe).toHaveBeenCalledTimes(1);
    expect(t.history[0]).toMatchObject({ text: '今日は晴れです。', paste: 'pasted' });
    expect(t.history[0].timings.speculative).toBe('hit');
    expect(t.history[0].timings.asrDoneMs).toBeTypeOf('number');
  });

  it('saves the ⌘V time reported by the helper as time since release', async () => {
    const t = setup({ llm: () => formatted('今日は晴れです。') });
    // Pretend ⌘V was sent 150 ms after release, on the same clock as the hotkey's t
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

  it('discards the speculative result and transcribes everything again when the user speaks after it', async () => {
    const t = setup({ settings: SPECULATIVE, llm: () => formatted('続けて話した。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.audio(1, new Float32Array(SR * 0.4));
    expect(t.asr.transcribe).toHaveBeenCalledTimes(1);
    const specSignal = t.asr.transcribe.mock.calls[0][1].signal!;
    t.helper.audio(1, speech(1));
    // The user spoke afterwards, so the speculation is canceled
    expect(specSignal.aborted).toBe(true);
    t.helper.hotkey('activate', 'up', 3400);
    await until(() => t.history.length === 1);
    const last = t.asr.transcribe.mock.calls[t.asr.transcribe.mock.calls.length - 1][0];
    expect(last.length).toBe(Math.round(SR * 3.4));
    expect(t.history[0].timings.speculative).toBe('miss');
  });

  it('does not speculate while ASR is busy', async () => {
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

  it('also cancels ASR in progress when esc is pressed while finalizing', async () => {
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

  it('keeps the audio in the history without transcribing when a recording longer than 2 seconds is canceled with esc', async () => {
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

  it('shows no cancel notification when an error closes the recording (not a cancel by the user)', async () => {
    const t = setup({ settings: { saveRecordings: true } });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(3));
    t.helper.emitMsg({ type: 'audio_error', payload: { sessionId: 1, code: 'permission_denied', message: 'x', fatal: true } });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.history[0]).toMatchObject({ paste: 'cancelled' });
    expect(t.huds).not.toContain('Cancelled');
  });

  it('transcribes what was recorded when audio stops during recording (engine_failed)', async () => {
    const t = setup({ llm: () => formatted('ここまで。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.emitMsg({ type: 'audio_error', payload: { sessionId: 1, code: 'engine_failed', message: 'no audio received for 2000 ms', fatal: true } });
    await until(() => t.history.length === 1);
    expect(t.history[0].text).toBe('ここまで。');
  });

  it('sets micReady and plays the start sound on the first audio, and notifies but keeps recording when no sound arrives for 2.5 seconds', async () => {
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

  it('plays the start sound after 600 ms even if no audio arrives', async () => {
    const t = setup({ settings: { playSounds: true }, llm: () => formatted('x') });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 700));
    expect(t.sounds).toEqual(['start']);
    t.helper.audio(1, speech(0.2));
    expect(t.sounds).toEqual(['start']);
  });

  it('waits for ASR to be ready and then transcribes when it is still getting ready at finalization', async () => {
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

  it('keeps recording when the microphone only switched (fatal: false)', async () => {
    const t = setup({ llm: () => formatted('続き。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(1.5));
    t.helper.emitMsg({ type: 'audio_error', payload: { sessionId: 1, code: 'device_lost', message: 'switched to the built-in microphone', fatal: false } });
    t.helper.audio(1, speech(1));
    expect(t.huds).toContain('MicrophoneSwitched');
    expect(t.asr.transcribe).not.toHaveBeenCalled();
    t.helper.hotkey('activate', 'up', 3000);
    await until(() => t.history.length === 1);
    expect(t.history[0].durationSec).toBeCloseTo(2.5, 1);
  });

  it('transcribes what was recorded when the helper crashes while recording', async () => {
    const t = setup({ llm: () => formatted('ここまで。') });
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.emit('exit');
    await until(() => t.history.length === 1);
    expect(t.huds).toContain('HelperCrashed');
    expect(t.history[0].text).toBe('ここまで。');
    // The next fn press can start a new recording
    t.helper.hotkey('activate', 'down', 5000);
    expect(t.helper.started).toEqual([1, 2]);
  });

  it('enters edit mode when speaking with text selected, and rewrites the selection', async () => {
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
    // Dictionary matching happens only when dictating
    expect(t.customizations.prepareFormatting).not.toHaveBeenCalled();
  });

  it('keeps an unclear edit instruction in the history without rewriting (N5)', async () => {
    const t = setup({ llm: () => JSON.stringify({ text: '', deleted: false, unclear: true }) });
    t.helper.context = { ...t.helper.context, field: { ...t.helper.context.field!, selectedText: 'こんにちは 世界\n' } } as ContextPayload;
    t.asr.transcribe.mockResolvedValue({ text: 'あのー', elapsedMs: 1 });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    // The selection length is counted without whitespace
    expect(t.floaters.filter((f) => f.selectionChars !== undefined).at(-1)?.selectionChars).toBe(7);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.huds).toContain('EditUnclear');
    expect(t.helper.pastes).toHaveLength(0);
    expect(t.history[0]).toMatchObject({ mode: 'edit', text: '', rawText: 'あのー', paste: 'skipped', editUnclear: true });
    expect(t.history[0].selectedText).toBeUndefined();
  });

  it('passes the input target context and recent transcripts to vocabulary hints and dictionary matching, and uses the match results in formatting', async () => {
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
    // Match candidates go to the formatting LLM, and rawText in the history stays the transcript
    expect(t.llmCalls[0].user).toContain('くばねてす');
    expect(t.llmCalls[0].system).toContain('Kubernetes');
    expect(t.history[0].rawText).toBe('くばねてすを使います');
  });

  it('leaves input field text out of the vocabulary hint context in password fields', async () => {
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

  it('pastes the text replaced by matching without the LLM, and keeps rawText in the history as before the replacement', async () => {
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

  it('pastes and records the textfix result without the LLM, and passes the original text and candidates to the LLM', async () => {
    const TEXTFIX: Partial<Settings> = { textFix: { ...DEFAULT_SETTINGS.textFix, latin: true } };
    // Without the LLM: paste the fixed text and record the fixes in the history. rawText stays the transcript
    const a = setup({ settings: TEXTFIX, asrText: 'スラックで送ります' });
    a.helper.hotkey('activate', 'down', 0);
    a.helper.audio(1, speech(2));
    a.helper.hotkey('activate', 'up', 2000);
    await until(() => a.history.length === 1);
    expect(String(a.helper.pastes[0].text)).toContain('Slackで送ります');
    expect(a.history[0].autoFixes).toEqual([{ rule: 'latin', before: 'スラック', after: 'Slack' }]);
    expect(a.history[0].rawText).toBe('スラックで送ります');

    // With the LLM: pass the original text and candidates to the LLM, and record no fixes in the history when the LLM result is used
    const b = setup({ settings: { ...TEXTFIX, llmFastPath: false }, asrText: 'スラックで送ります', llm: () => formatted('Slackで送ります。') });
    b.helper.hotkey('activate', 'down', 0);
    b.helper.audio(1, speech(2));
    b.helper.hotkey('activate', 'up', 2000);
    await until(() => b.history.length === 1);
    const user = JSON.parse(b.llmCalls[0].user) as { raw_text: string; lexicon_candidates?: unknown };
    expect(user.raw_text).toBe('スラックで送ります');
    expect(user.lexicon_candidates).toEqual([{ heard: 'スラック', word: 'Slack' }]);
    expect(b.history[0].autoFixes).toBeUndefined();

    // No fixes at blocked spots (never fix again), or when all rules are off
    const c = setup({ settings: { textFix: { ...TEXTFIX.textFix!, blocked: ['latin:スラック'] } }, asrText: 'スラックで送ります' });
    c.helper.hotkey('activate', 'down', 0);
    c.helper.audio(1, speech(2));
    c.helper.hotkey('activate', 'up', 2000);
    await until(() => c.history.length === 1);
    expect(String(c.helper.pastes[0].text)).toContain('スラック');
    expect(c.history[0].autoFixes).toBeUndefined();
  });

  it('sends an utterance with low-confidence characters to the LLM instead of the fast path', async () => {
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

    // Characters from 0.3 up to 0.5 are no sign of an error, so the fast path stays (LOW_CONFIDENCE)
    const unsure = setup({ settings: { llmFastPath: true }, asrText: text, llm: () => formatted(text) });
    unsure.asr.transcribe.mockResolvedValue({ text, elapsedMs: 1, tokens: tokens(0.4) } as never);
    unsure.helper.hotkey('activate', 'down', 0);
    unsure.helper.audio(1, speech(2));
    unsure.helper.hotkey('activate', 'up', 2000);
    await until(() => unsure.history.length === 1);
    expect(unsure.llmCalls).toHaveLength(0);
    expect(unsure.history[0].fastPath).toBe(true);
  });

  it('skips the paste landing check in a terminal (PST-3)', async () => {
    const t = setup({ llm: () => formatted('ls -la') });
    t.helper.context = { ...t.helper.context, app: { name: 'Terminal', bundleId: 'com.apple.Terminal', pid: 2 } } as ContextPayload;
    t.helper.hotkey('activate', 'down', 0);
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    expect(t.helper.pastes[0].verifyLanding).toBe(false);
  });

  it('sends the microphone name to the floating bar once known, and shows the lock hint after holding for 40 seconds without locking', async () => {
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

  it('learns a word from a correction right after pasting, and notifies', async () => {
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

  it('remembers a correction that undoes a formatting change as a phrase to keep, and notifies', async () => {
    // Use the real tokenizer to cut out whole words
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

  it('learns a correction of how a number is written, and says so', async () => {
    const t = setup({ asrText: 'お願いが2つあります', llm: () => formatted('お願いが2つあります。') });
    t.helper.hotkey('activate', 'down', 0);
    await new Promise((r) => setTimeout(r, 10));
    t.helper.audio(1, speech(2));
    t.helper.hotkey('activate', 'up', 2000);
    await until(() => t.history.length === 1);
    const pasteId = t.helper.pastes[0].pasteId as string;
    t.helper.emitMsg({
      type: 'field_watch_result',
      payload: { pasteId, before: '', afterPaste: 'お願いが2つあります。', final: 'お願いが二つあります。', reason: 'timeout' },
    });
    await until(() => t.remembered.numbers.length === 1);
    expect(t.remembered.numbers[0]).toMatchObject({ kind: 'counters', value: 'kanji' });
    expect(t.learned).toEqual([]);
    expect(t.huds).toContain('NumberStyleLearned');
  });

  it('does not ask to watch for corrections in password fields', async () => {
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
