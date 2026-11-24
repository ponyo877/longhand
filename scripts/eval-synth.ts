/**
 * Reads a list of sentences aloud with this Mac's speech synthesis and builds an evaluation dataset from it.
 *
 *   npx tsx scripts/eval-synth.ts --script scripts/review/script-v1.json --name synth-script-v1
 *   npx tsx scripts/eval-synth.ts --script scripts/review/spoken-v1.json --name synth-spoken-v1
 *     --truth-only      do not rebuild the audio; rewrite only the references (and the spelling variants)
 *     --only A07,B19    rebuild the audio of those sentences only (after fixing a reading; other sentences keep their audio)
 *
 * Used instead of having a person record and check references. The reference is the sentence in the list itself, so no checking is needed.
 * - Speech synthesis is macOS say (runs on the device only, no network). Each sentence gets 3 of the 9 Japanese voices in turn
 * - Latin-letter words are rewritten as katakana readings before being read, so that the Japanese voices can read them (READINGS)
 * - To get closer to real recordings, a very small noise is added: 0.3 s before and 0.5 s after
 * - Spellings that differ only in notation (「あとで」 and 「後で」, for example) are added to the reference as alternatives (VARIANTS).
 *   Either spelling is correct, so they do not count as errors
 *
 * Synthesized speech is clearer than a human voice and has no disfluencies. The numbers are not "accuracy on human voices"; they are for
 * comparing terms, numbers, homophones and formatting rules under the same conditions.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { decodeWav, encodeWav } from '../src/main/audio/wav';

const { values: args } = parseArgs({
  options: {
    script: { type: 'string' },
    name: { type: 'string' },
    root: { type: 'string', default: path.join(os.homedir(), 'longhand-eval') },
    'voices-per-item': { type: 'string', default: '3' },
    'truth-only': { type: 'boolean', default: false },
    only: { type: 'string' },
  },
});
if (!args.script || !args.name) {
  console.error('Usage: npx tsx scripts/eval-synth.ts --script <list JSON> --name <dataset name>');
  process.exit(1);
}

const VOICES = ['Kyoko', 'Eddy', 'Flo', 'Reed', 'Sandy', 'Shelley', 'Rocko', 'Grandma', 'Grandpa'];
/** Voice name passed to say. Voices other than Kyoko are given with the language in the name */
const voiceArg = (v: string) => (v === 'Kyoko' ? v : `${v} (日本語（日本）)`);

/** Readings of Latin-letter words. Longer words are matched first */
const READINGS: [string, string][] = (
  [
    ['Pull Request', 'プルリクエスト'],
    ["won't fix", 'ウォントフィックス'],
    ['VS Code', 'ブイエスコード'],
    ['Argo CD', 'アルゴシーディー'],
    ['Next.js', 'ネクストジェイエス'],
    ['PostgreSQL', 'ポストグレスキューエル'],
    ['Kubernetes', 'クバネティス'],
    ['Terraform', 'テラフォーム'],
    ['TypeScript', 'タイプスクリプト'],
    ['CloudFront', 'クラウドフロント'],
    ['ClickHouse', 'クリックハウス'],
    ['PagerDuty', 'ページャーデューティー'],
    ['Tailscale', 'テイルスケール'],
    ['onboarding', 'オンボーディング'],
    ['Metabase', 'メタベース'],
    ['Renovate', 'リノベート'],
    ['BigQuery', 'ビッグクエリ'],
    ['Datadog', 'データドッグ'],
    ['ChatGPT', 'チャットジーピーティー'],
    ['GitHub', 'ギットハブ'],
    ['Vitest', 'ヴィーテスト'],
    ['ESLint', 'イーエスリント'],
    ['README', 'リードミー'],
    ['Docker', 'ドッカー'],
    ['Notion', 'ノーション'],
    ['Vercel', 'バーセル'],
    ['Claude', 'クロード'],
    ['sprint', 'スプリント'],
    ['Figma', 'フィグマ'],
    ['React', 'リアクト'],
    ['Slack', 'スラック'],
    ['Excel', 'エクセル'],
    ['issue', 'イシュー'],
    ['merge', 'マージ'],
    ['LGTM', 'エルジーティーエム'],
    ['Jira', 'ジラ'],
    ['main', 'メイン'],
    ['flow', 'フロー'],
    ['AWS', 'エーダブリューエス'],
    ['API', 'エーピーアイ'],
    ['S3', 'エススリー'],
  ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

interface ScriptItem {
  id: string;
  split: 'A' | 'B';
  category: string;
  /** Text that should be typed (the reference) */
  text: string;
  /** Text as spoken (with disfluencies and self-corrections). Without it, text is read */
  spoken?: string;
  /** Text to read aloud: a reading written in kana, for sentences the synthesizer misreads. Without it, spoken or text is read */
  say?: string;
  /** Alternatives: texts also accepted as correct (for example a sentence that reads as either a self-correction or a contrast). Notation-only alternatives are generated from VARIANTS */
  alt?: string[];
  terms: string[];
  tags?: string[];
}

/**
 * Spellings that differ only in notation: [spelling in the reference, other spellings…]. Either spelling is correct.
 * - kana versus kanji (「あとで」 and 「後で」)
 * - Latin letters versus katakana for common loanwords (the formatting rules keep loanwords that are not product names in katakana)
 * Different words with the same reading (「校正」 and 「構成」) are errors, so they are not listed.
 */
const VARIANTS: [RegExp, string[]][] = [
  [/あとで/g, ['後で']],
  [/のほう/g, ['の方']],
  [/しだい/g, ['次第']],
  [/か月/g, ['ヶ月', 'カ月']],
  [/とおり/g, ['通り']],
  [/あらためて/g, ['改めて']],
  [/分か(?=[らりるっ])/g, ['わか']],
  [/いちばん/g, ['一番']],
  [/時ごろ/g, ['時頃']],
  [/たときに/g, ['た時に']],
  [/いまの/g, ['今の']],
  [/まわり/g, ['周り']],
  [/うしろ/g, ['後ろ']],
  [/なんか(?=食べ)/g, ['何か']],
  [/御茶ノ水/g, ['お茶の水', '御茶の水']],
  [/クラスタ(?!ー)/g, ['クラスター']],
  [/Pull Request/g, ['プルリクエスト']],
  [/issue/g, ['イシュー']],
  [/merge/g, ['マージ']],
  [/main(?=に)/g, ['メイン']],
  [/sprint/g, ['スプリント']],
  [/onboarding/g, ['オンボーディング']],
  [/flow/g, ['フロー']],
];

/** Maximum alternatives per sentence (so that the combinations do not explode) */
const MAX_ALTS = 32;

/** Builds notation alternatives from combinations of the matching spellings. The original text is not included */
function variantsOf(text: string): string[] {
  let out = [text];
  for (const [re, others] of VARIANTS) {
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const next = [...out];
    for (const o of others) for (const t of out) next.push(t.replace(re, o));
    out = [...new Set(next)].slice(0, MAX_ALTS + 1);
  }
  return out.filter((t) => t !== text);
}

/** Alternatives of the sentence (those in the list and the notation alternatives). Notation alternatives are also built for the listed alternatives */
function altsOf(it: ScriptItem): string[] {
  const base = [it.text, ...(it.alt ?? [])];
  const all = new Set<string>();
  for (const b of base) for (const v of [b, ...variantsOf(b)]) if (v !== it.text) all.add(v);
  return [...all].slice(0, MAX_ALTS);
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Text to read aloud, with Latin-letter words replaced by readings. Stops if a Latin-letter word without a reading is left, to tell the author */
function speakable(text: string): string {
  let s = text;
  for (const [word, reading] of READINGS) s = s.split(word).join(reading);
  const left = s.match(/[A-Za-z]{2,}/g);
  if (left) throw new Error(`Latin-letter words without a reading: ${left.join(', ')} (add them to READINGS in scripts/eval-synth.ts)`);
  return s;
}

// The noise uses a fixed random sequence, so the same input gives the same sound
let seed = 20261123;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
/** When rebuilding a single row, seed the random numbers from the utterance id (so other utterances keep their audio) */
function seedFor(id: string): void {
  seed = createHash('sha256').update(id).digest().readUInt32BE(0) & 0x7fffffff;
}

function synthesize(text: string, voice: string, tmp: string): Float32Array {
  execFileSync('say', ['-v', voiceArg(voice), '--file-format=WAVE', '--data-format=LEI16@16000', '-o', tmp, text], { stdio: 'ignore' });
  const { samples, sampleRate } = decodeWav(fs.readFileSync(tmp));
  if (sampleRate !== 16000) throw new Error(`Not 16 kHz (${sampleRate})`);
  const lead = Math.round(0.3 * 16000);
  const tail = Math.round(0.5 * 16000);
  const out = new Float32Array(lead + samples.length + tail);
  out.set(samples, lead);
  // Add a very small noise throughout, close to a quiet room (RMS about 0.0003)
  for (let i = 0; i < out.length; i++) out[i] += rand() * 0.0005;
  return out;
}

function main(): void {
  const doc = JSON.parse(fs.readFileSync(args.script!, 'utf8')) as { items: ScriptItem[] };
  const dir = path.join(args.root!, 'datasets', args.name!);
  const perItem = Math.max(1, Math.min(VOICES.length, Number(args['voices-per-item'])));
  // Check readings first (so that a stop midway does not leave a partial dataset)
  const spokenOf = new Map(doc.items.map((it) => [it.id, speakable(it.say ?? it.spoken ?? it.text)]));
  const now = new Date().toISOString();
  const truthRow = (id: string, hash: string, it: ScriptItem) => {
    const alt = altsOf(it);
    return JSON.stringify({
      id,
      audioSha256: hash,
      target: it.text,
      ...(it.spoken ? { spoken: it.spoken } : {}),
      ...(alt.length ? { alt } : {}),
      status: 'ok',
      prefill: 'synth',
      reviewedAt: now,
    });
  };
  const idOf = (it: ScriptItem, voice: string) => `${args.name}-${it.id.split('-').pop()}-${voice.toLowerCase()}`;
  const manifestFile = path.join(dir, 'manifest.jsonl');
  const truthFile = path.join(args.root!, 'truth.jsonl');
  const only = args.only
    ? new Set(
        args.only
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      )
    : null;

  if (args['truth-only'] || only) {
    // Do not rebuild audio (except for the given sentences). Match the sentences in the list against the existing dataset rows
    const rows = fs
      .readFileSync(manifestFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown> & { id: string; sentenceId: string; voice: string; audioSha256: string });
    const byItem = new Map(doc.items.map((it) => [it.id, it]));
    const tmp = path.join(dir, 'tmp.wav');
    const truth: string[] = [];
    let redone = 0;
    let withAlt = 0;
    for (const row of rows) {
      const it = byItem.get(row.sentenceId);
      if (!it) throw new Error(`Sentence not in the list: ${row.sentenceId}`);
      if (only?.has(it.id.split('-').pop()!)) {
        seedFor(row.id);
        const pcm = encodeWav(synthesize(spokenOf.get(it.id)!, row.voice, tmp));
        fs.writeFileSync(path.join(dir, 'audio', `${row.id}.wav`), pcm, { mode: 0o600 });
        row.audioSha256 = sha256(pcm);
        row.durationSec = Math.round(((pcm.length - 44) / 2 / 16000) * 10) / 10;
        row.importedAt = now;
        redone++;
      }
      row.content = it.text;
      if (altsOf(it).length) withAlt++;
      truth.push(truthRow(row.id, row.audioSha256, it));
    }
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(manifestFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
    fs.appendFileSync(truthFile, `${truth.join('\n')}\n`, { mode: 0o600 });
    console.log(`${args.name}: rewrote references (${rows.length} rows, ${withAlt} with alternatives), rebuilt audio for ${redone} utterances`);
    return;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, 'tmp.wav');
  const rows: string[] = [];
  const truth: string[] = [];
  let seconds = 0;
  doc.items.forEach((it, i) => {
    for (let k = 0; k < perItem; k++) {
      const voice = VOICES[(i * perItem + k) % VOICES.length];
      const id = idOf(it, voice);
      const pcm = encodeWav(synthesize(spokenOf.get(it.id)!, voice, tmp));
      fs.writeFileSync(path.join(dir, 'audio', `${id}.wav`), pcm, { mode: 0o600 });
      const hash = sha256(pcm);
      const durationSec = Math.round(((pcm.length - 44) / 2 / 16000) * 10) / 10;
      seconds += durationSec;
      rows.push(
        JSON.stringify({
          id,
          audio: `audio/${id}.wav`,
          durationSec,
          timestamp: '',
          kind: 'synth',
          rawText: '',
          content: it.text,
          source: 'synth',
          audioSha256: hash,
          sampleRate: 16000,
          importedAt: now,
          split: it.split,
          category: it.category,
          tags: it.tags ?? [],
          terms: it.terms,
          voice,
          sentenceId: it.id,
        }),
      );
      truth.push(truthRow(id, hash, it));
    }
  });
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(manifestFile, `${rows.join('\n')}\n`, { mode: 0o600 });
  // The reference is the sentence in the list itself. The last line for an id wins, so appending is fine when rebuilding
  fs.appendFileSync(truthFile, `${truth.join('\n')}\n`, { mode: 0o600 });
  console.log(`${args.name}: ${rows.length} rows (${doc.items.length} sentences × ${perItem} voices), ${Math.round(seconds)} s in total`);
}

main();
