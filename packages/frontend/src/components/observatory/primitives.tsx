/**
 * Observatory primitives — shared bones for the deep wing.
 *
 * Read-only doctrine (v1): nothing in this file renders a write affordance.
 * Instruments, not a scalpel.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { OBSERVATORY_UNAVAILABLE, type ObsResult } from '../../store/observatory';

export const STALE_MS = 2 * 60 * 60 * 1000; // >2h = the view says so

// ─── Age idiom (same contract as MindView's) ────────────────────────────────

export interface Age {
  label: string;
  stale: boolean;
}

export function ageOf(iso: string | number | undefined | null): Age | null {
  if (iso === undefined || iso === null || iso === '') return null;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return null;
  const label = ms < 60_000
    ? 'just now'
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)}m ago`
      : ms < 86_400_000
        ? `${(ms / 3_600_000).toFixed(1)}h ago`
        : `${Math.round(ms / 86_400_000)}d ago`;
  return { label, stale: ms > STALE_MS };
}

export function AgeStamp({ age, prefix }: { age: Age | null; prefix?: string }) {
  if (!age) return null;
  return (
    <span className={`ob-age${age.stale ? ' stale' : ''}`}>
      {prefix ? `${prefix} ` : ''}{age.label}
      {age.stale && ' · stale'}
    </span>
  );
}

// ─── Status dots — ok / warn / fail / unavailable ───────────────────────────
// 'unavailable' is honest absence: dim, with the reason on tap (title +
// click-to-toggle, no hover-only information). 'fail' comes from the proxy's
// health checks; it is still just a reading — no alarms fire from here.

export type ObsStatus = 'ok' | 'warn' | 'fail' | 'unavailable';

export function statusFromScore(score: number | undefined | null): ObsStatus {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'unavailable';
  return score >= 70 ? 'ok' : 'warn';
}

export function StatusDot({ status, reason }: { status: ObsStatus; reason?: string }) {
  const [showReason, setShowReason] = useState(false);
  const label = status === 'unavailable' ? (reason || 'unavailable') : status;
  return (
    <span className="ob-dot-wrap">
      <span
        className={`ob-dot ob-dot-${status}`}
        title={label}
        role="img"
        aria-label={label}
        onClick={status === 'unavailable' && reason ? () => setShowReason(s => !s) : undefined}
        style={status === 'unavailable' && reason ? { cursor: 'pointer' } : undefined}
      />
      {showReason && reason && <span className="ob-dot-reason">{reason}</span>}
    </span>
  );
}

// ─── Fetch-on-visit hook ────────────────────────────────────────────────────
// READ-when-visit (v1 decision): fetches on mount and on explicit refetch,
// never polls, never alarms.

export interface ObsData<T> {
  data: T | null;
  at: number | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

export function useObsData<T>(fetcher: () => Promise<ObsResult<T>>, deps: unknown[] = []): ObsData<T> {
  const [data, setData] = useState<T | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void fetcher().then(res => {
      if (!live) return;
      if (res.ok) {
        setData(res.data);
        setAt(res.at);
        setError(null);
      } else {
        setError(res.error);
      }
      setLoading(false);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const refetch = useCallback(() => setTick(t => t + 1), []);
  return { data, at, error, loading, refetch };
}

// ─── Graceful absence / unreachable rendering ───────────────────────────────

export function Unreachable({ error }: { error: string }) {
  // No backend for this panel in this version: one quiet line, not an outage.
  if (error === OBSERVATORY_UNAVAILABLE) return <div className="ob-unreachable">{OBSERVATORY_UNAVAILABLE}</div>;
  return <div className="ob-unreachable">unreachable — {error}</div>;
}

export function QuietNote({ children }: { children: React.ReactNode }) {
  return <div className="ob-quiet">{children}</div>;
}

export function LoadingPulse() {
  return (
    <div className="ob-loading" aria-label="loading">
      <span className="ob-pulse" />
    </div>
  );
}

// ─── Panel shell — eyebrow label + age + refetch, then content ──────────────

export function Panel({
  label,
  age,
  onRefetch,
  extra,
  children,
}: {
  label: string;
  age?: Age | null;
  onRefetch?: () => void;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ob-panel" aria-label={label}>
      <div className="ob-panel-head">
        <span className="ob-eyebrow">{label}</span>
        <span className="ob-panel-meta">
          {extra}
          {age !== undefined && <AgeStamp age={age ?? null} prefix="read" />}
          {onRefetch && (
            <button type="button" className="ob-refetch" onClick={onRefetch}>reread</button>
          )}
        </span>
      </div>
      {children}
    </section>
  );
}

// ─── Pager — honest pagination (no fabricated totals) ───────────────────────

export function Pager({
  offset,
  limit,
  count,
  total,
  onPage,
}: {
  offset: number;
  limit: number;
  count: number;       // rows actually returned this page
  total?: number | null; // only when upstream reports one
  onPage: (offset: number) => void;
}) {
  const page = Math.floor(offset / limit) + 1;
  const hasPrev = offset > 0;
  // Without a total, "next" exists only when the page came back full.
  const hasNext = typeof total === 'number' ? offset + count < total : count >= limit;
  return (
    <div className="ob-pager">
      <button type="button" className="ob-page-btn" disabled={!hasPrev} onClick={() => onPage(Math.max(0, offset - limit))}>
        ← prev
      </button>
      <span className="ob-page-label">
        page {page}
        {typeof total === 'number' ? ` · ${total} total` : count < limit ? ' · end' : ''}
      </span>
      <button type="button" className="ob-page-btn" disabled={!hasNext} onClick={() => onPage(offset + limit)}>
        next →
      </button>
    </div>
  );
}

// ─── Expandable prose cell — serif where prose lives ────────────────────────

export function ProseCell({ text, max = 140 }: { text: string; max?: number }) {
  const [open, setOpen] = useState(false);
  const needsFold = text.length > max;
  return (
    <span
      className={`ob-prose${needsFold ? ' foldable' : ''}`}
      onClick={needsFold ? () => setOpen(o => !o) : undefined}
      title={needsFold && !open ? 'tap to unfold' : undefined}
    >
      {open || !needsFold ? text : `${text.slice(0, max).trimEnd()}…`}
    </span>
  );
}

// ─── Shared styles — mono where data, serif where prose ─────────────────────

export function ObservatoryStyles() {
  return (
    <style>{`
      /* ── shared observatory grammar ── */
      .ob-eyebrow {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.62rem;
        letter-spacing: 0.28em;
        text-transform: uppercase;
        color: rgba(232, 224, 208, 0.38);
      }
      .ob-age {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.62rem;
        letter-spacing: 0.06em;
        color: var(--text-muted, #6a6258);
      }
      .ob-age.stale { color: #d4a843; }

      .ob-panel {
        margin-bottom: 1.25rem;
        padding: 1.1rem 1.4rem 1.2rem;
        border: 1px solid rgba(232, 224, 208, 0.08);
        border-radius: 0.5rem;
        background: rgba(20, 16, 12, 0.35);
      }
      .ob-panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 0.8rem;
        flex-wrap: wrap;
      }
      .ob-panel-meta {
        display: inline-flex;
        align-items: baseline;
        gap: 0.75rem;
      }
      .ob-refetch {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.62rem;
        letter-spacing: 0.08em;
        color: var(--amber-dim, #a08960);
        background: transparent;
        border: none;
        padding: 0;
        cursor: pointer;
      }
      .ob-refetch:hover { color: var(--amber, #c9a87c); }

      .ob-dot-wrap { display: inline-flex; align-items: baseline; gap: 0.4rem; }
      .ob-dot {
        display: inline-block;
        width: 0.4375rem;
        height: 0.4375rem;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .ob-dot-ok   { background: rgba(150, 180, 120, 0.85); }
      .ob-dot-warn { background: #d4a843; }
      .ob-dot-fail { background: rgba(200, 100, 90, 0.9); }
      .ob-dot-unavailable {
        background: transparent;
        border: 1px solid rgba(232, 224, 208, 0.25);
      }
      .ob-dot-reason {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.62rem;
        color: var(--text-muted, #6a6258);
        font-style: italic;
      }

      .ob-unreachable {
        font-style: italic;
        font-size: 0.8125rem;
        color: rgba(212, 168, 67, 0.8);
        padding: 0.75rem 0;
      }
      .ob-quiet {
        font-style: italic;
        font-size: 0.78rem;
        color: var(--text-muted, #6a6258);
        margin-top: 0.35rem;
      }
      .ob-loading { display: flex; align-items: center; justify-content: center; padding: 2rem 0; }
      .ob-pulse {
        width: 0.375rem; height: 0.375rem; border-radius: 50%;
        background: var(--amber-dim, #a08960);
        animation: ob-pulse 1.4s ease-in-out infinite;
      }
      @keyframes ob-pulse {
        0%, 100% { opacity: 0.3; transform: scale(0.8); }
        50%       { opacity: 1;   transform: scale(1); }
      }

      /* ── tables: mono where data ── */
      .ob-table-wrap { overflow-x: auto; }
      .ob-table {
        width: 100%;
        border-collapse: collapse;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.72rem;
      }
      .ob-table th {
        text-align: left;
        font-weight: 400;
        font-size: 0.6rem;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(232, 224, 208, 0.35);
        padding: 0.3rem 0.75rem 0.3rem 0;
        border-bottom: 1px solid rgba(232, 224, 208, 0.08);
        white-space: nowrap;
      }
      .ob-table td {
        padding: 0.4rem 0.75rem 0.4rem 0;
        border-bottom: 1px solid rgba(232, 224, 208, 0.045);
        color: rgba(232, 224, 208, 0.6);
        vertical-align: top;
      }
      .ob-table tr.archived td { opacity: 0.45; }
      .ob-num { color: rgba(232, 224, 208, 0.4); }

      /* serif where prose */
      .ob-prose {
        font-family: var(--font-serif, 'Lora', serif);
        font-size: 0.82rem;
        line-height: 1.5;
        color: rgba(232, 224, 208, 0.72);
      }
      .ob-prose.foldable { cursor: pointer; }
      .ob-prose.foldable:hover { color: rgba(232, 224, 208, 0.88); }

      .ob-chip {
        display: inline-block;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.58rem;
        letter-spacing: 0.06em;
        padding: 0.06rem 0.35rem;
        border-radius: 0.25rem;
        border: 1px solid rgba(232, 224, 208, 0.14);
        color: rgba(232, 224, 208, 0.5);
        white-space: nowrap;
      }
      .ob-chip-link {
        border-color: rgba(201, 168, 124, 0.3);
        color: var(--amber, #c9a87c);
        cursor: pointer;
        background: transparent;
      }
      .ob-chip-link:hover { border-color: rgba(201, 168, 124, 0.6); }
      .ob-chip-warn { border-color: rgba(212, 168, 67, 0.4); color: #d4a843; }

      /* pager */
      .ob-pager {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-top: 0.9rem;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.66rem;
      }
      .ob-page-btn {
        background: transparent;
        border: 1px solid rgba(232, 224, 208, 0.12);
        border-radius: 0.3rem;
        color: var(--text-secondary, #a09689);
        font: inherit;
        padding: 0.2rem 0.6rem;
        cursor: pointer;
      }
      .ob-page-btn:hover:not(:disabled) { border-color: rgba(201, 168, 124, 0.4); color: var(--amber, #c9a87c); }
      .ob-page-btn:disabled { opacity: 0.3; cursor: default; }
      .ob-page-label { color: var(--text-muted, #6a6258); }

      /* inline read-only peek (supersede-chain hops) */
      .ob-peek {
        border: 1px solid rgba(201, 168, 124, 0.22);
        border-radius: 0.4rem;
        background: rgba(24, 20, 15, 0.55);
        padding: 0.75rem 0.9rem;
        margin-bottom: 0.9rem;
      }
      .ob-peek-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 0.45rem;
      }
      .ob-peek-meta {
        display: flex;
        gap: 0.35rem;
        flex-wrap: wrap;
        margin-top: 0.5rem;
      }

      /* filters */
      .ob-filters {
        display: flex;
        gap: 0.6rem;
        flex-wrap: wrap;
        margin-bottom: 0.8rem;
      }
      .ob-filter-input, .ob-filter-select {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.68rem;
        background: rgba(12, 11, 9, 0.6);
        border: 1px solid rgba(232, 224, 208, 0.12);
        border-radius: 0.3rem;
        color: var(--text-primary, #e2dbd0);
        padding: 0.3rem 0.5rem;
        max-width: 10rem;
      }
      .ob-filter-input::placeholder { color: var(--text-muted, #6a6258); }
      .ob-filter-input:focus, .ob-filter-select:focus {
        outline: none;
        border-color: rgba(201, 168, 124, 0.4);
      }
    `}</style>
  );
}
