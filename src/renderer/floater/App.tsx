import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { bindingLabel } from '../../shared/keys';
import type { AppSnapshot, FloaterState, HudMessage } from '../../shared/types';
import { createMouseRouter } from './mouseRouting';
import { playSound } from './sounds';

const BARS = 16;

/**
 * マウスの操作を受け取るか、下のアプリに通すかを決める（mouseRouting.ts）。
 * 操作できる要素（バーと通知）には pointer-events-auto を付けてある。透明な部分は pointer-events-none なので、
 * elementFromPoint は操作できる要素の上でだけ、その要素を返す
 */
const mouseRouter = createMouseRouter({
  isInteractiveAt: (x, y) => !!document.elementFromPoint(x, y)?.closest('.pointer-events-auto'),
  send: (interactive) => window.longhand.setMouseInteractive(interactive),
});

/** ウィンドウ全体でポインタを追い、画面の中身が変わったときと一定の間隔で、いまの位置を調べ直す */
function useMouseRouting(): void {
  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => mouseRouter.move(e.clientX, e.clientY);
    const leave = () => mouseRouter.leave();
    window.addEventListener('mousemove', move, { passive: true });
    document.documentElement.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);
    // 通知が消えた、バーが切り替わった、というときは、ポインタが動かなくても調べ直す
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => mouseRouter.recheck());
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    const timer = setInterval(() => mouseRouter.recheck(), 300);
    // 読み込み直した直後は、必ず通す状態から始める
    window.longhand.setMouseInteractive(false);
    return () => {
      window.removeEventListener('mousemove', move);
      document.documentElement.removeEventListener('mouseleave', leave);
      window.removeEventListener('blur', leave);
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearInterval(timer);
      window.longhand.setMouseInteractive(false);
    };
  }, []);
}

/** 要素にポインタが出入りしたときにも、すぐ調べ直す（見た目の切り替えと同時に、操作を受け取れるように） */
function useInteractive() {
  return {
    onMouseEnter: (e: MouseEvent) => mouseRouter.move(e.clientX, e.clientY),
    onMouseLeave: (e: MouseEvent) => mouseRouter.move(e.clientX, e.clientY),
  };
}

/**
 * 音量を 0〜1 にする（F2）。
 * 直近 5 秒の静かな部分（250ms ごとの最小値の最小）を雑音の床とし、そこから 6dB 上を 0、さらに 36dB 上を 1 にする。
 * 空調やファンのような一定の雑音では棒が動かず、声が入ったときだけ伸びる。
 */
function useLevelNormalizer() {
  const st = useRef({ buckets: [] as number[], cur: Infinity, curStart: 0 });
  return {
    reset: () => {
      st.current = { buckets: [], cur: Infinity, curStart: 0 };
    },
    norm: (rms: number): number => {
      const f = st.current;
      const now = performance.now();
      if (now - f.curStart > 250) {
        if (f.cur < Infinity) f.buckets.push(f.cur);
        if (f.buckets.length > 20) f.buckets.shift();
        f.cur = Infinity;
        f.curStart = now;
      }
      f.cur = Math.min(f.cur, rms);
      const floor = Math.min(f.cur, ...f.buckets);
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const floorDb = 20 * Math.log10(Math.max(floor, 1e-6));
      return Math.min(1, Math.max(0, (db - floorDb - 6) / 36));
    },
  };
}

function Waveform({ levels, accent, dim }: { levels: number[]; accent: string; dim: boolean }) {
  return (
    <div className={'flex h-6 items-center gap-[2px] transition-opacity duration-300 ' + (dim ? 'opacity-30' : 'opacity-100')}>
      {levels.map((v, i) => (
        <span key={i} className="w-[3px] rounded-full transition-[height] duration-75" style={{ height: 2 + 20 * v ** 1.3, background: accent }} />
      ))}
    </div>
  );
}

function Elapsed({ since }: { since: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return (
    <span className="w-8 text-right font-mono text-[11px] tabular-nums text-white/60">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </span>
  );
}

function IconButton({ title, onClick, children, tone }: { title: string; onClick: () => void; children: ReactNode; tone: 'neutral' | 'primary' }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={
        'grid h-7 w-7 place-items-center rounded-full transition-colors ' + (tone === 'primary' ? 'bg-white text-neutral-900 hover:bg-white/85' : 'bg-white/10 text-white/80 hover:bg-white/20')
      }
    >
      {children}
    </button>
  );
}

const STAGE_LABEL: Record<NonNullable<FloaterState['stage']>, string> = {
  transcribing: '書き起こし中',
  formatting: '整形中',
  pasting: '入力中',
};

interface BarInfo {
  /** 起動キーの表示（例: fn） */
  activate: string;
  asr: AppSnapshot['status']['asr'];
}

function Bar({ state, levels, info, unclear }: { state: FloaterState; levels: number[]; info: BarInfo; unclear: boolean }) {
  const hover = useInteractive();
  const [hovered, setHovered] = useState(false);
  const edit = state.mode === 'edit';
  const accent = edit ? '#c4b5fd' : '#ffffff';
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    window.longhand.floaterAction('menu');
  };

  if (state.phase === 'idle') {
    // 編集の指示が分からなかったときは、通知ではなくバーの中で短く知らせる（F6）
    if (unclear) {
      return (
        <div className="pill shake flex h-9 items-center px-4" {...hover} onContextMenu={menu}>
          <span className="text-[12px] font-medium text-rose-300">言い直してください</span>
        </div>
      );
    }
    if (!state.visible) return null;
    // 貼り付けの成功（F5）
    if (state.flash === 'pasted') {
      return (
        <div className="pill flash-in flex h-5 w-[120px] items-center justify-center" aria-label="入力しました">
          <svg width="12" height="12" viewBox="0 0 14 14" className="text-emerald-300">
            <path d="M2.5 7.5l3 3 6-7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      );
    }
    const preparing = info.asr === 'starting' || info.asr === 'loading';
    const broken = info.asr === 'failed' || info.asr === 'missing';
    const label = preparing ? '音声認識を準備しています…' : broken ? '音声認識が使えません。右クリックで設定を開けます' : `クリックで録音、${info.activate} を押しながら話す`;
    return (
      <div
        {...hover}
        onMouseEnter={(e) => {
          hover.onMouseEnter(e);
          setHovered(true);
        }}
        onMouseLeave={(e) => {
          hover.onMouseLeave(e);
          setHovered(false);
        }}
        onClick={() => window.longhand.floaterAction('start')}
        onContextMenu={menu}
        aria-label={label}
        className={
          'pill flex cursor-pointer items-center justify-center gap-2 overflow-hidden transition-all duration-200 ' +
          (hovered ? 'h-8 px-3.5' : 'h-[10px] w-14 ' + (preparing ? 'preparing' : 'opacity-70')) +
          (broken ? ' ring-1 ring-amber-400/70' : '')
        }
      >
        {hovered && preparing && <span className="spinner" />}
        {hovered && <span className="whitespace-nowrap text-[11px] text-white/80">{label}</span>}
      </div>
    );
  }

  if (state.phase === 'finalizing') {
    return (
      <div className="pill flex h-9 items-center gap-2 px-4" {...hover} onContextMenu={menu}>
        <span className="dots" style={{ color: accent }}>
          <i />
          <i />
          <i />
        </span>
        <span className="text-[12px] text-white/75">{edit ? '書き換え中' : STAGE_LABEL[state.stage ?? 'transcribing']}</span>
      </div>
    );
  }

  const locked = state.phase === 'locked';
  // マイクの音が届くまでは控えめに出す（F1）。届いたら赤い点と波形を出す
  const ready = state.micReady !== false;
  return (
    <div className="flex flex-col items-center gap-1.5">
      {edit && <div className="rounded-full bg-violet-500/90 px-2.5 py-0.5 text-[11px] font-medium text-white shadow">編集モード · {state.selectionChars.toLocaleString()} 文字を選択中</div>}
      <div className={'pill flex h-9 items-center gap-2 ' + (locked ? 'pl-1 pr-1' : 'px-3.5')} {...hover} onContextMenu={menu} aria-label={ready ? '録音中' : 'マイクを準備しています'}>
        {locked && (
          <IconButton title="取り消す" tone="neutral" onClick={() => window.longhand.floaterAction('cancel')}>
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </IconButton>
        )}
        <span className={ready ? 'rec-dot' : 'rec-dot-wait'} />
        <Waveform levels={levels} accent={accent} dim={!ready} />
        {locked && <Elapsed since={state.startedAt} />}
        {locked && (
          <IconButton title="確定して入力" tone="primary" onClick={() => window.longhand.floaterAction('finish')}>
            <svg width="13" height="13" viewBox="0 0 14 14">
              <path d="M2.5 7.5l3 3 6-7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>
        )}
      </div>
    </div>
  );
}

const KIND_STYLE: Record<HudMessage['kind'], { icon: string; color: string }> = {
  info: { icon: 'i', color: 'bg-sky-500' },
  success: { icon: '✓', color: 'bg-emerald-500' },
  warning: { icon: '!', color: 'bg-amber-500' },
  error: { icon: '!', color: 'bg-rose-500' },
};

const PRIORITY: Record<HudMessage['kind'], number> = { error: 3, warning: 2, success: 1, info: 1 };

/**
 * 自動で閉じるタイマー。ホバー中は止め、離したら残り時間（最低 2 秒）から再開する
 */
function useAutoClose(ms: number, onClose: () => void) {
  const remaining = useRef(ms);
  const close = useRef(onClose);
  close.current = onClose;
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!ms || paused) return;
    const started = Date.now();
    const t = setTimeout(() => close.current(), remaining.current);
    return () => {
      clearTimeout(t);
      remaining.current = Math.max(2000, remaining.current - (Date.now() - started));
    };
  }, [ms, paused]);
  return { pause: () => setPaused(true), resume: () => setPaused(false) };
}

function runAction(m: HudMessage, actionId: string, onClose: () => void) {
  window.longhand.floaterAction('hud-action', `${m.id}:${actionId}`);
  onClose();
}

function Hud({ m, onClose }: { m: HudMessage; onClose: () => void }) {
  const hover = useInteractive();
  const timer = useAutoClose(m.durationMs, onClose);
  const [hovered, setHovered] = useState(false);
  const k = KIND_STYLE[m.kind];
  const handlers = {
    onMouseEnter: (e: MouseEvent) => {
      hover.onMouseEnter(e);
      timer.pause();
      setHovered(true);
    },
    onMouseLeave: (e: MouseEvent) => {
      hover.onMouseLeave(e);
      timer.resume();
      setHovered(false);
    },
  };
  const mute = () => {
    window.longhand.hudMute(m.key);
    onClose();
  };

  if (m.style === 'pill') {
    return (
      <div role="status" className="hud-pill pointer-events-auto flex h-8 max-w-full items-center gap-2 rounded-full pl-2.5 pr-1.5" {...handlers}>
        <span className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white ${k.color}`}>{k.icon}</span>
        <span className="min-w-0 truncate text-[12px] text-white" title={m.title}>
          {m.title}
        </span>
        {m.actions?.map((a) => (
          <button key={a.id} className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-[11px] text-white hover:bg-white/25" onClick={() => runAction(m, a.id, onClose)}>
            {a.label}
          </button>
        ))}
        {m.mutable && hovered && (
          <button className="shrink-0 px-1 text-[11px] text-white/45 hover:text-white/80" onClick={mute}>
            今後表示しない
          </button>
        )}
        {hovered && (
          <button aria-label="閉じる" className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[12px] text-white/50 hover:text-white/90" onClick={onClose}>
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div role={m.kind === 'error' ? 'alert' : 'status'} className="hud-card pointer-events-auto flex w-full gap-2.5 rounded-xl px-3 py-2.5" {...handlers}>
      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${k.color}`}>{k.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium leading-snug text-white">{m.title}</div>
        {m.body && <div className="mt-0.5 text-[11.5px] leading-snug text-white/65">{m.body}</div>}
        {(m.actions?.length || m.mutable) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {m.actions?.map((a) => (
              <button key={a.id} className="rounded-md bg-white/15 px-2 py-0.5 text-[11px] text-white hover:bg-white/25" onClick={() => runAction(m, a.id, onClose)}>
                {a.label}
              </button>
            ))}
            {m.mutable && (
              <button className="rounded-md px-2 py-0.5 text-[11px] text-white/45 hover:text-white/75" onClick={mute}>
                今後表示しない
              </button>
            )}
          </div>
        )}
      </div>
      <button aria-label="閉じる" className="h-4 w-4 shrink-0 text-[13px] leading-none text-white/40 hover:text-white/80" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

interface Queued {
  m: HudMessage;
  at: number;
}

/** 表示する 1 件を選ぶ（N1）。優先度の高いもの、同じなら新しいもの */
function pick(queue: Queued[]): Queued | undefined {
  let best: Queued | undefined;
  for (const q of queue) {
    if (!best || PRIORITY[q.m.kind] > PRIORITY[best.m.kind] || (PRIORITY[q.m.kind] === PRIORITY[best.m.kind] && q.at >= best.at)) best = q;
  }
  return best;
}

/** 表示されないまま期限を過ぎた通知を捨てる（消えない通知は残す） */
function prune(queue: Queued[], now: number): Queued[] {
  return queue.filter((q) => q.m.durationMs === 0 || now - q.at < q.m.durationMs);
}

export function App() {
  const [state, setState] = useState<FloaterState>({ phase: 'idle', mode: 'dictation', selectionChars: 0, startedAt: null, visible: true });
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [queue, setQueue] = useState<Queued[]>([]);
  const [unclear, setUnclear] = useState(false);
  const [info, setInfo] = useState<BarInfo>({ activate: 'fn', asr: 'ready' });
  const normalizer = useLevelNormalizer();
  const phase = useRef(state.phase);

  useEffect(() => {
    let unclearTimer: ReturnType<typeof setTimeout> | null = null;
    const applySnap = (s: AppSnapshot) => setInfo({ activate: bindingLabel(s.settings.hotkeys.activate[0]) || 'fn', asr: s.status.asr });
    void window.longhand.getSnapshot().then(applySnap);
    const offs = [
      window.longhand.onSnapshot(applySnap),
      window.longhand.onFloaterState((s) => {
        if ((s.phase === 'recording' || s.phase === 'locked') && phase.current !== 'recording' && phase.current !== 'locked') normalizer.reset();
        phase.current = s.phase;
        setState(s);
        if (s.phase === 'idle' || s.phase === 'finalizing') setLevels(Array(BARS).fill(0));
        if (s.phase !== 'idle') setUnclear(false);
      }),
      window.longhand.onLevel((rms) => setLevels((prev) => [...prev.slice(1), normalizer.norm(rms)])),
      window.longhand.onHud((m) => {
        if (m.key === 'EditUnclear') {
          setUnclear(true);
          if (unclearTimer) clearTimeout(unclearTimer);
          unclearTimer = setTimeout(() => setUnclear(false), m.durationMs || 3200);
          return;
        }
        const now = Date.now();
        // 同じ種類の通知は置き換える
        setQueue((prev) => [...prune(prev, now).filter((x) => x.m.key !== m.key), { m, at: now }].slice(-6));
      }),
      window.longhand.onHudDismiss((id) => setQueue((prev) => prev.filter((x) => x.m.id !== id))),
      window.longhand.onPlaySound(({ name, volume }) => playSound(name, volume)),
    ];
    return () => {
      offs.forEach((off) => off());
      if (unclearTimer) clearTimeout(unclearTimer);
    };
  }, []);

  useMouseRouting();
  const current = pick(queue);
  const close = (id: string) =>
    setQueue((prev) =>
      prune(
        prev.filter((x) => x.m.id !== id),
        Date.now(),
      ),
    );

  return (
    <div className="pointer-events-none flex h-screen w-screen flex-col items-center justify-end gap-2 px-3 pb-2">
      <div className={'flex w-full flex-col items-center ' + (current?.m.style === 'pill' ? 'max-w-[376px]' : 'max-w-[340px]')}>
        {current && <Hud key={current.m.id} m={current.m} onClose={() => close(current.m.id)} />}
      </div>
      <div className="pointer-events-auto">
        <Bar state={state} levels={levels} info={info} unclear={unclear} />
      </div>
    </div>
  );
}
