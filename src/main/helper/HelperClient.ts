import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { AudioStartedPayload, AudioStoppedPayload, ConfigurePayload, HelperToMain, PttState } from '../../shared/protocol';
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
 * ヘルパーの起動と死活監視（CORE-3）。
 * 4 秒ごとに ping を送り、3 回続けて応答がなければ再起動する。異常終了したら指数バックオフで再起動し、
 * 短時間に 5 回失敗したらあきらめて failed にする。再起動のたびに configure と state_sync を送り直す。
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
  /** 予約中の再起動。二重に予約しないよう 1 つだけ持つ */
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
      throw new Error(`ヘルパーが見つかりません: ${this.executable}（npm run build:helper でビルドしてください）`);
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
    log.info(`ヘルパーを起動しました（version=${this.version} pid=${proc.pid}）`);
    this.setStatus('running');
    if (this.lastConfig) await this.configure(this.lastConfig).catch((e) => log.warn('configure の再送に失敗', e));
    this.syncState(this.lastPtt);
    this.startHeartbeat();
    this.emit('ready');
  }

  /** 前のプロセスを切り離して止める。古いプロセスのイベントが新しいものと混ざらないようにする */
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
        log.warn(`ヘルパーの heartbeat に応答がありません（${this.missed}/${MAX_MISSED}）`);
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
    log.warn(`ヘルパーが終了しました（code=${code} signal=${signal}）`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    // 起動の失敗では、終了の通知と start() の失敗の両方からここに来る
    if (this.restartTimer) return;
    if (this.restarts >= MAX_RESTARTS) {
      log.error('ヘルパーの再起動を諦めました');
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
        log.error('ヘルパーの再起動に失敗しました', e);
        this.scheduleRestart();
      });
    }, delay);
  }

  /** 失敗した状態から手動で起動し直す */
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
    if (!this.proc?.running) throw new Error('ヘルパーが動いていません');
    const res = await this.proc.request(type, payload, timeoutMs);
    return res.payload as T;
  }

  /** 条件に合うメッセージが届くまで待つ。ヘルパーが終了したら失敗にする */
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
        reject(new Error(`${what} を待つ間にヘルパーが終了しました`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`helper の ${what} が ${timeoutMs}ms 以内に届きませんでした`));
      }, timeoutMs);
      this.on('message', onMessage);
      this.on('exit', onExit);
    });
  }

  /**
   * 録音を始める。結果（audio_started か audio_error）は sessionId で突き合わせる（protocol.ts の冒頭を参照）。
   */
  async startAudio(sessionId: number, deviceId: string | null, timeoutMs = 4000): Promise<AudioStartedPayload> {
    if (!this.proc?.running) throw new Error('ヘルパーが動いていません');
    const wait = this.waitFor(
      (m) =>
        (m.type === 'audio_started' && m.payload.sessionId === sessionId) ||
        // 開始の失敗（permission_denied、no_device、engine_failed）。device_lost は録音中の切り替えなので除く
        (m.type === 'audio_error' && m.payload.sessionId === sessionId && (m.payload.fatal || m.payload.code !== 'device_lost')),
      timeoutMs,
      'audio_started',
    );
    this.send('audio_start', { sessionId, deviceId });
    const m = await wait;
    if (m.type === 'audio_error') throw new Error(`${m.payload.message}（${m.payload.code}）`);
    return m.payload as AudioStartedPayload;
  }

  /** 録音を止め、最後のチャンクまで出し切ったことを audio_stopped で確かめる */
  async stopAudio(sessionId: number, timeoutMs = 2000): Promise<AudioStoppedPayload> {
    if (!this.proc?.running) throw new Error('ヘルパーが動いていません');
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
