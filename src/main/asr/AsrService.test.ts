import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { AsrCancelledError, AsrService, resolveModel } from './AsrService';

let dir: string;
const cfg = (engine: string, modelPath = '') => ({ ...DEFAULT_SETTINGS.asr, engine, modelPath });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-models-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('resolveModel', () => {
  it('prefers the model set in the settings', () => {
    expect(resolveModel(cfg('whisper', '/x/model.bin'), dir)?.modelPath).toBe('/x/model.bin');
  });

  it('resolves a relative path in default.json from the engine folder', () => {
    fs.mkdirSync(path.join(dir, 'whisper'));
    fs.writeFileSync(path.join(dir, 'whisper', 'default.json'), JSON.stringify({ modelPath: 'm.bin', options: { beam: 1 } }));
    const r = resolveModel(cfg('whisper'), dir)!;
    expect(r.modelPath).toBe(path.join(dir, 'whisper', 'm.bin'));
    expect(r.options).toEqual({ beam: 1 });
  });

  it('looks for the default model placed by the download script when there is no default.json', () => {
    fs.mkdirSync(path.join(dir, 'whisper'));
    fs.writeFileSync(path.join(dir, 'whisper', 'ggml-large-v3-turbo-q8_0.bin'), '');
    expect(resolveModel(cfg('whisper'), dir)?.modelPath).toBe(path.join(dir, 'whisper', 'ggml-large-v3-turbo-q8_0.bin'));
    fs.mkdirSync(path.join(dir, 'parakeet-ja'));
    expect(resolveModel(cfg('parakeet'), dir)?.modelPath).toBe(path.join(dir, 'parakeet-ja'));
  });

  it('looks in the folder bundled with the app when the user folder has no model', () => {
    const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-bundled-'));
    try {
      fs.mkdirSync(path.join(bundled, 'whisper'));
      fs.writeFileSync(path.join(bundled, 'whisper', 'ggml-large-v3-turbo-q8_0.bin'), '');
      expect(resolveModel(cfg('whisper'), dir, bundled)?.modelPath).toBe(path.join(bundled, 'whisper', 'ggml-large-v3-turbo-q8_0.bin'));
      // A model in the user folder takes precedence
      fs.mkdirSync(path.join(dir, 'whisper'));
      fs.writeFileSync(path.join(dir, 'whisper', 'ggml-large-v3-turbo-q8_0.bin'), '');
      expect(resolveModel(cfg('whisper'), dir, bundled)?.modelPath).toBe(path.join(dir, 'whisper', 'ggml-large-v3-turbo-q8_0.bin'));
    } finally {
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });

  it('returns null without a model, and an empty path for apple, whose model the OS holds', () => {
    expect(resolveModel(cfg('whisper'), dir)).toBeNull();
    expect(resolveModel(cfg('apple'), dir)?.modelPath).toBe('');
  });
});

/**
 * A fake worker. transcribe takes 300ms and returns "#<order received>"; a cancel cancels the requests received so far.
 * As with the real worker, a cancel only affects the requests received before it.
 */
const FAKE_WORKER = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let received = 0, cancelUpTo = 0, busy = false;
const queue = [];
function next() {
  if (busy || !queue.length) return;
  const m = queue.shift();
  if (m.type === 'load') { send({ type: 'loaded', id: m.id, payload: { elapsedMs: 1, model: 'fake' } }); return next(); }
  if (m.type !== 'transcribe') return next();
  if (cancelUpTo >= m.seq) { send({ type: 'error', id: m.id, payload: { code: 'cancelled', message: 'cancelled' } }); return next(); }
  busy = true;
  const timer = setInterval(() => {
    if (cancelUpTo >= m.seq) finish({ type: 'error', id: m.id, payload: { code: 'cancelled', message: 'cancelled' } });
  }, 10);
  const done = setTimeout(() => finish({ type: 'result', id: m.id, payload: { text: '#' + m.seq, elapsedMs: 300 } }), 300);
  function finish(msg) { clearInterval(timer); clearTimeout(done); busy = false; send(msg); next(); }
}
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'cancel') { cancelUpTo = received; return; }
  m.seq = ++received;
  queue.push(m);
  next();
});
send({ type: 'ready', payload: { engine: 'fake', version: '0', protocol: 1 } });
`;

describe('AsrService cancellation', () => {
  let svc: AsrService;
  beforeEach(async () => {
    const worker = path.join(dir, 'longhand-asr-fake');
    fs.writeFileSync(worker, FAKE_WORKER, { mode: 0o755 });
    const model = path.join(dir, 'model.bin');
    fs.writeFileSync(model, '');
    svc = new AsrService(
      () => ({ ...DEFAULT_SETTINGS.asr, engine: 'fake', workerPath: worker, modelPath: model }),
      () => worker,
      dir,
      () => 'ja',
    );
    await svc.start();
    expect(svc.ready).toBe(true);
    // Wait for the warm-up at startup to finish
    await svc.transcribe(new Float32Array(160), { language: 'ja', hints: [], timeoutMs: 5000 });
  });
  afterEach(() => svc.stop());

  const audio = new Float32Array(1600);
  const opts = (signal?: AbortSignal) => ({ language: 'ja' as const, hints: [], timeoutMs: 5000, signal });

  it('fails at once with AsrCancelledError when canceled in progress, and the next request does not wait', async () => {
    const ac = new AbortController();
    const a = svc.transcribe(audio, opts(ac.signal));
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    ac.abort();
    await expect(a).rejects.toBeInstanceOf(AsrCancelledError);
    const b = await svc.transcribe(audio, opts());
    // Without the cancel, b would wait for the remaining 250ms of a and then take 300ms
    expect(Date.now() - t0).toBeLessThan(500);
    expect(b.text).toMatch(/^#\d+$/);
  });

  it('does not send a request canceled while still in the queue to the worker', async () => {
    const first = svc.transcribe(audio, opts());
    const ac = new AbortController();
    const second = svc.transcribe(audio, opts(ac.signal));
    ac.abort();
    await expect(second).rejects.toBeInstanceOf(AsrCancelledError);
    await first;
    const third = await svc.transcribe(audio, opts());
    // The second request was never sent, so the number the worker gives the third comes right after the first
    expect(Number(third.text.slice(1)) - Number((await first).text.slice(1))).toBe(1);
  });

  it('sets idle back to true when no request is queued or in progress', async () => {
    expect(svc.idle).toBe(true);
    const p = svc.transcribe(audio, opts());
    expect(svc.idle).toBe(false);
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.idle).toBe(true);
  });
});
