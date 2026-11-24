import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelDownloader, type ModelFile } from './ModelDownloader';

let dir: string;
const body = Buffer.from('0123456789'.repeat(1000));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const FILE: ModelFile = { path: 'whisper/model.bin', urlPath: '/repo/model.bin', sha256: sha(body), size: body.length };

function stream(b: Buffer, failAfter?: number): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream({
    pull(c) {
      if (failAfter !== undefined && pos >= failAfter) return c.error(new Error('connection reset'));
      if (pos >= b.length) return c.close();
      const end = Math.min(b.length, pos + 1000, failAfter ?? Infinity);
      c.enqueue(new Uint8Array(b.subarray(pos, end)));
      pos = end;
    },
  });
}

interface Call {
  url: string;
  range?: string;
}

/** A fake fetch that follows a list of behaviors, one per call */
function fakeFetch(plan: ((range: number) => Response)[], calls: Call[]) {
  return async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ url, range: init.headers.Range });
    const start = init.headers.Range ? Number(/bytes=(\d+)-/.exec(init.headers.Range)![1]) : 0;
    const step = plan.shift();
    if (!step) throw new Error('unexpected fetch');
    return step(start);
  };
}

const ok206 = (b: Buffer) => (start: number) => new Response(stream(b.subarray(start)), { status: start ? 206 : 200 });
const cut = (b: Buffer, at: number) => (start: number) => new Response(stream(b.subarray(start), at - start), { status: start ? 206 : 200 });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-dl-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const make = (fetch: ReturnType<typeof fakeFetch>, free = 10 * 1024 ** 3) => new ModelDownloader({ modelsDir: dir, fetch, files: [FILE], freeBytes: () => free, sleep: async () => undefined });

describe('ModelDownloader', () => {
  it('downloads, checks the hash and puts the file in place', async () => {
    const calls: Call[] = [];
    const d = make(fakeFetch([ok206(body)], calls));
    expect(d.installed()).toBe(false);
    expect(await d.download('https://mirror.example/')).toBe(true);
    expect(calls[0].url).toBe('https://mirror.example/repo/model.bin');
    expect(fs.readFileSync(path.join(dir, FILE.path))).toEqual(body);
    expect(d.state).toMatchObject({ state: 'done', installed: true });
  });

  it('waits and retries after a cut-off download, resuming after the part already received', async () => {
    const calls: Call[] = [];
    const states: string[] = [];
    const d = make(fakeFetch([cut(body, 4000), ok206(body)], calls));
    d.on('change', (s) => states.push(s.state));
    expect(await d.download('https://h')).toBe(true);
    expect(calls.map((c) => c.range)).toEqual([undefined, 'bytes=4000-']);
    expect(states).toContain('waiting');
    expect(fs.readFileSync(path.join(dir, FILE.path))).toEqual(body);
  });

  it('starts over when the server ignores Range', async () => {
    const calls: Call[] = [];
    const d = make(fakeFetch([cut(body, 4000), () => new Response(stream(body), { status: 200 })], calls));
    expect(await d.download('https://h')).toBe(true);
    expect(fs.readFileSync(path.join(dir, FILE.path))).toEqual(body);
  });

  it('retries without placing the file when the hash does not match, and fails if it still does not match', async () => {
    const bad = Buffer.from(body);
    bad[10] = 0x41;
    const calls: Call[] = [];
    const d = make(
      fakeFetch(
        Array.from({ length: 6 }, () => ok206(bad)),
        calls,
      ),
    );
    expect(await d.download('https://h')).toBe(false);
    expect(d.state.state).toBe('failed');
    expect(d.state.error).toContain('SHA-256');
    expect(fs.existsSync(path.join(dir, FILE.path))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${FILE.path}.part`))).toBe(false);
  });

  it('fails at once on 404, which waiting does not fix', async () => {
    const calls: Call[] = [];
    const d = make(fakeFetch([() => new Response('nf', { status: 404 })], calls));
    expect(await d.download('https://h')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(d.state.error).toContain('404');
  });

  it('does not download without enough free space', async () => {
    const calls: Call[] = [];
    const d = make(fakeFetch([ok206(body)], calls), 100);
    expect(await d.download('https://h')).toBe(false);
    expect(calls).toHaveLength(0);
    expect(d.state.error).toContain('Not enough free space');
  });

  it('can be canceled, keeping the partial file and resuming from it next time', async () => {
    const calls: Call[] = [];
    let d!: ModelDownloader;
    const slow = (start: number) => {
      let pos = start;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (pos >= 3000) {
              d.cancel();
              return new Promise(() => undefined);
            }
            c.enqueue(new Uint8Array(body.subarray(pos, pos + 1000)));
            pos += 1000;
          },
        }),
        { status: 200 },
      );
    };
    d = make(fakeFetch([slow, ok206(body)], calls));
    const p = d.download('https://h');
    expect(await p).toBe(false);
    expect(d.state.state).toBe('cancelled');
    expect(fs.statSync(path.join(dir, `${FILE.path}.part`)).size).toBe(3000);
    expect(await d.download('https://h')).toBe(true);
    expect(calls[1].range).toBe('bytes=3000-');
  });

  it('treats models bundled with the app as installed', () => {
    const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-bundled-'));
    try {
      fs.mkdirSync(path.join(bundled, 'whisper'));
      fs.writeFileSync(path.join(bundled, FILE.path), body);
      const d = new ModelDownloader({ modelsDir: dir, bundledDir: bundled, fetch: fakeFetch([], []), files: [FILE] });
      expect(d.installed()).toBe(true);
      expect(d.state).toMatchObject({ installed: true, bundled: true });
    } finally {
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });

  it('imports files and folders downloaded on another computer after checking their hashes', async () => {
    const d = make(fakeFetch([], []));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-src-'));
    try {
      fs.writeFileSync(path.join(src, 'model.bin'), body);
      fs.writeFileSync(path.join(src, 'other.txt'), 'x');
      const r1 = await d.importFrom([path.join(src, 'other.txt')]);
      expect(r1).toEqual({ imported: [], rejected: ['other.txt'] });
      const r2 = await d.importFrom([src]);
      expect(r2.imported).toEqual(['model.bin']);
      expect(d.installed()).toBe(true);
      // Different contents are not imported
      fs.writeFileSync(path.join(src, 'model.bin'), 'broken');
      fs.rmSync(path.join(dir, FILE.path));
      const r3 = await d.importFrom([path.join(src, 'model.bin')]);
      expect(r3).toEqual({ imported: [], rejected: ['model.bin'] });
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });
});
