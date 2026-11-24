import { defineMessages } from '../define';

export default defineMessages({
  en: {
    'floater.stage.transcribing': 'Transcribing',
    'floater.stage.formatting': 'Formatting',
    'floater.stage.pasting': 'Inserting',
    'floater.stage.rewriting': 'Rewriting',
    /** Shown in the bar when the edit instruction was not understood (F6) */
    'floater.sayAgain': 'Please say that again',
    /** Read out for the short flash after a successful paste (F5) */
    'floater.pasted': 'Inserted',
    'floater.idle.preparing': 'Preparing speech recognition…',
    'floater.idle.unavailable': 'Speech recognition is unavailable. Right-click to open Settings',
    'floater.idle.hint': 'Click to record, or hold {activate} to talk',
    /** {count} is already formatted for the interface language */
    'floater.editMode': (v) => (String(v.count) === '1' ? 'Edit mode · 1 character selected' : 'Edit mode · {count} characters selected'),
    'floater.recording': 'Recording',
    'floater.micPreparing': 'Preparing the microphone',
    'floater.cancel': 'Cancel',
    'floater.finish': 'Finish and Insert',
    'floater.hud.mute': 'Don’t Show Again',
    'floater.hud.close': 'Close',
  },
  ja: {
    'floater.stage.transcribing': '書き起こし中',
    'floater.stage.formatting': '整形中',
    'floater.stage.pasting': '入力中',
    'floater.stage.rewriting': '書き換え中',
    'floater.sayAgain': '言い直してください',
    'floater.pasted': '入力しました',
    'floater.idle.preparing': '音声認識を準備しています…',
    'floater.idle.unavailable': '音声認識が使えません。右クリックで設定を開けます',
    'floater.idle.hint': 'クリックで録音、{activate} を押しながら話す',
    'floater.editMode': '編集モード · {count} 文字を選択中',
    'floater.recording': '録音中',
    'floater.micPreparing': 'マイクを準備しています',
    'floater.cancel': '取り消す',
    'floater.finish': '確定して入力',
    'floater.hud.mute': '今後表示しない',
    'floater.hud.close': '閉じる',
  },
});
