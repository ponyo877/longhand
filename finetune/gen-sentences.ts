/**
 * 微調整の学習用の文を作る。
 *
 *   npx tsx finetune/gen-sentences.ts [--out ~/longhand-eval/ft/sentences.jsonl] [--holdout-script scripts/review/script-v1.json]
 *
 * 作る文は 4 種類である。
 * - term:     用語集（src/main/textfix/lexicon/latin.ts の段階 1）の語を、文の型に当てはめた文。正解は英字の綴り、読み上げはカタカナの読み
 * - loanword: 同じ文の型に、カタカナのままにする一般的な外来語を当てはめた文。英字にしすぎないための反例
 * - general:  用語を含まない、ふだんの仕事の文
 * - plain:    公開データ（FLEURS の学習用）の文。読み上げの台本にだけ使う。正解は、元のモデルがその読み上げを書き起こしたものにする
 *             （合成音声でも、用語のない文は元のモデルと同じに書き起こすように。公開データの正解の書き方は学習させない）
 *
 * 評価に使う台本（script-v1）の B の文に出てくる語は、学習に使わない（学習していない語での効果を測るため）。
 * 台本の文そのものと同じ文は作らない。文はすべてここで作ったもので、利用者の書き起こしは見ていない。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { LATIN_LEXICON } from '../src/main/textfix/lexicon/latin';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(os.homedir(), 'longhand-eval', 'ft', 'sentences.jsonl') },
    'holdout-script': { type: 'string', default: 'scripts/review/script-v1.json' },
    'per-term': { type: 'string', default: '5' },
    pairs: { type: 'string', default: '420' },
    'per-loanword': { type: 'string', default: '10' },
    'include-holdout': { type: 'boolean', default: false },
    plain: { type: 'string', default: '800' },
    'fleurs-tsv': { type: 'string', default: path.join(os.homedir(), 'longhand-eval', 'public', 'fleurs-ja', 'train.tsv') },
  },
});

// 同じ入力から同じ文が出るように、決まった乱数を使う
let seed = 20261123;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const shuffle = <T>(xs: readonly T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** 語を 1 つ入れる文の型。{A} に、製品名でも一般的な外来語でも入る形にしてある */
const ONE: string[] = [
  '{A}の設定を見直します。',
  '{A}で確認してから返信します。',
  '{A}にログインできないんですけど、何か分かりますか？',
  'さっき{A}に上げたので、見ておいてください。',
  '{A}の使い方を教えてもらえますか？',
  '来週から{A}に移行する予定です。',
  '{A}を使うのは初めてなので、少し時間がかかりそうです。',
  '{A}のドキュメントを読んでおいてください。',
  'この件は{A}で管理しています。',
  '{A}が落ちているみたいです。',
  '{A}のバージョンを上げたら動かなくなりました。',
  '{A}のアカウントを発行してもらえますか？',
  '{A}の料金が思ったより高いですね。',
  'とりあえず{A}で試してみます。',
  '{A}の通知が多すぎるので、設定を変えました。',
  '{A}と同じことができる方法を探しています。',
  '{A}のエラーが出ているので、ログを確認してください。',
  '{A}は便利ですね。',
  '{A}を導入するかどうか、来週の会議で決めます。',
  'その資料は{A}に置いてあります。',
  '{A}の権限がないので、追加をお願いします。',
  '{A}について調べてまとめておきます。',
  '{A}のサポートに問い合わせてみます。',
  '{A}を開いて、状況を確認してもらえますか？',
  '昨日から{A}の動きが遅い気がします。',
  '{A}に詳しい人はいますか？',
  '{A}の連携がうまくいっていないようです。',
  '{A}のテストを追加してください。',
  '{A}を使った実装に書き換えてください。',
  '{A}のサンプルを作ってみました。',
  '{A}の更新があったので、対応が必要です。',
  '{A}から通知が来ていました。',
  '{A}へのアクセスが制限されています。',
  '{A}は使わずに進めることにしました。',
  '{A}のほうが良さそうですね。',
  'まず{A}をインストールしてください。',
  '{A}の設定ファイルを直しました。',
  '{A}って何でしたっけ？',
  '{A}に関する質問がいくつかあります。',
  '{A}でも同じ問題が起きますか？',
  '{A}の画面を共有しますね。',
  '{A}に書いてある手順どおりに進めてください。',
  '{A}をやめて、別の方法を考えましょう。',
  '{A}の検証は今週中に終わらせます。',
  'これ、{A}でやったほうが早くないですか？',
  '{A}の障害の影響で、作業が止まっています。',
  '{A}の契約を更新するか、検討しています。',
  '{A}を触ったことがある人に聞いてみます。',
  '{A}のデータを移しておきました。',
  '{A}の件、了解です。',
  '{A}でお願いします。',
  '{A}ですね。',
  '{A}を確認しました。',
  '{A}に入れておいてください。',
  '{A}はまだですか？',
  '{A}の依存を最新にして、テストが通るか確認して。',
  '{A}の設定を追加して、動くようにしてください。',
  '{A}のエラーの原因を調べて、直してください。',
  '{A}を使って書き直すと、どのくらい変わりますか？',
  'このリポジトリに{A}を入れてください。',
  '{A}のバージョンを固定しておいて。',
  '{A}の部分だけ、先にレビューしてもらえますか？',
  '{A}のログを見ると、タイムアウトが出ています。',
  '{A}の移行の計画を立ててください。',
  '{A}のコードを読んで、仕組みを説明してください。',
  '{A}向けの対応は後回しにします。',
  '{A}に合わせて、書き方をそろえてください。',
  '{A}の代わりになるものはありますか？',
  '今日は{A}の作業を進めます。',
  '{A}の話は、また今度にしましょう。',
  '{A}を見てもらえると助かります。',
  '念のため{A}も確認しておきました。',
  '{A}が原因かもしれません。',
  '{A}の担当は誰でしたっけ？',
  '午後は{A}の打ち合わせがあります。',
  '{A}を新しくしたので、試してみてください。',
  '{A}だけ先に終わらせます。',
  '{A}に切り替えてから、問題は起きていません。',
  '{A}の説明を追加しておきました。',
  'すみません、{A}の件を忘れていました。',
];

/** 語を 2 つ入れる文の型 */
const TWO: string[] = [
  '{A}と{B}を連携させたいです。',
  '{A}から{B}に移行します。',
  '{A}と{B}のどちらを使うか、迷っています。',
  '{A}の通知を{B}に流すようにしました。',
  '{A}で作ったものを{B}に載せます。',
  '{A}は{B}より速いらしいです。',
  '{A}と{B}の両方で確認してください。',
  '{A}のデータを{B}に取り込みたいです。',
  '{A}ではなく{B}を使うことにしました。',
  '{A}の上で{B}を動かしています。',
  '{A}と{B}を組み合わせるとどうなりますか？',
  '{A}に加えて{B}も必要です。',
  '{A}の設定は{B}と同じにしてあります。',
  '{A}を{B}に置き換える作業を進めています。',
  '{A}も{B}も、まだ試していません。',
  '{A}で書いて、{B}で動かします。',
  '{A}のあとに{B}を実行してください。',
  '{A}か{B}のどちらかで対応できます。',
  '{A}を見たら、{B}のエラーが出ていました。',
  '{A}の件と{B}の件、両方お願いします。',
  '{A}は分かるんですけど、{B}はあまり詳しくないです。',
  '{A}の結果を{B}にまとめておきました。',
  'まず{A}を直して、そのあと{B}に取りかかります。',
  '{A}を使うなら、{B}も合わせて入れたほうがいいです。',
];

/** カタカナのままにする一般的な外来語（英字にしない） */
// prettier-ignore
const LOANWORDS: string[] = [
  'ミーティング', 'スケジュール', 'サーバー', 'データベース', 'ブラウザ', 'アプリ', 'システム', 'ツール', 'サービス', 'プロジェクト',
  'リポジトリ', 'ブランチ', 'コミット', 'ビルド', 'デプロイ', 'リリース', 'テスト', 'レビュー', 'ダッシュボード', 'アカウント',
  'パスワード', 'メール', 'カレンダー', 'ファイル', 'フォルダ', 'クラウド', 'ネットワーク', 'キャッシュ', 'スクリプト', 'バックアップ',
  'テンプレート', 'マニュアル', 'チケット', 'タスク', 'ワークフロー', 'パイプライン', 'コンテナ', 'クラスター', 'インスタンス', 'エンドポイント',
  'トークン', 'ライブラリ', 'フレームワーク', 'プラグイン', 'モジュール', 'コンポーネント', 'インターフェース', 'プルリクエスト', 'マージ', 'オンボーディング',
  'スプリント', 'イシュー', 'セキュリティ', 'モニタリング', 'ドメイン', 'プロキシ', 'ルーター', 'キーボード', 'ディスプレイ', 'プリンター',
];

/** 用語を含まない、ふだんの仕事の文 */
const GENERAL: string[] = [
  'お疲れさまです。本日の進み具合を共有します。',
  '明日の打ち合わせは、午後2時からに変更になりました。',
  '資料を確認して、気になる点があれば教えてください。',
  '先ほどの件、承知しました。',
  '少し遅れそうなので、先に始めていてください。',
  '見積もりは今週中にお送りします。',
  'ご連絡ありがとうございます。内容を確認して、折り返します。',
  '来週の予定を教えてもらえますか？',
  'その方向で進めて問題ありません。',
  '念のため、もう一度確認させてください。',
  '担当の方に聞いてみますね。',
  '今日は早めに上がります。',
  '会議室の予約をお願いできますか？',
  '修正したので、もう一度見てもらえると助かります。',
  '原因が分かったので、これから直します。',
  '思ったより時間がかかっています。',
  'すみません、もう少し待ってもらえますか？',
  '午前中は外出しているので、午後に対応します。',
  '詳しい話は、明日の朝にしましょう。',
  'この書き方だと、あとで困りそうです。',
  '先週お願いした件は、どうなりましたか？',
  '結論から言うと、今回は見送ることにしました。',
  '3つ確認したいことがあります。',
  '予算は50万円以内に収めたいです。',
  '締め切りは来月の15日です。',
  '参加するのは全部で8人です。',
  '10時半に駅で待ち合わせましょう。',
  '売り上げは前の年より2割ほど増えました。',
  'それは助かります。ありがとうございます。',
  'いったん持ち帰って、検討させてください。',
  '細かいところは、あとで詰めましょう。',
  'ここまでで何か質問はありますか？',
  '優先順位を決めてから、取りかかります。',
  '今の説明で合っていますか？',
  '昨日の続きから始めます。',
  'この問題は、前にも起きたことがあります。',
  '急ぎではないので、手が空いたときにお願いします。',
  '念のため、関係する人にも伝えておきます。',
  '作業が終わったら、連絡します。',
  '思っていたのと少し違いますね。',
  'もう少し分かりやすく書き直してください。',
  '手順をまとめて、共有しておきます。',
  '来月から担当が変わります。',
  '体調が悪いので、今日は休みます。',
  '電車が遅れていて、10分ほど遅れます。',
  'お昼は外で食べてきます。',
  '今週は忙しいので、来週でもいいですか？',
  'その件は、私のほうで引き取ります。',
  '確認が取れたので、先に進めます。',
  '説明が足りなかったですね。すみません。',
  '同じ間違いをしないように、気をつけます。',
  'この数字は、どこから持ってきたものですか？',
  '半年ほど前に、同じような相談がありました。',
  '結果が出たら、すぐにお知らせします。',
  '長くなるので、要点だけ書きます。',
  '明日までに終わらせるのは、少し難しいです。',
  '必要なものがあれば、遠慮なく言ってください。',
  'もう一度、最初から説明します。',
  'それで大丈夫です。よろしくお願いします。',
  '今のところ、大きな問題は見つかっていません。',
];

interface Sentence {
  id: string;
  kind: 'term' | 'loanword' | 'general' | 'plain';
  /** 正解の文 */
  text: string;
  /** 読み上げる文（英字の語をカタカナの読みに直したもの） */
  say: string;
  terms: string[];
}

function main(): void {
  const script = JSON.parse(fs.readFileSync(args['holdout-script']!, 'utf8')) as { items: { split: string; text: string; terms: string[] }[] };
  const holdout = new Set(script.items.filter((i) => i.split === 'B').flatMap((i) => i.terms.map((t) => t.toLowerCase())));
  const banned = new Set(script.items.map((i) => i.text));
  const terms = LATIN_LEXICON.filter((e) => e.tier === 1 && e.readings.length && (args['include-holdout'] || !holdout.has(e.word.toLowerCase())));
  const out: Sentence[] = [];
  const seen = new Set<string>();
  const add = (kind: Sentence['kind'], text: string, say: string, used: string[]) => {
    if (seen.has(text) || banned.has(text)) return;
    seen.add(text);
    out.push({ id: `ft-${kind}-${String(out.length + 1).padStart(5, '0')}`, kind, text, say, terms: used });
  };
  const fill = (tpl: string, a: { text: string; say: string }, b?: { text: string; say: string }) => ({
    text: tpl.replace('{A}', a.text).replace('{B}', b?.text ?? ''),
    say: tpl.replace('{A}', a.say).replace('{B}', b?.say ?? ''),
  });
  const reading = (e: (typeof terms)[number]) => ({ text: e.word, say: pick(e.readings) });

  // 用語を 1 つ入れた文
  const perTerm = Number(args['per-term']);
  for (const e of terms) {
    for (const tpl of shuffle(ONE).slice(0, perTerm)) {
      const s = fill(tpl, reading(e));
      add('term', s.text, s.say, [e.word]);
    }
  }
  // 用語を 2 つ入れた文
  for (let i = 0; i < Number(args.pairs); i++) {
    const [a, b] = shuffle(terms).slice(0, 2);
    const s = fill(pick(TWO), reading(a), reading(b));
    add('term', s.text, s.say, [a.word, b.word]);
  }
  // 一般的な外来語（カタカナのまま）。用語と同じ文の型を使う
  for (const w of LOANWORDS) {
    for (const tpl of shuffle(ONE).slice(0, Number(args['per-loanword']))) {
      const s = fill(tpl, { text: w, say: w });
      add('loanword', s.text, s.say, []);
    }
  }
  // 外来語と用語を 1 つずつ入れた文（同じ文の中で、書き分けられるように）
  for (let i = 0; i < 200; i++) {
    const e = pick(terms);
    const w = pick(LOANWORDS);
    const swap = rnd() < 0.5;
    const a = swap ? { text: w, say: w } : reading(e);
    const b = swap ? reading(e) : { text: w, say: w };
    const s = fill(pick(TWO), a, b);
    add('term', s.text, s.say, [e.word]);
  }
  for (const g of GENERAL) add('general', g, g, []);
  // 公開データの学習用の文（英字を含まない、短めの文）。文の並びの順に、決まった数だけ使う。
  // ここより上の文の番号を変えないように、最後に足す
  const plainMax = Number(args.plain);
  if (plainMax > 0 && fs.existsSync(args['fleurs-tsv']!)) {
    let n = 0;
    for (const line of fs.readFileSync(args['fleurs-tsv']!, 'utf8').split('\n')) {
      const t = line.split('\t')[2];
      if (!t || t.length < 12 || t.length > 60 || /[A-Za-z]/.test(t) || seen.has(t)) continue;
      if (n++ >= plainMax) break;
      add('plain', t, t, []);
    }
  }

  fs.mkdirSync(path.dirname(args.out!), { recursive: true, mode: 0o700 });
  fs.writeFileSync(args.out!, `${out.map((s) => JSON.stringify(s)).join('\n')}\n`, { mode: 0o600 });
  const count = (k: string) => out.filter((s) => s.kind === k).length;
  console.log(
    `${out.length} 文（用語 ${count('term')}、外来語 ${count('loanword')}、ふだんの文 ${count('general')}、公開データの文 ${count('plain')}）。` +
      `用語集の語 ${terms.length} 語を使用${args['include-holdout'] ? '' : `（台本 B の語 ${LATIN_LEXICON.filter((e) => e.tier === 1 && holdout.has(e.word.toLowerCase())).length} 語は除外）`}`,
  );
}

main();
