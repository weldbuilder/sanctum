/**
 * Preferences section — full editable sanctum.yaml via GET/PUT /api/preferences.
 * Identity · Model · Server · Write-gate · Integrations · Auth
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Card,
  Group,
  Eyebrow,
  TextField,
  ToggleRow,
  SaveIndicator,
  FieldRow,
  FormGroup,
  Btn,
} from './primitives';
import { SetupWizard } from '../SetupWizard';
import { HearthSelect } from '../hearth';
import { loadTenantInfo, tenantLine, type TenantInfo } from './tenantState';

// ─── Types ────────────────────────────────────────────────────────────────────

/** agent.dsh as saved in yaml; '' = unset. api_key_env is a variable NAME, never a key. */
interface DshPrefs {
  model: string;
  model_autonomous: string;
  model_provider: string;
  base_url: string;
  api_key_env: string;
}
const DSH_EMPTY: DshPrefs = { model: '', model_autonomous: '', model_provider: '', base_url: '', api_key_env: '' };

interface Preferences {
  identity: {
    companion_name: string;
    user_name: string;
    timezone: string;
  };
  agent: {
    model: string;
    model_autonomous: string;
    provider?: 'claude' | 'codex' | 'dsh';
    app_write?: boolean;
    dsh?: DshPrefs;
    codex?: {
      model: string;
      model_provider: string;
      model_autonomous: string;
      sandbox_mode: 'read-only' | 'workspace-write' | 'danger-full-access';
      network_access: boolean;
      additional_directories: string[];
    };
    rolling?: { claude: boolean; codex: boolean; model: string; model_provider: string };
  };
  /** Read-only: PM2 pins PORT in env (ecosystem.config.cjs), which overrides
   *  sanctum.yaml at boot — so the UI shows live truth instead of offering a
   *  save that would silently not take effect. */
  server?: {
    port?: number;
  };
  /** Write-gate roots — yaml-backed under hooks.* (the real config keys; the
   *  old `paths.*` shape never existed server-side and every save dropped). */
  hooks?: {
    workspace_root?: string;
    vault_path?: string;
    extra_write_paths?: string[];
  };
  orchestrator: {
    enabled: boolean;
    wake_prompts_path?: string;
  };
  voice: {
    enabled: boolean;
    elevenlabs_voice_id?: string;
  };
  discord: {
    enabled: boolean;
  };
  telegram: {
    enabled: boolean;
  };
  handoff?: {
    enabled: boolean;
  };
  integrations?: {
    browser_url?: string;
    mind_cloud?: {
      enabled: boolean;
      mcp_url?: string;
      mind_id?: string;
    };
  };
  command_center?: { enabled?: boolean };
  auth: {
    has_password: boolean;
  };
}

function deepMerge(target: any, source: any): any {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof out[key] === 'object' &&
      out[key] !== null
    ) {
      out[key] = { ...out[key], ...source[key] };
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PreferencesSection({ base }: { base: string }) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [dirty, setDirty] = useState(false);
  // Run setup again: the wizard over the settings, and a reload of what it may have changed when it closes.
  const [setupOpen, setSetupOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // Tenant mode only: which host and folder serve this tenant (a 404 on a single-user install: no line).
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  useEffect(() => { void loadTenantInfo(base).then(setTenant); }, [base]);

  // Raw config editor (advanced — full sanctum.yaml)
  const [rawOpen, setRawOpen] = useState(false);
  const [rawContent, setRawContent] = useState('');
  const [rawDraft, setRawDraft] = useState('');
  const [rawPath, setRawPath] = useState('');
  const [rawLoading, setRawLoading] = useState(false);
  const [rawStatus, setRawStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [rawError, setRawError] = useState('');

  // System-prompt frame (separate endpoint — applies live, no restart)
  const [sysConfigured, setSysConfigured] = useState(false);
  const [sysContent, setSysContent] = useState('');
  const [sysDraft, setSysDraft] = useState('');
  const [sysPath, setSysPath] = useState('');
  const [sysProvider, setSysProvider] = useState('claude');
  const [sysAgentsPath, setSysAgentsPath] = useState('');
  const [sysStatus, setSysStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    async function loadSys() {
      try {
        const res = await fetch(`${base}/api/prompts/system`);
        if (!res.ok) return;
        const data = await res.json();
        setSysConfigured(!!data.configured);
        setSysContent(data.content ?? '');
        setSysDraft(data.content ?? '');
        setSysPath(data.path ?? '');
        setSysProvider(data.provider ?? 'claude');
        setSysAgentsPath(data.agents_md ?? '');
      } catch { /* backend not up */ }
    }
    loadSys();
  }, [base]);

  const saveSystemPrompt = useCallback(async () => {
    setSysStatus('saving');
    try {
      const res = await fetch(`${base}/api/prompts/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: sysDraft }),
      });
      if (res.ok) { setSysContent(sysDraft); setSysStatus('saved'); }
      else setSysStatus('error');
    } catch { setSysStatus('error'); }
    setTimeout(() => setSysStatus('idle'), 2200);
  }, [base, sysDraft]);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${base}/api/preferences`);
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.identity) {
          setPrefs(data as Preferences);
          setDraft(data as Preferences);
        }
      } catch { /* backend not yet up */ }
    }
    load();
  }, [base, reloadTick]);

  const patchDraft = useCallback((update: any) => {
    setDraft(prev => prev ? deepMerge(prev, update) as Preferences : null);
    setDirty(true);
  }, []);

  // Immediate-save toggle for booleans (matches old behaviour)
  const patchImmediate = useCallback(async (update: Partial<Preferences>) => {
    if (!draft) return;
    const merged = deepMerge(draft, update) as Preferences;
    setDraft(merged);
    setPrefs(merged);
    setSaveStatus('saving');
    try {
      const res = await fetch(`${base}/api/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      setSaveStatus(res.ok ? 'saved' : 'error');
    } catch {
      setSaveStatus('error');
    }
    setTimeout(() => setSaveStatus('idle'), 2200);
  }, [draft, base]);

  // Load raw config when disclosure opens
  useEffect(() => {
    if (!rawOpen) return;
    setRawLoading(true);
    fetch(`${base}/api/config/raw`)
      .then(r => r.json())
      .then(data => {
        setRawContent(data.content ?? '');
        setRawDraft(data.content ?? '');
        setRawPath(data.path ?? '');
      })
      .catch(() => {})
      .finally(() => setRawLoading(false));
  }, [rawOpen, base]);

  const saveRawConfig = useCallback(async () => {
    setRawStatus('saving');
    setRawError('');
    try {
      const res = await fetch(`${base}/api/config/raw`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: rawDraft }),
      });
      const data = await res.json();
      if (res.ok) {
        setRawContent(rawDraft);
        setRawStatus('saved');
      } else {
        setRawError(data.error || 'Save failed');
        setRawStatus('error');
      }
    } catch {
      setRawError('Network error');
      setRawStatus('error');
    }
    setTimeout(() => setRawStatus('idle'), 3200);
  }, [base, rawDraft]);

  const [saveError, setSaveError] = useState<string | null>(null);

  const saveAll = async () => {
    if (!draft) return;
    setSaveStatus('saving');
    setSaveError(null);
    try {
      const res = await fetch(`${base}/api/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (res.ok) {
        setPrefs(draft);
        setDirty(false);
        setSaveStatus('saved');
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setSaveError(data.error ?? `Save failed (HTTP ${res.status})`);
        setSaveStatus('error');
      }
    } catch {
      setSaveError('Network error — nothing was saved');
      setSaveStatus('error');
    }
    setTimeout(() => setSaveStatus('idle'), 2200);
  };

  if (!draft) {
    return (
      <div className="prefs-loading">
        <span className="sp-empty-text">Loading preferences…</span>
      </div>
    );
  }

  const extraPaths = draft.hooks?.extra_write_paths?.join(', ') ?? '';

  return (
    <div className="prefs-section">

      {tenantLine(tenant) && <p className="sp-empty-text" data-testid="tenant-line">{tenantLine(tenant)}</p>}

      {/* ── Identity ── */}
      <Eyebrow label="identity" />
      <Group>
        <div className="prefs-form-block">
          <TextField
            label="companion name"
            value={draft.identity.companion_name}
            onChange={v => patchDraft({ identity: { ...draft.identity, companion_name: v } })}
            mono
            restartRequired
          />
          <TextField
            label="user name"
            value={draft.identity.user_name}
            onChange={v => patchDraft({ identity: { ...draft.identity, user_name: v } })}
            mono
            restartRequired
          />
          <TextField
            label="timezone"
            value={draft.identity.timezone}
            onChange={v => patchDraft({ identity: { ...draft.identity, timezone: v } })}
            mono
            hint="IANA timezone string — e.g. Europe/London"
          />
        </div>
      </Group>

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
              value={draft.agent.provider ?? 'claude'}
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
      {draft.agent.provider === 'dsh' ? (
        <Group>
          <div className="prefs-form-block">
            <span className="sp-empty-text">
              Harness: dsh. The chat model runs live conversation; the autonomous model runs
              wakes and background helpers (digest, handoff, outlook). They are separate.
            </span>
            <TextField
              label="chat model"
              value={draft.agent.dsh?.model ?? ''}
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, model: v } } })}
              mono
              restartRequired
              hint="Model id for live chat, e.g. deepseek/deepseek-chat. Empty = dsh's default."
            />
            <TextField
              label="autonomous model"
              value={draft.agent.dsh?.model_autonomous ?? ''}
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, model_autonomous: v } } })}
              mono
              restartRequired
              hint="blank = same as chat model"
            />
            <TextField
              label="route (model provider)"
              value={draft.agent.dsh?.model_provider ?? ''}
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, model_provider: v } } })}
              mono
              restartRequired
              hint="The dsh route name, e.g. openrouter or deepseek-official."
            />
            <TextField
              label="base url"
              value={draft.agent.dsh?.base_url ?? ''}
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, base_url: v } } })}
              mono
              restartRequired
              hint="Optional endpoint override, e.g. https://openrouter.ai/api/v1. Empty = the route's default."
            />
            <TextField
              label="api key env var name"
              value={draft.agent.dsh?.api_key_env ?? ''}
              onChange={v => patchDraft({ agent: { ...draft.agent, dsh: { ...DSH_EMPTY, ...draft.agent.dsh, api_key_env: v } } })}
              mono
              restartRequired
              hint="The NAME of the environment variable that holds the key, e.g. OPENROUTER_API_KEY. Never paste the key here; put it in .env."
            />
          </div>
        </Group>
      ) : draft.agent.provider === 'codex' && draft.agent.codex ? (
        <Group>
          <div className="prefs-form-block">
            <span className="sp-empty-text">
              Harness: Codex. Models are whatever Codex can reach: DeepSeek, a ChatGPT plan, or any
              provider in ~/.codex/config.toml. Empty fields follow the one above them; all empty
              means Codex's own default. To switch harness, run npm run setup.
            </span>
            <TextField
              label="chat model"
              value={draft.agent.codex.model}
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, model: v } } })}
              mono
              restartRequired
              hint="Model id for live chat, e.g. deepseek-chat or gpt-5. Empty = Codex's default."
            />
            <TextField
              label="chat provider"
              value={draft.agent.codex.model_provider}
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, model_provider: v } } })}
              mono
              restartRequired
              hint="A [model_providers.*] name from ~/.codex/config.toml, e.g. deepseek. Empty = Codex's default provider."
            />
            <TextField
              label="autonomous model"
              value={draft.agent.codex.model_autonomous}
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, model_autonomous: v } } })}
              mono
              restartRequired
              hint="Background helpers (digest, handoff, outlook). Empty = same as the chat model."
            />
          </div>
        </Group>
      ) : (
      <Group>
        <div className="prefs-form-block">
          <TextField
            label="interactive model"
            value={draft.agent.model}
            onChange={v => patchDraft({ agent: { ...draft.agent, model: v } })}
            mono
            restartRequired
            hint="Used for live chat sessions"
          />
          <TextField
            label="autonomous model"
            value={draft.agent.model_autonomous}
            onChange={v => patchDraft({ agent: { ...draft.agent, model_autonomous: v } })}
            mono
            restartRequired
            hint="Used for orchestrator wake cycles. Empty = same as the interactive model. If you set one, keep the same context window ([1m]) or wakes compact long before chat does."
          />
        </div>
      </Group>
      )}

      {/* ── System prompt frame ── */}
      <Eyebrow label="system prompt" />
      <Card>
        <div className="prefs-form-block">
          {sysProvider === 'codex' ? (
            <span className="sp-empty-text">
              On Codex, your companion's identity lives in two files in their home
              folder: profile.md and companion.md. Edit those to change who they are.
              {sysAgentsPath && <code className="sysprompt-path">{sysAgentsPath}</code>}
            </span>
          ) : sysConfigured ? (
            <div className="sysprompt-block">
              <div className="sysprompt-head">
                <span className="sysprompt-hint">
                  The lean operating frame, prepended before CLAUDE.md. Replaces the
                  Claude Code preset. <strong>Applies live — no restart.</strong>
                </span>
                {sysPath && <code className="sysprompt-path">{sysPath}</code>}
              </div>
              <textarea
                className="sysprompt-textarea"
                value={sysDraft}
                onChange={e => setSysDraft(e.target.value)}
                spellCheck={false}
                rows={18}
                aria-label="System prompt frame"
              />
              <div className="sysprompt-actions">
                <SaveIndicator status={sysStatus} />
                <button
                  className="sysprompt-save"
                  onClick={saveSystemPrompt}
                  disabled={sysDraft === sysContent || sysStatus === 'saving'}
                >
                  save frame
                </button>
              </div>
            </div>
          ) : (
            <span className="sp-empty-text">
              No system_prompt_file configured. Set agent.system_prompt_file in
              sanctum.yaml to edit the frame here.
            </span>
          )}
        </div>
        <style>{`
          .sysprompt-block { display: flex; flex-direction: column; gap: 0.75rem; }
          .sysprompt-head { display: flex; flex-direction: column; gap: 0.375rem; }
          .sysprompt-hint {
            font-size: 0.8125rem; line-height: 1.5;
            color: var(--text-secondary, #a09689);
          }
          .sysprompt-hint strong { color: var(--amber, #c9a87c); font-weight: 500; }
          .sysprompt-path {
            font-family: var(--font-mono, monospace);
            font-size: 0.6875rem; color: var(--text-muted, #6a6258);
            opacity: 0.8; word-break: break-all;
          }
          .sysprompt-textarea {
            width: 100%; box-sizing: border-box; resize: vertical;
            min-height: 16rem;
            background: rgba(12, 11, 9, 0.6);
            border: 1px solid rgba(201, 168, 124, 0.14);
            border-radius: 0.5rem; padding: 0.875rem 1rem;
            color: var(--text-primary, #e2dbd0);
            font-family: var(--font-mono, 'JetBrains Mono', monospace);
            font-size: 0.78125rem; line-height: 1.6;
            transition: border-color 240ms var(--hearth-curve, ease);
          }
          .sysprompt-textarea:focus {
            outline: none;
            border-color: rgba(201, 168, 124, 0.45);
            box-shadow: 0 0 0 3px rgba(201, 168, 124, 0.07);
          }
          .sysprompt-actions {
            display: flex; align-items: center; justify-content: flex-end;
            gap: 0.875rem;
          }
          .sysprompt-save {
            font-size: 0.8125rem; font-weight: 500;
            color: var(--bg-primary, #0c0b09);
            background: var(--amber, #c9a87c);
            border: none; border-radius: 0.4375rem;
            padding: 0.4375rem 0.9375rem; cursor: pointer;
            transition: opacity 200ms var(--hearth-curve, ease), transform 100ms var(--hearth-curve, ease);
          }
          .sysprompt-save:hover:not(:disabled) { opacity: 0.9; }
          .sysprompt-save:active:not(:disabled) { transform: scale(0.985); }
          .sysprompt-save:disabled { opacity: 0.4; cursor: default; }
        `}</style>
      </Card>

      {/* ── Server ── */}
      <Eyebrow label="server" />
      <Group>
        {/* Honest read-only: PM2 pins PORT in env (ecosystem.config.cjs), which
            overrides sanctum.yaml at boot — a save here would claim success
            and then silently not take effect. */}
        <FieldRow
          label="port"
          value={String(draft.server?.port ?? '—')}
          hint="read-only — pinned by PM2 env (PORT in ecosystem.config.cjs); a yaml save would be overridden at boot"
          mono
        />
      </Group>

      {/* ── Long-conversation memory (rolling context) ── */}
      <Eyebrow label="long-conversation memory" sub="rolling context: the app's own compaction" />
      <Group>
        <span className="sp-empty-text">
          Models can only hold so much of a conversation at once. Without this, the oldest
          messages quietly fall off the end and your companion loses the thread. With it on,
          older messages are folded into a short summary your companion keeps reading, so the
          shape of what happened stays even when the words don't. Turning it off keeps the
          summaries; nothing is deleted. The next message in each thread carries the summary
          and the recent turns into a fresh session once, and the thread gets a note saying so;
          after that the session itself holds the conversation.
        </span>
        {draft.agent.rolling && (([
          ['codex', 'on Codex'],
          ['claude', 'on Claude'],
        ] as Array<['codex' | 'claude', string]>)
          .sort((a, b) => (a[0] === draft.agent.provider ? -1 : b[0] === draft.agent.provider ? 1 : 0))
          .map(([key, label]) => (
            <ToggleRow
              key={key}
              label={`long-conversation memory ${label}`}
              checked={draft.agent.rolling![key]}
              onChange={v => patchDraft({ agent: { ...draft.agent, rolling: { ...draft.agent.rolling!, [key]: v } } })}
              restartRequired
              hint={key === draft.agent.provider ? 'This is the harness you are using now.' : 'Only matters if you switch to this harness.'}
            />
          )))}
        {draft.agent.rolling && (
          <div className="prefs-form-block">
            <TextField
              label="summarizer model"
              value={draft.agent.rolling.model}
              onChange={v => patchDraft({ agent: { ...draft.agent, rolling: { ...draft.agent.rolling!, model: v } } })}
              mono
              restartRequired
              hint="The model that folds older conversation into summaries. A small, cheap one is fine. Empty = the autonomous model, then the chat model."
            />
            {draft.agent.provider === 'codex' && (
              <TextField
                label="summarizer provider"
                value={draft.agent.rolling.model_provider}
                onChange={v => patchDraft({ agent: { ...draft.agent, rolling: { ...draft.agent.rolling!, model_provider: v } } })}
                mono
                restartRequired
                hint="A [model_providers.*] name from ~/.codex/config.toml. Empty = same provider as chat."
              />
            )}
          </div>
        )}
      </Group>

      {/* ── Permissions ── */}
      <Eyebrow label="permissions" sub={draft.agent.provider === 'codex' ? 'what the companion may touch, on Codex' : 'what the companion may write, on Claude'} />
      <Group>
        <ToggleRow
          label="write to the app's features"
          checked={draft.agent.app_write !== false}
          onChange={v => patchDraft({ agent: { ...draft.agent, app_write: v } })}
          restartRequired
          hint="Reminders and timers, the meal and care log, cycle tracking, notes and canvases, routines, presence. On your say-so only. Off, every write is refused."
        />
        <ToggleRow
          label="Command Center"
          checked={draft.command_center?.enabled ?? false}
          onChange={v => patchDraft({ command_center: { ...(draft.command_center ?? {}), enabled: v } })}
          restartRequired
          hint="The care log, cycle tracking, routines, pets, countdowns and wins pages, and the companion's tools for them."
        />
      </Group>
      {draft.agent.provider === 'codex' && draft.agent.codex ? (
        <Group>
          <div className="prefs-form-block">
            <span className="sp-empty-text">
              On Codex the sandbox is the boundary. The home folder is always readable; the level
              below decides what else. Background helpers (digest, handoff, outlook) always run
              read-only whatever is set here.
            </span>
            <div className="sp-form-group">
              <label className="sp-form-label">
                sandbox <span className="sp-restart-badge" title="Applies on restart">restart</span>
              </label>
              <HearthSelect
                block
                ariaLabel="sandbox mode"
                value={draft.agent.codex.sandbox_mode}
                onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, sandbox_mode: v as 'read-only' | 'workspace-write' | 'danger-full-access' } } })}
                options={[
                  { value: 'read-only', label: 'Read only', sublabel: 'can read the home folder, writes nothing' },
                  { value: 'workspace-write', label: 'Home folder', sublabel: 'writes inside the home folder and the extra folders below' },
                  { value: 'danger-full-access', label: 'Full access', sublabel: 'writes anywhere on this computer; nothing stops a bad edit' },
                ]}
              />
            </div>
            <TextField
              label="extra writable folders"
              value={draft.agent.codex.additional_directories.join(', ')}
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, additional_directories: v.split(',').map(x => x.trim()).filter(Boolean) } } })}
              mono
              restartRequired
              hint="Comma-separated absolute paths the companion may also write to, e.g. a notes folder. Empty = the home folder only."
            />
            <ToggleRow
              label="network access"
              checked={draft.agent.codex.network_access}
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, network_access: v } } })}
              restartRequired
              hint="Lets the companion reach the network from inside the sandbox. Keep on: the res tools (canvas, timers, notes) talk to this app over the local network."
            />
          </div>
        </Group>
      ) : (
      <Group>
        <div className="prefs-form-block">
          <TextField
            label="workspace root"
            value={draft.hooks?.workspace_root ?? ''}
            onChange={v => patchDraft({ hooks: { ...(draft.hooks ?? {}), workspace_root: v } })}
            mono
            restartRequired
            hint="Primary write-allowed directory — absolute path, saved to sanctum.yaml (hooks.workspace_root)"
          />
          <TextField
            label="vault path"
            value={draft.hooks?.vault_path ?? ''}
            onChange={v => patchDraft({ hooks: { ...(draft.hooks ?? {}), vault_path: v } })}
            mono
            restartRequired
            hint="Knowledge vault — absolute path, saved to sanctum.yaml (hooks.vault_path)"
          />
          <TextField
            label="extra write paths"
            value={extraPaths}
            onChange={v => patchDraft({
              hooks: {
                ...(draft.hooks ?? {}),
                extra_write_paths: v.split(',').map(s => s.trim()).filter(Boolean),
              },
            })}
            restartRequired
            hint="Comma-separated absolute paths granted write access (hooks.extra_write_paths)"
          />
        </div>
      </Group>
      )}

      {/* ── Integrations ── */}
      <Eyebrow label="integrations" />
      <Group>
        <ToggleRow
          label="orchestrator"
          checked={draft.orchestrator.enabled}
          onChange={v => patchImmediate({ orchestrator: { ...draft.orchestrator, enabled: v } })}
          hint="Scheduled wakes and autonomous cycles"
        />
        <ToggleRow
          label="voice"
          checked={draft.voice.enabled}
          onChange={v => patchImmediate({ voice: { ...draft.voice, enabled: v } })}
        />
        <ToggleRow
          label="discord"
          checked={draft.discord.enabled}
          onChange={v => patchImmediate({ discord: { enabled: v } })}
        />
        <ToggleRow
          label="telegram"
          checked={draft.telegram.enabled}
          onChange={v => patchImmediate({ telegram: { enabled: v } })}
        />
        <ToggleRow
          label="daily handoff"
          checked={draft.handoff?.enabled ?? false}
          onChange={v => patchImmediate({ handoff: { enabled: v } })}
          hint="Midnight subagent carrying yesterday's daily into today"
        />
      </Group>

      {/* ── Orchestrator config ── */}
      <Eyebrow label="orchestrator config" />
      <Group>
        <div className="prefs-form-block">
          <TextField
            label="wake prompts path"
            value={draft.orchestrator.wake_prompts_path ?? ''}
            onChange={v => patchDraft({ orchestrator: { ...draft.orchestrator, wake_prompts_path: v } })}
            mono
            hint="Directory containing .md prompt files for scheduled wakes"
          />
        </div>
      </Group>

      {/* ── Voice config ── */}
      <Eyebrow label="voice config" />
      <Group>
        <div className="prefs-form-block">
          <TextField
            label="ElevenLabs voice ID"
            value={draft.voice.elevenlabs_voice_id ?? ''}
            onChange={v => patchDraft({ voice: { ...draft.voice, elevenlabs_voice_id: v } })}
            mono
            hint="Voice ID used for TTS — set ELEVENLABS_API_KEY in .env"
          />
        </div>
      </Group>

      {/* ── Browser tab ── */}
      <Eyebrow label="browser" />
      <Group>
        <div className="prefs-form-block">
          <TextField
            label="browser viewer URL"
            value={draft.integrations?.browser_url ?? ''}
            onChange={v => patchDraft({
              integrations: { ...(draft.integrations ?? {}), browser_url: v },
            })}
            mono
            placeholder="http://<viewer-host>:3201/"
            hint="Shown in the Browser tab (see examples/browser-seat-neko; noVNC fallback in examples/browser-seat). Keep it on localhost or a private network. Restart to apply."
          />
        </div>
      </Group>

      {/* ── Mind Cloud integration ── */}
      <Eyebrow label="mind cloud" />
      <Group>
        <ToggleRow
          label="mind cloud enabled"
          checked={draft.integrations?.mind_cloud?.enabled ?? false}
          onChange={v => patchImmediate({
            integrations: {
              ...(draft.integrations ?? {}),
              mind_cloud: { ...(draft.integrations?.mind_cloud ?? { mcp_url: '' }), enabled: v },
            },
          })}
          hint="Connect to the remote Sanctum Mind MCP"
        />
        <div className="prefs-form-block">
          <TextField
            label="MCP URL"
            value={draft.integrations?.mind_cloud?.mcp_url ?? ''}
            onChange={v => patchDraft({
              integrations: {
                ...(draft.integrations ?? {}),
                mind_cloud: { ...(draft.integrations?.mind_cloud ?? { enabled: false }), mcp_url: v },
              },
            })}
            mono
            hint="The sanctum-mind service URL: its root, or its /mcp or /verbs URL"
          />
          <TextField
            label="mind id"
            value={draft.integrations?.mind_cloud?.mind_id ?? ''}
            onChange={v => patchDraft({
              integrations: {
                ...(draft.integrations ?? {}),
                mind_cloud: { ...(draft.integrations?.mind_cloud ?? { enabled: false }), mind_id: v },
              },
            })}
            mono
            hint="The mind's id on that service. Settings → Mind overrides this one."
          />
        </div>
      </Group>

      {/* ── Auth ── */}
      <Eyebrow label="auth" />
      <Group>
        <FieldRow
          label="password"
          value={draft.auth.has_password ? 'set' : 'none'}
        />
      </Group>

      {/* ── Setup ── */}
      <Eyebrow label="setup" />
      <Group>
        <FieldRow
          label="setup wizard"
          value="the same questions as npm run setup"
          hint="Walks the setup again, one screen at a time, with your saved answers filled in. Your names and avatar stay as they are unless you change them. Nothing is written until the last screen, and sanctum.yaml and .env are copied aside first."
        />
        <div className="prefs-form-block">
          <Btn onClick={() => setSetupOpen(true)}>Run setup again</Btn>
        </div>
      </Group>
      {/* On the body, not inside .settings-view, whose field rules would otherwise restyle the wizard's own fields. */}
      {setupOpen && createPortal(<SetupWizard mode="rerun" onClose={() => { setSetupOpen(false); setReloadTick((t) => t + 1); }} />, document.body)}

      {/* ── Raw config (advanced) ── */}
      <div className="raw-cfg-disclosure">
        <button
          className="raw-cfg-toggle"
          onClick={() => setRawOpen(o => !o)}
          aria-expanded={rawOpen}
        >
          <span className="raw-cfg-toggle-label">raw config — advanced (full sanctum.yaml)</span>
          <span className="raw-cfg-chevron" aria-hidden="true">{rawOpen ? '▾' : '▸'}</span>
        </button>

        {rawOpen && (
          <div className="raw-cfg-body">
            <div className="raw-cfg-warning">
              Direct edit of the full config file. All changes require a server restart.
              The current file is backed up automatically before each save.
            </div>
            {rawPath && <code className="raw-cfg-path">{rawPath}</code>}
            {rawLoading ? (
              <div className="raw-cfg-spinner-wrap"><SaveIndicator status="saving" /></div>
            ) : (
              <textarea
                className="raw-cfg-textarea"
                value={rawDraft}
                onChange={e => setRawDraft(e.target.value)}
                spellCheck={false}
                rows={28}
                aria-label="Raw YAML config"
              />
            )}
            {rawError && <div className="raw-cfg-error">{rawError}</div>}
            <div className="raw-cfg-actions">
              <SaveIndicator status={rawStatus} />
              <button
                className="sysprompt-save"
                onClick={saveRawConfig}
                disabled={rawLoading || rawDraft === rawContent || rawStatus === 'saving'}
              >
                save config
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Save bar ── */}
      <div className="prefs-save-bar">
        {saveError && <span className="prefs-save-error">{saveError}</span>}
        <SaveIndicator status={saveStatus} />
        {dirty && (
          <button className="sp-btn sp-btn-primary" onClick={saveAll} disabled={saveStatus === 'saving'}>
            {saveStatus === 'saving' ? 'saving…' : 'save changes'}
          </button>
        )}
      </div>

      <style>{`
        .prefs-section { padding-bottom: 2rem; }

        .prefs-loading {
          padding: 2rem 0;
        }

        .prefs-form-block {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          padding: 0.875rem 0;
        }

        .prefs-save-bar {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.75rem;
          margin-top: 1.5rem;
        }

        .prefs-save-error {
          font-size: 0.75rem;
          font-style: italic;
          color: var(--status-error-text);
          margin-right: auto;
          line-height: 1.4;
        }

        /* ── Raw config disclosure ── */
        .raw-cfg-disclosure {
          margin-top: 2rem;
          border: 1px solid rgba(255,255,255,0.055);
          border-radius: 0.625rem;
          overflow: hidden;
        }

        .raw-cfg-toggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 0.75rem 1rem;
          background: rgba(255,255,255,0.015);
          border: none;
          cursor: pointer;
          transition: background 150ms var(--hearth-curve, ease);
        }
        .raw-cfg-toggle:hover { background: rgba(255,255,255,0.03); }

        .raw-cfg-toggle-label {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
        }

        .raw-cfg-chevron {
          font-size: 0.75rem;
          color: var(--text-muted, #6a6258);
          transition: transform 160ms var(--hearth-curve, ease);
        }
        @media (min-width: 769px) {
          .settings-view .raw-cfg-toggle-label { font-size: 14px; }
          .settings-view .raw-cfg-chevron { font-size: 12px; }
        }

        .raw-cfg-body {
          padding: 0.875rem 1rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          border-top: 1px solid rgba(255,255,255,0.04);
        }

        .raw-cfg-warning {
          font-size: 0.8125rem;
          line-height: 1.5;
          color: var(--text-secondary, #a09689);
          padding: 0.625rem 0.875rem;
          background: rgba(212,168,67,0.06);
          border: 1px solid rgba(212,168,67,0.16);
          border-radius: 0.4375rem;
        }

        .raw-cfg-path {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          word-break: break-all;
        }

        .raw-cfg-textarea {
          width: 100%;
          box-sizing: border-box;
          resize: vertical;
          min-height: 20rem;
          background: rgba(12, 11, 9, 0.7);
          border: 1px solid rgba(201, 168, 124, 0.10);
          border-radius: 0.5rem;
          padding: 0.875rem 1rem;
          color: var(--text-primary, #e2dbd0);
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          line-height: 1.65;
          transition: border-color 240ms var(--hearth-curve, ease);
        }
        .raw-cfg-textarea:focus {
          outline: none;
          border-color: rgba(201, 168, 124, 0.35);
          box-shadow: 0 0 0 3px rgba(201, 168, 124, 0.06);
        }

        .raw-cfg-error {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          color: var(--status-error-text);
          line-height: 1.45;
          padding: 0.5rem 0.75rem;
          background: rgba(210,100,90,0.07);
          border: 1px solid rgba(210,100,90,0.20);
          border-radius: 0.4375rem;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .raw-cfg-spinner-wrap {
          display: flex;
          justify-content: center;
          padding: 1.5rem 0;
        }

        .raw-cfg-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.875rem;
        }
      `}</style>
    </div>
  );
}
