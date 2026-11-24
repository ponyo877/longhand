/**
 * End-to-end self-test of dictation, with no one at the keyboard or the microphone.
 *
 *   LONGHAND_DEBUG_SELFTEST=e2e npm start
 *   LONGHAND_DEBUG_SELFTEST=e2e LONGHAND_SELFTEST_LLM=saved npm start   # also format with the saved LLM connection, and test edit mode
 *
 * main.ts starts the app as usual in a temporary profile, with the real helper and speech recognizer, and hands the controller
 * a VirtualInputHelper instead of the helper (selftest/virtualInput.ts). This module opens a small window with a text field,
 * speaks into the pipeline with synthetic speech from macOS `say`, presses the hotkeys virtually, and checks what lands in the field:
 *
 * - hold:       hold the key, speak, release. The text is pasted
 * - hands-free: double-tap, speak, tap. The text is pasted
 * - cancel:     hold the key, speak, press Escape. Nothing is pasted or kept
 * - paste last: the last result is pasted again
 * - edit:       select text, hold the key and speak an instruction. The selection is rewritten (only with an LLM)
 *
 * What it does not cover is the part before a shortcut is matched (the helper's event tap, tested in helper/Tests) and the
 * microphone itself (LONGHAND_DEBUG_SELFTEST=1 checks that audio arrives). No key event is posted to the system and the
 * microphone stays closed, so other apps on the same key are not triggered and nothing is recorded.
 *
 * The window takes focus for about half a minute. Typing elsewhere during the test makes it fail, but cannot put text into another
 * app: every paste is pinned to the test window's app.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, BrowserWindow } from 'electron';
import type { ContextPayload } from '../../shared/protocol';
import type { HistoryItem } from '../../shared/types';
import type { AsrService } from '../asr/AsrService';
import { decodeWav } from '../audio/wav';
import { cer, normContent, rate } from '../eval/metrics';
import type { HistoryStore } from '../store/history';
import type { VirtualInputHelper } from './virtualInput';

const execFileP = promisify(execFile);

export interface SelfTestDeps {
  input: VirtualInputHelper;
  asr: AsrService;
  history: HistoryStore;
  /** Whether an LLM connection is available (edit mode needs one) */
  llm: boolean;
  log: (line: string) => void;
  /** Where to write the JSON report */
  reportPath: string;
}

export interface ScenarioResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  ms: number;
}

/** Sentences spoken by the synthetic voice. They are made up for the test */
const SPEECH = {
  hold: { say: '資料を共有しておきました', expect: '資料を共有しておきました。' },
  handsFree: { say: '来週の予定を確認してください', expect: '来週の予定を確認してください。' },
  cancel: { say: 'この録音は取り消します' },
  edit: { say: 'もっと丁寧にして', field: '明日の会議は中止です。' },
} as const;

/** Largest character error rate (content characters, punctuation ignored) that still counts as the right text */
const MAX_CER = 0.2;
const SR = 16000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(get: () => T | Promise<T>, timeoutMs: number, stepMs = 100): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

/** A Japanese voice for `say`: Kyoko if installed, otherwise the first Japanese voice */
async function japaneseVoice(): Promise<string | null> {
  const { stdout } = await execFileP('say', ['-v', '?']);
  const voices = stdout
    .split('\n')
    .map((l) => /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && m[2] === 'ja_JP')
    .map((m) => m[1].trim());
  return voices.find((v) => v === 'Kyoko') ?? voices[0] ?? null;
}

/** Synthesizes speech to 16 kHz mono samples, with a short pause before it. `say -o` writes a file and plays nothing */
async function speak(text: string, voice: string, dir: string, name: string): Promise<Float32Array> {
  const file = path.join(dir, `${name}.wav`);
  await execFileP('say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@16000', '-o', file, text]);
  const { samples, sampleRate } = decodeWav(fs.readFileSync(file));
  if (sampleRate !== SR) throw new Error(`say wrote ${sampleRate} Hz audio`);
  const out = new Float32Array(Math.round(SR * 0.25) + samples.length);
  out.set(samples, Math.round(SR * 0.25));
  return out;
}

const TEST_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Longhand self-test</title>
<style>body{margin:0;padding:14px 16px;font:14px -apple-system,sans-serif;background:#fff;color:#111}p{margin:0 0 10px;color:#555}
textarea{display:block;width:100%;height:190px;box-sizing:border-box;padding:8px;font:15px -apple-system,sans-serif}</style>
<p>Longhand end-to-end self-test. Please do not type while it runs.</p>
<textarea id="field" aria-label="Self-test field"></textarea></html>`;

class TestWindow {
  private constructor(private readonly win: BrowserWindow) {}

  static async open(): Promise<TestWindow> {
    const win = new BrowserWindow({
      width: 520,
      height: 280,
      title: 'Longhand self-test',
      show: false,
      alwaysOnTop: true,
      resizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TEST_PAGE)}`);
    const w = new TestWindow(win);
    await w.focus();
    return w;
  }

  async focus(): Promise<void> {
    this.win.show();
    app.focus({ steal: true });
    this.win.focus();
    await this.js(`document.getElementById('field').focus(), true`);
  }

  /** Replaces the field's text. Selects all of it, or puts the caret at the end */
  async set(text: string, select = false): Promise<void> {
    await this.focus();
    await this.js(`(() => {
      const f = document.getElementById('field');
      f.value = ${JSON.stringify(text)};
      f.focus();
      ${select ? 'f.select();' : 'f.setSelectionRange(f.value.length, f.value.length);'}
      return true;
    })()`);
  }

  value(): Promise<string> {
    return this.js(`document.getElementById('field').value`) as Promise<string>;
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  private js(code: string): Promise<unknown> {
    return this.win.webContents.executeJavaScript(code, true);
  }
}

const contentCer = (hyp: string, ref: string) => rate(cer(hyp, ref, normContent)) ?? 1;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Runs every scenario and returns the process exit code: 0 when all ran scenarios passed */
export async function runEndToEndSelfTest(d: SelfTestDeps): Promise<number> {
  const results: ScenarioResult[] = [];
  const startedAt = new Date();
  const record = (r: ScenarioResult) => {
    results.push(r);
    d.log(`${r.status.toUpperCase().padEnd(4)} ${r.name}: ${r.detail} (${(r.ms / 1000).toFixed(1)} s)`);
  };
  let win: TestWindow | null = null;
  let voice: string | null = null;
  let setupError: string | null = null;
  try {
    voice = await japaneseVoice();
    if (!voice) throw new Error('no Japanese voice for `say`. Add one in System Settings > Accessibility > Spoken Content > System Voice');
    const dir = path.join(app.getPath('userData'), 'selftest-audio');
    fs.mkdirSync(dir, { recursive: true });
    const audio = {
      hold: await speak(SPEECH.hold.say, voice, dir, 'hold'),
      handsFree: await speak(SPEECH.handsFree.say, voice, dir, 'hands-free'),
      cancel: await speak(SPEECH.cancel.say, voice, dir, 'cancel'),
      edit: await speak(SPEECH.edit.say, voice, dir, 'edit'),
    };
    if (!(await d.asr.waitReady(90_000))) throw new Error(`speech recognizer is not ready (${d.asr.status})`);
    if (!d.input.running) throw new Error('helper is not running');

    win = await TestWindow.open();
    const w = win;
    // Pin pastes to this app once the helper sees the test field in front
    const front = await until(
      async () => {
        await w.focus();
        const ctx = await d.input.request<ContextPayload>('get_context', { includeField: true, includeHost: false, maxContextChars: 100 }, 1500).catch(() => null);
        return ctx && ctx.app.pid === process.pid && ctx.field?.editable ? ctx : null;
      },
      8000,
      500,
    );
    if (!front) throw new Error('the helper cannot see the test window in front. Is accessibility permission granted to LonghandHelper?');
    d.input.pinnedBundleId = front.app.bundleId;

    const ids = () => new Set(d.history.list().map((h) => h.id));
    const newItem = (before: Set<string>, timeoutMs: number) => until(() => d.history.list().find((h) => !before.has(h.id)) ?? null, timeoutMs);
    /** Waits until the queued audio has been delivered, then a moment of silence, as a person finishing a sentence */
    const speakAll = async () => {
      await until(() => d.input.recording, 3000, 20);
      await until(() => d.input.audioDelivered, 20_000);
      await sleep(400);
    };
    const checkPasted = async (item: HistoryItem | null, expected: string, startedMs: number): Promise<ScenarioResult & { item?: HistoryItem }> => {
      const ms = Date.now() - startedMs;
      if (!item) return { name: '', status: 'fail', detail: 'no result within 30 s', ms };
      const value = (await until(async () => (await w.value()).trim(), 3000)) ?? '';
      const e = contentCer(value, expected);
      const toPaste = item.timings.keyPostedMs ?? item.timings.ackMs;
      const timing = `release to paste ${toPaste === undefined ? '?' : Math.round(toPaste)} ms`;
      if (item.paste !== 'pasted') return { name: '', status: 'fail', detail: `paste ${item.paste}, field "${value}"`, ms, item };
      if (e > MAX_CER) return { name: '', status: 'fail', detail: `field "${value}", expected "${expected}" (CER ${pct(e)})`, ms, item };
      return { name: '', status: 'pass', detail: `"${value}" (CER ${pct(e)}, ${item.formatted ? 'formatted' : 'not formatted'}, ${timing})`, ms, item };
    };

    // --- Hold to talk --------------------------------------------------------------
    {
      const t0 = Date.now();
      await w.set('');
      d.input.setAudio(audio.hold);
      const before = ids();
      d.input.press('activate', 'down');
      await speakAll();
      d.input.press('activate', 'up');
      record({ ...(await checkPasted(await newItem(before, 30_000), SPEECH.hold.expect, t0)), name: 'hold to talk' });
    }

    // --- Hands-free -----------------------------------------------------------------
    {
      const t0 = Date.now();
      await w.set('');
      d.input.setAudio(audio.handsFree);
      const before = ids();
      // A double tap within the double-tap window locks the recording
      d.input.press('activate', 'down');
      await sleep(80);
      d.input.press('activate', 'up');
      await sleep(120);
      d.input.press('activate', 'down');
      await sleep(60);
      d.input.press('activate', 'up');
      await speakAll();
      if (!d.input.recording) {
        record({ name: 'hands-free', status: 'fail', detail: 'the recording stopped after the double tap instead of locking', ms: Date.now() - t0 });
      } else {
        d.input.press('activate', 'down');
        await sleep(60);
        d.input.press('activate', 'up');
        record({ ...(await checkPasted(await newItem(before, 30_000), SPEECH.handsFree.expect, t0)), name: 'hands-free' });
      }
    }

    // --- Cancel ---------------------------------------------------------------------
    {
      const t0 = Date.now();
      await w.set('');
      d.input.setAudio(audio.cancel);
      const before = ids();
      d.input.press('activate', 'down');
      await until(() => d.input.recording, 3000, 20);
      await sleep(1000);
      d.input.press('cancel', 'down');
      d.input.press('cancel', 'up');
      d.input.press('activate', 'up');
      await sleep(3000);
      const kept = d.history.list().find((h) => !before.has(h.id));
      const value = await w.value();
      const ok = !d.input.recording && !value && !kept;
      record({
        name: 'cancel',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'nothing pasted or kept' : `recording ${d.input.recording ? 'still running' : 'stopped'}, field "${value}", history ${kept ? 'kept an item' : 'unchanged'}`,
        ms: Date.now() - t0,
      });
    }

    // --- Paste last -----------------------------------------------------------------
    {
      const t0 = Date.now();
      const last = d.history.last();
      await w.set('');
      if (!last?.text) {
        record({ name: 'paste last', status: 'skip', detail: 'no earlier result', ms: 0 });
      } else {
        d.input.press('paste_last', 'down');
        d.input.press('paste_last', 'up');
        const value = (await until(async () => (await w.value()).trim(), 10_000)) ?? '';
        const ok = value === last.text.trim();
        record({ name: 'paste last', status: ok ? 'pass' : 'fail', detail: ok ? `"${value}"` : `field "${value}", expected "${last.text}"`, ms: Date.now() - t0 });
      }
    }

    // --- Edit mode ------------------------------------------------------------------
    if (!d.llm) {
      record({ name: 'edit selection', status: 'skip', detail: 'needs an LLM connection (LONGHAND_SELFTEST_LLM=saved)', ms: 0 });
    } else {
      const t0 = Date.now();
      await w.set(SPEECH.edit.field, true);
      d.input.setAudio(audio.edit);
      const before = ids();
      d.input.press('activate', 'down');
      await speakAll();
      d.input.press('activate', 'up');
      const item = await newItem(before, 45_000);
      const value = (await w.value()).trim();
      const ok = item?.mode === 'edit' && item.paste === 'pasted' && !!value && value !== SPEECH.edit.field;
      record({
        name: 'edit selection',
        status: ok ? 'pass' : 'fail',
        detail: ok ? `"${SPEECH.edit.field}" became "${value}"` : `mode ${item?.mode ?? 'none'}, paste ${item?.paste ?? 'none'}, field "${value}"`,
        ms: Date.now() - t0,
      });
    }
  } catch (e) {
    setupError = (e as Error).message;
    d.log(`FAIL setup: ${setupError}`);
  } finally {
    d.input.dispose();
    win?.close();
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const ok = !setupError && failed === 0 && results.some((r) => r.status === 'pass');
  const report = { startedAt: startedAt.toISOString(), ok, voice, llm: d.llm, setupError, results };
  fs.writeFileSync(d.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  d.log(
    `${ok ? 'passed' : 'failed'}: ${results.filter((r) => r.status === 'pass').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'skip').length} skipped. Report: ${d.reportPath}`,
  );
  return ok ? 0 : 1;
}
