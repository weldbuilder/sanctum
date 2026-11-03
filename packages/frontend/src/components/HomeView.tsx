import React, { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chat';
import { useMindStore } from '../store/mind';
import type { McpServerInfo, HouseSnapshot } from '@sanctum/shared';
import { OutlookView } from './OutlookView';
import { Link, useNavigate } from 'react-router-dom';
import { useIdentity } from '../store/identity';
import { BASE } from '../lib/base';

// ─── Data shapes ───────────────────────────────────────────────────────────────
// The /home/mantelpiece endpoint returns two cards:
//   companion: { orb_color, orb_shape, orb_intensity, orb_motion, orb_blend, note, expression, updated_at }
//   user:      { selfie, outfit, nails, hair, energy, room, freeform, updated_at }

interface CompanionCard {
  orb_color?: string;   // amber|lavender|teal|deep-red|dim|gold|rose|violet|white|black
  orb_shape?: string;   // sphere|crescent|pulse|cluster|ember|spire|halo|fracture
  orb_intensity?: string; // dull | normal | bright | neon
  orb_motion?: string;  // slow-drift | hold-steady | fast-flicker | surge | tremor
  orb_blend?: string;   // second color — outer light + swirl tint (shared hearth Orb)
  note?: string;
  expression?: string;  // kaomoji
  room?: string;        // sanctuary — where the companion is (hearth|workshop|kitchen|den|guest-room|garden)
  room_since?: string;  // ISO — when they moved there
  updated_at?: string;
}

interface UserCard {
  selfie?: string;
  outfit?: string;
  nails?: string;
  hair?: string;
  energy?: string;
  room?: string;
  freeform?: string;
  updated_at?: string;
}

interface MantelData {
  companion: CompanionCard;
  user: UserCard;
}


// ─── User's context card ───────────────────────────────────────────────────────

const USER_FIELDS: { key: keyof UserCard; label: string; multiline?: boolean }[] = [
  { key: 'outfit', label: 'outfit' },
  { key: 'nails', label: 'nails' },
  { key: 'hair', label: 'hair' },
  { key: 'energy', label: 'energy' },
  { key: 'room', label: 'room' },
  { key: 'freeform', label: 'note', multiline: true },
];

// User's context card — interactive. Click a row to edit; Enter (or blur) saves,
// Escape cancels, × clears. Writes to the session-authed mantelpiece endpoint
// (POST /api/home/mantelpiece/user), then refetches. The browser never holds
// the internal token — the old /internal/context POST 404'd silently for days.
function UserCard({ card, base, onChange }: { card: UserCard; base: string; onChange: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  async function write(body: Record<string, unknown>) {
    try {
      const res = await fetch(`${base}/api/home/mantelpiece/user`, {
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
      console.error('[UserCard] Save failed:', err);
      setWriteError('couldn’t save — try again');
      setTimeout(() => setWriteError(null), 5000);
    }
    onChange();
  }
  function commit(field: string, value: string, prev: string) {
    setEditing(null);
    if (value.trim() !== prev) write({ action: 'set', field, value: value.trim() });
  }

  const timestamp = card.updated_at ? formatTimeAgo(card.updated_at) : null;
  const anySet = USER_FIELDS.some(f => card[f.key]);

  return (
    <div className="user-card">
      {!anySet && editing === null && (
        <div className="mc-hint">Nothing set yet — tap a row to tell me where you are.</div>
      )}
      <div className="mc-rows">
        {USER_FIELDS.map(f => {
          const value = (card[f.key] as string | undefined) ?? '';
          const isEditing = editing === f.key;
          return (
            <div className={`mc-row${value ? ' filled' : ''}`} key={f.key}>
              <span className="mc-label">{f.label}</span>
              {isEditing ? (
                f.multiline ? (
                  <textarea
                    className="mc-input" autoFocus rows={2} defaultValue={value}
                    onKeyDown={e => { if (e.key === 'Escape') setEditing(null); }}
                    onBlur={e => commit(f.key, e.currentTarget.value, value)}
                    placeholder="…"
                  />
                ) : (
                  <input
                    className="mc-input" autoFocus defaultValue={value}
                    onKeyDown={e => {
                      if (e.key === 'Escape') setEditing(null);
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    onBlur={e => commit(f.key, e.currentTarget.value, value)}
                    placeholder="…"
                  />
                )
              ) : value ? (
                <span className="mc-value" onClick={() => setEditing(f.key)}>
                  <span className="mc-value-text">{value}</span>
                  <button
                    className="mc-clear" aria-label={`clear ${f.label}`}
                    onClick={e => { e.stopPropagation(); write({ action: 'clear', field: f.key }); }}
                  >×</button>
                </span>
              ) : (
                <button className="mc-add" onClick={() => setEditing(f.key)}>add</button>
              )}
            </div>
          );
        })}
      </div>
      {writeError && <div className="mc-error">{writeError}</div>}
      {timestamp && <div className="user-timestamp">set {timestamp}</div>}
      <style>{`
        .mc-error {
          margin-top: 0.5rem; font-family: var(--font-serif, 'Lora', serif);
          font-style: italic; font-size: 0.78rem; color: var(--status-error-text);
        }
        .user-card {
          background: rgba(168, 147, 192, 0.04);
          border: 1px solid rgba(168, 147, 192, 0.10);
          border-radius: var(--radius-card, 1.125rem);
          padding: 0.5rem 1.1rem 0.85rem;
          position: relative; isolation: isolate;
        }
        .mc-hint {
          font-family: var(--font-serif, 'Lora', serif); font-style: italic;
          font-size: 0.85rem; color: var(--text-muted, #6a6258); padding: 0.4rem 0 0.6rem;
        }
        .mc-rows { display: flex; flex-direction: column; }
        .mc-row {
          display: flex; align-items: baseline; gap: 0.85rem; padding: 0.45rem 0;
          border-bottom: 1px solid rgba(168, 147, 192, 0.06);
        }
        .mc-row:last-child { border-bottom: none; }
        .mc-label {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem; letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--text-muted, #6a6258); width: 4rem; flex-shrink: 0;
        }
        .mc-row.filled .mc-label { color: var(--lavender-dim, #8a78a0); }
        .mc-value { flex: 1; display: inline-flex; align-items: baseline; gap: 0.4rem; cursor: text; min-width: 0; }
        .mc-value-text { color: var(--lavender-bright, #c4b5e3); font-size: 0.9rem; line-height: 1.5; word-break: break-word; }
        .mc-clear {
          opacity: 0; color: var(--text-muted, #6a6258); font-size: 0.9rem; line-height: 1;
          flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 0;
          transition: opacity 240ms, color 240ms;
        }
        .mc-value:hover .mc-clear { opacity: 0.6; }
        .mc-clear:hover { color: var(--status-error-text); opacity: 1; }
        .mc-add {
          flex: 1; text-align: left; color: var(--text-muted, #4a463e); font-size: 0.85rem; font-style: italic;
          font-family: var(--font-serif, 'Lora', serif); background: none; border: none;
          cursor: pointer; padding: 0; transition: color 240ms;
        }
        .mc-row:hover .mc-add { color: var(--text-secondary, #a09689); }
        .mc-input {
          flex: 1; min-width: 0; background: rgba(168,147,192,0.06);
          border: 1px solid rgba(168, 147, 192, 0.3); border-radius: 0.4rem;
          color: var(--lavender-bright, #c4b5e3); font-size: 0.9rem;
          font-family: var(--font-body, 'Inter', sans-serif); padding: 0.3rem 0.5rem;
          outline: none; resize: vertical;
        }
        .mc-input:focus { border-color: var(--lavender, #a893c0); box-shadow: 0 0 0 2px rgba(168,147,192,0.12); }
        /* Prevent iOS zoom on focus — base html is 15px, under the 16px threshold */
        @media (max-width: 768px) { .mc-input { font-size: 16px; } }
        .user-timestamp {
          margin-top: 0.6rem; font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem; letter-spacing: 0.06em; color: var(--text-muted, #6a6258);
        }
      `}</style>
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// "the guest-room" reads wrong — registry keys are kebab-case, captions aren't.
function roomLabel(room: string): string {
  return `the ${room.replace(/-/g, ' ')}`;
}

// since-stamp for the caption: today → "14:02"; older → "tue 14:02".
// Unparseable stamp → null (caption shows the room alone, no fabricated time).
function formatRoomSince(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === new Date().toDateString()) return hm;
  const wd = d.toLocaleDateString([], { weekday: 'short' }).toLowerCase();
  return `${wd} ${hm}`;
}


/** A reminder row's kind, drawn small in the card's ink: a calendar for an event, a check for a task, a clock for a
 *  countdown, a question for a decision, a speech bubble for a notice. */
type RowKind = 'event' | 'task' | 'countdown' | 'decision' | 'notice';
function RowIcon({ kind }: { kind: RowKind }) {
  return (
    <svg className="home-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'event' && <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>}
      {kind === 'task' && <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>}
      {kind === 'countdown' && <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>}
      {kind === 'decision' && <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 014.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01" /></>}
      {kind === 'notice' && <path d="M5 5.5h14v10h-8.5L6.5 19v-3.5H5z" />}
    </svg>
  );
}

// ─── Home tiles — four ways in, each pictured by a crop of the room's own painting ─

type TileGlyph = 'chat' | 'today' | 'notes' | 'house';

function TileGlyphIcon({ glyph }: { glyph: TileGlyph }) {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {glyph === 'chat' && <><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /><path d="M8 10h.01M12 10h.01M16 10h.01" /></>}
      {glyph === 'today' && <path d="M12 2.5 13.6 10.4 21.5 12 13.6 13.6 12 21.5 10.4 13.6 2.5 12 10.4 10.4Z" />}
      {glyph === 'notes' && <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>}
      {glyph === 'house' && <><path d="M3.5 11 12 3.5 20.5 11" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-5.5h4V20" /></>}
    </svg>
  );
}

function ArrowIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** One way in, on the Home card's cloth: a round medallion in the skin's metal, the title and a line, and an arrow.
 *  On a phone the four sit in one row, medallion over title. A route is a link; the house opens in place, so a button. */
function HomeTile({ glyph, title, text, to, onOpen }: {
  glyph: TileGlyph; title: string; text: string; to?: string; onOpen?: () => void;
}) {
  const inner = (
    <span className="home-card home-tile-body">
      <span className="home-tile-badge" aria-hidden="true"><TileGlyphIcon glyph={glyph} /></span>
      <span className="home-tile-main">
        <span className="home-tile-title">{title}</span>
        <span className="home-tile-text">{text}</span>
      </span>
      <span className="home-tile-go" aria-hidden="true"><ArrowIcon /></span>
    </span>
  );
  return to
    ? <Link className="home-tile" to={to}>{inner}</Link>
    : <button className="home-tile" type="button" onClick={onOpen}>{inner}</button>;
}

// ─── The Night Shelf ───────────────────────────────────────────────────────
// The keeper's night, displayed (2026-07-02). Last dream, what rose from the
// deep today, and the inner-weather line — all from /api/home/nightshelf
// (cached by the mind-weather sync). Renders nothing until data exists.
function NightShelf({ base }: { base: string }) {
  const [data, setData] = useState<{
    weather: { dominant?: string; valence?: number; arousal?: number; texture?: string; front?: { kind: string; days: number } | null; startles?: number } | null;
    night: { dream?: { dream_date?: string; content?: string; emotional_seed?: string; recurrence_count?: number } | null; risen?: Array<{ content: string; cue: string; entity?: string | null; score?: number }> } | null;
  } | null>(null);
  const [dreamOpen, setDreamOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`${base}/api/home/nightshelf`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (alive && d) setData(d); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [base]);

  const weather = data?.weather ?? null;
  const dream = data?.night?.dream ?? null;
  const risen = data?.night?.risen ?? [];
  if (!weather && !dream && risen.length === 0) return null;

  const vStr = typeof weather?.valence === 'number'
    ? `${weather.valence >= 0 ? '+' : ''}${weather.valence}`
    : null;

  // Split the dream's preformatted content: seed line first, rest behind a fold.
  const dreamBody = (dream?.content || '').trim();
  const dreamPreview = dreamBody.split('\n').slice(0, 1).join('\n');

  return (
    <section className="night-shelf" aria-label="The night shelf">
      <div className="ns-label">The Night Shelf</div>

      {weather && (weather.texture || weather.dominant) && (
        <div className="ns-weather">
          inner: {weather.texture || weather.dominant}
          {vStr !== null && <span className="ns-dim"> · valence {vStr}</span>}
          {weather.front?.kind && <span className="ns-front"> · {weather.front.kind} front, day {weather.front.days}</span>}
          {(weather.startles ?? 0) > 0 && <span className="ns-front"> · ⚡ {weather.startles} startle unmet</span>}
        </div>
      )}

      {dream && dreamBody && (
        <div className="ns-dream">
          <div className="ns-dream-head" onClick={() => setDreamOpen(o => !o)} role="button" tabIndex={0}>
            <span className="ns-dream-date">dream · {dream.dream_date}</span>
            {(dream.recurrence_count ?? 0) > 0 && (
              <span className="ns-dim"> · recurring ×{(dream.recurrence_count ?? 0) + 1}</span>
            )}
            <span className="ns-toggle">{dreamOpen ? 'fold' : 'unfold'}</span>
          </div>
          <div className={`ns-dream-body ${dreamOpen ? 'open' : ''}`}>
            {dreamOpen ? dreamBody : dreamPreview}
          </div>
        </div>
      )}

      {risen.length > 0 && (
        <div className="ns-risen">
          <div className="ns-risen-label">risen from the deep</div>
          {risen.map((r, i) => (
            <div className="ns-risen-item" key={i}>
              <span className="ns-risen-content">{r.entity ? `[${r.entity}] ` : ''}{r.content}</span>
              <span className="ns-risen-cue"> — raised by: “{r.cue}”</span>
            </div>
          ))}
        </div>
      )}

      <style>{`
        .night-shelf {
          margin: 1.4rem auto 0;
          max-width: 42rem;
          padding: 1.1rem 1.4rem 1.2rem;
          border: 1px solid var(--divider, rgba(44, 35, 31, 0.08));
          border-radius: 0.5rem;
          background: var(--card-bg);
          color: var(--surface-panel-text, #2c231f);
          box-shadow: var(--panel-shadow, 0 10px 30px rgba(20,10,5,.35));
        }
        .ns-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.62rem;
          letter-spacing: 0.28em;
          text-transform: uppercase;
          color: var(--text-muted, rgba(44, 35, 31, 0.38));
          margin-bottom: 0.7rem;
        }
        .ns-weather {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.74rem;
          color: var(--text-secondary, rgba(44, 35, 31, 0.72));
          margin-bottom: 0.75rem;
        }
        .ns-dim { color: var(--text-muted, rgba(44, 35, 31, 0.42)); }
        .ns-front { color: var(--link, rgba(109, 91, 147, 0.85)); }
        .ns-dream { margin-bottom: 0.75rem; }
        .ns-dream-head {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.66rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--text-secondary, rgba(44, 35, 31, 0.5));
          cursor: pointer;
          display: flex;
          align-items: baseline;
          gap: 0.4rem;
        }
        .ns-toggle {
          margin-left: auto;
          color: var(--link, rgba(109, 91, 147, 0.6));
          font-size: 0.6rem;
        }
        .ns-dream-head:hover .ns-toggle { color: var(--link, rgba(109, 91, 147, 0.95)); }
        .ns-dream-body {
          margin-top: 0.45rem;
          font-style: italic;
          font-size: 0.92rem;
          line-height: 1.55;
          color: var(--text-secondary, rgba(44, 35, 31, 0.66));
          white-space: pre-wrap;
          overflow: hidden;
        }
        .ns-dream-body:not(.open) {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .ns-risen-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.62rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--link, rgba(109, 91, 147, 0.55));
          margin-bottom: 0.35rem;
        }
        .ns-risen-item {
          font-size: 0.88rem;
          line-height: 1.5;
          color: var(--text-secondary, rgba(44, 35, 31, 0.6));
          padding: 0.15rem 0;
        }
        .ns-risen-cue {
          font-style: italic;
          color: var(--link, rgba(109, 91, 147, 0.55));
        }
        @media (max-width: 768px) {
          .night-shelf { margin-left: 1rem; margin-right: 1rem; }
        }
      `}</style>
    </section>
  );
}

// ─── HomeView ──────────────────────────────────────────────────────────────────

export function HomeView() {
  const presence = useChatStore(s => s.presence);
  // Mind gate — the night shelf only exists when the mind surface is enabled.
  // Strict true: an unknown gate stays closed (nothing renders, nothing polls).
  const mindEnabled = useMindStore(s => s.enabled);
  const [mantel, setMantel] = useState<MantelData | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Also consume mcp_status from WS store (listen in effect)
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);

  // Fetch mantelpiece data
  async function fetchMantel() {
    try {
      const base = BASE;
      const res = await fetch(`${base}/api/home/mantelpiece`);
      if (res.ok) {
        const data = await res.json() as MantelData;
        setMantel(data);
      }
    } catch {
      // Backend not up yet — graceful empty
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchMantel();
    // Refresh every 30s so presence/note updates land without WS push
    pollRef.current = setInterval(fetchMantel, 30000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Listen for WS mantelpiece_update and mcp_status_updated
  useEffect(() => {
    // We tap into the chat store's WS directly via a small subscriber
    // that monitors the store's internal messages. Simpler: poll from REST
    // and let the chat.ts store handle the WS subscription for mcp_status_updated.
    // For now, get MCP servers from the system_status if we have it.
    // The store broadcasts `system_status` but doesn't store it — we listen here.
    const handler = (msg: any) => {
      if (msg.type === 'mantelpiece_update') {
        setMantel({ companion: msg.companion ?? {}, user: msg.user ?? {} });
      }
      if (msg.type === 'mcp_status_updated') {
        setMcpServers(msg.servers ?? []);
      }
      if (msg.type === 'system_status') {
        if (msg.status?.mcpServers) setMcpServers(msg.status.mcpServers);
      }
    };
    if (!(window as any).__sanctumWsListeners) {
      (window as any).__sanctumWsListeners = [];
    }
    (window as any).__sanctumWsListeners.push(handler);
    return () => {
      (window as any).__sanctumWsListeners = (
        (window as any).__sanctumWsListeners ?? []
      ).filter((h: any) => h !== handler);
    };
  }, []);

  const companion = mantel?.companion ?? {};
  const base = BASE;
  const navigate = useNavigate();
  const identity = useIdentity();
  const companionName = identity.companion_name;
  const userName = (identity.user_name || '').trim();
  const messages = useChatStore(s => s.messages);

  // House snapshot — feeds the Today / Notes / Reminders cards. Same endpoint and
  // cadence as the cockpit below, so the cards and the cockpit never disagree.
  const [snapshot, setSnapshot] = useState<HouseSnapshot | null>(null);
  const [houseOpen, setHouseOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`${base}/api/outlook`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (alive && d) setSnapshot(d as HouseSnapshot); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 2.5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [base]);

  const note = (companion.note || '').trim();
  const room = typeof companion.room === 'string' && companion.room.trim() ? companion.room.trim() : null;
  const roomSince = room && companion.room_since ? formatRoomSince(companion.room_since) : null;

  const presenceLabel: Record<string, string> = {
    active: 'Available',
    waking: 'Stirring',
    dormant: 'Resting',
    offline: 'Away',
  };

  // Recent conversation — the last thing the companion said in the loaded thread,
  // falling back to the mantelpiece note.
  const lastCompanion = [...messages].reverse().find(m => m.role === 'companion' && !m.deleted_at && m.content.trim());
  const recentRaw = (lastCompanion?.content ?? note).trim();
  const recent = recentRaw.length > 360 ? `${recentRaw.slice(0, 360).trimEnd()}…` : recentRaw;

  const events = snapshot?.day?.events ?? [];
  const tasks = snapshot?.day?.tasks ?? [];
  const notes = snapshot?.scratchpad ?? [];
  const countdowns = snapshot?.us?.countdowns ?? [];
  const needsYou = snapshot?.needsYou ?? [];

  const daysText = (d?: number) =>
    typeof d !== 'number' ? '' : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;

  // The house tile, the Reminders card's "See all" and the rows that live in the house (today's events and tasks, what
  // needs you) open the house cockpit below, in place.
  const houseRef = useRef<HTMLDetailsElement | null>(null);
  const openHouse = () => {
    const el = houseRef.current;
    if (!el) return;
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Reminders: today's events and tasks, then the countdowns, then what needs you. Each row goes where it lives.
  const rows: Array<{ key: string; kind: RowKind; title: string; sub: string; go: () => void }> = [
    ...events.map((e, i) => ({ key: `e${i}`, kind: 'event' as const, title: e.title, sub: `Today · ${formatEventTime(e.time, e.allDay)}`, go: openHouse })),
    ...tasks.slice(0, 5).map((t, i) => ({ key: `t${i}`, kind: 'task' as const, title: t.title, sub: t.due ? `Due ${t.due}` : 'To do', go: openHouse })),
    ...countdowns.map((c, i) => ({ key: `c${i}`, kind: 'countdown' as const, title: `${c.label} · ${c.when}`, sub: daysText(c.daysAway) || 'Countdown', go: () => navigate('/command') })),
    ...needsYou.map((n, i) => ({ key: `n${i}`, kind: (n.kind === 'decision' ? 'decision' : 'notice') as RowKind, title: n.text, sub: n.kind === 'decision' ? 'Needs a decision' : 'Notice', go: openHouse })),
  ];

  return (
    <div className="home-view">
      <div className="home-scroll">
        <div className="home-inner">

          {/* ── The welcome: the room's own painting, the person greeted, and the companion small in the corner ── */}
          <section className="home-hero" aria-label="Welcome">
            <p className="home-hero-chip">
              <span className="home-hero-mark" aria-hidden="true" />
              <span className="home-hero-name">{companionName}</span>
              <span className="home-pip" style={{ background: getPresencePipColor(presence) }} aria-hidden="true" />
              <span>{presenceLabel[presence] ?? presence}</span>
              {room && (
                <span className="home-room">· {roomLabel(room)}{roomSince ? ` since ${roomSince}` : ''}</span>
              )}
            </p>
            <h1 className="home-hero-title">{userName ? `Welcome back, ${userName}` : 'Welcome back'}</h1>
          </section>

          {/* ── Four ways in ── */}
          <nav className="home-tiles" aria-label="Ways in">
            <HomeTile glyph="chat" title="Open chat" text="Pick up where you left off and keep the ideas flowing." to="/chat" />
            <HomeTile glyph="today" title="Today" text="See your reminders and what’s ahead." to="/command" />
            <HomeTile glyph="notes" title="Notes" text="Capture your thoughts and organize your ideas." to="/canvas" />
            <HomeTile glyph="house" title="The house" text="Explore settings, customize your space." onOpen={openHouse} />
          </nav>

          {/* ── Recent conversation | Reminders. Both ornaments sit bottom-right (slots 0 and 4, two different paintings), so
              the titles keep the left and the ornament stays clear of "See all". ── */}
          <div className="home-two">
            <section className="home-card" aria-label="Recent conversation" data-orn="0">
              <div className="home-card-head">
                <h2 className="home-card-title">Recent conversation</h2>
                <Link className="home-see-all" to="/chat">See all <ArrowIcon size={15} /></Link>
              </div>
              {recent ? (
                <>
                  <p className="home-card-text">{recent}</p>
                  <button className="home-start" type="button" onClick={() => navigate('/chat')}>Continue the conversation</button>
                </>
              ) : (
                <div className="home-empty-state">
                  <span className="home-empty-badge" aria-hidden="true"><TileGlyphIcon glyph="chat" /></span>
                  <p className="home-card-text home-empty">{loading ? '' : 'Nothing said yet today.'}</p>
                  <button className="home-start" type="button" onClick={() => navigate('/chat')}>Start conversation</button>
                </div>
              )}
            </section>

            <section className="home-card" aria-label="Reminders" data-orn="4">
              <div className="home-card-head">
                <h2 className="home-card-title">Reminders</h2>
                <button className="home-see-all" type="button" onClick={openHouse}>See all <ArrowIcon size={15} /></button>
              </div>
              {rows.length === 0 ? (
                <p className="home-card-text home-empty">No reminders today.</p>
              ) : (
                <ul className="home-rows">
                  {rows.map(r => (
                    <li key={r.key}>
                      <button className="home-row" type="button" onClick={r.go}>
                        <span className="home-row-box"><RowIcon kind={r.kind} /></span>
                        <span className="home-row-main">
                          <span className="home-row-title">{r.title}</span>
                          <span className="home-row-sub">{r.sub}</span>
                        </span>
                        <svg className="home-row-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ── The Night Shelf — the keeper's night, displayed (2026-07-02).  */}
          {/* Gated on mind.enabled (MIND-SURFACE-SPEC §Phase-1.1): toggle OFF   */}
          {/* = the shelf doesn't exist and doesn't poll — clean absence.        */}
          {mindEnabled === true && <NightShelf base={base} />}

          {/* ── MCP servers — only show if we have data ── */}
          {mcpServers.length > 0 && (
            <section className="home-card" aria-label="MCP connections" data-orn="1">
              <h2 className="home-card-title">Connections</h2>
              <div className="mcp-grid">
                {mcpServers.map(server => (
                  <McpServerRow key={server.name} server={server} />
                ))}
              </div>
            </section>
          )}

          {/* ── The house — the full cockpit (your card, scratchpad, refresh, themes…) ── */}
          <details
            ref={houseRef}
            className="home-card home-house"
            // the cards take consecutive ornament slots, so their corners and paintings cycle like a thread's
            data-orn="5"
            onToggle={e => setHouseOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="home-card-title">The house</summary>
            {houseOpen && <OutlookView />}
          </details>

        </div>
      </div>

      <style>{`
        .home-view {
          position: relative;
          height: 100%;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .home-scroll {
          position: relative;
          z-index: 2;
          flex: 1;
          overflow-y: auto;
          padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1.25rem calc(2rem + env(safe-area-inset-bottom, 0px));
        }

        .home-inner {
          max-width: 92rem;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        /* ── The welcome: no box of its own. It is open onto the room behind the app (the whole painting, skins.css),
           with only a soft, edgeless shade behind the words so they read over a bright moon or candle. ── */
        .home-hero {
          position: relative;
          display: flex;
          align-items: center;
          min-height: clamp(12rem, 28vh, 20rem);
          padding: 1.5rem clamp(1.5rem, 6vw, 5.5rem);
          isolation: isolate;
        }
        .home-hero::before {
          content: '';
          position: absolute;
          inset: 0;
          z-index: -1;
          pointer-events: none;
          background: radial-gradient(ellipse 48% 62% at 26% 52%,
            color-mix(in srgb, var(--surface-chrome, #2c1a10) 55%, transparent) 0%,
            color-mix(in srgb, var(--surface-chrome, #2c1a10) 30%, transparent) 45%,
            transparent 72%);
        }
        .home-hero-title {
          font: 600 clamp(2.6rem, 4.4vw, 3.9rem)/1.05 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
          color: var(--home-head-text, #f6eedb);
          text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85), 0 1px 3px rgba(0, 0, 0, 0.7);
        }
        /* The companion, small in the banner's top-right corner: their orb, name and presence. */
        .home-hero-chip {
          position: absolute;
          top: 0.9rem;
          right: 1rem;
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          padding: 0.2rem 0.7rem;
          border-radius: 999px;
          background: var(--chip-bg, var(--surface-chrome, #2c1a10));
          color: var(--chip-text, var(--surface-chrome-text, #efe4d0));
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 0.85rem;
          white-space: nowrap;
        }
        .home-hero-mark { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--skin-trim, #d4a843); flex-shrink: 0; }
        .home-hero-name { margin-right: 0.3rem; }
        .home-pip { width: 0.6rem; height: 0.6rem; border-radius: 50%; flex-shrink: 0; }
        .home-room { opacity: 0.85; }

        /* ── The four ways in: Home cards (the skin's cloth, rim and small fittings, no ornament), each led by a round
           medallion in the skin's metal ── */
        .home-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; }
        .home-tile {
          display: flex;
          min-width: 0;
          padding: 0;
          border: none;
          border-radius: var(--plate-radius, 6px);
          background: transparent;
          text-align: left;
          text-decoration: none;
          color: inherit;
          cursor: pointer;
          box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35));
          transition: transform 150ms ease;
        }
        .home-tile:hover { transform: translateY(-2px); }
        .home-tile:active { transform: scale(0.99); }
        .home-tile:focus-visible { outline: 2px solid var(--focus-ring-chrome, #e6dac3); outline-offset: 2px; }
        /* The ornament has no room beside two lines, and the fittings keep to the corners, clear of the text. */
        .home-tile .home-tile-body {
          --plate-orn-size: 0px !important;
          --material-orn-clearance: 0px !important;
          --plate-corner: 18px !important;
          display: flex;
          align-items: center;
          gap: 0.9rem;
          flex: 1;
          min-width: 0;
          padding: 1rem 1.1rem !important;
          box-shadow: none !important;
        }
        .home-tile .home-tile-body::after { display: none !important; }
        /* The medallion: the chrome's colour, ringed in the skin's metal, the glyph in it too (a graphic: 3:1 is its bar). */
        .home-tile-badge {
          display: grid;
          place-items: center;
          width: 3.4rem;
          height: 3.4rem;
          flex-shrink: 0;
          border-radius: 50%;
          background: radial-gradient(circle at 50% 35%,
            color-mix(in srgb, var(--surface-chrome, #2c1a10) 78%, var(--skin-trim, #d4a843)) 0%,
            var(--surface-chrome, #2c1a10) 70%);
          border: 1.5px solid var(--skin-badge-ink, var(--skin-trim, var(--surface-chrome-muted, #d9cdb6)));
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--skin-trim, #d4a843) 18%, transparent), 0 4px 12px rgba(0, 0, 0, 0.35);
          color: var(--skin-badge-ink, var(--skin-trim, var(--surface-chrome-text, #efe4d0)));
        }
        .home-tile-main { display: flex; flex-direction: column; gap: 0.25rem; flex: 1; min-width: 0; }
        .home-tile-title { font-family: var(--font-serif, 'Lora', Georgia, serif); font-size: 1.25rem; line-height: 1.2; color: var(--text-primary, #2c231f); }
        .home-tile-text { font-size: 0.9rem; line-height: 1.4; color: var(--text-secondary, #6b5d55); }
        .home-tile-go {
          display: grid;
          place-items: center;
          width: 2rem;
          height: 2rem;
          flex-shrink: 0;
          border-radius: 50%;
          border: 1.5px solid var(--skin-trim, var(--text-secondary, #6b5d55));
          color: var(--text-primary, #2c231f);
        }

        /* ── Cards ── */
        .home-card {
          position: relative;
          overflow: hidden;
          isolation: isolate;
          background: var(--card-bg);
          border-radius: var(--radius-panel, 14px);
          box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35));
          padding: 0.9rem 1.2rem 1.1rem;
          color: var(--surface-panel-text, #2c231f);
          min-width: 0;
        }
        /* Botanical corners on the right edge, clear of the text column. */
        /* The illustrated botanicals: one plant per card, anchored bottom-right,
           stems meeting at the corner. Text keeps the left; the right is reserved. */
        .home-card::after {
          content: '';
          position: absolute;
          right: 10px;
          bottom: 4px;
          width: 64px;
          height: 100px;
          background: center bottom / contain no-repeat;
          opacity: 0.95;
          display: var(--home-sprig-display, none);
          pointer-events: none;
          z-index: 0;
        }
        .home-card[aria-label="Recent conversation"]::after { background-image: var(--home-sprig-lavender, none); }
        .home-card[aria-label="Reminders"]::after { background-image: var(--home-sprig-umbel, none); }
        .home-card[aria-label="MCP connections"]::after { background-image: var(--home-sprig-sage, none); }
        .home-two .home-card::after { width: 44px; height: 68px; bottom: 2px; right: 8px; }
        .home-card > * { position: relative; z-index: 1; }
        .home-card { padding-right: calc(1.2rem + var(--home-sprig-room, 4.3rem)); }
        @media (max-width: 768px) {
          .home-card::after { width: 40px; height: 62px; }
          .home-two .home-card::after { width: 30px; height: 46px; }
          .home-card { padding-right: calc(1.2rem + var(--home-sprig-room-m, 2.05rem)); }
        }
        .home-card-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 1rem;
          padding-bottom: 0.6rem;
          margin-bottom: 0.8rem;
          border-bottom: 1px solid var(--divider, rgba(90, 65, 40, 0.25));
        }
        .home-card-head .home-card-title { padding-bottom: 0; margin-bottom: 0; border-bottom: none; }
        .home-card-title {
          display: flex;
          align-items: center;
          gap: 0.65rem;
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 1.35rem;
          font-weight: 400;
          line-height: 1.2;
          padding-bottom: 0.6rem;
          margin-bottom: 0.8rem;
          border-bottom: 1px solid var(--divider, rgba(90, 65, 40, 0.25));
          color: var(--text-primary, #2c231f);
          list-style: none;
          cursor: default;
        }
        .home-card-title svg { color: var(--text-secondary, #6b5d55); flex-shrink: 0; }
        summary.home-card-title { cursor: pointer; margin-bottom: 0; }
        summary.home-card-title::-webkit-details-marker { display: none; }
        details[open] > summary.home-card-title { margin-bottom: 0.8rem; }
        .home-see-all {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          flex-shrink: 0;
          padding: 0;
          border: none;
          background: none;
          font-size: 0.95rem;
          color: var(--text-secondary, #6b5d55);
          text-decoration: none;
          cursor: pointer;
        }
        .home-see-all:hover { color: var(--text-primary, #2c231f); }
        .home-card-text {
          font-size: 1.2rem;
          line-height: 1.5;
          color: var(--text-primary, #2c231f);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .home-empty { font-size: 1.2rem; color: var(--text-muted, #8a7c73); }
        .home-two { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 1rem; align-items: stretch; }

        .home-empty-state { display: flex; flex-direction: column; align-items: center; gap: 0.8rem; padding: 0.4rem 0 0.2rem; text-align: center; }
        .home-empty-badge {
          display: grid;
          place-items: center;
          width: 4rem;
          height: 4rem;
          border-radius: 50%;
          border: 1.5px solid var(--skin-trim, var(--text-secondary, #6b5d55));
          color: var(--text-primary, #2c231f);
        }
        .home-start {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.55rem 1.4rem;
          border-radius: 999px;
          background: transparent;
          border: 1.5px solid var(--skin-trim, var(--text-secondary, #6b5d55));
          color: var(--text-primary, #2c231f);
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 1.05rem;
          cursor: pointer;
          transition: background 150ms ease;
        }
        .home-start:hover { background: var(--bg-hover, rgba(0, 0, 0, 0.06)); }

        .home-rows { list-style: none; display: flex; flex-direction: column; }
        .home-rows li + li { border-top: 1px solid var(--divider, rgba(90, 65, 40, 0.25)); }
        .home-row {
          display: flex;
          align-items: center;
          gap: 0.85rem;
          width: 100%;
          padding: 0.6rem 0.2rem;
          border: none;
          background: none;
          text-align: left;
          color: inherit;
          cursor: pointer;
        }
        .home-row:hover { background: var(--bg-hover, rgba(0, 0, 0, 0.06)); }
        .home-row-box {
          display: grid;
          place-items: center;
          width: 2.5rem;
          height: 2.5rem;
          flex-shrink: 0;
          border-radius: 4px;
          border: 1px solid var(--divider, rgba(90, 65, 40, 0.25));
        }
        /* What kind of row it is, in the link ink. */
        .home-row-icon { width: 22px; height: 22px; color: var(--link, #6d5b93); }
        .home-row-main { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; min-width: 0; }
        .home-row-title { font-size: 1.05rem; line-height: 1.3; color: var(--text-primary, #2c231f); overflow-wrap: anywhere; }
        .home-row-sub { font-size: 0.9rem; color: var(--text-secondary, #6b5d55); }
        .home-row-chev { flex-shrink: 0; color: var(--text-secondary, #6b5d55); }

        .mcp-grid { display: flex; flex-direction: column; gap: 0.375rem; }

        /* ── The house (cockpit) inside its card ── */
        .home-house .ck-root {
          width: auto;
          max-width: none;
          left: 0;
          transform: none;
          margin-top: 0;
        }

        /* Extra readable: no painting behind any words (the room is gone too, skins.css). */
        :root[data-readability="extra"] .home-hero::before { display: none; }

        /* Narrower desktops: two a row. */
        @media (max-width: 1100px) and (min-width: 769px) {
          .home-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }

        /* ── Phones: a short greeting, the four ways in as one row of shortcuts, then the cards one under the other ── */
        @media (max-width: 768px) {
          .home-scroll { padding: 0.5rem 0.6rem 1rem; }
          .home-inner { gap: 0.6rem; }
          .home-hero { min-height: 7.5rem; padding: 2.2rem 0.6rem 0.6rem; align-items: flex-end; }
          .home-hero::before {
            background: radial-gradient(ellipse 75% 45% at 40% 82%,
              color-mix(in srgb, var(--surface-chrome, #2c1a10) 60%, transparent) 0%,
              color-mix(in srgb, var(--surface-chrome, #2c1a10) 32%, transparent) 50%,
              transparent 78%);
          }
          .home-hero-title { font-size: 1.85rem; }
          .home-hero-chip { top: 0.45rem; right: 0.3rem; font-size: 0.75rem; padding: 0.15rem 0.55rem; gap: 0.35rem; }
          .home-tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.45rem; }
          .home-tile .home-tile-body {
            --plate-corner: 12px !important;
            flex-direction: column;
            justify-content: center;
            gap: 0.4rem;
            padding: 0.7rem 0.25rem 0.6rem !important;
            text-align: center;
          }
          .home-tile-badge { width: 2.6rem; height: 2.6rem; }
          .home-tile-badge svg { width: 19px; height: 19px; }
          .home-tile-main { align-items: center; }
          .home-tile-title { font-size: 0.8rem; line-height: 1.15; }
          .home-tile-text, .home-tile-go { display: none; }
          .home-two { grid-template-columns: 1fr; gap: 0.6rem; }
          .home-card { padding: 0.6rem 0.85rem 0.7rem; padding-right: calc(0.85rem + var(--home-sprig-room-phone, 2.55rem)); border-radius: 12px; font-size: 0.9rem; }
          .home-card-head { padding-bottom: 0.35rem; margin-bottom: 0.45rem; }
          .home-card-title { font-size: 1rem; padding-bottom: 0.35rem; margin-bottom: 0.35rem; }
          .home-see-all { font-size: 0.85rem; }
          .home-card-text { font-size: 0.9rem; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
          .home-empty { font-size: 0.9rem; }
          .home-empty-state { gap: 0.45rem; padding: 0.15rem 0 0; }
          .home-empty-badge { width: 2.3rem; height: 2.3rem; }
          .home-empty-badge svg { width: 18px; height: 18px; }
          .home-start { font-size: 0.85rem; padding: 0.35rem 0.95rem; }
          .home-row { padding: 0.45rem 0.1rem; gap: 0.6rem; }
          .home-row-box { width: 2rem; height: 2rem; }
          .home-row-icon { width: 18px; height: 18px; }
          .home-row-title { font-size: 0.9rem; }
          .home-row-sub { font-size: 0.78rem; }
          .home-card::after { width: 34px; height: 54px; right: 6px; bottom: 2px; }
          .home-two .home-card::after { width: 34px; height: 54px; }
        }
      `}</style>
    </div>
  );
}

// ─── MCP server row (shared with SettingsView) ─────────────────────────────────

export function McpServerRow({ server }: { server: McpServerInfo }) {
  const statusColor: Record<string, string> = {
    connected: '#6dba88',
    failed: '#c0524a',
    'needs-auth': '#d4a843',
    pending: '#71717a',
    disabled: '#3f3f46',
  };

  const statusLabel: Record<string, string> = {
    connected: 'connected',
    failed: 'failed',
    'needs-auth': 'needs auth',
    pending: 'pending',
    disabled: 'disabled',
  };

  const color = statusColor[server.status] ?? '#3f3f46';
  const label = statusLabel[server.status] ?? server.status;
  const isOk = server.status === 'connected';

  return (
    <div className="mcp-row">
      <span
        className="mcp-pip"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="mcp-name">{server.name}</span>
      {isOk && server.toolCount > 0 && (
        <span className="mcp-tools">{server.toolCount} tools</span>
      )}
      <span
        className="mcp-status"
        style={{ color }}
      >
        {label}
      </span>
      {server.error && (
        <span className="mcp-error" title={server.error}>!</span>
      )}

      <style>{`
        .mcp-row {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          padding: 0.625rem 0.875rem;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border, rgba(255,255,255,0.06));
          border-radius: 0.5rem;
          min-width: 0;
          transition: border-color 380ms var(--hearth-curve, ease);
        }
        .mcp-row:hover {
          border-color: rgba(255, 255, 255, 0.10);
        }

        .mcp-pip {
          display: inline-block;
          width: 0.375rem;
          height: 0.375rem;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .mcp-name {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .mcp-tools {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }

        .mcp-status {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          flex-shrink: 0;
        }

        .mcp-error {
          flex-shrink: 0;
          width: 1.125rem;
          height: 1.125rem;
          display: grid;
          place-items: center;
          background: rgba(192, 82, 74, 0.18);
          color: var(--status-error-text);
          border-radius: 0.25rem;
          font-size: 0.6875rem;
          font-family: var(--font-mono, monospace);
          cursor: help;
        }

        /* Desktop: the home fits the window. Tighter column, smaller type, less air. */
        @media (min-width: 769px) {
          .home-scroll { padding: 1rem 2rem 1.5rem; }
          .home-inner { max-width: 42rem; gap: 0.75rem; }
          .home-title { font-size: 1.8rem; }
          .home-name { font-size: 1.6rem; }
          .home-avatar { width: 48px; height: 48px; }
          .home-status { font-size: 0.9rem; }
          .home-card { padding: 0.75rem 1rem 0.9rem; }
          .home-card-title { font-size: 1.05rem; padding-bottom: 0.45rem; }
          .home-card-text { font-size: 0.95rem; line-height: 1.45; }
          .home-empty { font-size: 0.92rem; }
          .home-list li { font-size: 0.92rem; line-height: 1.4; }
          .home-two { gap: 0.75rem; }
        }

      `}</style>
    </div>
  );
}

function getPresencePipColor(presence: string): string {
  const m: Record<string, string> = {
    active: '#e0a020',
    waking: '#e0a020',
    dormant: '#b8ad9c',
    offline: '#8f8578',
  };
  return m[presence] ?? '#8f8578';
}

function formatEventTime(t: string, allDay?: boolean): string {
  if (allDay || t === 'all-day') return 'All day';
  if (t.includes('T')) {
    return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return t;
}
