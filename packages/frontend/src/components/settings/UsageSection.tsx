/**
 * Usage & Model section.
 * Read-only model display from GET /api/models.
 * Token-usage summary from GET /api/usage?days=N.
 *
 * No fabricated numbers — when usage is empty/zero, shows a graceful "no usage
 * logged yet" state. Uses plain fetch (no chat store dependency).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Card, Group, Eyebrow, FieldRow, StatCard, Spinner, EmptyState } from './primitives';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  label: string;
  tier?: string;
}

interface ModelsResponse {
  models: ModelEntry[];
  current: string;
  currentAutonomous: string;
}

interface PerDay {
  date: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  turns?: number;
}

interface PerModel {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  turns?: number;
}

interface UsageResponse {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  turns: number;
  windowDays: number;
  perDay: PerDay[];
  perModel: PerModel[];
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatTokens(n: number | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}

function formatCost(n: number | undefined): string {
  const v = n ?? 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function shortDate(iso: string): string {
  // Accept "2026-06-16" or full ISO — keep the MM-DD tail.
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[2]}/${m[3]}`;
  return iso;
}

// ─── Window options ───────────────────────────────────────────────────────────

const WINDOWS = [7, 14, 30, 90];

// ─── Component ────────────────────────────────────────────────────────────────

export function UsageSection({ base }: { base: string }) {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [days, setDays] = useState(30);
  const [loadingModels, setLoadingModels] = useState(true);
  const [loadingUsage, setLoadingUsage] = useState(true);

  // ── Load models (once) ──
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(`${base}/api/models`);
        if (res.ok) {
          const data = await res.json();
          if (alive && data && Array.isArray(data.models)) {
            setModels(data as ModelsResponse);
          }
        }
      } catch { /* backend not up */ }
      if (alive) setLoadingModels(false);
    }
    load();
    return () => { alive = false; };
  }, [base]);

  // ── Load usage (per window) ──
  const loadUsage = useCallback(async (windowDays: number) => {
    setLoadingUsage(true);
    try {
      const res = await fetch(`${base}/api/usage?days=${windowDays}`);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.totalInputTokens === 'number') {
          setUsage(data as UsageResponse);
        }
      }
    } catch { /* backend not up */ }
    setLoadingUsage(false);
  }, [base]);

  useEffect(() => { loadUsage(days); }, [days, loadUsage]);

  // ── Model label lookup ──
  const labelFor = (id: string): string => {
    const found = models?.models.find(m => m.id === id);
    return found?.label ?? id;
  };
  const tierFor = (id: string): string | undefined =>
    models?.models.find(m => m.id === id)?.tier;

  // ── Derived: has any usage at all? ──
  const hasUsage =
    !!usage &&
    (usage.totalInputTokens > 0 ||
      usage.totalOutputTokens > 0 ||
      usage.totalCacheCreationTokens > 0 ||
      usage.totalCacheReadTokens > 0 ||
      usage.turns > 0);

  // ── Max per-day total for bar scaling ──
  const perDayTotals = (usage?.perDay ?? []).map(d =>
    (d.inputTokens ?? 0) + (d.outputTokens ?? 0) +
    (d.cacheCreationTokens ?? 0) + (d.cacheReadTokens ?? 0)
  );
  const maxDayTotal = Math.max(1, ...perDayTotals);

  return (
    <div className="usage-section">

      {/* ── Active models (read-only) ── */}
      <Eyebrow label="active models" sub="read-only" />
      <Group>
        {loadingModels ? (
          <div className="usage-loading"><Spinner /><span className="sp-empty-text">Loading models…</span></div>
        ) : models ? (
          <>
            <FieldRow
              label="interactive"
              value={labelFor(models.current)}
              sub={tierFor(models.current)}
              mono
            />
            <FieldRow
              label="autonomous"
              value={labelFor(models.currentAutonomous)}
              sub={tierFor(models.currentAutonomous)}
              mono
            />
          </>
        ) : (
          <EmptyState message="Model info unavailable." />
        )}
      </Group>

      {/* ── Available models ── */}
      {models && models.models.length > 0 && (
        <>
          <Eyebrow label="available models" />
          <Group>
            {models.models.map(m => (
              <FieldRow
                key={m.id}
                label={m.label}
                value={m.id}
                sub={m.tier}
                mono
              />
            ))}
          </Group>
        </>
      )}

      {/* ── Usage window selector ── */}
      <div className="usage-eyebrow-row">
        <Eyebrow label="token usage" sub={usage ? `${usage.windowDays}d window` : undefined} />
        <div className="usage-window-tabs" role="tablist" aria-label="Usage window">
          {WINDOWS.map(w => (
            <button
              key={w}
              role="tab"
              aria-selected={days === w}
              className={`usage-window-tab${days === w ? ' active' : ''}`}
              onClick={() => setDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      <Card>
        {loadingUsage && !usage ? (
          <div className="usage-loading"><Spinner /><span className="sp-empty-text">Loading usage…</span></div>
        ) : !hasUsage ? (
          <EmptyState message="No usage logged yet — token counts will appear here once sessions run." />
        ) : (
          <div className="usage-totals">
            <div className="sp-stat-grid usage-stat-grid">
              <StatCard label="input" value={formatTokens(usage!.totalInputTokens)} />
              <StatCard label="output" value={formatTokens(usage!.totalOutputTokens)} />
              <StatCard label="cache write" value={formatTokens(usage!.totalCacheCreationTokens)} />
              <StatCard label="cache read" value={formatTokens(usage!.totalCacheReadTokens)} />
              <StatCard label="turns" value={usage!.turns} />
              <StatCard label="cost" value={formatCost(usage!.totalCostUsd)} />
            </div>
          </div>
        )}
      </Card>

      {/* ── Per-day breakdown (minimal bars) ── */}
      {hasUsage && usage!.perDay.length > 0 && (
        <>
          <Eyebrow label="per day" />
          <Card>
            <div className="usage-bars">
              {usage!.perDay.map(d => {
                const total =
                  (d.inputTokens ?? 0) + (d.outputTokens ?? 0) +
                  (d.cacheCreationTokens ?? 0) + (d.cacheReadTokens ?? 0);
                const pct = Math.max(2, Math.round((total / maxDayTotal) * 100));
                return (
                  <div className="usage-bar-row" key={d.date}>
                    <span className="usage-bar-date">{shortDate(d.date)}</span>
                    <div className="usage-bar-track">
                      <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="usage-bar-val">{formatTokens(total)}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}

      {/* ── Per-model breakdown ── */}
      {hasUsage && usage!.perModel.length > 0 && (
        <>
          <Eyebrow label="per model" />
          <Group>
            {usage!.perModel.map(pm => {
              const total =
                (pm.inputTokens ?? 0) + (pm.outputTokens ?? 0) +
                (pm.cacheCreationTokens ?? 0) + (pm.cacheReadTokens ?? 0);
              return (
                <FieldRow
                  key={pm.model}
                  label={labelFor(pm.model)}
                  value={`${formatTokens(total)} tok · ${formatCost(pm.costUsd)}`}
                  sub={pm.turns ? `${pm.turns} turns` : undefined}
                  mono
                />
              );
            })}
          </Group>
        </>
      )}

      <style>{`
        .usage-section { padding-bottom: 2rem; }

        .usage-loading {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 1rem 0;
        }

        .usage-eyebrow-row {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 0.75rem;
        }
        .usage-eyebrow-row .sp-eyebrow { flex: 1; }

        .usage-window-tabs {
          display: flex;
          gap: 0.1875rem;
          margin-bottom: 0.75rem;
          flex-shrink: 0;
        }
        .usage-window-tab {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.04em;
          color: var(--text-muted, #6a6258);
          background: transparent;
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 0.375rem;
          padding: 0.1875rem 0.5rem;
          cursor: pointer;
          transition: color 200ms var(--hearth-curve, ease), border-color 200ms var(--hearth-curve, ease), background 200ms var(--hearth-curve, ease);
        }
        .usage-window-tab:hover {
          color: var(--text-secondary, #a09689);
          border-color: rgba(255,255,255,0.12);
        }
        .usage-window-tab.active {
          color: var(--amber, #c9a87c);
          background: rgba(201,168,124,0.10);
          border-color: rgba(201,168,124,0.30);
        }

        .usage-totals { padding: 0.875rem 0; }
        .usage-stat-grid {
          grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
        }

        .usage-bars {
          display: flex;
          flex-direction: column;
          gap: 0.4375rem;
          padding: 0.875rem 0;
        }
        .usage-bar-row {
          display: flex;
          align-items: center;
          gap: 0.625rem;
        }
        .usage-bar-date {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          width: 2.75rem;
          flex-shrink: 0;
        }
        .usage-bar-track {
          flex: 1;
          height: 0.4375rem;
          background: rgba(255,255,255,0.04);
          border-radius: 99px;
          overflow: hidden;
          min-width: 0;
        }
        .usage-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, rgba(201,168,124,0.45), rgba(201,168,124,0.85));
          border-radius: 99px;
          transition: width 420ms var(--hearth-curve, ease);
        }
        .usage-bar-val {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--amber-bright, #e3c49a);
          width: 3rem;
          text-align: right;
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}
