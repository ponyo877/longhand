/**
 * 文の一覧を、この Mac の合成音声で読み上げて、評価用のデータセットを作る。
 *
 *   npx tsx scripts/eval-synth.ts --script scripts/review/script-v1.json --name synth-script-v1
 *   npx tsx scripts/eval-synth.ts --script scripts/review/spoken-v1.json --name synth-spoken-v1
 *     --truth-only      音声は作り直さず、正解（と、表記の別解）だけを書き直す
 *     --only A07,B19    その文の音声だけを作り直す（読みを直したとき。ほかの文の音声は変えない）
 *
 * 人が録音して正解を確かめる代わりに使う。正解は一覧の文そのものなので、確かめる手間が要らない。
 * - 合成音声は macOS の say（端末の中だけで動く。通信しない）。日本語の声 9 種類から、文ごとに 3 種類を順に割り当てる
 * - 英字の語は、日本語の声が読めるように、カタカナの読みに直してから読み上げる（READINGS）
 * - 実際の録音に近づけるため、前に 0.3 秒、後ろに 0.5 秒の、ごく小さな雑音を足す
 * - 表記だけが違う書き方（「あとで」と「後で」など）は、別解として正解に添える（VARIANTS）。
 *   どちらで書いても誤りではないので、誤りに数えない
 *
 * 合成音声は、人の声より明瞭で、言いよどみが無い。数値は「人の声での精度」ではなく、
 * 用語、数字、同音異義語、整形の規則を、条件をそろえて比べるために使う。
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
  console.error('使い方: npx tsx scripts/eval-synth.ts --script <一覧の JSON> --name <データセットの名前>');
  process.exit(1);
}

const VOICES = ['Kyoko', 'Eddy', 'Flo', 'Reed', 'Sandy', 'Shelley', 'Rocko', 'Grandma', 'Grandpa'];
/** say に渡す声の名前。Kyoko のほかは、言語の付いた名前で指定する */
const voiceArg = (v: string) => (v === 'Kyoko' ? v : `${v} (日本語（日本）)`);

/** 英字の語の読み。長い語を先に当てる */
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
  /** 入力されるべき文（正解） */
  text: string;
  /** 話したままの文（言いよどみや言い直しを含む）。無ければ text を読み上げる */
  spoken?: string;
  /** 読み上げる文。合成音声が読み誤る文で、かなで書いた読みを渡す。無ければ spoken か text を読み上げる */
  say?: string;
  /** 別解。どちらの書き方でも正解とする文（言い直しとも対比とも取れる文など）。表記だけの別解は VARIANTS から自動で作る */
  alt?: string[];
  terms: string[];
  tags?: string[];
}

/**
 * 表記だけが違う書き方。[正解の中の書き方, 別の書き方…]。どちらで書いても誤りではない。
 * - かなと漢字の書き分け（「あとで」と「後で」）
 * - 一般的な外来語の、英字とカタカナ（整形の規則では、製品名でない外来語はカタカナのままにする）
 * 同じ読みの別の語（「校正」と「構成」）は、誤りなので入れない。
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

/** 1 つの文の別解の上限（組み合わせが増えすぎないように） */
const MAX_ALTS = 32;

/** 表記の別解を、当てはまる書き方の組み合わせで作る。元の文は含めない */
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

/** その文の別解（一覧に書いたものと、表記の別解）。一覧に書いた別解にも、表記の別解を作る */
function altsOf(it: ScriptItem): string[] {
  const base = [it.text, ...(it.alt ?? [])];
  const all = new Set<string>();
  for (const b of base) for (const v of [b, ...variantsOf(b)]) if (v !== it.text) all.add(v);
  return [...all].slice(0, MAX_ALTS);
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** 読み上げる文。英字の語を読みに直す。読みの無い英字の語が残ったら、作り手に知らせるために止める */
function speakable(text: string): string {
  let s = text;
  for (const [word, reading] of READINGS) s = s.split(word).join(reading);
  const left = s.match(/[A-Za-z]{2,}/g);
  if (left) throw new Error(`読みの無い英字の語があります: ${left.join(', ')}（scripts/eval-synth.ts の READINGS に足してください）`);
  return s;
}

// 雑音は、同じ入力から同じ音になるように、決まった乱数で作る
let seed = 20261123;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
/** 1 件だけを作り直すときは、乱数をその発話の id から決める（ほかの発話の音声を変えないため） */
function seedFor(id: string): void {
  seed = createHash('sha256').update(id).digest().readUInt32BE(0) & 0x7fffffff;
}

function synthesize(text: string, voice: string, tmp: string): Float32Array {
  execFileSync('say', ['-v', voiceArg(voice), '--file-format=WAVE', '--data-format=LEI16@16000', '-o', tmp, text], { stdio: 'ignore' });
  const { samples, sampleRate } = decodeWav(fs.readFileSync(tmp));
  if (sampleRate !== 16000) throw new Error(`16 kHz ではありません（${sampleRate}）`);
  const lead = Math.round(0.3 * 16000);
  const tail = Math.round(0.5 * 16000);
  const out = new Float32Array(lead + samples.length + tail);
  out.set(samples, lead);
  // 静かな部屋の雑音に近い、ごく小さな雑音を全体に足す（RMS 約 0.0003）
  for (let i = 0; i < out.length; i++) out[i] += rand() * 0.0005;
  return out;
}

function main(): void {
  const doc = JSON.parse(fs.readFileSync(args.script!, 'utf8')) as { items: ScriptItem[] };
  const dir = path.join(args.root!, 'datasets', args.name!);
  const perItem = Math.max(1, Math.min(VOICES.length, Number(args['voices-per-item'])));
  // 読みの確認を先に済ませる（途中で止まって、半端なデータセットが残らないように）
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
    // 音声は（指定した文のほかは）作り直さない。一覧の文と、いまあるデータセットの行を突き合わせる
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
      if (!it) throw new Error(`一覧に無い文です: ${row.sentenceId}`);
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
    console.log(`${args.name}: 正解を書き直しました（${rows.length} 件、うち別解あり ${withAlt} 件）、音声を作り直した発話 ${redone} 件`);
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
  // 正解は一覧の文そのもの。同じ id は最後の行が有効なので、作り直しても追記でよい
  fs.appendFileSync(truthFile, `${truth.join('\n')}\n`, { mode: 0o600 });
  console.log(`${args.name}: ${rows.length} 件（${doc.items.length} 文 × ${perItem} 種類の声）、合計 ${Math.round(seconds)} 秒`);
}

main();
