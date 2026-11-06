/**
 * Mind tab: which model thinks, where memory lives (one choice), who writes the summaries, who paints the pictures, and the Mind cloud.
 * Everything saves through PUT /api/preferences (write-only-if-changed); the key status lines come from GET /api/settings and never carry a key.
 */
import React, { useEffect, useState } from 'react';
import { Eyebrow, Group, TextField, ToggleRow } from './primitives';
import { HearthSelect } from '../hearth';
import { MindSection } from './MindSection';
import { SystemPromptBlock } from './SystemPromptBlock';
import { DSH_EMPTY, PREFS_CSS, PrefsSaveBar, usePreferences, type MemoryChoice } from './prefsShared';
import { SUMMARIZER_DEFAULT_KEY_ENV, imagegenKeyFor, keyMarker, keyEnvTyped, keyText, KEY_ENV_HINT, memoryMixedNote, memoryOptions, shownMemory, summarizerWho, type KeyState } from './mindState';

const SUMMARIZER = { provider: '', model: '', base_url: '', api_key_env: SUMMARIZER_DEFAULT_KEY_ENV };
const IMAGEGEN = { provider: 'none' as 'none' | 'runware' | 'replicate', model: '', size: '1024x1024', safety_checker: false };

export function MindTab({ base }: { base: string }) {
  const { draft, patchDraft, saveAll, saveStatus, saveError, dirty } = usePreferences(base);
  const [effective, setEffective] = useState<Record<string, unknown> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${base}/api/settings`);
        if (!res.ok) return;
        const data = await res.json() as { effective?: Record<string, unknown> };
        if (alive) setEffective(data.effective);
      } catch { /* the key lines say "not reported" */ }
    })();
    return () => { alive = false; };
  }, [base]);

  if (!draft) {
    return <div className="prefs-loading"><span className="sp-empty-text">Loading…</span></div>;
  }

  const provider = draft.agent.provider ?? 'claude';
  const summ = { ...SUMMARIZER, ...draft.agent.summarizer };
  const img = { ...IMAGEGEN, ...draft.imagegen };
  const setSumm = (u: Partial<typeof SUMMARIZER>) => patchDraft({ agent: { ...draft.agent, summarizer: { ...summ, ...u } } });
  const setImg = (u: Partial<typeof IMAGEGEN>) => patchDraft({ imagegen: { ...img, ...u } });
  const memory: MemoryChoice = shownMemory(provider, draft.memory ?? 'revien');
  const mixedNote = memoryMixedNote(draft.memory_mixed);
  const imgKey = imagegenKeyFor(img.provider);
  const summKey: KeyState = keyMarker(effective, 'summarizer.api_key');
  const summKeyIsDefault = summ.api_key_env === SUMMARIZER_DEFAULT_KEY_ENV;

  return (
    <div className="prefs-section">
      <style>{PREFS_CSS}</style>

      {/* ── Model ── */}
      <Eyebrow label="model" />
      <Group>
        <div className="prefs-form-block">
          <div className="sp-form-group">
            <label className="sp-form-label">
              provider <span className="sp-restart-badge" title="Applies on restart">restart</span>
            </label>
            <HearthSelect
              block
              ariaLabel="provider"
              value={provider}
              onChange={v => patchDraft({ agent: { ...draft.agent, provider: v as 'claude' | 'codex' | 'dsh' } })}
              options={[
                { value: 'claude', label: 'Claude', sublabel: 'Claude Agent SDK' },
                { value: 'codex', label: 'Codex', sublabel: 'Codex CLI, any provider it can reach' },
                { value: 'dsh', label: 'dsh', sublabel: 'DeepSeek Harness, OpenAI-compatible routes' },
              ]}
            />
          </div>
        </div>
      </Group>
      {provider === 'dsh' ? (
        <Group>
          <div className="prefs-form-block">
            <span className="sp-empty-text">
              Harness: dsh. The chat model runs live conversation; the autonomous model runs wakes and background helpers (digest, handoff,
              outlook). They are separate.
            </span>
            <TextField label="chat model" value={draft.agent.dsh?.model ?? ''} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, model: v } } })}
              hint="Model id for live chat, e.g. deepseek/deepseek-chat. Empty = dsh's default." />
            <TextField label="autonomous model" value={draft.agent.dsh?.model_autonomous ?? ''} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, model_autonomous: v } } })}
              hint="blank = same as chat model" />
            <TextField label="route (model provider)" value={draft.agent.dsh?.model_provider ?? ''} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, model_provider: v } } })}
              hint="The dsh route name, e.g. openrouter or deepseek-official." />
            <TextField label="base url" value={draft.agent.dsh?.base_url ?? ''} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, base_url: v } } })}
              hint="Optional endpoint override, e.g. https://openrouter.ai/api/v1. Empty = the route's default." />
            <TextField label="api key env var name" value={draft.agent.dsh?.api_key_env ?? ''} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, api_key_env: v } } })}
              hint="The NAME of the environment variable that holds the key, e.g. OPENROUTER_API_KEY. Never paste the key here; put it in .env." />
          </div>
        </Group>
      ) : provider === 'codex' && draft.agent.codex ? (
        <Group>
          <div className="prefs-form-block">
            <span className="sp-empty-text">
              Harness: Codex. Models are whatever Codex can reach: DeepSeek, a ChatGPT plan, or any provider in ~/.codex/config.toml. Empty
              fields follow the one above them; all empty means Codex's own default.
            </span>
            <TextField label="chat model" value={draft.agent.codex.model} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, model: v } } })}
              hint="Model id for live chat, e.g. deepseek-chat or gpt-5. Empty = Codex's default." />
            <TextField label="chat provider" value={draft.agent.codex.model_provider} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, model_provider: v } } })}
              hint="A [model_providers.*] name from ~/.codex/config.toml, e.g. deepseek. Empty = Codex's default provider." />
            <TextField label="autonomous model" value={draft.agent.codex.model_autonomous} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, model_autonomous: v } } })}
              hint="Background helpers (digest, handoff, outlook). Empty = same as the chat model." />
          </div>
        </Group>
      ) : (
        <Group>
          <div className="prefs-form-block">
            <TextField label="chat model" value={draft.agent.model} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, model: v } })}
              hint="Used for live chat sessions" />
            <TextField label="autonomous model" value={draft.agent.model_autonomous} mono restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, model_autonomous: v } })}
              hint="Used for orchestrator wake cycles. Empty = same as the chat model. If you set one, keep the same context window ([1m]) or wakes compact long before chat does." />
          </div>
        </Group>
      )}
      <p className="prefs-radio-hint">Effort is chosen per conversation, in the chat header.</p>

      {/* ── Memory: one choice ── */}
      <Eyebrow label="memory" sub="one system at a time" />
      <div className="prefs-radio" role="radiogroup" aria-label="Memory">
        {memoryOptions(provider).map(o => (
          <label key={o.value} className={`prefs-radio-opt${memory === o.value ? ' sel' : ''}`}>
            <input type="radio" name="memory-choice" value={o.value} checked={memory === o.value} onChange={() => patchDraft({ memory: o.value })} onClick={() => patchDraft({ memory: o.value })} />
            <span className="prefs-radio-text">
              <span className="prefs-radio-label">{o.label}</span>
              <span className="prefs-radio-hint">{o.hint}</span>
            </span>
          </label>
        ))}
        {mixedNote && <span className="prefs-radio-hint" data-testid="memory-mixed">{mixedNote}</span>}
        <span className="prefs-radio-hint">Applies on restart. Two systems at once fight over what to remember, so choosing one turns the others off.</span>
      </div>

      {/* ── Long-conversation memory + Summarizer ── */}
      <Eyebrow label="long-conversation memory" sub="rolling context" />
      <Group>
        <span className="sp-empty-text">
          Without this, the oldest messages quietly fall off the end of a long conversation. With it on, older messages are folded into a short
          summary your companion keeps reading. Turning it off keeps the summaries; nothing is deleted.
        </span>
        {draft.agent.rolling && (([['codex', 'on Codex'], ['claude', 'on Claude']] as Array<['codex' | 'claude', string]>)
          .sort((a, b) => (a[0] === provider ? -1 : b[0] === provider ? 1 : 0))
          .map(([key, label]) => (
            <ToggleRow key={key} label={`long-conversation memory ${label}`} checked={draft.agent.rolling![key]} restartRequired
              onChange={v => patchDraft({ agent: { ...draft.agent, rolling: { ...draft.agent.rolling!, [key]: v } } })}
              hint={key === provider ? 'This is the harness you are using now.' : 'Only matters if you switch to this harness.'} />
          )))}
      </Group>

      <Eyebrow label="summarizer" sub="who writes the summaries" />
      <Group>
        <div className="prefs-form-block">
          <div className="sp-form-group">
            <label className="sp-form-label">provider <span className="sp-restart-badge" title="Applies on restart">restart</span></label>
            <HearthSelect
              block
              ariaLabel="summarizer provider"
              value={summ.provider}
              onChange={v => setSumm({ provider: v })}
              options={[
                { value: '', label: 'The chat model', sublabel: 'the chat model writes them' },
                { value: 'openai-compat', label: 'An OpenAI-compatible endpoint', sublabel: 'OpenRouter, a local server, any /chat/completions route' },
                ...(summ.provider && summ.provider !== 'openai-compat' ? [{ value: summ.provider, label: summ.provider, sublabel: 'set in sanctum.yaml' }] : []),
              ]}
            />
          </div>
          {summ.provider !== '' && (
            <TextField label="model" value={summ.model} mono restartRequired onChange={v => setSumm({ model: v })}
              hint="It writes the companion's own memory: not a small model. Empty = the provider's chat model." />
          )}
          {summ.provider === 'openai-compat' && (
            <>
              <TextField label="base url" value={summ.base_url} mono restartRequired onChange={v => setSumm({ base_url: v })} hint="e.g. https://openrouter.ai/api/v1" />
              <TextField label="api key env var name" value={summ.api_key_env} mono restartRequired onChange={v => setSumm({ api_key_env: keyEnvTyped(v) })}
                hint={KEY_ENV_HINT} />
              <span className={`prefs-keystate ${summKeyIsDefault ? (summKey?.set ? 'set' : 'unset') : 'unset'}`} data-testid="summarizer-key">
                {summKeyIsDefault ? `key: ${keyText(summKey)}` : `key: set ${summ.api_key_env} in .env (status shows only for ${SUMMARIZER_DEFAULT_KEY_ENV})`}
              </span>
            </>
          )}
          <span className="prefs-radio-hint" data-testid="summarizer-who">{summarizerWho(summ, draft.agent.rolling)}</span>
        </div>
      </Group>

      {/* ── Pictures ── */}
      <Eyebrow label="pictures" sub="image generation" />
      <Group>
        <div className="prefs-form-block">
          <div className="sp-form-group">
            <label className="sp-form-label">provider <span className="sp-restart-badge" title="Applies on restart">restart</span></label>
            <HearthSelect
              block
              ariaLabel="pictures provider"
              value={img.provider}
              onChange={v => setImg({ provider: v as 'none' | 'runware' | 'replicate' })}
              options={[
                { value: 'none', label: 'None', sublabel: 'the companion cannot make pictures' },
                { value: 'runware', label: 'Runware' },
                { value: 'replicate', label: 'Replicate' },
              ]}
            />
          </div>
          {img.provider !== 'none' && (
            <>
              <TextField label="model" value={img.model} mono restartRequired onChange={v => setImg({ model: v })} hint="The provider's model id. Empty = its default." />
              <div className="sp-form-group">
                <label className="sp-form-label">size</label>
                <HearthSelect
                  block
                  ariaLabel="picture size"
                  value={img.size}
                  onChange={v => setImg({ size: v })}
                  options={[
                    { value: '1024x1024', label: 'Square', sublabel: '1024 x 1024' },
                    { value: '1024x1536', label: 'Tall', sublabel: '1024 x 1536' },
                    { value: '1536x1024', label: 'Wide', sublabel: '1536 x 1024' },
                  ]}
                />
              </div>
              <ToggleRow label="safety checker" checked={img.safety_checker} restartRequired onChange={v => setImg({ safety_checker: v })}
                hint="Asks the provider to screen what it makes. Off by default." />
              {imgKey && (
                <span className={`prefs-keystate ${keyMarker(effective, imgKey.key)?.set ? 'set' : 'unset'}`} data-testid="imagegen-key">
                  key: {keyText(keyMarker(effective, imgKey.key))} (set {imgKey.env} in .env)
                </span>
              )}
            </>
          )}
        </div>
      </Group>

      <PrefsSaveBar saveStatus={saveStatus} saveError={saveError} dirty={dirty} onSave={() => void saveAll()} />

      <SystemPromptBlock base={base} />

      {/* ── Mind cloud: its own card, unchanged ── */}
      <MindSection base={base} />
    </div>
  );
}
