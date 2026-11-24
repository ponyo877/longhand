import { EventEmitter } from 'node:events';
import { safeStorage } from 'electron';
import { deepMerge, mergeSettings, type Settings } from '../../shared/settings';
import type { DeepPartial } from '../../shared/types';
import { JsonStore } from './json-store';

// deepMerge は electron を読み込まない場所（評価のコード）からも使うので、shared に置いてある
export { deepMerge };

export class SettingsStore extends EventEmitter {
  private value: Settings;
  private readonly store: JsonStore<Settings>;

  /**
   * readOnly: ファイルを読むだけにする（書き戻さない。壊れていても退避しない）。
   * 評価（LONGHAND_EVAL）が、動いている開発版の設定を触らずに接続先とキーだけを借りるために使う
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
    // API キーは setApiKey 経由でしか変えさせない
    if (patch.llm && 'apiKeyEnc' in patch.llm) delete (patch.llm as { apiKeyEnc?: string }).apiKeyEnc;
    this.value = mergeSettings(deepMerge(this.value, patch));
    this.store.write(this.value);
    this.emit('change', this.value, prev);
    return this.value;
  }

  /** API キーを safeStorage（macOS ではキーチェーンの鍵）で暗号化して保存する */
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
