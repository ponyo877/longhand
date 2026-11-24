/**
 * Builds a small dataset for regression checks from public read speech (the Japanese part of FLEURS, CC-BY 4.0).
 *
 *   npx tsx scripts/eval-import-public.ts
 *
 * The goal is to watch that tuning for one person's voice does not make other voices worse.
 * It is a separate dataset (fleurs-ja-v1) from the local user's recordings, and only the speech recognition error rate and the share
 * broken by formatting are looked at.
 *
 * Prerequisite: put the following two files in ~/longhand-eval/public/fleurs-ja/ and extract the audio into extract/.
 *   https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976/data/ja_jp/dev.tsv
 *   https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976/data/ja_jp/audio/dev.tar.gz
 * Source: Conneau et al., "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech" (google/fleurs).
 *
 * The selection is deterministic (the same input gives the same result). One recording is picked per sentence, preferring a female
 * speaker when there is one (the original distribution leans male).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeWav } from '../src/main/audio/wav';

const ROOT = path.join(os.homedir(), 'longhand-eval');
const SRC = path.join(ROOT, 'public', 'fleurs-ja');
const OUT = path.join(ROOT, 'datasets', 'fleurs-ja-v1');
const TRUTH = path.join(ROOT, 'truth.jsonl');

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Converts 16-bit PCM and 32-bit float WAV to Float32 (FLEURS is 32-bit float) */
function readWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  let o = 12;
  let format = 1;
  let channels = 1;
  let sampleRate = 16000;
  let bits = 16;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      format = buf.readUInt16LE(o + 8);
      channels = buf.readUInt16LE(o + 10);
      sampleRate = buf.readUInt32LE(o + 12);
      bits = buf.readUInt16LE(o + 22);
    } else if (id === 'data') {
      const bytes = bits / 8;
      const n = Math.floor(Math.min(size, buf.length - o - 8) / bytes / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const at = o + 8 + i * bytes * channels;
        if (format === 3 && bits === 32) out[i] = buf.readFloatLE(at);
        else if (format === 1 && bits === 16) out[i] = buf.readInt16LE(at) / 0x8000;
        else throw new Error(`Unsupported WAV format (format=${format}, bits=${bits})`);
      }
      return { samples: out, sampleRate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV data chunk not found');
}

interface Entry {
  sentenceId: string;
  file: string;
  text: string;
  gender: string;
}

function main(): void {
  const tsv = path.join(SRC, 'dev.tsv');
  const audioDir = path.join(SRC, 'extract', 'dev');
  if (!fs.existsSync(tsv) || !fs.existsSync(audioDir)) {
    console.error(`${SRC} has no dev.tsv and extract/dev/. See the comment at the top of this file.`);
    process.exit(1);
  }
  const entries: Entry[] = fs
    .readFileSync(tsv, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.split('\t'))
    .map((c) => ({ sentenceId: c[0], file: c[1], text: c[2], gender: c[6] ?? '' }))
    .filter((e) => fs.existsSync(path.join(audioDir, e.file)));

  // One per sentence: the female recording if there is one, otherwise the smallest file name
  const bySentence = new Map<string, Entry[]>();
  for (const e of entries) bySentence.set(e.sentenceId, [...(bySentence.get(e.sentenceId) ?? []), e]);
  const picked = [...bySentence.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, list]) => list.sort((a, b) => Number(b.gender === 'FEMALE') - Number(a.gender === 'FEMALE') || a.file.localeCompare(b.file))[0]);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true, mode: 0o700 });
  const rows: string[] = [];
  const truth: string[] = [];
  const now = new Date().toISOString();
  let seconds = 0;
  for (const e of picked) {
    const wav = readWav(fs.readFileSync(path.join(audioDir, e.file)));
    if (wav.sampleRate !== 16000) throw new Error(`${e.file}: not 16 kHz (${wav.sampleRate})`);
    const id = `fleurs_${path.basename(e.file, '.wav')}`;
    const pcm = encodeWav(wav.samples);
    fs.writeFileSync(path.join(OUT, 'audio', `${id}.wav`), pcm, { mode: 0o600 });
    const hash = sha256(pcm);
    const durationSec = Math.round((wav.samples.length / 16000) * 10) / 10;
    seconds += durationSec;
    rows.push(
      JSON.stringify({
        id,
        audio: `audio/${id}.wav`,
        durationSec,
        timestamp: '',
        kind: 'read',
        rawText: '',
        content: e.text,
        source: 'fleurs',
        audioSha256: hash,
        sampleRate: 16000,
        importedAt: now,
        sentenceId: e.sentenceId,
        gender: e.gender,
      }),
    );
    truth.push(JSON.stringify({ id, audioSha256: hash, target: e.text, status: 'ok', prefill: 'public', reviewedAt: now }));
  }
  fs.writeFileSync(path.join(OUT, 'manifest.jsonl'), `${rows.join('\n')}\n`, { mode: 0o600 });
  // The reference is the read sentence itself. The last line for an id wins, so appending is fine when rebuilding
  fs.appendFileSync(TRUTH, `${truth.join('\n')}\n`, { mode: 0o600 });
  const female = picked.filter((e) => e.gender === 'FEMALE').length;
  console.log(`fleurs-ja-v1: ${picked.length} rows (${female} female, ${picked.length - female} male), ${Math.round(seconds)} s in total`);
}

main();
