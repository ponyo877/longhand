import type { Replacement } from '../../shared/types';
import { applyReplacements, applySpacing } from '../format/postprocess';

export interface ComposeInput {
  mode: 'dictation' | 'edit';
  text: string;
  deleted?: boolean;
  replacements: Replacement[];
  beforeCursor?: string;
  afterCursor?: string;
}

/**
 * 貼り付ける文字列を組み立てる。置換（FMT-7）、スペース補正（PST-5）、コマンド記法（PST-6）を適用する。
 * 戻り値はヘルパーの paste にそのまま渡す。
 */
export function composePaste(input: ComposeInput): string {
  if (input.mode === 'edit') {
    if (input.deleted) return '<|BACKSPACE|>';
    return applyReplacements(input.text, input.replacements);
  }
  const replaced = applyReplacements(input.text, input.replacements);
  return applySpacing(replaced, input.beforeCursor, input.afterCursor);
}

/** 本文にコマンド記法と紛らわしい列が含まれていたら無害化する（ヘルパーが誤って実行しないように） */
export function escapeTokens(text: string): string {
  return text.replace(/<\|([A-Z_0-9]+)\|>/g, '<​|$1|>');
}
