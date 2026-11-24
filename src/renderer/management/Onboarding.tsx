import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MessageKey } from '../../shared/i18n';
import type { Settings } from '../../shared/settings';
import type { AppSnapshot, DeepPartial } from '../../shared/types';
import { useT } from '../common/i18n';
import { bindingLabel } from '../common/keys';
import { Button, cx, inputClass, Select, StatusDot, Toggle } from '../common/ui';
import { AsrSettingsSection, LlmSettingsSection } from './Settings';
import { Keys } from './Shortcuts';

type Update = (patch: DeepPartial<Settings>) => Promise<void>;

const STEPS = ['welcome', 'microphone', 'accessibility', 'globe', 'keyTest', 'llm', 'asr', 'try'] as const;

const STEP_LABEL: Record<(typeof STEPS)[number], MessageKey> = {
  welcome: 'onboarding.step.welcome',
  microphone: 'onboarding.step.microphone',
  accessibility: 'onboarding.step.accessibility',
  globe: 'onboarding.step.globe',
  keyTest: 'onboarding.step.keyTest',
  llm: 'onboarding.step.llm',
  asr: 'onboarding.step.asr',
  try: 'onboarding.step.try',
};

/** Example of a spoken edit instruction. It stays Japanese in both languages because Longhand transcribes Japanese speech */
const EDIT_EXAMPLE = 'もっと丁寧に';

/** Puts elements (key caps, for example) into the `{name}` placeholders of a translated message */
function fill(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{nodes[part] ?? `{${part}}`}</Fragment> : part));
}

function Step({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <h1 className="mb-3 text-[24px] font-semibold tracking-tight">{title}</h1>
      <div className="flex-1 overflow-y-auto pb-4 text-[14px] leading-relaxed text-neutral-700 dark:text-neutral-300">{children}</div>
      <div className="flex justify-end gap-2 border-t border-black/[0.06] pt-4 dark:border-white/10">{footer}</div>
    </div>
  );
}

function Status({ ok, okText, ngText }: { ok: boolean; okText: string; ngText: string }) {
  return (
    <div role="status" className={cx('my-4 flex items-center gap-2 rounded-lg px-3 py-2.5 text-[13px]', ok ? 'bg-emerald-500/10' : 'bg-amber-500/10')}>
      <StatusDot ok={ok} warn={!ok} />
      {ok ? okText : ngText}
    </div>
  );
}

/** RMS at which sound counts as coming in */
const HEARD_RMS = 0.003;
/** Warn when no sound arrives for this long */
const SILENT_WARN_MS = 4000;

/**
 * Microphone check (O1). The user picks a microphone and checks on the level meter that sound comes in.
 * Records a few seconds at a time, repeatedly, to drive the meter (the recordings are not saved).
 */
function MicCheck({ snap, update, onHeard }: { snap: AppSnapshot; update: Update; onHeard: (heard: boolean) => void }) {
  const t = useT();
  const [mics, setMics] = useState<Awaited<ReturnType<typeof window.longhand.listMicrophones>>>([]);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const [silent, setSilent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const micId = snap.settings.microphoneId ?? '';
  const heardRef = useRef(false);

  useEffect(() => void window.longhand.listMicrophones().then(setMics), []);
  useEffect(
    () =>
      window.longhand.onMicLevel((rms) => {
        setLevel(rms);
        if (rms >= HEARD_RMS && !heardRef.current) {
          heardRef.current = true;
          setHeard(true);
          setSilent(false);
          onHeard(true);
        }
      }),
    [onHeard],
  );

  // Check again when the microphone changes
  useEffect(() => {
    let stop = false;
    heardRef.current = false;
    setHeard(false);
    setSilent(false);
    setError(null);
    onHeard(false);
    const warn = setTimeout(() => !heardRef.current && setSilent(true), SILENT_WARN_MS);
    void (async () => {
      for (let i = 0; i < 20 && !stop; i++) {
        const r = await window.longhand.testMicrophone(3);
        if (!r.ok) {
          setError(r.error ?? t('onboarding.mic.openFailed'));
          break;
        }
      }
      setLevel(0);
    })();
    return () => {
      stop = true;
      clearTimeout(warn);
    };
  }, [micId, onHeard]);

  const real = mics.filter((m) => !m.isVirtual);
  const dots = 12;
  const lit = Math.round(Math.min(1, Math.sqrt(level) * 5) * dots);
  return (
    <div className="my-4 flex flex-col gap-3 rounded-lg bg-black/[0.03] px-4 py-3 dark:bg-white/[0.04]">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px]">{t('onboarding.mic.device')}</span>
        <Select
          value={micId}
          options={[
            { value: '', label: t('onboarding.mic.systemDefault') },
            ...real.map((m) => ({ value: m.id, label: m.transport === 'bluetooth' ? t('onboarding.mic.bluetooth', { name: m.name }) : m.name })),
          ]}
          onChange={(v) => void update({ microphoneId: v || null })}
        />
      </div>
      <div className="flex items-center gap-3">
        <span className="flex gap-1" aria-label={t(heard ? 'onboarding.mic.hearing' : 'onboarding.mic.waiting')}>
          {Array.from({ length: dots }, (_, i) => (
            <span key={i} className={cx('h-2.5 w-2.5 rounded-full transition-colors', i < lit ? (i >= dots - 2 ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-black/10 dark:bg-white/15')} />
          ))}
        </span>
        <span className="text-[12.5px] text-neutral-500">{error ? t('onboarding.mic.checkFailed', { error }) : heard ? t('onboarding.mic.hearing') : silent ? '' : t('onboarding.mic.speak')}</span>
      </div>
      {silent && !heard && !error && (
        <div role="alert" className="text-[12.5px] text-amber-700 dark:text-amber-300">
          {t('onboarding.mic.silent')}
        </div>
      )}
      <div className="text-[12px] text-neutral-500">{t('onboarding.mic.closeMicTip')}</div>
    </div>
  );
}

function KeyTest({ activeKeys, lockLabel, onDetected }: { activeKeys: string[]; lockLabel: string; onDetected: () => void }) {
  const t = useT();
  const [held, setHeld] = useState(false);
  const [seen, setSeen] = useState(false);
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    void window.longhand.hotkeyTest(true);
    const off = window.longhand.onHotkeyTest((e) => {
      if (e.action === 'activate') {
        setHeld(e.phase === 'down');
        if (e.phase === 'down') {
          setSeen(true);
          onDetected();
        }
      }
      if (e.action === 'lock' && e.phase === 'down') setLocked(true);
    });
    return () => {
      off();
      void window.longhand.hotkeyTest(false);
    };
  }, [onDetected]);
  return (
    <div className="my-4 flex flex-col gap-3">
      <div
        className={cx(
          'flex h-24 items-center justify-center rounded-xl text-[15px] font-medium transition-colors',
          held ? 'bg-blue-500 text-white' : seen ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-black/[0.05] text-neutral-500 dark:bg-white/[0.06]',
        )}
      >
        {held ? (
          t('onboarding.keyTest.held')
        ) : seen ? (
          t('onboarding.keyTest.seen')
        ) : (
          <span className="inline-flex items-center gap-2">{fill(t('onboarding.keyTest.press'), { keys: <Keys keys={activeKeys} /> })}</span>
        )}
      </div>
      {lockLabel && <div className="text-[12.5px] text-neutral-500">{locked ? t('onboarding.keyTest.lockSeen') : t('onboarding.keyTest.lockHint', { lock: lockLabel })}</div>}
    </div>
  );
}

/** Practice input (O4). Shows success when text arrives in the field, then asks the user to try hands-free */
function TryIt({ snap, activate, paste }: { snap: AppSnapshot; activate: string; paste: string }) {
  const t = useT();
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const ready = snap.status.asr === 'ready';
  const ok1 = first.trim().length > 0;
  const ok2 = second.trim().length > 0;
  return (
    <>
      {!ready && <Status ok={false} okText="" ngText={snap.status.asrMessage ? t('onboarding.try.preparingDetail', { detail: snap.status.asrMessage }) : t('onboarding.try.preparing')} />}
      <p>{fill(t('onboarding.try.step1'), { activate: <kbd className="key">{activate}</kbd> })}</p>
      <textarea
        aria-label={t('onboarding.try.field1')}
        disabled={!ready}
        value={first}
        onChange={(e) => setFirst(e.target.value)}
        className={cx(inputClass, 'mt-3 min-h-[90px] text-[14px] leading-relaxed disabled:opacity-50')}
        placeholder={ready ? t('onboarding.try.placeholder') : t('onboarding.try.placeholderPreparing')}
      />
      {ok1 && (
        <div role="status" className="mt-2 text-[13px] text-emerald-700 dark:text-emerald-300">
          {t('onboarding.try.ok1')}
        </div>
      )}
      <p className={cx('mt-5', !ok1 && 'opacity-50')}>{fill(t('onboarding.try.step2'), { activate: <kbd className="key">{activate}</kbd> })}</p>
      <textarea
        aria-label={t('onboarding.try.field2')}
        disabled={!ready || !ok1}
        value={second}
        onChange={(e) => setSecond(e.target.value)}
        className={cx(inputClass, 'mt-3 min-h-[70px] text-[14px] leading-relaxed disabled:opacity-50')}
        placeholder={ok1 ? t('onboarding.try.placeholder') : ''}
      />
      {ok2 && (
        <div role="status" className="mt-2 text-[13px] text-emerald-700 dark:text-emerald-300">
          {t('onboarding.try.ok2')}
        </div>
      )}
      <ul className="mt-5 list-disc space-y-1 pl-5 text-[13px] text-neutral-600 dark:text-neutral-400">
        <li>{t('onboarding.try.cancelTip', { cancel: bindingLabel(snap.settings.hotkeys.cancel[0], snap.locale) || 'esc' })}</li>
        <li>{t('onboarding.try.editTip', { example: EDIT_EXAMPLE })}</li>
        <li>{paste ? t('onboarding.try.pasteTip', { paste }) : t('onboarding.try.pasteTipMenu')}</li>
      </ul>
    </>
  );
}

export function Onboarding({ snap, update, onDone }: { snap: AppSnapshot; update: Update; onDone: () => void }) {
  const t = useT();
  const [i, setI] = useState(0);
  const [heard, setHeard] = useState(false);
  const [keySeen, setKeySeen] = useState(false);
  // Open at login (S1). On by default on the last screen, and applied when setup is completed
  const [launch, setLaunch] = useState(true);
  const p = snap.permissions;
  const hk = snap.settings.hotkeys;
  const activate = bindingLabel(hk.activate[0], snap.locale) || 'fn';
  const lockLabel = bindingLabel(hk.lock[0], snap.locale);
  const paste = bindingLabel(hk.paste_last[0], snap.locale);
  const next = () => setI((x) => Math.min(STEPS.length - 1, x + 1));
  const back = () => setI((x) => Math.max(0, x - 1));
  const finish = async () => {
    await update({ launchAtLogin: launch });
    await window.longhand.completeOnboarding();
    onDone();
  };
  const onHeard = useRef((h: boolean) => setHeard(h)).current;
  const onKeySeen = useRef(() => setKeySeen(true)).current;

  // On the permission screens, refresh the state when the user comes back from System Settings
  useEffect(() => {
    if (STEPS[i] !== 'accessibility' && STEPS[i] !== 'microphone') return;
    const t = setInterval(() => void window.longhand.refreshPermissions(), 1500);
    return () => clearInterval(t);
  }, [i]);

  // On entering the microphone step, show the system prompt if the user has not been asked yet
  useEffect(() => {
    if (STEPS[i] === 'microphone' && p.microphone === 'undetermined') void window.longhand.requestPermission('microphone');
  }, [i]);

  // When accessibility is allowed, wait a moment and move on (O2. main brings the window back to the front)
  const prevAx = useRef(p.accessibility);
  useEffect(() => {
    const was = prevAx.current;
    prevAx.current = p.accessibility;
    if (STEPS[i] !== 'accessibility' || was || !p.accessibility) return;
    const t = setTimeout(next, 1200);
    return () => clearTimeout(t);
  }, [p.accessibility, i]);

  const backBtn = i > 0 && (
    <Button variant="ghost" onClick={back}>
      {t('onboarding.back')}
    </Button>
  );

  let body: ReactNode;
  switch (STEPS[i]) {
    case 'welcome':
      body = (
        <Step
          title={t('onboarding.welcome.title')}
          footer={
            <Button variant="primary" onClick={next}>
              {t('onboarding.start')}
            </Button>
          }
        >
          <p>{t('onboarding.welcome.intro', { activate })}</p>
          <ul className="mt-4 list-disc space-y-1.5 pl-5">
            <li>{t('onboarding.welcome.local')}</li>
            <li>{t('onboarding.welcome.llm')}</li>
            <li>{t('onboarding.welcome.edit')}</li>
          </ul>
          <p className="mt-4">{t('onboarding.welcome.setup')}</p>
        </Step>
      );
      break;
    case 'microphone':
      body = (
        <Step
          title={t('onboarding.mic.title')}
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {t(p.microphone === 'granted' && heard ? 'onboarding.next' : 'onboarding.later')}
              </Button>
            </>
          }
        >
          <p>{t('onboarding.mic.body')}</p>
          <Status ok={p.microphone === 'granted'} okText={t('onboarding.mic.allowed')} ngText={t('onboarding.notAllowed')} />
          {p.microphone !== 'granted' ? (
            <Button variant="primary" onClick={() => void (p.microphone === 'undetermined' ? window.longhand.requestPermission('microphone') : window.longhand.openExternal('microphone'))}>
              {t(p.microphone === 'undetermined' ? 'onboarding.allow' : 'common.openSystemSettings')}
            </Button>
          ) : snap.status.helper === 'running' ? (
            <MicCheck snap={snap} update={update} onHeard={onHeard} />
          ) : (
            <Status ok={false} okText="" ngText={t('onboarding.mic.needsHelper')} />
          )}
        </Step>
      );
      break;
    case 'accessibility':
      body = (
        <Step
          title={t('onboarding.accessibility.title')}
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {t(p.accessibility ? 'onboarding.next' : 'onboarding.later')}
              </Button>
            </>
          }
        >
          <p>{t('onboarding.accessibility.body', { activate })}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px]">
            <li>{t('onboarding.accessibility.step1')}</li>
            <li>{t('onboarding.accessibility.step2')}</li>
            <li>{t('onboarding.accessibility.step3')}</li>
          </ol>
          <Status ok={p.accessibility} okText={t('onboarding.accessibility.allowed')} ngText={t('onboarding.notAllowed')} />
          {!p.accessibility && (
            <Button variant="primary" onClick={() => void window.longhand.requestPermission('accessibility').then(() => window.longhand.openExternal('accessibility'))}>
              {t('common.openSystemSettings')}
            </Button>
          )}
        </Step>
      );
      break;
    case 'globe':
      body = (
        <Step
          title={t('onboarding.globe.title')}
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {t('onboarding.next')}
              </Button>
            </>
          }
        >
          <p>{t('onboarding.globe.body')}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px]">
            <li>{t('onboarding.globe.step1')}</li>
            <li>{t('onboarding.globe.step2')}</li>
          </ol>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => void window.longhand.openExternal('keyboard')}>{t('onboarding.globe.openKeyboard')}</Button>
          </div>
          <div className="mt-5 flex items-start justify-between gap-6 rounded-lg bg-black/[0.03] px-4 py-3 dark:bg-white/[0.04]">
            <div className="text-[13px]">
              <div>{t('onboarding.globe.auto')}</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">{t('onboarding.globe.autoHint')}</div>
            </div>
            <Toggle label={t('onboarding.globe.autoLabel')} checked={snap.settings.suppressGlobe} onChange={(v) => void update({ suppressGlobe: v })} />
          </div>
        </Step>
      );
      break;
    case 'keyTest':
      body = (
        <Step
          title={t('onboarding.keyTest.title')}
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {t(keySeen ? 'onboarding.next' : 'onboarding.later')}
              </Button>
            </>
          }
        >
          <p>{t('onboarding.keyTest.body')}</p>
          {snap.status.helper === 'running' && p.accessibility ? (
            <KeyTest activeKeys={hk.activate[0] ?? ['Fn']} lockLabel={lockLabel} onDetected={onKeySeen} />
          ) : (
            <Status ok={false} okText="" ngText={t('onboarding.keyTest.unavailable')} />
          )}
          <p className="text-[12.5px] text-neutral-500">{t('onboarding.keyTest.externalKeyboard')}</p>
        </Step>
      );
      break;
    case 'llm':
      body = (
        <Step
          title={t('onboarding.llm.title')}
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {t(snap.status.llmConfigured ? 'onboarding.next' : 'onboarding.setUpLater')}
              </Button>
            </>
          }
        >
          <p className="mb-4">{t('onboarding.llm.body')}</p>
          <LlmSettingsSection snap={snap} update={update} compact />
        </Step>
      );
      break;
    case 'asr':
      body = (
        <Step
          title={t('onboarding.asr.title')}
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {t('onboarding.next')}
              </Button>
            </>
          }
        >
          <p className="mb-4">{t('onboarding.asr.body')}</p>
          <AsrSettingsSection snap={snap} update={update} />
        </Step>
      );
      break;
    case 'try': {
      // Point out skipped steps before finishing
      const skipped = [
        p.microphone !== 'granted' && t('onboarding.skipped.microphone'),
        !p.accessibility && t('onboarding.skipped.accessibility'),
        !snap.status.llmConfigured && t('onboarding.skipped.llm'),
        snap.status.asr !== 'ready' && snap.status.asr !== 'loading' && snap.status.asr !== 'starting' && t('onboarding.skipped.asr'),
      ].filter(Boolean) as string[];
      body = (
        <Step
          title={t('onboarding.try.title')}
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={finish}>
                {t('onboarding.done')}
              </Button>
            </>
          }
        >
          <TryIt snap={snap} activate={activate} paste={paste} />
          <div className="mt-6 flex items-center justify-between gap-6 rounded-lg bg-black/[0.03] px-4 py-3 dark:bg-white/[0.04]">
            <div className="text-[13px]">
              <div>{t('onboarding.try.launchAtLogin')}</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">{t('onboarding.try.launchHint', { activate })}</div>
            </div>
            <Toggle label={t('onboarding.try.launchAtLogin')} checked={launch} onChange={setLaunch} />
          </div>
          {skipped.length > 0 && (
            <div className="mt-4 rounded-lg bg-amber-500/10 px-4 py-3 text-[12.5px]">
              <div className="font-medium">{t('onboarding.try.unfinished')}</div>
              <ul className="mt-1 list-disc pl-5">
                {skipped.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <div className="mt-1 text-neutral-600 dark:text-neutral-400">{t('onboarding.try.unfinishedHint')}</div>
            </div>
          )}
        </Step>
      );
      break;
    }
  }

  return (
    <div className="flex h-screen">
      <aside className="drag w-[200px] shrink-0 px-5 pt-14">
        <ol className="flex flex-col gap-1">
          {STEPS.map((s, j) => (
            <li key={s} className={cx('no-drag flex items-center gap-2 rounded-md px-2 py-1 text-[13px]', j === i ? 'font-medium' : 'text-neutral-500')}>
              <span
                className={cx(
                  'grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px]',
                  j < i ? 'bg-emerald-500 text-white' : j === i ? 'bg-blue-500 text-white' : 'bg-black/[0.07] dark:bg-white/10',
                )}
              >
                {j < i ? '✓' : j + 1}
              </span>
              <button className="text-left" onClick={() => setI(j)} aria-current={j === i ? 'step' : undefined}>
                {t(STEP_LABEL[s])}
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <main className="flex-1 bg-[#f6f6f7] px-10 pb-8 pt-12 dark:bg-[#1c1c1e]">
        <div className="mx-auto h-full max-w-[640px]">{body}</div>
      </main>
    </div>
  );
}
