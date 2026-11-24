import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/settings';
import type { AutoFix, HistoryItem } from '../../shared/types';
import { bindingLabel } from '../common/keys';
import { Badge, Button, inputClass, PageHeader, Select, useSnapshot } from '../common/ui';

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

const PASTE_BADGE: Record<HistoryItem['paste'], { label: string; tone: 'amber' | 'red' | 'neutral' } | null> = {
  pasted: null,
  failed: { label: '入力できず', tone: 'red' },
  skipped: { label: '未入力', tone: 'neutral' },
  stale: { label: '後から完了', tone: 'amber' },
  cancelled: { label: '取り消した録音', tone: 'neutral' },
};

const LANGUAGES: { value: Settings['language']; label: string }[] = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'auto', label: '自動判定' },
];

/** 書き起こし直す、整形し直す（H1） */
function Redo({ item }: { item: HistoryItem }) {
  const [busy, setBusy] = useState<'transcribe' | 'format' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<Settings['language']>((LANGUAGES.some((l) => l.value === item.language) ? item.language : 'ja') as Settings['language']);
  const [open, setOpen] = useState(false);
  if (item.mode === 'edit') return null;
  const canTranscribe = !!item.audioFile;
  const canFormat = !!item.rawText.trim();
  if (!canTranscribe && !canFormat) return null;
  const run = async (kind: 'transcribe' | 'format') => {
    setBusy(kind);
    setError(null);
    const r = await window.longhand.redoHistory(item.id, { kind, language: kind === 'transcribe' ? language : undefined });
    setBusy(null);
    if (!r.ok) setError(r.error ?? 'やり直せませんでした');
    else setOpen(false);
  };
  return (
    <>
      {canTranscribe &&
        (open ? (
          <span className="inline-flex items-center gap-1">
            <Select value={language} options={LANGUAGES} onChange={setLanguage} className="py-0.5 text-[12px]" />
            <Button small variant="secondary" disabled={!!busy} onClick={() => void run('transcribe')}>
              {busy === 'transcribe' ? '書き起こし中…' : '書き起こす'}
            </Button>
            <Button small variant="ghost" disabled={!!busy} onClick={() => setOpen(false)}>
              やめる
            </Button>
          </span>
        ) : (
          <Button small variant="ghost" disabled={!!busy} onClick={() => setOpen(true)}>
            書き起こし直す
          </Button>
        ))}
      {canFormat && !open && (
        <Button small variant="ghost" disabled={!!busy} onClick={() => void run('format')}>
          {busy === 'format' ? '整形中…' : '整形だけやり直す'}
        </Button>
      )}
      {error && <span className="self-center text-[11.5px] text-rose-600 dark:text-rose-400">{error}</span>}
    </>
  );
}

/** 文を手で直す（G4-08）。保存すると、学習がオンなら直した語を辞書に覚える */
function EditBox({ initial, learn, onSave, onCancel }: { initial: string; learn: boolean; onSave: (text: string) => Promise<string | null>; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    const err = await onSave(draft);
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <div>
      <textarea
        className={inputClass + ' min-h-[64px] resize-y text-[13.5px] leading-relaxed'}
        aria-label="直した文"
        autoFocus
        value={draft}
        rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 40)))}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Button small variant="secondary" disabled={busy || !draft.trim()} onClick={() => void save()}>
          {busy ? (learn ? '保存して語を確かめています…' : '保存中…') : '保存'}
        </Button>
        <Button small variant="ghost" disabled={busy} onClick={onCancel}>
          やめる
        </Button>
        <span className="text-[11.5px] text-neutral-500">{learn ? '⌘Enter で保存。聞き間違いを直すと、その語を辞書に覚えます。' : '⌘Enter で保存。'}</span>
        {error && <span className="text-[11.5px] text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
    </div>
  );
}

const FIX_RULE_LABEL: Record<AutoFix['rule'], string> = {
  latin: '英字の綴り',
  fillers: 'つなぎの言葉',
  notation: '表記',
  particles: '助詞',
};

/** 自動修正（textfix）で直した箇所。箇所ごとに「今後は直さない」を選べる */
function AutoFixes({ fixes, blocked }: { fixes: AutoFix[]; blocked: string[] }) {
  const [open, setOpen] = useState(false);
  const key = (f: AutoFix) => `${f.rule}:${f.before}`;
  const block = (f: AutoFix) => void window.longhand.updateSettings({ textFix: { blocked: [...new Set([...blocked, key(f)])] } });
  if (!open) {
    return (
      <Button small variant="ghost" onClick={() => setOpen(true)}>
        自動修正 {fixes.length} か所
      </Button>
    );
  }
  return (
    <div className="mt-1.5 w-full rounded-md bg-black/[0.03] px-2.5 py-1.5 text-[12px] dark:bg-white/[0.05]">
      <div className="mb-1 flex items-center justify-between text-neutral-500">
        <span>LLM を通さずに貼った文で、次の箇所を自動で直しました</span>
        <Button small variant="ghost" onClick={() => setOpen(false)}>
          閉じる
        </Button>
      </div>
      <ul className="space-y-0.5">
        {fixes.map((f, i) => {
          const stopped = blocked.includes(key(f));
          return (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="text-neutral-500">{FIX_RULE_LABEL[f.rule]}</span>
              <span>
                <span className="line-through opacity-70">{f.before}</span> → {f.after.trim() || '（削除）'}
              </span>
              {stopped ? (
                <span className="text-neutral-500">今後は直しません</span>
              ) : (
                <Button small variant="ghost" onClick={() => block(f)}>
                  今後は直さない
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 手直しから覚えた語の知らせ。取り消すと同じ語は二度と覚えない */
function LearnedNotice({ words, remembered, onClose }: { words: string[]; remembered: number; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 12000);
    return () => clearTimeout(t);
  }, [onClose]);
  // 直した語が多すぎると、聞き間違いの直しではなく書き直しとみなして学習しない（Learner の上限）
  if (!words.length && remembered > 0) {
    // 辞書に語を足さない学習（聞き違えた形、取り違えの組、書き換えない語句）。取り消しは「スタイル」の画面で行う
    return (
      <div role="status" className="mt-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
        直し方を {remembered} 件覚えました（「スタイル」の「学習した語」で確かめられます）
      </div>
    );
  }
  if (!words.length)
    return (
      <div role="status" className="mt-1.5 text-[12px] text-neutral-500">
        直した語が多いため、書き直しとみなして学習しませんでした
      </div>
    );
  return (
    <div role="status" className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-emerald-700 dark:text-emerald-400">
      <span>「{words.join('」「')}」を辞書に追加しました</span>
      <Button
        small
        variant="ghost"
        onClick={async () => {
          for (const w of words) await window.longhand.undoLearnedWord(w);
          onClose();
        }}
      >
        取り消す
      </Button>
    </div>
  );
}

function Item({ item, learn, blocked, onDelete }: { item: HistoryItem; learn: boolean; blocked: string[]; onDelete: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [learned, setLearned] = useState<{ words: string[]; remembered: number } | null>(null);
  const closeLearned = useCallback(() => setLearned(null), []);
  const [copied, setCopied] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const text = showRaw ? item.rawText : item.text || item.rawText;
  const badge = PASTE_BADGE[item.paste];
  const edit = item.mode === 'edit';

  useEffect(() => () => void (audioUrl && URL.revokeObjectURL(audioUrl)), [audioUrl]);

  const play = async () => {
    if (audioUrl) {
      void audioRef.current?.play();
      return;
    }
    const buf = await window.longhand.readAudio(item.id);
    if (!buf) return;
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    setAudioUrl(url);
    setTimeout(() => void audioRef.current?.play(), 0);
  };

  return (
    <div className="group px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-[11.5px] text-neutral-500 dark:text-neutral-400">
        <span className="tabular-nums">{timeLabel(item.timestamp)}</span>
        {item.app && (
          <span>
            · {item.app.name}
            {item.host ? ` (${item.host})` : ''}
          </span>
        )}
        <span>· {item.durationSec.toFixed(1)} 秒</span>
        {edit && <Badge tone="violet">編集</Badge>}
        {item.editUnclear && <Badge tone="amber">不明確な編集</Badge>}
        {!item.formatted && item.text && <Badge tone="amber">未整形</Badge>}
        {item.fastPath && <Badge>LLM なし</Badge>}
        {!!item.autoFixes?.length && <Badge>自動修正</Badge>}
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        <span className="ml-auto hidden tabular-nums opacity-70 group-hover:inline" title="音声認識 / LLM / 合計">
          {item.timings.asrMs}ms / {item.timings.llmMs}ms / {item.timings.totalMs}ms
        </span>
      </div>
      {edit && item.selectedText && !showRaw && <div className="mb-1 line-clamp-2 text-[12px] text-neutral-400 line-through">{item.selectedText}</div>}
      {edit && (showRaw || !item.text) && item.rawText && <div className="mb-0.5 text-[11.5px] text-neutral-500">話した指示</div>}
      {editing ? (
        <EditBox
          initial={item.text || item.rawText}
          learn={learn && !edit}
          onCancel={() => setEditing(false)}
          onSave={async (next) => {
            const r = await window.longhand.editHistory(item.id, next);
            if (!r.ok) return r.error ?? '保存できませんでした';
            setEditing(false);
            const remembered = r.remembered ?? 0;
            setLearned(r.learned?.length || remembered || r.tooMany ? { words: r.learned ?? [], remembered } : null);
            return null;
          }}
        />
      ) : (
        <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">
          {text || <span className="text-neutral-400">{item.audioFile && !edit ? '（書き起こしなし。「書き起こし直す」で書き起こせます）' : '（空）'}</span>}
        </div>
      )}
      {learned && <LearnedNotice words={learned.words} remembered={learned.remembered} onClose={closeLearned} />}
      {item.llmError && <div className="mt-1 text-[11.5px] text-amber-600 dark:text-amber-400">{item.llmError}</div>}
      {!!item.autoFixes?.length && !editing && (
        <div className="mt-1 flex flex-wrap">
          <AutoFixes fixes={item.autoFixes} blocked={blocked} />
        </div>
      )}
      {/* キーボードで移動したときも操作が見えるようにする（X1） */}
      <div className={'mt-1.5 flex flex-wrap gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100' + (editing ? ' hidden' : '')}>
        <Button
          small
          variant="ghost"
          disabled={!text}
          onClick={async () => {
            await window.longhand.copyText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? 'コピーしました' : 'コピー'}
        </Button>
        {(item.text || (!edit && item.rawText)) && (
          <Button
            small
            variant="ghost"
            onClick={() => {
              setShowRaw(false);
              setLearned(null);
              setEditing(true);
            }}
          >
            文を直す
          </Button>
        )}
        {item.rawText && item.text && item.rawText !== item.text && (
          <Button small variant="ghost" onClick={() => setShowRaw((x) => !x)}>
            {edit ? (showRaw ? '結果を表示' : '話した指示を表示') : showRaw ? '整形後を表示' : '整形前を表示'}
          </Button>
        )}
        {item.audioFile && (
          <>
            <Button small variant="ghost" onClick={play}>
              再生
            </Button>
            <Button small variant="ghost" onClick={() => void window.longhand.saveAudioAs(item.id)}>
              音声を保存
            </Button>
          </>
        )}
        <Redo item={item} />
        <Button small variant="danger" onClick={onDelete}>
          削除
        </Button>
      </div>
      {audioUrl && <audio ref={audioRef} src={audioUrl} className="hidden" />}
    </div>
  );
}

/** 削除してから実際に消すまでの猶予（H3）。その間は「元に戻す」で取り消せる */
const UNDO_MS = 5000;

export function History() {
  const [snap] = useSnapshot();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<HistoryItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<HistoryItem | null>(null);
  pendingRef.current = pending;
  const load = useCallback(() => void window.longhand.listHistory(q).then(setItems), [q]);
  useEffect(load, [load]);
  useEffect(() => window.longhand.onHistoryChanged(load), [load]);

  const commitDelete = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pendingRef.current;
    if (p) void window.longhand.deleteHistory(p.id);
    setPending(null);
  }, []);
  // ページを離れるときは、待っている削除をすぐに行う
  useEffect(() => () => commitDelete(), [commitDelete]);

  const remove = (item: HistoryItem) => {
    commitDelete();
    setPending(item);
    timer.current = setTimeout(commitDelete, UNDO_MS);
  };
  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPending(null);
  };

  const hotkeys = snap?.settings.hotkeys;
  const activate = bindingLabel(hotkeys?.activate[0]) || 'fn';
  const paste = bindingLabel(hotkeys?.paste_last[0]);
  const visible = items.filter((it) => it.id !== pending?.id);

  return (
    <>
      <PageHeader
        title="履歴"
        description={
          <>
            音声入力の結果。録音は設定した期間だけ端末内に残ります。
            <br />
            {paste ? `入力できなかったときは ${paste} で直前の書き起こしを貼り付けられます。` : '入力できなかったときは、フローティングバーを右クリックして「直前の書き起こしを貼り付け」を選べます。'}
          </>
        }
        actions={
          items.length > 0 && (
            <Button
              variant="danger"
              onClick={async () => {
                if (confirm('履歴と録音をすべて削除しますか？この操作は元に戻せません。')) await window.longhand.clearHistory();
              }}
            >
              すべて削除
            </Button>
          )
        }
      />
      <input className={inputClass + ' mb-4'} placeholder="検索" aria-label="履歴を検索" value={q} onChange={(e) => setQ(e.target.value)} />
      {pending && (
        <div role="status" className="mb-3 flex items-center justify-between rounded-lg bg-black/[0.05] px-4 py-2 text-[12.5px] dark:bg-white/[0.06]">
          <span>履歴を 1 件削除しました</span>
          <Button small variant="secondary" onClick={undo}>
            元に戻す
          </Button>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-neutral-500">{q ? '一致する履歴はありません' : `まだ履歴がありません。${activate} を押しながら話してみてください。`}</div>
      ) : (
        <div className="divide-y divide-black/[0.06] overflow-hidden rounded-xl bg-white/80 shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)] dark:divide-white/[0.07] dark:bg-white/[0.04]">
          {visible.map((it) => (
            <Item key={it.id} item={it} learn={!!snap?.settings.learning.enabled} blocked={snap?.settings.textFix?.blocked ?? []} onDelete={() => remove(it)} />
          ))}
        </div>
      )}
    </>
  );
}
