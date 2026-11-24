/**
 * Tests for the textfix framework. Replaces rules with fakes to check protected ranges, blocked spots, overlaps and language handling.
 * All sentences are made-up examples.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fixKey, fixText, setRuleForTest, type FixEdit, type RuleContext } from './index';
import { fixFillers } from './fillers';
import { fixLatin } from './latin';
import { fixNotation } from './notation';
import { fixParticles } from './particles';

/** A fake rule that turns every 「りんご」 in the text into 「林檎」 */
function apples(ctx: RuleContext): { edits: FixEdit[] } {
  const edits: FixEdit[] = [];
  for (let i = ctx.text.indexOf('りんご'); i >= 0; i = ctx.text.indexOf('りんご', i + 1)) {
    edits.push({ rule: 'notation', start: i, end: i + 3, before: 'りんご', after: '林檎' });
  }
  return { edits };
}

describe('fixText framework', () => {
  afterEach(() => {
    setRuleForTest('notation', (ctx) => fixNotation(ctx));
    setRuleForTest('fillers', fixFillers);
    setRuleForTest('latin', fixLatin);
    setRuleForTest('particles', fixParticles);
  });

  it('returns the input unchanged when every rule is off', () => {
    setRuleForTest('notation', apples);
    const out = fixText({ text: 'りんごを買う', language: 'ja', rules: {} });
    expect(out).toEqual({ text: 'りんごを買う', edits: [], candidates: [], skipped: [] });
  });

  it('does not fix languages other than Japanese', () => {
    setRuleForTest('notation', apples);
    expect(fixText({ text: 'りんごを買う', language: 'en', rules: { notation: true } }).text).toBe('りんごを買う');
  });

  it('applies proposals together and records positions in the text before fixing', () => {
    setRuleForTest('notation', apples);
    const out = fixText({ text: 'りんごとりんご', language: 'ja', rules: { notation: true } });
    expect(out.text).toBe('林檎と林檎');
    expect(out.edits.map((e) => [e.start, e.end])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('does not fix spots overlapping protected phrases or blocked spots', () => {
    setRuleForTest('notation', apples);
    expect(fixText({ text: '青りんごとりんご', language: 'ja', rules: { notation: true }, protectedPhrases: ['青りんご'] }).text).toBe('青りんごと林檎');
    const blocked = [fixKey({ rule: 'notation', before: 'りんご' })];
    expect(fixText({ text: 'りんご', language: 'ja', rules: { notation: true }, blocked }).text).toBe('りんご');
  });

  it("takes the earlier rule's proposal when proposals overlap", () => {
    setRuleForTest('fillers', (ctx) => ({ edits: [{ rule: 'fillers', start: 0, end: 4, before: ctx.text.slice(0, 4), after: '' }] }));
    setRuleForTest('notation', apples);
    const out = fixText({ text: 'りんご、です', language: 'ja', rules: { notation: true, fillers: true } });
    expect(out.edits.map((e) => e.rule)).toEqual(['fillers']);
    expect(out.text).toBe('です');
  });

  it('keeps running other rules when a rule throws', () => {
    setRuleForTest('fillers', () => {
      throw new Error('boom');
    });
    setRuleForTest('notation', apples);
    const out = fixText({ text: 'りんご', language: 'ja', rules: { notation: true, fillers: true } });
    expect(out.text).toBe('林檎');
    expect(out.skipped).toContain('fillers: error');
  });

  it('continues as if there were no tokenizer when the tokenizer throws', () => {
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
