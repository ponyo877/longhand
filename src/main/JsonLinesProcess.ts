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
 * A child process that talks JSON Lines over stdin / stdout. Shared by the helper and the ASR workers.
 * - start() waits until it receives ready
 * - request() waits for the reply with the same id. {type: "error"} fails with a RequestError
 * - messages without an id are emitted as 'message' events
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
        reject(new Error(`${this.name} did not send ready within ${readyTimeoutMs}ms`));
        this.kill();
      }, readyTimeoutMs);

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        let msg: Message;
        try {
          msg = JSON.parse(line);
        } catch {
          this.onStderr(`[stdout non-JSON] ${line.slice(0, 200)}`);
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
          p.reject(new RequestError('exited', `${this.name} exited`));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${this.name} exited right after starting (code=${code} signal=${signal})`));
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
    if (!this.child || this.exited) return Promise.reject(new RequestError('not_running', `${this.name} is not running`));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestError('timeout', `${this.name} did not answer ${type} within ${timeoutMs}ms`));
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
    // child.killed becomes true as soon as SIGTERM is sent, so whether it exited is judged by exitCode and signalCode
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1500).unref();
    child.kill('SIGTERM');
  }
}
