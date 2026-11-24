import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandHome, parseEvalConfig, resolveRunDir, validateEvalConfig } from './config';

describe('評価の設定', () => {
  const base = { name: 'run', datasets: ['d1'], llm: 'off' };

  it('必要な項目を確かめ、辞書のパスの ~ を開く', () => {
    const c = validateEvalConfig({ ...base, vocab: '~/words.txt' });
    expect(c.vocab).toBe(path.join(os.homedir(), 'words.txt'));
    expect(c.readings).toBeNull();
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(() => validateEvalConfig({ ...base, name: '' })).toThrow(/name/);
    expect(() => validateEvalConfig({ ...base, datasets: [] })).toThrow(/datasets/);
    expect(() => validateEvalConfig({ ...base, llm: 'on' })).toThrow(/llm/);
    expect(() => validateEvalConfig({ ...base, split: 'test' })).toThrow(/split/);
    expect(() => validateEvalConfig({ ...base, maxLlmCalls: -1 })).toThrow(/maxLlmCalls/);
    expect(() => validateEvalConfig([])).toThrow(/オブジェクト/);
  });

  it('末尾の切り落としは、postRoll か 0 以上の数だけを受け付ける', () => {
    expect(validateEvalConfig({ ...base, truncateTail: 'postRoll' }).truncateTail).toBe('postRoll');
    expect(validateEvalConfig({ ...base, truncateTail: 300 }).truncateTail).toBe(300);
    expect(validateEvalConfig(base).truncateTail).toBeUndefined();
    expect(() => validateEvalConfig({ ...base, truncateTail: 'all' })).toThrow(/truncateTail/);
    expect(() => validateEvalConfig({ ...base, truncateTail: -1 })).toThrow(/truncateTail/);
    expect(() => validateEvalConfig({ ...base, truncateTail: Number.NaN })).toThrow(/truncateTail/);
  });

  it('JSON そのものからも、ファイルからも読める', () => {
    expect(parseEvalConfig(JSON.stringify(base)).name).toBe('run');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-eval-config-'));
    try {
      const file = path.join(dir, 'c.json');
      fs.writeFileSync(file, JSON.stringify({ ...base, name: 'from-file' }));
      expect(parseEvalConfig(file).name).toBe('from-file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveRunDir', () => {
  let runs = '';
  const make = (name: string, withRows = true) => {
    fs.mkdirSync(path.join(runs, name), { recursive: true });
    if (withRows) fs.writeFileSync(path.join(runs, name, 'rows.jsonl'), '');
  };

  beforeEach(() => {
    runs = fs.mkdtempSync(path.join(os.tmpdir(), 'longhand-eval-runs-'));
    make('2026-01-01T09-00-00-base');
    make('2026-01-01T10-00-00-base');
    make('2026-01-01T11-00-00-asr-base');
    make('2026-01-01T12-00-00-base', false); // 行の無い（途中で落ちた）実行
  });
  afterEach(() => {
    fs.rmSync(runs, { recursive: true, force: true });
  });

  it('フォルダのパスと、フォルダ名で探せる', () => {
    const dir = path.join(runs, '2026-01-01T09-00-00-base');
    expect(resolveRunDir(dir, runs)).toBe(dir);
    expect(resolveRunDir('2026-01-01T09-00-00-base', runs)).toBe(dir);
  });

  it('実行の名前で探すと、その名前の最も新しい実行になる。名前の一部が同じだけの実行は拾わない', () => {
    expect(resolveRunDir('base', runs)).toBe(path.join(runs, '2026-01-01T10-00-00-base'));
    expect(resolveRunDir('asr-base', runs)).toBe(path.join(runs, '2026-01-01T11-00-00-asr-base'));
    expect(() => resolveRunDir('se', runs)).toThrow(/見つかりません/);
    expect(() => resolveRunDir('none', runs)).toThrow(/見つかりません/);
  });
});
