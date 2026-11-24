/**
 * Loads the evaluation config (EvalConfig). Used both from tsx arguments and from LONGHAND_EVAL inside the app.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EvalConfig } from './run';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

const LLM_MODES = ['off', 'live', 'cache-only'];

/** Checks the shape of the config. Missing fields and unknown values stop the run before it starts */
export function validateEvalConfig(v: unknown): EvalConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The evaluation config must be a JSON object');
  const c = v as Partial<EvalConfig>;
  if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('The evaluation config has no name (the name of the run)');
  if (!Array.isArray(c.datasets) || !c.datasets.length || c.datasets.some((d) => typeof d !== 'string')) throw new Error('The evaluation config has no datasets (an array of dataset names)');
  if (typeof c.llm !== 'string' || !LLM_MODES.includes(c.llm)) throw new Error('llm in the evaluation config must be off, live or cache-only');
  if (c.maxLlmCalls !== undefined && (!Number.isInteger(c.maxLlmCalls) || c.maxLlmCalls < 0)) throw new Error('maxLlmCalls must be an integer of 0 or more');
  if (c.split !== undefined && !['dev', 'holdout', 'all'].includes(c.split)) throw new Error('split must be dev, holdout or all');
  if (c.truncateTail !== undefined && c.truncateTail !== 'postRoll' && !(typeof c.truncateTail === 'number' && Number.isFinite(c.truncateTail) && c.truncateTail >= 0)) {
    throw new Error('truncateTail must be postRoll or a number of 0 or more (ms)');
  }
  if (c.learn !== undefined) {
    if (!c.learn || typeof c.learn.train !== 'string' || !c.learn.train) throw new Error('learn.train (a regular expression for the ids of the utterances to learn from) is missing');
    try {
      new RegExp(c.learn.train);
    } catch {
      throw new Error('learn.train is not a valid regular expression');
    }
    const kinds = ['words', 'forms', 'corrections', 'kept', 'numbers'];
    if (c.learn.kinds !== undefined && (!Array.isArray(c.learn.kinds) || c.learn.kinds.some((k) => !kinds.includes(k)))) {
      throw new Error(`learn.kinds must be an array of ${kinds.join(', ')}`);
    }
  }
  return {
    ...(c as EvalConfig),
    vocab: c.vocab ? expandHome(c.vocab) : null,
    readings: c.readings ? expandHome(c.readings) : null,
  };
}

/** Reads the config from the path of a JSON file, or from JSON itself (a string starting with {) */
export function parseEvalConfig(spec: string): EvalConfig {
  const s = spec.trim();
  const text = s.startsWith('{') ? s : fs.readFileSync(expandHome(s), 'utf8');
  return validateEvalConfig(JSON.parse(text));
}

/**
 * Finds a run's folder. Tries a path, a folder name under runs, then a run name (the latest run with that name), in that order.
 * runsDir is <evaluation data folder>/runs
 */
export function resolveRunDir(spec: string, runsDir: string): string {
  const direct = [expandHome(spec), path.join(runsDir, spec)].find((p) => fs.existsSync(path.join(p, 'rows.jsonl')));
  if (direct) return direct;
  const byName = fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir)
        // Folder names are "<date and time>-<name>". Only an exact match of the whole name counts ("base" does not pick "asr-base")
        .filter((d) => d.replace(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, '') === spec && fs.existsSync(path.join(runsDir, d, 'rows.jsonl')))
        .sort()
    : [];
  if (!byName.length) throw new Error(`Run not found: ${spec}`);
  return path.join(runsDir, byName[byName.length - 1]);
}
