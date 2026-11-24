import { describe, expect, it } from 'vitest';
import { styleViolations, toneShift } from '../eval/metrics';
import { normalizeText } from './postprocess';
import { DICTATION_CONTEXT_CHARS, DICTATION_SCHEMA, EDIT_SCHEMA, dictationSystemPrompt, dictationUserMessage, editSystemPrompt, editUserMessage, protectedPhraseList } from './prompts';

/** プロンプトの「# 例」から、入力と出力の組を取り出す */
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

describe('通常の音声入力のプロンプト', () => {
  it('例はどれも JSON として読め、出力は構造化出力の形（text だけ）に合う', () => {
    const ex = examples(dictation);
    expect(ex.length).toBeGreaterThanOrEqual(10);
    for (const { input, output } of ex) {
      expect(typeof input.raw_text).toBe('string');
      expect(Object.keys(output)).toEqual(DICTATION_SCHEMA.required);
      expect(typeof output.text).toBe('string');
    }
  });

  it('例の出力は文体の規則を守る（「！」なし、和英間の空白なし、半角の句読点なし、言いさしに「。」なし）', () => {
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

  it('箇条書きの例は「箇条書きで」と話した 1 件だけで、1 行だけの改行もそこにしか無い', () => {
    const withBullets = examples(dictation).filter(({ output }) => styleViolations(output.text as string).bullets > 0);
    expect(withBullets).toHaveLength(1);
    expect(withBullets[0].input.raw_text).toMatch(/^箇条書きで/);
    const withSingleNewline = examples(dictation).filter(({ output }) => styleViolations(output.text as string).singleNewline > 0);
    expect(withSingleNewline).toEqual(withBullets);
  });

  it('例の出力は口調を硬くしない（生テキストに無い改まった言い方を足さない）', () => {
    for (const { input, output } of examples(dictation)) {
      expect(toneShift(input.raw_text as string, output.text as string)).toBe(0);
    }
  });

  it('例の出力は後処理の正規化を通しても変わらない（プロンプトと後処理の規則が食い違わない）', () => {
    for (const { input, output } of examples(dictation)) {
      const codeLike = /Terminal|iTerm2/.test(String((input.app as { name?: string } | undefined)?.name));
      expect(normalizeText(output.text as string, { language: 'ja', codeLike })).toBe(output.text);
    }
  });

  it('整っている生テキストをそのまま返す例と、言いさしに「。」を付けない例がある', () => {
    const ex = examples(dictation);
    expect(ex.some(({ input, output }) => input.raw_text === output.text && (output.text as string).endsWith('。'))).toBe(true);
    expect(ex.some(({ output }) => (output.text as string).endsWith('けど'))).toBe(true);
  });

  it('ターミナルでも、文として話した内容には句読点を付け、コマンドだけのときは付けない', () => {
    const ex = examples(dictation).filter(({ input }) => /Terminal|iTerm2/.test(String((input.app as { name?: string }).name)));
    expect(ex.some(({ output }) => /[。？]$/.test(output.text as string))).toBe(true);
    expect(ex.some(({ output }) => /^[a-z ]+$/.test(output.text as string))).toBe(true);
  });

  it('規則を明記し、逆向きに引っ張る旧い指示を含まない', () => {
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

  it('プロンプトキャッシュの最小長（512 トークン）を十分に超える長さがある', () => {
    expect(dictation.length).toBeGreaterThan(2000);
  });
});

describe('システムプロンプトの組み立て', () => {
  it('同じ引数なら同じ文字列になる（キャッシュが効く）', () => {
    expect(dictationSystemPrompt(['Longhand'], '指示', ['ほげ'])).toBe(dictationSystemPrompt(['Longhand'], '指示', ['ほげ']));
  });

  it('置換のきっかけを「そのまま残す語句」として、辞書の後、カスタム指示の前に入れる', () => {
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

  it('きっかけが無ければ「そのまま残す語句」の節を入れない', () => {
    expect(dictationSystemPrompt([], '', [])).not.toContain('# そのまま残す語句');
    expect(dictationSystemPrompt([], '')).toBe(dictationSystemPrompt([], '', ['  ']));
  });

  it('protectedPhraseList は空白をそろえ、空と重複を除き、順序を保つ', () => {
    expect(protectedPhraseList(['b', ' a  b ', '', 'b', 'a b'])).toEqual(['b', 'a b']);
  });

  it('編集モードにもきっかけを渡し、カスタム指示は参考として最後に置く', () => {
    const p = editSystemPrompt(['Longhand'], '短く', ['ほげ']);
    expect(p).toContain('# そのまま残す語句');
    expect(p.indexOf('# ユーザーのカスタム指示（参考）')).toBeGreaterThan(p.indexOf('# そのまま残す語句'));
  });
});

describe('編集モードのプロンプト', () => {
  it('例の出力は構造化出力の形に合い、本文が空なのは削除か不明確のときだけ', () => {
    const ex = examples(edit);
    expect(ex.length).toBeGreaterThanOrEqual(4);
    for (const { output } of ex) {
      expect(Object.keys(output).sort()).toEqual([...EDIT_SCHEMA.required].sort());
      if (output.text === '') expect(output.deleted || output.unclear).toBe(true);
    }
  });

  it('言い直した語句で置き換える規則と、口調を勝手に変えない規則がある', () => {
    expect(edit).toContain('選択範囲に入れたい語句や文そのもの');
    expect(edit).toContain('口調や敬語の度合いは、そう指示されたときだけ変える');
    expect(edit).toContain('text を "" にしてよいのは、deleted か unclear が true のときだけ');
  });
});

describe('ユーザーメッセージ', () => {
  it('通常の音声入力は、アプリ、ホスト、入力欄、カーソル前後を JSON で渡す', () => {
    const m = JSON.parse(dictationUserMessage('こんにちは', 'ja', { appName: 'Slack', host: 'example.com', field: 'メッセージ', beforeCursor: 'a', afterCursor: 'b' }));
    expect(m).toEqual({ raw_text: 'こんにちは', language: 'ja', app: { name: 'Slack', host: 'example.com', field: 'メッセージ' }, before_cursor: 'a', after_cursor: 'b' });
  });

  it('通常の音声入力では、カーソル前後をカーソルに近い側から一定の長さに切って渡す（サロゲートペアを壊さない）', () => {
    const before = `${'あ'.repeat(500)}𠮷末尾`;
    const after = `先頭𠮷${'い'.repeat(500)}`;
    const m = JSON.parse(dictationUserMessage('x', 'ja', { beforeCursor: before, afterCursor: after }));
    expect([...m.before_cursor]).toHaveLength(DICTATION_CONTEXT_CHARS);
    expect(m.before_cursor.endsWith('𠮷末尾')).toBe(true);
    expect([...m.after_cursor]).toHaveLength(DICTATION_CONTEXT_CHARS);
    expect(m.after_cursor.startsWith('先頭𠮷')).toBe(true);
  });

  it('辞書の語の候補があれば、最大 8 件を dictionary_candidates として渡す。無ければ入れない', () => {
    const cands = Array.from({ length: 10 }, (_, i) => ({ heard: `くばねてす${i}`, word: 'Kubernetes' }));
    const m = JSON.parse(dictationUserMessage('x', 'ja', {}, [{ heard: ' ', word: 'Longhand' }, ...cands]));
    expect(m.dictionary_candidates).toHaveLength(8);
    expect(m.dictionary_candidates[0]).toEqual({ heard: 'くばねてす0', word: 'Kubernetes' });
    expect(JSON.parse(dictationUserMessage('x', 'ja', {}, [])).dictionary_candidates).toBeUndefined();
    expect(JSON.parse(dictationUserMessage('x', 'ja', {})).dictionary_candidates).toBeUndefined();
  });

  it('辞書の語は文脈上その語を指すときだけ使い、候補も同じ条件で扱う規則がある', () => {
    expect(dictation).toContain('その語を指していると文脈から判断できるとき、辞書の表記で書く');
    expect(dictation).toContain('dictionary_candidates は');
    expect(dictation).not.toContain('読みや響きが近い語が出てきたら辞書の表記に置き換える');
  });

  it('手直しから覚えたことが無ければ、プロンプトは 1 字も変わらない', () => {
    const plain = dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ']);
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', {})).toBe(plain);
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', { misheard: {}, kept: [], hasCorrections: false })).toBe(plain);
    // 辞書に無い語の形は使わない
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', { misheard: { Grafana: ['ぐらふぁな'] } })).toBe(plain);
    expect(JSON.parse(dictationUserMessage('x', 'ja', {})).past_corrections).toBeUndefined();
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', { explainUncertain: false })).toBe(plain);
    expect(dictationSystemPrompt(['Kubernetes'], '短く', ['ほげ'], 'v1', { explainUncertain: true })).toContain('# 聞き違いかもしれない箇所（uncertain）');
  });

  it('聞き違えた形は、辞書の行に添える', () => {
    const p = dictationSystemPrompt(['Kubernetes', 'Claude'], '', [], 'v1', { misheard: { Kubernetes: ['クバネテス', 'くばねてす'] } });
    expect(p).toContain('- Kubernetes（聞き違いの例: クバネテス、くばねてす）\n- Claude\n「聞き違いの例」は、');
  });

  it('書き換えない語句と、以前の手直しの説明を入れる', () => {
    const p = dictationSystemPrompt([], '', [], 'v1', { kept: [{ phrase: 'なんか', changedTo: '何か' }], hasCorrections: true });
    expect(p).toContain('# 書き換えない語句\n');
    expect(p).toContain('- なんか（「何か」にしない）');
    expect(p).toContain('# 以前の手直し（past_corrections）\n');
    // 語句の中の改行と、かぎかっこは、行と引用の形を崩さないように取り除く
    const q = dictationSystemPrompt([], '', [], 'v1', { kept: [{ phrase: 'あ\nい', changedTo: '「う」' }] });
    expect(q).toContain('- あ い（「う」にしない）');
  });

  it('以前の取り違えの組は、ユーザーメッセージで渡す', () => {
    const m = JSON.parse(dictationUserMessage('資料を公正に回します', 'ja', {}, [], [], [], [{ heard: '公正', corrected: '校正' }]));
    expect(m.past_corrections).toEqual([{ heard: '公正', corrected: '校正' }]);
  });

  it('編集モードでも入力欄の説明を渡す', () => {
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
