import { useEffect, useRef, useState } from 'react';
import type { Binding, HotkeyAction } from '../../shared/protocol';
import { DEFAULT_HOTKEYS, type Settings } from '../../shared/settings';
import { bindingLabel, isRiskyBinding, keyLabel, sortKeys } from '../common/keys';
import { Button, Row } from '../common/ui';

export function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {sortKeys(keys).map((k) => (
        <kbd key={k} className="key">
          {keyLabel(k)}
        </kbd>
      ))}
    </span>
  );
}

const ACTIONS: { id: HotkeyAction; label: string; hint: string }[] = [
  { id: 'activate', label: '話す（押している間）', hint: '押している間だけ録音します。2 回続けて押すとハンズフリーになります。' },
  { id: 'lock', label: 'ハンズフリー', hint: '押すと録音を始め、もう一度押すと確定します。' },
  { id: 'cancel', label: '取り消す', hint: '録音中と処理中だけ有効です。' },
  { id: 'paste_last', label: '直前の書き起こしを貼り付け', hint: '入力できなかったときに使います。' },
];

function sameBinding(a: Binding, b: Binding): boolean {
  return a.length === b.length && sortKeys(a).join('+') === sortKeys(b).join('+');
}

/** キー割り当ての変更（HK-8）。押したキーの組み合わせをヘルパーから受け取って記録する */
function Recorder({ onDone, onCancel }: { onDone: (keys: string[]) => void; onCancel: () => void }) {
  const [keys, setKeys] = useState<string[]>([]);
  const done = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    void window.longhand.recordShortcut(true);
    // 5 秒で自動解除されるので、記録中は送り直す
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
        {keys.length ? <Keys keys={keys} /> : 'キーを押してください…'}
      </span>
      <Button small variant="ghost" onClick={onCancel}>
        やめる
      </Button>
    </span>
  );
}

export function ShortcutSettings({ settings, update }: { settings: Settings; update: (hotkeys: Settings['hotkeys']) => void }) {
  const [recording, setRecording] = useState<{ action: HotkeyAction; index: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** 起動キーを変えたときに、ハンズフリーのキーも合わせるかの提案（S2） */
  const [suggest, setSuggest] = useState<{ index: number; keys: string[] } | null>(null);

  const commit = (action: HotkeyAction, index: number, keys: string[]) => {
    setRecording(null);
    if (keys.length > 5) {
      setMessage('1 つのショートカットは 5 キーまでです');
      return;
    }
    for (const a of ACTIONS) {
      const list = settings.hotkeys[a.id];
      if (list.some((b, i) => sameBinding(b, keys) && !(a.id === action && i === index))) {
        setMessage(`その組み合わせは「${a.label}」で使っています`);
        return;
      }
    }
    setMessage(isRiskyBinding(keys) ? '修飾キーを含まない組み合わせは、普段の入力とぶつかる可能性があります' : null);
    const list = [...settings.hotkeys[action]];
    const old = list[index];
    list[index] = keys;
    update({ ...settings.hotkeys, [action]: list });
    // ハンズフリーが「元の起動キー＋Space」のままなら、新しい起動キーに合わせるか尋ねる
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
    // update は呼んだ時点の settings を元にするので、起動キーの変更を含む最新の割り当てに重ねる
    update({ ...settings.hotkeys, lock });
    setSuggest(null);
  };

  return (
    <>
      {ACTIONS.map((a) => {
        const list = settings.hotkeys[a.id];
        return (
          <Row key={a.id} label={a.label} hint={a.hint}>
            <div className="flex flex-col items-end gap-1.5">
              {list.map((b, i) =>
                recording?.action === a.id && recording.index === i ? (
                  <Recorder key={i} onDone={(k) => commit(a.id, i, k)} onCancel={() => setRecording(null)} />
                ) : (
                  <span key={i} className="inline-flex items-center gap-1.5">
                    <Keys keys={b} />
                    <Button small variant="ghost" onClick={() => setRecording({ action: a.id, index: i })}>
                      変更
                    </Button>
                    <Button
                      small
                      variant="ghost"
                      // 起動キーと取り消しキーは、最後の 1 つを消せないようにする（S3）
                      disabled={list.length === 1 && (a.id === 'activate' || a.id === 'cancel')}
                      title={list.length === 1 && (a.id === 'activate' || a.id === 'cancel') ? '最後の 1 つは削除できません。変更してください' : '削除'}
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
                  ＋ 追加
                </Button>
              )}
            </div>
          </Row>
        );
      })}
      {suggest && (
        <div className="flex items-center justify-between gap-3 bg-blue-500/[0.06] px-4 py-2.5 text-[12.5px]">
          <span>ハンズフリーのキーも {bindingLabel(suggest.keys)} に変えますか？</span>
          <span className="flex gap-1.5">
            <Button small variant="primary" onClick={applySuggest}>
              変える
            </Button>
            <Button small variant="ghost" onClick={() => setSuggest(null)}>
              そのまま
            </Button>
          </span>
        </div>
      )}
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-[12px] text-amber-600 dark:text-amber-400">{message}</span>
        <Button small variant="ghost" onClick={() => update(DEFAULT_HOTKEYS)}>
          既定に戻す
        </Button>
      </div>
    </>
  );
}
