import { session, type Session } from 'electron';
import { createLogger } from '../log';

const log = createLogger('egress');

let llmSession: Session | null = null;

/**
 * 外部通信の封鎖（OPS-1）。
 * - 画面（レンダラ）の通信は、アプリ内のリソース（file:、開発サーバー、devtools）以外をすべて遮断する。
 * - LLM の呼び出しは専用のセッション（partition: llm）からだけ行う。このセッションの fetch は
 *   Chromium のネットワーク層を通るので、システムのプロキシ設定（PAC を含む）とキーチェーンに入れた独自の CA がそのまま効く（OPS-2）。
 */
export function lockDownRendererNetwork(devServerUrl: string | undefined): void {
  const allowedPrefixes = ['file:', 'devtools:', 'data:', 'blob:', 'chrome-extension:'];
  if (devServerUrl) {
    const u = new URL(devServerUrl);
    allowedPrefixes.push(`${u.protocol}//${u.host}`, `ws://${u.host}`);
  }
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    const ok = allowedPrefixes.some((p) => details.url.startsWith(p));
    if (!ok) log.warn(`画面からの通信を遮断しました: ${new URL(details.url).host}`);
    cb({ cancel: !ok });
  });
  // 画面からの権限要求（カメラ、通知など）はすべて拒否する。録音はヘルパーが行う
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

export function getLlmSession(): Session {
  if (!llmSession) {
    llmSession = session.fromPartition('llm', { cache: false });
    llmSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  }
  return llmSession;
}

/** LLM の呼び出しに使う fetch */
export function llmFetch(input: string, init?: RequestInit): Promise<Response> {
  return getLlmSession().fetch(input, init as Parameters<Session['fetch']>[1]);
}

let modelSession: Session | null = null;

/**
 * 音声認識のモデルの取得に使う fetch（ASR-5）。利用者がボタンを押したときだけ使う。
 * LLM と同じくシステムのプロキシ設定と独自の CA が効く。
 */
export function modelFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!modelSession) {
    modelSession = session.fromPartition('model-download', { cache: false });
    modelSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  }
  return modelSession.fetch(input, init as Parameters<Session['fetch']>[1]);
}

/** 録音を始めた時点で接続しておき、TLS の握手を待たずに済むようにする */
export function preconnect(url: string): void {
  try {
    const origin = new URL(url).origin;
    getLlmSession().preconnect({ url: origin, numSockets: 1 });
  } catch {
    /* URL が不正なら何もしない */
  }
}
