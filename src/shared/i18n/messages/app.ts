import { defineMessages } from '../define';

export default defineMessages({
  en: {
    'app.nav.history': 'History',
    'app.nav.style': 'Style',
    'app.nav.settings': 'Settings',
    'app.problem.helper': 'Helper',
    'app.problem.asr': 'Speech recognition',
    'app.problem.accessibility': 'Accessibility',
    'app.problem.microphone': 'Microphone',
    'app.problem.llm': 'LLM',
    'app.status.check': 'Check {items}',
    'app.status.ready': 'Ready · Hold {activate} to talk',
    'app.accessibility.lostTitle': 'Accessibility permission was turned off',
    'app.accessibility.neededTitle': 'Accessibility permission is needed',
    'app.accessibility.lostBody':
      'Longhand cannot detect keys or type. Turn Longhand (Electron while developing) back on in System Settings > Privacy & Security > Accessibility. It starts working as soon as it is on.',
    'app.accessibility.neededBody':
      'Longhand cannot detect keys or type. Turn on Longhand (Electron while developing) in System Settings > Privacy & Security > Accessibility. It starts working as soon as it is on.',
  },
  ja: {
    'app.nav.history': '履歴',
    'app.nav.style': 'スタイル',
    'app.nav.settings': '設定',
    'app.problem.helper': 'ヘルパー',
    'app.problem.asr': '音声認識',
    'app.problem.accessibility': 'アクセシビリティ',
    'app.problem.microphone': 'マイク',
    'app.problem.llm': 'LLM',
    'app.status.check': '{items}を確認',
    'app.status.ready': '準備完了 · {activate} で話す',
    'app.accessibility.lostTitle': 'アクセシビリティの許可が外れました',
    'app.accessibility.neededTitle': 'アクセシビリティの許可が必要です',
    'app.accessibility.lostBody':
      'キーの検出と入力ができません。システム設定の「プライバシーとセキュリティ」で、Longhand（開発中は Electron）をオンにし直してください。オンにすると自動で使えるようになります。',
    'app.accessibility.neededBody':
      'キーの検出と入力ができません。システム設定の「プライバシーとセキュリティ」で、Longhand（開発中は Electron）をオンにしてください。オンにすると自動で使えるようになります。',
  },
});
