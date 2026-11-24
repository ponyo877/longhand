import { useEffect, useRef, useState, type ReactNode } from 'react';
import { extractCandidates, textsFromFile, type DictCandidate } from '../../shared/dictCandidates';
import type { MessageKey, Translate, Vars } from '../../shared/i18n';
import { CUSTOMIZATION_LIMITS as LIMITS, type AppSnapshot, type Customizations, type LearnedWord, type Replacement } from '../../shared/types';
import { intlLocale, useLocale, useT } from '../common/i18n';
import { Badge, Button, cx, inputClass, PageHeader, Row, Section, Toggle } from '../common/ui';
import { NUMBER_STYLE_KINDS, type NumberStyleKind, type NumberStyles } from '../../shared/numberStyle';

type Tab = 'dictionary' | 'replacements' | 'learned' | 'instructions';

const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'dictionary', label: 'style.tab.dictionary' },
  { id: 'replacements', label: 'style.tab.replacements' },
  { id: 'learned', label: 'style.tab.learned' },
  { id: 'instructions', label: 'style.tab.instructions' },
];

/**
 * Examples in placeholders and descriptions. They are Japanese text that the user says or the app writes, so they stay as they are
 * in both languages
 */
const EXAMPLES = {
  dictionary: 'Grafana, 日鷹, 定例会',
  readings: 'ぐらふぁな、グラファナ',
  replacementFrom: '自宅の住所',
  numberBefore: '2つ',
  numberAfter: '二つ',
  instructions: { a: 'です・ます調にそろえる', b: '数字は全角にしない', c: '社名は株式会社を省略しない' },
};

/** Locale tag for numbers and dates in the interface language */
const useIntlLocale = () => intlLocale(useLocale());

function save(patch: Partial<Customizations>) {
  return window.longhand.updateCustomizations(patch);
}

/** Form used to treat words as the same (ignores full-width/half-width and case) */
const keyOf = (w: string) => w.normalize('NFKC').trim().toLowerCase();
const charLen = (s: string) => Array.from(s).length;
const KANA_ONLY = /^[ぁ-ゖァ-ヺー・\s]+$/;

/** Splits on commas, Japanese commas (、), line breaks and tabs */
function splitWords(s: string): string[] {
  return s
    .split(/[,、，\n\r\t]/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function uniqWords(words: string[]): string[] {
  const seen = new Set<string>();
  return words.filter((w) => {
    const k = keyOf(w);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type Notice = { tone: 'red' | 'amber' | 'neutral'; text: string } | null;

function NoticeLine({ n }: { n: Notice }) {
  if (!n) return null;
  return (
    <div
      role="status"
      className={cx(
        'px-4 pb-2.5 text-[12px]',
        n.tone === 'red' && 'text-rose-600 dark:text-rose-400',
        n.tone === 'amber' && 'text-amber-700 dark:text-amber-400',
        n.tone === 'neutral' && 'text-neutral-500',
      )}
    >
      {n.text}
    </div>
  );
}

/** Shows "Undo" right after a deletion and similar actions. It disappears after 8 seconds */
function useUndo(): [ReactNode, (message: string, undo: () => void) => void] {
  const t = useT();
  const [state, setState] = useState<{ message: string; undo: () => void } | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const push = (message: string, undo: () => void) => {
    if (timer.current) window.clearTimeout(timer.current);
    setState({ message, undo });
    timer.current = window.setTimeout(() => setState(null), 8000);
  };
  const node = state && (
    <div role="status" className="flex items-center gap-3 px-4 py-2 text-[12.5px]">
      <span className="text-neutral-600 dark:text-neutral-300">{state.message}</span>
      <Button
        small
        variant="ghost"
        onClick={() => {
          state.undo();
          setState(null);
        }}
      >
        {t('style.undo')}
      </Button>
    </div>
  );
  return [node, push];
}

/** Refers to the latest customizations (so that undo does not discard other changes made in the meantime) */
function useLatest<T>(v: T) {
  const ref = useRef(v);
  ref.current = v;
  return ref;
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="px-4 pt-3">
      <input className={inputClass} type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Adds words to the dictionary. Checks the limit, length and duplicates, and returns why words could not be added */
function addToDictionary(current: string[], words: string[], t: Translate, loc: string): { next: string[]; added: number; notice: Notice } {
  const seen = new Set(current.map(keyOf));
  const next = [...current];
  let added = 0;
  let duplicate = 0;
  let tooLong = 0;
  let overLimit = 0;
  for (const w of words) {
    if (charLen(w) > LIMITS.wordLength) {
      tooLong++;
      continue;
    }
    const k = keyOf(w);
    if (seen.has(k)) {
      duplicate++;
      continue;
    }
    if (next.length >= LIMITS.dictionary) {
      overLimit++;
      continue;
    }
    seen.add(k);
    next.push(w);
    added++;
  }
  const reasons: string[] = [];
  if (overLimit) reasons.push(t('style.dictionary.reason.overLimit', { limit: LIMITS.dictionary.toLocaleString(loc), count: overLimit }));
  if (tooLong) reasons.push(t('style.dictionary.reason.tooLong', { max: LIMITS.wordLength, count: tooLong }));
  if (duplicate) reasons.push(t('style.dictionary.reason.duplicate', { count: duplicate }));
  if (!reasons.length) return { next, added, notice: words.length > 1 ? { tone: 'neutral', text: t('style.dictionary.added', { count: added }) } : null };
  const list = reasons.join(t('common.listSeparator'));
  const text = added ? t('style.dictionary.someNotAdded', { count: added, reasons: list }) : t('style.dictionary.notAdded', { reasons: list });
  return { next, added, notice: { tone: added ? 'amber' : 'red', text } };
}

/** Turns the contents of an imported file into a list of words (text with one word per line, comma-separated text, a JSON array or { dictionary: [] }) */
function parseImport(text: string): string[] {
  const t = text.replace(/^﻿/, '').trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as unknown;
      const arr = Array.isArray(j) ? j : Array.isArray((j as { dictionary?: unknown })?.dictionary) ? (j as { dictionary: unknown[] }).dictionary : [];
      return arr
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      /* Read it as text */
    }
  }
  return splitWords(t);
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function ReadingsEditor({ c, word, onClose }: { c: Customizations; word: string; onClose: () => void }) {
  const t = useT();
  const confirmed = c.readings?.[word] ?? [];
  const suggested = (c.suggestedReadings?.[word] ?? []).filter((r) => !confirmed.includes(r));
  const joined = confirmed.join('、');
  const [v, setV] = useState(joined);
  const [error, setError] = useState('');
  useEffect(() => setV(joined), [word, joined]);
  const commit = (list: string[]) => {
    const clean = uniqWords(list);
    if (clean.some((r) => !KANA_ONLY.test(r))) {
      setError(t('style.readings.kanaOnly'));
      return;
    }
    setError('');
    if (clean.join('、') === joined) return;
    const next = { ...c.readings };
    if (clean.length) next[word] = clean;
    else delete next[word];
    void save({ readings: next });
  };
  return (
    <div className="mx-4 mb-3 rounded-md bg-black/[0.03] px-3 py-2.5 text-[12.5px] dark:bg-white/[0.05]">
      <div className="mb-1 flex items-center">
        <span className="font-medium">{t('style.readings.title', { word })}</span>
        <span className="ml-auto">
          <Button small variant="ghost" onClick={onClose}>
            {t('style.close')}
          </Button>
        </span>
      </div>
      <p className="mb-2 text-neutral-500">{t('style.readings.description')}</p>
      <input
        className={inputClass}
        placeholder={t('style.example', { example: EXAMPLES.readings })}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => commit(splitWords(v))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {error && <div className="mt-1 text-rose-600 dark:text-rose-400">{error}</div>}
      {suggested.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-neutral-500">{t('style.readings.suggested')}</span>
          {suggested.map((r) => (
            <button
              key={r}
              title={t('style.readings.accept')}
              className="rounded-md bg-blue-500/10 px-2 py-0.5 text-blue-700 hover:bg-blue-500/20 dark:text-blue-300"
              onClick={() => commit([...confirmed, r])}
            >
              {r} ＋
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Finds dictionary candidates. Picks up words in Latin letters from the history or local documents, and lists the ones not yet in
 * the dictionary, most frequent first.
 * Processing happens only in this window, and nothing is sent anywhere.
 */
function CandidateFinder({ c, onAdd, onClose }: { c: Customizations; onAdd: (words: string[]) => void; onClose: () => void }) {
  const t = useT();
  const loc = useIntlLocale();
  const [found, setFound] = useState<{ source: string; list: DictCandidate[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const show = (source: string, texts: string[]) => {
    const list = extractCandidates(texts, { existing: [...c.dictionary, ...c.learnedWords.map((w) => w.word)], maxLength: LIMITS.wordLength });
    setFound({ source, list });
    // Preselect the words that appeared twice or more
    setPicked(new Set(list.filter((x) => x.count >= 2).map((x) => x.word)));
    setError(null);
  };
  const fromHistory = async () => {
    setBusy(true);
    try {
      const items = await window.longhand.listHistory();
      const texts = items.filter((h) => h.paste !== 'cancelled' && h.text).map((h) => h.text);
      show(t('style.candidates.source.history', { count: texts.length.toLocaleString(loc) }), texts);
    } catch {
      setError(t('style.candidates.historyError'));
    } finally {
      setBusy(false);
    }
  };
  const fromFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const contents = await Promise.all([...files].map((f) => f.text()));
      show(files.length === 1 ? files[0].name : t('style.candidates.source.files', { count: files.length.toLocaleString(loc) }), contents.flatMap(textsFromFile));
    } catch {
      setError(t('style.candidates.fileError'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Remove added words from the candidates
  const known = new Set([...c.dictionary, ...c.learnedWords.map((w) => w.word)].map(keyOf));
  const list = found?.list.filter((x) => !known.has(keyOf(x.word))) ?? [];
  const chosen = list.filter((x) => picked.has(x.word)).map((x) => x.word);
  const toggle = (w: string) => {
    const next = new Set(picked);
    if (!next.delete(w)) next.add(w);
    setPicked(next);
  };

  return (
    <div className="mx-4 mb-3 rounded-lg border border-black/10 dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span className="text-[12.5px] font-medium">{t('style.candidates.find')}</span>
        <Button small onClick={() => void fromHistory()} disabled={busy}>
          {t('style.candidates.fromHistory')}
        </Button>
        <Button small onClick={() => fileRef.current?.click()} disabled={busy} title={t('style.candidates.fromFilesHint')}>
          {t('style.candidates.fromFiles')}
        </Button>
        <input ref={fileRef} type="file" multiple accept=".txt,.md,.csv,.log,.json,.jsonl,text/plain,application/json" hidden onChange={(e) => void fromFiles(e.target.files)} />
        <span className="flex-1" />
        <Button small variant="ghost" onClick={onClose}>
          {t('style.close')}
        </Button>
      </div>
      <p className="px-3 pb-2.5 text-[12px] leading-relaxed text-neutral-500">{t('style.candidates.description')}</p>
      {error && <p className="px-3 pb-2.5 text-[12px] text-rose-600 dark:text-rose-400">{error}</p>}
      {found && list.length === 0 && (
        <p className="border-t border-black/5 px-3 py-2.5 text-[12.5px] text-neutral-500 dark:border-white/10">
          {found.list.length ? t('style.candidates.allAdded') : t('style.candidates.none', { source: found.source })}
        </p>
      )}
      {found && list.length > 0 && (
        <>
          <div className="flex items-center gap-2 border-t border-black/5 px-3 py-2 text-[12px] text-neutral-500 dark:border-white/10">
            <span>{t('style.candidates.count', { source: found.source, count: list.length.toLocaleString(loc) })}</span>
            <span className="flex-1" />
            <Button small variant="ghost" onClick={() => setPicked(new Set(list.map((x) => x.word)))}>
              {t('style.candidates.selectAll')}
            </Button>
            <Button small variant="ghost" onClick={() => setPicked(new Set())}>
              {t('style.candidates.deselectAll')}
            </Button>
          </div>
          <ul className="max-h-72 overflow-y-auto border-t border-black/5 dark:border-white/10">
            {list.map((x) => (
              <li key={x.word}>
                <label className="flex cursor-pointer items-baseline gap-2.5 px-3 py-1.5 text-[13px] hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
                  <input type="checkbox" className="translate-y-[2px]" checked={picked.has(x.word)} onChange={() => toggle(x.word)} />
                  <span className="shrink-0 font-medium">{x.word}</span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-neutral-400">{t('style.times', { count: x.count })}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-500" title={x.sample}>
                    {x.sample}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-end gap-2 border-t border-black/5 px-3 py-2.5 dark:border-white/10">
            <Button variant="primary" small disabled={!chosen.length} onClick={() => onAdd(chosen)}>
              {t('style.candidates.addSelected', { count: chosen.length.toLocaleString(loc) })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Dictionary({ c }: { c: Customizations }) {
  const t = useT();
  const loc = useIntlLocale();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [undoNode, pushUndo] = useUndo();
  const latest = useLatest(c);
  const fileRef = useRef<HTMLInputElement>(null);
  const full = c.dictionary.length >= LIMITS.dictionary;

  const addList = (words: string[]) => {
    if (!words.length) return false;
    const r = addToDictionary(c.dictionary, words, t, loc);
    if (r.added) void save({ dictionary: r.next });
    setNotice(r.notice);
    return r.added > 0 || r.notice?.tone !== 'red';
  };
  const add = () => {
    if (addList(splitWords(input))) setInput('');
  };
  const remove = (w: string) => {
    const index = c.dictionary.indexOf(w);
    const readings = c.readings?.[w];
    const suggested = c.suggestedReadings?.[w];
    void save({ dictionary: c.dictionary.filter((x) => x !== w) });
    if (selected === w) setSelected(null);
    pushUndo(t('style.dictionary.removed', { word: w }), () => {
      const cur = latest.current;
      if (cur.dictionary.some((x) => keyOf(x) === keyOf(w))) return;
      const dict = [...cur.dictionary];
      dict.splice(Math.min(index, dict.length), 0, w);
      void save({
        dictionary: dict,
        ...(readings ? { readings: { ...cur.readings, [w]: readings } } : {}),
        ...(suggested ? { suggestedReadings: { ...cur.suggestedReadings, [w]: suggested } } : {}),
      });
    });
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const words = parseImport(await file.text());
    if (!words.length) setNotice({ tone: 'red', text: t('style.dictionary.importEmpty') });
    else addList(words);
    if (fileRef.current) fileRef.current.value = '';
  };

  const q = keyOf(query);
  const visible = [...c.dictionary].reverse().filter((w) => !q || keyOf(w).includes(q) || (c.readings?.[w] ?? []).some((r) => keyOf(r).includes(q)));

  return (
    <Section
      title={t('style.dictionary.title', { count: c.dictionary.length.toLocaleString(loc), max: LIMITS.dictionary.toLocaleString(loc) })}
      description={t('style.dictionary.description')}
      actions={
        <span className="flex gap-1">
          <Button small variant="ghost" onClick={() => setFinding(!finding)} disabled={full} title={t('style.dictionary.findHint')}>
            {t('style.candidates.find')}
          </Button>
          <Button small variant="ghost" onClick={() => fileRef.current?.click()} disabled={full} title={t('style.dictionary.importHint')}>
            {t('style.dictionary.import')}
          </Button>
          <Button small variant="ghost" onClick={() => downloadText('dictionary.txt', c.dictionary.join('\n') + '\n')} disabled={!c.dictionary.length}>
            {t('style.dictionary.export')}
          </Button>
          <input ref={fileRef} type="file" accept=".txt,.csv,.json,text/plain,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        </span>
      }
    >
      <div className="flex gap-2 px-4 py-3">
        <input
          className={inputClass}
          placeholder={full ? t('style.dictionary.full', { max: LIMITS.dictionary.toLocaleString(loc) }) : t('style.example', { example: EXAMPLES.dictionary })}
          value={input}
          disabled={full}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button variant="primary" onClick={add} disabled={!input.trim() || full}>
          {t('style.add')}
        </Button>
      </div>
      <NoticeLine n={notice} />
      {finding && <CandidateFinder c={c} onAdd={(words) => void addList(words)} onClose={() => setFinding(false)} />}
      {c.dictionary.length > 12 && <SearchBox value={query} onChange={setQuery} placeholder={t('style.dictionary.search')} />}
      {c.dictionary.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {visible.length === 0 && <span className="text-[12.5px] text-neutral-500">{t('style.noMatchingWords')}</span>}
          {visible.map((w) => (
            <span key={w} className={cx('group inline-flex items-center gap-1 rounded-md py-0.5 pl-2 pr-1 text-[13px]', selected === w ? 'bg-blue-500/15' : 'bg-black/[0.05] dark:bg-white/10')}>
              <button className="text-left" title={t('style.dictionary.setReadings')} onClick={() => setSelected(selected === w ? null : w)}>
                {w}
                {(c.readings?.[w]?.length ?? 0) > 0 && <span className="ml-1 text-[11px] text-neutral-400">{t('style.dictionary.hasReadings')}</span>}
              </button>
              <button
                className="rounded px-1 text-neutral-400 hover:bg-black/10 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-white"
                onClick={() => remove(w)}
                title={t('style.delete')}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {selected && c.dictionary.includes(selected) && <ReadingsEditor c={c} word={selected} onClose={() => setSelected(null)} />}
      {undoNode}
    </Section>
  );
}

function newReplacement(): Replacement {
  return { id: crypto.randomUUID(), from: '', to: '', preserveCase: true, noPunctuation: false };
}

/** Form of a replacement trigger used for comparison (same as replacementTriggerKey in main/format/postprocess.ts: NFKC, lowercase, no spaces) */
const triggerKey = (from: string) => from.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** Checks a replacement entry. Nothing is saved when there is an error */
function checkReplacement(from: string, to: string, others: Replacement[], t: Translate, loc: string): { error?: string; warnings: string[] } {
  const warnings: string[] = [];
  const k = triggerKey(from);
  if (k && others.some((o) => triggerKey(o.from) === k)) {
    return { error: t('style.replacements.duplicate'), warnings };
  }
  if (!k && to.trim()) warnings.push(t('style.replacements.emptyFrom'));
  if (charLen(k) === 1) warnings.push(t('style.replacements.oneChar'));
  const overlap = k
    ? others.find((o) => {
        const ok = triggerKey(o.from);
        return ok && (ok.includes(k) || k.includes(ok));
      })
    : undefined;
  if (overlap) warnings.push(t('style.replacements.overlap', { other: overlap.from.trim() }));
  if (from.trim().split(/\s+/).length >= 4) {
    warnings.push(t('style.replacements.tooManyWords'));
  }
  if (to.endsWith('\n')) warnings.push(t('style.replacements.trailingNewline'));
  if (charLen(to) > LIMITS.replacementTo) warnings.push(t('style.replacements.tooLong', { max: LIMITS.replacementTo.toLocaleString(loc) }));
  return { warnings };
}

function ReplacementRow({ r, others, onChange, onDelete }: { r: Replacement; others: Replacement[]; onChange: (r: Replacement) => void; onDelete: () => void }) {
  const t = useT();
  const loc = useIntlLocale();
  const [from, setFrom] = useState(r.from);
  const [to, setTo] = useState(r.to);
  useEffect(() => {
    setFrom(r.from);
    setTo(r.to);
  }, [r]);
  const check = checkReplacement(from, to, others, t, loc);
  const commit = () => {
    if (check.error) return;
    if (from !== r.from || to !== r.to) onChange({ ...r, from, to: Array.from(to).slice(0, LIMITS.replacementTo).join('') });
  };
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-2">
        <input
          className={inputClass}
          placeholder={t('style.replacements.fromPlaceholder', { example: EXAMPLES.replacementFrom })}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          onBlur={commit}
        />
        <span className="pt-1.5 text-neutral-400">→</span>
        <textarea className={cx(inputClass, 'min-h-[32px] resize-y')} rows={1} placeholder={t('style.replacements.toPlaceholder')} value={to} onChange={(e) => setTo(e.target.value)} onBlur={commit} />
        <Button small variant="danger" onClick={onDelete}>
          {t('style.delete')}
        </Button>
      </div>
      {(check.error || check.warnings.length > 0) && (
        <div className="flex flex-col gap-0.5 pl-1 text-[12px]">
          {check.error && <span className="text-rose-600 dark:text-rose-400">{check.error}</span>}
          {check.warnings.map((w) => (
            <span key={w} className="text-amber-700 dark:text-amber-400">
              {w}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-5 pl-1 text-[12px] text-neutral-500">
        <label className="flex items-center gap-1.5" title={t('style.replacements.preserveCaseHint')}>
          <input type="checkbox" checked={r.preserveCase} onChange={(e) => onChange({ ...r, preserveCase: e.target.checked })} />
          {t('style.replacements.preserveCase')}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={r.noPunctuation} onChange={(e) => onChange({ ...r, noPunctuation: e.target.checked })} />
          {t('style.replacements.noPunctuation')}
        </label>
      </div>
    </div>
  );
}

function Replacements({ c }: { c: Customizations }) {
  const t = useT();
  const loc = useIntlLocale();
  const [query, setQuery] = useState('');
  const [undoNode, pushUndo] = useUndo();
  const latest = useLatest(c);
  const update = (list: Replacement[]) => void save({ replacements: list });
  const remove = (r: Replacement) => {
    const index = c.replacements.findIndex((x) => x.id === r.id);
    update(c.replacements.filter((x) => x.id !== r.id));
    if (!r.from.trim() && !r.to.trim()) return;
    pushUndo(t('style.replacements.removed', { word: r.from || r.to }), () => {
      const list = [...latest.current.replacements];
      if (list.some((x) => x.id === r.id)) return;
      list.splice(Math.min(index, list.length), 0, r);
      update(list);
    });
  };
  const q = keyOf(query);
  // Replacements are applied once each, longest first, so the order does not affect the result. Newer ones are shown at the top
  const visible = c.replacements.filter((r) => !q || keyOf(r.from).includes(q) || keyOf(r.to).includes(q));
  return (
    <Section
      title={t('style.replacements.title', { count: c.replacements.length.toLocaleString(loc) })}
      description={t('style.replacements.description')}
      actions={
        <Button small onClick={() => update([newReplacement(), ...c.replacements])}>
          {t('style.replacements.add')}
        </Button>
      }
    >
      {c.replacements.length > 8 && <SearchBox value={query} onChange={setQuery} placeholder={t('style.replacements.search')} />}
      {c.replacements.length === 0 ? (
        <div className="px-4 py-6 text-center text-[13px] text-neutral-500">{t('style.replacements.empty')}</div>
      ) : visible.length === 0 ? (
        <div className="px-4 py-6 text-center text-[13px] text-neutral-500">{t('style.replacements.noMatch')}</div>
      ) : (
        visible.map((r) => (
          <ReplacementRow
            key={r.id}
            r={r}
            others={c.replacements.filter((x) => x.id !== r.id)}
            onChange={(nr) => update(latest.current.replacements.map((x) => (x.id === r.id ? nr : x)))}
            onDelete={() => remove(r)}
          />
        ))
      )}
      {undoNode}
    </Section>
  );
}

function BlockedWords({ c }: { c: Customizations }) {
  const t = useT();
  const loc = useIntlLocale();
  const [input, setInput] = useState('');
  const add = () => {
    const words = splitWords(input).filter((w) => charLen(w) <= LIMITS.wordLength);
    if (!words.length) return;
    const keys = new Set(words.map(keyOf));
    // Adding a learned word also undoes its learning
    void save({
      blockedLearnedWords: uniqWords([...c.blockedLearnedWords, ...words]),
      learnedWords: c.learnedWords.filter((w) => !keys.has(keyOf(w.word))),
    });
    setInput('');
  };
  return (
    <Section title={t('style.blocked.title', { count: c.blockedLearnedWords.length.toLocaleString(loc) })} description={t('style.blocked.description')}>
      <div className="flex gap-2 px-4 py-3">
        <input className={inputClass} placeholder={t('style.blocked.placeholder')} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button onClick={add} disabled={!input.trim()}>
          {t('style.add')}
        </Button>
      </div>
      {c.blockedLearnedWords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          {[...c.blockedLearnedWords].reverse().map((w) => (
            <span key={w} className="inline-flex items-center gap-1 rounded-md bg-black/[0.05] py-0.5 pl-2 pr-1 text-[13px] dark:bg-white/10">
              {w}
              <button
                className="rounded px-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-white"
                title={t('style.blocked.remove')}
                onClick={() => void save({ blockedLearnedWords: c.blockedLearnedWords.filter((x) => x !== w) })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </Section>
  );
}

function Learned({ c, snap }: { c: Customizations; snap: AppSnapshot }) {
  const t = useT();
  const loc = useIntlLocale();
  const enabled = snap.settings.learning.enabled;
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [undoNode, pushUndo] = useUndo();
  const latest = useLatest(c);

  const undoLearn = (w: LearnedWord) => {
    void window.longhand.undoLearnedWord(w.word);
    pushUndo(t('style.learned.forgotten', { word: w.word }), () => {
      const cur = latest.current;
      void save({
        learnedWords: cur.learnedWords.some((x) => x.word === w.word) ? cur.learnedWords : [...cur.learnedWords, w],
        blockedLearnedWords: cur.blockedLearnedWords.filter((x) => x !== w.word),
      });
    });
  };
  const moveToDictionary = (w: LearnedWord) => {
    if (c.dictionary.length >= LIMITS.dictionary) {
      setNotice({ tone: 'red', text: t('style.learned.dictionaryFull', { max: LIMITS.dictionary.toLocaleString(loc) }) });
      return;
    }
    setNotice(null);
    // A misrecognized form written in kana carries over as a dictionary reading (used for matching)
    const from = w.from.trim();
    const keepReading = from && KANA_ONLY.test(from) && charLen(from) >= 3;
    const readings = keepReading ? { ...c.readings, [w.word]: uniqWords([...(c.readings?.[w.word] ?? []), from]) } : c.readings;
    // Forms that cannot carry over as readings (misrecognitions in kanji or Latin letters) are kept as misheard forms
    const misheard = !keepReading && from ? { ...c.misheard, [w.word]: uniqWords([from, ...(c.misheard?.[w.word] ?? [])]) } : c.misheard;
    void save({
      dictionary: c.dictionary.some((x) => keyOf(x) === keyOf(w.word)) ? c.dictionary : [...c.dictionary, w.word],
      learnedWords: c.learnedWords.filter((x) => x.word !== w.word),
      ...(readings ? { readings } : {}),
      ...(misheard ? { misheard } : {}),
    });
  };
  // Misheard forms attached to dictionary words (those of learned words are listed on the learned word's row)
  const learnedKeys = new Set(c.learnedWords.map((w) => w.word));
  const dictForms = Object.entries(c.misheard ?? {}).filter(([word, forms]) => !learnedKeys.has(word) && forms.length > 0);
  const removeForm = (word: string, form: string) => void save({ misheard: { ...c.misheard, [word]: (c.misheard?.[word] ?? []).filter((x) => x !== form) } });
  const corrections = [...(c.pastCorrections ?? [])].sort((a, b) => b.at - a.at);
  const kept = [...(c.keptPhrases ?? [])].sort((a, b) => b.at - a.at);
  const numberStyles = NUMBER_STYLE_KINDS.flatMap((k) => (c.numberStyle?.[k] ? [[k, c.numberStyle[k]] as const] : []));
  const removeNumberStyle = (kind: NumberStyleKind) => {
    const next: NumberStyles = { ...c.numberStyle };
    delete next[kind];
    // An empty object clears the field (undefined would be dropped on the way to the main process)
    void save({ numberStyle: next });
  };

  const q = keyOf(query);
  const visible = [...c.learnedWords].sort((a, b) => b.learnedAt - a.learnedAt).filter((w) => !q || keyOf(w.word).includes(q) || keyOf(w.from).includes(q));
  return (
    <>
      <Section title={t('style.learned.sectionTitle')} description={t('style.learned.sectionDescription')}>
        <Row label={t('style.learned.enable')} hint={t('style.learned.enableHint', { seconds: snap.settings.learning.watchSeconds })}>
          <Toggle checked={enabled} onChange={(v) => void window.longhand.updateSettings({ learning: { enabled: v } })} />
        </Row>
      </Section>
      <Section title={t('style.learned.title', { count: c.learnedWords.length.toLocaleString(loc), max: LIMITS.learned.toLocaleString(loc) })} description={t('style.learned.description')}>
        <NoticeLine n={notice} />
        {c.learnedWords.length > 8 && <SearchBox value={query} onChange={setQuery} placeholder={t('style.learned.search')} />}
        {c.learnedWords.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-neutral-500">{t('style.learned.empty')}</div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-neutral-500">{t('style.noMatchingWords')}</div>
        ) : (
          visible.map((w) => (
            <div key={w.word} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="font-medium">{w.word}</span>
              <span className="text-neutral-400">← {[w.from, ...(c.misheard?.[w.word] ?? [])].join(t('common.listSeparator'))}</span>
              <span className="text-[11.5px] text-neutral-400">{new Date(w.learnedAt).toLocaleDateString(loc)}</span>
              <span className="ml-auto flex gap-1">
                <Button small variant="ghost" onClick={() => moveToDictionary(w)}>
                  {t('style.learned.moveToDictionary')}
                </Button>
                <Button small variant="danger" onClick={() => undoLearn(w)}>
                  {t('style.forget')}
                </Button>
              </span>
            </div>
          ))
        )}
        {undoNode}
      </Section>
      {dictForms.length > 0 && (
        <Section title={t('style.misheard.title')} description={t('style.misheard.description')}>
          {dictForms.map(([word, forms]) => (
            <div key={word} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
              <span className="font-medium">{word}</span>
              <span className="text-neutral-400">←</span>
              {forms.map((f) => (
                <span key={f} className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 dark:bg-neutral-800">
                  {f}
                  <button type="button" className="text-neutral-400 hover:text-red-500" title={t('style.misheard.remove')} onClick={() => removeForm(word, f)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ))}
        </Section>
      )}
      {corrections.length > 0 && (
        <Section title={t('style.corrections.title', { count: corrections.length.toLocaleString(loc) })} description={t('style.corrections.description')}>
          {corrections.map((p) => (
            <div key={`${p.heard}\u0000${p.corrected}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="text-neutral-500">{p.heard}</span>
              <span className="text-neutral-400">→</span>
              <span className="font-medium">{p.corrected}</span>
              {p.count > 1 && <span className="text-[11.5px] text-neutral-400">{t('style.times', { count: p.count })}</span>}
              <span className="ml-auto">
                <Button small variant="danger" onClick={() => void save({ pastCorrections: (c.pastCorrections ?? []).filter((x) => !(x.heard === p.heard && x.corrected === p.corrected)) })}>
                  {t('style.forget')}
                </Button>
              </span>
            </div>
          ))}
        </Section>
      )}
      {kept.length > 0 && (
        <Section title={t('style.kept.title', { count: kept.length.toLocaleString(loc) })} description={t('style.kept.description')}>
          {kept.map((k) => (
            <div key={`${k.phrase}\u0000${k.changedTo}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="font-medium">{k.phrase}</span>
              <span className="text-neutral-400">{t('style.kept.notTo', { text: k.changedTo })}</span>
              <span className="ml-auto">
                <Button small variant="danger" onClick={() => void save({ keptPhrases: (c.keptPhrases ?? []).filter((x) => !(x.phrase === k.phrase && x.changedTo === k.changedTo)) })}>
                  {t('style.forget')}
                </Button>
              </span>
            </div>
          ))}
        </Section>
      )}
      {numberStyles.length > 0 && (
        <Section title={t('style.numbers.title')} description={t('style.numbers.description', { from: EXAMPLES.numberBefore, to: EXAMPLES.numberAfter })}>
          {numberStyles.map(([kind, p]) => (
            <div key={kind} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="w-24 shrink-0 text-neutral-500">{t(NUMBER_STYLE_LABELS[kind].title, NUMBER_STYLE_LABELS[kind].vars)}</span>
              <span className="font-medium">{numberStyleValueLabel(t, kind, p.value)}</span>
              {p.example && (
                <span className="text-neutral-400">
                  {p.example.before} → {p.example.after}
                </span>
              )}
              {p.count > 1 && <span className="text-[11.5px] text-neutral-400">{t('style.times', { count: p.count })}</span>}
              <span className="ml-auto">
                <Button small variant="danger" onClick={() => removeNumberStyle(kind)}>
                  {t('style.forget')}
                </Button>
              </span>
            </div>
          ))}
        </Section>
      )}
      <BlockedWords c={c} />
    </>
  );
}

/**
 * Names of the number notation preferences on the Style page. Each value shows an example of the notation; the examples are
 * Japanese text that the app writes, so they stay as they are in both languages. A value without a label shows only its example
 */
const NUMBER_STYLE_LABELS: Record<NumberStyleKind, { title: MessageKey; vars?: Vars; values: Record<string, { label?: MessageKey; example: string }> }> = {
  width: {
    title: 'style.numbers.width.title',
    values: { half: { label: 'style.numbers.width.half', example: '10' }, full: { label: 'style.numbers.width.full', example: '１０' } },
  },
  grouping: {
    title: 'style.numbers.grouping.title',
    values: { comma: { label: 'style.numbers.grouping.comma', example: '10,000円' }, none: { label: 'style.numbers.grouping.none', example: '10000円' } },
  },
  units: {
    title: 'style.numbers.units.title',
    vars: { man: '万', oku: '億' },
    values: { kanji: { label: 'style.numbers.units.kanji', example: '1万円' }, digits: { label: 'style.numbers.units.digits', example: '10000円' } },
  },
  counters: {
    title: 'style.numbers.counters.title',
    values: { kanji: { label: 'style.numbers.counters.kanji', example: '二つ、一人' }, digits: { label: 'style.numbers.counters.digits', example: '2つ、1人' } },
  },
  percent: {
    title: 'style.numbers.percent.title',
    values: { symbol: { label: 'style.numbers.percent.symbol', example: '3%' }, word: { label: 'style.numbers.percent.word', example: '3パーセント' } },
  },
  time: { title: 'style.numbers.time.title', values: { colon: { example: '10:30' }, kanji: { example: '10時30分' } } },
  date: { title: 'style.numbers.date.title', values: { slash: { example: '11/24' }, kanji: { example: '11月24日' } } },
};

function numberStyleValueLabel(t: Translate, kind: NumberStyleKind, value: string): string {
  const v = NUMBER_STYLE_LABELS[kind].values[value];
  if (!v) return value;
  return v.label ? t(v.label, { example: v.example }) : v.example;
}

function Instructions({ c }: { c: Customizations }) {
  const t = useT();
  const loc = useIntlLocale();
  const [v, setV] = useState(c.customInstructions);
  const [saved, setSaved] = useState(false);
  const latest = useLatest(c);
  const value = useLatest(v);
  const focused = useRef(false);
  const timer = useRef<number | null>(null);
  const savedTimer = useRef<number | null>(null);
  // While typing, do not overwrite the text with an older value that arrives as the result of a save
  useEffect(() => {
    if (!focused.current) setV(c.customInstructions);
  }, [c.customInstructions]);
  const commit = (text: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (text === latest.current.customInstructions) return;
    void save({ customInstructions: text }).then(() => {
      setSaved(true);
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
    });
  };
  // Save input that has not been saved yet when leaving the page
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        if (value.current !== latest.current.customInstructions) void save({ customInstructions: value.current });
      }
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    },
    [],
  );
  const len = Array.from(v).length;
  return (
    <Section title={t('style.instructions.title')} description={t('style.instructions.description', EXAMPLES.instructions)}>
      <div className="px-4 py-3">
        <textarea
          className={cx(inputClass, 'min-h-[180px] resize-y leading-relaxed')}
          value={v}
          onFocus={() => (focused.current = true)}
          onChange={(e) => {
            const text = e.target.value;
            setV(text);
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => commit(text), 1000);
          }}
          onBlur={() => {
            focused.current = false;
            commit(v);
          }}
          placeholder={t('style.instructions.placeholder')}
        />
        <div className="mt-1.5 flex justify-between text-[11.5px] text-neutral-500">
          <span className="flex items-center gap-2">
            {len > 2000 && <Badge tone="amber">{t('style.instructions.long')}</Badge>}
            {saved && <span role="status">{t('style.instructions.saved')}</span>}
          </span>
          <span className="tabular-nums">{t('style.instructions.length', { count: len.toLocaleString(loc) })}</span>
        </div>
      </div>
    </Section>
  );
}

export function Style({ snap }: { snap: AppSnapshot }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('dictionary');
  const c = snap.customizations;
  return (
    <>
      <PageHeader title={t('style.title')} description={t('style.description')} />
      <div className="mb-5 inline-flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.08]">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={cx(
              'rounded-md px-3 py-1 text-[13px]',
              tab === tb.id ? 'bg-white font-medium shadow-sm dark:bg-white/20' : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
            )}
          >
            {t(tb.label)}
          </button>
        ))}
      </div>
      {tab === 'dictionary' && <Dictionary c={c} />}
      {tab === 'replacements' && <Replacements c={c} />}
      {tab === 'learned' && <Learned c={c} snap={snap} />}
      {tab === 'instructions' && <Instructions c={c} />}
    </>
  );
}
