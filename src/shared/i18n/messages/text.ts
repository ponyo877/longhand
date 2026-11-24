import { defineMessages } from '../define';

/**
 * Text from format/, learn/, vocab/ and textfix/ that reaches the user: formatting errors shown in notifications ({reason}) and
 * kept in the history (llmError)
 */
export default defineMessages({
  en: {
    // Formatting (format/Formatter.ts)
    'text.format.unparseable': 'Could not read the LLM output',
    'text.format.emptyResult': 'The LLM returned an empty result',
    'text.format.strayedFromTranscript': 'The LLM output strayed too far from the transcript, so the raw text was used',
    'text.format.editNeedsLlm': 'Edit mode needs an LLM to be set up',
  },
  ja: {
    'text.format.unparseable': 'LLM の出力を解釈できませんでした',
    'text.format.emptyResult': 'LLM が空の結果を返しました',
    'text.format.strayedFromTranscript': 'LLM の出力が書き起こしから大きく外れたため、生テキストを使いました',
    'text.format.editNeedsLlm': '編集モードには LLM の設定が必要です',
  },
});
