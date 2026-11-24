import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageKey } from '../../shared/i18n';
import type { Settings } from '../../shared/settings';
import type { AutoFix, HistoryItem } from '../../shared/types';
import { intlLocale, useLocale, useT } from '../common/i18n';
import { bindingLabel } from '../common/keys';
import { Badge, Button, inputClass, PageHeader, Select, useSnapshot } from '../common/ui';

/** Time of day for today's items, and month, day and time for older ones */
function timeLabel(ts: number, locale: string): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const PASTE_BADGE: Record<HistoryItem['paste'], { label: MessageKey; tone: 'amber' | 'red' | 'neutral' } | null> = {
  pasted: null,
  failed: { label: 'history.paste.failed', tone: 'red' },
  skipped: { label: 'history.paste.skipped', tone: 'neutral' },
  stale: { label: 'history.paste.stale', tone: 'amber' },
  cancelled: { label: 'history.paste.cancelled', tone: 'neutral' },
};

const LANGUAGES: { value: Settings['language']; label: MessageKey }[] = [
  { value: 'ja', label: 'history.language.ja' },
  { value: 'en', label: 'history.language.en' },
  { value: 'auto', label: 'history.language.auto' },
];

/** Transcribes again or formats again (H1) */
function Redo({ item }: { item: HistoryItem }) {
  const t = useT();
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
    if (!r.ok) setError(r.error ?? t('history.redo.failed'));
    else setOpen(false);
  };
  return (
    <>
      {canTranscribe &&
        (open ? (
          <span className="inline-flex items-center gap-1">
            <Select value={language} options={LANGUAGES.map((l) => ({ value: l.value, label: t(l.label) }))} onChange={setLanguage} className="py-0.5 text-[12px]" />
            <Button small variant="secondary" disabled={!!busy} onClick={() => void run('transcribe')}>
              {busy === 'transcribe' ? t('history.redo.transcribing') : t('history.redo.transcribe')}
            </Button>
            <Button small variant="ghost" disabled={!!busy} onClick={() => setOpen(false)}>
              {t('history.cancel')}
            </Button>
          </span>
        ) : (
          <Button small variant="ghost" disabled={!!busy} onClick={() => setOpen(true)}>
            {t('history.redo.retranscribe')}
          </Button>
        ))}
      {canFormat && !open && (
        <Button small variant="ghost" disabled={!!busy} onClick={() => void run('format')}>
          {busy === 'format' ? t('history.redo.formatting') : t('history.redo.format')}
        </Button>
      )}
      {error && <span className="self-center text-[11.5px] text-rose-600 dark:text-rose-400">{error}</span>}
    </>
  );
}

/** Corrects the text by hand (G4-08). On save, the corrected words are added to the dictionary when learning is on */
function EditBox({ initial, learn, onSave, onCancel }: { initial: string; learn: boolean; onSave: (text: string) => Promise<string | null>; onCancel: () => void }) {
  const t = useT();
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
        aria-label={t('history.edit.label')}
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
          {busy ? (learn ? t('history.edit.savingLearn') : t('history.edit.saving')) : t('history.edit.save')}
        </Button>
        <Button small variant="ghost" disabled={busy} onClick={onCancel}>
          {t('history.cancel')}
        </Button>
        <span className="text-[11.5px] text-neutral-500">{learn ? t('history.edit.hintLearn') : t('history.edit.hint')}</span>
        {error && <span className="text-[11.5px] text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
    </div>
  );
}

const FIX_RULE_LABEL: Record<AutoFix['rule'], MessageKey> = {
  latin: 'history.fix.latin',
  fillers: 'history.fix.fillers',
  notation: 'history.fix.notation',
  particles: 'history.fix.particles',
};

/** Places fixed by the automatic fixes (textfix). Each place can be set to "Don't Fix Again" */
function AutoFixes({ fixes, blocked }: { fixes: AutoFix[]; blocked: string[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const key = (f: AutoFix) => `${f.rule}:${f.before}`;
  const block = (f: AutoFix) => void window.longhand.updateSettings({ textFix: { blocked: [...new Set([...blocked, key(f)])] } });
  if (!open) {
    return (
      <Button small variant="ghost" onClick={() => setOpen(true)}>
        {t('history.fixes.count', { count: fixes.length })}
      </Button>
    );
  }
  return (
    <div className="mt-1.5 w-full rounded-md bg-black/[0.03] px-2.5 py-1.5 text-[12px] dark:bg-white/[0.05]">
      <div className="mb-1 flex items-center justify-between text-neutral-500">
        <span>{t('history.fixes.description')}</span>
        <Button small variant="ghost" onClick={() => setOpen(false)}>
          {t('history.close')}
        </Button>
      </div>
      <ul className="space-y-0.5">
        {fixes.map((f, i) => {
          const stopped = blocked.includes(key(f));
          return (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="text-neutral-500">{t(FIX_RULE_LABEL[f.rule])}</span>
              <span>
                <span className="line-through opacity-70">{f.before}</span> → {f.after.trim() || t('history.fixes.removed')}
              </span>
              {stopped ? (
                <span className="text-neutral-500">{t('history.fixes.stopped')}</span>
              ) : (
                <Button small variant="ghost" onClick={() => block(f)}>
                  {t('history.fixes.stop')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Notice of words learned from a correction. Once undone, the same word is never learned again */
function LearnedNotice({ words, remembered, onClose }: { words: string[]; remembered: number; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const t = setTimeout(onClose, 12000);
    return () => clearTimeout(t);
  }, [onClose]);
  // When too many words were changed, treat it as a rewrite rather than a fix of misheard words and learn nothing (the Learner's limit)
  if (!words.length && remembered > 0) {
    // Learning that adds no words to the dictionary (misheard forms, mix-up pairs, phrases to keep). It is undone on the Style page
    return (
      <div role="status" className="mt-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
        {t('history.learned.remembered', { count: remembered })}
      </div>
    );
  }
  if (!words.length)
    return (
      <div role="status" className="mt-1.5 text-[12px] text-neutral-500">
        {t('history.learned.tooMany')}
      </div>
    );
  return (
    <div role="status" className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-emerald-700 dark:text-emerald-400">
      <span>{t('history.learned.added', { words: words.join(t('history.learned.wordSeparator')) })}</span>
      <Button
        small
        variant="ghost"
        onClick={async () => {
          for (const w of words) await window.longhand.undoLearnedWord(w);
          onClose();
        }}
      >
        {t('history.learned.undo')}
      </Button>
    </div>
  );
}

function Item({ item, learn, blocked, onDelete }: { item: HistoryItem; learn: boolean; blocked: string[]; onDelete: () => void }) {
  const t = useT();
  const loc = intlLocale(useLocale());
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
        <span className="tabular-nums">{timeLabel(item.timestamp, loc)}</span>
        {item.app && (
          <span>
            · {item.app.name}
            {item.host ? ` (${item.host})` : ''}
          </span>
        )}
        <span>· {t('history.item.duration', { seconds: item.durationSec.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>
        {edit && <Badge tone="violet">{t('history.badge.edit')}</Badge>}
        {item.editUnclear && <Badge tone="amber">{t('history.badge.editUnclear')}</Badge>}
        {!item.formatted && item.text && <Badge tone="amber">{t('history.badge.unformatted')}</Badge>}
        {item.fastPath && <Badge>{t('history.badge.noLlm')}</Badge>}
        {!!item.autoFixes?.length && <Badge>{t('history.badge.autoFixed')}</Badge>}
        {badge && <Badge tone={badge.tone}>{t(badge.label)}</Badge>}
        <span className="ml-auto hidden tabular-nums opacity-70 group-hover:inline" title={t('history.item.timings')}>
          {item.timings.asrMs}ms / {item.timings.llmMs}ms / {item.timings.totalMs}ms
        </span>
      </div>
      {edit && item.selectedText && !showRaw && <div className="mb-1 line-clamp-2 text-[12px] text-neutral-400 line-through">{item.selectedText}</div>}
      {edit && (showRaw || !item.text) && item.rawText && <div className="mb-0.5 text-[11.5px] text-neutral-500">{t('history.item.spokenInstruction')}</div>}
      {editing ? (
        <EditBox
          initial={item.text || item.rawText}
          learn={learn && !edit}
          onCancel={() => setEditing(false)}
          onSave={async (next) => {
            const r = await window.longhand.editHistory(item.id, next);
            if (!r.ok) return r.error ?? t('history.edit.failed');
            setEditing(false);
            const remembered = r.remembered ?? 0;
            setLearned(r.learned?.length || remembered || r.tooMany ? { words: r.learned ?? [], remembered } : null);
            return null;
          }}
        />
      ) : (
        <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">
          {text || <span className="text-neutral-400">{item.audioFile && !edit ? t('history.item.noTranscript', { button: t('history.redo.retranscribe') }) : t('history.item.empty')}</span>}
        </div>
      )}
      {learned && <LearnedNotice words={learned.words} remembered={learned.remembered} onClose={closeLearned} />}
      {item.llmError && <div className="mt-1 text-[11.5px] text-amber-600 dark:text-amber-400">{item.llmError}</div>}
      {!!item.autoFixes?.length && !editing && (
        <div className="mt-1 flex flex-wrap">
          <AutoFixes fixes={item.autoFixes} blocked={blocked} />
        </div>
      )}
      {/* Keep the actions visible when moving with the keyboard too (X1) */}
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
          {copied ? t('history.item.copied') : t('history.item.copy')}
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
            {t('history.item.edit')}
          </Button>
        )}
        {item.rawText && item.text && item.rawText !== item.text && (
          <Button small variant="ghost" onClick={() => setShowRaw((x) => !x)}>
            {edit ? (showRaw ? t('history.item.showResult') : t('history.item.showInstruction')) : showRaw ? t('history.item.showFormatted') : t('history.item.showRaw')}
          </Button>
        )}
        {item.audioFile && (
          <>
            <Button small variant="ghost" onClick={play}>
              {t('history.item.play')}
            </Button>
            <Button small variant="ghost" onClick={() => void window.longhand.saveAudioAs(item.id)}>
              {t('history.item.saveAudio')}
            </Button>
          </>
        )}
        <Redo item={item} />
        <Button small variant="danger" onClick={onDelete}>
          {t('history.item.delete')}
        </Button>
      </div>
      {audioUrl && <audio ref={audioRef} src={audioUrl} className="hidden" />}
    </div>
  );
}

/** Grace period between deleting an item and actually removing it (H3). Until then, "Undo" brings it back */
const UNDO_MS = 5000;

export function History() {
  const t = useT();
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
  // When leaving the page, carry out the pending deletion right away
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
  const locale = snap?.locale ?? 'en';
  const activate = bindingLabel(hotkeys?.activate[0], locale) || 'fn';
  const paste = bindingLabel(hotkeys?.paste_last[0], locale);
  const visible = items.filter((it) => it.id !== pending?.id);

  return (
    <>
      <PageHeader
        title={t('history.title')}
        description={
          <>
            {t('history.description')}
            <br />
            {paste ? t('history.pasteHint', { key: paste }) : t('history.pasteHintMenu')}
          </>
        }
        actions={
          items.length > 0 && (
            <Button
              variant="danger"
              onClick={async () => {
                if (confirm(t('history.clearConfirm'))) await window.longhand.clearHistory();
              }}
            >
              {t('history.clearAll')}
            </Button>
          )
        }
      />
      <input className={inputClass + ' mb-4'} placeholder={t('history.search')} aria-label={t('history.searchLabel')} value={q} onChange={(e) => setQ(e.target.value)} />
      {pending && (
        <div role="status" className="mb-3 flex items-center justify-between rounded-lg bg-black/[0.05] px-4 py-2 text-[12.5px] dark:bg-white/[0.06]">
          <span>{t('history.deleted')}</span>
          <Button small variant="secondary" onClick={undo}>
            {t('history.undo')}
          </Button>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-neutral-500">{q ? t('history.noMatch') : t('history.empty', { key: activate })}</div>
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
