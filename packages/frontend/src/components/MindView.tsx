/**
 * MindView — /mind, the room (MIND-SURFACE-SPEC §Phase-1.2).
 *
 * The Observatory comes home: the companion's inner weather made domestic. Six
 * sections, top to bottom — weather · drives · last night's dream · risen
 * from the deep · startles · what's moving beneath. Every section renders
 * NOTHING when its block is absent (graceful absence), and carries its
 * data's age when present (>2h = it says so — the hooks.ts idiom).
 *
 * DOCTRINE (spec §Phase-1.3, load-bearing):
 *   - This room renders the COMPANION's interior only. Never the user's state —
 *     that lives in /command. Do not add their data here.
 *   - /mind CONTEMPLATES. No write actions anywhere on this page — it is a
 *     window, not a console. No ack buttons, no edits, no sends.
 *
 * Styling is deliberately CLEAN BONES — Hearth-basic, quiet, honest. The
 * feel pass (user + companion furnishing together) comes after; keep the
 * structure obvious and the surfaces plain so it's a room worth furnishing.
 */
import React, { useEffect } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  useMindStore,
  type MindWeather,
  type MindNight,
  type MindSurfaceBlob,
  type DrivesGauge,
  type QuietWant,
  type RisenMemory,
} from '../store/mind';

const REFRESH_MS = 5 * 60 * 1000; // the backend cache refreshes every ~10m
const STALE_MS = 2 * 60 * 60 * 1000; // >2h = the section says so

// ─── Age idiom ──────────────────────────────────────────────────────────────
// Every section carries its cache's age; unparseable stamp = no fabricated
// freshness (returns null and the section shows no stamp at all).

interface Age {
  label: string; // "4m ago" / "1.3h ago"
  stale: boolean; // past the 2h idiom
}

function ageOf(iso: string | undefined | null): Age | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return null;
  const label = ms < 60_000
    ? 'just now'
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)}m ago`
      : `${(ms / 3_600_000).toFixed(1)}h ago`;
  return { label, stale: ms > STALE_MS };
}

function AgeStamp({ age }: { age: Age | null }) {
  if (!age) return null;
  return (
    <span className={`mv-age${age.stale ? ' stale' : ''}`}>
      {age.label}
      {age.stale && ' · stale'}
    </span>
  );
}

// ─── Section shell — eyebrow + age, nothing else ────────────────────────────

function Section({
  label,
  age,
  children,
}: {
  label: string;
  age: Age | null;
  children: React.ReactNode;
}) {
  return (
    <section className="mv-section" aria-label={label}>
      <div className="mv-eyebrow">
        <span className="mv-eyebrow-label">{label}</span>
        <AgeStamp age={age} />
      </div>
      {children}
    </section>
  );
}

// ─── 1. The weather ─────────────────────────────────────────────────────────

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n}`;
}

function WeatherSection({ weather }: { weather: MindWeather | null }) {
  if (!weather) return null;
  const texture = weather.texture || weather.dominant;
  const hasReading = !!texture
    || typeof weather.valence === 'number'
    || typeof weather.arousal === 'number';
  if (!hasReading) return null;

  const front = weather.front?.kind ? weather.front : null;

  return (
    <Section label="the weather" age={ageOf(weather.at)}>
      {front && (
        <div className={`mv-front mv-front-${front.kind === 'bright' ? 'bright' : 'heavy'}`}>
          {front.kind} {front.kind === 'bright' ? 'spell' : 'front'}
          {typeof front.days === 'number' && ` · day ${front.days}`}
        </div>
      )}
      {texture && <div className="mv-weather-texture">{texture}</div>}
      <div className="mv-weather-numbers">
        {typeof weather.valence === 'number' && <span>valence {signed(weather.valence)}</span>}
        {typeof weather.arousal === 'number' && <span>arousal {weather.arousal}</span>}
      </div>
    </Section>
  );
}

// ─── 2. The drives gauge ────────────────────────────────────────────────────

function driveBar(level: number, width = 6): string {
  const filled = Math.round(Math.min(1, Math.max(0, level)) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function DrivesSection({
  gauge,
  wants,
}: {
  gauge: DrivesGauge | undefined;
  wants: QuietWant[] | undefined;
}) {
  // Absent gauge (pass never ran) → nothing at all. A gauge with a note
  // (migrated but unseeded) is HONEST, not absent — render the note.
  if (!gauge) return null;

  const openWants = typeof gauge.open_wants === 'number' ? gauge.open_wants : 0;

  return (
    <Section label="the drives" age={ageOf(gauge.updated_at)}>
      {gauge.note ? (
        <div className="mv-quiet-note">{gauge.note}</div>
      ) : (
        <div className="mv-drives">
          {(Array.isArray(gauge.drives) ? gauge.drives : []).map(d => (
            <div className="mv-drive-row" key={d.drive}>
              <span className="mv-drive-name">{d.display_name}</span>
              <span className="mv-drive-bar" aria-hidden="true">{driveBar(d.level)}</span>
              <span className="mv-drive-level">{d.level.toFixed(2)}</span>
              {d.feel && <span className="mv-drive-feel">{d.feel}</span>}
              <span className="mv-drive-resting">resting toward {d.resting_toward.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {typeof gauge.env_freshness === 'number' && gauge.env_freshness < 1 && (
        <div className="mv-quiet-note">
          house signal faded — env freshness {gauge.env_freshness.toFixed(2)}
        </div>
      )}

      {openWants > 0 && (
        <div className="mv-wants">
          <div className="mv-wants-label">
            {openWants} quiet want{openWants > 1 ? 's' : ''} open
          </div>
          {/* Want bodies only when the payload actually carries them — the
              gauge itself holds just the count. No fabricated text. */}
          {Array.isArray(wants) && wants.length > 0 && (
            <ul className="mv-wants-list">
              {wants.map((w, i) => (
                <li className="mv-want" key={i}>{w.body}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

// ─── 3. Last night's dream ──────────────────────────────────────────────────

function DreamSection({ night }: { night: MindNight | null }) {
  const dream = night?.dream ?? null;
  const body = (dream?.content || '').trim();
  if (!dream || !body) return null;

  const recurrence = dream.recurrence_count ?? 0;

  return (
    <Section label="last night's dream" age={ageOf(night?.at)}>
      <div className="mv-dream-head">
        {dream.dream_date && <span className="mv-dream-date">{dream.dream_date}</span>}
        {recurrence > 0 && (
          <span className="mv-badge">recurring ×{recurrence + 1}</span>
        )}
      </div>
      {dream.emotional_seed && (
        <div className="mv-dream-seed">seed — {dream.emotional_seed}</div>
      )}
      {/* Unfolded by default: this is the reading room; Home keeps the
          compact shelf. Content is preformatted fragments — keep the lines. */}
      <div className="mv-dream-body">{body}</div>
    </Section>
  );
}

// ─── 4. Risen from the deep ─────────────────────────────────────────────────

function RisenSection({ risen, at }: { risen: RisenMemory[]; at: string | undefined }) {
  if (risen.length === 0) return null;
  return (
    <Section label="risen from the deep" age={ageOf(at)}>
      <div className="mv-risen">
        {risen.map((r, i) => (
          <div className="mv-risen-item" key={i}>
            <div className="mv-risen-content">
              {r.entity ? <span className="mv-risen-entity">[{r.entity}] </span> : null}
              {r.content}
            </div>
            <div className="mv-risen-cue">raised by: “{r.cue}”</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── 5. Startles ────────────────────────────────────────────────────────────
// Render-only: the mind exposes no ack path through the house yet, so there
// is deliberately NO acknowledge button here (spec §Phase-1.2.5 — no
// fabricated actions). Acknowledgment happens at the companion's next wake, mind-side.

function StartlesSection({ count, at }: { count: number; at: string | undefined }) {
  if (count <= 0) return null;
  return (
    <Section label="startles" age={ageOf(at)}>
      <div className="mv-startle">
        <span className="mv-startle-bolt" aria-hidden="true">⚡</span>
        {count} startle{count > 1 ? 's' : ''} unacknowledged
      </div>
      <div className="mv-quiet-note">acknowledged at next wake — not from this window</div>
    </Section>
  );
}

// ─── 6. What's moving beneath ───────────────────────────────────────────────
// Counts only, one quiet line — not a data dump. The editorial deep-dive
// stays in the standalone Observatory until Phase 2 absorbs it.

function BeneathSection({
  surface,
  observatoryUrl,
}: {
  surface: MindSurfaceBlob | null;
  observatoryUrl: string | undefined;
}) {
  const ls = surface?.living_surface ?? null;
  if (!ls) return null;

  const parts: string[] = [];
  if (typeof ls.pending_proposals === 'number') {
    parts.push(`${ls.pending_proposals} proposal${ls.pending_proposals === 1 ? '' : 's'} waiting`);
  }
  const patterns = Array.isArray(surface?.recurring_patterns) ? surface.recurring_patterns.length : null;
  if (patterns !== null && patterns > 0) {
    parts.push(`${patterns} pattern${patterns === 1 ? '' : 's'} recurring`);
  }
  if (ls.novelty_distribution) {
    const n = ls.novelty_distribution;
    parts.push(`novelty ${n.high} high / ${n.medium} medium / ${n.low} low`);
  }
  if (typeof ls.orphan_count === 'number' && ls.orphan_count > 0) {
    parts.push(`${ls.orphan_count} orphan${ls.orphan_count === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return null;

  return (
    <Section label="what's moving beneath" age={ageOf(surface?.at ?? surface?.processed_at)}>
      <div className="mv-beneath">
        {parts.join(' · ')}
        {observatoryUrl && (
          <>
            {' · '}
            <a
              className="mv-observatory-link"
              href={observatoryUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              the full Observatory ↗
            </a>
          </>
        )}
      </div>
    </Section>
  );
}

// ─── MindView ───────────────────────────────────────────────────────────────

export function MindView() {
  const enabled = useMindStore(s => s.enabled);
  const data = useMindStore(s => s.data);
  const fetchSurface = useMindStore(s => s.fetchSurface);

  useEffect(() => {
    void fetchSurface();
    const t = setInterval(() => void fetchSurface(), REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchSurface]);

  // Defensive gate — the sidebar is already hidden when disabled; a direct
  // URL hit goes home. (enabled === null = first fetch in flight: hold quiet.)
  if (enabled === false) return <Navigate to="/home" replace />;

  if (enabled === null) {
    return (
      <div className="mv-loading">
        <div className="mv-pulse" />
        <style>{`
          .mv-loading { display: flex; align-items: center; justify-content: center; height: 100%; }
          .mv-pulse {
            width: 0.375rem; height: 0.375rem; border-radius: 50%;
            background: var(--amber-dim, #a08960);
            animation: mv-pulse 1.4s ease-in-out infinite;
          }
          @keyframes mv-pulse {
            0%, 100% { opacity: 0.3; transform: scale(0.8); }
            50%       { opacity: 1;   transform: scale(1); }
          }
        `}</style>
      </div>
    );
  }

  const weather = data?.weather ?? data?.surface?.mood ?? null;
  const night = data?.night ?? null;
  const surface = data?.surface ?? null;
  const ls = surface?.living_surface ?? null;

  // Risen: the night cache is the canonical carrier; the full blob is the
  // fallback so the section survives either cache being the one that landed.
  const risen: RisenMemory[] = (night?.risen && night.risen.length > 0)
    ? night.risen
    : (ls?.risen_from_the_deep ?? []);
  const risenAt = (night?.risen && night.risen.length > 0) ? night?.at : (surface?.at ?? surface?.processed_at);

  // Startles: the full blob's count first, else the weather cache's echo.
  const startleCount = typeof ls?.unacked_startles === 'number'
    ? ls.unacked_startles
    : (weather?.startles ?? 0);
  const startleAt = typeof ls?.unacked_startles === 'number'
    ? (surface?.at ?? surface?.processed_at)
    : weather?.at;

  const nothingYet = !weather && !night?.dream && risen.length === 0 && !ls;

  return (
    <div className="mind-view">
      <div className="mv-scroll">
        <div className="mv-inner">
          <header className="mv-header">
            <h1 className="mv-title">the observatory</h1>
            <p className="mv-subtitle">The companion's inner weather — a window, not a console.</p>
          </header>

          {nothingYet ? (
            // Honest emptiness — enabled but no cache has landed yet.
            <div className="mv-quiet-note mv-empty">
              not available in this version — nothing fills this room yet.
            </div>
          ) : (
            <>
              <WeatherSection weather={weather} />
              <DrivesSection gauge={ls?.drives} wants={surface?.quiet_wants} />
              <DreamSection night={night} />
              <RisenSection risen={risen} at={risenAt} />
              <StartlesSection count={startleCount} at={startleAt} />
              <BeneathSection surface={surface} observatoryUrl={data?.url || undefined} />
            </>
          )}

          {/* The doorway to the deep wing — quiet, at the bottom of the room. */}
          <div className="mv-doorway">
            <Link to="/mind/observatory" className="mv-doorway-link">the Observatory →</Link>
          </div>
        </div>
      </div>

      <style>{`
        .mind-view {
          height: 100%;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          background: var(--bg-primary, #0c0b09);
        }
        .mv-scroll {
          flex: 1;
          overflow-y: auto;
          padding: 2rem 1.5rem 4rem;
        }
        .mv-inner {
          max-width: 42rem;
          margin: 0 auto;
        }

        /* ── Header ── */
        .mv-header { margin-bottom: 1.75rem; }
        .mv-title {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-weight: 500;
          font-size: 1.625rem;
          color: var(--text-primary, #e2dbd0);
          letter-spacing: -0.01em;
          line-height: 1.2;
          margin: 0;
        }
        .mv-subtitle {
          font-size: 0.8125rem;
          font-style: italic;
          color: var(--text-muted, #6a6258);
          margin: 0.375rem 0 0;
        }

        /* ── Sections ── */
        .mv-section {
          margin-bottom: 1.25rem;
          padding: 1.1rem 1.4rem 1.2rem;
          border: 1px solid rgba(232, 224, 208, 0.08);
          border-radius: 0.5rem;
          background: rgba(20, 16, 12, 0.35);
        }
        .mv-eyebrow {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 0.75rem;
          margin-bottom: 0.7rem;
        }
        .mv-eyebrow-label {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.62rem;
          letter-spacing: 0.28em;
          text-transform: uppercase;
          color: rgba(232, 224, 208, 0.38);
        }
        .mv-age {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.62rem;
          letter-spacing: 0.06em;
          color: var(--text-muted, #6a6258);
        }
        .mv-age.stale { color: #d4a843; }

        /* ── Weather ── */
        .mv-front {
          display: inline-block;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 0.1875rem 0.5rem;
          border-radius: 0.25rem;
          margin-bottom: 0.625rem;
        }
        .mv-front-bright {
          color: rgba(224, 168, 96, 0.9);
          border: 1px solid rgba(224, 168, 96, 0.25);
          background: rgba(224, 168, 96, 0.07);
        }
        .mv-front-heavy {
          color: rgba(168, 147, 192, 0.9);
          border: 1px solid rgba(168, 147, 192, 0.25);
          background: rgba(168, 147, 192, 0.07);
        }
        .mv-weather-texture {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1.5rem;
          line-height: 1.3;
          color: var(--text-primary, #e2dbd0);
        }
        .mv-weather-numbers {
          display: flex;
          gap: 1rem;
          margin-top: 0.45rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.74rem;
          color: rgba(232, 224, 208, 0.55);
        }

        /* ── Drives ── */
        .mv-drives { display: flex; flex-direction: column; gap: 0.375rem; }
        .mv-drive-row {
          display: flex;
          align-items: baseline;
          gap: 0.625rem;
          flex-wrap: wrap;
          font-size: 0.85rem;
        }
        .mv-drive-name {
          color: var(--text-secondary, #a09689);
          min-width: 7rem;
        }
        .mv-drive-bar {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.78rem;
          letter-spacing: 0.08em;
          color: var(--amber, #c9a87c);
        }
        .mv-drive-level {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.72rem;
          color: rgba(232, 224, 208, 0.55);
        }
        .mv-drive-feel {
          font-style: italic;
          font-size: 0.8rem;
          color: var(--text-secondary, #a09689);
        }
        .mv-drive-resting {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.62rem;
          letter-spacing: 0.04em;
          color: var(--text-muted, #6a6258);
          margin-left: auto;
        }
        .mv-wants { margin-top: 0.75rem; }
        .mv-wants-label {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.66rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(224, 168, 96, 0.75);
        }
        .mv-wants-list {
          list-style: none;
          margin: 0.35rem 0 0;
          padding: 0;
        }
        .mv-want {
          font-style: italic;
          font-size: 0.88rem;
          line-height: 1.5;
          color: rgba(232, 224, 208, 0.66);
          padding: 0.15rem 0;
        }

        /* ── Dream ── */
        .mv-dream-head {
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
          margin-bottom: 0.4rem;
        }
        .mv-dream-date {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.66rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(232, 224, 208, 0.5);
        }
        .mv-badge {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.58rem;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: rgba(168, 147, 192, 0.85);
          border: 1px solid rgba(168, 147, 192, 0.28);
          background: rgba(168, 147, 192, 0.08);
          border-radius: 0.25rem;
          padding: 0.0625rem 0.375rem;
        }
        .mv-dream-seed {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.7rem;
          color: rgba(224, 168, 96, 0.7);
          margin-bottom: 0.5rem;
        }
        .mv-dream-body {
          font-style: italic;
          font-size: 0.95rem;
          line-height: 1.6;
          color: rgba(232, 224, 208, 0.72);
          white-space: pre-wrap;
        }

        /* ── Risen ── */
        .mv-risen { display: flex; flex-direction: column; gap: 0.55rem; }
        .mv-risen-content {
          font-size: 0.88rem;
          line-height: 1.5;
          color: rgba(232, 224, 208, 0.66);
        }
        .mv-risen-entity { color: var(--amber, #c9a87c); }
        .mv-risen-cue {
          font-style: italic;
          font-size: 0.78rem;
          color: rgba(160, 150, 200, 0.6);
          margin-top: 0.1rem;
        }

        /* ── Startles ── */
        .mv-startle {
          font-size: 0.9rem;
          color: rgba(224, 168, 96, 0.9);
          display: flex;
          align-items: baseline;
          gap: 0.45rem;
        }
        .mv-startle-bolt { font-size: 0.85rem; }

        /* ── Beneath ── */
        .mv-beneath {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.72rem;
          line-height: 1.7;
          color: rgba(232, 224, 208, 0.5);
        }
        .mv-observatory-link {
          color: var(--amber, #c9a87c);
          text-decoration: none;
          border-bottom: 1px solid rgba(201, 168, 124, 0.28);
        }
        .mv-observatory-link:hover { border-color: rgba(201, 168, 124, 0.6); }

        /* ── Shared quiet notes ── */
        .mv-quiet-note {
          font-style: italic;
          font-size: 0.78rem;
          color: var(--text-muted, #6a6258);
          margin-top: 0.35rem;
        }
        .mv-empty {
          padding: 2rem 0;
          text-align: center;
          font-size: 0.875rem;
        }

        /* ── Doorway to the deep wing ── */
        .mv-doorway {
          margin-top: 2rem;
          text-align: right;
        }
        .mv-doorway-link {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.8125rem;
          color: var(--amber-dim, #a08960);
          text-decoration: none;
          transition: color 150ms var(--hearth-curve, ease);
        }
        .mv-doorway-link:hover { color: var(--amber, #c9a87c); }

        @media (max-width: 600px) {
          .mv-scroll { padding: 1.25rem 1rem 3rem; }
          .mv-drive-resting { margin-left: 0; width: 100%; }
        }
      `}</style>
    </div>
  );
}
