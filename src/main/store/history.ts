import { EventEmitter } from 'node:events';
import type { HistoryItem } from '../../shared/types';
import { JsonStore } from './json-store';

export class HistoryStore extends EventEmitter {
  private items: HistoryItem[];
  private readonly store: JsonStore<{ version: 1; items: HistoryItem[] }>;

  constructor(
    file: string,
    private limit: () => number,
    private readonly onEvict: (item: HistoryItem) => void,
  ) {
    super();
    this.store = new JsonStore(file, 500);
    const saved = this.store.read() as { items?: HistoryItem[] } | undefined;
    this.items = Array.isArray(saved?.items) ? saved!.items : [];
  }

  list(query?: string): HistoryItem[] {
    const q = query?.trim().toLowerCase();
    const sorted = [...this.items].sort((a, b) => b.timestamp - a.timestamp);
    if (!q) return sorted;
    return sorted.filter((i) => i.text.toLowerCase().includes(q) || i.rawText.toLowerCase().includes(q) || (i.app?.name ?? '').toLowerCase().includes(q));
  }

  get(id: string): HistoryItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** 最後に貼り付けた（貼り付けるはずだった）書き起こし（HK-7） */
  last(): HistoryItem | undefined {
    return this.list().find((i) => i.text && i.paste !== 'cancelled');
  }

  add(item: HistoryItem): void {
    this.items.push(item);
    const limit = Math.max(10, this.limit());
    if (this.items.length > limit) {
      this.items.sort((a, b) => a.timestamp - b.timestamp);
      const evicted = this.items.splice(0, this.items.length - limit);
      evicted.forEach(this.onEvict);
    }
    this.save();
  }

  update(id: string, patch: Partial<HistoryItem>): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.items[i] = { ...this.items[i], ...patch };
    this.save();
  }

  delete(id: string): HistoryItem | undefined {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    const [removed] = this.items.splice(i, 1);
    this.save();
    return removed;
  }

  clear(): HistoryItem[] {
    const all = this.items;
    this.items = [];
    this.save();
    return all;
  }

  private save(): void {
    this.store.write({ version: 1, items: this.items });
    this.emit('change');
  }

  flush(): void {
    this.store.flush();
  }
}
