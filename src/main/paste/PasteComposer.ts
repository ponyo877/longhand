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
 * Builds the text to paste. Applies replacements (FMT-7), spacing fixes (PST-5) and command tokens (PST-6).
 * The return value goes to the helper's paste as it is.
 */
export function composePaste(input: ComposeInput): string {
  if (input.mode === 'edit') {
    if (input.deleted) return '<|BACKSPACE|>';
    return applyReplacements(input.text, input.replacements);
  }
  const replaced = applyReplacements(input.text, input.replacements);
  return applySpacing(replaced, input.beforeCursor, input.afterCursor);
}

/** Defuses sequences in the text that look like command tokens (so the helper never runs them by mistake) */
export function escapeTokens(text: string): string {
  return text.replace(/<\|([A-Z_0-9]+)\|>/g, '<​|$1|>');
}
