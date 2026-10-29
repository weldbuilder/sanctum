/**
 * ObservatoryView — /mind/observatory, the lab behind the room.
 *
 * The user's stethoscope into the companion's substrate. The /mind room contemplates;
 * this wing INSPECTS — regions, rows, instruments. Doctrine (v1, load-bearing):
 *   - READ-ONLY. Instruments, not a scalpel. No writes to the mind, no
 *     delete/edit actions anywhere on this page.
 *   - The mind key never reaches the client — everything rides the
 *     session-authed backend proxy at /api/mind/observatory/*.
 *   - Renders the companion's interior only. Never the user's state (theirs is /command).
 *   - Read-when-visit: no polling, no alarms, no notifications.
 *
 * Structure: index (instruments + regions grid) → region browser per region
 * → constellation doorway (the graph component is the constellation lane's;
 * we mount it lazily and hand it the graph fetch).
 */
import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMindStore } from '../../store/mind';
import {
  fetchObservatory,
  fetchObservatoryHealth,
  OBSERVATORY_UNAVAILABLE,
  type ObservatoryHealth,
  type Telemetry,
} from '../../store/observatory';
import type { GraphData } from './ConstellationView';
import {
  ObservatoryStyles,
  StatusDot,
  LoadingPulse,
  statusFromScore,
  useObsData,
  type ObsStatus,
} from './primitives';
import { HealthPanel } from './HealthPanel';
import {
  EntitiesRegion,
  ObservationsRegion,
  ThreadsRegion,
  CompassRegion,
  SpineRegion,
  JournalsRegion,
  WeatherRegion,
  DreamsRegion,
  DrivesRegion,
} from './regions';

// The constellation lane owns ConstellationView; lazy so its chunk (d3-force)
// only loads when the doorway is opened.
const ConstellationView = React.lazy(() =>
  import('./ConstellationView').then(m => ({ default: m.ConstellationView }))
);

// Contract with the constellation lane: fetchGraph: () => Promise<GraphData>.
//
// SEAM ADAPTER (load-bearing): the proxy's /graph edges carry entity NAMES —
// the mind's relations table is name-keyed (from_entity/to_entity) — while
// skyData resolves edge endpoints against node IDS. Without translation every
// edge drops as "dangling" and the sky renders starless of lines. This fetch
// owns the seam: names → ids, passing through anything already id-shaped so a
// future id-keyed proxy payload keeps working unchanged.
async function fetchGraph(): Promise<GraphData> {
  const res = await fetchObservatory<GraphData>('/graph');
  if (!res.ok) throw Object.assign(new Error(res.error), { unavailable: res.error === OBSERVATORY_UNAVAILABLE });
  const data = res.data ?? ({} as GraphData);
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const ids = new Set<string>();
  const idByName = new Map<string, string>();
  for (const n of nodes) {
    const rec = n as { id?: unknown; name?: unknown };
    const id = String(rec.id ?? '').trim();
    const name = String(rec.name ?? '').trim();
    if (!id) continue;
    ids.add(id);
    if (name && !idByName.has(name)) idByName.set(name, id);
  }
  const edges = (Array.isArray(data.edges) ? data.edges : []).map(e => {
    const rec = e as { from?: unknown; to?: unknown };
    const from = String(rec.from ?? '');
    const to = String(rec.to ?? '');
    return {
      ...(e as Record<string, unknown>),
      from: ids.has(from) ? from : (idByName.get(from) ?? from),
      to: ids.has(to) ? to : (idByName.get(to) ?? to),
    };
  });
  return { ...data, nodes, edges } as GraphData;
}

// ─── Region registry ─────────────────────────────────────────────────────────

type RegionKey =
  | 'entities' | 'observations' | 'threads' | 'compass' | 'spine'
  | 'journal' | 'weather' | 'dreams' | 'drives';

interface RegionDef {
  key: RegionKey;
  label: string;
  /** Card count + status derived from the telemetry snapshot; count null =
   *  telemetry doesn't carry one — rendered as an honest em-dash. */
  card: (t: Telemetry | null) => { count: number | null; status: ObsStatus; hint?: string };
}

const REGIONS: RegionDef[] = [
  {
    key: 'entities',
    label: 'entities · people · nodes',
    card: t => ({
      count: t?.database?.entities ?? null,
      status: statusFromScore(t?.database?.score),
    }),
  },
  {
    key: 'observations',
    label: 'observations',
    card: t => ({
      count: t?.database?.observations ?? null,
      status: statusFromScore(t?.database?.score),
      hint: typeof t?.living_surface?.archived_obs === 'number'
        ? `${t.living_surface.archived_obs} archived` : undefined,
    }),
  },
  {
    key: 'threads',
    label: 'threads',
    card: t => ({
      count: t?.threads?.active ?? null,
      status: statusFromScore(t?.threads?.score),
      hint: typeof t?.threads?.graveyard === 'number' ? `${t.threads.graveyard} graveyard` : undefined,
    }),
  },
  {
    key: 'compass',
    label: 'compass',
    card: t => ({
      count: t?.compass?.entries ?? null,
      status: t?.compass ? ((t.compass.fresh ?? 0) > 0 ? 'ok' : 'warn') : 'unavailable',
      hint: typeof t?.compass?.edges === 'number' ? `${t.compass.edges} provenance edges` : undefined,
    }),
  },
  {
    key: 'spine',
    label: 'spine',
    card: t => ({
      count: t?.identity?.entries ?? null,
      status: statusFromScore(t?.identity?.score),
    }),
  },
  {
    key: 'journal',
    label: 'episodes · journal',
    card: t => ({
      count: t?.journals?.total ?? null,
      status: statusFromScore(t?.journals?.score),
      hint: typeof t?.journals?.this_week === 'number' ? `${t.journals.this_week} this week` : undefined,
    }),
  },
  {
    key: 'weather',
    label: 'weather · mood history',
    card: t => ({
      count: null,
      status: statusFromScore(t?.subconscious?.score),
      hint: t?.subconscious?.age ? `daemon ${t.subconscious.age}` : undefined,
    }),
  },
  {
    key: 'dreams',
    label: 'dreams',
    card: t => ({
      count: null,
      status: statusFromScore(t?.subconscious?.score),
    }),
  },
  {
    key: 'drives',
    label: 'drives ledger',
    // Not exposed by the mind's read API — arrives via the living-surface
    // cache; the card reflects whether that carrier has it.
    card: () => ({ count: null, status: 'unavailable' as const }),
  },
];

// ─── Index grid ──────────────────────────────────────────────────────────────

function RegionCards({
  telemetry,
  drivesPresent,
  onOpen,
}: {
  telemetry: Telemetry | null;
  drivesPresent: boolean;
  onOpen: (key: RegionKey) => void;
}) {
  return (
    <div className="ob-cards">
      {REGIONS.map(r => {
        let { count, status, hint } = r.card(telemetry);
        if (r.key === 'drives') {
          status = drivesPresent ? 'ok' : 'unavailable';
          if (!drivesPresent) hint = 'not in the living surface yet';
        }
        return (
          <button type="button" className="ob-card" key={r.key} onClick={() => onOpen(r.key)}>
            <div className="ob-card-top">
              <StatusDot
                status={status}
                reason={status === 'unavailable' ? (hint ?? 'no reading from the mind') : undefined}
              />
              <span className="ob-card-count">{count === null ? '—' : count}</span>
            </div>
            <div className="ob-card-label">{r.label}</div>
            {hint && <div className="ob-card-hint">{hint}</div>}
          </button>
        );
      })}
    </div>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────

type Pane = 'index' | 'constellation' | RegionKey;

export function ObservatoryView() {
  const enabled = useMindStore(s => s.enabled);
  const mindData = useMindStore(s => s.data);
  const [pane, setPane] = useState<Pane>('index');

  // Deep link straight to the wing: make sure the gate has been asked.
  useEffect(() => {
    if (enabled === null) void useMindStore.getState().fetchSurface();
  }, [enabled]);

  // The instruments read — once per visit, reread on demand. Region cards
  // derive their counts from the telemetry passthrough riding the same call.
  const health = useObsData<ObservatoryHealth>(fetchObservatoryHealth);
  const telemetry = health.data?.telemetry ?? null;

  const drivesPresent = !!mindData?.surface?.living_surface?.drives;
  const regionLabel = useMemo(
    () => REGIONS.find(r => r.key === pane)?.label ?? null,
    [pane],
  );

  // Gate — same manners as /mind: unknown holds quiet, disabled goes home.
  if (enabled === false) return <Navigate to="/home" replace />;
  if (enabled === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <LoadingPulse />
        <ObservatoryStyles />
      </div>
    );
  }

  return (
    <div className="observatory-view">
      <div className="ob-scroll">
        <div className="ob-inner">
          <header className="ob-header">
            <div className="ob-crumbs">
              <Link to="/mind" className="ob-crumb-link">the observatory</Link>
              <span className="ob-crumb-sep">/</span>
              {pane === 'index' ? (
                <span className="ob-crumb-here">the lab</span>
              ) : (
                <>
                  <button type="button" className="ob-crumb-link ob-crumb-btn" onClick={() => setPane('index')}>
                    the lab
                  </button>
                  <span className="ob-crumb-sep">/</span>
                  <span className="ob-crumb-here">
                    {pane === 'constellation' ? 'constellation' : regionLabel}
                  </span>
                </>
              )}
            </div>
            <h1 className="ob-title">{pane === 'constellation' ? 'the constellation' : 'the lab'}</h1>
            <p className="ob-subtitle">
              read-only instruments over the companion's substrate — a stethoscope, not a scalpel.
            </p>
            <nav className="ob-tabs" aria-label="Observatory panes">
              <button
                type="button"
                className={`ob-tab${pane !== 'constellation' ? ' active' : ''}`}
                onClick={() => setPane('index')}
              >
                regions
              </button>
              <button
                type="button"
                className={`ob-tab${pane === 'constellation' ? ' active' : ''}`}
                onClick={() => setPane('constellation')}
              >
                constellation
              </button>
            </nav>
          </header>

          {pane === 'index' && (
            <>
              <HealthPanel
                health={health.data}
                at={health.at}
                error={health.error}
                loading={health.loading}
                onRefetch={health.refetch}
              />
              <RegionCards
                telemetry={telemetry}
                drivesPresent={drivesPresent}
                onOpen={key => setPane(key)}
              />
            </>
          )}

          {pane === 'entities' && <EntitiesRegion />}
          {pane === 'observations' && <ObservationsRegion />}
          {pane === 'threads' && <ThreadsRegion />}
          {pane === 'compass' && <CompassRegion telemetry={telemetry} />}
          {pane === 'spine' && <SpineRegion />}
          {pane === 'journal' && <JournalsRegion />}
          {pane === 'weather' && <WeatherRegion />}
          {pane === 'dreams' && <DreamsRegion />}
          {pane === 'drives' && <DrivesRegion />}

          {pane === 'constellation' && (
            <div className="ob-constellation">
              <Suspense fallback={<LoadingPulse />}>
                <ConstellationView fetchGraph={fetchGraph} />
              </Suspense>
            </div>
          )}
        </div>
      </div>

      <ObservatoryStyles />
      <style>{`
        .observatory-view {
          height: 100%;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          background: var(--bg-primary, #0c0b09);
        }
        .ob-scroll {
          flex: 1;
          overflow-y: auto;
          padding: 2rem 1.5rem 4rem;
        }
        .ob-inner {
          max-width: 56rem;
          margin: 0 auto;
        }

        /* ── header ── */
        .ob-header { margin-bottom: 1.5rem; }
        .ob-crumbs {
          display: flex;
          align-items: baseline;
          gap: 0.45rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.66rem;
          letter-spacing: 0.08em;
          margin-bottom: 0.6rem;
        }
        .ob-crumb-link {
          color: var(--amber-dim, #a08960);
          text-decoration: none;
        }
        .ob-crumb-link:hover { color: var(--amber, #c9a87c); }
        .ob-crumb-btn {
          background: transparent;
          border: none;
          font: inherit;
          letter-spacing: inherit;
          padding: 0;
          cursor: pointer;
        }
        .ob-crumb-sep { color: rgba(232, 224, 208, 0.25); }
        .ob-crumb-here { color: var(--text-muted, #6a6258); }
        .ob-title {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-weight: 500;
          font-size: 1.625rem;
          color: var(--text-primary, #e2dbd0);
          letter-spacing: -0.01em;
          line-height: 1.2;
          margin: 0;
        }
        .ob-subtitle {
          font-size: 0.8125rem;
          font-style: italic;
          color: var(--text-muted, #6a6258);
          margin: 0.375rem 0 0;
        }
        .ob-tabs {
          display: flex;
          gap: 0.4rem;
          margin-top: 1rem;
        }
        .ob-tab {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.66rem;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
          background: transparent;
          border: 1px solid rgba(232, 224, 208, 0.1);
          border-radius: 2rem;
          padding: 0.3rem 0.9rem;
          cursor: pointer;
          transition: color 150ms ease, border-color 150ms ease;
        }
        .ob-tab:hover { color: var(--text-secondary, #a09689); }
        .ob-tab.active {
          color: var(--amber, #c9a87c);
          border-color: rgba(201, 168, 124, 0.35);
        }

        /* ── region cards ── */
        .ob-cards {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
          gap: 0.75rem;
        }
        .ob-card {
          text-align: left;
          padding: 0.9rem 1rem;
          border: 1px solid rgba(232, 224, 208, 0.08);
          border-radius: 0.5rem;
          background: rgba(20, 16, 12, 0.35);
          cursor: pointer;
          transition: border-color 150ms ease, background 150ms ease;
        }
        .ob-card:hover {
          border-color: rgba(201, 168, 124, 0.3);
          background: rgba(24, 20, 15, 0.5);
        }
        .ob-card-top {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          margin-bottom: 0.35rem;
        }
        .ob-card-count {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 1.05rem;
          color: var(--text-primary, #e2dbd0);
        }
        .ob-card-label {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.64rem;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--text-secondary, #a09689);
        }
        .ob-card-hint {
          font-style: italic;
          font-size: 0.7rem;
          color: var(--text-muted, #6a6258);
          margin-top: 0.25rem;
        }

        .ob-constellation { min-height: 24rem; }

        @media (max-width: 600px) {
          .ob-scroll { padding: 1.25rem 1rem 3rem; }
        }
      `}</style>
    </div>
  );
}
