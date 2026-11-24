import { EventEmitter } from 'node:events';
import { safeStorage } from 'electron';
import { deepMerge, mergeSettings, type Settings } from '../../shared/settings';
import type { DeepPartial } from '../../shared/types';
import { JsonStore } from './json-store';

// deepMerge is also used where electron is not loaded (the evaluation code), so it lives in shared
export { deepMerge };

export class SettingsStore extends EventEmitter {
  private value: Settings;
  private readonly store: JsonStore<Settings>;

  /**
   * readOnly: only read the file (never write it back, never move it aside when corrupt).
   * The evaluation (LONGHAND_EVAL) uses it to borrow just the connection and the key, without touching the settings of a running dev build
   */
  constructor(file: string, opts: { readOnly?: boolean } = {}) {
    super();
    this.store = new JsonStore<Settings>(file, 200, opts);
    this.value = mergeSettings(this.store.read());
  }

  get(): Settings {
    return this.value;
  }

  update(patch: DeepPartial<Settings>): Settings {
    const prev = this.value;
    // The API key can only be changed through setApiKey
    if (patch.llm && 'apiKeyEnc' in patch.llm) delete (patch.llm as { apiKeyEnc?: string }).apiKeyEnc;
    this.value = mergeSettings(deepMerge(this.value, patch));
    this.store.write(this.value);
    this.emit('change', this.value, prev);
    return this.value;
  }

  /** Encrypts the API key with safeStorage (a keychain key on macOS) and saves it */
  setApiKey(plain: string): void {
    const enc = plain ? safeStorage.encryptString(plain).toString('base64') : '';
    const prev = this.value;
    this.value = { ...this.value, llm: { ...this.value.llm, apiKeyEnc: enc } };
    this.store.write(this.value);
    this.emit('change', this.value, prev);
  }

  getApiKey(): string {
    const enc = this.value.llm.apiKeyEnc;
    if (!enc) return process.env.LONGHAND_LLM_API_KEY ?? '';
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return '';
    }
  }

  hasApiKey(): boolean {
    return !!this.value.llm.apiKeyEnc || !!process.env.LONGHAND_LLM_API_KEY;
  }

  flush(): void {
    this.store.flush();
  }
}
