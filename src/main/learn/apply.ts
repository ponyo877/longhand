/**
 * Saves what was learned from a correction. Used both for corrections after a paste (DictationController)
 * and for corrections in the history page (main).
 */
import type { KeptPhrase, LearnedWord, PastCorrection } from '../../shared/types';
import type { AppliedNumberStyle, CustomizationsStore } from '../store/customizations';
import type { LearnResult, MisheardForm } from './Learner';

export interface AppliedLearning {
  /** Words added to the dictionary */
  words: LearnedWord[];
  /** Misheard forms added to existing words */
  forms: MisheardForm[];
  /** Mix-up pairs learned (including ones whose count was only increased) */
  corrections: PastCorrection[];
  /** Phrases not to rewrite learned (including ones whose count was only increased) */
  kept: KeptPhrase[];
  /** Number notation preferences that were set or confirmed */
  numbers: AppliedNumberStyle[];
  /** Total number of items saved */
  count: number;
  /** Undoes this save. Words go to the list of words not to learn (the existing behavior). Pairs and phrases whose count was only increased stay as they are */
  undo: () => void;
}

type Store = Pick<
  CustomizationsStore,
  | 'addLearnedWords'
  | 'addMisheardForms'
  | 'addPastCorrections'
  | 'addKeptPhrases'
  | 'addNumberStyles'
  | 'undoLearnedWord'
  | 'removeMisheardForm'
  | 'removePastCorrection'
  | 'removeKeptPhrase'
  | 'setNumberStyle'
>;

export function applyLearning(store: Store, r: Pick<LearnResult, 'words' | 'forms' | 'corrections' | 'kept'> & Partial<Pick<LearnResult, 'numbers'>>, now = Date.now()): AppliedLearning {
  const words = store.addLearnedWords(r.words);
  const forms = store.addMisheardForms(r.forms);
  const corrections = store.addPastCorrections(r.corrections, now);
  const kept = store.addKeptPhrases(r.kept, now);
  const numbers = store.addNumberStyles(r.numbers ?? [], now);
  return {
    words,
    forms,
    corrections,
    kept,
    numbers,
    count: words.length + forms.length + corrections.length + kept.length + numbers.length,
    undo: () => {
      for (const w of words) store.undoLearnedWord(w.word);
      for (const f of forms) store.removeMisheardForm(f.word, f.from);
      for (const c of corrections) if (c.count <= 1) store.removePastCorrection(c.heard, c.corrected);
      for (const k of kept) if (k.count <= 1) store.removeKeptPhrase(k.phrase, k.changedTo);
      // Put back the notation the user had before this correction
      for (const n of numbers) store.setNumberStyle(n.kind, n.previous);
    },
  };
}
