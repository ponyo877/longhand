"""
微調整したモデルと元のモデルを、発話の組ごとに比べる（数だけを出す。文面は出さない）。

  python3 finetune/report.py base run1          # 書き起こしの生の出力（asr）で比べる
  python3 finetune/report.py base run1 noLlm    # 読みの照合と語ごとの補正の後で比べる

finetune/eval.sh が作った実行（ft-<実行>-{real,synth,real-vocab,synth-vocab}）を読む。
合成音声の台本は、用語の文を「学習した語」「学習から外した語」「用語集に無い語」に分ける。
"""
import json, os, sys, collections
R = os.path.expanduser('~/longhand-eval/runs')
A, B = sys.argv[1], sys.argv[2]
STAGE = sys.argv[3] if len(sys.argv) > 3 else 'asr'
def rows(name):
    c = sorted(d for d in os.listdir(R) if d.endswith('-' + name))
    if not c: return None
    return {r['id']: r for r in map(json.loads, open(os.path.join(R, c[-1], 'rows.jsonl')))}
# 評価に使う台本の B に出てくる、用語集の語（12 語）。学習から外してある
HOLD = {'Jira', 'PostgreSQL', 'ChatGPT', 'Claude', 'VS Code', 'ESLint', 'Datadog', 'API', 'Next.js', 'Vercel', 'Excel', 'BigQuery'}
ft_terms = set(t for l in open(os.path.expanduser('~/longhand-eval/ft/sentences.jsonl')) for t in json.loads(l).get('terms', []))
man = {}
for ds in ['synth-script-v1', 'synth-spoken-v1']:
    for l in open(os.path.expanduser(f'~/longhand-eval/datasets/{ds}/manifest.jsonl')):
        m = json.loads(l); man[m['id']] = m
def group(r):
    ds = r['dataset']
    if ds.startswith('synth-script'):
        terms = set(man.get(r['id'], {}).get('terms') or [])
        if r['category'] in ('lexicon', 'unlisted', 'mixed'):
            if terms & ft_terms and not terms & HOLD: return f"台本 {r['category']}（学習した語）"
            if terms & HOLD: return f"台本 {r['category']}（学習から外した語）"
            return f"台本 {r['category']}（用語集に無い語）"
        return f"台本 {r['category']}"
    if ds.startswith('synth-spoken'): return '話し言葉'
    return f"{ds} {'開発用' if r['split']=='dev' else '確認用'}" if ds.startswith('user') else ds
def table(suffix):
    a, b = rows(f'ft-{A}-{suffix}'), rows(f'ft-{B}-{suffix}')
    if not a or not b: print(f'[{suffix}] 実行がありません'); return
    g = collections.OrderedDict()
    for i, ra in a.items():
        rb = b.get(i)
        if not rb: continue
        for k in (group(ra), f"［{ra['dataset']} 全体］"):
            x = g.setdefault(k, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
            sa, sb = ra['scores'][STAGE], rb['scores'][STAGE]
            x[0] += 1; x[1] += sa['content']['edits']; x[2] += sb['content']['edits']; x[3] += sa['content']['len']
            x[4] += sa['latin']['hit']; x[5] += sb['latin']['hit']; x[6] += sa['latin']['total']
            x[7] += sb['content']['edits'] < sa['content']['edits']; x[8] += sb['content']['edits'] > sa['content']['edits']
            # 別解のある発話では、実行ごとに近いほうの正解で数える。分母も、その実行のものを使う
            x[9] += sb['content']['len']; x[10] += sb['latin']['total']
    print(f'[{suffix}] {A} → {B}（段階 {STAGE}）')
    for k, x in sorted(g.items()):
        rel = (x[2] - x[1]) / x[1] * 100 if x[1] else 0
        print(f"  {k:<28} {x[0]:>4} 件  誤り {x[1]:>4} → {x[2]:>4}（{x[2]-x[1]:+d}、{rel:+.0f}%、率 {x[1]/max(1,x[3])*100:.2f}% → {x[2]/max(1,x[9])*100:.2f}%）  英字の語 {x[4]}/{x[6]} → {x[5]}/{x[10]}  良化 {x[7]} 悪化 {x[8]}")
for s in ['real', 'synth', 'real-vocab', 'synth-vocab']:
    table(s)
