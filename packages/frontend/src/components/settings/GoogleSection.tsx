/**
 * Google Integrations section — multi-account model.
 *
 * Layout (top to bottom):
 *   1. "How to connect your Google" accordion — collapsed by default;
 *      step-by-step guide so the user can get their OAuth client keys.
 *   2. Credential fields — Client ID (text) + Client Secret (password/masked,
 *      show/hide toggle). Save → POST /api/google/config. Once saved, shows a
 *      compact "configured" pill + "edit keys" affordance instead.
 *   3. ACCOUNTS region — list each connected account; + Add Google account.
 *   4. SERVICES region — per-app toggle + account dropdown; inline Grant prompt
 *      when a scope hasn't been granted; restricted / health-wiring notes.
 *
 * Multi-account OAuth flow:
 *   POST the relevant endpoint → receive { url } → open in new tab.
 *   Poll /api/google/auth/status on window-focus + 3 s interval until settled.
 *   On return re-fetch status; new accounts / granted scopes appear automatically.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Group, Eyebrow, Btn, Spinner } from './primitives';
import { useConfirm } from '../ConfirmDialog';
import { HearthSelect } from '../hearth';

// ─── Types (mirror authoritative backend contract) ────────────────────────────

type GoogleApp = 'calendar' | 'tasks' | 'gmail' | 'drive' | 'docs' | 'sheets' | 'youtube' | 'search_console' | 'health';

interface GoogleAccount {
  id: string;
  email: string;
  connected: true;
  error?: string;
  grantedScopes: string[];
}

interface GoogleAppStatus {
  enabled: boolean;
  accountId: string | null;
  hasScope: boolean;
  hasScopeKnown: boolean;
  restricted: boolean;
}

interface GoogleGrantNeed {
  app: GoogleApp;
  accountId: string;
  scope: string;
}

interface GoogleStatus {
  configured: boolean;
  accounts: GoogleAccount[];
  apps: Record<GoogleApp, GoogleAppStatus>;
  needsGrant: GoogleGrantNeed[];
}

// ─── App definitions (display order matches GoogleApp union) ──────────────────

interface AppDef {
  key: GoogleApp;
  label: string;
  hint: string;
}

const APPS: AppDef[] = [
  { key: 'calendar', label: 'Calendar',  hint: 'Reflect your events — today\'s schedule visible at a glance.' },
  { key: 'tasks',    label: 'Tasks',     hint: 'Surface your open tasks in conversation.' },
  { key: 'gmail',    label: 'Gmail',     hint: 'Surface mail that needs a reply.' },
  { key: 'drive',    label: 'Drive',     hint: 'Find your files in chat.' },
  { key: 'docs',     label: 'Docs',      hint: 'Open and discuss documents inline.' },
  { key: 'sheets',   label: 'Sheets',    hint: 'Query and update spreadsheets through conversation.' },
  { key: 'youtube',  label: 'YouTube',   hint: 'Reference your subscriptions and watch history.' },
  { key: 'search_console', label: 'Search Console', hint: 'Read-only search performance — clicks, impressions, index status.' },
  { key: 'health',   label: 'Health',    hint: 'Sleep, HRV, resting HR — your body data, automatically.' },
];

// ─── How-to accordion ─────────────────────────────────────────────────────────

function SetupAccordion() {
  const [open, setOpen] = useState(false);
  return (
    <div className="gs-accordion">
      <button
        className={`gs-accordion-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        type="button"
      >
        <span className="gs-accordion-glyph" aria-hidden="true">⬡</span>
        <span className="gs-accordion-label">How to get your Google keys</span>
        <span className="gs-accordion-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="gs-accordion-body" role="region">
          <p className="gs-accordion-intro">
            Sanctum Mobile uses your own Google Cloud project — your data stays between
            you and Google, no middleman. It takes about five minutes, and once your
            keys are saved you can connect <strong>multiple Google accounts</strong>
            and route each service to whichever account you prefer.
          </p>
          <ol className="gs-steps">
            <li className="gs-step">
              <span className="gs-step-num">1</span>
              <div className="gs-step-body">
                Go to{' '}
                <a
                  href="https://console.cloud.google.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gs-link"
                >
                  console.cloud.google.com
                </a>{' '}
                and create a new project. Any name works — "Sanctum" is fine.
              </div>
            </li>
            <li className="gs-step">
              <span className="gs-step-num">2</span>
              <div className="gs-step-body">
                In the left sidebar go to <strong>APIs &amp; Services → Library</strong>.
                Enable each API you want to use:{' '}
                <strong>
                  Google Calendar API, Tasks API, Gmail API, Drive API, Google Docs API,
                  Google Sheets API, YouTube Data API v3
                </strong>
                {' '}— and if you want body data,{' '}
                <strong>Google Health API</strong>. Enable only what you need; you
                can always come back.
              </div>
            </li>
            <li className="gs-step">
              <span className="gs-step-num">3</span>
              <div className="gs-step-body">
                Go to <strong>APIs &amp; Services → OAuth consent screen</strong>.
                Choose <strong>External</strong>, fill in an app name (anything), and
                add <strong>every Google email you plan to connect</strong> as test
                users. Save.
              </div>
            </li>
            <li className="gs-step">
              <span className="gs-step-num">4</span>
              <div className="gs-step-body">
                Go to <strong>Credentials → Create Credentials → OAuth client ID</strong>.
                Application type: <strong>Desktop app</strong>. Give it any name, click
                Create.
              </div>
            </li>
            <li className="gs-step">
              <span className="gs-step-num">5</span>
              <div className="gs-step-body">
                A dialog shows your <strong>Client ID</strong> and{' '}
                <strong>Client secret</strong>. Copy both and paste them into the
                fields below. After saving you can connect your first account — then
                add more accounts any time from the Accounts section.
              </div>
            </li>
          </ol>
          <p className="gs-accordion-note">
            Your keys are <strong>encrypted and stored on your own machine</strong> —
            they never leave your device, and no one (not even us) sits in the middle.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Credential fields ────────────────────────────────────────────────────────

interface CredFieldsProps {
  base: string;
  onSaved: () => void;
}

function CredFields({ base, onSaved }: CredFieldsProps) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0;

  const handleSave = async () => {
    setErr(null);
    setSaving(true);
    try {
      const res = await fetch(`${base}/api/google/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr((body as { error?: string }).error ?? 'Could not save — try again.');
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setErr('Could not reach the backend.');
    }
    setSaving(false);
  };

  return (
    <div className="gs-cred-fields">
      <div className="gs-field-group">
        <label className="gs-field-label" htmlFor="gs-client-id">Client ID</label>
        <input
          id="gs-client-id"
          type="text"
          className="gs-field-input"
          value={clientId}
          onChange={e => setClientId(e.target.value)}
          placeholder="123456789-abc….apps.googleusercontent.com"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="gs-field-group">
        <label className="gs-field-label" htmlFor="gs-client-secret">Client secret</label>
        <div className="gs-field-secret-wrap">
          <input
            id="gs-client-secret"
            type={showSecret ? 'text' : 'password'}
            className="gs-field-input mono"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder={showSecret ? 'GOCSPX-…' : '••••••••••••••••'}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="gs-show-secret-btn"
            onClick={() => setShowSecret(s => !s)}
            aria-label={showSecret ? 'Hide secret' : 'Show secret'}
          >
            {showSecret ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      </div>
      {err && <p className="gs-cred-err" role="alert">{err}</p>}
      <div className="gs-cred-save-row">
        <button
          className="gs-save-btn"
          onClick={handleSave}
          disabled={!canSave || saving}
          type="button"
        >
          {saving ? <><Spinner /> saving…</> : 'Save keys'}
        </button>
        <span className="gs-cred-hint">Step 1 of 2 — save your keys, then connect an account below</span>
      </div>
    </div>
  );
}

// ─── Configured (saved) state display ────────────────────────────────────────

function ConfiguredBadge({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="gs-configured-badge">
      <span className="gs-pip configured" aria-hidden="true" />
      <span className="gs-configured-label">Keys saved</span>
      <button type="button" className="gs-edit-keys-btn" onClick={onEdit}>
        edit keys
      </button>
    </div>
  );
}

// ─── Account row ──────────────────────────────────────────────────────────────

interface AccountRowProps {
  account: GoogleAccount;
  busy: boolean;
  onReconnect: () => void;
  onRemove: () => void;
}

function AccountRow({ account, busy, onReconnect, onRemove }: AccountRowProps) {
  const hasError = !!account.error;
  return (
    <div className={`ga-account-row${hasError ? ' has-error' : ''}`}>
      <div className="ga-account-left">
        <span className="ga-pip" aria-hidden="true" style={{
          background: hasError ? '#d4a843' : '#6dba88',
          boxShadow: hasError ? '0 0 5px rgba(212,168,67,0.40)' : '0 0 5px rgba(109,186,136,0.40)',
        }} />
        <div className="ga-account-info">
          <span className="ga-account-email">{account.email}</span>
          {hasError && (
            <span className="ga-account-error-note">reconnect needed</span>
          )}
        </div>
      </div>
      <div className="ga-account-actions">
        <Btn variant="muted" small onClick={onReconnect} disabled={busy}>
          {busy ? <Spinner /> : 'reconnect'}
        </Btn>
        <Btn variant="danger" small onClick={onRemove} disabled={busy}>
          remove
        </Btn>
      </div>
    </div>
  );
}

// ─── Service row ──────────────────────────────────────────────────────────────

interface ServiceRowProps {
  app: AppDef;
  appStatus: GoogleAppStatus;
  accounts: GoogleAccount[];
  needsGrant: boolean;
  toggling: boolean;
  granting: boolean;
  assigningAccount: boolean;
  onToggle: (enabled: boolean) => void;
  onAssign: (accountId: string | null) => void;
  onGrant: () => void;
}

function ServiceRow({
  app,
  appStatus,
  accounts,
  needsGrant,
  toggling,
  granting,
  assigningAccount,
  onToggle,
  onAssign,
  onGrant,
}: ServiceRowProps) {
  const isHealth = app.key === 'health';
  const scopeUnknown = !appStatus.hasScopeKnown;
  // Show grant affordance: enabled + assigned + scope not granted + scope is known
  const showGrant = appStatus.enabled && appStatus.accountId !== null && !appStatus.hasScope
    && !(isHealth && scopeUnknown) && appStatus.hasScopeKnown;
  // For health with unknown scope wiring, show a quiet note instead
  const showHealthNote = isHealth && scopeUnknown;

  const noAccounts = accounts.length === 0;
  const toggleDisabled = noAccounts || toggling;

  return (
    <div className="gs-service-row">
      {/* Left: label + hint + notes */}
      <div className="gs-service-left">
        <div className="gs-service-label-row">
          <span className={`gs-service-label${toggleDisabled && !appStatus.enabled ? ' muted' : ''}`}>
            {app.label}
          </span>
          {appStatus.restricted && (
            <span className="gs-restricted-pill" title="Restricted scope — Google may ask you to reconnect periodically">
              restricted
            </span>
          )}
        </div>
        <span className="gs-service-hint">{app.hint}</span>

        {/* Health wiring note */}
        {showHealthNote && (
          <span className="gs-service-note soon">body-data wiring coming soon</span>
        )}

        {/* Grant prompt */}
        {showGrant && (
          <div className="gs-grant-inline">
            <span className="gs-grant-inline-text">
              needs access for this account
            </span>
            <button
              type="button"
              className="gs-grant-inline-btn"
              onClick={onGrant}
              disabled={granting}
            >
              {granting ? <><Spinner /> granting…</> : 'Grant access'}
            </button>
          </div>
        )}
      </div>

      {/* Right: account dropdown + toggle */}
      <div className="gs-service-right">
        {/* Account selector */}
        {appStatus.enabled && accounts.length > 0 && (
          <div className="gs-account-select" title={`Which account to use for ${app.label}`}>
            <HearthSelect
              block
              value={appStatus.accountId ?? ''}
              onChange={v => onAssign(v === '' ? null : v)}
              options={[
                { value: '', label: '— choose account —' },
                ...accounts.map(a => ({ value: a.id, label: a.email })),
              ]}
              disabled={assigningAccount}
              ariaLabel={`Account for ${app.label}`}
            />
          </div>
        )}

        {/* Toggle */}
        <button
          role="switch"
          aria-checked={appStatus.enabled}
          aria-label={app.label}
          disabled={toggleDisabled}
          className={`sp-toggle${appStatus.enabled ? ' on' : ''}${toggleDisabled ? ' gs-toggle-disabled' : ''}`}
          onClick={() => !toggleDisabled && onToggle(!appStatus.enabled)}
          type="button"
        >
          {toggling
            ? <span className="gs-toggle-spinner"><Spinner /></span>
            : <span className="sp-toggle-thumb" />
          }
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function GoogleSection({ base }: { base: string }) {
  const confirm = useConfirm();

  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editingKeys, setEditingKeys] = useState(false);

  // Per-account busy states
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);

  // Per-app busy states
  const [togglingApp, setTogglingApp] = useState<GoogleApp | null>(null);
  const [grantingApp, setGrantingApp] = useState<GoogleApp | null>(null);
  const [assigningApp, setAssigningApp] = useState<GoogleApp | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingOAuthRef = useRef(false);

  function flash(text: string, isErr = false) {
    if (isErr) setErr(text);
    else setMsg(text);
    setTimeout(() => { setMsg(null); setErr(null); }, 4000);
  }

  // ── Fetch status ──────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async (quiet = false): Promise<GoogleStatus | null> => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`${base}/api/google/auth/status`);
      if (!res.ok) { if (!quiet) setLoading(false); return null; }
      const data: GoogleStatus = await res.json();
      setStatus(data);
      if (!quiet) setLoading(false);
      return data;
    } catch {
      if (!quiet) setLoading(false);
      return null;
    }
  }, [base]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // ── Poll while an OAuth tab is open ──────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    pendingOAuthRef.current = false;
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pendingOAuthRef.current = true;
    pollRef.current = setInterval(async () => {
      const s = await fetchStatus(true);
      if (s) stopPolling();
    }, 3000);
  }, [fetchStatus, stopPolling]);

  useEffect(() => {
    const onFocus = () => { if (pendingOAuthRef.current) fetchStatus(true).then(() => stopPolling()); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); stopPolling(); };
  }, [fetchStatus, stopPolling]);

  // ── Generic OAuth helper ──────────────────────────────────────────────────

  async function openOAuth(endpoint: string, body?: object): Promise<boolean> {
    try {
      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        flash((d as { error?: string }).error ?? 'Could not open consent — try again.', true);
        return false;
      }
      const { url } = await res.json() as { url: string };
      window.open(url, '_blank', 'noopener');
      startPolling();
      return true;
    } catch {
      flash('Could not reach the backend.', true);
      return false;
    }
  }

  // ── Add account ───────────────────────────────────────────────────────────

  const handleAddAccount = async () => {
    setAddingAccount(true);
    await openOAuth('/api/google/accounts/add');
    setAddingAccount(false);
  };

  // ── Reconnect account ─────────────────────────────────────────────────────

  const handleReconnect = async (accountId: string) => {
    setReconnectingId(accountId);
    await openOAuth('/api/google/accounts/reconnect', { accountId });
    setReconnectingId(null);
  };

  // ── Remove account ────────────────────────────────────────────────────────

  const handleRemove = async (account: GoogleAccount) => {
    const ok = await confirm({
      title: `Remove ${account.email}?`,
      body: 'Apps assigned to this account will become unassigned. You can reconnect it any time.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setRemovingId(account.id);
    try {
      const res = await fetch(`${base}/api/google/accounts/${account.id}`, { method: 'DELETE' });
      if (!res.ok) { flash('Could not remove account — try again.', true); }
      else {
        const d = await res.json() as { status?: GoogleStatus };
        if (d.status) setStatus(d.status);
        else await fetchStatus(true);
        flash('Account removed.');
      }
    } catch {
      flash('Could not reach the backend.', true);
    }
    setRemovingId(null);
  };

  // ── Toggle app ────────────────────────────────────────────────────────────

  const handleToggle = async (app: GoogleApp, enabled: boolean) => {
    setTogglingApp(app);
    try {
      const res = await fetch(`${base}/api/google/apps`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app, enabled }),
      });
      if (!res.ok) { flash('Could not save — try again.', true); }
      else {
        const d = await res.json() as { status?: GoogleStatus };
        if (d.status) setStatus(d.status);
        else await fetchStatus(true);
      }
    } catch {
      flash('Could not save — try again.', true);
    }
    setTogglingApp(null);
  };

  // ── Assign account to app ─────────────────────────────────────────────────

  const handleAssign = async (app: GoogleApp, accountId: string | null) => {
    setAssigningApp(app);
    try {
      const res = await fetch(`${base}/api/google/apps`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app, accountId }),
      });
      if (!res.ok) { flash('Could not assign account — try again.', true); }
      else {
        const d = await res.json() as { status?: GoogleStatus };
        if (d.status) setStatus(d.status);
        else await fetchStatus(true);
      }
    } catch {
      flash('Could not save — try again.', true);
    }
    setAssigningApp(null);
  };

  // ── Grant scope for app ───────────────────────────────────────────────────

  const handleGrant = async (app: GoogleApp) => {
    setGrantingApp(app);
    await openOAuth('/api/google/accounts/grant', { app });
    setGrantingApp(null);
  };

  // ── After keys are saved ──────────────────────────────────────────────────

  const handleKeysSaved = async () => {
    setEditingKeys(false);
    flash('Keys saved.');
    await fetchStatus(true);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="google-loading" aria-label="loading Google status">
        <Spinner />
      </div>
    );
  }

  const isConfigured = status?.configured ?? false;
  const showCredFields = !isConfigured || editingKeys;
  const accounts = status?.accounts ?? [];
  const needsGrantSet = new Set((status?.needsGrant ?? []).map(g => g.app));

  return (
    <div className="google-section">

      {/* ── 1. Setup accordion ── */}
      <SetupAccordion />

      {/* ── 2. Credential fields / configured badge ── */}
      <Eyebrow label="your Google keys" />

      {showCredFields ? (
        <CredFields base={base} onSaved={handleKeysSaved} />
      ) : (
        <ConfiguredBadge onEdit={() => setEditingKeys(true)} />
      )}

      {/* ── 3. Accounts ── */}
      {isConfigured && (
        <>
          <Eyebrow label="accounts" />

          {accounts.length === 0 ? (
            <p className="ga-empty-note">
              No accounts connected yet — add one below to get started.
            </p>
          ) : (
            <div className="ga-account-list">
              {accounts.map(account => (
                <AccountRow
                  key={account.id}
                  account={account}
                  busy={reconnectingId === account.id || removingId === account.id}
                  onReconnect={() => handleReconnect(account.id)}
                  onRemove={() => handleRemove(account)}
                />
              ))}
            </div>
          )}

          <div className="ga-add-row">
            <button
              type="button"
              className="ga-add-btn"
              onClick={handleAddAccount}
              disabled={addingAccount}
            >
              {addingAccount ? (
                <><Spinner /> opening consent…</>
              ) : (
                <>
                  <span className="ga-add-plus" aria-hidden="true">+</span>
                  Add Google account
                </>
              )}
            </button>
            {addingAccount && (
              <span className="ga-add-hint">
                Complete sign-in in the tab that just opened — this will update automatically.
              </span>
            )}
          </div>
        </>
      )}

      {/* ── 4. Services ── */}
      {isConfigured && (
        <>
          <Eyebrow
            label="services"
            sub={accounts.length === 0 ? 'add an account first' : undefined}
          />

          <Group>
            {APPS.map(app => {
              const appStatus = status?.apps?.[app.key];
              if (!appStatus) return null;
              const needsGrant = needsGrantSet.has(app.key)
                || (appStatus.enabled && appStatus.accountId !== null && !appStatus.hasScope && appStatus.hasScopeKnown);

              return (
                <ServiceRow
                  key={app.key}
                  app={app}
                  appStatus={appStatus}
                  accounts={accounts}
                  needsGrant={needsGrant}
                  toggling={togglingApp === app.key}
                  granting={grantingApp === app.key}
                  assigningAccount={assigningApp === app.key}
                  onToggle={enabled => handleToggle(app.key, enabled)}
                  onAssign={accountId => handleAssign(app.key, accountId)}
                  onGrant={() => handleGrant(app.key)}
                />
              );
            })}
          </Group>
        </>
      )}

      {/* ── Feedback ── */}
      {msg && <p className="google-msg" role="status">{msg}</p>}
      {err && <p className="google-err" role="alert">{err}</p>}

      <style>{`
        .google-section { padding-bottom: 2rem; }

        .google-loading {
          display: flex;
          justify-content: center;
          padding: 2.5rem 0;
        }

        /* ── How-to accordion ── */
        .gs-accordion {
          border: 1px solid rgba(201,168,124,0.13);
          border-radius: 0.625rem;
          overflow: hidden;
          margin-bottom: 0.25rem;
        }
        .gs-accordion-trigger {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 0.4375rem;
          padding: 0.6875rem 0.875rem;
          background: rgba(201,168,124,0.04);
          border: none;
          cursor: pointer;
          text-align: left;
          transition: background 150ms var(--hearth-curve, ease);
        }
        .gs-accordion-trigger:hover {
          background: rgba(201,168,124,0.08);
        }
        .gs-accordion-trigger.open {
          background: rgba(201,168,124,0.07);
          border-bottom: 1px solid rgba(201,168,124,0.12);
        }
        .gs-accordion-glyph {
          font-size: 0.5625rem;
          color: var(--text-muted);
          flex-shrink: 0;
        }
        .gs-accordion-label {
          flex: 1;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.04em;
          color: var(--text-secondary, #a09689);
        }
        .gs-accordion-chevron {
          font-size: 0.5rem;
          color: var(--text-muted);
          flex-shrink: 0;
        }
        .gs-accordion-body {
          padding: 1rem 1rem 0.875rem;
          background: rgba(0,0,0,0.12);
          animation: gsReveal 160ms var(--hearth-curve, ease) both;
        }
        @keyframes gsReveal {
          from { opacity: 0; transform: translateY(-0.25rem); }
          to   { opacity: 1; transform: none; }
        }
        .gs-accordion-intro {
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          line-height: 1.55;
          margin: 0 0 0.875rem;
          font-style: italic;
        }
        .gs-accordion-intro strong {
          color: var(--text-primary, #e2dbd0);
          font-weight: 500;
          font-style: normal;
        }
        .gs-steps {
          list-style: none;
          padding: 0;
          margin: 0 0 0.875rem;
          display: flex;
          flex-direction: column;
          gap: 0.5625rem;
        }
        .gs-step {
          display: flex;
          gap: 0.625rem;
          align-items: flex-start;
        }
        .gs-step-num {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.04em;
          color: var(--text-muted);
          background: rgba(201,168,124,0.09);
          border: 1px solid rgba(201,168,124,0.18);
          border-radius: 50%;
          width: 1.125rem;
          height: 1.125rem;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          margin-top: 0.0625rem;
        }
        .gs-step-body {
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          line-height: 1.55;
          flex: 1;
        }
        .gs-step-body strong {
          color: var(--text-primary, #e2dbd0);
          font-weight: 500;
        }
        .gs-link {
          color: var(--amber, #c9a87c);
          text-decoration: none;
          border-bottom: 1px solid rgba(201,168,124,0.28);
          transition: border-color 150ms ease;
        }
        .gs-link:hover { border-color: rgba(201,168,124,0.60); }
        .gs-accordion-note {
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          font-style: italic;
          line-height: 1.5;
          margin: 0;
        }
        .gs-accordion-note strong {
          font-style: normal;
          color: var(--text-secondary, #a09689);
        }

        /* ── Credential fields ── */
        .gs-cred-fields {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          padding: 0.25rem 0;
        }
        .gs-field-group {
          display: flex;
          flex-direction: column;
          gap: 0.3125rem;
        }
        .gs-field-label {
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
        }
        .gs-field-input {
          background: var(--bg-input, #0f0e0c);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 0.5rem;
          color: var(--text-primary, #e2dbd0);
          font-size: 0.875rem;
          padding: 0.4375rem 0.75rem;
          font-family: inherit;
          width: 100%;
          transition: border-color 240ms var(--hearth-curve, ease);
        }
        .gs-field-input.mono {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
          letter-spacing: 0.02em;
        }
        .gs-field-input:focus {
          outline: none;
          border-color: rgba(201,168,124,0.30);
        }
        .gs-field-secret-wrap {
          position: relative;
          display: flex;
          align-items: center;
        }
        .gs-field-secret-wrap .gs-field-input {
          padding-right: 2.375rem;
        }
        .gs-show-secret-btn {
          position: absolute;
          right: 0.5rem;
          top: 50%;
          transform: translateY(-50%);
          background: transparent;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          color: var(--text-muted, #6a6258);
          padding: 0.1875rem;
          border-radius: 0.25rem;
          transition: color 150ms ease;
        }
        .gs-show-secret-btn:hover { color: var(--text-secondary, #a09689); }
        .gs-cred-err {
          font-size: 0.8125rem;
          color: var(--status-error-text);
          font-style: italic;
          margin: 0;
        }
        .gs-cred-save-row {
          display: flex;
          align-items: center;
          gap: 0.875rem;
          flex-wrap: wrap;
        }
        .gs-save-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.4375rem;
          padding: 0.5rem 1rem;
          background: rgba(201,168,124,0.13);
          border: 1px solid rgba(201,168,124,0.30);
          border-radius: 0.5625rem;
          color: var(--amber-bright, #e3c49a);
          font-size: 0.875rem;
          font-family: inherit;
          font-weight: 500;
          cursor: pointer;
          transition:
            background 150ms var(--hearth-curve, ease),
            border-color 150ms var(--hearth-curve, ease),
            transform 100ms var(--hearth-curve, ease);
        }
        .gs-save-btn:hover:not(:disabled) {
          background: rgba(201,168,124,0.20);
          border-color: rgba(201,168,124,0.46);
        }
        .gs-save-btn:active:not(:disabled) { transform: scale(0.985) translateY(0.5px); }
        .gs-save-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .gs-cred-hint {
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          font-style: italic;
          line-height: 1.4;
        }

        /* ── Configured badge ── */
        .gs-configured-badge {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5625rem 0.25rem;
        }
        .gs-pip {
          width: 0.4375rem;
          height: 0.4375rem;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .gs-pip.configured {
          background: #6dba88;
          box-shadow: 0 0 5px rgba(109,186,136,0.40);
        }
        .gs-configured-label {
          font-size: 0.8125rem;
          color: #6dba88;
        }
        .gs-edit-keys-btn {
          background: transparent;
          border: none;
          cursor: pointer;
          font-size: 0.6875rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          letter-spacing: 0.04em;
          color: var(--text-muted, #6a6258);
          padding: 0.125rem 0.375rem;
          border-radius: 0.25rem;
          border: 1px solid rgba(255,255,255,0.07);
          transition: color 150ms ease, border-color 150ms ease;
          margin-left: 0.125rem;
        }
        .gs-edit-keys-btn:hover {
          color: var(--text-secondary, #a09689);
          border-color: rgba(255,255,255,0.13);
        }

        /* ── Accounts region ── */
        .ga-empty-note {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.8125rem;
          color: var(--text-muted, #6a6258);
          margin: 0 0 0.5rem;
          line-height: 1.55;
        }
        .ga-account-list {
          display: flex;
          flex-direction: column;
          gap: 0.3125rem;
          margin-bottom: 0.5rem;
        }
        .ga-account-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          padding: 0.625rem 0.875rem;
          background: rgba(109,186,136,0.04);
          border: 1px solid rgba(109,186,136,0.12);
          border-radius: 0.625rem;
          flex-wrap: wrap;
          animation: fadeIn 200ms var(--hearth-curve, ease) both;
        }
        .ga-account-row.has-error {
          background: rgba(212,168,67,0.05);
          border-color: rgba(212,168,67,0.14);
        }
        .ga-account-left {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          min-width: 0;
          flex: 1;
        }
        .ga-pip {
          width: 0.4375rem;
          height: 0.4375rem;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .ga-account-info {
          display: flex;
          flex-direction: column;
          gap: 0.0625rem;
          min-width: 0;
        }
        .ga-account-email {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          color: var(--text-secondary, #a09689);
          letter-spacing: 0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ga-account-error-note {
          font-size: 0.625rem;
          color: #d4a843;
          font-style: italic;
        }
        .ga-account-actions {
          display: flex;
          gap: 0.375rem;
          flex-shrink: 0;
        }

        /* ── Add account button ── */
        .ga-add-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          flex-wrap: wrap;
          margin-top: 0.375rem;
        }
        .ga-add-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.4375rem;
          padding: 0.4375rem 0.875rem;
          background: transparent;
          border: 1px solid rgba(201,168,124,0.20);
          border-radius: 0.5rem;
          color: var(--amber, #c9a87c);
          font-size: 0.8125rem;
          font-family: inherit;
          cursor: pointer;
          transition:
            background 150ms var(--hearth-curve, ease),
            border-color 150ms var(--hearth-curve, ease),
            transform 100ms var(--hearth-curve, ease);
        }
        .ga-add-btn:hover:not(:disabled) {
          background: rgba(201,168,124,0.08);
          border-color: rgba(201,168,124,0.34);
        }
        .ga-add-btn:active:not(:disabled) { transform: scale(0.985) translateY(0.5px); }
        .ga-add-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .ga-add-plus {
          font-size: 1rem;
          line-height: 1;
          color: var(--text-secondary);
        }
        .ga-add-hint {
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          font-style: italic;
          line-height: 1.4;
        }

        /* ── Service rows ── */
        .gs-service-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          padding: 0.6875rem 0;
          border-bottom: 1px solid rgba(255,255,255,0.055);
          gap: 0.875rem;
        }
        .gs-service-row:last-child { border-bottom: none; }
        .gs-service-left {
          display: flex;
          flex-direction: column;
          gap: 0.1875rem;
          flex: 1;
          min-width: 0;
        }
        .gs-service-label-row {
          display: flex;
          align-items: center;
          gap: 0.4rem;
        }
        .gs-service-label {
          font-size: 0.875rem;
          color: var(--text-secondary, #a09689);
        }
        .gs-service-label.muted { color: var(--text-muted, #6a6258); }
        .gs-service-hint {
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          font-style: italic;
          line-height: 1.4;
        }
        .gs-service-note {
          font-size: 0.625rem;
          color: var(--text-muted, #6a6258);
          font-style: italic;
          margin-top: 0.0625rem;
        }
        .gs-service-note.soon {
          color: var(--text-muted);
        }

        /* Restricted pill */
        .gs-restricted-pill {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5rem;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          background: rgba(212,168,67,0.09);
          color: rgba(212,168,67,0.60);
          border: 1px solid rgba(212,168,67,0.18);
          border-radius: 0.25rem;
          padding: 0.0625rem 0.3125rem;
          cursor: default;
        }

        /* Inline grant prompt */
        .gs-grant-inline {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-top: 0.25rem;
          flex-wrap: wrap;
        }
        .gs-grant-inline-text {
          font-size: 0.6875rem;
          color: var(--text-secondary);
          font-style: italic;
        }
        .gs-grant-inline-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.3125rem;
          background: transparent;
          border: 1px solid rgba(201,168,124,0.25);
          border-radius: 0.375rem;
          color: var(--amber, #c9a87c);
          font-size: 0.6875rem;
          font-family: inherit;
          padding: 0.1875rem 0.5625rem;
          cursor: pointer;
          white-space: nowrap;
          transition:
            background 150ms var(--hearth-curve, ease),
            border-color 150ms var(--hearth-curve, ease),
            transform 100ms var(--hearth-curve, ease);
        }
        .gs-grant-inline-btn:hover:not(:disabled) {
          background: rgba(201,168,124,0.10);
          border-color: rgba(201,168,124,0.42);
        }
        .gs-grant-inline-btn:active:not(:disabled) { transform: scale(0.985) translateY(0.5px); }
        .gs-grant-inline-btn:disabled { opacity: 0.45; cursor: not-allowed; }

        /* Right column — account selector + toggle stacked */
        .gs-service-right {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 0.4375rem;
          flex-shrink: 0;
        }

        /* Account dropdown */
        .gs-account-select {
          width: auto;
          min-width: 9rem;
          max-width: 13rem;
        }
        .gs-account-select .hsel-trigger {
          padding: 0.25rem 0.5rem;
          min-width: 0;
        }
        .gs-account-select .hsel-trigger .hsel-trigger-text {
          font-size: 0.75rem;
          color: var(--text-secondary, #a09689);
        }

        /* Toggle within service row */
        .gs-toggle-disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .gs-toggle-spinner {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* ── Google G icon ── */
        .google-g-icon {
          width: 1rem;
          height: 1rem;
          flex-shrink: 0;
          opacity: 0.8;
        }

        /* ── Eye icons ── */
        .gs-eye-icon {
          width: 0.9375rem;
          height: 0.9375rem;
        }

        /* ── Feedback ── */
        .google-msg {
          font-size: 0.8125rem;
          color: #6dba88;
          margin-top: 0.875rem;
          font-style: italic;
        }
        .google-err {
          font-size: 0.8125rem;
          color: var(--status-error-text);
          margin-top: 0.875rem;
          font-style: italic;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(3px); }
          to   { opacity: 1; transform: none; }
        }

        /* Desktop floor: body text >= 14px, pills/badges/glyphs >= 12px. Phone sizes untouched. */
        @media (min-width: 769px) {
          .settings-view .gs-accordion-glyph, .settings-view .gs-accordion-chevron, .settings-view .gs-step-num,
          .settings-view .ga-account-error-note, .settings-view .gs-restricted-pill, .settings-view .gs-service-note { font-size: 12px; }
          .settings-view .gs-accordion-label, .settings-view .gs-accordion-intro, .settings-view .gs-step-body,
          .settings-view .gs-accordion-note, .settings-view .gs-field-label, .settings-view .gs-field-input.mono,
          .settings-view .gs-cred-err, .settings-view .gs-cred-hint, .settings-view .gs-configured-label,
          .settings-view .gs-edit-keys-btn, .settings-view .ga-empty-note, .settings-view .ga-account-email,
          .settings-view .ga-add-btn, .settings-view .ga-add-hint, .settings-view .gs-service-hint,
          .settings-view .gs-grant-inline-text, .settings-view .gs-grant-inline-btn,
          .settings-view .gs-account-select .hsel-trigger .hsel-trigger-text,
          .settings-view .gs-save-btn, .settings-view input.gs-field-input,
          .settings-view .google-msg, .settings-view .google-err { font-size: 14px; }
        }

        /* Mobile: make account dropdowns full-width and iOS-safe */
        @media (max-width: 600px) {
          .gs-account-select {
            min-width: unset;
            max-width: 100%;
            width: 100%;
          }
          .gs-account-select .hsel-trigger {
            min-height: 44px;
          }
          .gs-account-select .hsel-trigger .hsel-trigger-text {
            font-size: 1rem;
          }
          .gs-service-right {
            flex-direction: column;
            align-items: flex-start;
            width: 100%;
          }
          .gs-service-row {
            flex-wrap: wrap;
          }
          .gs-accordion-trigger {
            min-height: 44px;
          }
        }
      `}</style>
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function EyeIcon() {
  return (
    <svg className="gs-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg className="gs-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
