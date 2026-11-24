#!/usr/bin/env node
// LonghandHelper の動作確認用ハーネス（Node 24、依存なし）。
//
//   node helper/tools/harness.mjs                 対話モード（コマンドか JSON を 1 行ずつ打つ）
//   node helper/tools/harness.mjs ping ctx "rec 2" 引数のコマンドを順に実行して終了する
//
// オプション:
//   --bin <path>   ヘルパーの実行ファイル（既定: helper/build/LonghandHelper.app/Contents/MacOS/LonghandHelper）
//   --debug        LONGHAND_HELPER_DEBUG=1 で起動する（キー入力を stderr に出す）
//   --chunks       audio_chunk を 1 件ずつ表示する（既定は 10 件ごと）
//   --quiet        ヘルパーの stderr を表示しない
//
// コマンド:
//   ping | conf [globe] | state <inactive|active|locked|finalizing> | perm [accessibility|microphone]
//   devices | ctx [nofield] | paste <text> | pastew <watchMs> <text> | rec <sec> [deviceId]
//   record on|off | sleep <ms> | raw <json> | {json...} | quit

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opts = { bin: path.join(here, '..', 'build', 'LonghandHelper.app', 'Contents', 'MacOS', 'LonghandHelper'), debug: false, chunks: false, quiet: false };
const commands = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--bin') opts.bin = args[++i];
  else if (a === '--debug') opts.debug = true;
  else if (a === '--chunks') opts.chunks = true;
  else if (a === '--quiet') opts.quiet = true;
  else commands.push(a);
}

const t0 = performance.now();
const ts = () => ((performance.now() - t0) / 1000).toFixed(3).padStart(7);
const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);

const child = spawn(opts.bin, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...(opts.debug ? { LONGHAND_HELPER_DEBUG: '1' } : {}) },
});
child.on('error', (e) => {
  console.error(`failed to start ${opts.bin}: ${e.message}`);
  process.exit(1);
});

let exited = false;
const exitPromise = new Promise((resolve) => {
  child.on('exit', (code, signal) => {
    exited = true;
    console.log(color(90, `${ts()} helper exited code=${code} signal=${signal ?? ''}`));
    resolve(code);
  });
});

// --- 受信 -----------------------------------------------------------------
const waiters = [];
let nextId = 1;
const chunkStats = new Map(); // sessionId -> {count, samples, rmsSum, peak, firstAt}

function waitFor(pred, timeoutMs = 5000, label = 'response') {
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) {
        waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, timeoutMs);
  });
}

function onMessage(msg) {
  if (msg.type === 'audio_chunk') {
    const p = msg.payload;
    const st = chunkStats.get(p.sessionId) ?? { count: 0, samples: 0, rmsSum: 0, peak: 0, firstAt: performance.now() };
    st.count++;
    st.samples += Buffer.from(p.pcm, 'base64').length / 4;
    st.rmsSum += p.rms;
    st.peak = Math.max(st.peak, p.peak);
    chunkStats.set(p.sessionId, st);
    if (opts.chunks || p.seq % 10 === 0) {
      console.log(color(36, `${ts()} < audio_chunk session=${p.sessionId} seq=${p.seq} samples=${Buffer.from(p.pcm, 'base64').length / 4} rms=${p.rms} peak=${p.peak}`));
    }
  } else {
    const text = JSON.stringify(msg);
    console.log(color(32, `${ts()} < ${text.length > 1500 ? text.slice(0, 1500) + '…' : text}`));
  }
  for (const w of [...waiters]) {
    if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  }
}

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    onMessage(JSON.parse(line));
  } catch {
    console.log(color(31, `${ts()} < (non-JSON on stdout!) ${line}`));
  }
});
createInterface({ input: child.stderr }).on('line', (line) => {
  if (!opts.quiet) console.log(color(90, `${ts()} ! ${line}`));
});

// --- 送信 -----------------------------------------------------------------
function send(type, payload = {}, id) {
  const msg = { type, payload };
  if (id !== undefined) msg.id = id;
  const text = JSON.stringify(msg);
  console.log(color(33, `${ts()} > ${text.length > 300 ? text.slice(0, 300) + '…' : text}`));
  child.stdin.write(text + '\n');
}

async function request(type, payload, responseType, timeoutMs = 5000) {
  const id = `h${nextId++}`;
  const p = waitFor((m) => m.id === id && (m.type === responseType || m.type === 'error'), timeoutMs, responseType);
  send(type, payload, id);
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sessionSeq = 1;

const defaultHotkeys = {
  activate: [['Fn']],
  lock: [['Fn', 'Space']],
  cancel: [['Escape']],
  paste_last: [['Meta', 'Control', 'KeyV']],
};

async function run(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('{')) {
    child.stdin.write(trimmed + '\n');
    console.log(color(33, `${ts()} > ${trimmed}`));
    return;
  }
  const [cmd, ...rest] = trimmed.split(/\s+/);
  const restText = trimmed.slice(cmd.length).trim();
  switch (cmd) {
    case 'ping': {
      const t = performance.now();
      await request('ping', {}, 'pong');
      console.log(`pong in ${(performance.now() - t).toFixed(1)}ms`);
      break;
    }
    case 'conf':
      await request('configure', { hotkeys: defaultHotkeys, suppressGlobe: rest[0] === 'globe' }, 'configured');
      break;
    case 'state':
      send('state_sync', { ptt: rest[0] ?? 'inactive' });
      break;
    case 'perm':
      await request('permissions', rest[0] ? { prompt: rest[0] } : {}, 'permissions', 130000);
      break;
    case 'devices':
      await request('list_audio_devices', {}, 'audio_devices', 10000);
      break;
    case 'ctx':
      await request('get_context', { includeField: rest[0] !== 'nofield', includeHost: true, maxContextChars: 200 }, 'context');
      break;
    case 'paste':
    case 'pastew': {
      let watchMs = 0;
      let text = restText;
      if (cmd === 'pastew') {
        watchMs = Number(rest[0]);
        text = restText.slice(rest[0].length).trim();
      }
      const ack = await request(
        'paste',
        {
          pasteId: `p${Date.now()}`,
          text,
          verifyLanding: true,
          avoidClipboardHistory: true,
          watchMs,
        },
        'paste_ack',
        15000,
      );
      console.log(`paste: success=${ack.payload.success} landed=${ack.payload.landed} retried=${ack.payload.retried} reason=${ack.payload.failureReason ?? '-'} ${ack.payload.elapsedMs}ms`);
      if (watchMs > 0 && ack.payload.success) {
        const r = await waitFor((m) => m.type === 'field_watch_result' && m.payload.pasteId === ack.payload.pasteId, watchMs + 3000, 'field_watch_result').catch((e) => e);
        if (r instanceof Error) console.log(r.message);
      }
      break;
    }
    case 'rec': {
      const secs = Number(rest[0] ?? 2);
      const sessionId = sessionSeq++;
      const t = performance.now();
      const startedP = waitFor((m) => (m.type === 'audio_started' || m.type === 'audio_error') && m.payload.sessionId === sessionId, 130000, 'audio_started');
      send('audio_start', { sessionId, deviceId: rest[1] ?? null });
      const started = await startedP;
      const startMs = performance.now() - t;
      if (started.type === 'audio_error') {
        console.log(`rec: audio_error ${started.payload.code}: ${started.payload.message}`);
        break;
      }
      await sleep(secs * 1000);
      const stopT = performance.now();
      const stoppedP = waitFor((m) => m.type === 'audio_stopped' && m.payload.sessionId === sessionId, 5000, 'audio_stopped');
      send('audio_stop', { sessionId });
      const stopped = await stoppedP;
      const st = chunkStats.get(sessionId) ?? { count: 0, samples: 0, rmsSum: 0, peak: 0, firstAt: NaN };
      console.log(
        `rec: started in ${startMs.toFixed(0)}ms, first chunk after ${(st.firstAt - t).toFixed(0)}ms, stop took ${(performance.now() - stopT).toFixed(0)}ms; ` +
          `status=${stopped.payload.status} chunks=${st.count} (reported ${stopped.payload.chunks}) samples=${st.samples} ` +
          `(${(st.samples / 16000).toFixed(2)}s) meanRms=${(st.rmsSum / Math.max(1, st.count)).toFixed(4)} peak=${st.peak.toFixed(4)}`,
      );
      break;
    }
    case 'record':
      send('record_shortcut', { active: rest[0] !== 'off' });
      break;
    case 'sleep':
      await sleep(Number(rest[0] ?? 1000));
      break;
    case 'raw':
      child.stdin.write(restText + '\n');
      break;
    case 'quit':
    case 'shutdown':
      send('shutdown', {});
      await Promise.race([exitPromise, sleep(4000)]);
      break;
    default:
      console.log(`unknown command: ${cmd}`);
  }
}

// --- 実行 -----------------------------------------------------------------
await waitFor((m) => m.type === 'ready', 10000, 'ready').catch((e) => {
  console.error(e.message);
  child.kill();
  process.exit(1);
});

if (commands.length > 0) {
  for (const c of commands) {
    try {
      await run(c);
    } catch (e) {
      console.log(color(31, `error: ${e.message}`));
    }
  }
  if (!exited) await run('quit');
  process.exit(exited ? 0 : 1);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    try {
      await run(line);
    } catch (e) {
      console.log(color(31, `error: ${e.message}`));
    }
    if (exited) process.exit(0);
    rl.prompt();
  });
  rl.on('close', async () => {
    if (!exited) await run('quit');
    process.exit(0);
  });
}
