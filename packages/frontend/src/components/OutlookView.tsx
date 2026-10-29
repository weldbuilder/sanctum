import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HouseSnapshot,
  OutlookOrb,
  OutlookPresence,
  OutlookScratchpadNote,
  OutlookYou,
  OutlookUs,
  OutlookDay,
  OutlookNeedsYouItem,
  OutlookRoom,
  OutlookRecentThread,
  OutlookRecentAction,
  OutlookHouseSystems,
  OutlookSourceStatus,
  OutlookTheme,
} from '@sanctum/shared';
import { Orb } from './hearth';

// ─── helpers ─────────────────────────────────────────────────────────────────

import { BASE } from '../lib/base';

function formatTimeAgo(iso: string | number): string {
  const ms = typeof iso === 'number' ? Date.now() - iso : Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatGenerated(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatEventTime(t: string, allDay?: boolean): string {
  if (allDay || t === 'all-day') return 'all day';
  if (t.includes('T')) {
    return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return t;
}

function staleBadge(src: OutlookSourceStatus | undefined): string | null {
  if (!src || src.status === 'ok') return null;
  return `as of ${formatTimeAgo(src.updatedAt)}`;
}

function statusColor(status: string): string {
  const m: Record<string, string> = {
    connected: '#6dba88',
    ok: '#6dba88',
    failed: '#c0524a',
    error: '#c0524a',
    'needs-auth': '#d4a843',
    stale: '#d4a843',
    pending: '#71717a',
    disabled: '#3f3f46',
  };
  return m[status] ?? '#71717a';
}

// ─── Cockpit panel wrapper ────────────────────────────────────────────────────

function Panel({
  label,
  meta,
  stale,
  children,
  amber,
}: {
  label: string;
  meta?: string;
  stale?: string | null;
  children: React.ReactNode;
  amber?: boolean;
}) {
  return (
    <div className={`ck-panel${amber ? ' ck-panel-amber' : ''}`}>
      <div className="ck-panel-head">
        <span className="ck-panel-label">{label}</span>
        {meta && <span className="ck-panel-meta">{meta}</span>}
        {stale && <span className="ck-stale">{stale}</span>}
      </div>
      <div className="ck-panel-body">
        {children}
      </div>
    </div>
  );
}

// ─── Hearth band — full width across the top ──────────────────────────────────
// The mantelpiece orb is above this in HomeView. This band carries the AUTHORED
// presence: mood headline, thoughts prose, artifacts, and needsUser highlight.

function HearthBand({
  orb,
  presence,
  src,
}: {
  orb: OutlookOrb | null;
  presence: OutlookPresence | null;
  src: OutlookSourceStatus | undefined;
}) {
  const stale = staleBadge(src);

  const orbColor = orb?.color || 'amber';
  const isAmber = orbColor !== 'lavender' && orbColor !== 'teal' && orbColor !== 'deep-red';

  return (
    <div className={`ck-hearth${stale ? ' ck-hearth-stale' : ''}`}>
      <div className="ck-hearth-glow" aria-hidden="true" />
      <div className="ck-hearth-inner">
        {/* The band finally renders the orb it receives — full weather
            dimensions (shape/intensity/blend), collapsed to band scale. */}
        {orb && (
          <div className="ck-hearth-orb">
            <Orb
              size="band"
              color={orbColor}
              blend={orb.blend || undefined}
              shape={orb.shape}
              motion={orb.motion}
              intensity={orb.intensity}
            />
          </div>
        )}
        <div className="ck-hearth-content">
        {presence ? (
          <>
            {presence.mood && (
              <p className={`ck-hearth-mood${isAmber ? '' : ' ck-hearth-mood-alt'}`}>
                {presence.mood}
              </p>
            )}
            {presence.thoughts && (
              <p className="ck-hearth-thoughts">{presence.thoughts}</p>
            )}
            {presence.artifacts && presence.artifacts.length > 0 && (
              <ul className="ck-hearth-artifacts">
                {presence.artifacts.map((a, i) => (
                  <li key={i} className="ck-artifact">
                    <span className="ck-artifact-title">{a.title}</span>
                    <span className="ck-artifact-why">{a.why}</span>
                  </li>
                ))}
              </ul>
            )}
            {presence.needsUser && (
              <div className="ck-needs-user">
                <span className="ck-needs-user-pip" aria-hidden="true" />
                <span className="ck-needs-user-text">{presence.needsUser}</span>
              </div>
            )}
            {presence.updatedAt && (
              <div className="ck-hearth-ts">{formatTimeAgo(presence.updatedAt)}</div>
            )}
          </>
        ) : (
          <p className="ck-hearth-empty">The companion hasn't written its state yet.</p>
        )}
        </div>
      </div>
      {stale && <div className="ck-hearth-stale-badge">{stale}</div>}
    </div>
  );
}

// ─── Today panel ─────────────────────────────────────────────────────────────

function TodayPanel({
  you,
  day,
  sources,
}: {
  you: OutlookYou;
  day: OutlookDay;
  sources: Record<string, OutlookSourceStatus>;
}) {
  const care = you.care ?? [];
  const doneCare = care.filter(c => c.done);
  const pendingCare = care.filter(c => !c.done);
  const careStale = staleBadge(sources['care']);
  const eventsStale = staleBadge(sources['events']);
  const tasksStale = staleBadge(sources['tasks']);

  const hasCare = care.length > 0;
  const hasEvents = day.events.length > 0;
  const hasTasks = day.tasks.length > 0;
  const hasMail = day.mailNeedsReply.length > 0;

  const careCount = doneCare.length;
  const careMeta = hasCare ? `${careCount}/${care.length}` : undefined;

  return (
    <Panel label="today" meta={careMeta} stale={eventsStale || tasksStale || null}>
      {/* Care chips */}
      {hasCare && (
        <div className={`ck-care-section${careStale ? ' ck-stale-dim' : ''}`}>
          <div className="ck-care-chips">
            {[...doneCare, ...pendingCare].map((c, i) => (
              <span key={i} className={`ck-chip${c.done ? ' ck-chip-done' : ' ck-chip-open'}`}>
                <span className="ck-chip-mark" aria-hidden="true">{c.done ? '✓' : '·'}</span>
                {c.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Events */}
      {hasEvents ? (
        <div className={`ck-events${eventsStale ? ' ck-stale-dim' : ''}`}>
          {day.events.map((e, i) => (
            <div key={i} className="ck-event-row">
              <span className="ck-event-time">{formatEventTime(e.time, e.allDay)}</span>
              <span className="ck-event-title">{e.title}</span>
            </div>
          ))}
        </div>
      ) : (
        !hasCare && !hasTasks && (
          <p className="ck-empty-line">Nothing on the board today.</p>
        )
      )}

      {/* Tasks */}
      {hasTasks && (
        <div className={`ck-tasks${tasksStale ? ' ck-stale-dim' : ''}`}>
          <div className="ck-section-label">open</div>
          {day.tasks.slice(0, 6).map((t, i) => (
            <div key={i} className="ck-task-row">
              <span className="ck-task-pip" aria-hidden="true" />
              <span className="ck-task-title">{t.title}</span>
              {t.due && <span className="ck-task-due">{t.due}</span>}
            </div>
          ))}
          {day.tasks.length > 6 && (
            <div className="ck-overflow">+{day.tasks.length - 6} more</div>
          )}
        </div>
      )}

      {/* Mail */}
      {hasMail && (
        <div className="ck-mail">
          <div className="ck-section-label">
            <span className="ck-mail-count">{day.mailNeedsReply.length}</span> needs reply
          </div>
          {day.mailNeedsReply.slice(0, 4).map((m, i) => (
            <div key={i} className="ck-mail-row">
              <span className="ck-mail-from">{m.from}</span>
              <span className="ck-mail-subject">{m.subject}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── Themes panel — "What we've been circling" ──────────────────────────────

function ThemesPanel({
  themes,
  countdowns,
  themesSrc,
  countdownsSrc,
  onOpenThread,
}: {
  themes: OutlookTheme[];
  countdowns: { label: string; when: string; daysAway?: number }[];
  themesSrc: OutlookSourceStatus | undefined;
  countdownsSrc: OutlookSourceStatus | undefined;
  onOpenThread?: (id: string) => void;
}) {
  const stale = staleBadge(themesSrc);
  const hasThemes = themes.length > 0;
  const hasCountdowns = countdowns.length > 0;

  if (!hasThemes && !hasCountdowns) return null;

  return (
    <Panel label="what we've been circling" stale={stale}>
      {hasThemes ? (
        <div className="ck-themes">
          {themes.map((t, i) => (
            <div key={i} className="ck-theme-row">
              <div className="ck-theme-head">
                <span className="ck-theme-topic">{t.topic}</span>
                <div className="ck-theme-meta">
                  {t.room && <span className="ck-theme-room">{t.room}</span>}
                  {t.lastActivityAt && (
                    <span className="ck-theme-ago">{formatTimeAgo(t.lastActivityAt)}</span>
                  )}
                  {t.threadId && (
                    <button
                      className="ck-theme-open"
                      onClick={() => onOpenThread?.(t.threadId!)}
                      aria-label={`Open thread for ${t.topic}`}
                    >
                      open
                    </button>
                  )}
                </div>
              </div>
              <p className="ck-theme-note">{t.note}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="ck-empty-line">Nothing surfaced yet — the next outlook will fill this in.</p>
      )}

      {hasCountdowns && (
        <div className="ck-countdowns">
          {countdowns.map((c, i) => (
            <div key={i} className="ck-countdown-row">
              <span className="ck-countdown-label">{c.label}</span>
              <div className="ck-countdown-right">
                {typeof c.daysAway === 'number' && (
                  <span className={`ck-countdown-days${c.daysAway === 0 ? ' today' : c.daysAway <= 7 ? ' soon' : ''}`}>
                    {c.daysAway === 0 ? 'today' : c.daysAway === 1 ? 'tomorrow' : `${c.daysAway}d`}
                  </span>
                )}
                <span className="ck-countdown-when">{c.when}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── Needs You panel ─────────────────────────────────────────────────────────

function NeedsYouPanel({
  items,
  src,
}: {
  items: OutlookNeedsYouItem[];
  src: OutlookSourceStatus | undefined;
}) {
  const stale = staleBadge(src);
  if (items.length === 0) return null;

  return (
    <Panel label="things asking for you" meta={`${items.length} open`} stale={stale}>
      <div className="ck-needs-list">
        {items.map((item, i) => (
          <div key={i} className="ck-need-row">
            <span className={`ck-need-tag ck-need-tag-${item.kind}`}>{item.kind}</span>
            <span className="ck-need-text">{item.text}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ─── The House panel (rooms + recent threads + recent actions) ────────────────

function HousePanel({
  rooms,
  recentThreads,
  recentActions,
  roomsSrc,
  threadsSrc,
  onOpenThread,
}: {
  rooms: OutlookRoom[];
  recentThreads: OutlookRecentThread[];
  recentActions: OutlookRecentAction[];
  roomsSrc: OutlookSourceStatus | undefined;
  threadsSrc: OutlookSourceStatus | undefined;
  onOpenThread?: (id: string) => void;
}) {
  const stale = staleBadge(roomsSrc);

  return (
    <Panel label="the house" meta={`${rooms.length} rooms`} stale={stale}>
      {rooms.length > 0 ? (
        <div className="ck-rooms">
          {rooms.map(r => (
            <div
              key={r.id}
              className={`ck-room${r.kind === 'daily' ? ' ck-room-daily' : ''}`}
            >
              <span className="ck-room-name">{r.name}</span>
              <span className="ck-room-threads">{r.threadCount}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="ck-empty-line">No rooms yet.</p>
      )}

      {recentThreads.length > 0 && (
        <div className="ck-recent-threads">
          <div className="ck-section-label">recent</div>
          {recentThreads.slice(0, 4).map(t => (
            <div key={t.id} className="ck-recent-thread-row">
              <button
                className="ck-recent-thread-btn"
                onClick={() => onOpenThread?.(t.id)}
              >
                {t.name}
              </button>
              <span className="ck-recent-thread-room">{t.roomName}</span>
              {t.lastActivityAt && (
                <span className="ck-recent-thread-ago">{formatTimeAgo(t.lastActivityAt)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {recentActions.length > 0 && (
        <div className="ck-recent-actions">
          <div className="ck-section-label">actions</div>
          {recentActions.slice(0, 3).map((a, i) => (
            <div key={i} className="ck-action-row">
              <span className={`ck-action-pip${a.success ? ' ok' : ' err'}`} aria-hidden="true" />
              <span className="ck-action-summary">{a.summary}</span>
              <span className="ck-action-ago">{formatTimeAgo(a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── User's card (rail) ───────────────────────────────────────────────────────
// Lifted from HomeView — the same interactive context card, re-skinned for the rail.

interface MaryCardData {
  outfit?: string;
  nails?: string;
  hair?: string;
  energy?: string;
  room?: string;
  freeform?: string;
  updated_at?: string;
}

const USER_FIELDS: { key: keyof MaryCardData; label: string; multiline?: boolean }[] = [
  { key: 'outfit', label: 'outfit' },
  { key: 'nails', label: 'nails' },
  { key: 'hair', label: 'hair' },
  { key: 'energy', label: 'energy' },
  { key: 'room', label: 'room' },
  { key: 'freeform', label: 'note', multiline: true },
];

function CockpitMaryCard() {
  const [card, setCard] = useState<MaryCardData>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  async function fetchCard() {
    try {
      const res = await fetch(`${BASE}/api/home/mantelpiece`);
      if (res.ok) {
        const data = await res.json() as { companion: unknown; user: MaryCardData };
        setCard(data.user ?? {});
      }
    } catch { /* graceful */ }
  }

  useEffect(() => {
    fetchCard();
    const id = setInterval(fetchCard, 30_000);
    return () => clearInterval(id);
  }, []);

  // Session-authed user-card write (POST /api/home/mantelpiece/user) — the
  // browser must never hold the internal token; the old /internal/context
  // POST 404'd silently and the card quietly reverted.
  async function write(body: Record<string, unknown>) {
    try {
      const res = await fetch(`${BASE}/api/home/mantelpiece/user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setWriteError(null);
    } catch (err) {
      console.error('[CockpitMaryCard] Save failed:', err);
      setWriteError('couldn’t save — try again');
      setTimeout(() => setWriteError(null), 5000);
    }
    fetchCard();
  }

  function commit(field: string, value: string, prev: string) {
    setEditing(null);
    if (value.trim() !== prev) write({ action: 'set', field, value: value.trim() });
  }

  const timestamp = card.updated_at ? formatTimeAgo(card.updated_at) : null;
  const anySet = USER_FIELDS.some(f => card[f.key]);

  return (
    <div className="ck-user-card">
      <div className="ck-rail-label">you</div>
      {!anySet && editing === null && (
        <div className="ck-user-hint">Nothing set — tap a row.</div>
      )}
      <div className="ck-user-rows">
        {USER_FIELDS.map(f => {
          const value = (card[f.key] as string | undefined) ?? '';
          const isEditing = editing === f.key;
          return (
            <div className={`ck-user-row${value ? ' filled' : ''}`} key={f.key}>
              <span className="ck-user-label">{f.label}</span>
              {isEditing ? (
                f.multiline ? (
                  <textarea
                    className="ck-user-input"
                    autoFocus
                    rows={2}
                    defaultValue={value}
                    onKeyDown={e => { if (e.key === 'Escape') setEditing(null); }}
                    onBlur={e => commit(f.key, e.currentTarget.value, value)}
                    placeholder="…"
                  />
                ) : (
                  <input
                    className="ck-user-input"
                    autoFocus
                    defaultValue={value}
                    onKeyDown={e => {
                      if (e.key === 'Escape') setEditing(null);
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    onBlur={e => commit(f.key, e.currentTarget.value, value)}
                    placeholder="…"
                  />
                )
              ) : value ? (
                <span className="ck-user-value" onClick={() => setEditing(f.key)}>
                  <span className="ck-user-value-text">{value}</span>
                  <button
                    className="ck-user-clear"
                    aria-label={`clear ${f.label}`}
                    onClick={e => { e.stopPropagation(); write({ action: 'clear', field: f.key }); }}
                  >×</button>
                </span>
              ) : (
                <button className="ck-user-add" onClick={() => setEditing(f.key)}>—</button>
              )}
            </div>
          );
        })}
      </div>
      {writeError && <div className="ck-user-err">{writeError}</div>}
      {timestamp && <div className="ck-user-ts">set {timestamp}</div>}
    </div>
  );
}

// ─── You (body) rail card ─────────────────────────────────────────────────────

function YouRailCard({
  you,
  sources,
}: {
  you: OutlookYou;
  sources: Record<string, OutlookSourceStatus>;
}) {
  const bodyStale = staleBadge(sources['body']);
  const moodStale = staleBadge(sources['mood']);
  const hasMood = you.mood !== null;
  const hasBody = you.body !== null;
  const hasSleep = you.body?.sleepSummary && you.body.sleepSummary !== 'insufficient_history';
  const hasHrv = typeof you.body?.hrvMs === 'number';
  const hasCycle = you.body?.cyclePhase && you.body.cyclePhase !== 'insufficient_history';

  if (!hasMood && !hasBody) return null;

  return (
    <div className={`ck-you-card${bodyStale || moodStale ? ' ck-stale-dim' : ''}`}>
      <div className="ck-rail-label">you</div>
      {hasMood && (
        <div className="ck-you-mood">
          <span className="ck-you-mood-pip" aria-hidden="true" />
          <span className="ck-you-mood-text">{you.mood}</span>
        </div>
      )}
      {hasBody && (
        <div className="ck-you-body">
          {hasSleep && (
            <div className="ck-you-row">
              <span className="ck-you-key">sleep</span>
              <span className="ck-you-val">{you.body!.sleepSummary}</span>
            </div>
          )}
          {hasHrv && (
            <div className="ck-you-row">
              <span className="ck-you-key">hrv</span>
              <span className="ck-you-val">{you.body!.hrvMs} ms</span>
            </div>
          )}
          {hasCycle && (
            <div className="ck-you-row">
              <span className="ck-you-key">cycle</span>
              <span className="ck-you-val">{you.body!.cyclePhase}</span>
            </div>
          )}
        </div>
      )}
      {(bodyStale || moodStale) && (
        <div className="ck-stale-text">{bodyStale || moodStale}</div>
      )}
    </div>
  );
}

// ─── House Systems rail card ──────────────────────────────────────────────────

function HouseSystemsCard({
  systems,
  src,
}: {
  systems: OutlookHouseSystems;
  src: OutlookSourceStatus | undefined;
}) {
  const stale = staleBadge(src);
  const pollerOk = systems.pollerOk;
  const organs = systems.organs;

  return (
    <div className={`ck-systems-card${stale ? ' ck-stale-dim' : ''}`}>
      <div className="ck-rail-label">
        house systems
        {!pollerOk && <span className="ck-systems-warn" title="Poller had issues">·</span>}
      </div>

      {/* MCP vitals */}
      {systems.mcp.length > 0 && (
        <div className="ck-mcp-list">
          {systems.mcp.map((m, i) => (
            <div key={i} className="ck-mcp-row">
              <span
                className="ck-mcp-pip"
                style={{ background: statusColor(m.status) }}
                aria-hidden="true"
              />
              <span className="ck-mcp-name">{m.name}</span>
              {m.toolCount > 0 && (
                <span className="ck-mcp-tools">{m.toolCount}</span>
              )}
              <span className="ck-mcp-status" style={{ color: statusColor(m.status) }}>
                {m.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Organs — tucked in details */}
      <details className="ck-organs-details">
        <summary className="ck-organs-summary">organs</summary>
        <div className="ck-organs-rows">
          {organs.routines !== undefined && (
            <div className="ck-organ-row">
              <span className="ck-organ-key">routines</span>
              <span className="ck-organ-val">
                {organs.routines.enabled ? 'on' : 'off'}
                {organs.routines.count !== undefined ? ` · ${organs.routines.count}` : ''}
                {organs.routines.detail ? ` · ${organs.routines.detail}` : ''}
              </span>
            </div>
          )}
          {organs.timers !== undefined && (
            <div className="ck-organ-row">
              <span className="ck-organ-key">timers</span>
              <span className="ck-organ-val">
                {organs.timers.count !== undefined ? `${organs.timers.count} pending` : '—'}
                {organs.timers.detail ? ` · ${organs.timers.detail}` : ''}
              </span>
            </div>
          )}
          {organs.watches !== undefined && (
            <div className="ck-organ-row">
              <span className="ck-organ-key">watches</span>
              <span className="ck-organ-val">
                {organs.watches.count !== undefined ? `${organs.watches.count} active` : '—'}
              </span>
            </div>
          )}
          {organs.pulse !== undefined && (
            <div className="ck-organ-row">
              <span className="ck-organ-key">pulse</span>
              <span className="ck-organ-val">
                {organs.pulse.enabled ? 'on' : 'off'}
                {organs.pulse.detail ? ` · ${organs.pulse.detail}` : ''}
              </span>
            </div>
          )}
          {organs.failsafe !== undefined && (
            <div className="ck-organ-row">
              <span className="ck-organ-key">failsafe</span>
              <span className="ck-organ-val">
                {organs.failsafe.enabled ? 'on' : 'off'}
                {organs.failsafe.detail ? ` · ${organs.failsafe.detail}` : ''}
              </span>
            </div>
          )}
        </div>
      </details>

      {stale && <div className="ck-stale-text">{stale}</div>}
    </div>
  );
}

// ─── Scratchpad panel ────────────────────────────────────────────────────────
// Notes left by the companion (or the user) via the cc_scratchpad MCP tool. Newest first.
// Hides entirely when empty. Each note has a quiet × dismiss that DELETEs via
// DELETE /api/cc/scratchpad/notes/:id and refreshes the cockpit snapshot.

function ScratchpadPanel({
  notes,
  src,
  onDismiss,
}: {
  notes: OutlookScratchpadNote[];
  src: OutlookSourceStatus | undefined;
  onDismiss: (id: string) => Promise<void>;
}) {
  const [dismissing, setDismissing] = React.useState<Set<string>>(new Set());
  const stale = staleBadge(src);

  if (notes.length === 0) return null;

  async function handleDismiss(id: string) {
    setDismissing(prev => new Set(prev).add(id));
    await onDismiss(id);
    setDismissing(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  return (
    <Panel label="notes" meta={`${notes.length}`} stale={stale} amber>
      <div className="ck-scratch-list">
        {notes.map(note => (
          <div key={note.id} className={`ck-scratch-note${dismissing.has(note.id) ? ' ck-scratch-dismissing' : ''}`}>
            <div className="ck-scratch-body">
              <p className="ck-scratch-text">{note.text}</p>
              <div className="ck-scratch-meta">
                <span className="ck-scratch-by">{note.createdBy}</span>
                <span className="ck-scratch-dot" aria-hidden="true" />
                <span className="ck-scratch-ago">{formatTimeAgo(note.createdAt)}</span>
              </div>
            </div>
            <button
              className="ck-scratch-dismiss"
              aria-label="Dismiss note"
              disabled={dismissing.has(note.id)}
              onClick={() => handleDismiss(note.id)}
            >×</button>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ─── OutlookView (main export) ────────────────────────────────────────────────

export function OutlookView({ onOpenThread }: { onOpenThread?: (id: string) => void }) {
  const [snapshot, setSnapshot] = useState<HouseSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/outlook`);
      if (res.ok) {
        const data = await res.json() as HouseSnapshot;
        setSnapshot(data);
        setError(false);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    fetchSnapshot();
    pollRef.current = setInterval(fetchSnapshot, 2.5 * 60 * 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchSnapshot]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch(`${BASE}/api/outlook/refresh`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as HouseSnapshot;
        setSnapshot(data);
        setError(false);
      }
    } catch {
      // keep last data
    } finally {
      setRefreshing(false);
    }
  }

  // Re-author — the slow Sonnet hearth/topics/needsYou write, on demand.
  // Quiet affordance beside refresh; ok-gated so a failure never fakes success.
  const [reauthoring, setReauthoring] = useState(false);
  async function handleReauthor() {
    if (reauthoring) return;
    setReauthoring(true);
    try {
      const res = await fetch(`${BASE}/api/outlook/reauthor`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { authored: boolean; snapshot: HouseSnapshot };
        setSnapshot(data.snapshot);
        setError(false);
      } else {
        console.error('[Outlook] Re-author failed: HTTP', res.status);
      }
    } catch (err) {
      console.error('[Outlook] Re-author failed:', err);
    } finally {
      setReauthoring(false);
    }
  }

  if (error && !snapshot) {
    return (
      <div className="ck-root">
        <div className="ck-error">
          <p className="ck-empty-line">The house is quiet — could not reach the server.</p>
        </div>
        <CockpitStyles />
      </div>
    );
  }

  const s = snapshot;
  const hearth = s?.hearth ?? { orb: null, presence: null };
  const you = s?.you ?? { mood: null, body: null, care: null };
  const us = s?.us ?? { themes: [], countdowns: [] };
  const day = s?.day ?? { events: [], tasks: [], mailNeedsReply: [] };
  const needsYou = s?.needsYou ?? [];
  const rooms = s?.rooms ?? [];
  const recentThreads = s?.recentThreads ?? [];
  const recentActions = s?.recentActions ?? [];
  const houseSystems = s?.houseSystems ?? { mcp: [], organs: {}, pollerOk: true };
  const scratchpad = s?.scratchpad ?? [];
  const sources = s?.sources ?? {};

  async function handleDismissNote(id: string) {
    try {
      const res = await fetch(`${BASE}/api/cc/scratchpad/notes/${id}`, { method: 'DELETE' });
      if (!res.ok) { console.error(`scratchpad dismiss failed: HTTP ${res.status}`); return; }
      // The DELETE succeeds but GET /api/outlook serves the 2.5-min CACHED
      // snapshot — refetching it resurrected the note ("delete button doesn't
      // work"). Remove locally NOW, then force a real
      // reassemble so the cache stops lying; refetch only after that.
      setSnapshot(prev => prev ? {
        ...prev,
        scratchpad: (prev.scratchpad ?? []).filter(n => n.id !== id),
      } : prev);
      await fetch(`${BASE}/api/outlook/refresh`, { method: 'POST' }).catch(() => {});
      await fetchSnapshot();
    } catch (err) {
      console.error('scratchpad dismiss error:', err);
    }
  }

  const hasThemesOrCountdowns = us.themes.length > 0 || us.countdowns.length > 0;
  const hasNeedsYou = needsYou.length > 0;
  const youHasBody = you.body !== null || you.mood !== null;

  return (
    <div className="ck-root">
      {/* ── Hearth band — full width ── */}
      <HearthBand
        orb={hearth.orb}
        presence={hearth.presence}
        src={sources['presence']}
      />

      {/* ── Cockpit grid ── */}
      <div className="ck-cockpit">
        {/* MAIN column */}
        <div className="ck-main">
          <TodayPanel you={you} day={day} sources={sources} />

          {hasThemesOrCountdowns && (
            <ThemesPanel
              themes={us.themes}
              countdowns={us.countdowns}
              themesSrc={sources['themes']}
              countdownsSrc={sources['countdowns']}
              onOpenThread={onOpenThread}
            />
          )}

          {hasNeedsYou && (
            <NeedsYouPanel items={needsYou} src={sources['needsYou']} />
          )}

          <ScratchpadPanel
            notes={scratchpad}
            src={sources['scratchpad']}
            onDismiss={handleDismissNote}
          />

          <HousePanel
            rooms={rooms}
            recentThreads={recentThreads}
            recentActions={recentActions}
            roomsSrc={sources['rooms']}
            threadsSrc={sources['recentThreads']}
            onOpenThread={onOpenThread}
          />
        </div>

        {/* RAIL column */}
        <div className="ck-rail">
          <CockpitMaryCard />

          {youHasBody && (
            <YouRailCard you={you} sources={sources} />
          )}

          {houseSystems && (
            <HouseSystemsCard
              systems={houseSystems}
              src={sources['houseSystems']}
            />
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="ck-footer">
        {s && (
          <span className="ck-generated">assembled {formatGenerated(s.generatedAt)}</span>
        )}
        <button
          className={`ck-refresh-btn${refreshing ? ' spinning' : ''}`}
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Refresh the house"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {refreshing ? 'refreshing…' : 'refresh'}
        </button>
        <button
          className={`ck-refresh-btn${reauthoring ? ' spinning' : ''}`}
          onClick={handleReauthor}
          disabled={reauthoring}
          aria-label="Re-author the felt layer now"
          title="Re-run the slow authored pass (hearth, topics, needs-you)"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          {reauthoring ? 'authoring…' : 're-author'}
        </button>
      </div>

      <CockpitStyles />
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Extracted for clarity. Inline because we live in the same scroll container.

function CockpitStyles() {
  return (
    <style>{`
      /* ── Root ── */
      .ck-root {
        margin-top: 2.5rem;
        /* Break out of parent .home-inner's max-width: 34rem.
           Subtract the desktop nav rail (3.25rem) so we don't overflow. */
        width: calc(100vw - 3.25rem - 1.5rem);
        max-width: 72rem;
        position: relative;
        left: 50%;
        transform: translateX(-50%);
      }

      /* ── Hearth band ── */
      .ck-hearth {
        position: relative;
        padding: 1.5rem 2rem;
        background: rgba(201, 168, 124, 0.04);
        border: 1px solid rgba(201, 168, 124, 0.12);
        border-radius: var(--radius-card, 1.125rem);
        margin-bottom: 1.25rem;
        overflow: hidden;
        isolation: isolate;
      }
      .ck-hearth-glow {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: radial-gradient(
          ellipse at 50% 0%,
          rgba(201, 168, 124, 0.08),
          transparent 65%
        );
        z-index: -1;
        pointer-events: none;
      }
      .ck-hearth-stale { opacity: 0.72; }
      .ck-hearth-inner {
        display: flex;
        align-items: flex-start;
        gap: 1.25rem;
      }
      /* Band orb — left edge. Fixed stage so the mood text never shifts;
         the halo (::after, z-index -1) breathes behind it. */
      .ck-hearth-orb {
        flex-shrink: 0;
        width: 3rem;
        display: grid;
        place-items: center;
        padding-top: 0.125rem;
        position: relative;
        isolation: isolate;
      }
      .ck-hearth-content {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        max-width: 56rem;
        min-width: 0;
        flex: 1;
      }
      @media (max-width: 480px) {
        .ck-hearth-inner { gap: 0.875rem; }
        .ck-hearth-orb { width: 2.5rem; }
        .ck-hearth-orb .horb { --orb-d: 32px; }
      }
      .ck-hearth-mood {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 1.125rem;
        font-weight: 500;
        color: var(--amber-bright, #e3c49a);
        line-height: 1.4;
        letter-spacing: -0.005em;
      }
      .ck-hearth-mood-alt {
        color: var(--lavender-bright, #c4b5e3);
      }
      .ck-hearth-thoughts {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.9375rem;
        color: var(--text-secondary, #a09689);
        line-height: 1.6;
      }
      .ck-hearth-artifacts {
        list-style: none;
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.25rem;
      }
      .ck-artifact {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
        padding: 0.4rem 0.75rem;
        background: rgba(201, 168, 124, 0.05);
        border: 1px solid rgba(201, 168, 124, 0.12);
        border-radius: 0.625rem;
        border-left: 2px solid rgba(201, 168, 124, 0.3);
      }
      .ck-artifact-title {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--amber, #c9a87c);
        font-weight: 500;
      }
      .ck-artifact-why {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.75rem;
        color: var(--text-muted, #6a6258);
        line-height: 1.45;
      }
      .ck-needs-user {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        margin-top: 0.25rem;
        padding: 0.4rem 0.75rem;
        background: rgba(168, 147, 192, 0.06);
        border: 1px solid rgba(168, 147, 192, 0.15);
        border-radius: 0.5rem;
        max-width: 36rem;
      }
      .ck-needs-user-pip {
        display: inline-block;
        width: 0.3rem;
        height: 0.3rem;
        border-radius: 50%;
        background: var(--lavender, #a893c0);
        flex-shrink: 0;
        margin-top: 0.35rem;
      }
      .ck-needs-user-text {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.875rem;
        color: var(--lavender-bright, #c4b5e3);
        line-height: 1.5;
      }
      .ck-hearth-ts {
        margin-top: 0.375rem;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.07em;
        color: var(--text-muted, #6a6258);
      }
      .ck-hearth-empty {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.9rem;
        color: var(--text-muted, #6a6258);
      }
      .ck-hearth-stale-badge {
        position: absolute;
        top: 0.75rem;
        right: 0.875rem;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 0.25rem;
        padding: 0.125rem 0.3rem;
      }

      /* ── Cockpit two-column grid ── */
      .ck-cockpit {
        display: grid;
        grid-template-columns: 1fr 18rem;
        gap: 1rem;
        align-items: start;
      }
      @media (max-width: 720px) {
        .ck-cockpit {
          grid-template-columns: 1fr;
        }
        .ck-root {
          /* No left nav rail on mobile (it becomes bottom bar) */
          width: calc(100vw - 2rem);
        }
      }

      /* Phone: tighten padding */
      @media (max-width: 480px) {
        .ck-root {
          width: calc(100vw - 1.25rem);
          margin-top: 1.5rem;
          /* Backstop: prevent any inner element from widening the root */
          overflow-x: clip;
        }
        .ck-hearth {
          padding: 1rem 1rem;
          max-width: 100%;
        }
        .ck-panel-body {
          padding: 0.625rem 0.75rem;
        }
        .ck-hearth-mood {
          font-size: 1rem;
        }
        /* User card + rail panels go full-width on phone */
        .ck-user-card,
        .ck-you-card,
        .ck-systems-card {
          border-radius: 0.75rem;
        }
        /* Rooms: single column on very small screens so minmax never forces width */
        .ck-rooms {
          grid-template-columns: repeat(auto-fill, minmax(0, 1fr));
        }
        /* Needs-you rows: ensure text child cannot bust flex container */
        .ck-need-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* Prevent iOS zoom on focus (base font-size is 15px = below 16px threshold) */
        .ck-user-input {
          font-size: 16px;
        }
      }

      .ck-main {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        min-width: 0;
      }
      .ck-rail {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        min-width: 0;
      }

      /* ── Panel base ── */
      .ck-panel {
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid var(--border, rgba(255,255,255,0.06));
        border-radius: var(--radius-card, 1.125rem);
        overflow: hidden;
      }
      .ck-panel-amber {
        background: rgba(201, 168, 124, 0.025);
        border-color: rgba(201, 168, 124, 0.10);
      }
      .ck-panel-head {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        padding: 0.6rem 1rem 0.5rem;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .ck-panel-label {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.8125rem;
        color: var(--text-secondary, #a09689);
        letter-spacing: 0.005em;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ck-panel-meta {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
      }
      .ck-stale {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 0.2rem;
        padding: 0.1rem 0.25rem;
      }
      .ck-panel-body {
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        min-width: 0;
      }
      .ck-stale-dim { opacity: 0.65; }
      .ck-stale-text {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        margin-top: 0.375rem;
      }

      /* ── Section label ── */
      .ck-section-label {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        margin-bottom: 0.3rem;
      }

      /* ── Empty lines ── */
      .ck-empty-line {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.875rem;
        color: var(--text-muted, #6a6258);
        line-height: 1.5;
      }
      .ck-overflow {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
        color: var(--text-muted, #6a6258);
        letter-spacing: 0.04em;
      }

      /* ── Care chips ── */
      .ck-care-section { margin-bottom: -0.125rem; }
      .ck-care-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
      }
      .ck-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.2rem 0.5rem;
        border-radius: 0.375rem;
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.75rem;
        border: 1px solid transparent;
        transition: border-color var(--tx-color, 150ms);
      }
      .ck-chip-done {
        background: rgba(109, 186, 136, 0.08);
        border-color: rgba(109, 186, 136, 0.16);
        color: var(--status-active, #6dba88);
      }
      .ck-chip-open {
        background: rgba(255,255,255,0.03);
        border-color: rgba(255,255,255,0.06);
        color: var(--text-muted, #6a6258);
      }
      .ck-chip-mark {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
      }

      /* ── Events ── */
      .ck-events {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .ck-event-row {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
        padding: 0.35rem 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .ck-event-row:last-child { border-bottom: none; }
      .ck-event-time {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.6875rem;
        color: var(--text-muted, #6a6258);
        letter-spacing: 0.04em;
        width: 4.25rem;
        flex-shrink: 0;
      }
      .ck-event-title {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.875rem;
        color: var(--text-secondary, #a09689);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ── Tasks ── */
      .ck-tasks { display: flex; flex-direction: column; gap: 0; }
      .ck-task-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.275rem 0;
      }
      .ck-task-pip {
        display: inline-block;
        width: 0.25rem;
        height: 0.25rem;
        border-radius: 50%;
        background: rgba(201, 168, 124, 0.25);
        flex-shrink: 0;
      }
      .ck-task-title {
        flex: 1;
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--text-muted, #6a6258);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ck-task-due {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--text-muted, #6a6258);
        flex-shrink: 0;
        letter-spacing: 0.03em;
      }

      /* ── Mail ── */
      .ck-mail { display: flex; flex-direction: column; gap: 0.125rem; }
      .ck-mail-count {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--amber, #c9a87c);
      }
      .ck-mail-row {
        display: flex;
        flex-direction: column;
        gap: 0.0625rem;
        padding: 0.25rem 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .ck-mail-row:last-child { border-bottom: none; }
      .ck-mail-from {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.04em;
        color: var(--text-muted, #6a6258);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ck-mail-subject {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--text-secondary, #a09689);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ── Themes ── */
      .ck-themes { display: flex; flex-direction: column; gap: 0; }
      .ck-theme-row {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        padding: 0.625rem 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .ck-theme-row:last-child { border-bottom: none; }
      .ck-theme-head {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .ck-theme-topic {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-primary, #e2dbd0);
        flex: 1;
        min-width: 0;
      }
      .ck-theme-meta {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        flex-shrink: 0;
      }
      .ck-theme-room {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--amber-dim, #a08960);
        background: rgba(201, 168, 124, 0.07);
        border: 1px solid rgba(201, 168, 124, 0.12);
        border-radius: 0.25rem;
        padding: 0.1rem 0.3rem;
      }
      .ck-theme-ago {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--text-muted, #6a6258);
        letter-spacing: 0.04em;
      }
      .ck-theme-open {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.07em;
        color: var(--amber, #c9a87c);
        background: none;
        border: 1px solid rgba(201, 168, 124, 0.18);
        border-radius: 0.25rem;
        padding: 0.1rem 0.3rem;
        cursor: pointer;
        transition: border-color var(--tx-color, 150ms), color var(--tx-color, 150ms);
      }
      .ck-theme-open:hover {
        border-color: rgba(201, 168, 124, 0.35);
        color: var(--amber-bright, #e3c49a);
      }
      .ck-theme-note {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.875rem;
        color: var(--text-secondary, #a09689);
        line-height: 1.55;
      }

      /* ── Countdowns ── */
      .ck-countdowns {
        display: flex;
        flex-direction: column;
        border-top: 1px solid rgba(255,255,255,0.04);
        padding-top: 0.5rem;
        gap: 0;
      }
      .ck-countdown-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.625rem;
        padding: 0.4rem 0;
        border-bottom: 1px solid rgba(255,255,255,0.03);
      }
      .ck-countdown-row:last-child { border-bottom: none; }
      .ck-countdown-label {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.875rem;
        color: var(--text-secondary, #a09689);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ck-countdown-right {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
        flex-shrink: 0;
      }
      .ck-countdown-days {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--amber-dim, #a08960);
      }
      .ck-countdown-days.today { color: var(--amber-bright, #e3c49a); }
      .ck-countdown-days.soon { color: var(--amber, #c9a87c); }
      .ck-countdown-when {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
        color: var(--text-muted, #6a6258);
        letter-spacing: 0.03em;
      }

      /* ── Needs You ── */
      .ck-needs-list { display: flex; flex-direction: column; gap: 0.5rem; }
      .ck-need-row {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
      }
      .ck-need-tag {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        padding: 0.175rem 0.35rem;
        border-radius: 0.25rem;
        flex-shrink: 0;
        margin-top: 0.1rem;
        border: 1px solid transparent;
      }
      .ck-need-tag-decision {
        background: rgba(201, 168, 124, 0.10);
        border-color: rgba(201, 168, 124, 0.2);
        color: var(--amber, #c9a87c);
      }
      .ck-need-tag-notice {
        background: rgba(168, 147, 192, 0.08);
        border-color: rgba(168, 147, 192, 0.18);
        color: var(--lavender, #a893c0);
      }
      .ck-need-text {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.875rem;
        color: var(--text-secondary, #a09689);
        line-height: 1.5;
        flex: 1;
        min-width: 0;
        word-break: break-word;
      }

      /* ── House rooms ── */
      .ck-rooms {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
        gap: 0.375rem;
      }
      .ck-room {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.375rem;
        padding: 0.4rem 0.625rem;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 0.5rem;
        transition: border-color var(--tx-color, 150ms);
        min-width: 0;
      }
      .ck-room:hover { border-color: rgba(255,255,255,0.10); }
      .ck-room-daily {
        border-color: rgba(201, 168, 124, 0.12);
        background: rgba(201, 168, 124, 0.025);
      }
      .ck-room-name {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--text-secondary, #a09689);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
      }
      .ck-room-threads {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
        color: var(--text-muted, #6a6258);
        flex-shrink: 0;
      }

      /* ── Recent threads ── */
      .ck-recent-threads { display: flex; flex-direction: column; gap: 0; }
      .ck-recent-thread-row {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        padding: 0.3rem 0;
        border-bottom: 1px solid rgba(255,255,255,0.03);
      }
      .ck-recent-thread-row:last-child { border-bottom: none; }
      .ck-recent-thread-btn {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--amber, #c9a87c);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        text-align: left;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        transition: color var(--tx-color, 150ms);
      }
      .ck-recent-thread-btn:hover { color: var(--amber-bright, #e3c49a); }
      .ck-recent-thread-room {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--text-muted, #6a6258);
        letter-spacing: 0.04em;
        flex-shrink: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 7rem;
      }
      .ck-recent-thread-ago {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--text-muted, #6a6258);
        flex-shrink: 0;
      }

      /* ── Recent actions ── */
      .ck-recent-actions { display: flex; flex-direction: column; gap: 0; }
      .ck-action-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0;
        border-bottom: 1px solid rgba(255,255,255,0.03);
      }
      .ck-action-row:last-child { border-bottom: none; }
      .ck-action-pip {
        display: inline-block;
        width: 0.3125rem;
        height: 0.3125rem;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .ck-action-pip.ok { background: var(--status-active, #6dba88); }
      .ck-action-pip.err { background: #c0524a; }
      .ck-action-summary {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.75rem;
        color: var(--text-muted, #6a6258);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ck-action-ago {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5rem;
        color: var(--text-muted, #6a6258);
        flex-shrink: 0;
      }

      /* ── Rail: User's card ── */
      .ck-user-card {
        background: rgba(168, 147, 192, 0.04);
        border: 1px solid rgba(168, 147, 192, 0.10);
        border-radius: var(--radius-card, 1.125rem);
        padding: 0.625rem 0.875rem 0.75rem;
        position: relative;
        isolation: isolate;
      }
      .ck-rail-label {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.75rem;
        color: var(--text-secondary, #a09689);
        margin-bottom: 0.5rem;
        letter-spacing: 0.005em;
      }
      .ck-user-hint {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.8125rem;
        color: var(--text-muted, #6a6258);
        padding-bottom: 0.375rem;
      }
      .ck-user-rows { display: flex; flex-direction: column; }
      .ck-user-row {
        display: flex;
        align-items: baseline;
        gap: 0.625rem;
        padding: 0.35rem 0;
        border-bottom: 1px solid rgba(168, 147, 192, 0.06);
      }
      .ck-user-row:last-child { border-bottom: none; }
      .ck-user-label {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        width: 3.5rem;
        flex-shrink: 0;
      }
      .ck-user-row.filled .ck-user-label { color: var(--lavender-dim, #8a78a0); }
      .ck-user-value {
        flex: 1;
        display: inline-flex;
        align-items: baseline;
        gap: 0.3rem;
        cursor: text;
        min-width: 0;
        overflow: hidden;
      }
      .ck-user-value-text {
        color: var(--lavender-bright, #c4b5e3);
        font-size: 0.8125rem;
        line-height: 1.5;
        word-break: break-word;
      }
      .ck-user-clear {
        opacity: 0;
        color: var(--text-muted, #6a6258);
        font-size: 0.875rem;
        flex-shrink: 0;
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        transition: opacity var(--tx-color, 150ms), color var(--tx-color, 150ms);
      }
      .ck-user-value:hover .ck-user-clear { opacity: 0.6; }
      .ck-user-clear:hover { color: rgba(210, 140, 130, 0.95); opacity: 1; }
      .ck-user-add {
        flex: 1;
        text-align: left;
        color: rgba(106, 98, 88, 0.5);
        font-size: 0.8125rem;
        font-family: var(--font-body, 'Inter', sans-serif);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        transition: color var(--tx-color, 150ms);
      }
      .ck-user-row:hover .ck-user-add { color: var(--text-muted, #6a6258); }
      .ck-user-input {
        flex: 1;
        min-width: 0;
        background: rgba(168,147,192,0.06);
        border: 1px solid rgba(168, 147, 192, 0.28);
        border-radius: 0.35rem;
        color: var(--lavender-bright, #c4b5e3);
        font-size: 0.8125rem;
        font-family: var(--font-body, 'Inter', sans-serif);
        padding: 0.25rem 0.4rem;
        outline: none;
        resize: vertical;
      }
      .ck-user-input:focus {
        border-color: var(--lavender, #a893c0);
        box-shadow: 0 0 0 2px rgba(168,147,192,0.10);
      }
      .ck-user-ts {
        margin-top: 0.5rem;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5rem;
        letter-spacing: 0.06em;
        color: var(--text-muted, #6a6258);
      }

      .ck-user-err {
        margin-top: 0.5rem;
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.72rem;
        color: rgba(210, 140, 130, 0.85);
      }

      /* ── Rail: You card ── */
      .ck-you-card {
        background: rgba(168, 147, 192, 0.03);
        border: 1px solid rgba(168, 147, 192, 0.08);
        border-radius: var(--radius-card, 1.125rem);
        padding: 0.625rem 0.875rem 0.75rem;
      }
      .ck-you-mood {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin-bottom: 0.375rem;
      }
      .ck-you-mood-pip {
        display: inline-block;
        width: 0.3rem;
        height: 0.3rem;
        border-radius: 50%;
        background: var(--lavender, #a893c0);
        flex-shrink: 0;
      }
      .ck-you-mood-text {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.875rem;
        color: var(--lavender-bright, #c4b5e3);
        line-height: 1.4;
      }
      .ck-you-body { display: flex; flex-direction: column; gap: 0; }
      .ck-you-row {
        display: flex;
        align-items: baseline;
        gap: 0.625rem;
        padding: 0.3rem 0;
        border-bottom: 1px solid rgba(168, 147, 192, 0.06);
      }
      .ck-you-row:last-child { border-bottom: none; }
      .ck-you-key {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        width: 3rem;
        flex-shrink: 0;
      }
      .ck-you-val {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--lavender-bright, #c4b5e3);
        flex: 1;
      }

      /* ── Rail: House systems card ── */
      .ck-systems-card {
        background: rgba(255, 255, 255, 0.015);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: var(--radius-card, 1.125rem);
        padding: 0.625rem 0.875rem 0.75rem;
      }
      .ck-systems-warn {
        display: inline-block;
        margin-left: 0.3rem;
        width: 0.35rem;
        height: 0.35rem;
        border-radius: 50%;
        background: #d4a843;
        vertical-align: middle;
      }
      .ck-mcp-list {
        display: flex;
        flex-direction: column;
        gap: 0.1875rem;
      }
      .ck-mcp-row {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        padding: 0.3rem 0.4rem;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.04);
        border-radius: 0.375rem;
      }
      .ck-mcp-pip {
        display: inline-block;
        width: 0.3rem;
        height: 0.3rem;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .ck-mcp-name {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
        color: var(--text-secondary, #a09689);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        letter-spacing: 0.02em;
      }
      .ck-mcp-tools {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--text-muted, #6a6258);
        flex-shrink: 0;
      }
      .ck-mcp-status {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        flex-shrink: 0;
      }
      .ck-organs-details {
        margin-top: 0.5rem;
        border-top: 1px solid rgba(255,255,255,0.04);
        padding-top: 0.375rem;
      }
      .ck-organs-summary {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        cursor: pointer;
        list-style: none;
        user-select: none;
        padding: 0.125rem 0;
        transition: color var(--tx-color, 150ms);
      }
      .ck-organs-summary::-webkit-details-marker { display: none; }
      .ck-organs-summary:hover { color: var(--text-secondary, #a09689); }
      .ck-organs-rows {
        display: flex;
        flex-direction: column;
        gap: 0;
        margin-top: 0.375rem;
      }
      .ck-organ-row {
        display: flex;
        align-items: baseline;
        gap: 0.625rem;
        padding: 0.275rem 0;
        border-bottom: 1px solid rgba(255,255,255,0.03);
      }
      .ck-organ-row:last-child { border-bottom: none; }
      .ck-organ-key {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        width: 4rem;
        flex-shrink: 0;
      }
      .ck-organ-val {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--text-secondary, #a09689);
        flex: 1;
        letter-spacing: 0.03em;
      }

      /* ── Scratchpad notes ── */
      .ck-scratch-list {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .ck-scratch-note {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.625rem 0;
        border-bottom: 1px solid rgba(201, 168, 124, 0.07);
        transition: opacity 160ms var(--ease, cubic-bezier(0.25,0.46,0.45,0.94));
      }
      .ck-scratch-note:last-child { border-bottom: none; }
      .ck-scratch-dismissing { opacity: 0.35; pointer-events: none; }
      .ck-scratch-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }
      .ck-scratch-text {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.9375rem;
        color: var(--text-primary, #e2dbd0);
        line-height: 1.65;
        word-break: break-word;
        white-space: pre-wrap;
        margin: 0;
      }
      .ck-scratch-meta {
        display: flex;
        align-items: center;
        gap: 0.3rem;
      }
      .ck-scratch-by {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--amber-dim, #a08960);
      }
      .ck-scratch-dot {
        display: inline-block;
        width: 0.2rem;
        height: 0.2rem;
        border-radius: 50%;
        background: var(--text-muted, #6a6258);
        flex-shrink: 0;
      }
      .ck-scratch-ago {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.04em;
        color: var(--text-muted, #6a6258);
      }
      .ck-scratch-dismiss {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.25rem;
        height: 1.25rem;
        border-radius: 0.25rem;
        background: none;
        border: 1px solid transparent;
        color: var(--text-muted, #6a6258);
        font-size: 0.875rem;
        line-height: 1;
        cursor: pointer;
        opacity: 0;
        transition: opacity var(--tx-color, 150ms), color var(--tx-color, 150ms), border-color var(--tx-color, 150ms);
        margin-top: 0.125rem;
      }
      .ck-scratch-note:hover .ck-scratch-dismiss { opacity: 0.5; }
      .ck-scratch-dismiss:hover {
        opacity: 1;
        color: rgba(210, 140, 130, 0.9);
        border-color: rgba(210, 140, 130, 0.2);
      }
      .ck-scratch-dismiss:disabled { cursor: not-allowed; }

      /* ── Footer ── */
      .ck-footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 1.25rem;
        padding-bottom: 1rem;
      }
      .ck-generated {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
      }
      .ck-refresh-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
        letter-spacing: 0.05em;
        color: var(--text-muted, #6a6258);
        padding: 0.3rem 0.5625rem;
        border-radius: var(--radius-sm, 0.5rem);
        border: 1px solid rgba(255,255,255,0.06);
        background: transparent;
        cursor: pointer;
        transition:
          color var(--tx-color, 150ms),
          border-color var(--tx-color, 150ms),
          transform var(--tx-press, 100ms);
      }
      .ck-refresh-btn:hover:not(:disabled) {
        color: var(--text-secondary, #a09689);
        border-color: rgba(255,255,255,0.12);
      }
      .ck-refresh-btn:active:not(:disabled) {
        transform: scale(0.985) translateY(0.5px);
      }
      .ck-refresh-btn:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .ck-refresh-btn.spinning svg {
        animation: ck-spin 1s linear infinite;
      }
      @keyframes ck-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }

      /* ── Error ── */
      .ck-error { padding: 1.5rem 0; }
    `}</style>
  );
}
