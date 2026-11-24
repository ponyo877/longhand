import { defineMessages } from '../define';

export default defineMessages({
  en: {
    'asr.cancelled': 'Transcription canceled',
    'asr.notReady': 'Speech recognition is not ready',
    'asr.workerMissing': 'Speech recognition worker not found: {path} (build it with npm run build:asr)',
    'asr.workerExited': 'The speech recognition worker stopped. Restarting…',
    'asr.modelMissing.download': 'No speech recognition model ({dir}). Download it from “Speech Recognition” in Settings > Connection.',
    'asr.modelMissing.script': 'No speech recognition model ({dir}). Get it with asr/download-models.sh --{engine}.',
    'asr.modelFileMissing': 'Speech recognition model not found: {path}',
    'asr.download.noSpace': 'Not enough free space ({needed} GB needed, {free} GB available)',
    'asr.download.resumeFailed': 'Could not resume the partly downloaded file',
    'asr.download.http': 'HTTP {status} ({url})',
    'asr.download.truncated': 'The download was cut off ({got}/{size} bytes)',
    'asr.download.hashMismatch': 'SHA-256 does not match: {file}',
  },
  ja: {
    'asr.cancelled': '書き起こしを取り消しました',
    'asr.notReady': 'ASR が準備できていません',
    'asr.workerMissing': 'ASR ワーカーが見つかりません: {path}（npm run build:asr でビルドしてください）',
    'asr.workerExited': 'ASR ワーカーが終了しました。再起動しています',
    'asr.modelMissing.download': '音声認識のモデルがありません（{dir}）。設定 > 接続 の「音声認識」からダウンロードしてください',
    'asr.modelMissing.script': '音声認識のモデルがありません（{dir}）。asr/download-models.sh --{engine} で取得してください',
    'asr.modelFileMissing': 'ASR のモデルが見つかりません: {path}',
    'asr.download.noSpace': '空き容量が足りません（必要 {needed} GB、空き {free} GB）',
    'asr.download.resumeFailed': '途中まで取得したファイルを再開できませんでした',
    'asr.download.http': 'HTTP {status}（{url}）',
    'asr.download.truncated': '途中で切れました（{got}/{size} バイト）',
    'asr.download.hashMismatch': 'SHA-256 が一致しません: {file}',
  },
});
