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
 * Release builds (`LONGHAND_RELEASE=1`, set by scripts/release.sh) must be signed with a Developer ID certificate and notarized.
 * They stop instead of falling back to a development certificate or skipping notarization.
 */
const release = process.env.LONGHAND_RELEASE === '1';

interface SigningIdentity {
  /** SHA-1 hash, or the name given in LONGHAND_SIGN_IDENTITY */
  id: string;
  /** "Developer ID Application", "Apple Development", or null when the kind is unknown */
  kind: string | null;
}

function keychainIdentities(): { hash: string; name: string }[] {
  let listing = '';
  try {
    listing = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  } catch {
    // Without the security tool, behave as if the keychain had no identities
  }
  return [...listing.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((m) => ({ hash: m[1], name: m[2] }));
}

const IDENTITY_KINDS = ['Developer ID Application', 'Apple Development'];

const kindOf = (name: string) => IDENTITY_KINDS.find((k) => name.startsWith(k)) ?? null;

/**
 * Chooses the certificate to sign with.
 *
 * - LONGHAND_SIGN_IDENTITY=-: do not sign.
 * - LONGHAND_SIGN_IDENTITY=<name or SHA-1>: use that certificate.
 * - Unset: look in the keychain. Use a Developer ID Application certificate if there is one, otherwise Apple Development
 *   (the same certificate helper/build.sh and asr/build.sh use, so macOS keeps the permissions granted to earlier builds).
 *
 * @electron/osx-sign only looks for Developer ID Application certificates when none is given.
 * On a machine with only a development certificate it would silently produce an unsigned app, so the choice is made here.
 */
function signingIdentity(): SigningIdentity | undefined {
  const given = process.env.LONGHAND_SIGN_IDENTITY;
  if (given === '-') return undefined;
  const found = keychainIdentities();
  if (given) {
    const hit = found.find((i) => i.hash === given.toUpperCase() || i.name === given);
    return { id: given, kind: hit ? kindOf(hit.name) : null };
  }
  for (const kind of IDENTITY_KINDS) {
    const hit = found.find((i) => i.name.startsWith(kind));
    if (hit) {
      // Certificate names contain a person's name, so only the kind is printed
      console.log(`[forge] Signing with: ${kind} (${hit.hash.slice(0, 8)}…)`);
      return { id: hit.hash, kind };
    }
  }
  console.warn('[forge] No code signing certificate found. Building unsigned (macOS will ask for permissions again after every rebuild)');
  return undefined;
}

type NotarizeOptions = NonNullable<ForgeConfig['packagerConfig']>['osxNotarize'];

/**
 * Notarization credentials from the environment. The first complete set wins:
 *
 * - APPLE_KEYCHAIN_PROFILE: a profile saved with `xcrun notarytool store-credentials`
 * - APPLE_API_KEY (path to the .p8 file), APPLE_API_KEY_ID, APPLE_API_ISSUER: an App Store Connect API key
 * - APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID: an Apple ID with an app-specific password
 */
function notarizeOptions(): NotarizeOptions {
  const e = process.env;
  if (e.APPLE_KEYCHAIN_PROFILE) return { keychainProfile: e.APPLE_KEYCHAIN_PROFILE };
  if (e.APPLE_API_KEY && e.APPLE_API_KEY_ID) {
    return { appleApiKey: e.APPLE_API_KEY, appleApiKeyId: e.APPLE_API_KEY_ID, ...(e.APPLE_API_ISSUER ? { appleApiIssuer: e.APPLE_API_ISSUER } : {}) };
  }
  if (e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID) {
    return { appleId: e.APPLE_ID, appleIdPassword: e.APPLE_APP_SPECIFIC_PASSWORD, teamId: e.APPLE_TEAM_ID };
  }
  return undefined;
}

const signIdentity = signingIdentity();
const developerId = signIdentity?.kind === 'Developer ID Application';
const credentials = notarizeOptions();
if (release && !developerId) {
  throw new Error('[forge] A release build needs a "Developer ID Application" certificate in the keychain (see docs/releasing.md)');
}
if (release && !credentials) {
  throw new Error('[forge] A release build needs notarization credentials in the environment (see docs/releasing.md)');
}
// Apple only notarizes apps signed with a Developer ID certificate
const notarize = developerId ? credentials : undefined;
if (credentials && !developerId) console.warn('[forge] Notarization credentials are set, but the app is not signed with a Developer ID certificate. Skipping notarization');

const entitlements = {
  app: path.join(root, 'resources/entitlements.mac.plist'),
  helper: path.join(root, 'helper/Resources/LonghandHelper.entitlements'),
};

/**
 * Entitlements for each signed file. Electron's own executables get the app's entitlements (JIT and microphone).
 * The Swift helper keeps its own (microphone only), and the speech recognition workers get none: they read audio from stdin
 * and use neither JIT nor injected libraries.
 */
function entitlementsFor(filePath: string): string | string[] {
  if (filePath.includes('/LonghandHelper.app')) return entitlements.helper;
  if (/\/longhand-asr-[^/]+$/.test(filePath)) return [];
  return entitlements.app;
}

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
          identity: signIdentity.id,
          // Stop the build if signing fails, rather than leaving an unsigned app behind
          continueOnError: false,
          optionsForFile: (filePath) => ({
            hardenedRuntime: true,
            entitlements: entitlementsFor(filePath),
          }),
        }
      : undefined,
    // Submits the signed app to Apple and staples the ticket. Only with a Developer ID certificate and credentials (see above)
    osxNotarize: notarize,
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
