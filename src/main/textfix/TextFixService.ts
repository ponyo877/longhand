/**
 * textfix の単語分割を、裏で 1 回だけ読み込んで持っておく。
 * 読み込めないときや例外のときは、単語分割を使う規則だけを飛ばす（音声入力は止めない）。
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

  /** 単語分割を読み込む。何度呼んでも 1 回だけ読み込む */
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
      // 最初の 1 回は遅いので、ここで済ませておく
      this.tokenizer.tokenize('準備ができました。');
      this.status = 'ready';
      log.info(`単語分割を読み込みました（${Math.round(performance.now() - started)}ms）`);
    } catch (e) {
      this.status = 'failed';
      this.error = (e as Error).message;
      log.warn(`単語分割を読み込めませんでした。単語分割を使う自動修正は飛ばします: ${this.error}`);
    }
  }

  /** 読み込み済みなら単語分割を返す。読み込み中か失敗したら null */
  get(): Tokenizer | null {
    return this.tokenizer;
  }
}
