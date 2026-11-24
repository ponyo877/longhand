import { useEffect, useRef, useState, type ReactNode } from 'react';
import { extractCandidates, textsFromFile, type DictCandidate } from '../../shared/dictCandidates';
import { CUSTOMIZATION_LIMITS as LIMITS, type AppSnapshot, type Customizations, type LearnedWord, type Replacement } from '../../shared/types';
import { Badge, Button, cx, inputClass, PageHeader, Row, Section, Toggle } from '../common/ui';
import { NUMBER_STYLE_KINDS, type NumberStyleKind, type NumberStyles } from '../../shared/numberStyle';

type Tab = 'dictionary' | 'replacements' | 'learned' | 'instructions';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dictionary', label: '辞書' },
  { id: 'replacements', label: '置換' },
  { id: 'learned', label: '学習した語' },
  { id: 'instructions', label: 'カスタム指示' },
];

function save(patch: Partial<Customizations>) {
  return window.longhand.updateCustomizations(patch);
}

/** 同じ語とみなすための形（全角半角と大文字小文字を区別しない） */
const keyOf = (w: string) => w.normalize('NFKC').trim().toLowerCase();
const charLen = (s: string) => Array.from(s).length;
const KANA_ONLY = /^[ぁ-ゖァ-ヺー・\s]+$/;

/** カンマ、読点、改行、タブで区切る */
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

/** 削除などの直後に「元に戻す」を出す。8 秒で消える */
function useUndo(): [ReactNode, (message: string, undo: () => void) => void] {
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
        元に戻す
      </Button>
    </div>
  );
  return [node, push];
}

/** 最新のカスタマイズを参照する（元に戻すまでの間にほかの変更があっても消さないため） */
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

/** 辞書に語を足す。上限、長さ、重複を検査し、足せなかった理由を返す */
function addToDictionary(current: string[], words: string[]): { next: string[]; added: number; notice: Notice } {
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
  if (overLimit) reasons.push(`上限の ${LIMITS.dictionary.toLocaleString()} 語に達したため ${overLimit} 語`);
  if (tooLong) reasons.push(`${LIMITS.wordLength} 字を超える ${tooLong} 語`);
  if (duplicate) reasons.push(`登録済みの ${duplicate} 語`);
  if (!reasons.length) return { next, added, notice: words.length > 1 ? { tone: 'neutral', text: `${added} 語を追加しました。` } : null };
  const head = added ? `${added} 語を追加しました。` : '';
  return { next, added, notice: { tone: added ? 'amber' : 'red', text: `${head}${reasons.join('、')}は追加していません。` } };
}

/** 読み込んだファイルの中身を語の一覧にする（1 行 1 語のテキスト、カンマ区切り、JSON の配列か { dictionary: [] }） */
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
      /* テキストとして読む */
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
  const confirmed = c.readings?.[word] ?? [];
  const suggested = (c.suggestedReadings?.[word] ?? []).filter((r) => !confirmed.includes(r));
  const joined = confirmed.join('、');
  const [v, setV] = useState(joined);
  const [error, setError] = useState('');
  useEffect(() => setV(joined), [word, joined]);
  const commit = (list: string[]) => {
    const clean = uniqWords(list);
    if (clean.some((r) => !KANA_ONLY.test(r))) {
      setError('読みはひらがなかカタカナで書いてください。');
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
        <span className="font-medium">「{word}」の読み</span>
        <span className="ml-auto">
          <Button small variant="ghost" onClick={onClose}>
            閉じる
          </Button>
        </span>
      </div>
      <p className="mb-2 text-neutral-500">音声認識がこの語をかなで書いたときに照合します。ここに書いた読みと一致したところは、LLM を使わない設定でもこの語に置き換えます。</p>
      <input
        className={inputClass}
        placeholder="例: ぐらふぁな、グラファナ"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => commit(splitWords(v))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {error && <div className="mt-1 text-rose-600 dark:text-rose-400">{error}</div>}
      {suggested.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-neutral-500">読みの候補（LLM が作成、未確認）:</span>
          {suggested.map((r) => (
            <button
              key={r}
              title="この読みを採用する"
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
 * 辞書の候補を探す。履歴や手元の文書から英字の語を拾い、まだ辞書にない語を、出てきた回数の多い順に並べる。
 * 処理はこの画面の中だけで行い、どこにも送らない。
 */
function CandidateFinder({ c, onAdd, onClose }: { c: Customizations; onAdd: (words: string[]) => void; onClose: () => void }) {
  const [found, setFound] = useState<{ source: string; list: DictCandidate[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const show = (source: string, texts: string[]) => {
    const list = extractCandidates(texts, { existing: [...c.dictionary, ...c.learnedWords.map((w) => w.word)], maxLength: LIMITS.wordLength });
    setFound({ source, list });
    // 2 回以上出てきた語を、はじめから選んでおく
    setPicked(new Set(list.filter((x) => x.count >= 2).map((x) => x.word)));
    setError(null);
  };
  const fromHistory = async () => {
    setBusy(true);
    try {
      const items = await window.longhand.listHistory();
      const texts = items.filter((h) => h.paste !== 'cancelled' && h.text).map((h) => h.text);
      show(`履歴の ${texts.length.toLocaleString()} 件`, texts);
    } catch {
      setError('履歴を読めませんでした。');
    } finally {
      setBusy(false);
    }
  };
  const fromFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const contents = await Promise.all([...files].map((f) => f.text()));
      show(files.length === 1 ? files[0].name : `${files.length} 個のファイル`, contents.flatMap(textsFromFile));
    } catch {
      setError('ファイルを読めませんでした。');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // 追加した語は、候補から消す
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
        <span className="text-[12.5px] font-medium">候補を探す</span>
        <Button small onClick={() => void fromHistory()} disabled={busy}>
          Longhand の履歴から
        </Button>
        <Button small onClick={() => fileRef.current?.click()} disabled={busy} title="議事録やメモ、ほかのアプリが書き出した履歴など。テキストか JSON を選べます">
          ファイルから…
        </Button>
        <input ref={fileRef} type="file" multiple accept=".txt,.md,.csv,.log,.json,.jsonl,text/plain,application/json" hidden onChange={(e) => void fromFiles(e.target.files)} />
        <span className="flex-1" />
        <Button small variant="ghost" onClick={onClose}>
          閉じる
        </Button>
      </div>
      <p className="px-3 pb-2.5 text-[12px] leading-relaxed text-neutral-500">
        文章に出てくる英字の語（製品名や技術用語）のうち、まだ辞書にない語を、出てきた回数の多い順に並べます。処理はこの Mac の中だけで行います。
      </p>
      {error && <p className="px-3 pb-2.5 text-[12px] text-rose-600 dark:text-rose-400">{error}</p>}
      {found && list.length === 0 && (
        <p className="border-t border-black/5 px-3 py-2.5 text-[12.5px] text-neutral-500 dark:border-white/10">
          {found.list.length ? '候補はすべて追加しました。' : `${found.source}には、辞書にない英字の語が見つかりませんでした。`}
        </p>
      )}
      {found && list.length > 0 && (
        <>
          <div className="flex items-center gap-2 border-t border-black/5 px-3 py-2 text-[12px] text-neutral-500 dark:border-white/10">
            <span>
              {found.source}から {list.length.toLocaleString()} 語
            </span>
            <span className="flex-1" />
            <Button small variant="ghost" onClick={() => setPicked(new Set(list.map((x) => x.word)))}>
              すべて選ぶ
            </Button>
            <Button small variant="ghost" onClick={() => setPicked(new Set())}>
              すべて外す
            </Button>
          </div>
          <ul className="max-h-72 overflow-y-auto border-t border-black/5 dark:border-white/10">
            {list.map((x) => (
              <li key={x.word}>
                <label className="flex cursor-pointer items-baseline gap-2.5 px-3 py-1.5 text-[13px] hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
                  <input type="checkbox" className="translate-y-[2px]" checked={picked.has(x.word)} onChange={() => toggle(x.word)} />
                  <span className="shrink-0 font-medium">{x.word}</span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-neutral-400">{x.count} 回</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-500" title={x.sample}>
                    {x.sample}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-end gap-2 border-t border-black/5 px-3 py-2.5 dark:border-white/10">
            <Button variant="primary" small disabled={!chosen.length} onClick={() => onAdd(chosen)}>
              選んだ {chosen.length.toLocaleString()} 語を辞書に追加
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Dictionary({ c }: { c: Customizations }) {
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
    const r = addToDictionary(c.dictionary, words);
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
    pushUndo(`「${w}」を削除しました`, () => {
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
    if (!words.length) setNotice({ tone: 'red', text: 'ファイルから語を読み取れませんでした。1 行に 1 語のテキストか、語の配列の JSON を選んでください。' });
    else addList(words);
    if (fileRef.current) fileRef.current.value = '';
  };

  const q = keyOf(query);
  const visible = [...c.dictionary].reverse().filter((w) => !q || keyOf(w).includes(q) || (c.readings?.[w] ?? []).some((r) => keyOf(r).includes(q)));

  return (
    <Section
      title={`辞書（${c.dictionary.length.toLocaleString()} / ${LIMITS.dictionary.toLocaleString()} 語）`}
      description="人名、社名、製品名、専門用語など、正しく書き起こしてほしい語。音声認識の語彙ヒントと LLM の整形の両方に使います。カンマ区切りでまとめて追加できます。語を押すと、照合に使う読みを設定できます。"
      actions={
        <span className="flex gap-1">
          <Button small variant="ghost" onClick={() => setFinding(!finding)} disabled={full} title="履歴や手元の文書から、辞書に入れる語の候補を探します">
            候補を探す
          </Button>
          <Button small variant="ghost" onClick={() => fileRef.current?.click()} disabled={full} title="1 行に 1 語のテキストか JSON を読み込みます">
            読み込む
          </Button>
          <Button small variant="ghost" onClick={() => downloadText('dictionary.txt', c.dictionary.join('\n') + '\n')} disabled={!c.dictionary.length}>
            書き出す
          </Button>
          <input ref={fileRef} type="file" accept=".txt,.csv,.json,text/plain,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        </span>
      }
    >
      <div className="flex gap-2 px-4 py-3">
        <input
          className={inputClass}
          placeholder={full ? `上限の ${LIMITS.dictionary.toLocaleString()} 語に達しています。使わない語を削除してください。` : '例: Grafana, 日鷹, 定例会'}
          value={input}
          disabled={full}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button variant="primary" onClick={add} disabled={!input.trim() || full}>
          追加
        </Button>
      </div>
      <NoticeLine n={notice} />
      {finding && <CandidateFinder c={c} onAdd={(words) => void addList(words)} onClose={() => setFinding(false)} />}
      {c.dictionary.length > 12 && <SearchBox value={query} onChange={setQuery} placeholder="辞書の語を探す" />}
      {c.dictionary.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {visible.length === 0 && <span className="text-[12.5px] text-neutral-500">一致する語はありません</span>}
          {visible.map((w) => (
            <span key={w} className={cx('group inline-flex items-center gap-1 rounded-md py-0.5 pl-2 pr-1 text-[13px]', selected === w ? 'bg-blue-500/15' : 'bg-black/[0.05] dark:bg-white/10')}>
              <button className="text-left" title="読みを設定する" onClick={() => setSelected(selected === w ? null : w)}>
                {w}
                {(c.readings?.[w]?.length ?? 0) > 0 && <span className="ml-1 text-[11px] text-neutral-400">読み</span>}
              </button>
              <button className="rounded px-1 text-neutral-400 hover:bg-black/10 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-white" onClick={() => remove(w)} title="削除">
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

/** 置換のきっかけの比較用の形（main/format/postprocess.ts の replacementTriggerKey と同じ。NFKC、小文字、空白なし） */
const triggerKey = (from: string) => from.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 置換の入力の検査。error があれば保存しない */
function checkReplacement(from: string, to: string, others: Replacement[]): { error?: string; warnings: string[] } {
  const warnings: string[] = [];
  const k = triggerKey(from);
  if (k && others.some((o) => triggerKey(o.from) === k)) {
    return { error: '同じ言葉の置換がすでにあります。保存していません。', warnings };
  }
  if (!k && to.trim()) warnings.push('話した言葉を入れてください。空のままでは置き換えません。');
  if (charLen(k) === 1) warnings.push('1 字だけの言葉は、意図しない箇所も置き換わります。');
  const overlap = k
    ? others.find((o) => {
        const ok = triggerKey(o.from);
        return ok && (ok.includes(k) || k.includes(ok));
      })
    : undefined;
  if (overlap) warnings.push(`「${overlap.from.trim()}」の置換と重なります。同じ箇所に一致したときは、長いほうが優先されます。`);
  if (from.trim().split(/\s+/).length >= 4) {
    warnings.push('4 語以上の言葉は、書き起こしの表記が少し違うだけで一致しなくなります。短い言葉にしてください。');
  }
  if (to.endsWith('\n')) warnings.push('置換後の末尾に改行があります。入力の後で改行されます。');
  if (charLen(to) > LIMITS.replacementTo) warnings.push(`置換後は ${LIMITS.replacementTo.toLocaleString()} 字までです。超えた分は保存しません。`);
  return { warnings };
}

function ReplacementRow({ r, others, onChange, onDelete }: { r: Replacement; others: Replacement[]; onChange: (r: Replacement) => void; onDelete: () => void }) {
  const [from, setFrom] = useState(r.from);
  const [to, setTo] = useState(r.to);
  useEffect(() => {
    setFrom(r.from);
    setTo(r.to);
  }, [r]);
  const check = checkReplacement(from, to, others);
  const commit = () => {
    if (check.error) return;
    if (from !== r.from || to !== r.to) onChange({ ...r, from, to: Array.from(to).slice(0, LIMITS.replacementTo).join('') });
  };
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-2">
        <input className={inputClass} placeholder="話した言葉（例: 自宅の住所）" value={from} onChange={(e) => setFrom(e.target.value)} onBlur={commit} />
        <span className="pt-1.5 text-neutral-400">→</span>
        <textarea className={cx(inputClass, 'min-h-[32px] resize-y')} rows={1} placeholder="入力する文字列" value={to} onChange={(e) => setTo(e.target.value)} onBlur={commit} />
        <Button small variant="danger" onClick={onDelete}>
          削除
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
        <label className="flex items-center gap-1.5" title="オフにすると、文頭では先頭の英小文字を大文字にします">
          <input type="checkbox" checked={r.preserveCase} onChange={(e) => onChange({ ...r, preserveCase: e.target.checked })} />
          置換後の大文字小文字をそのまま使う
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={r.noPunctuation} onChange={(e) => onChange({ ...r, noPunctuation: e.target.checked })} />
          直後の句読点を付けない
        </label>
      </div>
    </div>
  );
}

function Replacements({ c }: { c: Customizations }) {
  const [query, setQuery] = useState('');
  const [undoNode, pushUndo] = useUndo();
  const latest = useLatest(c);
  const update = (list: Replacement[]) => void save({ replacements: list });
  const remove = (r: Replacement) => {
    const index = c.replacements.findIndex((x) => x.id === r.id);
    update(c.replacements.filter((x) => x.id !== r.id));
    if (!r.from.trim() && !r.to.trim()) return;
    pushUndo(`「${r.from || r.to}」の置換を削除しました`, () => {
      const list = [...latest.current.replacements];
      if (list.some((x) => x.id === r.id)) return;
      list.splice(Math.min(index, list.length), 0, r);
      update(list);
    });
  };
  const q = keyOf(query);
  // 置換は長い言葉から順に 1 回だけ当てるので、並び順は結果に影響しない。新しいものを上に出す
  const visible = c.replacements.filter((r) => !q || keyOf(r.from).includes(q) || keyOf(r.to).includes(q));
  return (
    <Section
      title={`置換（${c.replacements.length} 件）`}
      description="整形の後に、決まった言葉を決まった文字列に置き換えます（メールアドレス、URL、定型文など）。LLM を通さないので、毎回必ず同じ結果になります。一致は大文字小文字と全角半角を区別しません。"
      actions={
        <Button small onClick={() => update([newReplacement(), ...c.replacements])}>
          ＋ 追加
        </Button>
      }
    >
      {c.replacements.length > 8 && <SearchBox value={query} onChange={setQuery} placeholder="置換を探す" />}
      {c.replacements.length === 0 ? (
        <div className="px-4 py-6 text-center text-[13px] text-neutral-500">置換はまだありません</div>
      ) : visible.length === 0 ? (
        <div className="px-4 py-6 text-center text-[13px] text-neutral-500">一致する置換はありません</div>
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
  const [input, setInput] = useState('');
  const add = () => {
    const words = splitWords(input).filter((w) => charLen(w) <= LIMITS.wordLength);
    if (!words.length) return;
    const keys = new Set(words.map(keyOf));
    // 学習済みの語を入れたら、学習も取り消す
    void save({
      blockedLearnedWords: uniqWords([...c.blockedLearnedWords, ...words]),
      learnedWords: c.learnedWords.filter((w) => !keys.has(keyOf(w.word))),
    });
    setInput('');
  };
  return (
    <Section title={`学習しない語（${c.blockedLearnedWords.length} 語）`} description="ここにある語は、手直しから自動で学習しません。取り消した学習語もここに入ります。">
      <div className="flex gap-2 px-4 py-3">
        <input
          className={inputClass}
          placeholder="学習させたくない語（カンマ区切りでまとめて追加）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button onClick={add} disabled={!input.trim()}>
          追加
        </Button>
      </div>
      {c.blockedLearnedWords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          {[...c.blockedLearnedWords].reverse().map((w) => (
            <span key={w} className="inline-flex items-center gap-1 rounded-md bg-black/[0.05] py-0.5 pl-2 pr-1 text-[13px] dark:bg-white/10">
              {w}
              <button
                className="rounded px-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-white"
                title="学習しない語から外す"
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
  const enabled = snap.settings.learning.enabled;
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [undoNode, pushUndo] = useUndo();
  const latest = useLatest(c);

  const undoLearn = (w: LearnedWord) => {
    void window.longhand.undoLearnedWord(w.word);
    pushUndo(`「${w.word}」の学習を取り消しました`, () => {
      const cur = latest.current;
      void save({
        learnedWords: cur.learnedWords.some((x) => x.word === w.word) ? cur.learnedWords : [...cur.learnedWords, w],
        blockedLearnedWords: cur.blockedLearnedWords.filter((x) => x !== w.word),
      });
    });
  };
  const moveToDictionary = (w: LearnedWord) => {
    if (c.dictionary.length >= LIMITS.dictionary) {
      setNotice({ tone: 'red', text: `辞書が上限の ${LIMITS.dictionary.toLocaleString()} 語に達しているため、移せません。` });
      return;
    }
    setNotice(null);
    // かなの誤認識の形は、辞書の読みとして引き継ぐ（照合に使う）
    const from = w.from.trim();
    const keepReading = from && KANA_ONLY.test(from) && charLen(from) >= 3;
    const readings = keepReading ? { ...c.readings, [w.word]: uniqWords([...(c.readings?.[w.word] ?? []), from]) } : c.readings;
    // 読みとして引き継げない形（漢字や英字の誤認識）は、聞き違えた形として残す
    const misheard = !keepReading && from ? { ...c.misheard, [w.word]: uniqWords([from, ...(c.misheard?.[w.word] ?? [])]) } : c.misheard;
    void save({
      dictionary: c.dictionary.some((x) => keyOf(x) === keyOf(w.word)) ? c.dictionary : [...c.dictionary, w.word],
      learnedWords: c.learnedWords.filter((x) => x.word !== w.word),
      ...(readings ? { readings } : {}),
      ...(misheard ? { misheard } : {}),
    });
  };
  // 辞書の語に付いた、聞き違えた形（学習語の分は、学習した語の行に並べる）
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
      <Section
        title="手直しからの学習"
        description="音声入力の直後に、入力された文をあなたが手で直すと、直した語を辞書に追加します。辞書に入れない直し（同じ読みの別の語、表記、整形の書き換えを戻したもの）も、直し方として覚えます。差分は端末内で取り出し、LLM には直した語と前後の短い文だけを送って、辞書に入れるべき語かを判定させます。"
      >
        <Row label="手直しから学習する" hint={`入力後 ${snap.settings.learning.watchSeconds} 秒間、入力欄の変化を見ます。パスワード欄とターミナルでは見ません。`}>
          <Toggle checked={enabled} onChange={(v) => void window.longhand.updateSettings({ learning: { enabled: v } })} />
        </Row>
      </Section>
      <Section
        title={`学習した語（${c.learnedWords.length} / ${LIMITS.learned} 語）`}
        description={`上限を超えると、古く学習した語から外れます。1 回の手直しで 3 語より多く直したときは、書き直しとみなして学習しません。`}
      >
        <NoticeLine n={notice} />
        {c.learnedWords.length > 8 && <SearchBox value={query} onChange={setQuery} placeholder="学習した語を探す" />}
        {c.learnedWords.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-neutral-500">まだありません</div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-neutral-500">一致する語はありません</div>
        ) : (
          visible.map((w) => (
            <div key={w.word} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="font-medium">{w.word}</span>
              <span className="text-neutral-400">← {[w.from, ...(c.misheard?.[w.word] ?? [])].join('、')}</span>
              <span className="text-[11.5px] text-neutral-400">{new Date(w.learnedAt).toLocaleDateString('ja-JP')}</span>
              <span className="ml-auto flex gap-1">
                <Button small variant="ghost" onClick={() => moveToDictionary(w)}>
                  辞書に移す
                </Button>
                <Button small variant="danger" onClick={() => undoLearn(w)}>
                  取り消す
                </Button>
              </span>
            </div>
          ))
        )}
        {undoNode}
      </Section>
      {dictForms.length > 0 && (
        <Section title="辞書の語の聞き違えた形" description="辞書にある語に直したとき、直す前の形を覚えます。次に同じ形が出たら、その語の候補として扱います。">
          {dictForms.map(([word, forms]) => (
            <div key={word} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
              <span className="font-medium">{word}</span>
              <span className="text-neutral-400">←</span>
              {forms.map((f) => (
                <span key={f} className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 dark:bg-neutral-800">
                  {f}
                  <button type="button" className="text-neutral-400 hover:text-red-500" title="この形を外す" onClick={() => removeForm(word, f)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ))}
        </Section>
      )}
      {corrections.length > 0 && (
        <Section
          title={`直した取り違え（${corrections.length} 件）`}
          description="同じ読みの別の語や、表記の直しを覚えます。辞書には入れず、次に左の形が出たときに、文脈に合えば右の形に直します（LLM を使うとき）。"
        >
          {corrections.map((p) => (
            <div key={`${p.heard}\u0000${p.corrected}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="text-neutral-500">{p.heard}</span>
              <span className="text-neutral-400">→</span>
              <span className="font-medium">{p.corrected}</span>
              {p.count > 1 && <span className="text-[11.5px] text-neutral-400">{p.count} 回</span>}
              <span className="ml-auto">
                <Button small variant="danger" onClick={() => void save({ pastCorrections: (c.pastCorrections ?? []).filter((x) => !(x.heard === p.heard && x.corrected === p.corrected)) })}>
                  取り消す
                </Button>
              </span>
            </div>
          ))}
        </Section>
      )}
      {kept.length > 0 && (
        <Section title={`書き換えない語句（${kept.length} 件）`} description="整形が書き換えた所を、あなたが話したとおりに戻したとき、その語句を覚えます。次からは書き換えません。">
          {kept.map((k) => (
            <div key={`${k.phrase}\u0000${k.changedTo}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="font-medium">{k.phrase}</span>
              <span className="text-neutral-400">（「{k.changedTo}」にしない）</span>
              <span className="ml-auto">
                <Button small variant="danger" onClick={() => void save({ keptPhrases: (c.keptPhrases ?? []).filter((x) => !(x.phrase === k.phrase && x.changedTo === k.changedTo)) })}>
                  取り消す
                </Button>
              </span>
            </div>
          ))}
        </Section>
      )}
      {numberStyles.length > 0 && (
        <Section
          title="数字の書き方"
          description="数字の書き方だけを直したとき（「2つ」を「二つ」にした、など）、その書き方を覚えます。次からは、LLM を使わないときも、この書き方で入力します。ターミナルとコードエディタでは変えません。"
        >
          {numberStyles.map(([kind, p]) => (
            <div key={kind} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="w-24 shrink-0 text-neutral-500">{NUMBER_STYLE_LABELS[kind].title}</span>
              <span className="font-medium">{NUMBER_STYLE_LABELS[kind].values[p.value] ?? p.value}</span>
              {p.example && (
                <span className="text-neutral-400">
                  {p.example.before} → {p.example.after}
                </span>
              )}
              {p.count > 1 && <span className="text-[11.5px] text-neutral-400">{p.count} 回</span>}
              <span className="ml-auto">
                <Button small variant="danger" onClick={() => removeNumberStyle(kind)}>
                  取り消す
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

/** Names of the number notation preferences on the Style page */
const NUMBER_STYLE_LABELS: Record<NumberStyleKind, { title: string; values: Record<string, string> }> = {
  width: { title: '数字の幅', values: { half: '半角（10）', full: '全角（１０）' } },
  grouping: { title: '3 桁の区切り', values: { comma: '入れる（10,000円）', none: '入れない（10000円）' } },
  units: { title: '万と億', values: { kanji: '使う（1万円）', digits: '使わない（10000円）' } },
  counters: { title: '数え方', values: { kanji: '漢数字（二つ、一人）', digits: '算用数字（2つ、1人）' } },
  percent: { title: '百分率', values: { symbol: '記号（3%）', word: 'カタカナ（3パーセント）' } },
  time: { title: '時刻', values: { colon: '10:30', kanji: '10時30分' } },
  date: { title: '日付', values: { slash: '11/24', kanji: '11月24日' } },
};

function Instructions({ c }: { c: Customizations }) {
  const [v, setV] = useState(c.customInstructions);
  const [saved, setSaved] = useState(false);
  const latest = useLatest(c);
  const value = useLatest(v);
  const focused = useRef(false);
  const timer = useRef<number | null>(null);
  const savedTimer = useRef<number | null>(null);
  // 入力中は、保存の結果で届いた古い値で上書きしない
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
  // 画面を離れるときに、まだ保存していない入力を保存する
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
    <Section
      title="カスタム指示"
      description="整形のときに LLM へ追加で伝える指示です。入力が止まって 1 秒たつと保存します。例:「です・ます調にそろえる」「数字は全角にしない」「社名は株式会社を省略しない」。"
    >
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
          placeholder="ここに書いた指示は、整形の規則より優先されます。"
        />
        <div className="mt-1.5 flex justify-between text-[11.5px] text-neutral-500">
          <span className="flex items-center gap-2">
            {len > 2000 && <Badge tone="amber">長い指示は応答を遅くします</Badge>}
            {saved && <span role="status">保存しました</span>}
          </span>
          <span className="tabular-nums">{len.toLocaleString()} 字</span>
        </div>
      </div>
    </Section>
  );
}

export function Style({ snap }: { snap: AppSnapshot }) {
  const [tab, setTab] = useState<Tab>('dictionary');
  const c = snap.customizations;
  return (
    <>
      <PageHeader title="スタイル" description="書き起こしの表記と整形のしかたを調整します。" />
      <div className="mb-5 inline-flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.08]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              'rounded-md px-3 py-1 text-[13px]',
              tab === t.id ? 'bg-white font-medium shadow-sm dark:bg-white/20' : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
            )}
          >
            {t.label}
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
