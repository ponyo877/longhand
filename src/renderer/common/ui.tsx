import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppSnapshot, DeepPartial } from '../../shared/types';
import type { Settings } from '../../shared/settings';

export function useSnapshot(): [AppSnapshot | null, (patch: DeepPartial<Settings>) => Promise<void>] {
  const [snap, setSnap] = useState<AppSnapshot | null>(null);
  useEffect(() => {
    void window.longhand.getSnapshot().then(setSnap);
    return window.longhand.onSnapshot(setSnap);
  }, []);
  const update = async (patch: DeepPartial<Settings>) => {
    await window.longhand.updateSettings(patch);
  };
  return [snap, update];
}

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-neutral-500 dark:text-neutral-400">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-7">
      <div className="mb-2 flex items-end justify-between px-1">
        <div>
          <h2 className="text-[13px] font-semibold text-neutral-700 dark:text-neutral-200">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="divide-y divide-black/[0.06] overflow-hidden rounded-xl bg-white/80 shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)] dark:divide-white/[0.07] dark:bg-white/[0.04] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.1)]">
        {children}
      </div>
    </section>
  );
}

/** Uses the Row label as the accessible name of the switch inside it (X1) */
const RowLabel = createContext<string | undefined>(undefined);

export function Row({ label, hint, children, vertical }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; vertical?: boolean }) {
  return (
    <RowLabel.Provider value={typeof label === 'string' ? label : undefined}>
      <div className={cx('px-4 py-3', vertical ? 'flex flex-col gap-2' : 'flex items-center justify-between gap-6')}>
        <div className="min-w-0">
          <div className="text-[13px]">{label}</div>
          {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">{hint}</div>}
        </div>
        {children !== undefined && <div className={cx(vertical ? 'w-full' : 'shrink-0')}>{children}</div>}
      </div>
    </RowLabel.Provider>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  const rowLabel = useContext(RowLabel);
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label ?? rowLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative block h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-40', checked ? 'bg-blue-500' : 'bg-black/15 dark:bg-white/20')}
    >
      <span className={cx('absolute left-0 top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-[2px]')} />
    </button>
  );
}

export function Select<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cx('rounded-md border-0 bg-black/[0.05] px-2 py-1 text-[13px] outline-none ring-blue-500/50 focus:ring-2 dark:bg-white/10', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Look of a text field without a width. The caller sets the width */
export const inputBase = 'rounded-md border-0 bg-black/[0.05] px-2.5 py-1.5 text-[13px] outline-none ring-blue-500/50 placeholder:text-neutral-400 focus:ring-2 dark:bg-white/10';
export const inputClass = `${inputBase} w-full`;

/** Text field that saves only when the input is committed (blur or Enter) */
export function TextField({
  value,
  onCommit,
  placeholder,
  type = 'text',
  className,
  mono,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  mono?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      type={type}
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={cx(inputBase, className ?? 'w-full', mono && 'font-mono text-[12px]')}
    />
  );
}

export function NumberField({ value, onCommit, min, max, step = 1, suffix }: { value: number; onCommit: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    let n = Number(v);
    if (!Number.isFinite(n)) n = value;
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    setV(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        value={v}
        step={step}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className={cx(inputBase, 'w-24 text-right tabular-nums')}
      />
      {suffix && <span className="whitespace-nowrap text-[12px] text-neutral-500">{suffix}</span>}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  small,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  small?: boolean;
  title?: string;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        small ? 'px-2 py-0.5 text-[12px]' : 'px-3 py-1.5 text-[13px]',
        variant === 'primary' && 'bg-blue-500 text-white hover:bg-blue-600',
        variant === 'secondary' && 'bg-black/[0.06] hover:bg-black/[0.1] dark:bg-white/10 dark:hover:bg-white/[0.16]',
        variant === 'danger' && 'text-rose-600 hover:bg-rose-500/10 dark:text-rose-400',
        variant === 'ghost' && 'text-neutral-500 hover:bg-black/[0.05] hover:text-neutral-800 dark:hover:bg-white/10 dark:hover:text-neutral-100',
      )}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'violet' }) {
  const tones = {
    neutral: 'bg-black/[0.06] text-neutral-600 dark:bg-white/10 dark:text-neutral-300',
    blue: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
    green: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    red: 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
    violet: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
  };
  return <span className={cx('inline-flex items-center rounded px-1.5 py-[1px] text-[11px] font-medium', tones[tone])}>{children}</span>;
}

export function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={cx('inline-block h-2 w-2 rounded-full', ok ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-rose-500')} />;
}
