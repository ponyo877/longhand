/**
 * 手直しから学習した結果を、保存先に反映する。貼り付け後の手直し（DictationController）と、
 * 履歴の画面での手直し（main）の両方から使う。
 */
import type { KeptPhrase, LearnedWord, PastCorrection } from '../../shared/types';
import type { CustomizationsStore } from '../store/customizations';
import type { LearnResult, MisheardForm } from './Learner';

export interface AppliedLearning {
  /** 辞書に足した語 */
  words: LearnedWord[];
  /** すでにある語に足した、聞き違えた形 */
  forms: MisheardForm[];
  /** 覚えた取り違えの組（回数を増やしただけのものも含む） */
  corrections: PastCorrection[];
  /** 覚えた、書き換えない語句（回数を増やしただけのものも含む） */
  kept: KeptPhrase[];
  /** 反映した数の合計 */
  count: number;
  /** 今回の反映を取り消す。語は「学習しない語」に入る（以前からの動き）。回数を増やしただけの組と語句は、そのまま残す */
  undo: () => void;
}

type Store = Pick<
  CustomizationsStore,
  'addLearnedWords' | 'addMisheardForms' | 'addPastCorrections' | 'addKeptPhrases' | 'undoLearnedWord' | 'removeMisheardForm' | 'removePastCorrection' | 'removeKeptPhrase'
>;

export function applyLearning(store: Store, r: Pick<LearnResult, 'words' | 'forms' | 'corrections' | 'kept'>, now = Date.now()): AppliedLearning {
  const words = store.addLearnedWords(r.words);
  const forms = store.addMisheardForms(r.forms);
  const corrections = store.addPastCorrections(r.corrections, now);
  const kept = store.addKeptPhrases(r.kept, now);
  return {
    words,
    forms,
    corrections,
    kept,
    count: words.length + forms.length + corrections.length + kept.length,
    undo: () => {
      for (const w of words) store.undoLearnedWord(w.word);
      for (const f of forms) store.removeMisheardForm(f.word, f.from);
      for (const c of corrections) if (c.count <= 1) store.removePastCorrection(c.heard, c.corrected);
      for (const k of kept) if (k.count <= 1) store.removeKeptPhrase(k.phrase, k.changedTo);
    },
  };
}
