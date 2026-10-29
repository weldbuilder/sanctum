/**
 * Registered MCPs section.
 * Reads from WS event mcp_status_updated (already wired in HomeView/SettingsView global listeners),
 * and polls /api/system/status as fallback.
 * The list shows connected/failed status so the user can confirm ghost servers are gone.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { McpServerInfo } from '@sanctum/shared';
import { Eyebrow, Pill, EmptyState, Spinner, Btn, SaveIndicator } from './primitives';

// ─── MCP server row ───────────────────────────────────────────────────────────

interface McpRowProps {
  server: McpServerInfo;
  onReconnect: () => Promise<void>;
  reconnecting: boolean;
  reconnectError: string | null;
}

function McpRow({ server, onReconnect, reconnecting, reconnectError }: McpRowProps) {
  const STATUS_COLOR: Record<string, string> = {
    connected: '#6dba88',
    failed: '#c0524a',
    'needs-auth': '#d4a843',
    pending: '#71717a',
    disabled: '#3f3f46',
  };
  const STATUS_LABEL: Record<string, string> = {
    connected: 'connected',
    failed: 'failed',
    'needs-auth': 'needs auth',
    pending: 'pending',
    disabled: 'disabled',
  };

  const color = STATUS_COLOR[server.status] ?? '#3f3f46';
  const label = STATUS_LABEL[server.status] ?? server.status;
  const isOk = server.status === 'connected';
  const isDisabled = server.status === 'disabled';

  return (
    <div className="mcp-detail-row">
      <div className="mcp-detail-left">
        <span
          className="mcp-detail-pip"
          style={{ background: color, boxShadow: isOk ? `0 0 8px ${color}55` : 'none' }}
          aria-hidden="true"
        />
        <div className="mcp-detail-info">
          <span className="mcp-detail-name">{server.name}</span>
          {server.scope && (
            <span className="mcp-detail-scope">{server.scope}</span>
          )}
          {server.error && (
            <span className="mcp-detail-error" title={server.error}>
              {server.error.length > 80 ? server.error.slice(0, 80) + '…' : server.error}
            </span>
          )}
          {reconnectError && (
            <span className="mcp-detail-error">{reconnectError}</span>
          )}
        </div>
      </div>
      <div className="mcp-detail-right">
        {isOk && server.toolCount > 0 && (
          <span className="mcp-detail-tools">{server.toolCount} tools</span>
        )}
        <Pill color={color} label={label} />
        {!isDisabled && (
          <Btn
            variant="muted"
            small
            onClick={onReconnect}
            disabled={reconnecting}
          >
            {reconnecting ? (
              <><Spinner /> testing…</>
            ) : (
              'reconnect'
            )}
          </Btn>
        )}
      </div>

      <style>{`
        .mcp-detail-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.75rem;
          padding: 0.75rem 0.875rem;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 0.625rem;
          transition: border-color 240ms var(--hearth-curve, ease);
        }
        .mcp-detail-row:hover { border-color: rgba(255,255,255,0.10); }

        .mcp-detail-left {
          display: flex;
          align-items: flex-start;
          gap: 0.625rem;
          min-width: 0;
          flex: 1;
        }

        .mcp-detail-pip {
          display: inline-block;
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 50%;
          flex-shrink: 0;
          margin-top: 0.3rem;
        }

        .mcp-detail-info {
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          min-width: 0;
        }

        .mcp-detail-name {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
          color: var(--text-primary, #e2dbd0);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .mcp-detail-scope {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          letter-spacing: 0.03em;
        }

        .mcp-detail-error {
          font-size: 0.6875rem;
          color: var(--status-error-text);
          line-height: 1.4;
          margin-top: 0.125rem;
        }

        .mcp-detail-right {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-shrink: 0;
        }

        .mcp-detail-tools {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          letter-spacing: 0.04em;
        }
      `}</style>
    </div>
  );
}

// ─── McpSection ───────────────────────────────────────────────────────────────

export function McpSection({ base }: { base: string }) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-server reconnect state — keyed by server name
  const [reconnecting, setReconnecting] = useState<Set<string>>(new Set());
  const [reconnectErrors, setReconnectErrors] = useState<Map<string, string>>(new Map());

  const handleReconnect = useCallback(async (serverName: string) => {
    setReconnecting(prev => new Set([...prev, serverName]));
    setReconnectErrors(prev => {
      const next = new Map(prev);
      next.delete(serverName);
      return next;
    });
    try {
      const res = await fetch(`${base}/api/system/mcp/reconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: serverName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setReconnectErrors(prev => new Map([...prev, [serverName, data.error || 'Reconnect failed']]));
      }
      // On success, the backend broadcasts mcp_status_updated — WS listener updates servers
    } catch {
      setReconnectErrors(prev => new Map([...prev, [serverName, 'Network error']]));
    } finally {
      setReconnecting(prev => {
        const next = new Set(prev);
        next.delete(serverName);
        return next;
      });
    }
  }, [base]);

  // Poll /api/system/status for initial load
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${base}/api/system/status`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.mcpServers)) {
            setServers(data.mcpServers);
          }
        }
      } catch { /* graceful */ }
      setLoading(false);
    }
    load();
  }, [base]);

  // Also subscribe to live WS events pushed by the global listener
  useEffect(() => {
    const handler = (msg: any) => {
      if (msg.type === 'mcp_status_updated' && Array.isArray(msg.servers)) {
        setServers(msg.servers);
        setLoading(false);
      }
      if (msg.type === 'system_status' && Array.isArray(msg.status?.mcpServers)) {
        setServers(msg.status.mcpServers);
        setLoading(false);
      }
    };
    if (!(window as any).__sanctumWsListeners) (window as any).__sanctumWsListeners = [];
    (window as any).__sanctumWsListeners.push(handler);
    return () => {
      (window as any).__sanctumWsListeners = (
        (window as any).__sanctumWsListeners ?? []
      ).filter((h: any) => h !== handler);
    };
  }, []);

  const connected = servers.filter(s => s.status === 'connected');
  const failed = servers.filter(s => s.status === 'failed');
  const other = servers.filter(s => s.status !== 'connected' && s.status !== 'failed');

  return (
    <div className="mcp-section">
      <Eyebrow
        label="registered MCPs"
        sub={
          servers.length > 0
            ? `${connected.length} connected${failed.length > 0 ? ` · ${failed.length} failed` : ''}`
            : undefined
        }
      />

      {loading ? (
        <div className="mcp-section-loading"><Spinner /></div>
      ) : servers.length === 0 ? (
        <EmptyState message="MCP server status arrives via websocket — connect to see it here. Expected: a mind server + a discord server." />
      ) : (
        <div className="mcp-server-list">
          {connected.length > 0 && (
            <>
              {connected.map(s => (
                <McpRow
                  key={s.name}
                  server={s}
                  onReconnect={() => handleReconnect(s.name)}
                  reconnecting={reconnecting.has(s.name)}
                  reconnectError={reconnectErrors.get(s.name) ?? null}
                />
              ))}
            </>
          )}
          {failed.length > 0 && (
            <>
              {failed.map(s => (
                <McpRow
                  key={s.name}
                  server={s}
                  onReconnect={() => handleReconnect(s.name)}
                  reconnecting={reconnecting.has(s.name)}
                  reconnectError={reconnectErrors.get(s.name) ?? null}
                />
              ))}
            </>
          )}
          {other.length > 0 && (
            <>
              {other.map(s => (
                <McpRow
                  key={s.name}
                  server={s}
                  onReconnect={() => handleReconnect(s.name)}
                  reconnecting={reconnecting.has(s.name)}
                  reconnectError={reconnectErrors.get(s.name) ?? null}
                />
              ))}
            </>
          )}
        </div>
      )}

      {servers.length > 0 && (
        <>
          <Eyebrow label="tool summary" />
          <div className="mcp-tool-summary">
            {connected.map(s => (
              s.toolCount > 0 && (
                <div key={s.name} className="mcp-tool-row">
                  <span className="mcp-tool-server">{s.name}</span>
                  <span className="mcp-tool-count">{s.toolCount} tools</span>
                </div>
              )
            ))}
          </div>
        </>
      )}

      <style>{`
        .mcp-section { padding-bottom: 2rem; }

        .mcp-section-loading {
          display: flex;
          justify-content: center;
          padding: 2rem 0;
        }

        .mcp-server-list {
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
        }

        .mcp-tool-summary {
          display: flex;
          flex-direction: column;
          gap: 0;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 0.625rem;
          padding: 0 0.875rem;
        }

        .mcp-tool-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.5rem 0;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .mcp-tool-row:last-child { border-bottom: none; }

        .mcp-tool-server {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
        }

        .mcp-tool-count {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--amber, #c9a87c);
          letter-spacing: 0.04em;
        }
      `}</style>
    </div>
  );
}
