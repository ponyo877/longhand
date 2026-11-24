import { useEffect, useState } from 'react';
import type { LlmProviderKind, Settings } from '../../shared/settings';
import type { AppSnapshot, AsrTestResult, ConnectionTestResult, DeepPartial, ModelDownloadState } from '../../shared/types';
import { Badge, Button, cx, inputBase, inputClass, NumberField, PageHeader, Row, Section, Select, StatusDot, TextField, Toggle } from '../common/ui';
import { ShortcutSettings } from './Shortcuts';

type Update = (patch: DeepPartial<Settings>) => Promise<void>;
type Tab = 'general' | 'keyboard' | 'dictation' | 'audio' | 'connection' | 'about';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: '一般' },
  { id: 'keyboard', label: 'キーボード' },
  { id: 'dictation', label: '音声入力' },
  { id: 'audio', label: 'オーディオ' },
  { id: 'connection', label: '接続' },
  { id: 'about', label: '状態' },
];

function General({ s, update }: { s: Settings; update: Update }) {
  return (
    <>
      <Section title="起動と表示">
        <Row label="ログイン時に起動" hint="アプリケーションのフォルダに置いたアプリで有効になります。">
          <Toggle checked={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
        </Row>
        <Row label="フローティングバーを表示" hint="隠していても、録音中と通知は表示します。トレイメニューから一時的に隠すこともできます。">
          <Toggle checked={s.showFloater} onChange={(v) => update({ showFloater: v, floaterSnoozeUntil: null })} />
        </Row>
        <Row label="外観">
          <Select
            value={s.appearance}
            options={[
              { value: 'system', label: 'システムに合わせる' },
              { value: 'light', label: 'ライト' },
              { value: 'dark', label: 'ダーク' },
            ]}
            onChange={(v) => update({ appearance: v })}
          />
        </Row>
        <Row label="⌘Q でウィンドウだけを閉じる" hint="オンのとき、完全に終了するにはトレイメニューの「Longhand を終了」を使います。">
          <Toggle checked={s.quitOnlyFromTray} onChange={(v) => update({ quitOnlyFromTray: v })} />
        </Row>
      </Section>
      <Section title="クリップボード">
        <Row label="クリップボード履歴に残さない" hint="貼り付けに使う一時的な内容を、Raycast や Maccy などの履歴アプリが記録しないように印を付けます。">
          <Toggle checked={s.avoidClipboardHistory} onChange={(v) => update({ avoidClipboardHistory: v })} />
        </Row>
      </Section>
      <Section title="履歴と録音" description="履歴と録音は端末内だけに保存します。">
        <Row label="履歴の件数">
          <NumberField value={s.historyLimit} min={10} max={2000} onCommit={(v) => update({ historyLimit: v })} suffix="件" />
        </Row>
        <Row label="録音を保存する" hint="履歴から再生、保存できます。">
          <Toggle checked={s.saveRecordings} onChange={(v) => update({ saveRecordings: v })} />
        </Row>
        <Row label="録音を残す期間">
          <NumberField value={s.recordingRetentionHours} min={1} max={24 * 30} onCommit={(v) => update({ recordingRetentionHours: v })} suffix="時間" />
        </Row>
        <Row label="録音の合計サイズの上限">
          <NumberField value={s.recordingMaxMB} min={10} max={10000} onCommit={(v) => update({ recordingMaxMB: v })} suffix="MB" />
        </Row>
        <Row label="保存先">
          <Button small onClick={() => void window.longhand.openExternal('recordings')}>
            Finder で開く
          </Button>
        </Row>
      </Section>
    </>
  );
}

function Keyboard({ s, update }: { s: Settings; update: Update }) {
  return (
    <>
      <Section title="ショートカット" description="fn キーの代わりに、修飾キーの組み合わせやマウスのボタンも使えます（1 つの操作に 3 つまで）。">
        <ShortcutSettings settings={s} update={(hotkeys) => void update({ hotkeys })} />
      </Section>
      <Section title="ハンズフリー">
        <Row label="ダブルタップでハンズフリーにする" hint="話すキーを素早く 2 回押すと、押し続けなくても録音が続きます。">
          <Toggle checked={s.doubleTapToLock} onChange={(v) => update({ doubleTapToLock: v })} />
        </Row>
        <Row label="ダブルタップとみなす間隔" hint="1 回目を押してから 2 回目を押すまでの時間です。">
          <NumberField value={s.doubleTapMs} min={150} max={800} step={10} onCommit={(v) => update({ doubleTapMs: v })} suffix="ミリ秒" />
        </Row>
      </Section>
      <Section title="地球儀キー">
        <Row
          label="fn（地球儀）キーのシステム動作を自動で止める"
          hint="Longhand の起動中だけ、「🌐キーを押して」の設定を「何もしない」に切り替え、終了時に元に戻します。非公開の仕組みを使うため、macOS の更新で動かなくなる可能性があります。うまくいかないときは、システム設定 > キーボード で手動で「何もしない」にしてください。"
        >
          <Toggle checked={s.suppressGlobe} onChange={(v) => update({ suppressGlobe: v })} />
        </Row>
        <Row label="キーボードの設定">
          <Button small onClick={() => void window.longhand.openExternal('keyboard')}>
            システム設定を開く
          </Button>
        </Row>
      </Section>
    </>
  );
}

function Dictation({ s, update }: { s: Settings; update: Update }) {
  return (
    <>
      <Section title="言語">
        <Row label="話す言語">
          <Select
            value={s.language}
            options={[
              { value: 'ja', label: '日本語' },
              { value: 'en', label: 'English' },
              { value: 'auto', label: '自動判定' },
            ]}
            onChange={(v) => update({ language: v })}
          />
        </Row>
      </Section>
      <Section title="整形">
        <Row label="LLM で整形する" hint="オフにすると、音声認識の結果をそのまま入力します（外部への通信は一切なくなります）。">
          <Toggle checked={!s.skipLlm} onChange={(v) => update({ skipLlm: !v })} />
        </Row>
        <Row
          label="整った短い発話は LLM を通さない"
          hint="句読点まで整っている短い発話は、LLM を呼ばずにそのまま入力します。待ち時間が 1 秒ほど減りますが、同音異義語などの聞き違いを LLM が直せなくなります。"
        >
          <Toggle checked={s.llmFastPath} disabled={s.skipLlm} onChange={(v) => update({ llmFastPath: v })} />
        </Row>
        <Row
          label="LLM を通さない文を自動で直す"
          hint="LLM を使わないとき、整った短い発話で LLM を飛ばしたとき、LLM が失敗したときに貼る文を、決まった規則で直します。LLM には直す前の文を渡します。直した箇所は履歴で確かめられます。"
        >
          <Toggle checked={s.textFix.enabled} onChange={(v) => update({ textFix: { enabled: v } })} />
        </Row>
        {s.textFix.enabled && (
          <>
            <Row label="製品名を英字にする" hint="「スラック」を「Slack」にするなど、よく知られた製品名や略語のカタカナを英字の綴りにします。">
              <Toggle checked={s.textFix.latin} onChange={(v) => update({ textFix: { latin: v } })} />
            </Row>
            <Row label="つなぎの言葉を取り除く" hint="文頭や読点の前後の「えっと」「あのー」などを取り除きます。">
              <Toggle checked={s.textFix.fillers} onChange={(v) => update({ textFix: { fillers: v } })} />
            </Row>
            <Row label="表記をそろえる" hint="「下さい」を「ください」にするなど、補助動詞や形式名詞をかなで書きます。">
              <Toggle checked={s.textFix.notation} onChange={(v) => update({ textFix: { notation: v } })} />
            </Row>
            <Row label="助詞の誤りを直す" hint="「こんにちわ」を「こんにちは」にする、音声認識が自信なく足した「を」を取り除くなど、明らかな誤りだけを直します。">
              <Toggle checked={s.textFix.particles} onChange={(v) => update({ textFix: { particles: v } })} />
            </Row>
            {s.textFix.blocked.length > 0 && (
              <Row label={`「今後は直さない」を選んだ箇所（${s.textFix.blocked.length} 件）`}>
                <Button small variant="secondary" onClick={() => update({ textFix: { blocked: [] } })}>
                  すべて元に戻す
                </Button>
              </Row>
            )}
          </>
        )}
        <Row label="編集モード" hint="文字を選択してから話すキーを押し、「もっと丁寧に」などと話すと、選択した文章を書き換えます。">
          <Toggle checked={s.editModeEnabled} onChange={(v) => update({ editModeEnabled: v })} />
        </Row>
      </Section>
      <Section title="LLM に送る文脈" description="入力先に合った体裁にするために使います。音声そのものは送りません。パスワード欄の内容は読みません。">
        <Row label="アプリ名、ブラウザのドメイン、入力欄の種類">
          <Toggle checked={s.sendAppContext} onChange={(v) => update({ sendAppContext: v })} />
        </Row>
        <Row label="カーソルの前後の文字列（それぞれ最大 1,000 字）" hint="文の続きとして自然につながるようにします。入力中の内容を外部に送りたくない場合はオフにしてください。">
          <Toggle checked={s.sendFieldContext} onChange={(v) => update({ sendFieldContext: v })} />
        </Row>
        <Row
          label="Chromium 系のアプリの入力欄を読む"
          hint="Chrome、Edge、Slack などで入力欄の文脈を読むために、アクセシビリティの拡張モードを有効にします。Rectangle などのウィンドウ整列ツールの動きがおかしくなるときはオフにしてください。"
        >
          <Toggle checked={s.chromiumEnhancedUI} onChange={(v) => update({ chromiumEnhancedUI: v })} />
        </Row>
      </Section>
      <Section title="学習">
        <Row label="手直しから語を学習する" hint="入力の直後に手で直した語と、履歴の「文を直す」で直した語を、辞書に追加します（スタイル > 学習した語）。">
          <Toggle checked={s.learning.enabled} onChange={(v) => update({ learning: { enabled: v } })} />
        </Row>
        <Row label="手直しを見る時間">
          <NumberField value={s.learning.watchSeconds} min={5} max={300} onCommit={(v) => update({ learning: { watchSeconds: v } })} suffix="秒" />
        </Row>
      </Section>
    </>
  );
}

function Meter({ level }: { level: number }) {
  const pct = Math.min(100, Math.sqrt(level) * 220);
  return (
    <div className="h-1.5 w-40 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
      <div className={cx('h-full transition-[width] duration-75', pct > 85 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Audio({ s, update }: { s: Settings; update: Update }) {
  const [mics, setMics] = useState<Awaited<ReturnType<typeof window.longhand.listMicrophones>>>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => void window.longhand.listMicrophones().then(setMics), []);
  useEffect(() => window.longhand.onMicLevel(setLevel), []);
  const test = async () => {
    setTesting(true);
    setResult(null);
    const r = await window.longhand.testMicrophone(3);
    setTesting(false);
    setLevel(0);
    if (!r.ok) setResult(`失敗: ${r.error}`);
    else if (r.peak < 0.001) setResult('音が入っていません。マイクがミュートになっていないか確認してください');
    else if (r.rms < 0.01) setResult('音が小さめです。マイクに近づくか、入力音量を上げてください');
    else setResult('問題ありません');
  };
  const real = mics.filter((m) => !m.isVirtual);
  return (
    <>
      <Section title="マイク">
        <Row label="使うマイク" hint="選んだマイクがないときは、システムの既定を使います。">
          <Select
            value={s.microphoneId ?? ''}
            options={[{ value: '', label: 'システムの既定' }, ...real.map((m) => ({ value: m.id, label: m.name + (m.transport === 'bluetooth' ? '（Bluetooth）' : '') }))]}
            onChange={(v) => update({ microphoneId: v || null })}
          />
        </Row>
        <Row label="マイクのテスト" hint={result ?? '3 秒間録音して、音の大きさを確かめます。'}>
          <span className="inline-flex items-center gap-3">
            {testing && <Meter level={level} />}
            <Button small onClick={test} disabled={testing}>
              {testing ? '録音中…' : 'テスト'}
            </Button>
          </span>
        </Row>
        {real.length > 1 && (
          <Row label="自動で選ばないマイク" hint="システムの既定がここにあるときは、ほかのマイクを使います。" vertical>
            <div className="flex flex-col gap-1">
              {real.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={s.excludedMicrophones.includes(m.id)}
                    onChange={(e) =>
                      update({
                        excludedMicrophones: e.target.checked ? [...s.excludedMicrophones, m.id] : s.excludedMicrophones.filter((x) => x !== m.id),
                      })
                    }
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </Row>
        )}
      </Section>
      <Section title="効果音と判定">
        <Row label="効果音">
          <Toggle checked={s.playSounds} onChange={(v) => update({ playSounds: v })} />
        </Row>
        <Row label="音量">
          <input type="range" min={0} max={1} step={0.05} value={s.soundVolume} onChange={(e) => update({ soundVolume: Number(e.target.value) })} className="w-40" />
        </Row>
        <Row label="無音を検出する" hint="何も話していない録音は、書き起こさずに知らせます。">
          <Toggle checked={s.silenceDetection} onChange={(v) => update({ silenceDetection: v })} />
        </Row>
        <Row label="誤操作とみなす録音の長さ" hint="これより短い録音は何もせずに捨てます。">
          <NumberField value={s.minRecordingMs} min={0} max={2000} step={50} onCommit={(v) => update({ minRecordingMs: v })} suffix="ミリ秒" />
        </Row>
      </Section>
    </>
  );
}

const PROVIDERS: { value: LlmProviderKind; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI 互換（LiteLLM、vLLM、Ollama など）' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
  { value: 'anthropic', label: 'Anthropic（Claude）' },
  { value: 'custom-http', label: '任意の HTTP API' },
];

const URL_HINT: Record<LlmProviderKind, string> = {
  'openai-compatible': '例: https://llm-gateway.example.internal/v1（/chat/completions は付けない）',
  'azure-openai': '例: https://my-resource.openai.azure.com',
  anthropic: '空なら公式の API（api.anthropic.com）。プロキシを通す場合はその URL',
  'custom-http': 'リクエストを送る URL そのもの',
};

function HeadersEditor({ headers, onChange }: { headers: Record<string, string>; onChange: (h: Record<string, string>) => void }) {
  const [rows, setRows] = useState(() => Object.entries(headers));
  useEffect(() => setRows(Object.entries(headers)), [headers]);
  const commit = (r: [string, string][]) => onChange(Object.fromEntries(r.filter(([k]) => k.trim())));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <input
            className={cx(inputClass, 'font-mono text-[12px]')}
            placeholder="ヘッダ名"
            value={k}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
            onBlur={() => commit(rows)}
          />
          <input
            className={cx(inputClass, 'font-mono text-[12px]')}
            placeholder="値"
            value={v}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
            onBlur={() => commit(rows)}
          />
          <Button small variant="ghost" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            ×
          </Button>
        </div>
      ))}
      <div>
        <Button small variant="ghost" onClick={() => setRows([...rows, ['', '']])}>
          ＋ ヘッダを追加
        </Button>
      </div>
    </div>
  );
}

function ApiKeyField({ hasKey }: { hasKey: boolean }) {
  const [v, setV] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="password"
        className={cx(inputBase, 'w-64 font-mono text-[12px]')}
        placeholder={hasKey ? '保存済み（変更する場合のみ入力）' : 'API キー'}
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <Button
        small
        disabled={!v}
        onClick={async () => {
          await window.longhand.setApiKey(v);
          setV('');
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        }}
      >
        {saved ? '保存しました' : '保存'}
      </Button>
      {hasKey && !v && (
        <Button small variant="danger" onClick={() => void window.longhand.setApiKey('')}>
          削除
        </Button>
      )}
    </span>
  );
}

export function LlmSettingsSection({ snap, update, compact }: { snap: AppSnapshot; update: Update; compact?: boolean }) {
  const l = snap.settings.llm;
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const run = async () => {
    setTesting(true);
    setTest(null);
    setTest(await window.longhand.testLlm());
    setTesting(false);
  };
  return (
    <Section
      title="LLM（整形）"
      description="書き起こしの整形に使う LLM の接続先です。API キーは macOS のキーチェーンの鍵で暗号化して保存します。"
      actions={
        !compact && (
          <span className="flex gap-1">
            <Button
              small
              variant="ghost"
              onClick={async () => {
                const r = await window.longhand.importConnection();
                if (r.error) alert(r.error);
              }}
            >
              読み込む…
            </Button>
            <Button
              small
              variant="ghost"
              onClick={async () => {
                const r = await window.longhand.exportConnection();
                if (r.removedHeaders?.length) alert(`API キーと、認証情報らしいヘッダ（${r.removedHeaders.join('、')}）は書き出していません。受け取った人が自分で入力してください。`);
              }}
            >
              書き出す…
            </Button>
          </span>
        )
      }
    >
      <Row label="方式">
        <Select value={l.provider} options={PROVIDERS} onChange={(v) => update({ llm: { provider: v } })} className="max-w-[340px]" />
      </Row>
      <Row label={l.provider === 'azure-openai' ? 'エンドポイント' : '接続先 URL'} hint={URL_HINT[l.provider]} vertical>
        <TextField value={l.baseUrl} mono onCommit={(v) => update({ llm: { baseUrl: v.trim() } })} placeholder={l.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://'} />
      </Row>
      {l.provider === 'azure-openai' ? (
        <>
          <Row label="デプロイメント名">
            <TextField value={l.azure.deployment} mono className="w-64" onCommit={(v) => update({ llm: { azure: { deployment: v.trim() } } })} />
          </Row>
          <Row label="API バージョン">
            <TextField value={l.azure.apiVersion} mono className="w-40" onCommit={(v) => update({ llm: { azure: { apiVersion: v.trim() } } })} />
          </Row>
        </>
      ) : (
        <Row label="モデル名" hint={l.provider === 'anthropic' ? '例: claude-opus-5-5、claude-sonnet-5-5、claude-haiku-5-5' : '接続先で使えるモデル名'}>
          <TextField value={l.model} mono className="w-64" onCommit={(v) => update({ llm: { model: v.trim() } })} />
        </Row>
      )}
      <Row label="API キー">
        <ApiKeyField hasKey={snap.hasApiKey} />
      </Row>
      {!compact && (
        <>
          <Row label="追加のヘッダ" hint="ゲートウェイが求めるヘッダ（テナント ID など）。" vertical>
            <HeadersEditor headers={l.headers} onChange={(h) => update({ llm: { headers: h } })} />
          </Row>
          <Row label="タイムアウト" hint="これを過ぎたら、整形せずに書き起こしをそのまま入力します。">
            <NumberField value={l.timeoutMs} min={1000} max={60000} step={500} onCommit={(v) => update({ llm: { timeoutMs: v } })} suffix="ミリ秒" />
          </Row>
          <Row label="出力の上限">
            <NumberField value={l.maxOutputTokens} min={128} max={32000} step={128} onCommit={(v) => update({ llm: { maxOutputTokens: v } })} suffix="トークン" />
          </Row>
          {(l.provider === 'openai-compatible' || l.provider === 'azure-openai') && (
            <Row label="構造化出力" hint="接続先が対応していない場合は、自動で 1 段ずつ落とします。">
              <Select
                value={l.structuredOutput}
                options={[
                  { value: 'json_schema', label: 'JSON Schema' },
                  { value: 'json_object', label: 'JSON モード' },
                  { value: 'none', label: '使わない（プロンプトで指示）' },
                ]}
                onChange={(v) => update({ llm: { structuredOutput: v } })}
              />
            </Row>
          )}
          {l.provider === 'anthropic' && (
            <>
              <Row label="思考（thinking）" hint="整形は単純な作業なので、止めると速くなります。モデルごとに適切な指定を自動で選びます。">
                <Select
                  value={l.anthropic.thinking}
                  options={[
                    { value: 'off', label: '止める（推奨）' },
                    { value: 'adaptive', label: 'モデルに任せる' },
                    { value: 'omit', label: '指定しない' },
                  ]}
                  onChange={(v) => update({ llm: { anthropic: { thinking: v } } })}
                />
              </Row>
              <Row label="effort">
                <Select
                  value={l.anthropic.effort}
                  options={[
                    { value: 'low', label: 'low（推奨）' },
                    { value: 'medium', label: 'medium' },
                    { value: 'high', label: 'high' },
                    { value: '', label: 'モデルの既定' },
                  ]}
                  onChange={(v) => update({ llm: { anthropic: { effort: v } } })}
                />
              </Row>
              <Row label="プロンプトキャッシュ" hint="整形の規則と辞書をキャッシュして、応答を速くし費用を下げます。">
                <Toggle checked={l.anthropic.promptCaching} onChange={(v) => update({ llm: { anthropic: { promptCaching: v } } })} />
              </Row>
            </>
          )}
          {l.provider === 'custom-http' && (
            <>
              <Row label="リクエスト本文のテンプレート" hint="{{system}} {{user}} {{model}} {{max_tokens}} が JSON の値として埋め込まれます。" vertical>
                <textarea
                  className={cx(inputClass, 'min-h-[110px] font-mono text-[12px]')}
                  defaultValue={l.custom.bodyTemplate}
                  onBlur={(e) => update({ llm: { custom: { bodyTemplate: e.target.value } } })}
                />
              </Row>
              <Row label="応答から本文を取り出すパス" hint="例: choices.0.message.content、output.text">
                <TextField value={l.custom.responsePath} mono className="w-64" onCommit={(v) => update({ llm: { custom: { responsePath: v.trim() } } })} />
              </Row>
              <Row label="認証ヘッダ" hint="空にすると API キーを送りません（追加のヘッダに直接書く場合）。">
                <span className="inline-flex gap-1.5">
                  <TextField value={l.custom.authHeader} mono className="w-40" onCommit={(v) => update({ llm: { custom: { authHeader: v.trim() } } })} placeholder="Authorization" />
                  <TextField value={l.custom.authPrefix} mono className="w-28" onCommit={(v) => update({ llm: { custom: { authPrefix: v } } })} placeholder="Bearer " />
                </span>
              </Row>
            </>
          )}
          <Row label="追加のパラメータ（JSON）" hint='リクエスト本文にマージします。例: {"temperature": 0}（Anthropic の新しいモデルでは temperature は送れません）' vertical>
            <textarea className={cx(inputClass, 'min-h-[60px] font-mono text-[12px]')} defaultValue={l.extraBody} placeholder="{}" onBlur={(e) => update({ llm: { extraBody: e.target.value } })} />
          </Row>
        </>
      )}
      <Row
        label="接続テスト"
        hint={
          test ? (
            test.ok ? (
              <span className="text-emerald-700 dark:text-emerald-400">
                成功（{test.elapsedMs}ms、{test.model}）:「{test.output}」
              </span>
            ) : (
              <span className="text-rose-600 dark:text-rose-400">{test.error}</span>
            )
          ) : (
            '短い文を整形させて、応答と時間を確かめます。'
          )
        }
      >
        <Button small variant="primary" onClick={run} disabled={testing}>
          {testing ? 'テスト中…' : 'テスト'}
        </Button>
      </Row>
    </Section>
  );
}

const ENGINES = [
  { value: 'whisper', label: 'whisper large-v3-turbo（推奨）' },
  { value: 'apple', label: 'Apple SpeechTranscriber' },
  { value: 'parakeet', label: 'Parakeet 日本語版' },
];

const ENGINE_HINT: Record<string, string> = {
  whisper: '精度が一番高い。モデルは下の「ダウンロード」で取得します（約 835 MB）。',
  apple: 'macOS 26 以降。速く、モデルの取得も要りませんが、精度は whisper より落ちます。モデルは初回に OS が Apple のサーバーから取得します。',
  parakeet: '速いが、精度は 3 つの中で一番低い。モデルは asr/download-models.sh --parakeet で取得します。',
};

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** 音声認識のモデルの取得（ASR-5） */
export function ModelDownloadRow({ dl }: { dl: ModelDownloadState }) {
  const [importMsg, setImportMsg] = useState('');
  const busy = dl.state === 'downloading' || dl.state === 'waiting';
  const pct = dl.totalBytes ? Math.floor((dl.receivedBytes / dl.totalBytes) * 100) : 0;
  const doImport = async () => {
    const r = await window.longhand.importModel();
    if (!r.imported.length && !r.rejected.length) return setImportMsg('');
    setImportMsg(
      [r.imported.length ? `取り込みました: ${r.imported.join('、')}` : '', r.rejected.length ? `取り込めませんでした（中身が違うか、対象外のファイル）: ${r.rejected.join('、')}` : '']
        .filter(Boolean)
        .join('。'),
    );
  };
  let hint: string;
  if (busy) {
    hint = dl.state === 'waiting' ? `接続できませんでした（${dl.error}）。${dl.retryInSec} 秒後に再試行します。` : `${dl.file ?? ''} ${mb(dl.receivedBytes)} / ${mb(dl.totalBytes)}`;
  } else if (dl.bundled) {
    hint = 'アプリに同梱された whisper large-v3-turbo（q8_0）と Silero VAD を使っています。取得は要りません。';
  } else if (dl.installed) {
    hint = 'whisper large-v3-turbo（q8_0）と Silero VAD を取得済みです。';
  } else if (dl.state === 'failed') {
    hint = `取得できませんでした: ${dl.error}`;
  } else {
    hint = '約 835 MB。社外に出られない PC では、別の PC で取得したファイルを取り込めます。';
  }
  return (
    <Row label="モデル" hint={importMsg || hint} vertical={busy}>
      {busy ? (
        <div className="flex w-full items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <div className="h-full rounded-full bg-blue-500 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-10 text-right text-[12px] tabular-nums">{pct}%</span>
          <Button small onClick={() => void window.longhand.cancelModelDownload()}>
            中止
          </Button>
        </div>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          {dl.installed ? (
            <Badge tone="green">{dl.bundled ? '同梱' : '取得済み'}</Badge>
          ) : (
            <Button small variant="primary" onClick={() => void window.longhand.downloadModel()}>
              {dl.state === 'failed' || dl.state === 'cancelled' ? '再開' : 'ダウンロード'}
            </Button>
          )}
          <Button small onClick={() => void doImport()}>
            ファイルから取り込む…
          </Button>
        </span>
      )}
    </Row>
  );
}

export function AsrSettingsSection({ snap, update }: { snap: AppSnapshot; update: Update }) {
  const a = snap.settings.asr;
  const st = snap.status;
  const [test, setTest] = useState<AsrTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const label = { starting: '起動中', loading: 'モデルを読み込み中', ready: '準備完了', failed: 'エラー', missing: '未導入' }[st.asr];
  return (
    <Section title="音声認識（端末内）" description="音声は端末の外に出しません。">
      <Row label="状態" hint={st.asrMessage}>
        <span className="inline-flex items-center gap-2 text-[13px]">
          <StatusDot ok={st.asr === 'ready'} warn={st.asr === 'loading' || st.asr === 'starting'} />
          {label}
        </span>
      </Row>
      <Row label="エンジン" hint={ENGINE_HINT[a.engine] ?? 'asr/build/longhand-asr-<エンジン> を起動します。'}>
        <Select
          value={a.engine}
          options={[...ENGINES, ...(ENGINES.some((e) => e.value === a.engine) ? [] : [{ value: a.engine, label: a.engine }])]}
          onChange={(v) => update({ asr: { engine: v, modelPath: '' } })}
        />
      </Row>
      {a.engine === 'whisper' && !a.modelPath && <ModelDownloadRow dl={snap.modelDownload} />}
      {a.engine === 'whisper' && (
        <Row label="モデルの取得元" hint="ミラーから取るときに変えます（Hugging Face と同じ URL の構成）。" vertical>
          <TextField value={a.downloadBaseUrl} mono onCommit={(v) => update({ asr: { downloadBaseUrl: v.trim() || 'https://huggingface.co' } })} />
        </Row>
      )}
      <Row label="モデルのパス" hint="通常は空のままにします。空なら取得したモデル（models/<エンジン>/）を使います。" vertical>
        <TextField value={a.modelPath} mono onCommit={(v) => update({ asr: { modelPath: v.trim() } })} placeholder="（既定）" />
      </Row>
      <Row label="話しながら書き起こす" hint="長く話したとき、話の切れ目ごとに先に書き起こしておき、キーを離してからの待ち時間を減らします。">
        <Toggle checked={a.incremental} onChange={(v) => update({ asr: { incremental: v } })} />
      </Row>
      <Row
        label="辞書の語は、効いた所だけ取り込む"
        hint="辞書に語があるとき、辞書を使わない書き起こしと、使う書き起こしの 2 回を行い、辞書の語か英字の語が現れた所だけを取り込みます。辞書と関係のない所の聞き取りが変わるのを防ぎます。書き起こしが 2 回になるので、待ち時間が少し伸びます。"
      >
        <Toggle checked={a.hintMode === 'selective'} onChange={(v) => update({ asr: { hintMode: v ? 'selective' : 'always' } })} />
      </Row>
      <Row
        label="話の間で先に書き起こす（実験的）"
        hint="話が途切れたところで、キーを離す前に書き起こしを始めておきます。待ち時間が短くなる発話と、かえって長くなる発話があります。GPU の使用が増えます。"
      >
        <Toggle checked={a.speculative} onChange={(v) => update({ asr: { speculative: v } })} />
      </Row>
      <Row label="テスト" hint={test ? (test.ok ? `「${test.text}」（${test.elapsedMs}ms）` : test.error) : '直近の録音を書き起こし直します。'}>
        <span className="inline-flex gap-1.5">
          <Button small onClick={() => void window.longhand.openExternal('models')}>
            モデルのフォルダ
          </Button>
          <Button small onClick={() => void window.longhand.restartAsr()}>
            再起動
          </Button>
          <Button
            small
            variant="primary"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              setTest(await window.longhand.testAsr());
              setTesting(false);
            }}
          >
            {testing ? '実行中…' : 'テスト'}
          </Button>
        </span>
      </Row>
    </Section>
  );
}

function About({ snap, openOnboarding }: { snap: AppSnapshot; openOnboarding: () => void }) {
  const p = snap.permissions;
  const st = snap.status;
  return (
    <>
      <Section title="状態">
        <Row label="ヘルパー（ホットキー、録音、貼り付け）">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <StatusDot ok={st.helper === 'running'} warn={st.helper !== 'failed'} />
            {{ starting: '起動中', running: '動作中', restarting: '再起動中', failed: '停止' }[st.helper]}
          </span>
        </Row>
        <Row label="音声認識" hint={st.asr === 'ready' ? undefined : st.asrMessage}>
          <span className="inline-flex items-center gap-2 text-[13px]">
            <StatusDot ok={st.asr === 'ready'} warn={st.asr === 'loading' || st.asr === 'starting'} />
            {{ starting: '起動中', loading: 'モデルを読み込み中', ready: '準備完了', failed: 'エラー', missing: '未導入' }[st.asr]}
          </span>
        </Row>
        <Row label="アクセシビリティ">
          <span className="inline-flex items-center gap-2">
            <StatusDot ok={p.accessibility} />
            {!p.accessibility && (
              <Button small onClick={() => void window.longhand.requestPermission('accessibility').then(() => window.longhand.openExternal('accessibility'))}>
                許可する
              </Button>
            )}
          </span>
        </Row>
        <Row label="マイク">
          <span className="inline-flex items-center gap-2">
            <StatusDot ok={p.microphone === 'granted'} />
            {p.microphone !== 'granted' && (
              <Button small onClick={() => void (p.microphone === 'undetermined' ? window.longhand.requestPermission('microphone') : window.longhand.openExternal('microphone'))}>
                許可する
              </Button>
            )}
          </span>
        </Row>
        <Row label="LLM">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <StatusDot ok={st.llmConfigured} warn />
            {st.llmConfigured ? (snap.settings.skipLlm ? '使わない設定' : '設定済み') : '未設定'}
          </span>
        </Row>
      </Section>
      <Section title="情報">
        <Row label="バージョン">
          <Badge>{snap.version}</Badge>
        </Row>
        <Row label="ログ" hint={snap.paths.logs}>
          <Button small onClick={() => void window.longhand.openExternal('logs')}>
            Finder で開く
          </Button>
        </Row>
        <Row label="データ" hint={snap.paths.userData} />
        <Row label="初回の案内">
          <Button small onClick={openOnboarding}>
            もう一度表示
          </Button>
        </Row>
      </Section>
    </>
  );
}

export function SettingsPage({ snap, update, openOnboarding, initialTab }: { snap: AppSnapshot; update: Update; openOnboarding: () => void; initialTab?: string }) {
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : 'general');
  const s = snap.settings;
  return (
    <>
      <PageHeader title="設定" />
      <div className="mb-5 inline-flex flex-wrap rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.08]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              'rounded-md px-3 py-1 text-[13px]',
              tab === t.id ? 'bg-white font-medium shadow-sm dark:bg-white/20' : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'general' && <General s={s} update={update} />}
      {tab === 'keyboard' && <Keyboard s={s} update={update} />}
      {tab === 'dictation' && <Dictation s={s} update={update} />}
      {tab === 'audio' && <Audio s={s} update={update} />}
      {tab === 'connection' && (
        <>
          <LlmSettingsSection snap={snap} update={update} />
          <AsrSettingsSection snap={snap} update={update} />
        </>
      )}
      {tab === 'about' && <About snap={snap} openOnboarding={openOnboarding} />}
    </>
  );
}
