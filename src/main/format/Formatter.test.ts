import { describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest } from '../llm/types';
import { LlmError } from '../llm/types';
import { formatText, type FormatInput } from './Formatter';

/** 受け取った要求を記録し、用意した応答を返す偽のプロバイダ */
function fake(reply: string | ((req: LlmRequest) => string) | Error) {
  const calls: LlmRequest[] = [];
  const provider: LlmProvider = {
    kind: 'fake',
    async complete(req) {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === 'function' ? reply(req) : reply, model: 'fake-model', elapsedMs: 1 };
    },
  };
  return { provider, calls };
}

const base = (over: Partial<FormatInput>): FormatInput => ({
  mode: 'dictation',
  rawText: '',
  language: 'ja',
  context: {},
  vocabulary: [],
  customInstructions: '',
  provider: null,
  timeoutMs: 1000,
  maxOutputTokens: 1024,
  ...over,
});

describe('formatText（通常の音声入力）', () => {
  it('LLM の出力にも正規化を掛ける（和英間の空白、半角の「?」）', async () => {
    const f = fake('{"text": "Slack で 共有しましたか?"}');
    const r = await formatText(base({ rawText: 'すらっくで共有しましたか', provider: f.provider }));
    expect(r).toMatchObject({ text: 'Slackで共有しましたか？', formatted: true });
  });

  it('LLM が無いときも、生テキストを正規化して返す', async () => {
    const r = await formatText(base({ rawText: 'Notion に まとめました' }));
    expect(r).toMatchObject({ text: 'Notionにまとめました', formatted: false });
  });

  it('ターミナルでは和英間の空白を残す（アプリ名から推定、明示もできる）', async () => {
    const f = fake('{"text": "mkdir 資料"}');
    expect((await formatText(base({ rawText: 'x', provider: f.provider, context: { appName: 'Terminal' } }))).text).toBe('mkdir 資料');
    expect((await formatText(base({ rawText: 'x', provider: f.provider, codeLike: true }))).text).toBe('mkdir 資料');
    expect((await formatText(base({ rawText: 'x', provider: f.provider, context: { appName: 'Slack' } }))).text).toBe('mkdir資料');
  });

  it('置換のきっかけをシステムプロンプトに渡す', async () => {
    const f = fake('{"text": "ほげです。"}');
    await formatText(base({ rawText: 'ほげです', provider: f.provider, protectedPhrases: ['ほげ'] }));
    expect(f.calls[0].system).toContain('# そのまま残す語句\n');
    expect(f.calls[0].system).toContain('- ほげ');
  });

  it('以前の取り違えの組があれば近道に入らず、組をユーザーメッセージで、覚えたことをシステムプロンプトで渡す', async () => {
    const f = fake('{"text": "資料を校正に回します。"}');
    const r = await formatText(
      base({
        rawText: '資料を公正に回します。',
        provider: f.provider,
        fastPath: true,
        pastCorrections: [{ heard: '公正', corrected: '校正' }],
        learned: { hasCorrections: true, kept: [{ phrase: 'なんか', changedTo: '何か' }] },
      }),
    );
    expect(r).toMatchObject({ text: '資料を校正に回します。', formatted: true });
    expect(r.fastPath).toBeUndefined();
    expect(JSON.parse(f.calls[0].user).past_corrections).toEqual([{ heard: '公正', corrected: '校正' }]);
    expect(f.calls[0].system).toContain('# 以前の手直し（past_corrections）');
    expect(f.calls[0].system).toContain('- なんか（「何か」にしない）');
  });

  it('食い違った箇所は、設定がオンのときだけ LLM に渡す。渡すときは近道に入らず、説明をシステムプロンプトに足す', async () => {
    const uncertain = [{ heard: '剣', alternatives: ['件'] }];
    const off = fake('{"text": "その剣は来週です。"}');
    const r0 = await formatText(base({ rawText: 'その剣は来週です。', provider: off.provider, fastPath: true, uncertain }));
    expect(r0.fastPath).toBe(true);
    expect(off.calls).toHaveLength(0);

    const on = fake('{"text": "その件は来週です。"}');
    const r1 = await formatText(base({ rawText: 'その剣は来週です。', provider: on.provider, fastPath: true, uncertain, useUncertain: true }));
    expect(r1).toMatchObject({ text: 'その件は来週です。', formatted: true });
    expect(r1.fastPath).toBeUndefined();
    expect(JSON.parse(on.calls[0].user).uncertain).toEqual([{ heard: '剣', alternatives: ['件'] }]);
    expect(on.calls[0].system).toContain('# 聞き違いかもしれない箇所（uncertain）');
  });

  it('辞書の語の候補をユーザーメッセージで渡し、候補があれば近道に入らない', async () => {
    const f = fake('{"text": "明日の会議は午後からです。"}');
    await formatText(base({ rawText: '明日の会議は午後からです。', provider: f.provider, fastPath: true, dictionaryCandidates: [{ heard: '会議', word: 'Kaigi' }] }));
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0].user).dictionary_candidates).toEqual([{ heard: '会議', word: 'Kaigi' }]);
  });

  it('近道がオンで整った短い発話なら、LLM を呼ばずに確定する', async () => {
    const f = fake('{"text": "呼ばれないはず"}');
    const r = await formatText(base({ rawText: '明日の会議は午後からです。', provider: f.provider, fastPath: true }));
    expect(r).toMatchObject({ text: '明日の会議は午後からです。', formatted: true, fastPath: true, llmMs: 0 });
    expect(f.calls).toHaveLength(0);
  });

  it('自動修正（textfix）で直した文は、近道と LLM の失敗のときに使い、英字に直した語は知っている語として扱う', async () => {
    const textFix = {
      text: '明日はSlackで連絡します。',
      edits: [{ rule: 'latin' as const, start: 3, end: 7, before: 'スラック', after: 'Slack' }],
      candidates: [],
    };
    const near = fake('{"text": "呼ばれないはず"}');
    const r = await formatText(base({ rawText: '明日はスラックで連絡します。', provider: near.provider, fastPath: true, textFix }));
    expect(r).toMatchObject({ text: '明日はSlackで連絡します。', fastPath: true, autoFixed: true });
    expect(near.calls).toHaveLength(0);

    const failed = fake(new LlmError('timeout', 'タイムアウト'));
    const r2 = await formatText(base({ rawText: '明日はスラックで連絡します。', provider: failed.provider, textFix }));
    expect(r2).toMatchObject({ text: '明日はSlackで連絡します。', formatted: false, autoFixed: true });
    // LLM には直す前の文を渡す
    expect(JSON.parse(failed.calls[0].user).raw_text).toBe('明日はスラックで連絡します。');
  });

  it('確信度の低い字がある発話は、整っていても近道に入れない', async () => {
    const f = fake('{"text": "明日の会議は午後からです。"}');
    const r = await formatText(base({ rawText: '明日の会議は午後からです。', provider: f.provider, fastPath: true, lowConfidence: true }));
    expect(f.calls).toHaveLength(1);
    expect(r.fastPath).toBeUndefined();
  });

  it('直さなかった用語集の候補があれば近道に入らず、LLM に候補を渡す', async () => {
    const f = fake('{"text": "ラインで送ります。"}');
    const r = await formatText(
      base({
        rawText: 'ラインで送ります。',
        provider: f.provider,
        fastPath: true,
        textFix: { text: 'ラインで送ります。', edits: [], candidates: [{ heard: 'ライン', word: 'LINE' }] },
      }),
    );
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0].user).lexicon_candidates).toEqual([{ heard: 'ライン', word: 'LINE' }]);
    expect(r.autoFixed).toBeUndefined();
  });

  it('近道がオンでも、整っていない発話は LLM に回す', async () => {
    const f = fake('{"text": "明日行きます。"}');
    const r = await formatText(base({ rawText: 'えーと明日行きます', provider: f.provider, fastPath: true }));
    expect(f.calls).toHaveLength(1);
    expect(r.fastPath).toBeUndefined();
  });

  it('近道がオフなら、整った発話でも LLM に回す', async () => {
    const f = fake('{"text": "明日の会議は午後からです。"}');
    await formatText(base({ rawText: '明日の会議は午後からです。', provider: f.provider }));
    expect(f.calls).toHaveLength(1);
  });

  it('「うん」だけの発話も本文として LLM に回す', async () => {
    const f = fake('{"text": "うん。"}');
    expect((await formatText(base({ rawText: 'うん', provider: f.provider }))).text).toBe('うん。');
  });

  it('LLM が失敗したら、正規化した生テキストに戻す', async () => {
    const f = fake(new LlmError('timeout', 'タイムアウト'));
    const r = await formatText(base({ rawText: '資料 は Slack に 置きました', provider: f.provider }));
    expect(r).toMatchObject({ text: '資料はSlackに置きました', formatted: false, errorKind: 'timeout' });
  });
});

describe('formatText（編集モード）', () => {
  const edit = (reply: string) => formatText(base({ mode: 'edit', rawText: '直して', selectedText: '元の文', provider: fake(reply).provider }));

  it('削除の指示でないのに本文が空なら、不明確として扱う（N5）', async () => {
    expect(await edit('{"text": "", "deleted": false, "unclear": false}')).toMatchObject({ text: '', unclear: true, deleted: false });
  });

  it('削除の指示なら deleted を返す', async () => {
    expect(await edit('{"text": "", "deleted": true, "unclear": false}')).toMatchObject({ text: '', unclear: false, deleted: true });
  });

  it('不明確と判断されたら、本文があっても空にする', async () => {
    expect(await edit('{"text": "元の文", "deleted": false, "unclear": true}')).toMatchObject({ text: '', unclear: true });
  });

  it('書き換えた本文はそのまま返す（編集結果には正規化を掛けない）', async () => {
    expect(await edit('{"text": "Slack で送る", "deleted": false, "unclear": false}')).toMatchObject({ text: 'Slack で送る', unclear: false });
  });
});
