/**
 * ChannelsSection — unified Discord + Telegram gateway cards.
 * Settings slice 1. Reads GET /api/channels aggregator (single call, no polling).
 * Each card: status pill, enable toggle, Test button, Configure expand/collapse.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Card,
  Eyebrow,
  Pill,
  Btn,
  Spinner,
  FieldRow,
  TextField,
  SubDivider,
  SaveIndicator,
  EmptyState,
} from './primitives';
import type { ChannelSummary, ChannelsResponse, ChannelTestResult } from '@sanctum/shared';
import { useConfirm } from '../ConfirmDialog';
import { parseRecentFailures, describeFailures, DISCORD_LOG_FILTER, type FailureView } from './discordFailures';

// ─── CSS (scoped .ch-* — no overrides to .sp-* primitives) ───────────────────

const CHANNELS_CSS = `
.channels-section { padding-bottom: 2rem; }

.ch-card { padding: 0.625rem 1rem 0.5rem; }

.ch-card-header {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.125rem 0 0.5rem;
  flex-wrap: wrap; /* phones: controls drop to a second row instead of crushing the name */
}
.ch-card-identity .sp-pill { white-space: nowrap; flex-shrink: 0; }
.ch-card-identity {
  display: flex; align-items: center; gap: 0.625rem;
  flex: 1; min-width: 0;
}
.ch-card-icon { display: flex; align-items: center; flex-shrink: 0; }
.ch-card-namegroup { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
.ch-card-name { font-size: 0.9375rem; color: var(--text-primary, #e2dbd0); font-weight: 450; }
.ch-card-desc { font-size: 0.6875rem; color: var(--text-muted, #6a6258); font-style: italic; }

.ch-card-controls {
  display: flex; align-items: center; gap: 0.5rem;
  margin-left: auto; flex-shrink: 0;
}

.ch-test-result { margin-right: 0.125rem; }

.ch-card-configure-btn { display: inline-flex; align-items: center; gap: 0.3rem; }
.ch-chevron { transition: transform 160ms var(--hearth-curve, ease); }
.ch-chevron.open { transform: rotate(180deg); }

.ch-card-config {
  animation: fadeIn 180ms var(--hearth-curve, ease) both;
  padding-top: 0.25rem;
}
.ch-card-config-body {
  display: flex; flex-direction: column; gap: 0.75rem;
  padding: 0.375rem 0 0.5rem;
}
.ch-config-footer {
  display: flex; justify-content: flex-end; align-items: center;
  gap: 0.5rem; margin-top: 0.25rem;
}

.ch-card-stack { display: flex; flex-direction: column; gap: 0.625rem; }

.ch-header-note {
  font-size: 0.75rem; color: var(--text-muted, #6a6258);
  font-style: italic; margin: 0.125rem 0 1.25rem;
}

.ch-err {
  font-size: 0.8125rem;
  color: var(--status-error-text);
  font-style: italic;
  margin-top: 0.375rem;
  margin-bottom: 0;
}

.ch-failures { margin: 0 0 0.375rem; font-size: 0.8125rem; color: var(--text-muted, #6a6258); display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem; }
.ch-failures.error { color: var(--status-error-text); }
.ch-failures.warning { color: var(--status-warning-text); }
.ch-failures-link { background: none; border: 0; padding: 0; font: inherit; color: inherit; text-decoration: underline; cursor: pointer; }

.ch-loading {
  display: flex;
  justify-content: center;
  padding: 2rem 0;
}

@media (min-width: 769px) {
  .settings-view .ch-card-desc { font-size: 14px; }
  .settings-view .ch-header-note { font-size: 14px; }
  .settings-view .ch-err { font-size: 14px; }
  .settings-view .ch-failures { font-size: 14px; }
}

@media (max-width: 600px) {
  .ch-card-desc { display: none; }
  .ch-card-controls { gap: 0.375rem; }
}
`;

// ─── Derived channel state ────────────────────────────────────────────────────

type ChannelState = 'connected' | 'offline' | 'disabled' | 'no_token';

function deriveChannelState(s: {
  hasToken: boolean;
  enabled: boolean;
  connected: boolean;
} | null): ChannelState {
  if (!s || !s.hasToken) return 'no_token';
  if (!s.enabled) return 'disabled';
  if (s.connected) return 'connected';
  return 'offline';
}

const PILL_MAP: Record<ChannelState, { color: string; label: string }> = {
  connected: { color: '#6dba88', label: 'connected' },
  offline:   { color: '#71717a', label: 'offline' },
  disabled:  { color: '#6a6258', label: 'disabled' },
  no_token:  { color: '#d4a843', label: 'no token' },
};

// ─── Discord send failures (D11 reader) ──────────────────────────────────────

const FAILURES_REFRESH_MS = 30_000;

function DiscordFailures({ base, onOpenLogs }: { base: string; onOpenLogs?: (q: string) => void }) {
  const [view, setView] = useState<FailureView | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${base}/api/discord/status`);
        if (!res.ok) return;
        const v = describeFailures(parseRecentFailures(await res.json()));
        if (alive) setView(v);
      } catch { /* no status: the card shows nothing rather than a guess */ }
    };
    load();
    // The Settings page can sit open: read again every 30 seconds, and stop with the card.
    const timer = setInterval(load, FAILURES_REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [base]);
  if (!view) return null;
  return (
    <p className={`ch-failures ${view.tone}`} role={view.tone === 'error' ? 'alert' : undefined}>
      <span>{view.headline}</span>
      {view.detail && <span>{view.detail}</span>}
      {view.note && <span>{view.note}</span>}
      {onOpenLogs && (
        <button type="button" className="ch-failures-link" onClick={() => onOpenLogs(DISCORD_LOG_FILTER)}>open the log, filtered to [discord]</button>
      )}
    </p>
  );
}

// ─── ChannelCard ──────────────────────────────────────────────────────────────

function ChannelCard({
  channel,
  base,
  onRefresh,
  onOpenLogs,
}: {
  channel: ChannelSummary;
  base: string;
  onRefresh: () => Promise<void>;
  onOpenLogs?: (q: string) => void;
}) {
  const { id, hasToken, enabled, connected, ownerId, tokenEnvVar } = channel;

  const confirm = useConfirm();
  const [toggling, setToggling]         = useState(false);
  const [configOpen, setConfigOpen]     = useState(false);
  const [testing, setTesting]           = useState(false);
  const [testResult, setTestResult]     = useState<{ ok: boolean; text: string } | null>(null);
  const [ownerUserId, setOwnerUserId]   = useState(ownerId ?? '');
  const [saving, setSaving]             = useState(false);
  const [saveStatus, setSaveStatus]     = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errMsg, setErrMsg]             = useState<string | null>(null);
  const editingOwner                    = useRef(false);
  const [tokenInput, setTokenInput]           = useState('');
  const [tokenSaving, setTokenSaving]         = useState(false);
  const [tokenSaveStatus, setTokenSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Sync ownerUserId from prop whenever it changes, unless user is mid-edit
  useEffect(() => {
    if (!editingOwner.current) {
      setOwnerUserId(ownerId ?? '');
    }
  }, [ownerId]);

  const state = deriveChannelState({ hasToken, enabled, connected });
  const pill  = PILL_MAP[state];

  // ── Toggle ────────────────────────────────────────────────────────────────

  const handleToggle = async () => {
    setToggling(true);
    const want = !enabled;
    try {
      const res = await fetch(`${base}/api/${id}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: want }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Toggle failed');
      }
      // Delay before refreshing when enabling — matches existing section timing
      if (want) {
        const delay = id === 'telegram' ? 1200 : 1500;
        await new Promise<void>(r => setTimeout(r, delay));
      }
      await onRefresh();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Toggle failed');
      setTimeout(() => setErrMsg(null), 3000);
    }
    setToggling(false);
  };

  // ── Test ──────────────────────────────────────────────────────────────────

  const handleTest = async () => {
    setTesting(true);
    try {
      const res  = await fetch(`${base}/api/channels/${id}/test`, { method: 'POST' });
      const data = await res.json() as ChannelTestResult;
      const text = data.message.length > 20 ? data.message.slice(0, 20) : data.message;
      setTestResult({ ok: data.ok, text });
    } catch {
      setTestResult({ ok: false, text: 'network error' });
    }
    setTesting(false);
    setTimeout(() => setTestResult(null), 3000);
  };

  // ── Save (Discord only) ───────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('saving');
    try {
      const res = await fetch(`${base}/api/discord/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerUserId: ownerUserId.trim() }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveStatus('saved');
      editingOwner.current = false;
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
    setSaving(false);
  };

  // ── Save token ────────────────────────────────────────────────────────────

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return;
    setTokenSaving(true);
    setTokenSaveStatus('saving');
    try {
      const res = await fetch(`${base}/api/${id}/token`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim() }),
      });
      if (!res.ok) throw new Error('Save failed');
      setTokenInput('');
      setTokenSaveStatus('saved');
      await onRefresh();
      setTimeout(() => setTokenSaveStatus('idle'), 2000);
    } catch {
      setTokenSaveStatus('error');
      setTimeout(() => setTokenSaveStatus('idle'), 3000);
    }
    setTokenSaving(false);
  };

  // ── Clear token ───────────────────────────────────────────────────────────

  const handleClearToken = async () => {
    const ok = await confirm({
      title: `Clear the ${name} bot token?`,
      body: 'The stored token will be deleted and the gateway will disconnect until a new token is saved.',
      confirmLabel: 'Clear token',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setTokenSaving(true);
    setTokenSaveStatus('saving');
    try {
      const res = await fetch(`${base}/api/${id}/token`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Clear failed');
      setTokenSaveStatus('saved');
      await onRefresh();
      setTimeout(() => setTokenSaveStatus('idle'), 2000);
    } catch {
      setTokenSaveStatus('error');
      setTimeout(() => setTokenSaveStatus('idle'), 3000);
    }
    setTokenSaving(false);
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const icon =
    id === 'discord' ? (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ) : (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <line x1="22" y1="2" x2="11" y2="13" />
        <polygon points="22 2 15 22 11 13 2 9 22 2" />
      </svg>
    );

  const name = id === 'discord' ? 'Discord' : 'Telegram';
  const desc = id === 'discord' ? 'your owner channel, and listed public servers' : 'private messages and bots';

  return (
    <Card className="ch-card">

      {/* ── Header row ── */}
      <div className="ch-card-header">

        {/* Identity cluster */}
        <div className="ch-card-identity">
          <span className="ch-card-icon" style={{ color: 'var(--amber, #c9a87c)', opacity: 0.65 }}>
            {icon}
          </span>
          <div className="ch-card-namegroup">
            <span className="ch-card-name">{name}</span>
            <span className="ch-card-desc">{desc}</span>
          </div>
          <Pill color={pill.color} label={pill.label} />
        </div>

        {/* Controls cluster */}
        <div className="ch-card-controls">

          {/* Test result flash — always in DOM to prevent reflow */}
          {testResult !== null ? (
            <span className={`sp-save-indicator ${testResult.ok ? 'saved' : 'error'} ch-test-result`}>
              {testResult.text}
            </span>
          ) : (
            <span className="ch-test-result" style={{ display: 'none' }} aria-hidden="true" />
          )}

          {/* Test button */}
          <Btn
            variant="muted"
            small
            disabled={!connected || testing}
            onClick={handleTest}
          >
            {testing ? <Spinner /> : 'test'}
          </Btn>

          {/* Configure button + animated chevron */}
          <Btn
            variant="ghost"
            small
            onClick={() => setConfigOpen(o => !o)}
          >
            <span className="ch-card-configure-btn">
              configure
              <svg
                className={`ch-chevron${configOpen ? ' open' : ''}`}
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="4 6 8 10 12 6" />
              </svg>
            </span>
          </Btn>

          {/* Enable toggle — raw button matching .sp-toggle pattern */}
          <button
            role="switch"
            aria-checked={enabled}
            disabled={!hasToken || toggling}
            className={`sp-toggle${enabled ? ' on' : ''}`}
            onClick={handleToggle}
            aria-label={`Enable ${name} gateway`}
          >
            <span className="sp-toggle-thumb" />
          </button>
        </div>
      </div>

      {/* Toggle error flash */}
      {errMsg && <p className="ch-err">{errMsg}</p>}

      {id === 'discord' && hasToken && enabled && <DiscordFailures base={base} onOpenLogs={onOpenLogs} />}

      {/* ── Configure body — conditionally rendered, collapses to zero naturally ── */}
      {configOpen && (
        <div className="ch-card-config">
          <SubDivider label="configure" />
          <div className="ch-card-config-body">

            {/* Token CRUD — password input, value never pre-filled from server */}
            <div className="sp-form-group">
              <label className="sp-form-label">bot token</label>
              <input
                type="password"
                className="sp-form-input mono"
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                placeholder={hasToken ? 'enter new token to replace' : 'paste token here'}
                autoComplete="new-password"
              />
              <span className="sp-form-hint">
                {hasToken ? 'token set ✓' : `no token set — enter above to save (or set ${tokenEnvVar} in .env)`}
              </span>
            </div>

            {/* Discord only: editable owner user ID */}
            {id === 'discord' && (
              <TextField
                label="owner user id"
                value={ownerUserId}
                onChange={v => { setOwnerUserId(v); editingOwner.current = true; }}
                placeholder="your Discord snowflake ID"
                hint="restricts DM access to this account; leave empty to allow any paired user"
                mono
              />
            )}

            {/* Telegram only: read-only owner chat ID */}
            {id === 'telegram' && (
              <FieldRow
                label="owner chat id"
                value={ownerId ?? null}
                hint="auto-populated after your first /start message to the bot"
                mono
              />
            )}

            {/* Configure footer */}
            <div className="ch-config-footer">
              <SaveIndicator status={tokenSaveStatus} />
              {id === 'discord' && (
                <Btn
                  variant="primary"
                  small
                  onClick={handleSave}
                  disabled={saving || !ownerUserId.trim()}
                >
                  save owner
                </Btn>
              )}
              {hasToken && (
                <Btn variant="danger" small onClick={handleClearToken} disabled={tokenSaving}>
                  clear token
                </Btn>
              )}
              <Btn
                variant="primary"
                small
                onClick={handleSaveToken}
                disabled={tokenSaving || !tokenInput.trim()}
              >
                save token
              </Btn>
            </div>

          </div>
        </div>
      )}
    </Card>
  );
}

// ─── ChannelsSection ──────────────────────────────────────────────────────────

export function ChannelsSection({ base, onOpenLogs }: { base: string; onOpenLogs?: (q: string) => void }) {
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Single aggregator fetch. On refresh (after toggle), channels updates in-place
  // without setting loading=true, so ChannelCard local state (configOpen etc.) survives.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/channels`);
      if (res.status === 404 || res.status === 501 || !res.ok) {
        setUnavailable(true);
        return;
      }
      const data = await res.json() as ChannelsResponse;
      setChannels(data.channels);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  const configuredCount = channels ? channels.filter(c => c.hasToken).length : 0;
  const isLoading = channels === null && !unavailable;

  return (
    <div className="channels-section">
      <style>{CHANNELS_CSS}</style>

      <Eyebrow label="channels" sub={`${configuredCount} of 2 configured`} />
      <p className="ch-header-note">
        Bot tokens can be set here (saved encrypted in the DB) or via DISCORD_BOT_TOKEN / TELEGRAM_BOT_TOKEN in .env.
      </p>

      {isLoading ? (
        <div className="ch-loading"><Spinner /></div>
      ) : unavailable ? (
        <EmptyState message="Channel gateways unavailable — check that the backend is running." />
      ) : (
        <div className="ch-card-stack">
          {channels!.map(ch => (
            <ChannelCard
              key={ch.id}
              channel={ch}
              base={base}
              onRefresh={load}
              onOpenLogs={onOpenLogs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
