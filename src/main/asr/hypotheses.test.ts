import { describe, expect, it } from 'vitest';
import { mergeUncertain, uncertainFromHypotheses, uncertainFromTokens } from './hypotheses';

describe('uncertainFromHypotheses', () => {
  it('食い違う語を、語の範囲に広げて取り出す', () => {
    const r = uncertainFromHypotheses('パレスティナの自治政府が同意しました', ['パレスリアの自治政府が同意しました']);
    expect(r).toEqual([{ heard: 'パレスティナ', alternatives: ['パレスリア'], source: 'rehear' }]);
  });

  it('漢字の語の食い違いは、漢字が続く範囲で取り出す', () => {
    const r = uncertainFromHypotheses('資料を公正に回します', ['資料を校正に回します']);
    expect(r).toEqual([{ heard: '公正', alternatives: ['校正'], source: 'rehear' }]);
  });

  it('句読点、空白、大文字と小文字だけの違いは捨てる', () => {
    expect(uncertainFromHypotheses('githubに上げておきます', ['GitHubに上げておきます。', 'github に、上げておきます'])).toEqual([]);
  });

  it('複数の仮説の候補を、同じ箇所にまとめる', () => {
    const r = uncertainFromHypotheses('会議は強国で行います', ['会議は峡谷で行います', '会議は教国で行います', '会議は強国で行います']);
    expect(r).toEqual([{ heard: '強国', alternatives: ['峡谷', '教国'], source: 'rehear' }]);
  });

  it('片方に無い字（助詞など）は、前後の字を足して場所が分かるようにする', () => {
    const r = uncertainFromHypotheses('資料送っておきます', ['資料を送っておきます']);
    expect(r).toHaveLength(1);
    expect(r[0].heard).toBe('料送');
    expect(r[0].alternatives).toEqual(['料を送']);
  });

  it('カタカナと英字の食い違いも取り出す', () => {
    const r = uncertainFromHypotheses('ギットハブに上げました', ['GitHubに上げました'], 'engine2');
    expect(r).toEqual([{ heard: 'ギットハブ', alternatives: ['GitHub'], source: 'engine2' }]);
  });

  it('長すぎる食い違い（別の文）は渡さない', () => {
    expect(uncertainFromHypotheses('今日は早めに帰ります', ['来週の打ち合わせの資料を、明日の朝までに用意しておいてください'])).toEqual([]);
  });

  it('上限までを、文の中の順に返す', () => {
    const r = uncertainFromHypotheses('雨と雪と風と雷', ['飴と行きと風と雷', '雨と雪と風邪と神鳴'], 'rehear', 2);
    expect(r.map((u) => u.heard)).toEqual(['雨', '雪']);
  });
});

describe('uncertainFromTokens', () => {
  const tokens: [string, number][] = [
    ['会議', 0.98],
    ['は', 0.99],
    ['強', 0.42],
    ['国', 0.9],
    ['で', 0.99],
    ['行', 0.97],
    ['います', 0.99],
  ];

  it('確信度の低い字を、その字を含む語にして、候補を差し替えた語を返す', () => {
    const r = uncertainFromTokens('会議は強国で行います', tokens, [
      {
        index: 2,
        candidates: [
          ['峡', 0.3],
          ['共', 0.08],
          ['教', 0.02],
        ],
      },
    ]);
    expect(r).toEqual([{ heard: '強国', alternatives: ['峡国', '共国'], source: 'token' }]);
  });

  it('句読点だけの候補は捨てる', () => {
    expect(uncertainFromTokens('会議は強国で行います', tokens, [{ index: 2, candidates: [['、', 0.4]] }])).toEqual([]);
  });

  it('書き起こしと語の並びが少し違っても、対応が取れた字だけを使う', () => {
    const r = uncertainFromTokens('会議は強国で行います。', tokens, [{ index: 2, candidates: [['峡', 0.3]] }]);
    expect(r).toEqual([{ heard: '強国', alternatives: ['峡国'], source: 'token' }]);
  });

  it('材料が無ければ空を返す', () => {
    expect(uncertainFromTokens('会議は強国で行います', null, [])).toEqual([]);
    expect(uncertainFromTokens('会議は強国で行います', tokens, [])).toEqual([]);
  });
});

describe('mergeUncertain', () => {
  it('同じ語句を 1 つにまとめ、先に渡した材料の候補を先に並べる', () => {
    const r = mergeUncertain([
      [{ heard: '強国', alternatives: ['峡谷'], source: 'rehear' }],
      [
        { heard: '強国', alternatives: ['峡国', '峡谷'], source: 'token' },
        { heard: '有給', alternatives: ['要求'], source: 'token' },
      ],
    ]);
    expect(r).toEqual([
      { heard: '強国', alternatives: ['峡谷', '峡国'], source: 'rehear' },
      { heard: '有給', alternatives: ['要求'], source: 'token' },
    ]);
  });
});
