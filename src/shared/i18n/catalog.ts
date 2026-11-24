/**
 * All messages, merged from the areas in messages/. Each area holds both languages.
 *
 * - common: controls and labels shared by the windows (renderer/common)
 * - app: frame and navigation of the management window (management/App.tsx)
 * - settings: settings page (management/Settings.tsx)
 * - shortcuts: shortcut editor and key names (management/Shortcuts.tsx, shared/keys.ts)
 * - style: style page: dictionary, corrections, number notation (management/Style.tsx)
 * - history: history page (management/History.tsx)
 * - onboarding: first-run setup (management/Onboarding.tsx)
 * - floater: floating bar (floater/)
 * - hud: notifications shown under the floating bar (main/ui/notifications.ts)
 * - tray: menu bar menu and status line (main/ui/tray.ts, main.ts)
 * - main: dialogs, test results and other text from main.ts and main/ui
 * - engine: errors and reasons from the dictation engine that reach the user (session/, llm/, paste/, store/, helper/, ...)
 * - asr: speech recognizer and model download status (main/asr/), and text from main/eval/ that reaches the user
 * - text: text from format/, learn/, vocab/ and textfix/ that reaches the user
 */
import app from './messages/app';
import asr from './messages/asr';
import common from './messages/common';
import engine from './messages/engine';
import floater from './messages/floater';
import history from './messages/history';
import hud from './messages/hud';
import main from './messages/main';
import onboarding from './messages/onboarding';
import settings from './messages/settings';
import shortcuts from './messages/shortcuts';
import style from './messages/style';
import text from './messages/text';
import tray from './messages/tray';

export const catalog = {
  en: {
    ...common.en,
    ...app.en,
    ...settings.en,
    ...shortcuts.en,
    ...style.en,
    ...history.en,
    ...onboarding.en,
    ...floater.en,
    ...hud.en,
    ...tray.en,
    ...main.en,
    ...engine.en,
    ...asr.en,
    ...text.en,
  },
  ja: {
    ...common.ja,
    ...app.ja,
    ...settings.ja,
    ...shortcuts.ja,
    ...style.ja,
    ...history.ja,
    ...onboarding.ja,
    ...floater.ja,
    ...hud.ja,
    ...tray.ja,
    ...main.ja,
    ...engine.ja,
    ...asr.ja,
    ...text.ja,
  },
};
