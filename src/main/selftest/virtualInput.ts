/**
 * Stands in for the keyboard and the microphone in the end-to-end self-test (selftest/e2e.ts).
 *
 * The dictation controller talks to this object instead of the helper. Everything else goes to the real helper, so reading the
 * focused field, pasting and landing checks run for real. Two things are replaced:
 *
 * - Hotkeys come from press(), as if the helper had matched a shortcut. No key event is posted to the system, so other apps
 *   listening on the same key (another dictation app, for example) see nothing.
 * - Audio comes from samples given to setAudio(), in 100 ms chunks at real-time pace. The microphone is never opened.
 *
 * Hotkeys and audio from the real helper are dropped while the test runs, and every paste is pinned to the test window's app,
 * so a paste can never land in another app even if the user switches apps during the test.
 */
import { EventEmitter } from 'node:events';
import type { AudioStartedPayload, AudioStoppedPayload, HelperToMain, HotkeyAction, PasteAckPayload, PttState } from '../../shared/protocol';
import type { HelperPort } from '../session/DictationController';

const SR = 16000;
const CHUNK = SR / 10;
/** Level of the background noise after the queued audio. Quiet for voice activity detection, but not digital silence (which raises the "no signal" warning) */
const NOISE = 0.001;

/** The parts of the real helper this object forwards to */
export type RealHelper = Pick<HelperPort, 'on' | 'running' | 'syncState' | 'request' | 'send'>;

/**
 * Milliseconds on Node's monotonic clock, for the time of a virtual key event. The helper's clock (CLOCK_UPTIME_RAW) stops while
 * the Mac sleeps and this one does not, so the two differ by the total time asleep. The controller only compares key times with
 * each other, except for keyPostedAt in the paste reply, which request() drops for that reason.
 */
const keyClock = () => Number(process.hrtime.bigint() / 1_000_000n);

interface Stream {
  sessionId: number;
  timer: NodeJS.Timeout;
  pos: number;
  seq: number;
  noise: number;
}

export class VirtualInputHelper extends EventEmitter {
  private audio: Float32Array = new Float32Array(0);
  private stream: Stream | null = null;
  /** Bundle ID that every paste must land in. Set by the test once it has checked that its window is in front */
  pinnedBundleId: string | null = null;

  constructor(private readonly real: RealHelper) {
    super();
    real.on('message', (m: HelperToMain) => {
      // The real keyboard and microphone stay out of the test
      if (m.type === 'hotkey' || m.type.startsWith('audio_')) return;
      this.emit('message', m);
    });
    real.on('exit', (...args: unknown[]) => this.emit('exit', ...args));
  }

  get running(): boolean {
    return this.real.running;
  }

  syncState(ptt: PttState): void {
    this.real.syncState(ptt);
  }

  request<T = unknown>(type: string, payload: unknown = {}, timeoutMs = 5000): Promise<T> {
    if (type !== 'paste') return this.real.request<T>(type, payload, timeoutMs);
    if (!this.pinnedBundleId) return Promise.reject(new Error('self-test: paste before the test window was checked'));
    // keyPostedAt is on the helper's clock, which the virtual key times are not. keyPostedAfterMs needs no clock
    return this.real.request<PasteAckPayload>(type, { ...(payload as object), expectBundleId: this.pinnedBundleId }, timeoutMs).then(({ keyPostedAt: _, ...ack }) => ack as T);
  }

  send(type: string, payload: unknown = {}): void {
    if (type === 'audio_stop') {
      this.finish((payload as { sessionId: number }).sessionId);
      return;
    }
    if (type === 'audio_start') return;
    this.real.send(type, payload);
  }

  async startAudio(sessionId: number, _deviceId: string | null, _timeoutMs?: number): Promise<AudioStartedPayload> {
    if (this.stream) this.finish(this.stream.sessionId);
    const stream: Stream = { sessionId, pos: 0, seq: 0, noise: 1, timer: setInterval(() => this.tick(), CHUNK / (SR / 1000)) };
    this.stream = stream;
    return { sessionId, deviceId: 'longhand-selftest', deviceName: 'Self-test audio', transport: 'virtual' };
  }

  async stopAudio(sessionId: number, _timeoutMs?: number): Promise<AudioStoppedPayload> {
    return this.finish(sessionId);
  }

  // --- Controls for the test ----------------------------------------------------------

  /** Audio for the next recordings (16 kHz mono). After it runs out, quiet noise follows */
  setAudio(samples: Float32Array): void {
    this.audio = samples;
  }

  /** Delivers a hotkey event, as the helper does when a shortcut is pressed or released */
  press(action: HotkeyAction, phase: 'down' | 'up'): void {
    this.emit('message', { type: 'hotkey', payload: { action, phase, t: keyClock() } } satisfies HelperToMain);
  }

  /** Whether all of the queued audio has been delivered to the current recording (true when nothing is recording) */
  get audioDelivered(): boolean {
    return !this.stream || this.stream.pos >= this.audio.length;
  }

  get recording(): boolean {
    return !!this.stream;
  }

  dispose(): void {
    if (this.stream) this.finish(this.stream.sessionId);
  }

  private tick(): void {
    const s = this.stream;
    if (!s) return;
    const chunk = new Float32Array(CHUNK);
    const take = this.audio.subarray(s.pos, s.pos + CHUNK);
    chunk.set(take);
    for (let i = take.length; i < CHUNK; i++) {
      // A small deterministic noise generator (xorshift), so that runs are repeatable
      s.noise ^= s.noise << 13;
      s.noise ^= s.noise >>> 17;
      s.noise ^= s.noise << 5;
      chunk[i] = ((s.noise >>> 0) / 0xffffffff - 0.5) * 2 * NOISE;
    }
    s.pos += CHUNK;
    let sum = 0;
    let peak = 0;
    for (const v of chunk) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const pcm = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64');
    this.emit('message', { type: 'audio_chunk', payload: { sessionId: s.sessionId, seq: s.seq++, pcm, rms: Math.sqrt(sum / CHUNK), peak } } satisfies HelperToMain);
  }

  private finish(sessionId: number): AudioStoppedPayload {
    const s = this.stream;
    const chunks = s?.sessionId === sessionId ? s.seq : 0;
    if (s && s.sessionId === sessionId) {
      clearInterval(s.timer);
      this.stream = null;
    }
    return { sessionId, status: 'flushed', chunks };
  }
}
