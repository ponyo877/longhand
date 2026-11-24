import { JsonStore } from '../store/json-store';

/**
 * マイクの状態の記録（N6）。
 *
 * 録音中に届く音量（約 100ms ごとのチャンクの RMS）から、セッションごとに 95 パーセンタイルの dBFS を求める。
 * マイクごとに直近 5 回分を残し、3 回以上が -50 dBFS 以下なら「音がとても小さい」と判断する。
 * 95 パーセンタイルを使うのは、話していない間の静けさではなく、話しているときの大きさを見るため。
 */

export const QUIET_DBFS = -50;
/** これより短い録音は判定に使わない */
export const MIN_SESSION_MS = 3000;
const KEEP = 5;
const QUIET_NEEDED = 3;
/** 完全な無音（ミュート）は別の通知（AllSilence）で扱うので、記録しない */
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
  /** マイク名ごとの、直近のセッションの 95 パーセンタイル（dBFS） */
  devices: Record<string, number[]>;
  /** 前回の録音に使ったマイク（マイクが変わったことを知らせるため） */
  lastDevice?: string;
}

export interface SessionVerdict {
  p95: number;
  /** 直近 5 回中 3 回以上が小さい */
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

  /** セッションの終わり。判定に使えない録音なら null */
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
