import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const root = import.meta.dirname;

/** ビルド済みのネイティブ部品（ヘルパーと ASR ワーカー）を Resources に同梱する */
function nativeResources(): string[] {
  const candidates = [path.join(root, 'helper/build/LonghandHelper.app'), path.join(root, 'asr/build')];
  const always = [path.join(root, 'resources/tray')];
  // textfix の単語分割（lindera の WASM と IPADIC、約 18MB）。main のバンドルには入れず、Resources に置いてバイト列から読み込む
  const lindera = path.join(root, 'node_modules/lindera-wasm-ipadic-web/lindera_wasm_bg.wasm');
  if (fs.existsSync(lindera)) always.push(lindera);
  else console.warn('[forge] 単語分割の WASM が見つかりません（npm install を実行してください）。自動修正の一部の規則が動きません:', lindera);
  const found = candidates.filter((p) => fs.existsSync(p));
  if (found.length < candidates.length) {
    console.warn(
      '[forge] ネイティブ部品が見つかりません。先に `npm run build:native` を実行してください:',
      candidates.filter((p) => !found.includes(p)),
    );
  }
  // 音声認識のモデルは、resources/models に置いてあれば同梱する（npm run bundle:models で用意する）
  const bundledModels = path.join(root, 'resources/models');
  const models = fs.existsSync(path.join(bundledModels, 'whisper')) ? [bundledModels] : [];
  if (!models.length) console.warn('[forge] 音声認識のモデルは同梱しません（同梱するには先に `npm run bundle:models` を実行してください）');
  return [...always, ...found, ...models];
}

/**
 * 署名に使う証明書を決める。
 *
 * - LONGHAND_SIGN_IDENTITY=-：署名しない。
 * - LONGHAND_SIGN_IDENTITY=<名前か SHA-1>：その証明書を使う。
 * - 未指定：キーチェーンから探す。Developer ID Application があればそれ、なければ Apple Development を使う
 *   （helper/build.sh や asr/build.sh と同じ証明書になり、ビルドし直しても権限の許可が残る）。
 *
 * @electron/osx-sign は、証明書を指定しないと Developer ID Application しか探さない。
 * 開発用の証明書しかない PC では、署名に失敗したまま（何も表示せずに）署名なしのアプリができてしまうので、ここで選んで渡す。
 */
function signingIdentity(): string | undefined {
  const given = process.env.LONGHAND_SIGN_IDENTITY;
  if (given === '-') return undefined;
  if (given) return given;
  let listing = '';
  try {
    listing = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  } catch {
    // security が使えないときは、署名しない
  }
  const found = [...listing.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((m) => ({ hash: m[1], name: m[2] }));
  for (const kind of ['Developer ID Application', 'Apple Development']) {
    const hit = found.find((i) => i.name.startsWith(kind));
    if (hit) {
      // 証明書の名前には個人の名前が入るので、種類だけを表示する
      console.log(`[forge] 署名に使う証明書: ${kind}（${hit.hash.slice(0, 8)}…）`);
      return hit.hash;
    }
  }
  console.warn('[forge] 署名に使える証明書が見つかりません。署名なしで作ります（権限の許可は、ビルドし直すたびに取り直しになります）');
  return undefined;
}

const signIdentity = signingIdentity();

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Longhand',
    executableName: 'Longhand',
    appBundleId: 'io.github.ponyo877.longhand',
    appCategoryType: 'public.app-category.productivity',
    icon: path.join(root, 'resources/icon'),
    asar: true,
    extraResource: nativeResources(),
    extendInfo: {
      LSUIElement: true,
      NSMicrophoneUsageDescription: '音声入力のためにマイクを使います。音声は端末の外に送信しません。',
    },
    osxSign: signIdentity
      ? {
          identity: signIdentity,
          // 署名に失敗したら、署名なしのアプリを残さずにビルドを止める
          continueOnError: false,
          optionsForFile: () => ({
            hardenedRuntime: true,
            entitlements: path.join(root, 'resources/entitlements.mac.plist'),
          }),
        }
      : undefined,
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin']), new MakerDMG({ format: 'ULFO' })],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'ui',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
