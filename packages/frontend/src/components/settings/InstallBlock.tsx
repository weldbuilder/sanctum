/**
 * Status tab, install block: the server's port, updates, the app password's state, "run setup again" and the raw sanctum.yaml editor.
 * Moved whole from the old Preferences section; the raw editor and the wizard still write the files they always wrote.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Btn, Eyebrow, FieldRow, Group, SaveIndicator } from './primitives';
import { SetupWizard } from '../SetupWizard';
import { UpdatesBlock } from './UpdatesBlock';
import { loadTenantInfo, tenantLine, type TenantInfo } from './tenantState';
import { usePreferences } from './prefsShared';

export function InstallBlock({ base }: { base: string }) {
  const [reloadTick, setReloadTick] = useState(0);
  const { draft } = usePreferences(base, reloadTick);
  // Run setup again: the wizard over the settings, and a reload of what it may have changed when it closes.
  const [setupOpen, setSetupOpen] = useState(false);

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


  if (!draft) return <div className="prefs-loading"><span className="sp-empty-text">Loading…</span></div>;

  return (
    <div className="prefs-section">
      {tenantLine(tenant) && <p className="sp-empty-text" data-testid="tenant-line">{tenantLine(tenant)}</p>}

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

      <UpdatesBlock />
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


      <style>{`
        .sysprompt-save {
          font-size: 0.8125rem; font-weight: 500;
          color: var(--bg-primary);
          background: var(--amber);
          border: none; border-radius: 0.4375rem;
          min-height: 40px;
          padding: 0.4375rem 0.9375rem; cursor: pointer;
        }
        .sysprompt-save:disabled { opacity: 0.4; cursor: default; }
        /* ── Raw config disclosure ── */
        .raw-cfg-disclosure {
          margin-top: 2rem;
          border: 1px solid var(--settings-hairline, var(--border));
          border-radius: 0.625rem;
          overflow: hidden;
        }

        .raw-cfg-toggle {
          min-height: 44px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 0.75rem 1rem;
          background: transparent;
          border: none;
          cursor: pointer;
          transition: background 150ms var(--hearth-curve, ease);
        }
        .raw-cfg-toggle:hover { background: var(--bg-hover); }

        .raw-cfg-toggle-label {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--text-muted);
        }

        .raw-cfg-chevron {
          font-size: 0.75rem;
          color: var(--text-muted);
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
          border-top: 1px solid var(--settings-hairline, var(--border));
        }

        .raw-cfg-warning {
          font-size: 0.8125rem;
          line-height: 1.5;
          color: var(--text-secondary);
          padding: 0.625rem 0.875rem;
          background: var(--bg-hover);
          border: 1px solid var(--status-warning-text);
          border-radius: 0.4375rem;
        }

        .raw-cfg-path {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted);
          word-break: break-all;
        }

        .raw-cfg-textarea {
          width: 100%;
          box-sizing: border-box;
          resize: vertical;
          min-height: 20rem;
          background: var(--settings-field-bg);
          border: 1px solid var(--settings-field-border);
          border-radius: 0.5rem;
          padding: 0.875rem 1rem;
          color: var(--text-primary);
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          line-height: 1.65;
          transition: border-color 240ms var(--hearth-curve, ease);
        }
        .raw-cfg-textarea:focus {
          outline: none;
          border-color: var(--field-border-focus, var(--amber));
        }

        .raw-cfg-error {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          color: var(--status-error-text);
          line-height: 1.45;
          padding: 0.5rem 0.75rem;
          background: var(--bg-hover);
          border: 1px solid var(--status-error-text);
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
