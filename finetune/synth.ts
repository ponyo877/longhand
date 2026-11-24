/**
 * 学習用の文を、この Mac の合成音声で読み上げて、音声のファイルにする。
 *
 *   npx tsx finetune/synth.ts [--in ~/longhand-eval/ft/sentences.jsonl] [--out ~/longhand-eval/ft] [--jobs 4]
 *
 * - 声は日本語の 9 種類から、文ごとに乱数で選ぶ。話す速さも変える
 * - 前後の無音の長さ、雑音の大きさ、音量を、文ごとに変える（合成音声の音だけに合わせすぎないため）
 * - すでにある音声は作り直さない（途中で止めても、続きから作れる）。
 *   ファイル名に、読み上げる文と声と速さから作った印を入れる。文の一覧を作り直して同じ id の文が変わったときは、
 *   名前が変わるので作り直される（古い音声を、新しい文の音声として使わない）。使わなくなった音声は、最後に消す
 * 合成音声は macOS の say で、端末の中だけで動く。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { decodeWav, encodeWav } from '../src/main/audio/wav';

const run = promisify(execFile);
const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: path.join(os.homedir(), 'longhand-eval', 'ft', 'sentences.jsonl') },
    out: { type: 'string', default: path.join(os.homedir(), 'longhand-eval', 'ft') },
    jobs: { type: 'string', default: '4' },
    limit: { type: 'string' },
  },
});

const VOICES = ['Kyoko', 'Eddy', 'Flo', 'Reed', 'Sandy', 'Shelley', 'Rocko', 'Grandma', 'Grandpa'];
const voiceArg = (v: string) => (v === 'Kyoko' ? v : `${v} (日本語（日本）)`);
/** 話す速さ（1 分あたりの語数の指定）。既定より少し遅い所から、速い所まで */
const RATES = [150, 165, 180, 195, 210, 230];

interface Sentence {
  id: string;
  kind: string;
  text: string;
  say: string;
  terms: string[];
}

/** 文の id から決まる乱数（同じ文は、いつも同じ声と同じ雑音になる） */
function rng(id: string): () => number {
  let s = createHash('sha256').update(id).digest().readUInt32BE(0) & 0x7fffffff || 1;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

async function one(s: Sentence, dir: string): Promise<Record<string, unknown> | null> {
  const r = rng(s.id);
  const voice = VOICES[Math.floor(r() * VOICES.length)];
  const rate = RATES[Math.floor(r() * RATES.length)];
  const lead = 0.05 + r() * 0.3;
  const tail = 0.2 + r() * 0.4;
  const noise = 0.0003 * Math.pow(12, r()); // 0.0003〜0.0036
  const gain = 0.45 + r() * 0.55;
  const tag = createHash('sha256').update(`${s.say}\n${voice}\n${rate}`).digest('hex').slice(0, 8);
  const name = `${s.id}-${tag}.wav`;
  const file = path.join(dir, 'audio', name);
  if (!fs.existsSync(file)) {
    const tmp = path.join(dir, 'tmp', `${s.id}.wav`);
    try {
      // say は、まれに終わらないことがある。時間を切って、その文は飛ばす
      await run('say', ['-v', voiceArg(voice), '-r', String(rate), '--file-format=WAVE', '--data-format=LEI16@16000', '-o', tmp, s.say], { timeout: 60_000 });
    } catch (e) {
      console.error(`読み上げに失敗: ${s.id} ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
    const { samples, sampleRate } = decodeWav(fs.readFileSync(tmp));
    fs.rmSync(tmp, { force: true });
    if (sampleRate !== 16000 || samples.length < 1600) return null;
    const a = Math.round(lead * 16000);
    const b = Math.round(tail * 16000);
    const out = new Float32Array(a + samples.length + b);
    for (let i = 0; i < samples.length; i++) out[a + i] = samples[i] * gain;
    for (let i = 0; i < out.length; i++) out[i] += (r() * 2 - 1) * noise;
    fs.writeFileSync(file, encodeWav(out), { mode: 0o600 });
  }
  const bytes = fs.statSync(file).size;
  return { id: s.id, audio: `audio/${name}`, text: s.text, kind: s.kind, terms: s.terms, voice, rate, durationSec: Math.round(((bytes - 44) / 2 / 16000) * 100) / 100 };
}

async function main(): Promise<void> {
  const dir = args.out!;
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true, mode: 0o700 });
  let list = fs
    .readFileSync(args.in!, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Sentence);
  if (args.limit) list = list.slice(0, Number(args.limit));
  const rows: Record<string, unknown>[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      const row = await one(list[i], dir);
      if (row) rows[i] = row;
      if (++done % 400 === 0) console.log(`${done}/${list.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(args.jobs)) }, worker));
  const ok = rows.filter(Boolean);
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), `${ok.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
  fs.rmSync(path.join(dir, 'tmp'), { recursive: true, force: true });
  // 一覧に無い音声（文が変わる前のもの）を消す。--limit で一部だけを作ったときは、ほかの文の音声を消さない
  if (!args.limit) {
    const keep = new Set(ok.map((r) => path.basename(r.audio as string)));
    for (const f of fs.readdirSync(path.join(dir, 'audio'))) if (f.endsWith('.wav') && !keep.has(f)) fs.rmSync(path.join(dir, 'audio', f), { force: true });
  }
  const sec = ok.reduce((n, r) => n + (r.durationSec as number), 0);
  console.log(`${ok.length} 件（合計 ${(sec / 3600).toFixed(2)} 時間、平均 ${(sec / ok.length).toFixed(1)} 秒）`);
}

void main();
