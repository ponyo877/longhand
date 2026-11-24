import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioChunkPayload, HelperToMain } from '../../shared/protocol';
import { VirtualInputHelper } from './virtualInput';

class FakeHelper extends EventEmitter {
  running = true;
  requests: { type: string; payload: unknown }[] = [];
  sent: string[] = [];
  syncState = vi.fn();
  async request<T>(type: string, payload: unknown = {}): Promise<T> {
    this.requests.push({ type, payload });
    return (type === 'paste' ? { success: true, keyPostedAt: 1234.5, keyPostedAfterMs: 3.2 } : {}) as T;
  }
  send(type: string): void {
    this.sent.push(type);
  }
}

let real: FakeHelper;
let input: VirtualInputHelper;
let messages: HelperToMain[];

beforeEach(() => {
  vi.useFakeTimers();
  real = new FakeHelper();
  input = new VirtualInputHelper(real);
  messages = [];
  input.on('message', (m: HelperToMain) => messages.push(m));
});

afterEach(() => {
  input.dispose();
  vi.useRealTimers();
});

describe('VirtualInputHelper', () => {
  it('drops hotkeys and audio from the real helper and forwards everything else', () => {
    real.emit('message', { type: 'hotkey', payload: { action: 'activate', phase: 'down', t: 1 } });
    real.emit('message', { type: 'audio_chunk', payload: { sessionId: 1, seq: 0, pcm: '', rms: 0, peak: 0 } });
    real.emit('message', { type: 'front_app', payload: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 1 } });
    expect(messages.map((m) => m.type)).toEqual(['front_app']);
  });

  it('delivers virtual hotkeys', () => {
    input.press('activate', 'down');
    expect(messages[0]).toMatchObject({ type: 'hotkey', payload: { action: 'activate', phase: 'down' } });
  });

  it('refuses to paste before the test window is checked, then pins every paste to its app', async () => {
    await expect(input.request('paste', { pasteId: 'a', text: 'x' })).rejects.toThrow();
    expect(real.requests).toEqual([]);
    input.pinnedBundleId = 'com.github.Electron';
    await input.request('paste', { pasteId: 'b', text: 'x' });
    expect(real.requests[0]).toEqual({ type: 'paste', payload: { pasteId: 'b', text: 'x', expectBundleId: 'com.github.Electron' } });
  });

  it('drops the helper-clock time from the paste reply and keeps the clock-free one', async () => {
    input.pinnedBundleId = 'com.github.Electron';
    expect(await input.request('paste', { pasteId: 'c', text: 'x' })).toEqual({ success: true, keyPostedAfterMs: 3.2 });
  });

  it('streams the queued audio in 100 ms chunks, then quiet noise, without opening the microphone', async () => {
    const audio = new Float32Array(2400).fill(0.5);
    input.setAudio(audio);
    const started = await input.startAudio(7, null);
    expect(started).toMatchObject({ sessionId: 7, transport: 'virtual' });
    vi.advanceTimersByTime(300);
    const chunks = messages.filter((m) => m.type === 'audio_chunk').map((m) => m.payload as AudioChunkPayload);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(chunks[0].peak).toBeCloseTo(0.5);
    expect(chunks[2].peak).toBeLessThan(0.01);
    expect(chunks[2].peak).toBeGreaterThan(0);
    expect(input.audioDelivered).toBe(true);
    expect(real.sent).toEqual([]);
  });

  it('stops streaming on audio_stop and on stopAudio', async () => {
    await input.startAudio(1, null);
    input.send('audio_stop', { sessionId: 1 });
    expect(input.recording).toBe(false);
    await input.startAudio(2, null);
    vi.advanceTimersByTime(200);
    expect(await input.stopAudio(2)).toEqual({ sessionId: 2, status: 'flushed', chunks: 2 });
    vi.advanceTimersByTime(500);
    expect(messages.filter((m) => m.type === 'audio_chunk')).toHaveLength(2);
  });
});
