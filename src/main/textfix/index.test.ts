/**
 * textfix の骨組みのテスト。規則を偽物に差し替えて、守る範囲、止めた箇所、重なり、言語の扱いを確かめる。
 * 文はすべて作った例文である。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fixKey, fixText, setRuleForTest, type FixEdit, type RuleContext } from './index';
import { fixFillers } from './fillers';
import { fixLatin } from './latin';
import { fixNotation } from './notation';
import { fixParticles } from './particles';

/** 文中の「りんご」をすべて「林檎」にする偽物の規則 */
function apples(ctx: RuleContext): { edits: FixEdit[] } {
  const edits: FixEdit[] = [];
  for (let i = ctx.text.indexOf('りんご'); i >= 0; i = ctx.text.indexOf('りんご', i + 1)) {
    edits.push({ rule: 'notation', start: i, end: i + 3, before: 'りんご', after: '林檎' });
  }
  return { edits };
}

describe('fixText の骨組み', () => {
  afterEach(() => {
    setRuleForTest('notation', (ctx) => fixNotation(ctx));
    setRuleForTest('fillers', fixFillers);
    setRuleForTest('latin', fixLatin);
    setRuleForTest('particles', fixParticles);
  });

  it('規則がすべてオフなら、入力をそのまま返す', () => {
    setRuleForTest('notation', apples);
    const out = fixText({ text: 'りんごを買う', language: 'ja', rules: {} });
    expect(out).toEqual({ text: 'りんごを買う', edits: [], candidates: [], skipped: [] });
  });

  it('日本語以外では直さない', () => {
    setRuleForTest('notation', apples);
    expect(fixText({ text: 'りんごを買う', language: 'en', rules: { notation: true } }).text).toBe('りんごを買う');
  });

  it('提案をまとめて当て、位置は直す前の文字列で記録する', () => {
    setRuleForTest('notation', apples);
    const out = fixText({ text: 'りんごとりんご', language: 'ja', rules: { notation: true } });
    expect(out.text).toBe('林檎と林檎');
    expect(out.edits.map((e) => [e.start, e.end])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('守る語句と重なる箇所、止めた箇所は直さない', () => {
    setRuleForTest('notation', apples);
    expect(fixText({ text: '青りんごとりんご', language: 'ja', rules: { notation: true }, protectedPhrases: ['青りんご'] }).text).toBe('青りんごと林檎');
    const blocked = [fixKey({ rule: 'notation', before: 'りんご' })];
    expect(fixText({ text: 'りんご', language: 'ja', rules: { notation: true }, blocked }).text).toBe('りんご');
  });

  it('重なった提案は、先の規則のものを採る', () => {
    setRuleForTest('fillers', (ctx) => ({ edits: [{ rule: 'fillers', start: 0, end: 4, before: ctx.text.slice(0, 4), after: '' }] }));
    setRuleForTest('notation', apples);
    const out = fixText({ text: 'りんご、です', language: 'ja', rules: { notation: true, fillers: true } });
    expect(out.edits.map((e) => e.rule)).toEqual(['fillers']);
    expect(out.text).toBe('です');
  });

  it('規則が例外を投げても、ほかの規則は続ける', () => {
    setRuleForTest('fillers', () => {
      throw new Error('boom');
    });
    setRuleForTest('notation', apples);
    const out = fixText({ text: 'りんご', language: 'ja', rules: { notation: true, fillers: true } });
    expect(out.text).toBe('林檎');
    expect(out.skipped).toContain('fillers: error');
  });

  it('単語分割が例外を投げたら、単語分割はないものとして続ける', () => {
    let seen: unknown = 'unset';
    setRuleForTest('notation', (ctx) => {
      seen = ctx.tokens();
      return { edits: [] };
    });
    fixText({
      text: 'りんご',
      language: 'ja',
      rules: { notation: true },
      tokenizer: {
        tokenize: () => {
          throw new Error('wasm');
        },
      },
    });
    expect(seen).toBeNull();
  });
});
