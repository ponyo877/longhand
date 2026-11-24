#!/usr/bin/env node
// ASR ワーカーの動作確認。ワーカーを起動し、モデルを読み込み、音声を 3 本と 1 秒の無音を書き起こして、結果と時間を表示する。
//
//   node asr/tools/smoke.mjs                                   # 既定: longhand-asr-whisper + large-v3-turbo q8_0、評価セットの先頭 3 本
//   node asr/tools/smoke.mjs --engine apple                    # longhand-asr-apple（modelPath は空）
//   node asr/tools/smoke.mjs --engine parakeet
//   node asr/tools/smoke.mjs --worker <path> --model <path> --options '{"beamSize":1}' --hints "Slack,Electron" a.wav b.wav
//
// 音声を指定しなければ ~/longhand-eval/datasets/user-v1/manifest.jsonl の先頭 3 本を使う（ない場合は音声の指定が必要）。
// 1 本目は pcm（base64 Float32）、残りは wavPath で送り、両方の経路を確かめる。

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ASR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(homedir(), 'Library/Application Support/Longhand/models');
const ENGINES = {
  whisper: { worker: join(ASR_DIR, 'build/longhand-asr-whisper'), model: join(MODELS, 'whisper/ggml-large-v3-turbo-q8_0.bin') },
  apple: { worker: join(ASR_DIR, 'build/longhand-asr-apple'), model: '' },
  parakeet: { worker: join(ASR_DIR, 'build/longhand-asr-parakeet'), model: join(MODELS, 'parakeet-ja') },
};

function parseArgs(argv) {
  const a = { engine: 'whisper', options: '{}', language: 'ja', hints: '', files: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--engine') a.engine = argv[++i];
    else if (k === '--worker') a.worker = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--options') a.options = argv[++i];
    else if (k === '--language') a.language = argv[++i];
    else if (k === '--hints') a.hints = argv[++i];
    else if (k === '-h' || k === '--help') {
      console.log(
        readFileSync(fileURLToPath(import.meta.url), 'utf8')
          .split('\n')
          .slice(1, 10)
          .join('\n'),
      );
      process.exit(0);
    } else a.files.push(k);
  }
  const e = ENGINES[a.engine];
  if (!e) throw new Error(`unknown engine: ${a.engine}`);
  a.worker ??= e.worker;
  a.model ??= e.model;
  return a;
}

// 16 kHz モノラル 16bit の WAV を Float32 に変換する
function wavToFloat32(path) {
  const buf = readFileSync(path);
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const len = buf.readUInt32LE(pos + 4);
    if (id === 'data') {
      const n = Math.floor(Math.min(len, buf.length - pos - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(pos + 8 + i * 2) / 32768;
      return out;
    }
    pos += 8 + len + (len & 1);
  }
  throw new Error(`no data chunk: ${path}`);
}

const b64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');

class Worker {
  constructor(cmd) {
    this.p = spawn(cmd, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.queue = [];
    this.waiters = [];
    this.stderr = '';
    this.p.stderr.on('data', (d) => (this.stderr += d));
    createInterface({ input: this.p.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`!! stdout にプロトコル以外の行: ${line.slice(0, 200)}`);
        return;
      }
      const w = this.waiters.shift();
      w ? w(msg) : this.queue.push(msg);
    });
    this.exited = new Promise((r) => this.p.on('exit', (code) => r(code)));
    this.n = 0;
  }
  next() {
    return this.queue.length ? Promise.resolve(this.queue.shift()) : new Promise((r) => this.waiters.push(r));
  }
  async request(type, payload) {
    const id = String(++this.n);
    const t0 = performance.now();
    this.p.stdin.write(JSON.stringify({ type, id, payload }) + '\n');
    for (;;) {
      const m = await this.next();
      if (m.id === id) return [m, performance.now() - t0];
    }
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  let files = a.files;
  if (files.length === 0) {
    const manifest = join(homedir(), 'longhand-eval/datasets/user-v1/manifest.jsonl');
    if (!existsSync(manifest)) throw new Error('音声ファイルを指定してください（評価セットが見つからない）');
    files = readFileSync(manifest, 'utf8')
      .trim()
      .split('\n')
      .slice(0, 3)
      .map((l) => join(dirname(manifest), JSON.parse(l).audio));
  }
  const hints = a.hints
    ? a.hints
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  console.log(`worker: ${a.worker}\nmodel:  ${a.model || '(OS)'}`);
  const t0 = performance.now();
  const w = new Worker(a.worker);
  const ready = await w.next();
  console.log(`ready:  ${JSON.stringify(ready.payload)} (${(performance.now() - t0).toFixed(0)} ms)`);

  const [loaded, loadMs] = await w.request('load', { modelPath: a.model, language: a.language, options: JSON.parse(a.options) });
  if (loaded.type !== 'loaded') {
    console.error(`load failed: ${JSON.stringify(loaded.payload)}\n--- stderr ---\n${w.stderr}`);
    process.exit(1);
  }
  console.log(`loaded: ${loaded.payload.model} (worker ${loaded.payload.elapsedMs} ms, wall ${loadMs.toFixed(0)} ms)\n`);

  const [pong, pingMs] = await w.request('ping', {});
  console.log(`ping:   ${pong.type} (${pingMs.toFixed(1)} ms)`);

  let failed = false;
  for (const [i, f] of files.entries()) {
    const pcm = wavToFloat32(f);
    const payload = i === 0 ? { pcm: b64(pcm), language: a.language, hints } : { wavPath: f, language: a.language, hints };
    const [res, ms] = await w.request('transcribe', payload);
    const sec = pcm.length / 16000;
    if (res.type !== 'result') {
      failed = true;
      console.log(`[${i === 0 ? 'pcm' : 'wav'}] ${f}: ERROR ${JSON.stringify(res.payload)}`);
      continue;
    }
    console.log(`[${i === 0 ? 'pcm' : 'wav'}] ${sec.toFixed(1)} s → ${ms.toFixed(0)} ms (worker ${res.payload.elapsedMs} ms, RTF ${(ms / 1000 / sec).toFixed(3)})`);
    console.log(`      ${res.payload.text}`);
  }

  const [sil, silMs] = await w.request('transcribe', { pcm: b64(new Float32Array(16000)), language: a.language });
  const silOk = sil.type === 'result' && sil.payload.text === '';
  console.log(`[silence 1 s] ${JSON.stringify(sil.payload.text)} (${silMs.toFixed(0)} ms) ${silOk ? 'OK' : 'NG（空であるべき）'}`);
  const [bad] = await w.request('transcribe', { language: a.language });
  console.log(`[no audio] ${bad.type} ${bad.payload?.code ?? ''}`);

  w.p.stdin.end();
  const code = await w.exited;
  console.log(`\nexit on EOF: code ${code}`);
  process.exit(failed || !silOk || code !== 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
