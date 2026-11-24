import { defineMessages } from '../define';

/**
 * Errors and reasons from the dictation engine that reach the user: notification bodies ({reason}), the connection test, and
 * errors kept in the history (llmError)
 */
export default defineMessages({
  en: {
    // Dictation (session/DictationController.ts)
    'engine.session.asrStarting': 'Speech recognition is starting',
    'engine.session.asrNotReady': 'Speech recognition is not ready',
    'engine.session.transcriptionFailed': 'Transcription failed: {reason}',
    /** Button on the notification after learning from a correction */
    'engine.session.undoLearning': 'Undo',

    // Paste failures (helper's failureReason)
    'engine.paste.editTargetChanged': 'The selection changed before the text was replaced',
    'engine.paste.appChanged': 'The app in front changed before the text was pasted',
    'engine.paste.noTextTarget': 'There is no text field to type into',
    'engine.paste.secureField': 'Longhand does not type into password fields',
    'engine.paste.pasteboardError': 'The clipboard could not be used',
    'engine.paste.notTrusted': 'Accessibility permission is needed',

    // Helper (helper/HelperClient.ts)
    'engine.helper.notRunning': 'The helper is not running',
    /** {what} is a message name such as audio_started */
    'engine.helper.exitedWhileWaiting': 'The helper quit while waiting for {what}',
    'engine.helper.timedOut': 'The helper did not send {what} within {timeoutMs} ms',
    /** {what} is a request name such as paste */
    'engine.helper.requestTimedOut': 'The helper did not answer {what} within {timeoutMs} ms',
    /** {message} comes from the helper, {code} is an error code such as no_device */
    'engine.helper.audioError': '{message} ({code})',

    // LLM (llm/)
    'engine.llm.noApiKey': 'No API key is set',
    'engine.llm.noModel': 'No model name is set',
    'engine.llm.noUrl': 'No endpoint URL is set',
    'engine.llm.noAzureEndpoint': 'No Azure endpoint is set',
    'engine.llm.noDeployment': 'No deployment name is set',
    'engine.llm.unknownProvider': 'Unknown provider: {provider}',
    'engine.llm.extraBodyNotObject': 'extraBody must be a JSON object',
    /** {variable} is a template variable such as {{user}} */
    'engine.llm.unknownTemplateVariable': 'The template variable {variable} is not available',
    'engine.llm.templateNotJson': 'The request template is not valid JSON: {reason}',
    /** {path} is the response path from the settings, such as choices.0.message.content */
    'engine.llm.noStringAtPath': 'The response has no string at {path}',
    'engine.llm.timeout': (v) => (Number(v.seconds) === 1 ? 'The LLM did not respond within 1 second' : 'The LLM did not respond within {seconds} seconds'),
    'engine.llm.aborted': 'Interrupted',
    'engine.llm.network': 'Could not connect: {reason}',
    'engine.llm.readFailed': 'Could not read the response: {reason}',
    'engine.llm.auth': 'Authentication failed ({status}): {reason}',
    'engine.llm.rateLimit': 'Usage limit reached (429): {reason}',
    'engine.llm.refusal': 'The model refused to respond',
    'engine.llm.truncated': 'The output was cut off at the limit',
    'engine.llm.retriesExhausted': 'The LLM call failed (retry limit reached)',
  },
  ja: {
    'engine.session.asrStarting': 'ASR を起動しています',
    'engine.session.asrNotReady': 'ASR が準備できていません',
    'engine.session.transcriptionFailed': '書き起こしに失敗: {reason}',
    'engine.session.undoLearning': '取り消す',

    'engine.paste.editTargetChanged': '書き換える前に選択範囲が変わりました',
    'engine.paste.appChanged': '貼り付ける前に前面のアプリが変わりました',
    'engine.paste.noTextTarget': '入力できる欄がありません',
    'engine.paste.secureField': 'パスワードの入力欄には入力しません',
    'engine.paste.pasteboardError': 'クリップボードを使えませんでした',
    'engine.paste.notTrusted': 'アクセシビリティの許可が必要です',
    'engine.helper.notRunning': 'ヘルパーが動いていません',
    'engine.helper.exitedWhileWaiting': '{what} を待つ間にヘルパーが終了しました',
    'engine.helper.timedOut': 'helper の {what} が {timeoutMs}ms 以内に届きませんでした',
    'engine.helper.requestTimedOut': 'ヘルパーが {what} に {timeoutMs}ms 以内に応答しませんでした',
    'engine.helper.audioError': '{message}（{code}）',

    'engine.llm.noApiKey': 'API キーが設定されていません',
    'engine.llm.noModel': 'モデル名が設定されていません',
    'engine.llm.noUrl': '接続先の URL が設定されていません',
    'engine.llm.noAzureEndpoint': 'Azure のエンドポイントが設定されていません',
    'engine.llm.noDeployment': 'デプロイメント名が設定されていません',
    'engine.llm.unknownProvider': '未知のプロバイダです: {provider}',
    'engine.llm.extraBodyNotObject': 'extraBody は JSON オブジェクトにしてください',
    'engine.llm.unknownTemplateVariable': 'テンプレートの変数 {variable} は使えません',
    'engine.llm.templateNotJson': 'リクエストのテンプレートが JSON になりません: {reason}',
    'engine.llm.noStringAtPath': '応答の {path} に文字列がありません',
    'engine.llm.timeout': 'LLM が {seconds} 秒以内に応答しませんでした',
    'engine.llm.aborted': '中断しました',
    'engine.llm.network': '接続できませんでした: {reason}',
    'engine.llm.readFailed': '応答の読み取りに失敗しました: {reason}',
    'engine.llm.auth': '認証に失敗しました（{status}）: {reason}',
    'engine.llm.rateLimit': '利用上限に達しました（429）: {reason}',
    'engine.llm.refusal': 'モデルが応答を拒否しました',
    'engine.llm.truncated': '出力が上限で切れました',
    'engine.llm.retriesExhausted': 'LLM の呼び出しに失敗しました（再試行の上限）',
  },
});
