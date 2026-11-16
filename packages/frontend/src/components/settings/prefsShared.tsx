/**
 * GET/PUT /api/preferences, shared by the tabs that edit sanctum.yaml-backed settings (You & them, Mind, Channels, Permissions, Rhythm's paths).
 * Each tab loads its own copy and posts its draft; the server writes only keys that differ from the file (the PUT's `written`).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { SaveIndicator } from './primitives';

/** agent.dsh as saved in yaml; '' = unset. api_key_env is a variable NAME, never a key. */
export interface DshPrefs {
  model: string;
  model_autonomous: string;
  model_provider: string;
  base_url: string;
  api_key_env: string;
}
export const DSH_EMPTY: DshPrefs = { model: '', model_autonomous: '', model_provider: '', base_url: '', api_key_env: '' };

export type MemoryChoice = 'revien' | 'sanctum' | 'harness' | 'none';

export interface Preferences {
  identity: { companion_name: string; user_name: string; timezone: string };
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
    summarizer?: { provider: string; model: string; base_url: string; api_key_env: string };
  };
  /** Read-only: PM2 pins PORT in env, which overrides sanctum.yaml at boot. */
  server?: { port?: number };
  hooks?: { workspace_root?: string; vault_path?: string; extra_write_paths?: string[] };
  orchestrator: { enabled: boolean; wake_prompts_path?: string };
  voice: { enabled: boolean; elevenlabs_voice_id?: string };
  discord: { enabled: boolean };
  telegram: { enabled: boolean };
  handoff?: { enabled: boolean };
  integrations?: { browser_url?: string };
  command_center?: { enabled?: boolean };
  auth: { has_password: boolean };
  /** One memory system at a time; the server writes revien.enabled, agent.harness_memory and agent.local_recall together. */
  memory?: MemoryChoice;
  /** The file turns on more than the one system `memory` names (read-only; saving the choice normalises it). */
  memory_mixed?: boolean;
  imagegen?: { provider: 'none' | 'runware' | 'replicate'; model: string; reference_model?: string; size: string; safety_checker: boolean };
  sources?: Record<string, string>;
}

export function deepMerge(target: any, source: any): any {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key]) && typeof out[key] === 'object' && out[key] !== null) {
      out[key] = { ...out[key], ...source[key] };
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function usePreferences(base: string, reloadKey = 0) {
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${base}/api/preferences`);
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data && data.identity) { setDraft(data as Preferences); setDirty(false); }
      } catch { /* backend not yet up */ }
    })();
    return () => { alive = false; };
  }, [base, reloadKey]);

  const patchDraft = useCallback((update: any) => {
    setDraft(prev => (prev ? (deepMerge(prev, update) as Preferences) : null));
    setDirty(true);
  }, []);

  const flash = (s: SaveStatus) => { setSaveStatus(s); setTimeout(() => setSaveStatus('idle'), 2200); };

  /** Switches that save at once: posts only the changed slice. */
  const patchImmediate = useCallback(async (update: any) => {
    setDraft(prev => (prev ? (deepMerge(prev, update) as Preferences) : null));
    setSaveStatus('saving');
    setSaveError(null);
    try {
      const res = await fetch(`${base}/api/preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
      if (res.ok) flash('saved');
      else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setSaveError(data.error ?? `Save failed (HTTP ${res.status})`);
        flash('error');
      }
    } catch { flash('error'); }
  }, [base]);

  const saveAll = useCallback(async () => {
    if (!draft) return;
    setSaveStatus('saving');
    setSaveError(null);
    try {
      const res = await fetch(`${base}/api/preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      if (res.ok) { setDirty(false); flash('saved'); }
      else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setSaveError(data.error ?? `Save failed (HTTP ${res.status})`);
        flash('error');
      }
    } catch {
      setSaveError('Network error — nothing was saved');
      flash('error');
    }
  }, [base, draft]);

  return { draft, patchDraft, patchImmediate, saveAll, saveStatus, saveError, dirty };
}

export function PrefsSaveBar({ saveStatus, saveError, dirty, onSave }: { saveStatus: SaveStatus; saveError: string | null; dirty: boolean; onSave: () => void }) {
  return (
    <div className="prefs-save-bar">
      {saveError && <span className="prefs-save-error">{saveError}</span>}
      <SaveIndicator status={saveStatus} />
      {dirty && (
        <button className="sp-btn sp-btn-primary" onClick={onSave} disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'saving…' : 'save changes'}
        </button>
      )}
    </div>
  );
}

/** Shared by the tabs that use usePreferences. */
export const PREFS_CSS = `
.prefs-section { padding-bottom: 2rem; }
.prefs-loading { padding: 2rem 0; }
.prefs-form-block { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.875rem 0; }
.prefs-save-bar { display: flex; align-items: center; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem; }
.prefs-save-error { font-size: 0.75rem; font-style: italic; color: var(--status-error-text); margin-right: auto; line-height: 1.4; }
.prefs-radio { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem 0; }
.prefs-radio-opt {
  display: flex; align-items: flex-start; gap: 0.75rem; min-height: 40px; padding: 0.5rem 0.75rem; cursor: pointer;
  border: 1px solid var(--settings-field-border); border-radius: 0.5rem;
}
.prefs-radio-opt.sel { border-color: var(--field-border-focus, var(--amber)); background: var(--bg-active); }
.prefs-radio-opt input { accent-color: var(--amber); margin-top: 0.25rem; width: 1.125rem; height: 1.125rem; flex-shrink: 0; }
.prefs-radio-text { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
.prefs-radio-label { font-size: 0.9375rem; color: var(--text-primary); }
.prefs-radio-hint { font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.45; }
.prefs-keystate { font-size: 0.8125rem; font-weight: 600; }
.prefs-keystate.set { color: var(--status-success-text); }
.prefs-keystate.unset { color: var(--status-warning-text); }
`;
