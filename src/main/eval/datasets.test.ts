import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWav } from '../audio/wav';
import { assignSplits, loadDataset, loadTruth, readWordList, type ManifestRow, type TruthRow } from './datasets';
import { sha256Hex } from './files';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 9, min)).toISOString();

describe('assignSplits', () => {
  it('3 分以上あいたら別の塊とし、塊を時刻の順に、件数の少ない側に入れる（同数なら開発用）', () => {
    const rows = [
      { id: 'a', timestamp: at(0) },
      { id: 'b', timestamp: at(2) }, // a から 2 分。同じ塊
      { id: 'c', timestamp: at(4) }, // b から 2 分。同じ塊
      { id: 'd', timestamp: at(7) }, // c から 3 分。別の塊
      { id: 'e', timestamp: at(60) },
      { id: 'f', timestamp: at(61) },
      { id: 'g', timestamp: at(90) },
    ];
    const s = assignSplits(rows);
    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => s.get(id))).toEqual([
      { split: 'dev', chunk: 0 }, // 0 対 0。同数なので開発用
      { split: 'dev', chunk: 0 },
      { split: 'dev', chunk: 0 },
      { split: 'holdout', chunk: 1 }, // 3 対 0
      { split: 'holdout', chunk: 2 }, // 3 対 1
      { split: 'holdout', chunk: 2 },
      { split: 'dev', chunk: 3 }, // 3 対 3。同数なので開発用
    ]);
  });

  it('大きな塊があっても、塊は割らずに、残りの塊でつり合いを取る', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ id: `big${i}`, timestamp: at(i) }));
    const small = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, timestamp: at(100 + i * 10) }));
    const s = assignSplits([...big, ...small]);
    expect(new Set(big.map((r) => s.get(r.id)?.split))).toEqual(new Set(['dev']));
    expect(small.map((r) => s.get(r.id)?.split)).toEqual(['holdout', 'holdout', 'holdout', 'holdout', 'holdout', 'holdout']);
  });

  it('件数に数えるのは、文のある行だけ。文の無い行は、同じ塊の行と同じ側に入る', () => {
    const rows = [
      { id: 'a', timestamp: at(0), content: '' }, // 取り消した録音など
      { id: 'b', timestamp: at(1), content: '' },
      { id: 'c', timestamp: at(10), content: '文のある発話です。' },
      { id: 'd', timestamp: at(20), content: '次の発話です。' },
      { id: 'e', timestamp: at(21), content: '  ' },
    ];
    const s = assignSplits(rows);
    // 最初の塊は 0 件と数えるので、次の塊も開発用に入る
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => s.get(id)?.split)).toEqual(['dev', 'dev', 'dev', 'holdout', 'holdout']);
  });

  it('並びが時刻の順でなくても、時刻で塊を作る', () => {
    const s = assignSplits([
      { id: 'late', timestamp: at(40) },
      { id: 'early', timestamp: at(0) },
    ]);
    expect(s.get('early')).toEqual({ split: 'dev', chunk: 0 });
    expect(s.get('late')).toEqual({ split: 'holdout', chunk: 1 });
  });

  it('台本の読み上げは、行の split に従う（時刻では分けない）', () => {
    const s = assignSplits([
      { id: 's1', timestamp: at(0), split: 'A' as const },
      { id: 's2', timestamp: at(1), split: 'B' as const },
      { id: 'n1', timestamp: at(2) },
    ]);
    expect(s.get('s1')).toEqual({ split: 'dev', chunk: -1 });
    expect(s.get('s2')).toEqual({ split: 'holdout', chunk: -1 });
    expect(s.get('n1')).toEqual({ split: 'dev', chunk: 0 });
  });

  it('時刻の無い発話（公開データ）は、文の番号のハッシュで振る。同じ文の録音は同じ側に入る', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, timestamp: '', sentenceId: String(i % 20) }));
    const s = assignSplits(rows);
    for (let i = 0; i < 20; i++) expect(s.get(`p${i}`)).toEqual(s.get(`p${i + 20}`));
    const dev = rows.filter((r) => s.get(r.id)?.split === 'dev').length;
    expect(dev).toBeGreaterThan(8);
    expect(dev).toBeLessThan(32);
    expect(s.get('p0')?.chunk).toBe(-1);
    // 何度振っても同じ。文の番号が無ければ id で振る
    expect(assignSplits(rows)).toEqual(s);
    expect(assignSplits([{ id: 'x', timestamp: '' }]).get('x')?.chunk).toBe(-1);
  });

  it('後ろに行が増えても、前の行の振り分けは変わらない', () => {
    const rows = [
      { id: 'a', timestamp: at(0) },
      { id: 'b', timestamp: at(30) },
    ];
    const before = assignSplits(rows);
    const after = assignSplits([...rows, { id: 'c', timestamp: at(31) }, { id: 'd', timestamp: at(90) }]);
    expect(after.get('a')).toEqual(before.get('a'));
    expect(after.get('b')).toEqual(before.get('b'));
    expect(after.get('c')).toEqual({ split: 'holdout', chunk: 1 });
    // 開発用 1 件、確認用 2 件になったので、次の塊は開発用
    expect(after.get('d')).toEqual({ split: 'dev', chunk: 2 });
  });
});

describe('データセットと正解の読み込み', () => {
  let root = '';
  const wav = (seed: number) => encodeWav(Float32Array.from({ length: 1600 }, (_, i) => 0.1 * Math.sin((i + seed) / 5)));

  function writeDataset(name: string, rows: (Partial<ManifestRow> & { id: string })[], withHash: boolean): Map<string, string> {
    const dir = path.join(root, 'datasets', name);
    fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
    const hashes = new Map<string, string>();
    const lines = rows.map((r, i) => {
      const buf = wav(i + 1);
      fs.writeFileSync(path.join(dir, 'audio', `${r.id}.wav`), buf);
      hashes.set(r.id, sha256Hex(buf));
      return JSON.stringify({
        audio: `audio/${r.id}.wav`,
        durationSec: 0.1,
        timestamp: at(i),
        kind: 'dictation',
        rawText: '',
        content: '',
        ...(withHash ? { audioSha256: sha256Hex(buf) } : {}),
        ...r,
      });
    });
    fs.writeFileSync(path.join(dir, 'manifest.jsonl'), `${lines.join('\n')}\n`);
    return hashes;
  }

  const truthRow = (id: string, audioSha256: string, extra: Partial<TruthRow> = {}): TruthRow => ({
    id,
    audioSha256,
    target: '確かめた文です。',
    status: 'ok',
    prefill: 'longhand',
    reviewedAt: at(0),
    ...extra,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-eval-test-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('正解は、同じ id の最後の行が有効', () => {
    const file = path.join(root, 'truth.jsonl');
    fs.writeFileSync(file, [truthRow('u1', 'h', { target: '最初の文' }), truthRow('u2', 'h'), truthRow('u1', 'h', { target: '直した文' })].map((r) => JSON.stringify(r)).join('\n'));
    const t = loadTruth(file);
    expect(t.size).toBe(2);
    expect(t.get('u1')?.target).toBe('直した文');
    expect(loadTruth(path.join(root, 'none.jsonl')).size).toBe(0);
  });

  it('正解が無い発話は content を仮の正解にし、正解も content も無い発話は使わない', () => {
    writeDataset(
      'd1',
      [
        { id: 'u1', content: '仮の文です。' },
        { id: 'u2', content: '' },
      ],
      true,
    );
    const d = loadDataset(root, 'd1', new Map());
    expect(d.utterances.map((u) => u.id)).toEqual(['u1']);
    expect(d.utterances[0]).toMatchObject({ target: '仮の文です。', spoken: '仮の文です。', alt: [], provisional: true, dataset: 'd1' });
    expect(d.counts).toMatchObject({ rows: 2, used: 1, provisional: 1, reviewed: 0, noReference: 1 });
  });

  it('正解があれば使う。話したままの文と別解も読み、除外の発話は外す', () => {
    const h = writeDataset(
      'd1',
      [
        { id: 'u1', content: '仮の文です。' },
        { id: 'u2', content: '除く文です。' },
        { id: 'u3', content: '' },
      ],
      true,
    );
    const truth = new Map<string, TruthRow>([
      ['u1', truthRow('u1', h.get('u1')!, { target: '資料をください。', spoken: 'えー資料をください', alt: ['資料を下さい。'], tags: ['短い'] })],
      ['u2', truthRow('u2', h.get('u2')!, { status: 'excluded' })],
      ['u3', truthRow('u3', h.get('u3')!, { target: '音だけの発話にも正解を付けた。' })],
    ]);
    const d = loadDataset(root, 'd1', truth);
    expect(d.utterances.map((u) => u.id)).toEqual(['u1', 'u3']);
    expect(d.utterances[0]).toMatchObject({ target: '資料をください。', spoken: 'えー資料をください', alt: ['資料を下さい。'], tags: ['短い'], provisional: false });
    expect(d.utterances[1].spoken).toBe('音だけの発話にも正解を付けた。');
    expect(d.counts).toMatchObject({ used: 2, provisional: 0, reviewed: 2, excluded: 1 });
  });

  it('manifest にハッシュが無ければ音声から求める。別の音声に付けた正解は使わず、仮の正解に戻す', () => {
    const h = writeDataset('d1', [{ id: 'u1', content: '仮の文です。' }], false);
    const ok = loadDataset(root, 'd1', new Map([['u1', truthRow('u1', h.get('u1')!)]]));
    expect(ok.utterances[0]).toMatchObject({ audioSha256: h.get('u1'), provisional: false, target: '確かめた文です。' });
    const bad = loadDataset(root, 'd1', new Map([['u1', truthRow('u1', 'ffff')]]));
    expect(bad.utterances[0]).toMatchObject({ provisional: true, target: '仮の文です。' });
    expect(bad.counts.hashMismatch).toBe(1);
  });

  it('台本の行の split と用語を引き継ぐ。音声が無い行は数えて飛ばす', () => {
    writeDataset(
      'script',
      [
        { id: 's1', content: '一つ目の文です。', split: 'A', terms: ['用語'], tags: ['number'], category: 'number', postRollMs: 300 },
        { id: 's2', content: '二つ目の文です。', split: 'B' },
        { id: 's3', content: '音声の無い文です。', split: 'A' },
      ],
      true,
    );
    fs.rmSync(path.join(root, 'datasets', 'script', 'audio', 's3.wav'));
    const d = loadDataset(root, 'script', new Map());
    expect(d.utterances.map((u) => [u.id, u.split, u.terms, u.tags])).toEqual([
      ['s1', 'dev', ['用語'], ['number']],
      ['s2', 'holdout', [], []],
    ]);
    // 文の種類と、離した後に録った長さも引き継ぐ（無ければ undefined）
    expect(d.utterances.map((u) => [u.category, u.postRollMs])).toEqual([
      ['number', 300],
      [undefined, undefined],
    ]);
    expect(d.counts.missingAudio).toBe(1);
    expect(() => loadDataset(root, 'none', new Map())).toThrow(/見つかりません/);
  });

  it('語の一覧は、空行と重複を除く', () => {
    const file = path.join(root, 'words.txt');
    fs.writeFileSync(file, 'Longhand\n\n  用語集  \nLonghand\n');
    expect(readWordList(file)).toEqual(['Longhand', '用語集']);
  });
});
