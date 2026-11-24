import fs from 'node:fs';
import path from 'node:path';

/**
 * Local logs (OPS-3). Writes main.log and helper.log to ~/Library/Logs/Longhand/, rotating at 5MB and keeping 3 generations.
 * API keys and transcript text never go into the logs. Callers do not pass the text, and on top of that,
 * strings that look like keys are masked here too.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const MAX_BYTES = 5 * 1024 * 1024;
const GENERATIONS = 3;

class LogFile {
  private stream: fs.WriteStream | null = null;
  private size = 0;

  constructor(private readonly file: string) {}

  write(line: string): void {
    try {
      if (!this.stream) this.open();
      if (this.size > MAX_BYTES) this.rotate();
      this.stream!.write(line);
      this.size += Buffer.byteLength(line);
    } catch {
      // A logging failure must not stop the app
    }
  }

  private open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
  }

  private rotate(): void {
    this.stream?.end();
    this.stream = null;
    for (let i = GENERATIONS - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    this.open();
  }
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/sk-[A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/((?:api[-_]?key|authorization|x-api-key)["'\s:=]+(?:Bearer\s+)?)[A-Za-z0-9._-]{12,}/gi, '$1<redacted>'],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

let mainFile: LogFile | null = null;
let helperFile: LogFile | null = null;
let asrFile: LogFile | null = null;

export function initLogs(dir: string): void {
  mainFile = new LogFile(path.join(dir, 'main.log'));
  helperFile = new LogFile(path.join(dir, 'helper.log'));
  asrFile = new LogFile(path.join(dir, 'asr.log'));
}

function fmt(level: Level, scope: string, msg: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  let tail = '';
  if (extra !== undefined) {
    try {
      tail = ' ' + (extra instanceof Error ? `${extra.name}: ${extra.message}` : JSON.stringify(extra));
    } catch {
      tail = ' [unserializable]';
    }
  }
  return redact(`${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}\n`);
}

export function createLogger(scope: string) {
  const write = (level: Level, msg: string, extra?: unknown) => {
    const line = fmt(level, scope, msg, extra);
    mainFile?.write(line);
    if (process.env.NODE_ENV !== 'production' || level !== 'debug') {
      (level === 'error' ? process.stderr : process.stdout).write(line);
    }
  };
  return {
    debug: (m: string, e?: unknown) => write('debug', m, e),
    info: (m: string, e?: unknown) => write('info', m, e),
    warn: (m: string, e?: unknown) => write('warn', m, e),
    error: (m: string, e?: unknown) => write('error', m, e),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function helperLog(line: string): void {
  helperFile?.write(redact(`${new Date().toISOString()} ${line}\n`));
}

export function asrLog(line: string): void {
  asrFile?.write(redact(`${new Date().toISOString()} ${line}\n`));
}
