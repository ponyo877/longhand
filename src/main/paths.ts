import path from 'node:path';
import { app } from 'electron';

/** アプリが使うディレクトリ。app.getPath は ready 前でも使える */
export const paths = {
  get userData(): string {
    return app.getPath('userData');
  },
  get logs(): string {
    return app.getPath('logs');
  },
  get recordings(): string {
    return path.join(app.getPath('userData'), 'recordings');
  },
  get models(): string {
    return path.join(app.getPath('userData'), 'models');
  },
  /** アプリに同梱したモデルの場所（npm run bundle:models で用意する。なければ存在しない） */
  get bundledModels(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(app.getAppPath(), 'resources/models');
  },
  file(name: string): string {
    return path.join(app.getPath('userData'), name);
  },
  /** 同梱リソース（ヘルパー、ASR ワーカー）の場所。開発中はリポジトリのビルド成果物を使う */
  get nativeRoot(): string {
    return app.isPackaged ? process.resourcesPath : app.getAppPath();
  },
  get helperExecutable(): string {
    if (process.env.LONGHAND_HELPER_PATH) return process.env.LONGHAND_HELPER_PATH;
    return app.isPackaged
      ? path.join(process.resourcesPath, 'LonghandHelper.app/Contents/MacOS/LonghandHelper')
      : path.join(app.getAppPath(), 'helper/build/LonghandHelper.app/Contents/MacOS/LonghandHelper');
  },
  /** textfix の単語分割の WASM（lindera、辞書は IPADIC）。配布パッケージでは Resources に置く（forge の extraResource） */
  get linderaWasm(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'lindera_wasm_bg.wasm') : path.join(app.getAppPath(), 'node_modules/lindera-wasm-ipadic-web/lindera_wasm_bg.wasm');
  },
  asrWorker(engine: string): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'build', `longhand-asr-${engine}`) : path.join(app.getAppPath(), 'asr/build', `longhand-asr-${engine}`);
  },
};
