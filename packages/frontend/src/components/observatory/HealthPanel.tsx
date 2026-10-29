/**
 * HealthPanel — the overall instruments, top of the Observatory index.
 *
 * Source: GET /api/mind/observatory/health — the proxy's enriched reading:
 * named checks (mind_reachable, daemon_freshness, house caches, startles,
 * threads, proposals, graph, dreams, weather history) each with status +
 * detail, and honest 'unavailable' entries carrying their reason (dim ring,
 * reason on tap — no fabricated green). Instruments are READ-when-visit —
 * no polling, no alarms, no notifications (v1 decision).
 */
import React from 'react';
import { type ObservatoryHealth, type HealthCheck } from '../../store/observatory';
import {
  Panel,
  StatusDot,
  Unreachable,
  QuietNote,
  LoadingPulse,
  ageOf,
  type Age,
} from './primitives';

function checkValue(c: HealthCheck): string {
  if (c.status === 'unavailable') return '—';
  if (c.detail) return c.detail;
  if (c.value !== undefined && c.value !== null && typeof c.value !== 'object') return String(c.value);
  return c.status;
}

export function HealthPanel({
  health,
  at,
  error,
  loading,
  onRefetch,
}: {
  health: ObservatoryHealth | null;
  at: number | null;
  error: string | null;
  loading: boolean;
  onRefetch: () => void;
}) {
  // Prefer the reading's own stamp; the fetch clock is the fallback.
  const age: Age | null = ageOf(health?.at ?? at);

  return (
    <Panel
      label="instruments"
      age={age}
      onRefetch={onRefetch}
      extra={health ? (
        <span className="ob-dot-wrap">
          <StatusDot status={health.overall} />
          <span className="ob-age">{health.overall}</span>
        </span>
      ) : undefined}
    >
      {loading && !health ? (
        <LoadingPulse />
      ) : error && !health ? (
        <Unreachable error={error} />
      ) : health ? (
        <>
          <div className="ob-instruments">
            {health.checks.map(c => (
              <div className="ob-instrument" key={c.check}>
                <StatusDot
                  status={c.status}
                  reason={c.status === 'unavailable' ? (c.reason ?? 'no reading') : undefined}
                />
                <span className="ob-instrument-name">{c.check.replace(/_/g, ' ')}</span>
                <span className={`ob-instrument-value${c.status === 'unavailable' ? ' dim' : ''}`}>
                  {checkValue(c)}
                </span>
              </div>
            ))}
          </div>
          {health.telemetry_error && (
            <QuietNote>telemetry passthrough failed — {health.telemetry_error}; region counts below may be blank.</QuietNote>
          )}
        </>
      ) : null}
      <style>{`
        .ob-instruments {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
          gap: 0.5rem 1.5rem;
        }
        .ob-instrument {
          display: flex;
          align-items: baseline;
          gap: 0.55rem;
          min-width: 0;
        }
        .ob-instrument-name {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.66rem;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--text-secondary, #a09689);
          flex-shrink: 0;
          min-width: 9.5rem;
        }
        .ob-instrument-value {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.68rem;
          color: rgba(232, 224, 208, 0.55);
          overflow-wrap: anywhere;
        }
        .ob-instrument-value.dim { color: rgba(232, 224, 208, 0.28); font-style: italic; }
        @media (max-width: 600px) {
          .ob-instruments { grid-template-columns: 1fr; }
        }
      `}</style>
    </Panel>
  );
}
