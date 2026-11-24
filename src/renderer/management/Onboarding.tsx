import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Settings } from '../../shared/settings';
import type { AppSnapshot, DeepPartial } from '../../shared/types';
import { bindingLabel } from '../common/keys';
import { Button, cx, inputClass, Select, StatusDot, Toggle } from '../common/ui';
import { AsrSettingsSection, LlmSettingsSection } from './Settings';
import { Keys } from './Shortcuts';

type Update = (patch: DeepPartial<Settings>) => Promise<void>;

const STEPS = ['ようこそ', 'マイク', 'アクセシビリティ', '地球儀キー', 'キーのテスト', 'LLM', '音声認識', '試す'] as const;

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

/** 「音が入った」とみなす RMS */
const HEARD_RMS = 0.003;
/** これだけ音が来なければ警告する */
const SILENT_WARN_MS = 4000;

/**
 * マイクの確認（O1）。マイクを選び、レベルメーターで音が入るのを確かめる。
 * 数秒ずつ録音を繰り返してメーターを動かす（録音は保存しない）。
 */
function MicCheck({ snap, update, onHeard }: { snap: AppSnapshot; update: Update; onHeard: (heard: boolean) => void }) {
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

  // マイクを変えたら確かめ直す
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
          setError(r.error ?? 'マイクを開けませんでした');
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
        <span className="text-[13px]">使うマイク</span>
        <Select
          value={micId}
          options={[{ value: '', label: 'システムの既定' }, ...real.map((m) => ({ value: m.id, label: m.name + (m.transport === 'bluetooth' ? '（Bluetooth）' : '') }))]}
          onChange={(v) => void update({ microphoneId: v || null })}
        />
      </div>
      <div className="flex items-center gap-3">
        <span className="flex gap-1" aria-label={heard ? '音が入っています' : '音を待っています'}>
          {Array.from({ length: dots }, (_, i) => (
            <span key={i} className={cx('h-2.5 w-2.5 rounded-full transition-colors', i < lit ? (i >= dots - 2 ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-black/10 dark:bg-white/15')} />
          ))}
        </span>
        <span className="text-[12.5px] text-neutral-500">{error ? `確かめられませんでした: ${error}` : heard ? '音が入っています' : silent ? '' : '何か話してみてください'}</span>
      </div>
      {silent && !heard && !error && (
        <div role="alert" className="text-[12.5px] text-amber-700 dark:text-amber-300">
          音が入っていません。マイクのミュートを外すか、別のマイクを選んでください。
        </div>
      )}
      <div className="text-[12px] text-neutral-500">ヘッドセットなど口元に近いマイクほど、認識の精度が上がります。</div>
    </div>
  );
}

function KeyTest({ activeKeys, lockLabel, onDetected }: { activeKeys: string[]; lockLabel: string; onDetected: () => void }) {
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
          '検出しています（離すと録音が確定します）'
        ) : seen ? (
          '✓ 検出できました'
        ) : (
          <span className="inline-flex items-center gap-2">
            <Keys keys={activeKeys} /> を押してみてください
          </span>
        )}
      </div>
      {lockLabel && <div className="text-[12.5px] text-neutral-500">{locked ? '✓ ハンズフリーのショートカットも検出しました' : `${lockLabel}（ハンズフリー）も試せます。`}</div>}
    </div>
  );
}

/** 試し入力（O4）。入力欄に文字が入ったら成功を出し、次にハンズフリーを試してもらう */
function TryIt({ snap, activate, paste }: { snap: AppSnapshot; activate: string; paste: string }) {
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const ready = snap.status.asr === 'ready';
  const ok1 = first.trim().length > 0;
  const ok2 = second.trim().length > 0;
  return (
    <>
      {!ready && <Status ok={false} okText="" ngText={`音声認識を準備しています。準備ができると試せます${snap.status.asrMessage ? `（${snap.status.asrMessage}）` : ''}`} />}
      <p>
        1. 下の欄をクリックしてから、<kbd className="key">{activate}</kbd> を押しながら話し、話し終えたら離してください。
      </p>
      <textarea
        aria-label="試し入力 1"
        disabled={!ready}
        value={first}
        onChange={(e) => setFirst(e.target.value)}
        className={cx(inputClass, 'mt-3 min-h-[90px] text-[14px] leading-relaxed disabled:opacity-50')}
        placeholder={ready ? 'ここに入力されます' : '準備中…'}
      />
      {ok1 && (
        <div role="status" className="mt-2 text-[13px] text-emerald-700 dark:text-emerald-300">
          ✓ 入力できました
        </div>
      )}
      <p className={cx('mt-5', !ok1 && 'opacity-50')}>
        2. 次はハンズフリーです。<kbd className="key">{activate}</kbd> を 2 回続けて押すと、キーを離しても録音が続きます。話し終えたら、もう一度押して確定します。
      </p>
      <textarea
        aria-label="試し入力 2"
        disabled={!ready || !ok1}
        value={second}
        onChange={(e) => setSecond(e.target.value)}
        className={cx(inputClass, 'mt-3 min-h-[70px] text-[14px] leading-relaxed disabled:opacity-50')}
        placeholder={ok1 ? 'ここに入力されます' : ''}
      />
      {ok2 && (
        <div role="status" className="mt-2 text-[13px] text-emerald-700 dark:text-emerald-300">
          ✓ ハンズフリーでも入力できました
        </div>
      )}
      <ul className="mt-5 list-disc space-y-1 pl-5 text-[13px] text-neutral-600 dark:text-neutral-400">
        <li>{bindingLabel(snap.settings.hotkeys.cancel[0]) || 'esc'} で取り消せます。</li>
        <li>文字を選択してから話すと、「もっと丁寧に」のように指示して書き換えられます。</li>
        <li>
          {paste ? `入力できなかったときは ${paste} で直前の書き起こしを貼り付けられます。` : '入力できなかったときは、フローティングバーを右クリックして「直前の書き起こしを貼り付け」を選べます。'}
        </li>
      </ul>
    </>
  );
}

export function Onboarding({ snap, update, onDone }: { snap: AppSnapshot; update: Update; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [heard, setHeard] = useState(false);
  const [keySeen, setKeySeen] = useState(false);
  // ログイン時に起動する（S1）。完了画面で既定オンにしておき、完了したときに反映する
  const [launch, setLaunch] = useState(true);
  const p = snap.permissions;
  const hk = snap.settings.hotkeys;
  const activate = bindingLabel(hk.activate[0]) || 'fn';
  const lockLabel = bindingLabel(hk.lock[0]);
  const paste = bindingLabel(hk.paste_last[0]);
  const next = () => setI((x) => Math.min(STEPS.length - 1, x + 1));
  const back = () => setI((x) => Math.max(0, x - 1));
  const finish = async () => {
    await update({ launchAtLogin: launch });
    await window.longhand.completeOnboarding();
    onDone();
  };
  const onHeard = useRef((h: boolean) => setHeard(h)).current;
  const onKeySeen = useRef(() => setKeySeen(true)).current;

  // 権限の画面では、システム設定から戻ってきたときに状態を更新する
  useEffect(() => {
    if (STEPS[i] !== 'アクセシビリティ' && STEPS[i] !== 'マイク') return;
    const t = setInterval(() => void window.longhand.refreshPermissions(), 1500);
    return () => clearInterval(t);
  }, [i]);

  // マイクの手順に入ったら、まだ聞いていなければ OS の確認を出す
  useEffect(() => {
    if (STEPS[i] === 'マイク' && p.microphone === 'undetermined') void window.longhand.requestPermission('microphone');
  }, [i]);

  // アクセシビリティが許可されたら、少し待って次へ進む（O2。画面を前に戻すのは main が行う）
  const prevAx = useRef(p.accessibility);
  useEffect(() => {
    const was = prevAx.current;
    prevAx.current = p.accessibility;
    if (STEPS[i] !== 'アクセシビリティ' || was || !p.accessibility) return;
    const t = setTimeout(next, 1200);
    return () => clearTimeout(t);
  }, [p.accessibility, i]);

  const backBtn = i > 0 && (
    <Button variant="ghost" onClick={back}>
      戻る
    </Button>
  );

  let body: ReactNode;
  switch (STEPS[i]) {
    case 'ようこそ':
      body = (
        <Step
          title="Longhand へようこそ"
          footer={
            <Button variant="primary" onClick={next}>
              はじめる
            </Button>
          }
        >
          <p>{activate} キーを押しながら話すと、話した内容が整った文章になって、カーソルの位置に入ります。</p>
          <ul className="mt-4 list-disc space-y-1.5 pl-5">
            <li>音声の書き起こしは、この Mac の中だけで行います。音声は外に送りません。</li>
            <li>文章の整形には、設定した LLM の API を使います。</li>
            <li>文字を選択してから話すと、選択した文章を声で書き換えられます。</li>
          </ul>
          <p className="mt-4">使い始める前に、いくつかの許可と設定を行います。</p>
        </Step>
      );
      break;
    case 'マイク':
      body = (
        <Step
          title="マイクを選ぶ"
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {p.microphone === 'granted' && heard ? '次へ' : 'あとで'}
              </Button>
            </>
          }
        >
          <p>話した声を録音するために、マイクを使います。録音はこの Mac の中で書き起こし、外には送りません。</p>
          <Status ok={p.microphone === 'granted'} okText="マイクの使用が許可されています" ngText="まだ許可されていません" />
          {p.microphone !== 'granted' ? (
            <Button variant="primary" onClick={() => void (p.microphone === 'undetermined' ? window.longhand.requestPermission('microphone') : window.longhand.openExternal('microphone'))}>
              {p.microphone === 'undetermined' ? '許可する' : 'システム設定を開く'}
            </Button>
          ) : snap.status.helper === 'running' ? (
            <MicCheck snap={snap} update={update} onHeard={onHeard} />
          ) : (
            <Status ok={false} okText="" ngText="ヘルパーが動いているときに、マイクの音を確かめられます" />
          )}
        </Step>
      );
      break;
    case 'アクセシビリティ':
      body = (
        <Step
          title="アクセシビリティを許可する"
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {p.accessibility ? '次へ' : 'あとで'}
              </Button>
            </>
          }
        >
          <p>{activate} キーの検出、書き起こした文章の入力、入力欄の文脈の読み取りに必要です。</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px]">
            <li>下のボタンでシステム設定を開きます。</li>
            <li>「プライバシーとセキュリティ」→「アクセシビリティ」で、Longhand（開発中は Electron）をオンにします。</li>
            <li>オンにすると、この画面に自動で戻って次へ進みます。</li>
          </ol>
          <Status ok={p.accessibility} okText="アクセシビリティが許可されています" ngText="まだ許可されていません" />
          {!p.accessibility && (
            <Button variant="primary" onClick={() => void window.longhand.requestPermission('accessibility').then(() => window.longhand.openExternal('accessibility'))}>
              システム設定を開く
            </Button>
          )}
        </Step>
      );
      break;
    case '地球儀キー':
      body = (
        <Step
          title="地球儀キーの設定"
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                次へ
              </Button>
            </>
          }
        >
          <p>fn（地球儀）キーを押すと、macOS が絵文字ピッカーや入力ソースの切り替えを開くことがあります。音声入力とぶつからないように止めておきます。</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px]">
            <li>システム設定 →「キーボード」を開きます。</li>
            <li>「🌐キーを押して」を「何もしない」にします。</li>
          </ol>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => void window.longhand.openExternal('keyboard')}>キーボードの設定を開く</Button>
          </div>
          <div className="mt-5 flex items-start justify-between gap-6 rounded-lg bg-black/[0.03] px-4 py-3 dark:bg-white/[0.04]">
            <div className="text-[13px]">
              <div>自動で止める（試験的）</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">Longhand の起動中だけ「何もしない」にし、終了時に戻します。macOS の更新で動かなくなる可能性があります。</div>
            </div>
            <Toggle label="地球儀キーを自動で止める" checked={snap.settings.suppressGlobe} onChange={(v) => void update({ suppressGlobe: v })} />
          </div>
        </Step>
      );
      break;
    case 'キーのテスト':
      body = (
        <Step
          title="キーのテスト"
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {keySeen ? '次へ' : 'あとで'}
              </Button>
            </>
          }
        >
          <p>話すキーを押して、検出されるか確かめます。ここでは録音しません。</p>
          {snap.status.helper === 'running' && p.accessibility ? (
            <KeyTest activeKeys={hk.activate[0] ?? ['Fn']} lockLabel={lockLabel} onDetected={onKeySeen} />
          ) : (
            <Status ok={false} okText="" ngText="アクセシビリティが許可され、ヘルパーが動いているときにテストできます" />
          )}
          <p className="text-[12.5px] text-neutral-500">fn キーのない外付けキーボードでは、設定 → キーボード で別のキー（例: 右⌥ や 左⌃+左⌥）を割り当ててください。</p>
        </Step>
      );
      break;
    case 'LLM':
      body = (
        <Step
          title="整形に使う LLM"
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                {snap.status.llmConfigured ? '次へ' : 'あとで設定する'}
              </Button>
            </>
          }
        >
          <p className="mb-4">書き起こした文章から言いよどみを除き、句読点を整えるために使います。設定しなくても、書き起こしをそのまま入力して使えます。</p>
          <LlmSettingsSection snap={snap} update={update} compact />
        </Step>
      );
      break;
    case '音声認識':
      body = (
        <Step
          title="音声認識の準備"
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={next}>
                次へ
              </Button>
            </>
          }
        >
          <p className="mb-4">書き起こしはこの Mac の中で行います。初回はモデルの読み込みに少し時間がかかります。</p>
          <AsrSettingsSection snap={snap} update={update} />
        </Step>
      );
      break;
    case '試す': {
      // 飛ばした手順を完了の前に知らせる
      const skipped = [
        p.microphone !== 'granted' && 'マイクの許可',
        !p.accessibility && 'アクセシビリティの許可',
        !snap.status.llmConfigured && 'LLM の設定（整形なしで入力します）',
        snap.status.asr !== 'ready' && snap.status.asr !== 'loading' && snap.status.asr !== 'starting' && '音声認識の準備',
      ].filter(Boolean) as string[];
      body = (
        <Step
          title="試してみましょう"
          footer={
            <>
              {backBtn}
              <Button variant="primary" onClick={finish}>
                完了
              </Button>
            </>
          }
        >
          <TryIt snap={snap} activate={activate} paste={paste} />
          <div className="mt-6 flex items-center justify-between gap-6 rounded-lg bg-black/[0.03] px-4 py-3 dark:bg-white/[0.04]">
            <div className="text-[13px]">
              <div>ログイン時に Longhand を起動する</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">Mac を起動したら、すぐに {activate} キーで話せるようにします。あとから設定の「一般」で変えられます。</div>
            </div>
            <Toggle label="ログイン時に Longhand を起動する" checked={launch} onChange={setLaunch} />
          </div>
          {skipped.length > 0 && (
            <div className="mt-4 rounded-lg bg-amber-500/10 px-4 py-3 text-[12.5px]">
              <div className="font-medium">まだ終わっていない設定があります</div>
              <ul className="mt-1 list-disc pl-5">
                {skipped.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <div className="mt-1 text-neutral-600 dark:text-neutral-400">左の手順から戻って設定できます。</div>
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
                  'grid h-5 w-5 place-items-center rounded-full text-[11px]',
                  j < i ? 'bg-emerald-500 text-white' : j === i ? 'bg-blue-500 text-white' : 'bg-black/[0.07] dark:bg-white/10',
                )}
              >
                {j < i ? '✓' : j + 1}
              </span>
              <button onClick={() => setI(j)} aria-current={j === i ? 'step' : undefined}>
                {s}
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
