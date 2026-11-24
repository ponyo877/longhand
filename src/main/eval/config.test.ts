import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandHome, parseEvalConfig, resolveRunDir, validateEvalConfig } from './config';

describe('evaluation config', () => {
  const base = { name: 'run', datasets: ['d1'], llm: 'off' };

  it('checks the required fields and expands ~ in the dictionary path', () => {
    const c = validateEvalConfig({ ...base, vocab: '~/words.txt' });
    expect(c.vocab).toBe(path.join(os.homedir(), 'words.txt'));
    expect(c.readings).toBeNull();
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(() => validateEvalConfig({ ...base, name: '' })).toThrow(/name/);
    expect(() => validateEvalConfig({ ...base, datasets: [] })).toThrow(/datasets/);
    expect(() => validateEvalConfig({ ...base, llm: 'on' })).toThrow(/llm/);
    expect(() => validateEvalConfig({ ...base, split: 'test' })).toThrow(/split/);
    expect(() => validateEvalConfig({ ...base, maxLlmCalls: -1 })).toThrow(/maxLlmCalls/);
    expect(() => validateEvalConfig([])).toThrow(/JSON object/);
  });

  it('accepts only postRoll or a number of 0 or more for the tail cut', () => {
    expect(validateEvalConfig({ ...base, truncateTail: 'postRoll' }).truncateTail).toBe('postRoll');
    expect(validateEvalConfig({ ...base, truncateTail: 300 }).truncateTail).toBe(300);
    expect(validateEvalConfig(base).truncateTail).toBeUndefined();
    expect(() => validateEvalConfig({ ...base, truncateTail: 'all' })).toThrow(/truncateTail/);
    expect(() => validateEvalConfig({ ...base, truncateTail: -1 })).toThrow(/truncateTail/);
    expect(() => validateEvalConfig({ ...base, truncateTail: Number.NaN })).toThrow(/truncateTail/);
  });

  it('reads from JSON itself and from a file', () => {
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
    make('2026-01-01T12-00-00-base', false); // a run with no rows (it crashed halfway)
  });
  afterEach(() => {
    fs.rmSync(runs, { recursive: true, force: true });
  });

  it('finds a run by folder path and by folder name', () => {
    const dir = path.join(runs, '2026-01-01T09-00-00-base');
    expect(resolveRunDir(dir, runs)).toBe(dir);
    expect(resolveRunDir('2026-01-01T09-00-00-base', runs)).toBe(dir);
  });

  it('finds the latest run with a name and ignores runs whose name only partly matches', () => {
    expect(resolveRunDir('base', runs)).toBe(path.join(runs, '2026-01-01T10-00-00-base'));
    expect(resolveRunDir('asr-base', runs)).toBe(path.join(runs, '2026-01-01T11-00-00-asr-base'));
    expect(() => resolveRunDir('se', runs)).toThrow(/not found/);
    expect(() => resolveRunDir('none', runs)).toThrow(/not found/);
  });
});
