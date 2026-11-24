/**
 * Computes the potential of alternatives (an oracle). Estimates how much re-hearing and alternatives (the row's asr.uncertain) could help.
 *
 *   npx tsx scripts/eval-oracle.ts <run> [<run> …]
 *     A run is a folder name under ~/longhand-eval/runs/ or a folder path. Given only a run name, the newest run with that name is used
 *     (pass a run that asked for re-hearing or alternatives, for example asr-rehear or asr-vocab-rehear)
 *
 * For each spot, tries replacing the phrase in the transcript with each candidate and reports the errors when only candidates that
 * reduce the edit distance (content) to the reference are adopted.
 * It picks by looking at the reference, so it is the upper bound real formatting can reach. For comparison, it also reports adopting
 * the first candidate at every spot.
 * Prints numbers only (no sentences).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveRunDir } from '../src/main/eval/config';
import { evalRoot, readJsonl } from '../src/main/eval/files';
import { formatOracle, oracleSummary } from '../src/main/eval/oracle';
import type { RowRecord } from '../src/main/eval/score';

const { positionals } = parseArgs({ allowPositionals: true, options: {} });

function main(): void {
  if (!positionals.length) throw new Error('Usage: npx tsx scripts/eval-oracle.ts <run> [<run> …]');
  const runs = path.join(evalRoot(), 'runs');
  for (const spec of positionals) {
    const dir = resolveRunDir(spec, runs);
    const rows = readJsonl<RowRecord>(path.join(dir, 'rows.jsonl'));
    console.log(`Run: ${path.basename(dir)} (${rows.length} utterances)`);
    const provisional = rows.filter((r) => r.provisional).length;
    if (provisional) console.log(`Note: ${provisional} utterances have a provisional reference`);
    if (!rows.some((r) => r.asr.uncertain?.length)) {
      console.log('  No utterance has a possibly misheard spot (pass a run that asked for re-hearing or alternatives)');
      continue;
    }
    for (const l of formatOracle('All', oracleSummary(rows))) console.log(l);
    const datasets = [...new Set(rows.map((r) => r.dataset))].sort();
    if (datasets.length > 1) for (const d of datasets) for (const l of formatOracle(d, oracleSummary(rows.filter((r) => r.dataset === d)))) console.log(l);
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
