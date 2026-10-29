import React, { useEffect, useState, useCallback } from 'react';
import { useChatStore } from '../store/chat';

// ─── Base URL (matches SettingsView pattern) ───────────────────────────────────
import { BASE } from '../lib/base';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Connection {
  platform: string;
  label: string;
  threadCount: number;
  lastActivityAt: string | null;
  unreadCount: number;
  lastMessage: { content: string; role: string; createdAt: string } | null;
  threadIds: string[];
}

export type ActiveTab = 'daily' | string; // 'daily' | platform name ('telegram' | 'discord')

interface Props {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab, threadIds: string[]) => void;
}

// ─── Icons ─────────────────────────────────────────────────────────────────────

function DailyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.114 18.103.132 18.115a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
    </svg>
  );
}

function iconForPlatform(platform: string) {
  if (platform === 'telegram') return <TelegramIcon />;
  if (platform === 'discord') return <DiscordIcon />;
  return <DailyIcon />;
}

// ─── ConnectionTabs ────────────────────────────────────────────────────────────

export function ConnectionTabs({ activeTab, onTabChange }: Props) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const loadThread = useChatStore(s => s.loadThread);

  // Fetch /api/connections once on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchConnections() {
      try {
        const res = await fetch(`${BASE}/api/connections`);
        if (!res.ok) throw new Error(`connections ${res.status}`);
        const data = await res.json() as { connections: Connection[] };
        if (!cancelled) setConnections(data.connections ?? []);
      } catch (err) {
        console.warn('[ConnectionTabs] Failed to load connections:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchConnections();
    return () => { cancelled = true; };
  }, []);

  // Tab selection: signal parent with the tab id and its thread ids.
  // Daily thread resolution is owned by ChatView (calls GET /api/threads/today).
  const handleSelect = useCallback((conn: Connection) => {
    const tab = conn.platform === 'daily' ? 'daily' : conn.platform;
    onTabChange(tab, conn.threadIds);
    // For non-daily platform tabs, eagerly load the first thread
    if (conn.platform !== 'daily' && conn.threadIds.length > 0) {
      void loadThread(conn.threadIds[0]);
    }
  }, [onTabChange, loadThread]);

  // The strip only earns its place once there is somewhere else to switch to:
  // a Discord or Telegram connection with threads. Alone, "Daily" is just a
  // label for the only option, so it stays hidden (and nothing flashes while
  // the list loads).
  const hasOtherChannel = connections.some(c => c.platform !== 'daily' && c.threadCount > 0);
  if (loading || !hasOtherChannel) return null;

  return (
    <nav className="conn-tabs" aria-label="Connections">
      {connections.map(conn => {
        const tabId = conn.platform === 'daily' ? 'daily' : conn.platform;
        const isActive = activeTab === tabId;
        const dim = conn.threadCount === 0 && conn.platform !== 'daily';
        return (
          <button
            key={conn.platform}
            className={`conn-tab${isActive ? ' active' : ''}${dim ? ' dim' : ''}`}
            onClick={() => { if (!dim) handleSelect(conn); }}
            disabled={dim}
            aria-current={isActive ? 'page' : undefined}
            title={conn.label}
          >
            <span className="conn-tab-icon">
              {iconForPlatform(conn.platform)}
            </span>
            <span className="conn-tab-name">{conn.label}</span>
            {conn.unreadCount > 0 && (
              <span className="conn-tab-badge">{conn.unreadCount > 99 ? '99+' : conn.unreadCount}</span>
            )}
          </button>
        );
      })}
      <ConnectionTabsStyles />
    </nav>
  );
}

// ─── Day divider for the Daily view ───────────────────────────────────────────

export function DayDivider({ date }: { date: string }) {
  const d = new Date(date + 'T12:00:00'); // noon avoids tz-edge DST issues
  const label = d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return (
    <div className="day-divider" aria-label={`Messages from ${label}`}>
      <span className="day-divider-line" aria-hidden="true" />
      <span className="day-divider-label">{label}</span>
      <span className="day-divider-line" aria-hidden="true" />
      <style>{`
        .day-divider {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin: 1.25rem 0 0.75rem;
          padding: 0 0.25rem;
        }
        .day-divider-line {
          flex: 1;
          height: 1px;
          background: rgba(201, 168, 124, 0.10);
        }
        .day-divider-label {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          white-space: nowrap;
          letter-spacing: 0.02em;
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function ConnectionTabsStyles() {
  return (
    <style>{`
      .conn-tabs {
        display: flex;
        align-items: center;
        gap: 0.125rem;
        padding: 0 1rem;
        flex-shrink: 0;
        border-bottom: 1px solid var(--divider, rgba(90, 65, 40, 0.14));
        box-shadow: 0 6px 14px -10px rgba(20, 10, 5, 0.5);
        background: var(--surface-panel, #f3ead7);
        overflow-x: auto;
        scrollbar-width: none;
      }
      .conn-tabs::-webkit-scrollbar { display: none; }

      .conn-tabs-loading {
        padding: 0.5rem 0;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .conn-tabs-spinner {
        display: block;
        width: 0.625rem;
        height: 0.625rem;
        border: 1.5px solid rgba(201, 168, 124, 0.2);
        border-top-color: var(--amber, #c9a87c);
        border-radius: 50%;
        animation: ctSpin 0.8s linear infinite;
      }
      @keyframes ctSpin { to { transform: rotate(360deg); } }

      /* Tab button — horizontal bar pill */
      .conn-tab {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.5625rem 0.875rem;
        border: none;
        border-radius: 0;
        background: transparent;
        color: var(--text-secondary, #a09689);
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        position: relative;
        flex-shrink: 0;
        transition:
          color var(--tx-fast, 240ms ease);
      }

      /* Amber underline — hidden at rest, slides in on active */
      .conn-tab::after {
        content: '';
        position: absolute;
        bottom: -1px; left: 0; right: 0;
        height: 1.5px;
        background: var(--amber, #c9a87c);
        transform: scaleX(0);
        transform-origin: center;
        transition: transform var(--tx-base, 380ms var(--hearth-curve, ease));
        border-radius: 1px;
      }

      .conn-tab:hover:not(:disabled) {
        color: var(--text-primary, #e2dbd0);
      }
      .conn-tab.active {
        color: var(--amber, #c9a87c);
      }
      .conn-tab.active::after {
        transform: scaleX(1);
      }
      .conn-tab.dim {
        color: var(--tab-dim-text, var(--text-muted));
        font-style: italic;
        cursor: default;
      }
      .conn-tab:active:not(:disabled) {
        transform: scale(var(--press-scale, 0.985)) translateY(0.5px);
        transition: transform 140ms var(--hearth-curve, ease);
      }

      .conn-tab-icon {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        color: inherit;
      }

      .conn-tab-name {
        letter-spacing: 0.01em;
      }

      /* Unread badge — amber, small */
      .conn-tab-badge {
        flex-shrink: 0;
        background: rgba(201, 168, 124, 0.20);
        color: var(--amber-bright, #e3c49a);
        font-size: 0.5rem;
        font-family: var(--font-mono, monospace);
        font-weight: 600;
        padding: 0.0625rem 0.3125rem;
        border-radius: 99px;
        letter-spacing: 0.04em;
        min-width: 1rem;
        text-align: center;
      }

      .conn-tab {
        font-family: var(--font-serif, 'Lora', Georgia, serif);
        font-size: 1.05rem;
        font-weight: 400;
        padding: 0.5rem 0.9rem;
      }
      .conn-tab-icon { display: none; }
      .conn-tab.active { color: var(--surface-panel-text, #3b2f52); }
      .conn-tab::after { background: var(--link, #6d5b93); height: 2px; }
      .conn-tab-badge { background: var(--bg-active, rgba(109, 91, 147, 0.18)); color: var(--surface-panel-text, #3b2f52); }

      @media (max-width: 768px) {
        .conn-tabs {
          padding: 0 0.75rem;
        }
        .conn-tab {
          padding: 0.5rem 0.625rem;
          font-size: 0.75rem;
        }
      }
    `}</style>
  );
}
