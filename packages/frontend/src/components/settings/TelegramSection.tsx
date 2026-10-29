/**
 * Telegram gateway section — status + config via /api/telegram/status.
 * Graceful disabled/unavailable state.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Group, Eyebrow, ToggleRow, EmptyState, Spinner, StatCard } from './primitives';

interface TelegramStatus {
  enabled: boolean;
  hasToken: boolean;
  connected: boolean;
  username: string | null;
  messagesProcessed: number;
  errors: number;
  restarts: number;
}

export function TelegramSection({ base }: { base: string }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [notAvailable, setNotAvailable] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function flash(text: string, isErr = false) {
    if (isErr) setErr(text);
    else setMsg(text);
    setTimeout(() => { setMsg(null); setErr(null); }, 3000);
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${base}/api/telegram/status`);
      if (res.status === 404 || res.status === 501) { setNotAvailable(true); setLoading(false); return; }
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.enabled === 'boolean') setStatus(data);
      }
    } catch { setNotAvailable(true); }
    setLoading(false);
  }, [base]);

  useEffect(() => { load(); }, [load]);

  const toggleGateway = async (enabled: boolean) => {
    setToggling(true);
    try {
      const res = await fetch(`${base}/api/telegram/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed');
      flash(enabled ? 'Telegram gateway starting…' : 'Telegram gateway stopped');
      if (enabled) await new Promise(r => setTimeout(r, 1200));
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : 'Toggle failed', true); }
    setToggling(false);
  };

  if (loading) return <div className="tg-loading"><Spinner /></div>;

  if (notAvailable) {
    return (
      <EmptyState message="Telegram gateway endpoint unavailable — enable telegram in Preferences first, or check your backend." />
    );
  }

  const isConnected = status?.connected ?? false;

  return (
    <div className="telegram-section">
      {!status?.hasToken && (
        <div className="tg-warn">
          <span className="tg-warn-text">
            No bot token configured. Add <code>TELEGRAM_BOT_TOKEN</code> to .env and restart.
          </span>
        </div>
      )}

      <Eyebrow label="gateway" />
      <Group>
        <ToggleRow
          label={status?.enabled ? 'gateway active' : 'gateway off'}
          checked={status?.enabled ?? false}
          onChange={toggleGateway}
          disabled={toggling || !status?.hasToken}
          hint="Connect to Telegram and receive messages"
        />
      </Group>

      {status?.enabled && (
        <>
          <Eyebrow label="connection" />
          <Group>
            <div className="tg-status-row">
              <span
                className="tg-pip"
                style={{ background: isConnected ? '#6dba88' : '#71717a' }}
                aria-hidden="true"
              />
              {isConnected ? (
                <span className="tg-status-text connected">
                  online{status.username ? ` as @${status.username}` : ''}
                </span>
              ) : (
                <span className="tg-status-text">connecting…</span>
              )}
            </div>

            {isConnected && status && (
              <div className="tg-stats">
                <div className="sp-stat-grid">
                  <StatCard label="processed" value={status.messagesProcessed} />
                  <StatCard label="errors" value={status.errors} warn={status.errors > 0} />
                  <StatCard label="restarts" value={status.restarts} warn={status.restarts > 1} />
                </div>
              </div>
            )}
          </Group>
        </>
      )}

      {msg && <p className="tg-msg">{msg}</p>}
      {err && <p className="tg-err">{err}</p>}

      <style>{`
        .telegram-section { padding-bottom: 2rem; }

        .tg-loading {
          display: flex;
          justify-content: center;
          padding: 2rem 0;
        }

        .tg-warn {
          padding: 0.75rem 1rem;
          background: rgba(212,168,67,0.08);
          border: 1px solid rgba(212,168,67,0.20);
          border-radius: 0.625rem;
          margin-bottom: 1rem;
        }
        .tg-warn-text {
          font-size: 0.8125rem;
          color: #d4a843;
        }
        .tg-warn-text code {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          background: rgba(212,168,67,0.12);
          padding: 0.0625rem 0.25rem;
          border-radius: 0.25rem;
        }

        .tg-status-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.75rem 0 0.5rem;
        }
        .tg-pip {
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .tg-status-text {
          font-size: 0.875rem;
          color: var(--text-secondary, #a09689);
        }
        .tg-status-text.connected { color: #6dba88; }

        .tg-stats { padding-bottom: 0.75rem; }

        .tg-msg { font-size: 0.8125rem; color: #6dba88; margin-top: 0.875rem; font-style: italic; }
        .tg-err { font-size: 0.8125rem; color: var(--status-error-text); margin-top: 0.875rem; font-style: italic; }
      `}</style>
    </div>
  );
}
