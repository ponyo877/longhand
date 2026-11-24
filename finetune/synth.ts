/**
 * Reads the training sentences aloud with this Mac's speech synthesis and saves them as audio files.
 *
 *   npx tsx finetune/synth.ts [--in ~/longhand-eval/ft/sentences.jsonl] [--out ~/longhand-eval/ft] [--jobs 4]
 *
 * - The voice is picked at random per sentence from the 9 Japanese voices. The speaking rate varies too
 * - Leading and trailing silence, noise level and volume vary per sentence (so as not to overfit to the sound of synthesized speech)
 * - Existing audio is not rebuilt (if stopped midway, it continues where it left off).
 *   The file name includes a tag made from the text read aloud, the voice and the rate. When the sentence list is rebuilt and the
 *   sentence for an id changes, the name changes, so the audio is rebuilt (old audio is never used for a new sentence). Audio no longer
 *   used is deleted at the end
 * Speech synthesis is macOS say and runs on the device only.
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
/** Speaking rates (words per minute), from a little slower than the default to fast */
const RATES = [150, 165, 180, 195, 210, 230];

interface Sentence {
  id: string;
  kind: string;
  text: string;
  say: string;
  terms: string[];
}

/** Random numbers seeded from the sentence id (the same sentence always gets the same voice and noise) */
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
  const noise = 0.0003 * Math.pow(12, r()); // 0.0003 to 0.0036
  const gain = 0.45 + r() * 0.55;
  const tag = createHash('sha256').update(`${s.say}\n${voice}\n${rate}`).digest('hex').slice(0, 8);
  const name = `${s.id}-${tag}.wav`;
  const file = path.join(dir, 'audio', name);
  if (!fs.existsSync(file)) {
    const tmp = path.join(dir, 'tmp', `${s.id}.wav`);
    try {
      // say occasionally never finishes. Time out and skip that sentence
      await run('say', ['-v', voiceArg(voice), '-r', String(rate), '--file-format=WAVE', '--data-format=LEI16@16000', '-o', tmp, s.say], { timeout: 60_000 });
    } catch (e) {
      console.error(`Speech synthesis failed: ${s.id} ${(e as Error).message.slice(0, 80)}`);
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
  // Delete audio not in the list (from before a sentence changed). When only part was built with --limit, keep the other sentences' audio
  if (!args.limit) {
    const keep = new Set(ok.map((r) => path.basename(r.audio as string)));
    for (const f of fs.readdirSync(path.join(dir, 'audio'))) if (f.endsWith('.wav') && !keep.has(f)) fs.rmSync(path.join(dir, 'audio', f), { force: true });
  }
  const sec = ok.reduce((n, r) => n + (r.durationSec as number), 0);
  console.log(`${ok.length} files (${(sec / 3600).toFixed(2)} h in total, ${(sec / ok.length).toFixed(1)} s on average)`);
}

void main();
