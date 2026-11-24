import { describe, expect, it } from 'vitest';
import type { Uncertain } from '../asr/hypotheses';
import { formatOracle, oracleRow, oracleSummary, type OracleRow } from './oracle';

const spot = (heard: string, alternatives: string[], source: Uncertain['source'] = 'rehear'): Uncertain => ({ heard, alternatives, source });

describe('oracleRow', () => {
  it('adopts only candidates closer to the reference', () => {
    const r = oracleRow('機関を決めて飴が降る', ['期間を決めて雨が降る'], [spot('機関', ['期間']), spot('飴', ['網', '雨'])]);
    expect(r.text).toBe('期間を決めて雨が降る');
    expect(r).toMatchObject({ before: { edits: 3, len: 10 }, oracle: { edits: 0, len: 10 }, spots: 2, adopted: 2, notFound: 0 });
    expect(r.bySource).toEqual({ rehear: { spots: 2, adopted: 2, editsSaved: 3 } });
  });

  it('does not adopt candidates that move away from the reference or change nothing', () => {
    const r = oracleRow('明日の会議は午後からです', ['明日の会議は午後からです'], [spot('午後', ['午前']), spot('会議', ['会議'])]);
    expect(r.text).toBe('明日の会議は午後からです');
    expect(r).toMatchObject({ adopted: 0, before: { edits: 0 }, oracle: { edits: 0 } });
    // Adopting the first candidate without looking at the reference adds an error
    expect(r.first.edits).toBe(1);
  });

  it('adopts the closest candidate when there are several', () => {
    const r = oracleRow('スラックで送る', ['Slackで送る'], [spot('スラック', ['スラッグ', 'slack', 'Slack'], 'token')]);
    expect(r.oracle.edits).toBe(0);
    expect(r.bySource.token).toEqual({ spots: 1, adopted: 1, editsSaved: 5 });
    // Only content is compared, so case differences are the same distance. The one found first is adopted
    expect(r.text).toBe('slackで送る');
  });

  it('replaces the occurrence that reduces the distance the most when the same phrase appears several times', () => {
    const r = oracleRow('橋を渡って橋で食べる', ['橋を渡って箸で食べる'], [spot('橋', ['箸'])]);
    expect(r.text).toBe('橋を渡って箸で食べる');
    expect(r.adopted).toBe(1);
    // Without looking at the reference, the first occurrence is replaced, which makes it worse
    expect(r.first.edits).toBe(2);
  });

  it('adopts one spot at a time, building on what earlier spots adopted, and counts spots not found in the transcript', () => {
    const r = oracleRow('きかんを決める', ['期間を決める'], [spot('きかん', ['機関', '期間']), spot('きかん', ['帰還']), spot('無い語句', ['何か'])]);
    expect(r.text).toBe('期間を決める');
    expect(r).toMatchObject({ spots: 3, adopted: 1, notFound: 2 });
  });

  it('decides by the distance to the closer reference when there are alternatives', () => {
    const r = oracleRow('資料をくだsai', ['資料をください', '資料を下さい'], [spot('くだsai', ['下さい'])]);
    expect(r.oracle.edits).toBe(0);
    expect(r.oracle.len).toBe(6);
  });

  it('changes nothing when there are no spots', () => {
    const r = oracleRow('今日は雨です', ['今日は晴れです'], []);
    expect(r).toMatchObject({ text: '今日は雨です', spots: 0, adopted: 0, before: { edits: 2 }, oracle: { edits: 2 }, first: { edits: 2 } });
  });
});

describe('oracleSummary', () => {
  const row = (asr: string, target: string, uncertain?: Uncertain[], dataset = 'd1'): OracleRow => ({ dataset, target, alt: [], stages: { asr }, asr: { uncertain } });
  const rows = [
    row('機関を決める', '期間を決める', [spot('機関', ['期間'])]),
    row('飴が降る', '雨が降る', [spot('飴', ['網'], 'token'), spot('降る', ['振る'], 'token')]),
    row('今日は雨です', '今日は晴れです'),
    row('同じ文です', '同じ文です', undefined, 'd2'),
  ];

  it('reports target utterances, spots, adoptions, errors before and after, and a breakdown by source', () => {
    const s = oracleSummary(rows);
    expect(s).toMatchObject({ rows: 4, utterances: 2, improved: 1, spots: 3, adopted: 1, notFound: 0 });
    expect(s.all.before).toEqual({ edits: 5, len: 22 });
    expect(s.all.oracle).toEqual({ edits: 3, len: 22 });
    expect(s.target.before).toEqual({ edits: 3, len: 10 });
    expect(s.target.oracle).toEqual({ edits: 1, len: 10 });
    // Adopting the first candidate without looking at the reference fixes the first utterance but makes both spots of the second worse (0 + 2)
    expect(s.target.first.edits).toBe(2);
    expect(s.bySource).toEqual({ rehear: { spots: 1, adopted: 1, editsSaved: 2 }, token: { spots: 2, adopted: 0, editsSaved: 0 } });
  });

  it('displays counts only, without sentences', () => {
    const text = formatOracle('all', oracleSummary(rows)).join('\n');
    expect(text).toContain('2 of 4 utterances have spots that may be misheard');
    expect(text).toContain('spots 3, adopted 1');
    expect(text).toContain('before 5');
    expect(text).toContain('rehearing: spots 1, adopted 1');
    expect(text).toContain('low-confidence alternatives: spots 2, adopted 0');
    for (const t of ['機関', '期間', '飴', '雨', '降る']) expect(text).not.toContain(t);
  });

  it('reports 0 target utterances and unchanged errors when no utterance has spots', () => {
    const s = oracleSummary([row('今日は雨です', '今日は晴れです')]);
    expect(s).toMatchObject({ utterances: 0, spots: 0, adopted: 0 });
    expect(s.all.oracle).toEqual(s.all.before);
    expect(s.target.before).toEqual({ edits: 0, len: 0 });
  });
});
