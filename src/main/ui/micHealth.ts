import { JsonStore } from '../store/json-store';

/**
 * Record of microphone health (N6).
 *
 * From the levels that arrive while recording (the RMS of each chunk of about 100ms), computes the 95th percentile in dBFS per session.
 * Keeps the last 5 sessions per microphone, and judges it "very quiet" when 3 or more are at or below -50 dBFS.
 * The 95th percentile looks at the level while the user speaks, not at the silence between phrases.
 */

export const QUIET_DBFS = -50;
/** Recordings shorter than this are not used for the judgment */
export const MIN_SESSION_MS = 3000;
const KEEP = 5;
const QUIET_NEEDED = 3;
/** Complete silence (muted) is handled by another notification (AllSilence), so it is not recorded */
const SILENT_DBFS = -90;

export function dbfs(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

interface Data {
  version: 1;
  /** Per microphone name, the 95th percentile (dBFS) of the recent sessions */
  devices: Record<string, number[]>;
  /** Microphone used for the previous recording (to tell the user when it changes) */
  lastDevice?: string;
}

export interface SessionVerdict {
  p95: number;
  /** 3 or more of the last 5 sessions were quiet */
  quiet: boolean;
}

export class MicHealth {
  private data: Data = { version: 1, devices: {} };
  private levels: number[] = [];
  private store: JsonStore<Data> | null;

  constructor(file: string | null) {
    this.store = file ? new JsonStore<Data>(file, 1000) : null;
    const saved = this.store?.read() as Partial<Data> | undefined;
    if (saved?.devices && typeof saved.devices === 'object') this.data.devices = saved.devices;
    if (typeof saved?.lastDevice === 'string') this.data.lastDevice = saved.lastDevice;
  }

  get lastDevice(): string {
    return this.data.lastDevice ?? '';
  }

  set lastDevice(name: string) {
    if (!name || name === this.data.lastDevice) return;
    this.data.lastDevice = name;
    this.store?.write(this.data);
  }

  begin(): void {
    this.levels = [];
  }

  push(rms: number): void {
    if (this.levels.length < 20000) this.levels.push(dbfs(rms));
  }

  /** End of a session. null when the recording cannot be used for the judgment */
  end(device: string | undefined, durationMs: number): SessionVerdict | null {
    const levels = this.levels;
    this.levels = [];
    if (!device || durationMs < MIN_SESSION_MS || levels.length < 10) return null;
    const p95 = percentile(levels, 95);
    if (p95 <= SILENT_DBFS) return null;
    const list = [...(this.data.devices[device] ?? []), Math.round(p95 * 10) / 10].slice(-KEEP);
    this.data.devices[device] = list;
    this.store?.write(this.data);
    const quiet = list.filter((x) => x <= QUIET_DBFS).length >= QUIET_NEEDED;
    return { p95, quiet };
  }

  history(device: string): number[] {
    return [...(this.data.devices[device] ?? [])];
  }

  flush(): void {
    this.store?.flush();
  }
}
