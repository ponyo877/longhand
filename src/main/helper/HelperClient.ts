import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { AudioStartedPayload, AudioStoppedPayload, ConfigurePayload, HelperToMain, PttState } from '../../shared/protocol';
import { t } from '../i18n';
import { JsonLinesProcess, type Message } from '../JsonLinesProcess';
import { createLogger, helperLog } from '../log';

const log = createLogger('helper');

export type HelperStatus = 'starting' | 'running' | 'restarting' | 'failed';

const HEARTBEAT_MS = 4000;
const HEARTBEAT_TIMEOUT_MS = 2000;
const MAX_MISSED = 3;
const MAX_RESTARTS = 5;
const STABLE_MS = 60_000;

/**
 * Starts the helper and checks that it is alive (CORE-3).
 * Sends a ping every 4 seconds and restarts the helper after 3 missed replies in a row. After a crash it restarts with
 * exponential backoff, and gives up (failed) after 5 failures in a short time. Every restart sends configure and state_sync again.
 */
export class HelperClient extends EventEmitter {
  private proc: JsonLinesProcess | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private missed = 0;
  private restarts = 0;
  private startedAt = 0;
  private stopping = false;
  private lastConfig: ConfigurePayload | null = null;
  private lastPtt: PttState = 'inactive';
  /** The scheduled restart. Only one is kept, so that a restart is never scheduled twice */
  private restartTimer: NodeJS.Timeout | null = null;
  status: HelperStatus = 'starting';
  version = '';

  constructor(private readonly executable: string) {
    super();
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.clearRestartTimer();
    this.detach();
    if (!fs.existsSync(this.executable)) {
      this.setStatus('failed');
      throw new Error(`helper not found: ${this.executable} (build it with npm run build:helper)`);
    }
    this.setStatus(this.restarts ? 'restarting' : 'starting');
    const proc = new JsonLinesProcess('helper', this.executable, [], (line) => helperLog(line));
    this.proc = proc;
    proc.on('message', (m: Message) => this.emit('message', m as HelperToMain));
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal));
    const ready = await proc.start(10000);
    this.version = String((ready.payload as { version?: string }).version ?? '');
    this.startedAt = Date.now();
    this.missed = 0;
    log.info(`helper started (version=${this.version} pid=${proc.pid})`);
    this.setStatus('running');
    if (this.lastConfig) await this.configure(this.lastConfig).catch((e) => log.warn('failed to resend configure', e));
    this.syncState(this.lastPtt);
    this.startHeartbeat();
    this.emit('ready');
  }

  /** Detaches and stops the previous process, so that its events never mix with the new one's */
  private detach(): void {
    const old = this.proc;
    this.proc = null;
    if (!old) return;
    old.removeAllListeners('message');
    if (old.running) old.kill();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private setStatus(s: HelperStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(async () => {
      if (!this.proc?.running) return;
      try {
        await this.proc.request('ping', {}, HEARTBEAT_TIMEOUT_MS);
        this.missed = 0;
        if (Date.now() - this.startedAt > STABLE_MS) this.restarts = 0;
      } catch {
        this.missed++;
        log.warn(`no reply to the helper heartbeat (${this.missed}/${MAX_MISSED})`);
        if (this.missed >= MAX_MISSED) {
          this.missed = 0;
          this.proc?.kill();
        }
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private onExit(proc: JsonLinesProcess, code: number | null, signal: string | null): void {
    if (proc !== this.proc) return;
    this.stopHeartbeat();
    this.emit('exit');
    if (this.stopping) return;
    log.warn(`helper exited (code=${code} signal=${signal})`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    // A failed start gets here twice: from the exit event and from the failed start()
    if (this.restartTimer) return;
    if (this.restarts >= MAX_RESTARTS) {
      log.error('gave up restarting the helper');
      this.setStatus('failed');
      return;
    }
    const delay = 1000 * 2 ** this.restarts;
    this.restarts++;
    this.setStatus('restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.start().catch((e) => {
        log.error('failed to restart the helper', e);
        this.scheduleRestart();
      });
    }, delay);
  }

  /** Restarts by hand from the failed state */
  async restart(): Promise<void> {
    this.clearRestartTimer();
    this.restarts = 0;
    this.stopping = true;
    this.proc?.kill();
    await new Promise((r) => setTimeout(r, 300));
    await this.start();
  }

  async configure(cfg: ConfigurePayload): Promise<{ ok: boolean; errors: string[]; globeSuppressed: boolean }> {
    this.lastConfig = cfg;
    if (!this.proc?.running) return { ok: false, errors: ['helper not running'], globeSuppressed: false };
    const res = await this.proc.request('configure', cfg, 5000);
    return res.payload as { ok: boolean; errors: string[]; globeSuppressed: boolean };
  }

  syncState(ptt: PttState): void {
    this.lastPtt = ptt;
    this.proc?.send('state_sync', { ptt });
  }

  send(type: string, payload: unknown = {}): void {
    this.proc?.send(type, payload);
  }

  async request<T = unknown>(type: string, payload: unknown = {}, timeoutMs = 5000): Promise<T> {
    if (!this.proc?.running) throw new Error(t('engine.helper.notRunning'));
    const res = await this.proc.request(type, payload, timeoutMs).catch((e: unknown) => {
      // These reach the user as the reason of a failed paste or microphone start, so they are shown in the interface language
      const code = (e as { code?: string } | null)?.code;
      if (code === 'timeout') throw new Error(t('engine.helper.requestTimedOut', { what: type, timeoutMs }));
      if (code === 'exited') throw new Error(t('engine.helper.exitedWhileWaiting', { what: type }));
      if (code === 'not_running') throw new Error(t('engine.helper.notRunning'));
      throw e;
    });
    return res.payload as T;
  }

  /** Waits for a message that matches. Fails if the helper exits */
  waitFor(match: (m: HelperToMain) => boolean, timeoutMs: number, what: string): Promise<HelperToMain> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('message', onMessage);
        this.off('exit', onExit);
      };
      const onMessage = (m: HelperToMain) => {
        if (!match(m)) return;
        cleanup();
        resolve(m);
      };
      const onExit = () => {
        cleanup();
        reject(new Error(t('engine.helper.exitedWhileWaiting', { what })));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(t('engine.helper.timedOut', { what, timeoutMs })));
      }, timeoutMs);
      this.on('message', onMessage);
      this.on('exit', onExit);
    });
  }

  /**
   * Starts recording. The result (audio_started or audio_error) is matched by sessionId (see the top of protocol.ts).
   */
  async startAudio(sessionId: number, deviceId: string | null, timeoutMs = 4000): Promise<AudioStartedPayload> {
    if (!this.proc?.running) throw new Error(t('engine.helper.notRunning'));
    const wait = this.waitFor(
      (m) =>
        (m.type === 'audio_started' && m.payload.sessionId === sessionId) ||
        // A failed start (permission_denied, no_device, engine_failed). device_lost is a switch during recording, so it is left out
        (m.type === 'audio_error' && m.payload.sessionId === sessionId && (m.payload.fatal || m.payload.code !== 'device_lost')),
      timeoutMs,
      'audio_started',
    );
    this.send('audio_start', { sessionId, deviceId });
    const m = await wait;
    if (m.type === 'audio_error') throw new Error(t('engine.helper.audioError', { message: m.payload.message, code: m.payload.code }));
    return m.payload as AudioStartedPayload;
  }

  /** Stops recording, and confirms with audio_stopped that every chunk up to the last has been sent */
  async stopAudio(sessionId: number, timeoutMs = 2000): Promise<AudioStoppedPayload> {
    if (!this.proc?.running) throw new Error(t('engine.helper.notRunning'));
    const wait = this.waitFor((m) => m.type === 'audio_stopped' && m.payload.sessionId === sessionId, timeoutMs, 'audio_stopped');
    this.send('audio_stop', { sessionId });
    return (await wait).payload as AudioStoppedPayload;
  }

  get running(): boolean {
    return !!this.proc?.running;
  }

  stop(): void {
    this.stopping = true;
    this.clearRestartTimer();
    this.stopHeartbeat();
    if (this.proc?.running) {
      this.proc.send('shutdown', {});
      this.proc.kill();
    }
  }
}
