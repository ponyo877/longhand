import { useEffect, useState } from 'react';
import type { MessageKey, Vars } from '../../shared/i18n';
import type { LlmProviderKind, Settings } from '../../shared/settings';
import type { AppSnapshot, AsrTestResult, ConnectionTestResult, DeepPartial, ModelDownloadState } from '../../shared/types';
import { useT } from '../common/i18n';
import { Badge, Button, cx, inputBase, inputClass, NumberField, PageHeader, Row, Section, Select, StatusDot, TextField, Toggle } from '../common/ui';
import { ShortcutSettings } from './Shortcuts';

type Update = (patch: DeepPartial<Settings>) => Promise<void>;
type Tab = 'general' | 'keyboard' | 'dictation' | 'audio' | 'connection' | 'about';

const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'general', label: 'settings.tab.general' },
  { id: 'keyboard', label: 'settings.tab.keyboard' },
  { id: 'dictation', label: 'settings.tab.dictation' },
  { id: 'audio', label: 'settings.tab.audio' },
  { id: 'connection', label: 'settings.tab.connection' },
  { id: 'about', label: 'settings.tab.about' },
];

/** A message to show later, kept as a key so that it follows a change of interface language */
type Note = { key: MessageKey; vars?: Vars };

function General({ s, update }: { s: Settings; update: Update }) {
  const t = useT();
  return (
    <>
      <Section title={t('settings.general.startup')}>
        <Row label={t('settings.general.launchAtLogin')} hint={t('settings.general.launchAtLoginHint')}>
          <Toggle checked={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
        </Row>
        <Row label={t('settings.general.showFloater')} hint={t('settings.general.showFloaterHint')}>
          <Toggle checked={s.showFloater} onChange={(v) => update({ showFloater: v, floaterSnoozeUntil: null })} />
        </Row>
        <Row label={t('settings.general.appearance')}>
          <Select
            value={s.appearance}
            options={[
              { value: 'system', label: t('settings.general.appearanceSystem') },
              { value: 'light', label: t('settings.general.appearanceLight') },
              { value: 'dark', label: t('settings.general.appearanceDark') },
            ]}
            onChange={(v) => update({ appearance: v })}
          />
        </Row>
        <Row label={t('settings.general.uiLanguage')} hint={t('settings.general.uiLanguageHint')}>
          <Select
            value={s.uiLanguage}
            options={[
              { value: 'system', label: t('settings.general.uiLanguageSystem') },
              // Language names are shown in their own language, so they are not translated
              { value: 'en', label: 'English' },
              { value: 'ja', label: '日本語' },
            ]}
            onChange={(v) => update({ uiLanguage: v })}
          />
        </Row>
        <Row label={t('settings.general.quitOnlyFromTray')} hint={t('settings.general.quitOnlyFromTrayHint')}>
          <Toggle checked={s.quitOnlyFromTray} onChange={(v) => update({ quitOnlyFromTray: v })} />
        </Row>
      </Section>
      <Section title={t('settings.general.clipboard')}>
        <Row label={t('settings.general.avoidClipboardHistory')} hint={t('settings.general.avoidClipboardHistoryHint')}>
          <Toggle checked={s.avoidClipboardHistory} onChange={(v) => update({ avoidClipboardHistory: v })} />
        </Row>
      </Section>
      <Section title={t('settings.general.history')} description={t('settings.general.historyDescription')}>
        <Row label={t('settings.general.historyLimit')}>
          <NumberField value={s.historyLimit} min={10} max={2000} onCommit={(v) => update({ historyLimit: v })} suffix={t('settings.unit.entries')} />
        </Row>
        <Row label={t('settings.general.saveRecordings')} hint={t('settings.general.saveRecordingsHint')}>
          <Toggle checked={s.saveRecordings} onChange={(v) => update({ saveRecordings: v })} />
        </Row>
        <Row label={t('settings.general.recordingRetention')}>
          <NumberField value={s.recordingRetentionHours} min={1} max={24 * 30} onCommit={(v) => update({ recordingRetentionHours: v })} suffix={t('settings.unit.hours')} />
        </Row>
        <Row label={t('settings.general.recordingMaxMB')}>
          <NumberField value={s.recordingMaxMB} min={10} max={10000} onCommit={(v) => update({ recordingMaxMB: v })} suffix="MB" />
        </Row>
        <Row label={t('settings.general.recordingsLocation')}>
          <Button small onClick={() => void window.longhand.openExternal('recordings')}>
            {t('settings.openInFinder')}
          </Button>
        </Row>
      </Section>
    </>
  );
}

function Keyboard({ s, update }: { s: Settings; update: Update }) {
  const t = useT();
  return (
    <>
      <Section title={t('settings.keyboard.shortcuts')} description={t('settings.keyboard.shortcutsDescription')}>
        <ShortcutSettings settings={s} update={(hotkeys) => void update({ hotkeys })} />
      </Section>
      <Section title={t('settings.keyboard.handsFree')}>
        <Row label={t('settings.keyboard.doubleTapToLock')} hint={t('settings.keyboard.doubleTapToLockHint')}>
          <Toggle checked={s.doubleTapToLock} onChange={(v) => update({ doubleTapToLock: v })} />
        </Row>
        <Row label={t('settings.keyboard.doubleTapMs')} hint={t('settings.keyboard.doubleTapMsHint')}>
          <NumberField value={s.doubleTapMs} min={150} max={800} step={10} onCommit={(v) => update({ doubleTapMs: v })} suffix={t('settings.unit.ms')} />
        </Row>
      </Section>
      <Section title={t('settings.keyboard.globe')}>
        <Row label={t('settings.keyboard.suppressGlobe')} hint={t('settings.keyboard.suppressGlobeHint')}>
          <Toggle checked={s.suppressGlobe} onChange={(v) => update({ suppressGlobe: v })} />
        </Row>
        <Row label={t('settings.keyboard.keyboardSettings')}>
          <Button small onClick={() => void window.longhand.openExternal('keyboard')}>
            {t('common.openSystemSettings')}
          </Button>
        </Row>
      </Section>
    </>
  );
}

function Dictation({ s, update }: { s: Settings; update: Update }) {
  const t = useT();
  return (
    <>
      <Section title={t('settings.dictation.language')}>
        <Row label={t('settings.dictation.spokenLanguage')}>
          <Select
            value={s.language}
            options={[
              { value: 'ja', label: t('settings.dictation.languageJa') },
              { value: 'en', label: t('settings.dictation.languageEn') },
              { value: 'auto', label: t('settings.dictation.languageAuto') },
            ]}
            onChange={(v) => update({ language: v })}
          />
        </Row>
      </Section>
      <Section title={t('settings.dictation.formatting')}>
        <Row label={t('settings.dictation.useLlm')} hint={t('settings.dictation.useLlmHint')}>
          <Toggle checked={!s.skipLlm} onChange={(v) => update({ skipLlm: !v })} />
        </Row>
        <Row label={t('settings.dictation.llmFastPath')} hint={t('settings.dictation.llmFastPathHint')}>
          <Toggle checked={s.llmFastPath} disabled={s.skipLlm} onChange={(v) => update({ llmFastPath: v })} />
        </Row>
        <Row label={t('settings.dictation.textFix')} hint={t('settings.dictation.textFixHint')}>
          <Toggle checked={s.textFix.enabled} onChange={(v) => update({ textFix: { enabled: v } })} />
        </Row>
        {s.textFix.enabled && (
          <>
            <Row label={t('settings.dictation.textFixLatin')} hint={t('settings.dictation.textFixLatinHint')}>
              <Toggle checked={s.textFix.latin} onChange={(v) => update({ textFix: { latin: v } })} />
            </Row>
            <Row label={t('settings.dictation.textFixFillers')} hint={t('settings.dictation.textFixFillersHint')}>
              <Toggle checked={s.textFix.fillers} onChange={(v) => update({ textFix: { fillers: v } })} />
            </Row>
            <Row label={t('settings.dictation.textFixNotation')} hint={t('settings.dictation.textFixNotationHint')}>
              <Toggle checked={s.textFix.notation} onChange={(v) => update({ textFix: { notation: v } })} />
            </Row>
            <Row label={t('settings.dictation.textFixParticles')} hint={t('settings.dictation.textFixParticlesHint')}>
              <Toggle checked={s.textFix.particles} onChange={(v) => update({ textFix: { particles: v } })} />
            </Row>
            {s.textFix.blocked.length > 0 && (
              <Row label={t('settings.dictation.textFixBlocked', { count: s.textFix.blocked.length })}>
                <Button small variant="secondary" onClick={() => update({ textFix: { blocked: [] } })}>
                  {t('settings.dictation.textFixUnblockAll')}
                </Button>
              </Row>
            )}
          </>
        )}
        <Row label={t('settings.dictation.editMode')} hint={t('settings.dictation.editModeHint')}>
          <Toggle checked={s.editModeEnabled} onChange={(v) => update({ editModeEnabled: v })} />
        </Row>
      </Section>
      <Section title={t('settings.dictation.context')} description={t('settings.dictation.contextDescription')}>
        <Row label={t('settings.dictation.sendAppContext')}>
          <Toggle checked={s.sendAppContext} onChange={(v) => update({ sendAppContext: v })} />
        </Row>
        <Row label={t('settings.dictation.sendFieldContext')} hint={t('settings.dictation.sendFieldContextHint')}>
          <Toggle checked={s.sendFieldContext} onChange={(v) => update({ sendFieldContext: v })} />
        </Row>
        <Row label={t('settings.dictation.chromiumEnhancedUI')} hint={t('settings.dictation.chromiumEnhancedUIHint')}>
          <Toggle checked={s.chromiumEnhancedUI} onChange={(v) => update({ chromiumEnhancedUI: v })} />
        </Row>
      </Section>
      <Section title={t('settings.dictation.learning')}>
        <Row label={t('settings.dictation.learningEnabled')} hint={t('settings.dictation.learningEnabledHint')}>
          <Toggle checked={s.learning.enabled} onChange={(v) => update({ learning: { enabled: v } })} />
        </Row>
        <Row label={t('settings.dictation.watchSeconds')}>
          <NumberField value={s.learning.watchSeconds} min={5} max={300} onCommit={(v) => update({ learning: { watchSeconds: v } })} suffix={t('settings.unit.seconds')} />
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
  const t = useT();
  const [mics, setMics] = useState<Awaited<ReturnType<typeof window.longhand.listMicrophones>>>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState<Note | null>(null);
  useEffect(() => void window.longhand.listMicrophones().then(setMics), []);
  useEffect(() => window.longhand.onMicLevel(setLevel), []);
  const test = async () => {
    setTesting(true);
    setResult(null);
    const r = await window.longhand.testMicrophone(3);
    setTesting(false);
    setLevel(0);
    if (!r.ok) setResult({ key: 'settings.audio.micTestFailed', vars: { error: r.error ?? '' } });
    else if (r.peak < 0.001) setResult({ key: 'settings.audio.micTestSilent' });
    else if (r.rms < 0.01) setResult({ key: 'settings.audio.micTestQuiet' });
    else setResult({ key: 'settings.audio.micTestOk' });
  };
  const real = mics.filter((m) => !m.isVirtual);
  return (
    <>
      <Section title={t('settings.audio.microphone')}>
        <Row label={t('settings.audio.microphoneId')} hint={t('settings.audio.microphoneIdHint')}>
          <Select
            value={s.microphoneId ?? ''}
            options={[
              { value: '', label: t('settings.audio.systemDefault') },
              ...real.map((m) => ({ value: m.id, label: m.transport === 'bluetooth' ? t('settings.audio.bluetoothMic', { name: m.name }) : m.name })),
            ]}
            onChange={(v) => update({ microphoneId: v || null })}
          />
        </Row>
        <Row label={t('settings.audio.micTest')} hint={result ? t(result.key, result.vars) : t('settings.audio.micTestHint')}>
          <span className="inline-flex items-center gap-3">
            {testing && <Meter level={level} />}
            <Button small onClick={test} disabled={testing}>
              {testing ? t('settings.audio.micTestRecording') : t('settings.test')}
            </Button>
          </span>
        </Row>
        {real.length > 1 && (
          <Row label={t('settings.audio.excludedMicrophones')} hint={t('settings.audio.excludedMicrophonesHint')} vertical>
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
      <Section title={t('settings.audio.soundsAndDetection')}>
        <Row label={t('settings.audio.playSounds')}>
          <Toggle checked={s.playSounds} onChange={(v) => update({ playSounds: v })} />
        </Row>
        <Row label={t('settings.audio.soundVolume')}>
          <input type="range" min={0} max={1} step={0.05} value={s.soundVolume} onChange={(e) => update({ soundVolume: Number(e.target.value) })} className="w-40" />
        </Row>
        <Row label={t('settings.audio.silenceDetection')} hint={t('settings.audio.silenceDetectionHint')}>
          <Toggle checked={s.silenceDetection} onChange={(v) => update({ silenceDetection: v })} />
        </Row>
        <Row label={t('settings.audio.minRecordingMs')} hint={t('settings.audio.minRecordingMsHint')}>
          <NumberField value={s.minRecordingMs} min={0} max={2000} step={50} onCommit={(v) => update({ minRecordingMs: v })} suffix={t('settings.unit.ms')} />
        </Row>
      </Section>
    </>
  );
}

const PROVIDERS: { value: LlmProviderKind; label: MessageKey }[] = [
  { value: 'openai-compatible', label: 'settings.llm.provider.openaiCompatible' },
  { value: 'azure-openai', label: 'settings.llm.provider.azureOpenai' },
  { value: 'anthropic', label: 'settings.llm.provider.anthropic' },
  { value: 'custom-http', label: 'settings.llm.provider.customHttp' },
];

const URL_HINT: Record<LlmProviderKind, MessageKey> = {
  'openai-compatible': 'settings.llm.urlHint.openaiCompatible',
  'azure-openai': 'settings.llm.urlHint.azureOpenai',
  anthropic: 'settings.llm.urlHint.anthropic',
  'custom-http': 'settings.llm.urlHint.customHttp',
};

function HeadersEditor({ headers, onChange }: { headers: Record<string, string>; onChange: (h: Record<string, string>) => void }) {
  const t = useT();
  const [rows, setRows] = useState(() => Object.entries(headers));
  useEffect(() => setRows(Object.entries(headers)), [headers]);
  const commit = (r: [string, string][]) => onChange(Object.fromEntries(r.filter(([k]) => k.trim())));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <input
            className={cx(inputClass, 'font-mono text-[12px]')}
            placeholder={t('settings.llm.headerName')}
            value={k}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
            onBlur={() => commit(rows)}
          />
          <input
            className={cx(inputClass, 'font-mono text-[12px]')}
            placeholder={t('settings.llm.headerValue')}
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
          {t('settings.llm.addHeader')}
        </Button>
      </div>
    </div>
  );
}

function ApiKeyField({ hasKey }: { hasKey: boolean }) {
  const t = useT();
  const [v, setV] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="password"
        className={cx(inputBase, 'w-64 font-mono text-[12px]')}
        placeholder={hasKey ? t('settings.llm.apiKeySaved') : t('settings.llm.apiKey')}
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
        {saved ? t('settings.llm.saved') : t('settings.llm.save')}
      </Button>
      {hasKey && !v && (
        <Button small variant="danger" onClick={() => void window.longhand.setApiKey('')}>
          {t('settings.llm.delete')}
        </Button>
      )}
    </span>
  );
}

export function LlmSettingsSection({ snap, update, compact }: { snap: AppSnapshot; update: Update; compact?: boolean }) {
  const t = useT();
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
      title={t('settings.llm.title')}
      description={t('settings.llm.description')}
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
              {t('settings.llm.import')}
            </Button>
            <Button
              small
              variant="ghost"
              onClick={async () => {
                const r = await window.longhand.exportConnection();
                if (r.removedHeaders?.length) alert(t('settings.llm.exportRemovedHeaders', { headers: r.removedHeaders.join(t('common.listSeparator')) }));
              }}
            >
              {t('settings.llm.export')}
            </Button>
          </span>
        )
      }
    >
      <Row label={t('settings.llm.provider')}>
        <Select value={l.provider} options={PROVIDERS.map((p) => ({ value: p.value, label: t(p.label) }))} onChange={(v) => update({ llm: { provider: v } })} className="max-w-[340px]" />
      </Row>
      <Row label={l.provider === 'azure-openai' ? t('settings.llm.endpoint') : t('settings.llm.baseUrl')} hint={t(URL_HINT[l.provider])} vertical>
        <TextField value={l.baseUrl} mono onCommit={(v) => update({ llm: { baseUrl: v.trim() } })} placeholder={l.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://'} />
      </Row>
      {l.provider === 'azure-openai' ? (
        <>
          <Row label={t('settings.llm.deployment')}>
            <TextField value={l.azure.deployment} mono className="w-64" onCommit={(v) => update({ llm: { azure: { deployment: v.trim() } } })} />
          </Row>
          <Row label={t('settings.llm.apiVersion')}>
            <TextField value={l.azure.apiVersion} mono className="w-40" onCommit={(v) => update({ llm: { azure: { apiVersion: v.trim() } } })} />
          </Row>
        </>
      ) : (
        <Row label={t('settings.llm.model')} hint={l.provider === 'anthropic' ? t('settings.llm.modelHintAnthropic') : t('settings.llm.modelHint')}>
          <TextField value={l.model} mono className="w-64" onCommit={(v) => update({ llm: { model: v.trim() } })} />
        </Row>
      )}
      <Row label={t('settings.llm.apiKey')}>
        <ApiKeyField hasKey={snap.hasApiKey} />
      </Row>
      {!compact && (
        <>
          <Row label={t('settings.llm.headers')} hint={t('settings.llm.headersHint')} vertical>
            <HeadersEditor headers={l.headers} onChange={(h) => update({ llm: { headers: h } })} />
          </Row>
          <Row label={t('settings.llm.timeout')} hint={t('settings.llm.timeoutHint')}>
            <NumberField value={l.timeoutMs} min={1000} max={60000} step={500} onCommit={(v) => update({ llm: { timeoutMs: v } })} suffix={t('settings.unit.ms')} />
          </Row>
          <Row label={t('settings.llm.maxOutputTokens')}>
            <NumberField value={l.maxOutputTokens} min={128} max={32000} step={128} onCommit={(v) => update({ llm: { maxOutputTokens: v } })} suffix={t('settings.unit.tokens')} />
          </Row>
          {(l.provider === 'openai-compatible' || l.provider === 'azure-openai') && (
            <Row label={t('settings.llm.structuredOutput')} hint={t('settings.llm.structuredOutputHint')}>
              <Select
                value={l.structuredOutput}
                options={[
                  { value: 'json_schema', label: 'JSON Schema' },
                  { value: 'json_object', label: t('settings.llm.structuredOutput.jsonObject') },
                  { value: 'none', label: t('settings.llm.structuredOutput.none') },
                ]}
                onChange={(v) => update({ llm: { structuredOutput: v } })}
              />
            </Row>
          )}
          {l.provider === 'anthropic' && (
            <>
              <Row label={t('settings.llm.thinking')} hint={t('settings.llm.thinkingHint')}>
                <Select
                  value={l.anthropic.thinking}
                  options={[
                    { value: 'off', label: t('settings.llm.thinking.off') },
                    { value: 'adaptive', label: t('settings.llm.thinking.adaptive') },
                    { value: 'omit', label: t('settings.llm.thinking.omit') },
                  ]}
                  onChange={(v) => update({ llm: { anthropic: { thinking: v } } })}
                />
              </Row>
              {/* effort and its levels are the API's own values, so they are shown as they are */}
              <Row label="effort">
                <Select
                  value={l.anthropic.effort}
                  options={[
                    { value: 'low', label: t('settings.llm.effort.lowRecommended') },
                    { value: 'medium', label: 'medium' },
                    { value: 'high', label: 'high' },
                    { value: '', label: t('settings.llm.effort.modelDefault') },
                  ]}
                  onChange={(v) => update({ llm: { anthropic: { effort: v } } })}
                />
              </Row>
              <Row label={t('settings.llm.promptCaching')} hint={t('settings.llm.promptCachingHint')}>
                <Toggle checked={l.anthropic.promptCaching} onChange={(v) => update({ llm: { anthropic: { promptCaching: v } } })} />
              </Row>
            </>
          )}
          {l.provider === 'custom-http' && (
            <>
              <Row label={t('settings.llm.bodyTemplate')} hint={t('settings.llm.bodyTemplateHint')} vertical>
                <textarea
                  className={cx(inputClass, 'min-h-[110px] font-mono text-[12px]')}
                  defaultValue={l.custom.bodyTemplate}
                  onBlur={(e) => update({ llm: { custom: { bodyTemplate: e.target.value } } })}
                />
              </Row>
              <Row label={t('settings.llm.responsePath')} hint={t('settings.llm.responsePathHint')}>
                <TextField value={l.custom.responsePath} mono className="w-64" onCommit={(v) => update({ llm: { custom: { responsePath: v.trim() } } })} />
              </Row>
              <Row label={t('settings.llm.authHeader')} hint={t('settings.llm.authHeaderHint')}>
                <span className="inline-flex gap-1.5">
                  <TextField value={l.custom.authHeader} mono className="w-40" onCommit={(v) => update({ llm: { custom: { authHeader: v.trim() } } })} placeholder="Authorization" />
                  <TextField value={l.custom.authPrefix} mono className="w-28" onCommit={(v) => update({ llm: { custom: { authPrefix: v } } })} placeholder="Bearer " />
                </span>
              </Row>
            </>
          )}
          <Row label={t('settings.llm.extraBody')} hint={t('settings.llm.extraBodyHint')} vertical>
            <textarea className={cx(inputClass, 'min-h-[60px] font-mono text-[12px]')} defaultValue={l.extraBody} placeholder="{}" onBlur={(e) => update({ llm: { extraBody: e.target.value } })} />
          </Row>
        </>
      )}
      <Row
        label={t('settings.llm.test')}
        hint={
          test ? (
            test.ok ? (
              <span className="text-emerald-700 dark:text-emerald-400">{t('settings.llm.testOk', { elapsedMs: test.elapsedMs, model: test.model ?? '', output: test.output ?? '' })}</span>
            ) : (
              <span className="text-rose-600 dark:text-rose-400">{test.error}</span>
            )
          ) : (
            t('settings.llm.testHint')
          )
        }
      >
        <Button small variant="primary" onClick={run} disabled={testing}>
          {testing ? t('settings.llm.testing') : t('settings.test')}
        </Button>
      </Row>
    </Section>
  );
}

const ENGINES: { value: string; label: MessageKey; hint: MessageKey }[] = [
  { value: 'whisper', label: 'settings.asr.engine.whisper', hint: 'settings.asr.engineHint.whisper' },
  { value: 'apple', label: 'settings.asr.engine.apple', hint: 'settings.asr.engineHint.apple' },
  { value: 'parakeet', label: 'settings.asr.engine.parakeet', hint: 'settings.asr.engineHint.parakeet' },
];

const ASR_STATE: Record<AppSnapshot['status']['asr'], MessageKey> = {
  starting: 'settings.asr.state.starting',
  loading: 'settings.asr.state.loading',
  ready: 'settings.asr.state.ready',
  failed: 'settings.asr.state.failed',
  missing: 'settings.asr.state.missing',
};

const HELPER_STATE: Record<AppSnapshot['status']['helper'], MessageKey> = {
  starting: 'settings.about.helper.starting',
  running: 'settings.about.helper.running',
  restarting: 'settings.about.helper.restarting',
  failed: 'settings.about.helper.failed',
};

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Downloading the speech recognition model (ASR-5) */
export function ModelDownloadRow({ dl }: { dl: ModelDownloadState }) {
  const t = useT();
  const [importMsg, setImportMsg] = useState<Note | null>(null);
  const busy = dl.state === 'downloading' || dl.state === 'waiting';
  const pct = dl.totalBytes ? Math.floor((dl.receivedBytes / dl.totalBytes) * 100) : 0;
  const doImport = async () => {
    const r = await window.longhand.importModel();
    const imported = r.imported.join(t('common.listSeparator'));
    const rejected = r.rejected.join(t('common.listSeparator'));
    if (r.imported.length && r.rejected.length) setImportMsg({ key: 'settings.model.importedAndRejected', vars: { imported, rejected } });
    else if (r.imported.length) setImportMsg({ key: 'settings.model.imported', vars: { files: imported } });
    else if (r.rejected.length) setImportMsg({ key: 'settings.model.rejected', vars: { files: rejected } });
    else setImportMsg(null);
  };
  let hint: string;
  if (busy) {
    hint = dl.state === 'waiting' ? t('settings.model.waiting', { error: dl.error ?? '', seconds: dl.retryInSec ?? 0 }) : `${dl.file ?? ''} ${mb(dl.receivedBytes)} / ${mb(dl.totalBytes)}`;
  } else if (dl.bundled) {
    hint = t('settings.model.bundled');
  } else if (dl.installed) {
    hint = t('settings.model.installed');
  } else if (dl.state === 'failed') {
    hint = t('settings.model.failed', { error: dl.error ?? '' });
  } else {
    hint = t('settings.model.notInstalled');
  }
  return (
    <Row label={t('settings.model.label')} hint={importMsg ? t(importMsg.key, importMsg.vars) : hint} vertical={busy}>
      {busy ? (
        <div className="flex w-full items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <div className="h-full rounded-full bg-blue-500 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-10 text-right text-[12px] tabular-nums">{pct}%</span>
          <Button small onClick={() => void window.longhand.cancelModelDownload()}>
            {t('settings.model.cancel')}
          </Button>
        </div>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          {dl.installed ? (
            <Badge tone="green">{dl.bundled ? t('settings.model.bundledBadge') : t('settings.model.installedBadge')}</Badge>
          ) : (
            <Button small variant="primary" onClick={() => void window.longhand.downloadModel()}>
              {dl.state === 'failed' || dl.state === 'cancelled' ? t('settings.model.resume') : t('settings.model.download')}
            </Button>
          )}
          <Button small onClick={() => void doImport()}>
            {t('settings.model.importFile')}
          </Button>
        </span>
      )}
    </Row>
  );
}

export function AsrSettingsSection({ snap, update }: { snap: AppSnapshot; update: Update }) {
  const t = useT();
  const a = snap.settings.asr;
  const st = snap.status;
  const [test, setTest] = useState<AsrTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const engine = ENGINES.find((e) => e.value === a.engine);
  return (
    <Section title={t('settings.asr.title')} description={t('settings.asr.description')}>
      <Row label={t('settings.asr.status')} hint={st.asrMessage}>
        <span className="inline-flex items-center gap-2 text-[13px]">
          <StatusDot ok={st.asr === 'ready'} warn={st.asr === 'loading' || st.asr === 'starting'} />
          {t(ASR_STATE[st.asr])}
        </span>
      </Row>
      <Row label={t('settings.asr.engine')} hint={engine ? t(engine.hint) : t('settings.asr.engineHint.other')}>
        <Select
          value={a.engine}
          options={[...ENGINES.map((e) => ({ value: e.value, label: t(e.label) })), ...(engine ? [] : [{ value: a.engine, label: a.engine }])]}
          onChange={(v) => update({ asr: { engine: v, modelPath: '' } })}
        />
      </Row>
      {a.engine === 'whisper' && !a.modelPath && <ModelDownloadRow dl={snap.modelDownload} />}
      {a.engine === 'whisper' && (
        <Row label={t('settings.asr.downloadBaseUrl')} hint={t('settings.asr.downloadBaseUrlHint')} vertical>
          <TextField value={a.downloadBaseUrl} mono onCommit={(v) => update({ asr: { downloadBaseUrl: v.trim() || 'https://huggingface.co' } })} />
        </Row>
      )}
      <Row label={t('settings.asr.modelPath')} hint={t('settings.asr.modelPathHint')} vertical>
        <TextField value={a.modelPath} mono onCommit={(v) => update({ asr: { modelPath: v.trim() } })} placeholder={t('settings.asr.modelPathDefault')} />
      </Row>
      <Row label={t('settings.asr.incremental')} hint={t('settings.asr.incrementalHint')}>
        <Toggle checked={a.incremental} onChange={(v) => update({ asr: { incremental: v } })} />
      </Row>
      <Row label={t('settings.asr.selectiveHints')} hint={t('settings.asr.selectiveHintsHint')}>
        <Toggle checked={a.hintMode === 'selective'} onChange={(v) => update({ asr: { hintMode: v ? 'selective' : 'always' } })} />
      </Row>
      <Row label={t('settings.asr.speculative')} hint={t('settings.asr.speculativeHint')}>
        <Toggle checked={a.speculative} onChange={(v) => update({ asr: { speculative: v } })} />
      </Row>
      <Row label={t('settings.test')} hint={test ? (test.ok ? t('settings.asr.testOk', { text: test.text ?? '', elapsedMs: test.elapsedMs ?? 0 }) : test.error) : t('settings.asr.testHint')}>
        <span className="inline-flex gap-1.5">
          <Button small onClick={() => void window.longhand.openExternal('models')}>
            {t('settings.asr.modelFolder')}
          </Button>
          <Button small onClick={() => void window.longhand.restartAsr()}>
            {t('settings.asr.restart')}
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
            {testing ? t('settings.asr.running') : t('settings.test')}
          </Button>
        </span>
      </Row>
    </Section>
  );
}

function About({ snap, openOnboarding }: { snap: AppSnapshot; openOnboarding: () => void }) {
  const t = useT();
  const p = snap.permissions;
  const st = snap.status;
  return (
    <>
      <Section title={t('settings.about.status')}>
        <Row label={t('settings.about.helper')}>
          <span className="inline-flex items-center gap-2 text-[13px]">
            <StatusDot ok={st.helper === 'running'} warn={st.helper !== 'failed'} />
            {t(HELPER_STATE[st.helper])}
          </span>
        </Row>
        <Row label={t('settings.about.asr')} hint={st.asr === 'ready' ? undefined : st.asrMessage}>
          <span className="inline-flex items-center gap-2 text-[13px]">
            <StatusDot ok={st.asr === 'ready'} warn={st.asr === 'loading' || st.asr === 'starting'} />
            {t(ASR_STATE[st.asr])}
          </span>
        </Row>
        <Row label={t('settings.about.accessibility')}>
          <span className="inline-flex items-center gap-2">
            <StatusDot ok={p.accessibility} />
            {!p.accessibility && (
              <Button small onClick={() => void window.longhand.requestPermission('accessibility').then(() => window.longhand.openExternal('accessibility'))}>
                {t('settings.about.allow')}
              </Button>
            )}
          </span>
        </Row>
        <Row label={t('settings.about.microphone')}>
          <span className="inline-flex items-center gap-2">
            <StatusDot ok={p.microphone === 'granted'} />
            {p.microphone !== 'granted' && (
              <Button small onClick={() => void (p.microphone === 'undetermined' ? window.longhand.requestPermission('microphone') : window.longhand.openExternal('microphone'))}>
                {t('settings.about.allow')}
              </Button>
            )}
          </span>
        </Row>
        <Row label="LLM">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <StatusDot ok={st.llmConfigured} warn />
            {st.llmConfigured ? (snap.settings.skipLlm ? t('settings.about.llmSkipped') : t('settings.about.llmConfigured')) : t('settings.about.llmNotConfigured')}
          </span>
        </Row>
      </Section>
      <Section title={t('settings.about.info')}>
        <Row label={t('settings.about.version')}>
          <Badge>{snap.version}</Badge>
        </Row>
        <Row label={t('settings.about.logs')} hint={snap.paths.logs}>
          <Button small onClick={() => void window.longhand.openExternal('logs')}>
            {t('settings.openInFinder')}
          </Button>
        </Row>
        <Row label={t('settings.about.data')} hint={snap.paths.userData} />
        <Row label={t('settings.about.onboarding')}>
          <Button small onClick={openOnboarding}>
            {t('settings.about.showAgain')}
          </Button>
        </Row>
      </Section>
    </>
  );
}

export function SettingsPage({ snap, update, openOnboarding, initialTab }: { snap: AppSnapshot; update: Update; openOnboarding: () => void; initialTab?: string }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(TABS.some((x) => x.id === initialTab) ? (initialTab as Tab) : 'general');
  const s = snap.settings;
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="mb-5 inline-flex flex-wrap rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.08]">
        {TABS.map((x) => (
          <button
            key={x.id}
            onClick={() => setTab(x.id)}
            className={cx(
              'rounded-md px-3 py-1 text-[13px]',
              tab === x.id ? 'bg-white font-medium shadow-sm dark:bg-white/20' : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
            )}
          >
            {t(x.label)}
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
