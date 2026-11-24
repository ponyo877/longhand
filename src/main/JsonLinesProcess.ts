import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

export interface Message {
  type: string;
  id?: string;
  payload: unknown;
}

interface Pending {
  resolve: (m: Message) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/**
 * stdin / stdout の JSON Lines で話す子プロセス。ヘルパーと ASR ワーカーで共用する。
 * - start() は ready を受けるまで待つ
 * - request() は同じ id の応答を待つ。{type: "error"} なら RequestError で失敗する
 * - id のないメッセージは 'message' イベントで流す
 */
export class JsonLinesProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private exited = true;

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly onStderr: (line: string) => void = () => undefined,
  ) {
    super();
  }

  get running(): boolean {
    return !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(readyTimeoutMs = 15000): Promise<Message> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
      this.child = child;
      this.exited = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${this.name} が ${readyTimeoutMs}ms 以内に ready を返しませんでした`));
        this.kill();
      }, readyTimeoutMs);

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        let msg: Message;
        try {
          msg = JSON.parse(line);
        } catch {
          this.onStderr(`[stdout 非 JSON] ${line.slice(0, 200)}`);
          return;
        }
        if (msg.type === 'ready' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(msg);
          return;
        }
        this.dispatch(msg);
      });
      readline.createInterface({ input: child.stderr }).on('line', (line) => this.onStderr(line));
      child.stdin.on('error', () => undefined);
      child.on('error', (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      });
      child.on('exit', (code, signal) => {
        this.exited = true;
        this.child = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new RequestError('exited', `${this.name} が終了しました`));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${this.name} が起動直後に終了しました（code=${code} signal=${signal}）`));
        }
        this.emit('exit', code, signal);
      });
    });
  }

  private dispatch(msg: Message): void {
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'error') {
        const pl = (msg.payload ?? {}) as { code?: string; message?: string };
        p.reject(new RequestError(pl.code ?? 'unknown', pl.message ?? 'error'));
      } else {
        p.resolve(msg);
      }
      return;
    }
    this.emit('message', msg);
  }

  send(type: string, payload: unknown = {}, id?: string): void {
    if (!this.child || this.exited) return;
    this.child.stdin.write(JSON.stringify({ type, id, payload }) + '\n');
  }

  request(type: string, payload: unknown = {}, timeoutMs = 5000): Promise<Message> {
    if (!this.child || this.exited) return Promise.reject(new RequestError('not_running', `${this.name} が動いていません`));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestError('timeout', `${this.name} の ${type} が ${timeoutMs}ms 以内に応答しませんでした`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(type, payload, id);
    });
  }

  kill(): void {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const child = this.child;
    // child.killed は SIGTERM を送った時点で true になるので、終了したかは exitCode と signalCode で見る
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1500).unref();
    child.kill('SIGTERM');
  }
}
