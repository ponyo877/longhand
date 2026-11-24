/**
 * 評価の実行を通しで確かめる。書き起こしと LLM は偽物、データセットは一時フォルダに作った短い音声。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { encodeWav } from '../audio/wav';
import type { LlmProvider } from '../llm/types';
import { llmIdentity } from './cache';
import { readJsonl, sha256Hex } from './files';
import type { Transcriber } from './pipeline';
import { runEval, type EvalConfig, type EvalEnv } from './run';
import type { RowRecord } from './score';

const SR = 16000;

function speech(sec: number): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < out.length; i++) out[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / SR) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / SR));
  return out;
}

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 9, min)).toISOString();

/** 音声の長さで決まった文を返す偽の書き起こし */
const ASR_TEXT: Record<string, string> = { '1.0': 'きょうは晴れです。', '1.2': 'えーと資料を送ります', '1.4': '会議は三時からです' };
/** 書き起こしで決まった文を返す偽の LLM */
const LLM_TEXT: Record<string, string> = { えーと資料を送ります: '資料を送ります。', 会議は三時からです: '会議は三時からでした。' };

describe('runEval', () => {
  let root = '';
  let asrCalls = 0;
  let llmCalls = 0;
  const lines: string[] = [];

  const asr: Transcriber = {
    async transcribe(samples) {
      asrCalls++;
      return { text: ASR_TEXT[(samples.length / SR).toFixed(1)] ?? '', elapsedMs: 1 };
    },
  };
  const provider: LlmProvider = {
    kind: 'anthropic',
    async complete(req) {
      llmCalls++;
      const raw = (JSON.parse(req.user) as { raw_text: string }).raw_text;
      return { text: JSON.stringify({ text: LLM_TEXT[raw] ?? raw }), model: 'fake-model', elapsedMs: raw.startsWith('会議') ? 9000 : 1200 };
    },
  };
  const env = (over: Partial<EvalEnv> = {}): EvalEnv => ({
    root,
    // 単語分割の WASM もコードも無い場所を渡す（単語分割なしで動くことも確かめる）
    repoRoot: path.join(root, 'no-repo'),
    modelsDir: path.join(root, 'no-models'),
    asr,
    host: 'test',
    print: (l) => lines.push(l),
    ...over,
  });
  const live = (): EvalEnv => env({ llm: { provider, identity: llmIdentity(DEFAULT_SETTINGS.llm), maxOutputTokens: 2048, appTimeoutMs: 8000 } });
  // 整形を省く近道（既定はオフ）の動きも見るので、オンにして走らせる
  const config = (over: Partial<EvalConfig> = {}): EvalConfig => ({ name: 'テスト run', datasets: ['d1'], llm: 'live', settings: { llmFastPath: true }, ...over });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-eval-run-'));
    asrCalls = 0;
    llmCalls = 0;
    lines.length = 0;
    const dir = path.join(root, 'datasets', 'd1');
    fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
    const rows = [
      { id: 'u1', sec: 1.0, min: 0, content: '使わない文' },
      { id: 'u2', sec: 1.2, min: 1, content: '資料を送ります。' },
      { id: 'u3', sec: 1.4, min: 30, content: '会議は3時からです。' },
    ];
    const hashes = new Map<string, string>();
    const manifest = rows.map((r) => {
      const buf = encodeWav(speech(r.sec));
      fs.writeFileSync(path.join(dir, 'audio', `${r.id}.wav`), buf);
      hashes.set(r.id, sha256Hex(buf));
      return JSON.stringify({
        id: r.id,
        audio: `audio/${r.id}.wav`,
        durationSec: r.sec,
        timestamp: at(r.min),
        kind: 'dictation',
        rawText: '',
        content: r.content,
        audioSha256: sha256Hex(buf),
        sampleRate: SR,
      });
    });
    fs.writeFileSync(path.join(dir, 'manifest.jsonl'), `${manifest.join('\n')}\n`);
    // u1 だけ、人が確かめた正解がある（別解つき）
    fs.writeFileSync(
      path.join(root, 'truth.jsonl'),
      `${JSON.stringify({ id: 'u1', audioSha256: hashes.get('u1'), target: '今日は晴れです。', alt: ['きょうは晴れです。'], status: 'ok', prefill: 'longhand', reviewedAt: at(0) })}\n`,
    );
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('段階ごとに測り、結果を保存する。2 回目は書き起こしも LLM も呼ばない', async () => {
    const first = await runEval(config(), live());
    expect(asrCalls).toBe(3);
    expect(llmCalls).toBe(2);
    const s = first.summary;
    expect(s.status).toBe('ok');
    expect(s.provisional).toBe(true);
    expect(s.truth).toEqual({ provisional: 2, reviewed: 1 });
    expect(s.llm).toMatchObject({ mode: 'live', kind: 'anthropic', calls: 2, cacheHits: 0, stored: 2, failures: 0, maxCalls: 150, timeoutMs: 60000, appTimeoutMs: 8000 });
    expect(s.asr).toEqual({ cached: 0, transcribed: 3, skippedOtherRate: 0 });

    const all = s.groups.all;
    expect(all.n).toBe(3);
    // 書き起こしの生の出力: u1 は別解と一致、u2 は「えーと」の 3 字、u3 は「三」の 1 字
    expect(all.stages.asr).toMatchObject({ contentEdits: 4, exact: 1 });
    expect(all.stages.noLlm.contentEdits).toBe(4);
    // LLM の後: u2 は直り、u3 は「でした」で悪くなる
    expect(all.stages.final).toMatchObject({ contentEdits: 3, exact: 2 });
    expect(all.llm).toMatchObject({ called: 2, cached: 0, live: 2, fastPath: 1, failed: 0, cacheMiss: 0, overAppTimeout: 1 });
    expect(all.llm.effect).toEqual({ clean: 1, broke: 0, errored: 2, improved: 1, worsened: 1, fixed: 1 });
    expect(all.llm.brokeRate).toBe(0);
    expect(all.llm.improvedRate).toBe(0.5);
    expect(all.errors.asr.filler).toEqual({ groups: 1, edits: 3 });
    expect(all.errors.asr.number).toEqual({ groups: 1, edits: 1 });
    // 開発用（u1、u2）と確認用（30 分あいた u3）
    expect(s.groups.bySplit.dev.n).toBe(2);
    expect(s.groups.bySplit.holdout.n).toBe(1);
    expect(Object.keys(s.groups.byDatasetSplit)).toEqual(['d1/dev', 'd1/holdout']);

    const again = await runEval(config(), live());
    expect(asrCalls).toBe(3);
    expect(llmCalls).toBe(2);
    expect(again.summary.llm).toMatchObject({ calls: 0, cacheHits: 2, stored: 0 });
    expect(again.summary.asr).toEqual({ cached: 3, transcribed: 0, skippedOtherRate: 0 });
    expect(again.summary.groups.all.stages).toEqual(all.stages);
    expect(again.summary.groups.all.llm).toMatchObject({ called: 2, cached: 2, live: 0, overAppTimeout: 1 });
  });

  it('結果のファイルは 0600、フォルダは 0700。集計と標準出力には文を出さない', async () => {
    const { dir } = await runEval(config(), live());
    expect(path.basename(dir)).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d--run$/);
    // 同じ秒に同じ名前で始めても、別のフォルダになる
    const second = await runEval(config({ llm: 'off' }), env());
    expect(second.dir).not.toBe(dir);
    expect(readJsonl<RowRecord>(path.join(second.dir, 'rows.jsonl')).length).toBe(3);
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    for (const f of ['config.json', 'rows.jsonl', 'summary.json']) expect(mode(path.join(dir, f))).toBe(0o600);
    for (const d of [dir, path.join(root, 'runs'), path.join(root, 'cache'), path.join(root, 'cache', 'asr'), path.join(root, 'cache', 'llm')]) expect(mode(d)).toBe(0o700);
    expect(mode(path.join(root, 'runs', 'index.jsonl'))).toBe(0o600);
    for (const f of fs.readdirSync(path.join(root, 'cache', 'llm'))) expect(mode(path.join(root, 'cache', 'llm', f))).toBe(0o600);

    const rows = readJsonl<RowRecord>(path.join(dir, 'rows.jsonl'));
    expect(rows.map((r) => [r.id, r.split, r.provisional, r.stages.final])).toEqual([
      ['u1', 'dev', false, 'きょうは晴れです。'],
      ['u2', 'dev', true, '資料を送ります。'],
      ['u3', 'holdout', true, '会議は三時からでした。'],
    ]);
    expect(rows[0].llm).toMatchObject({ called: false, fastPath: true });
    expect(rows[2].llm).toMatchObject({ called: true, cached: false, ms: 9000, overAppTimeout: true });

    const texts = ['資料', '晴れ', '会議'];
    const summary = fs.readFileSync(path.join(dir, 'summary.json'), 'utf8');
    const cfg = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    const index = fs.readFileSync(path.join(root, 'runs', 'index.jsonl'), 'utf8');
    for (const t of texts) {
      expect(summary).not.toContain(t);
      expect(cfg).not.toContain(t);
      expect(index).not.toContain(t);
      expect(lines.join('\n')).not.toContain(t);
    }
    expect(lines.join('\n')).toContain('正解が仮の発話が 2 件');
    const record = JSON.parse(cfg) as {
      truth: { provisional: number; reviewed: number };
      llm: { identity: { model: string } };
      settings: { llmFastPath: boolean; textFix: { latin: boolean; fillers: boolean } };
    };
    expect(record.truth).toMatchObject({ provisional: 2, reviewed: 1 });
    // 上書きした設定（近道）が記録に残る。ほかはアプリの既定の設定で動く（補正は latin と particles だけ）
    expect(record.settings.llmFastPath).toBe(true);
    expect(record.settings.textFix).toMatchObject({ latin: true, fillers: false, notation: false, particles: true });
    expect(record.llm.identity.model).toBe(DEFAULT_SETTINGS.llm.model);
    expect(
      index
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { n: number; llmMode: string }).llmMode),
    ).toEqual(['live', 'off']);
  });

  it('保存済みの結果だけで集計し直せる（LLM の接続を渡さなくても、前の実行の記録からキーを作る）', async () => {
    const first = await runEval(config(), live());
    const again = await runEval(config({ llm: 'cache-only', asrCacheOnly: true }), env({ asr: undefined }));
    expect(llmCalls).toBe(2);
    expect(again.summary.llm).toMatchObject({ mode: 'cache-only', calls: 0, cacheHits: 2, cacheMisses: 0 });
    expect(again.summary.groups.all.stages).toEqual(first.summary.groups.all.stages);
    expect(again.summary.groups.all.llm.cacheMiss).toBe(0);
  });

  it('保存済みの結果が無い発話は、LLM なしの文に落として数える', async () => {
    await runEval(config({ ids: ['u2'] }), live());
    const r = await runEval(config({ llm: 'cache-only' }), env());
    expect(r.summary.status).toBe('ok');
    expect(r.summary.groups.all.llm).toMatchObject({ called: 2, cached: 1, cacheMiss: 1, failed: 0 });
    // u3 は LLM なしの文のまま
    expect(r.summary.groups.all.stages.final.contentEdits).toBe(1);
  });

  it('LLM なしでも動く。最終の文は LLM なしの文と同じ', async () => {
    const r = await runEval(config({ llm: 'off' }), env());
    expect(llmCalls).toBe(0);
    expect(r.summary.llm).toMatchObject({ mode: 'off', calls: 0 });
    expect(r.summary.groups.all.stages.final).toEqual(r.summary.groups.all.stages.noLlm);
    expect(r.summary.groups.all.llm.called).toBe(0);
  });

  it('呼び出しの上限に達したら、その発話を記録せずに止める', async () => {
    const r = await runEval(config({ maxLlmCalls: 1 }), live());
    expect(llmCalls).toBe(1);
    expect(r.summary.status).toBe('aborted');
    expect(r.summary.aborted).toBe('budget');
    expect(r.summary.groups.all.n).toBe(2);
    expect(readJsonl<RowRecord>(path.join(r.dir, 'rows.jsonl')).map((x) => x.id)).toEqual(['u1', 'u2']);
  });

  it('設定を上書きしなければ、アプリの既定で動く（近道はオフで、整った発話も LLM に回る）', async () => {
    const r = await runEval(config({ settings: undefined }), live());
    expect(llmCalls).toBe(3);
    expect(r.summary.groups.all.llm).toMatchObject({ called: 3, fastPath: 0 });
    const record = JSON.parse(fs.readFileSync(path.join(r.dir, 'config.json'), 'utf8')) as { settings: { llmFastPath: boolean } };
    expect(record.settings.llmFastPath).toBe(false);
  });

  it('手直しの模擬では、別解に合っている出力は直さない', async () => {
    // u1 の出力「きょうは晴れです。」は、別解に合っている。正解の文「今日は晴れです。」との違いは表記だけなので、利用者は直さない
    const r = await runEval(config({ ids: ['u1', 'u2'], learn: { train: '^u1$' } }), live());
    expect(r.summary.status).toBe('ok');
    expect(r.summary.learn).toMatchObject({ train: 1, edited: 0, corrections: 0, kept: 0 });
    // 学習に使った発話は、測る側に入らない
    expect(readJsonl<RowRecord>(path.join(r.dir, 'rows.jsonl')).map((x) => x.id)).toEqual(['u2']);
  });

  it('開発用だけ、確認用だけ、件数で絞れる', async () => {
    expect((await runEval(config({ llm: 'off', split: 'holdout' }), env())).summary.groups.all.n).toBe(1);
    expect((await runEval(config({ llm: 'off', split: 'dev' }), env())).summary.groups.all.n).toBe(2);
    expect((await runEval(config({ llm: 'off', limit: 1 }), env())).summary.groups.all.n).toBe(1);
  });

  it('辞書の語の一覧を渡すと、書き起こしのヒントに使い、再現率を数える', async () => {
    const vocab = path.join(root, 'words.txt');
    fs.writeFileSync(vocab, '資料\n会議室\n');
    const hints: string[][] = [];
    const spy: Transcriber = {
      async transcribe(samples, opts) {
        hints.push(opts.hints);
        return asr.transcribe(samples, opts);
      },
    };
    const r = await runEval(config({ llm: 'off', vocab }), env({ asr: spy }));
    // 既定では、ヒントなしとヒントありの 2 回書き起こす（asr.hintMode の selective）
    expect(hints.length).toBe(6);
    expect(hints.filter((h) => !h.length)).toHaveLength(3);
    expect([...hints[1]].sort()).toEqual(['会議室', '資料']);
    expect(r.summary.groups.all.terms.vocab.asr).toEqual({ hit: 1, total: 1 });
    // 辞書が変わると、書き起こしの保存済みの結果は使い回さない（ヒントがキーに入っている）
    const before = asrCalls;
    await runEval(config({ llm: 'off' }), env());
    expect(asrCalls).toBe(before + 3);
  });

  /** 追加のデータセットを作る（行に、台本の種類や、離した後に録った長さを付けられる） */
  function writeDataset(name: string, rows: { id: string; sec: number; content: string; extra?: Record<string, unknown> }[]): void {
    const dir = path.join(root, 'datasets', name);
    fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
    const manifest = rows.map((r, i) => {
      const buf = encodeWav(speech(r.sec));
      fs.writeFileSync(path.join(dir, 'audio', `${r.id}.wav`), buf);
      return JSON.stringify({
        id: r.id,
        audio: `audio/${r.id}.wav`,
        durationSec: r.sec,
        timestamp: at(i),
        kind: 'dictation',
        rawText: '',
        content: r.content,
        audioSha256: sha256Hex(buf),
        sampleRate: SR,
        ...r.extra,
      });
    });
    fs.writeFileSync(path.join(dir, 'manifest.jsonl'), `${manifest.join('\n')}\n`);
  }

  it('台本の文の種類ごとに集計し、種類ごとの最終の誤り率を 1 行ずつ出す。種類の無いデータセットでは出さない', async () => {
    writeDataset('script', [
      { id: 's1', sec: 1.4, content: '会議は3時からです。', extra: { split: 'A', category: 'number', terms: ['会議'] } },
      { id: 's2', sec: 1.2, content: '資料を送ります。', extra: { split: 'B', category: 'short' } },
      { id: 's3', sec: 1.0, content: 'きょうは晴れです。', extra: { split: 'B', category: 'short' } },
    ]);
    const r = await runEval(config({ llm: 'off', datasets: ['d1', 'script'] }), env());
    const by = r.summary.groups.byCategory!;
    expect(Object.keys(by)).toEqual(['number', 'short']);
    // 種類の付いた発話だけが入る（d1 の 3 件は入らない）
    expect(by.number.n).toBe(1);
    expect(by.short.n).toBe(2);
    expect(by.number.stages.noLlm.contentEdits).toBe(1);
    expect(by.short.stages.noLlm.contentEdits).toBe(3);
    expect(r.summary.groups.bySplit.dev.n).toBe(3);
    const rows = readJsonl<RowRecord>(path.join(r.dir, 'rows.jsonl'));
    expect(rows.map((x) => x.category)).toEqual([undefined, undefined, undefined, 'number', 'short', 'short']);
    const printed = lines.filter((l) => l.startsWith('[種類'));
    expect(printed.length).toBe(2);
    expect(printed[0]).toContain('number');
    expect(printed[0]).toContain('1 件');
    expect(printed[1]).toContain('short');
    expect(printed[1]).toContain('3/15');
    expect(printed.join('\n')).not.toContain('資料');

    lines.length = 0;
    const plain = await runEval(config({ llm: 'off' }), env());
    expect(plain.summary.groups.byCategory).toBeUndefined();
    expect(lines.some((l) => l.startsWith('[種類'))).toBe(false);
  });

  it('末尾の切り落とし（postRoll）は、離した後に録った長さのある行だけを切り落とし、保存済みの書き起こしを分ける', async () => {
    writeDataset('tail', [
      { id: 't1', sec: 1.5, content: '資料を送ります。', extra: { postRollMs: 300 } },
      { id: 't2', sec: 1.4, content: '会議は3時からです。' },
    ]);
    const seen: number[] = [];
    const spy: Transcriber = {
      async transcribe(samples, opts) {
        seen.push(Number((samples.length / SR).toFixed(2)));
        return asr.transcribe(samples, opts);
      },
    };
    const cfg = (over: Partial<EvalConfig> = {}) => config({ llm: 'off', datasets: ['tail'], ...over });

    const full = await runEval(cfg(), env({ asr: spy }));
    expect(seen).toEqual([1.5, 1.4]);
    expect(full.summary.asr.truncated).toBeUndefined();
    expect(readJsonl<RowRecord>(path.join(full.dir, 'rows.jsonl')).map((x) => x.asr.truncatedMs)).toEqual([undefined, undefined]);

    // t1 だけ 0.3 秒を切り落として書き起こし直す。t2 は切り落とさないので、保存済みの結果を使う
    const cut = await runEval(cfg({ truncateTail: 'postRoll' }), env({ asr: spy }));
    expect(seen).toEqual([1.5, 1.4, 1.2]);
    expect(cut.summary.asr).toMatchObject({ cached: 1, transcribed: 1, truncated: 1 });
    const rows = readJsonl<RowRecord>(path.join(cut.dir, 'rows.jsonl'));
    expect(rows.map((x) => [x.id, x.asr.truncatedMs, x.asr.cached, x.durationSec])).toEqual([
      ['t1', 300, false, 1.5],
      ['t2', undefined, true, 1.4],
    ]);
    // 切り落とした音声の書き起こしで採点している（1.2 秒の音声の文になる）
    expect(rows[0].stages.asr).toBe('えーと資料を送ります');
    expect(lines.some((l) => l.startsWith('末尾の切り落とし 1 件'))).toBe(true);

    // 同じ指定の 2 回目は、どちらも保存済み
    const again = await runEval(cfg({ truncateTail: 'postRoll' }), env({ asr: spy }));
    expect(seen.length).toBe(3);
    expect(again.summary.asr).toMatchObject({ cached: 2, transcribed: 0, truncated: 1 });
    // 切り落とさない実行の結果は、そのまま残っている
    const back = await runEval(cfg(), env({ asr: spy }));
    expect(seen.length).toBe(3);
    expect(readJsonl<RowRecord>(path.join(back.dir, 'rows.jsonl'))[0].stages.asr).toBe('');
  });

  it('末尾の切り落としを ms で指定すると、どの行も同じ長さだけ切り落とす。長さごとに保存を分ける', async () => {
    writeDataset('tail', [
      { id: 't1', sec: 1.5, content: '資料を送ります。', extra: { postRollMs: 300 } },
      { id: 't2', sec: 1.4, content: 'きょうは晴れです。' },
    ]);
    const seen: number[] = [];
    const spy: Transcriber = {
      async transcribe(samples, opts) {
        seen.push(Number((samples.length / SR).toFixed(2)));
        return asr.transcribe(samples, opts);
      },
    };
    const r = await runEval(config({ llm: 'off', datasets: ['tail'], truncateTail: 400 }), env({ asr: spy }));
    expect(seen).toEqual([1.1, 1]);
    expect(r.summary.asr.truncated).toBe(2);
    await runEval(config({ llm: 'off', datasets: ['tail'], truncateTail: 300 }), env({ asr: spy }));
    expect(seen).toEqual([1.1, 1, 1.2, 1.1]);
    // 0 は切り落とさないのと同じ（キーも同じ）
    await runEval(config({ llm: 'off', datasets: ['tail'], truncateTail: 0 }), env({ asr: spy }));
    await runEval(config({ llm: 'off', datasets: ['tail'] }), env({ asr: spy }));
    expect(seen).toEqual([1.1, 1, 1.2, 1.1, 1.5, 1.4]);
    // 録音より長く切り落とすと、短すぎる録音として書き起こさない
    const none = await runEval(config({ llm: 'off', datasets: ['tail'], truncateTail: 5000 }), env({ asr: spy }));
    expect(seen.length).toBe(6);
    expect(readJsonl<RowRecord>(path.join(none.dir, 'rows.jsonl')).map((x) => x.asr.skipped)).toEqual(['too-short', 'too-short']);
  });

  it('LLM を呼ぶ実行は、接続を渡さなければ始めない', async () => {
    await expect(runEval(config(), env())).rejects.toThrow(/アプリの中/);
    await expect(runEval(config({ llm: 'cache-only' }), env())).rejects.toThrow(/接続の記録がありません/);
  });
});
