"""
Compares a fine-tuned model with the base model per group of utterances (prints numbers only, no text).

  python3 finetune/report.py base run1          # compare raw transcription output (asr)
  python3 finetune/report.py base run1 noLlm    # compare after reading match and per-word fixes

Reads the runs made by finetune/eval.sh (ft-<run>-{real,synth,real-vocab,synth-vocab}).
For the synthesized script, term sentences are split into "trained terms", "held-out terms" and "terms not in the glossary".
"""
import json, os, sys, collections
R = os.path.expanduser('~/longhand-eval/runs')
A, B = sys.argv[1], sys.argv[2]
STAGE = sys.argv[3] if len(sys.argv) > 3 else 'asr'
def rows(name):
    c = sorted(d for d in os.listdir(R) if d.endswith('-' + name))
    if not c: return None
    return {r['id']: r for r in map(json.loads, open(os.path.join(R, c[-1], 'rows.jsonl')))}
# Glossary words (12) that appear in B of the evaluation script. Held out from training
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
            if terms & ft_terms and not terms & HOLD: return f"script {r['category']} (trained terms)"
            if terms & HOLD: return f"script {r['category']} (held-out terms)"
            return f"script {r['category']} (terms not in the glossary)"
        return f"script {r['category']}"
    if ds.startswith('synth-spoken'): return 'spoken'
    return f"{ds} {'dev' if r['split']=='dev' else 'holdout'}" if ds.startswith('user') else ds
def table(suffix):
    a, b = rows(f'ft-{A}-{suffix}'), rows(f'ft-{B}-{suffix}')
    if not a or not b: print(f'[{suffix}] run not found'); return
    g = collections.OrderedDict()
    for i, ra in a.items():
        rb = b.get(i)
        if not rb: continue
        for k in (group(ra), f"［{ra['dataset']} all］"):
            x = g.setdefault(k, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
            sa, sb = ra['scores'][STAGE], rb['scores'][STAGE]
            x[0] += 1; x[1] += sa['content']['edits']; x[2] += sb['content']['edits']; x[3] += sa['content']['len']
            x[4] += sa['latin']['hit']; x[5] += sb['latin']['hit']; x[6] += sa['latin']['total']
            x[7] += sb['content']['edits'] < sa['content']['edits']; x[8] += sb['content']['edits'] > sa['content']['edits']
            # For utterances with alternatives, each run is scored against its closer reference. The denominator is that run's too
            x[9] += sb['content']['len']; x[10] += sb['latin']['total']
    print(f'[{suffix}] {A} → {B} (stage {STAGE})')
    for k, x in sorted(g.items()):
        rel = (x[2] - x[1]) / x[1] * 100 if x[1] else 0
        print(f"  {k:<28} {x[0]:>4} rows  errors {x[1]:>4} → {x[2]:>4} ({x[2]-x[1]:+d}, {rel:+.0f}%, rate {x[1]/max(1,x[3])*100:.2f}% → {x[2]/max(1,x[9])*100:.2f}%)  Latin terms {x[4]}/{x[6]} → {x[5]}/{x[10]}  better {x[7]} worse {x[8]}")
for s in ['real', 'synth', 'real-vocab', 'synth-vocab']:
    table(s)
