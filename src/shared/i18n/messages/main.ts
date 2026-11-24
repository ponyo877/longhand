import { defineMessages } from '../define';

/** Dialogs, menus, test results and errors from main.ts */
export default defineMessages({
  en: {
    // Right-click menu of the floating bar (UI-5). Items shared with the menu bar menu come from tray.menu.*
    'main.floaterMenu.finishAndPaste': 'Finish and Paste',
    'main.floaterMenu.startHandsFree': 'Start Recording (Hands-Free)',
    'main.floaterMenu.hide': 'Hide Floating Bar',
    'main.floaterMenu.minutes': (v) => (Number(v.minutes) === 1 ? 'For 1 Minute' : 'For {minutes} Minutes'),
    'main.floaterMenu.hour': 'For 1 Hour',
    'main.floaterMenu.untilShown': 'Until Shown Again',

    // Application menu
    'main.appMenu.closeWindow': 'Close Window',
    'main.appMenu.window': 'Window',

    'main.dialog.importModel': 'Choose Model Files or Folders',

    // Connection, recognizer and microphone tests in settings
    'main.test.llmNotConfigured': 'The endpoint, the model name or the API key is not set',
    'main.test.asrNotReady': 'Speech recognition is not ready',
    'main.test.silence': '(silence)',
    'main.test.micWhileRecording': 'You cannot test while recording',

    // Redoing and editing history items
    'main.history.notFound': 'The history item was not found',
    'main.history.editCannotRedo': 'Results of edit mode cannot be redone',
    'main.history.noRecording': 'The recording is no longer kept',
    'main.history.asrNotReady': 'Speech recognition is not ready',
    'main.history.readFailed': 'Could not read the recording',
    'main.history.transcribeFailed': 'Could not transcribe: {error}',
    'main.history.noSpeech': 'Could not hear any speech',
    'main.history.noTranscript': 'There is no transcript. Transcribe it again first',
    'main.history.empty': 'The text cannot be empty. To remove the item, use “Delete”',
  },
  ja: {
    'main.floaterMenu.finishAndPaste': '確定して貼り付け',
    'main.floaterMenu.startHandsFree': '録音を開始（ハンズフリー）',
    'main.floaterMenu.hide': 'フローティングバーを隠す',
    'main.floaterMenu.minutes': '{minutes} 分間',
    'main.floaterMenu.hour': '1 時間',
    'main.floaterMenu.untilShown': '戻すまで',

    'main.appMenu.closeWindow': 'ウィンドウを閉じる',
    'main.appMenu.window': 'ウィンドウ',

    'main.dialog.importModel': 'モデルのファイルかフォルダを選ぶ',

    'main.test.llmNotConfigured': '接続先、モデル名、API キーのいずれかが未設定です',
    'main.test.asrNotReady': '音声認識が準備できていません',
    'main.test.silence': '（無音）',
    'main.test.micWhileRecording': '録音中は試せません',

    'main.history.notFound': '履歴が見つかりません',
    'main.history.editCannotRedo': '編集の結果はやり直せません',
    'main.history.noRecording': '録音が残っていません',
    'main.history.asrNotReady': '音声認識の準備ができていません',
    'main.history.readFailed': '録音を読み込めませんでした',
    'main.history.transcribeFailed': '書き起こしに失敗しました: {error}',
    'main.history.noSpeech': '音声を聞き取れませんでした',
    'main.history.noTranscript': '書き起こしがありません。先に書き起こし直してください',
    'main.history.empty': '空にはできません。消すときは「削除」を使ってください',
  },
});
