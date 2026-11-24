/**
 * 公開の読み上げデータ（FLEURS の日本語、CC-BY 4.0）から、回帰の確認に使う小さなデータセットを作る。
 *
 *   npx tsx scripts/eval-import-public.ts
 *
 * 目的は、1 人の声に合わせた調整が、ほかの声で悪くなっていないかを見張ること。
 * 手元の利用者の録音とは別のデータセット（fleurs-ja-v1）にして、音声認識の段の誤り率と、整形が壊した割合だけを見る。
 *
 * 前提: 次の 2 つを ~/longhand-eval/public/fleurs-ja/ に置き、音声を extract/ に展開しておく。
 *   https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976/data/ja_jp/dev.tsv
 *   https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976/data/ja_jp/audio/dev.tar.gz
 * 出典: Conneau et al., "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech"（google/fleurs）。
 *
 * 選び方は決まっている（同じ入力からは同じ結果になる）。文ごとに 1 つの録音を選び、女性の録音があればそれを優先する
 * （もとの配分は男性に偏っているため）。
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

/** 16bit PCM と 32bit float の WAV を Float32 にする（FLEURS は 32bit float） */
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
        else throw new Error(`対応していない WAV の形式です（format=${format}, bits=${bits}）`);
      }
      return { samples: out, sampleRate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV の data チャンクが見つかりません');
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
    console.error(`${SRC} に dev.tsv と extract/dev/ がありません。このファイルの先頭の説明を見てください。`);
    process.exit(1);
  }
  const entries: Entry[] = fs
    .readFileSync(tsv, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.split('\t'))
    .map((c) => ({ sentenceId: c[0], file: c[1], text: c[2], gender: c[6] ?? '' }))
    .filter((e) => fs.existsSync(path.join(audioDir, e.file)));

  // 文ごとに 1 つ。女性の録音があればそれを、なければファイル名の小さいものを選ぶ
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
    if (wav.sampleRate !== 16000) throw new Error(`${e.file}: 16 kHz ではありません（${wav.sampleRate}）`);
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
  // 正解は読み上げた文そのもの。同じ id は最後の行が有効なので、作り直しても追記でよい
  fs.appendFileSync(TRUTH, `${truth.join('\n')}\n`, { mode: 0o600 });
  const female = picked.filter((e) => e.gender === 'FEMALE').length;
  console.log(`fleurs-ja-v1: ${picked.length} 件（女性 ${female}、男性 ${picked.length - female}）、合計 ${Math.round(seconds)} 秒`);
}

main();
