/**
 * Loads the textfix tokenizer once in the background and keeps it.
 * If it cannot be loaded or throws, only the rules that need tokens are skipped (dictation keeps working).
 */
import fs from 'node:fs';
import { createLogger } from '../log';
import { createLinderaTokenizer } from './tokenizer';
import type { Tokenizer } from './types';

const log = createLogger('textfix');

export type TokenizerStatus = 'idle' | 'loading' | 'ready' | 'failed';

export class TextFixService {
  private tokenizer: Tokenizer | null = null;
  private loading: Promise<void> | null = null;
  status: TokenizerStatus = 'idle';
  error = '';

  constructor(private readonly wasmPath: () => string) {}

  /** Loads the tokenizer. Loads only once however many times it is called */
  load(): Promise<void> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    this.status = 'loading';
    const started = performance.now();
    try {
      const file = this.wasmPath();
      const bytes = await fs.promises.readFile(file);
      this.tokenizer = await createLinderaTokenizer(bytes);
      // The first call is slow, so get it out of the way here
      this.tokenizer.tokenize('準備ができました。');
      this.status = 'ready';
      log.info(`Loaded the tokenizer (${Math.round(performance.now() - started)} ms)`);
    } catch (e) {
      this.status = 'failed';
      this.error = (e as Error).message;
      log.warn(`Could not load the tokenizer. Skipping the automatic fixes that need it: ${this.error}`);
    }
  }

  /** Returns the tokenizer if loaded. null while loading or after a failure */
  get(): Tokenizer | null {
    return this.tokenizer;
  }
}
