import { useEffect, useRef, useState } from 'react';
import type { Binding, HotkeyAction } from '../../shared/protocol';
import { DEFAULT_HOTKEYS, type Settings } from '../../shared/settings';
import type { MessageKey } from '../../shared/i18n';
import { bindingLabel, isRiskyBinding, keyLabel, sortKeys } from '../common/keys';
import { useLocale, useT } from '../common/i18n';
import { Button, Row } from '../common/ui';

export function Keys({ keys }: { keys: string[] }) {
  const locale = useLocale();
  return (
    <span className="inline-flex items-center gap-1">
      {sortKeys(keys).map((k) => (
        <kbd key={k} className="key">
          {keyLabel(k, locale)}
        </kbd>
      ))}
    </span>
  );
}

const ACTIONS: { id: HotkeyAction; label: MessageKey; hint: MessageKey }[] = [
  { id: 'activate', label: 'shortcuts.action.activate', hint: 'shortcuts.action.activateHint' },
  { id: 'lock', label: 'shortcuts.action.lock', hint: 'shortcuts.action.lockHint' },
  { id: 'cancel', label: 'shortcuts.action.cancel', hint: 'shortcuts.action.cancelHint' },
  { id: 'paste_last', label: 'shortcuts.action.pasteLast', hint: 'shortcuts.action.pasteLastHint' },
];

function sameBinding(a: Binding, b: Binding): boolean {
  return a.length === b.length && sortKeys(a).join('+') === sortKeys(b).join('+');
}

/** Changes a key binding (HK-8). Records the key combination that the helper reports while keys are pressed */
function Recorder({ onDone, onCancel }: { onDone: (keys: string[]) => void; onCancel: () => void }) {
  const t = useT();
  const [keys, setKeys] = useState<string[]>([]);
  const done = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    void window.longhand.recordShortcut(true);
    // Recording turns itself off after 5 seconds, so keep renewing it while recording
    const renew = setInterval(() => void window.longhand.recordShortcut(true), 4000);
    const off = window.longhand.onShortcutKeys((p) => {
      setKeys(p.done ? p.combo : p.keys.length ? p.keys : p.combo);
      if (p.done && p.combo.length && !done.current) {
        done.current = true;
        onDoneRef.current(p.combo);
      }
    });
    return () => {
      clearInterval(renew);
      off();
      void window.longhand.recordShortcut(false);
    };
  }, []);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex min-w-[120px] items-center justify-center rounded-md bg-blue-500/10 px-2 py-1 text-[12px] text-blue-700 ring-1 ring-blue-500/40 dark:text-blue-300">
        {keys.length ? <Keys keys={keys} /> : t('shortcuts.recorder.pressKeys')}
      </span>
      <Button small variant="ghost" onClick={onCancel}>
        {t('shortcuts.recorder.stop')}
      </Button>
    </span>
  );
}

export function ShortcutSettings({ settings, update }: { settings: Settings; update: (hotkeys: Settings['hotkeys']) => void }) {
  const t = useT();
  const locale = useLocale();
  const [recording, setRecording] = useState<{ action: HotkeyAction; index: number } | null>(null);
  /** Kept as a key, so that the message follows a change of interface language. action: the action that already uses the keys */
  const [message, setMessage] = useState<{ key: MessageKey; action?: MessageKey } | null>(null);
  /** Offer to change the hands-free key as well when the talk key changes (S2) */
  const [suggest, setSuggest] = useState<{ index: number; keys: string[] } | null>(null);

  const commit = (action: HotkeyAction, index: number, keys: string[]) => {
    setRecording(null);
    if (keys.length > 5) {
      setMessage({ key: 'shortcuts.tooManyKeys' });
      return;
    }
    for (const a of ACTIONS) {
      const list = settings.hotkeys[a.id];
      if (list.some((b, i) => sameBinding(b, keys) && !(a.id === action && i === index))) {
        setMessage({ key: 'shortcuts.inUse', action: a.label });
        return;
      }
    }
    setMessage(isRiskyBinding(keys) ? { key: 'shortcuts.risky' } : null);
    const list = [...settings.hotkeys[action]];
    const old = list[index];
    list[index] = keys;
    update({ ...settings.hotkeys, [action]: list });
    // If hands-free is still the old talk key + Space, ask whether to move it to the new talk key
    setSuggest(null);
    if (action === 'activate' && old && !keys.includes('Space')) {
      const lockIndex = settings.hotkeys.lock.findIndex((b) => sameBinding(b, [...old, 'Space']));
      const next = [...keys, 'Space'];
      const taken = ACTIONS.some((a) => settings.hotkeys[a.id].some((b) => sameBinding(b, next)));
      if (lockIndex >= 0 && !taken) setSuggest({ index: lockIndex, keys: next });
    }
  };

  const applySuggest = () => {
    if (!suggest) return;
    const lock = [...settings.hotkeys.lock];
    lock[suggest.index] = suggest.keys;
    // update starts from the settings at the time of the call, so build on the latest bindings, which include the talk key change
    update({ ...settings.hotkeys, lock });
    setSuggest(null);
  };

  return (
    <>
      {ACTIONS.map((a) => {
        const list = settings.hotkeys[a.id];
        return (
          <Row key={a.id} label={t(a.label)} hint={t(a.hint)}>
            <div className="flex flex-col items-end gap-1.5">
              {list.map((b, i) =>
                recording?.action === a.id && recording.index === i ? (
                  <Recorder key={i} onDone={(k) => commit(a.id, i, k)} onCancel={() => setRecording(null)} />
                ) : (
                  <span key={i} className="inline-flex items-center gap-1.5">
                    <Keys keys={b} />
                    <Button small variant="ghost" onClick={() => setRecording({ action: a.id, index: i })}>
                      {t('shortcuts.change')}
                    </Button>
                    <Button
                      small
                      variant="ghost"
                      // The last talk key and the last cancel key cannot be deleted (S3)
                      disabled={list.length === 1 && (a.id === 'activate' || a.id === 'cancel')}
                      title={list.length === 1 && (a.id === 'activate' || a.id === 'cancel') ? t('shortcuts.cannotDeleteLast') : t('shortcuts.delete')}
                      onClick={() => update({ ...settings.hotkeys, [a.id]: list.filter((_, j) => j !== i) })}
                    >
                      ×
                    </Button>
                  </span>
                ),
              )}
              {recording?.action === a.id && recording.index === list.length && <Recorder onDone={(k) => commit(a.id, list.length, k)} onCancel={() => setRecording(null)} />}
              {list.length < 3 && !(recording?.action === a.id) && (
                <Button small variant="ghost" onClick={() => setRecording({ action: a.id, index: list.length })}>
                  {t('shortcuts.add')}
                </Button>
              )}
            </div>
          </Row>
        );
      })}
      {suggest && (
        <div className="flex items-center justify-between gap-3 bg-blue-500/[0.06] px-4 py-2.5 text-[12.5px]">
          <span>{t('shortcuts.suggestLock', { keys: bindingLabel(suggest.keys, locale) })}</span>
          <span className="flex gap-1.5">
            <Button small variant="primary" onClick={applySuggest}>
              {t('shortcuts.suggestLockApply')}
            </Button>
            <Button small variant="ghost" onClick={() => setSuggest(null)}>
              {t('shortcuts.suggestLockKeep')}
            </Button>
          </span>
        </div>
      )}
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-[12px] text-amber-600 dark:text-amber-400">{message && t(message.key, message.action ? { action: t(message.action) } : undefined)}</span>
        <Button small variant="ghost" onClick={() => update(DEFAULT_HOTKEYS)}>
          {t('shortcuts.restoreDefaults')}
        </Button>
      </div>
    </>
  );
}
