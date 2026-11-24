import { session, type Session } from 'electron';
import { createLogger } from '../log';

const log = createLogger('egress');

let llmSession: Session | null = null;

/**
 * Locks down outside connections (OPS-1).
 * - Requests from the windows (renderer) are all blocked, except for the app's own resources (file:, the dev server, devtools).
 * - LLM calls are made only from a dedicated session (partition: llm). Its fetch goes through Chromium's network
 *   stack, so the system proxy settings (including PAC) and custom CAs in the keychain apply as they are (OPS-2).
 */
export function lockDownRendererNetwork(devServerUrl: string | undefined): void {
  const allowedPrefixes = ['file:', 'devtools:', 'data:', 'blob:', 'chrome-extension:'];
  if (devServerUrl) {
    const u = new URL(devServerUrl);
    allowedPrefixes.push(`${u.protocol}//${u.host}`, `ws://${u.host}`);
  }
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    const ok = allowedPrefixes.some((p) => details.url.startsWith(p));
    if (!ok) log.warn(`blocked a request from a window: ${new URL(details.url).host}`);
    cb({ cancel: !ok });
  });
  // Deny every permission request from the windows (camera, notifications and so on). The helper does the recording
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

export function getLlmSession(): Session {
  if (!llmSession) {
    llmSession = session.fromPartition('llm', { cache: false });
    llmSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  }
  return llmSession;
}

/** The fetch used for LLM calls */
export function llmFetch(input: string, init?: RequestInit): Promise<Response> {
  return getLlmSession().fetch(input, init as Parameters<Session['fetch']>[1]);
}

let modelSession: Session | null = null;

/**
 * The fetch used to download speech recognition models (ASR-5). Used only when the user presses the button.
 * As with the LLM, the system proxy settings and custom CAs apply.
 */
export function modelFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!modelSession) {
    modelSession = session.fromPartition('model-download', { cache: false });
    modelSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  }
  return modelSession.fetch(input, init as Parameters<Session['fetch']>[1]);
}

/** Connects when recording starts, so that nothing waits for the TLS handshake later */
export function preconnect(url: string): void {
  try {
    const origin = new URL(url).origin;
    getLlmSession().preconnect({ url: origin, numSockets: 1 });
  } catch {
    /* do nothing if the URL is invalid */
  }
}
