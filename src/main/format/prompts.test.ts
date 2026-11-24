import { describe, expect, it } from 'vitest';
import { styleViolations, toneShift } from '../eval/metrics';
import { normalizeText } from './postprocess';
import { DICTATION_CONTEXT_CHARS, DICTATION_SCHEMA, EDIT_SCHEMA, dictationSystemPrompt, dictationUserMessage, editSystemPrompt, editUserMessage, protectedPhraseList } from './prompts';

/** Extracts input and output pairs from the prompt's 「# 例」 section */
function examples(prompt: string): { input: Record<string, unknown>; output: Record<string, unknown> }[] {
  const lines = prompt.split('\n');
  const out: { input: Record<string, unknown>; output: Record<string, unknown> }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('入力: ')) continue;
    expect(lines[i + 1].startsWith('出力: ')).toBe(true);
    out.push({ input: JSON.parse(lines[i].slice(4)), output: JSON.parse(lines[i + 1].slice(4)) });
  }
  return out;
}

const dictation = dictationSystemPrompt([], '');
const edit = editSystemPrompt([], '');

describe('dictation prompt', () => {
  it('has examples that all parse as JSON, with outputs matching the structured output shape (text only)', () => {
    const ex = examples(dictation);
    expect(ex.length).toBeGreaterThanOrEqual(10);
    for (const { input, output } of ex) {
      expect(typeof input.raw_text).toBe('string');
      expect(Object.keys(output)).toEqual(DICTATION_SCHEMA.required);
      expect(typeof output.text).toBe('string');
    }
  });

  it('has example outputs that follow the style rules (no 「！」, no space between Japanese and Latin text, no half-width punctuation, no 「。」 after a trailing-off ending)', () => {
    for (const { output } of examples(dictation)) {
      const v = styleViolations(output.text as string);
      expect(v.exclamation).toBe(0);
      expect(v.jaLatinSpace).toBe(0);
      expect(v.jaSpace).toBe(0);
      expect(v.halfWidthPunct).toBe(0);
      expect(v.periodAfterConjunction).toBe(0);
      expect(v.markdown).toBe(0);
    }
  });

  it('has only one bulleted example, where 「箇条書きで」 was spoken, and single line breaks appear only there', () => {
    const withBullets = examples(dictation).filter(({ output }) => styleViolations(output.text as string).bullets > 0);
    expect(withBullets).toHaveLength(1);
    expect(withBullets[0].input.raw_text).toMatch(/^箇条書きで/);
    const withSingleNewline = examples(dictation).filter(({ output }) => styleViolations(output.text as string).singleNewline > 0);
    expect(withSingleNewline).toEqual(withBullets);
  });

  it('has example outputs that do not stiffen the tone (no formal phrasing absent from the raw text)', () => {
    for (const { input, output } of examples(dictation)) {
      expect(toneShift(input.raw_text as string, output.text as string)).toBe(0);
    }
  });

  it('has example outputs unchanged by post-processing normalization (the prompt and post-processing rules agree)', () => {
    for (const { input, output } of examples(dictation)) {
      const codeLike = /Terminal|iTerm2/.test(String((input.app as { name?: string } | undefined)?.name));
      expect(normalizeText(output.text as string, { language: 'ja', codeLike })).toBe(output.text);
    }
  });

  it('has an example returning clean raw text unchanged and one leaving 「。」 off a trailing-off ending', () => {
    const ex = examples(dictation);
    expect(ex.some(({ input, output }) => input.raw_text === output.text && (output.text as string).endsWith('。'))).toBe(true);
    expect(ex.some(({ output }) => (output.text as string).endsWith('けど'))).toBe(true);
  });

  it('punctuates sentences even in a terminal, but not a bare command', () => {
    const ex = examples(dictation).filter(({ input }) => /Terminal|iTerm2/.test(String((input.app as { name?: string }).name)));
    expect(ex.some(({ output }) => /[。？]$/.test(output.text as string))).toBe(true);
    expect(ex.some(({ output }) => /^[a-z ]+$/.test(output.text as string))).toBe(true);
  });

  it('states the rules and contains no old instructions that pull the other way', () => {
    expect(dictation).toContain('「！」は使わない');
    expect(dictation).toContain('日本語と英字、日本語と数字の間に空白を入れない');
    expect(dictation).toContain('一字も変えずにそのまま返します');
    expect(dictation).toContain('入力先がメールでも、丁寧な言い方に直しません');
    expect(dictation).toContain('末尾に「。」を付けない');
    expect(dictation).not.toContain('簡潔にし');
    expect(dictation).not.toContain('文末の句点を付けない');
    expect(dictation).not.toContain('git status を');
    expect(dictation).not.toContain('3 つ以上の項目を並べている場合');
  });

  it('is well over the minimum length for prompt caching (512 tokens)', () => {
    expect(dictation.length).toBeGreaterThan(2000);
  });
});

describe('system prompt assembly', () => {
  it('returns the same string for the same arguments (so caching works)', () => {
    expect(dictationSystemPrompt(['Longhand'], '指示', ['ほげ'])).toBe(dictationSystemPrompt(['Longhand'], '指示', ['ほげ']));
  });

  it('puts replacement triggers under 「そのまま残す語句」, after the dictionary and before the custom instructions', () => {
    const p = dictationSystemPrompt(['Kubernetes'], '敬体で書く', ['じーめーる', ' じーめーる ', '', 'しーぷらぷら']);
    const iDict = p.indexOf('# 辞書（dictionary）');
    const iKeep = p.indexOf('# そのまま残す語句');
    const iCustom = p.indexOf('# ユーザーのカスタム指示');
    expect(iDict).toBeGreaterThan(0);
    expect(iKeep).toBeGreaterThan(iDict);
    expect(iCustom).toBeGreaterThan(iKeep);
    expect(p.match(/^- じーめーる$/gm)).toHaveLength(1);
    expect(p).toContain('- しーぷらぷら');
  });

  it('leaves out the 「そのまま残す語句」 section when there are no triggers', () => {
    expect(dictationSystemPrompt([], '', [])).not.toContain('# そのまま残す語句');
    expect(dictationSystemPrompt([], '')).toBe(dictationSystemPrompt([], '', ['  ']));
  });

  it('normalizes whitespace in protectedPhraseList, drops empty and duplicate phrases, and keeps the order', () => {
    expect(protectedPhraseList(['b', ' a  b ', '', 'b', 'a b'])).toEqual(['b', 'a b']);
  });

  it('passes triggers in edit mode too and puts custom instructions last, for reference', () => {
    const p = editSystemPrompt(['Longhand'], '短く', ['ほげ']);
    expect(p).toContain('# そのまま残す語句');
    expect(p.indexOf('# ユーザーのカスタム指示（参考）')).toBeGreaterThan(p.indexOf('# そのまま残す語句'));
  });
});

describe('edit mode prompt', () => {
  it('has example outputs matching the structured output shape, with empty text only for deletions or unclear instructions', () => {
    const ex = examples(edit);
    expect(ex.length).toBeGreaterThanOrEqual(4);
    for (const { output } of ex) {
      expect(Object.keys(output).sort()).toEqual([...EDIT_SCHEMA.required].sort());
      if (output.text === '') expect(output.deleted || output.unclear).toBe(true);
    }
  });

  it('has a rule to use the restated phrase and a rule not to change the tone on its own', () => {
    expect(edit).toContain('選択範囲に入れたい語句や文そのもの');
    expect(edit).toContain('口調や敬語の度合いは、そう指示されたときだけ変える');
    expect(edit).toContain('text を "" にしてよいのは、deleted か unclear が true のときだけ');
  });
});

describe('user message', () => {
  it('passes the app, host, field and text around the cursor as JSON for dictation', () => {
    const m = JSON.parse(dictationUserMessage('こんにちは', 'ja', { appName: 'Slack', host: 'example.com', field: 'メッセージ', beforeCursor: 'a', afterCursor: 'b' }));
    expect(m).toEqual({ raw_text: 'こんにちは', language: 'ja', app: { name: 'Slack', host: 'example.com', field: 'メッセージ' }, before_cursor: 'a', after_cursor: 'b' });
  });

  it('cuts the text around the cursor to a fixed length from the cursor side for dictation (without breaking surrogate pairs)', () => {
    const before = `${'あ'.repeat(500)}𠮷末尾`;
    const after = `先頭𠮷${'い'.repeat(500)}`;
    const m = JSON.parse(dictationUserMessage('x', 'ja', { beforeCursor: before, afterCursor: after }));
    expect([...m.before_cursor]).toHaveLength(DICTATION_CONTEXT_CHARS);
    expect(m.before_cursor.endsWith('𠮷末尾')).toBe(true);
    expect([...m.after_cursor]).toHaveLength(DICTATION_CONTEXT_CHARS);
    expect(m.after_cursor.startsWith('先頭𠮷')).toBe(true);
  });

  it('passes up to 8 dictionary word candidates as dictionary_candidates, and omits the field when there are none', () => {
    const cands = Array.from({ length: 10 }, (_, i) => ({ heard: `くばねてす${i}`, word: 'Kubernetes' }));
    const m = JSON.parse(dictationUserMessage('x', 'ja', {}, [{ heard: ' ', word: 'Longhand' }, ...cands]));
    expect(m.dictionary_candidates).toHaveLength(8);
    expect(m.dictionary_candidates[0]).toEqual({ heard: 'くばねてす0', word: 'Kubernetes' });
    expect(JSON.parse(dictationUserMessage('x', 'ja', {}, [])).dictionary_candidates).toBeUndefined();
    expect(JSON.parse(dictationUserMessage('x', 'ja', {})).dictionary_candidates).toBeUndefined();
  });

  it('has a rule to use dictionary words only when the context points to them, and to treat candidates the same way', () => {
    expect(dictation).toContain('その語を指していると文脈から判断できるとき、辞書の表記で書く');
    expect(dictation).toContain('dictionary_candidates は');
    expect(dictation).not.toContain('読みや響きが近い語が出てきたら辞書の表記に置き換える');
  });

  it('leaves the prompt unchanged to the character without anything learned from corrections', () => {
    const plain = dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ']);
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', {})).toBe(plain);
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', { misheard: {}, kept: [], hasCorrections: false })).toBe(plain);
    // Forms of words not in the dictionary are not used
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', { misheard: { Grafana: ['ぐらふぁな'] } })).toBe(plain);
    expect(JSON.parse(dictationUserMessage('x', 'ja', {})).past_corrections).toBeUndefined();
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', { explainUncertain: false })).toBe(plain);
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', { explainUncertain: true })).toContain('# 聞き違いかもしれない箇所（uncertain）');
  });

  it('adds misheard forms to the dictionary line', () => {
    const p = dictationSystemPrompt(['Kubernetes', 'Claude'], '', [], 'v1', { misheard: { Kubernetes: ['クバネテス', 'くばねてす'] } });
    expect(p).toContain('- Kubernetes（聞き違いの例: クバネテス、くばねてす）\n- Claude\n「聞き違いの例」は、');
  });

  it('adds the phrases not to rewrite and the explanation of past corrections', () => {
    const p = dictationSystemPrompt([], '', [], 'v1', { kept: [{ phrase: 'なんか', changedTo: '何か' }], hasCorrections: true });
    expect(p).toContain('# 書き換えない語句\n');
    expect(p).toContain('- なんか（「何か」にしない）');
    expect(p).toContain('# 以前の手直し（past_corrections）\n');
    // Newlines and corner brackets inside phrases are removed so the line and quotation structure stays intact
    const q = dictationSystemPrompt([], '', [], 'v1', { kept: [{ phrase: 'あ\nい', changedTo: '「う」' }] });
    expect(q).toContain('- あ い（「う」にしない）');
  });

  it('passes past mix-up pairs in the user message', () => {
    const m = JSON.parse(dictationUserMessage('資料を公正に回します', 'ja', {}, [], [], [], [{ heard: '公正', corrected: '校正' }]));
    expect(m.past_corrections).toEqual([{ heard: '公正', corrected: '校正' }]);
  });

  it('passes the field description in edit mode too', () => {
    const m = JSON.parse(editUserMessage('明日', '明後日', 'ja', { appName: 'メモ', field: '本文' }));
    expect(m).toEqual({ selected_text: '明日', instruction: '明後日', language: 'ja', app: { name: 'メモ', field: '本文' } });
  });
});

describe('number notation in the system prompt', () => {
  it('adds a section only when preferences exist, and keeps the prompt identical otherwise', () => {
    const plain = dictationSystemPrompt([], '');
    expect(dictationSystemPrompt([], '', [], 'v1', { numberStyle: {} })).toBe(plain);
    const withStyle = dictationSystemPrompt([], '', [], 'v1', { numberStyle: { counters: { value: 'kanji', count: 1, at: 0 } } });
    expect(withStyle.startsWith(plain)).toBe(true);
    expect(withStyle).toContain('# 数字の書き方');
    expect(withStyle).toContain('「二つ」');
  });
});
