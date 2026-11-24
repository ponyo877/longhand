import path from 'node:path';
import { app } from 'electron';

/** Directories the app uses. app.getPath works before ready */
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
  /** Models bundled with the app (prepared by npm run bundle:models; absent otherwise) */
  get bundledModels(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(app.getAppPath(), 'resources/models');
  },
  file(name: string): string {
    return path.join(app.getPath('userData'), name);
  },
  /** Location of bundled resources (the helper, ASR workers). During development, the repository's build output */
  get nativeRoot(): string {
    return app.isPackaged ? process.resourcesPath : app.getAppPath();
  },
  get helperExecutable(): string {
    if (process.env.LONGHAND_HELPER_PATH) return process.env.LONGHAND_HELPER_PATH;
    return app.isPackaged
      ? path.join(process.resourcesPath, 'LonghandHelper.app/Contents/MacOS/LonghandHelper')
      : path.join(app.getAppPath(), 'helper/build/LonghandHelper.app/Contents/MacOS/LonghandHelper');
  },
  /** WASM of textfix's tokenizer (lindera, with the IPADIC dictionary). In the distributed package it is in Resources (forge's extraResource) */
  get linderaWasm(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'lindera_wasm_bg.wasm') : path.join(app.getAppPath(), 'node_modules/lindera-wasm-ipadic-web/lindera_wasm_bg.wasm');
  },
  asrWorker(engine: string): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'build', `longhand-asr-${engine}`) : path.join(app.getAppPath(), 'asr/build', `longhand-asr-${engine}`);
  },
};
