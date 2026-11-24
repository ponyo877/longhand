/**
 * 評価の設定（EvalConfig）の読み込み。tsx の引数と、アプリの中の LONGHAND_EVAL の両方から使う。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EvalConfig } from './run';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

const LLM_MODES = ['off', 'live', 'cache-only'];

/** 設定の形を確かめる。足りない項目や知らない値は、実行の前に止める */
export function validateEvalConfig(v: unknown): EvalConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('評価の設定は JSON のオブジェクトにしてください');
  const c = v as Partial<EvalConfig>;
  if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('評価の設定に name（実行の名前）がありません');
  if (!Array.isArray(c.datasets) || !c.datasets.length || c.datasets.some((d) => typeof d !== 'string')) throw new Error('評価の設定に datasets（データセットの名前の配列）がありません');
  if (typeof c.llm !== 'string' || !LLM_MODES.includes(c.llm)) throw new Error('評価の設定の llm は off、live、cache-only のどれかにしてください');
  if (c.maxLlmCalls !== undefined && (!Number.isInteger(c.maxLlmCalls) || c.maxLlmCalls < 0)) throw new Error('maxLlmCalls は 0 以上の整数にしてください');
  if (c.split !== undefined && !['dev', 'holdout', 'all'].includes(c.split)) throw new Error('split は dev、holdout、all のどれかにしてください');
  if (c.truncateTail !== undefined && c.truncateTail !== 'postRoll' && !(typeof c.truncateTail === 'number' && Number.isFinite(c.truncateTail) && c.truncateTail >= 0)) {
    throw new Error('truncateTail は postRoll か、0 以上の数（ms）にしてください');
  }
  if (c.learn !== undefined) {
    if (!c.learn || typeof c.learn.train !== 'string' || !c.learn.train) throw new Error('learn.train（学習に使う発話の id の正規表現）がありません');
    try {
      new RegExp(c.learn.train);
    } catch {
      throw new Error('learn.train を正規表現として読めません');
    }
    const kinds = ['words', 'forms', 'corrections', 'kept', 'numbers'];
    if (c.learn.kinds !== undefined && (!Array.isArray(c.learn.kinds) || c.learn.kinds.some((k) => !kinds.includes(k)))) {
      throw new Error(`learn.kinds は ${kinds.join('、')} の配列にしてください`);
    }
  }
  return {
    ...(c as EvalConfig),
    vocab: c.vocab ? expandHome(c.vocab) : null,
    readings: c.readings ? expandHome(c.readings) : null,
  };
}

/** JSON のファイルのパスか、JSON そのもの（{ で始まる文字列）から設定を読む */
export function parseEvalConfig(spec: string): EvalConfig {
  const s = spec.trim();
  const text = s.startsWith('{') ? s : fs.readFileSync(expandHome(s), 'utf8');
  return validateEvalConfig(JSON.parse(text));
}

/**
 * 実行のフォルダを探す。パス、runs の下のフォルダ名、実行の名前（その名前の最も新しい実行）の順に試す。
 * runsDir は <評価のデータの置き場所>/runs
 */
export function resolveRunDir(spec: string, runsDir: string): string {
  const direct = [expandHome(spec), path.join(runsDir, spec)].find((p) => fs.existsSync(path.join(p, 'rows.jsonl')));
  if (direct) return direct;
  const byName = fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir)
        // フォルダ名は「日時-名前」。名前の全体が一致するものだけを採る（「base」で「asr-base」を拾わない）
        .filter((d) => d.replace(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, '') === spec && fs.existsSync(path.join(runsDir, d, 'rows.jsonl')))
        .sort()
    : [];
  if (!byName.length) throw new Error(`実行が見つかりません: ${spec}`);
  return path.join(runsDir, byName[byName.length - 1]);
}
