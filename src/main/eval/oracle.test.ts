import { describe, expect, it } from 'vitest';
import type { Uncertain } from '../asr/hypotheses';
import { formatOracle, oracleRow, oracleSummary, type OracleRow } from './oracle';

const spot = (heard: string, alternatives: string[], source: Uncertain['source'] = 'rehear'): Uncertain => ({ heard, alternatives, source });

describe('oracleRow', () => {
  it('正解に近づく候補だけを採る', () => {
    const r = oracleRow('機関を決めて飴が降る', ['期間を決めて雨が降る'], [spot('機関', ['期間']), spot('飴', ['網', '雨'])]);
    expect(r.text).toBe('期間を決めて雨が降る');
    expect(r).toMatchObject({ before: { edits: 3, len: 10 }, oracle: { edits: 0, len: 10 }, spots: 2, adopted: 2, notFound: 0 });
    expect(r.bySource).toEqual({ rehear: { spots: 2, adopted: 2, editsSaved: 3 } });
  });

  it('正解から遠ざかる候補と、変わらない候補は採らない', () => {
    const r = oracleRow('明日の会議は午後からです', ['明日の会議は午後からです'], [spot('午後', ['午前']), spot('会議', ['会議'])]);
    expect(r.text).toBe('明日の会議は午後からです');
    expect(r).toMatchObject({ adopted: 0, before: { edits: 0 }, oracle: { edits: 0 } });
    // 正解を見ずに 1 番目の候補を採ると、誤りが増える
    expect(r.first.edits).toBe(1);
  });

  it('候補が複数あれば、最も近づくものを採る', () => {
    const r = oracleRow('スラックで送る', ['Slackで送る'], [spot('スラック', ['スラッグ', 'slack', 'Slack'], 'token')]);
    expect(r.oracle.edits).toBe(0);
    expect(r.bySource.token).toEqual({ spots: 1, adopted: 1, editsSaved: 5 });
    // 中身だけを比べるので、大文字と小文字の違いは同じ距離。先に見つかったものを採る
    expect(r.text).toBe('slackで送る');
  });

  it('同じ語句が何度も出るときは、距離が最も減る出現を置き換える', () => {
    const r = oracleRow('橋を渡って橋で食べる', ['橋を渡って箸で食べる'], [spot('橋', ['箸'])]);
    expect(r.text).toBe('橋を渡って箸で食べる');
    expect(r.adopted).toBe(1);
    // 正解を見ない場合は、最初の出現を置き換えるので悪くなる
    expect(r.first.edits).toBe(2);
  });

  it('1 か所ずつ、前の箇所で採った結果に重ねる。書き起こしに見つからない箇所は数える', () => {
    const r = oracleRow('きかんを決める', ['期間を決める'], [spot('きかん', ['機関', '期間']), spot('きかん', ['帰還']), spot('無い語句', ['何か'])]);
    expect(r.text).toBe('期間を決める');
    expect(r).toMatchObject({ spots: 3, adopted: 1, notFound: 2 });
  });

  it('別解があれば、近いほうの正解との距離で決める', () => {
    const r = oracleRow('資料をくだsai', ['資料をください', '資料を下さい'], [spot('くだsai', ['下さい'])]);
    expect(r.oracle.edits).toBe(0);
    expect(r.oracle.len).toBe(6);
  });

  it('箇所が無ければ何も変えない', () => {
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

  it('対象の発話、箇所、採った数、誤り数の前後、根拠ごとの内訳を出す', () => {
    const s = oracleSummary(rows);
    expect(s).toMatchObject({ rows: 4, utterances: 2, improved: 1, spots: 3, adopted: 1, notFound: 0 });
    expect(s.all.before).toEqual({ edits: 5, len: 22 });
    expect(s.all.oracle).toEqual({ edits: 3, len: 22 });
    expect(s.target.before).toEqual({ edits: 3, len: 10 });
    expect(s.target.oracle).toEqual({ edits: 1, len: 10 });
    // 正解を見ずに 1 番目の候補を採ると、1 件目は直るが、2 件目は 2 か所とも悪くなる（0 + 2）
    expect(s.target.first.edits).toBe(2);
    expect(s.bySource).toEqual({ rehear: { spots: 1, adopted: 1, editsSaved: 2 }, token: { spots: 2, adopted: 0, editsSaved: 0 } });
  });

  it('表示は数だけで、文を含まない', () => {
    const text = formatOracle('全体', oracleSummary(rows)).join('\n');
    expect(text).toContain('聞き違いかもしれない箇所のある発話 2 件');
    expect(text).toContain('箇所 3、採った 1');
    expect(text).toContain('もと 5');
    expect(text).toContain('聞き直し: 箇所 1、採った 1');
    expect(text).toContain('確信度の低い箇所の別候補: 箇所 2、採った 0');
    for (const t of ['機関', '期間', '飴', '雨', '降る']) expect(text).not.toContain(t);
  });

  it('箇所のある発話が無ければ、対象は 0 件で、誤りは変わらない', () => {
    const s = oracleSummary([row('今日は雨です', '今日は晴れです')]);
    expect(s).toMatchObject({ utterances: 0, spots: 0, adopted: 0 });
    expect(s.all.oracle).toEqual(s.all.before);
    expect(s.target.before).toEqual({ edits: 0, len: 0 });
  });
});
