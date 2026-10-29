// ─── Observatory store — /mind/observatory data plumbing ────────────────────
// The deep wing's single fetch seam (MIND-SURFACE-SPEC Phase-2 pull-forward).
// Everything goes through the session-authed backend proxy at
// /api/mind/observatory/* — the mind key NEVER reaches the client. Read-only
// in v1: instruments, not a scalpel. No write verbs exist in this file on
// purpose; do not add any.
//
// PROXY-LANE CONTRACT (landed: backend/src/routes/mind-observatory.ts) —
// GET /api/mind/observatory/<mind-path> forwards allowlisted GETs to the mind
// worker's read API (READ-API MAP shapes):
//   /health            → enriched instruments: { enabled, at, overall,
//                        checks: HealthCheck[], telemetry, telemetry_error }
//   /graph             → assembled constellation { nodes, edges, at, counts, ageMin }
//   /entities          → /api/entities         (?type=&context=; whole table)
//   /observations      → /api/observations     (?entity_id=&weight=&charge=&limit=&offset=)
//   /observations/:id  → /api/observations/:id
//   /active/threads    → /api/threads          (?status=)
//   /compass           → /api/compass          ({count, rows})
//   /spine             → /api/identity         ({entries, tree})
//   /episodes/journals → /api/journals         (latest 100, upstream cap)
//   /weather/trend     → /api/weather/trend    (?days=)
//   /dreams/last       → /api/dreams/last
//   /dreams/patterns   → /api/patterns
//   /graph             → graph payload for ConstellationView (other lane)
//
// Honesty rules baked in here:
//   - 404 = the proxy route hasn't landed → sections say so, never white-screen.
//   - network / 5xx = the mind (or the house) is unreachable → sections say so.
//   - Every successful fetch carries its own `at` stamp (client clock) so
//     views can render data age; upstream stamps ride inside the payloads.

import { BASE } from '../lib/base';

// ── Not in this version ─────────────────────────────────────────────────────
// The backend has no /api/mind/observatory/* routes: the proxy named above did not come across from the
// reference app, and the current sanctum-mind has no read API of that shape (it speaks verbs). Until a
// Mind spec decides what the observatory reads, every call here answers "not available in this version"
// without a request, and each panel shows that one line. The paths and shapes in the contract above are
// exactly what the panels expect, kept as the list for that decision. Flip this when routes exist.
export const OBSERVATORY_BACKEND = false;
export const OBSERVATORY_UNAVAILABLE = 'not available in this version';

// ── Fetch seam ───────────────────────────────────────────────────────────────

export type ObsResult<T> =
  | { ok: true; data: T; at: number }
  | { ok: false; error: string; status?: number };

export async function fetchObservatory<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<ObsResult<T>> {
  if (!OBSERVATORY_BACKEND) return { ok: false, error: OBSERVATORY_UNAVAILABLE, status: 404 };
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
  }
  const query = qs.toString();
  const url = `${BASE}/api/mind/observatory${path}${query ? `?${query}` : ''}`;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) {
      const data = (await res.json()) as T;
      return { ok: true, data, at: Date.now() };
    }
    // The proxy speaks honest JSON on failure ({error, detail?}) — carry its
    // words through instead of inventing our own.
    let detail: string | null = null;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') detail = body.error;
    } catch { /* non-JSON failure body */ }
    if (res.status === 404) {
      return { ok: false, error: detail ?? 'not a window this observatory has (or the mind is off)', status: 404 };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'not authorized — session may have lapsed', status: res.status };
    }
    if (res.status === 503) {
      return { ok: false, error: detail ?? 'mind integration unconfigured', status: 503 };
    }
    if (res.status === 504) {
      return { ok: false, error: detail ?? 'the mind is unreachable (timeout)', status: 504 };
    }
    return { ok: false, error: detail ?? `the mind is unreachable (upstream ${res.status})`, status: res.status };
  } catch {
    return { ok: false, error: 'the house is unreachable — network error' };
  }
}

// ── Mind-worker row shapes (READ-API MAP, quoted not inferred) ──────────────

export interface ObsEntity {
  id: number;
  name: string;
  entity_type: string;
  primary_context: string | null;
  salience: string | null;
  created_at: string;
  updated_at: string | null;
  observation_count: number;
  [k: string]: unknown;
}

export interface ObsObservation {
  id: number;
  entity_id: number | null;
  content: string;
  salience?: string | null;
  emotion: string | null;
  weight: string | null;
  certainty?: string | null;
  source: string | null;
  context: string | null;
  charge: string | null;
  sit_count?: number | null;
  added_at: string;
  archived_at: string | null;
  superseded_by: number | null;
  supersedes: number | null;
  valid_until?: string | null;
  entity_name: string | null;
  entity_type: string | null;
  [k: string]: unknown;
}

export interface ObsThread {
  id: number;
  content: string;
  thread_type: string | null;
  priority: string | null;
  status: string;
  context: string | null;
  notes: string | null;
  created_at: string;
  updated_at?: string | null;
  resolved_at: string | null;
  [k: string]: unknown;
}

export interface CompassRow {
  id: number;
  kind: string;
  content: string;
  weight: number | null;
  asserted_count: number | null;
  last_asserted_at: string | null;
  source_identity_id: number | null;
  created_at: string;
  freshness: 'fresh' | 'stale' | 'unexercised';
  [k: string]: unknown;
}

export interface CompassResponse {
  count: number;
  rows: CompassRow[];
}

export interface SpineEntry {
  id: number;
  section: string;
  content: string;
  weight: number | null;
  connections: string | null;
  timestamp: string | null;
  [k: string]: unknown;
}

export interface SpineResponse {
  entries: SpineEntry[];
  tree: Record<string, SpineEntry[]>;
}

export interface JournalEntry {
  id: number;
  entry_date: string;
  content: string;
  tags: string | null;
  emotion: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export interface WeatherTrendDay {
  day: string;
  feeling: string;
  intensity: string;
  n: number;
}

export interface WeatherTrendResponse {
  days: number;
  trend: WeatherTrendDay[];
}

export interface DreamLastResponse {
  dream: {
    id?: number;
    dream_date?: string;
    content?: string;
    emotional_seed?: string | null;
    recurrence_count?: number;
  } | null;
}

export interface PatternsResponse {
  period_days: number;
  alive: Array<{ name: string; entity_type: string; obs_count: number }>;
  weights: Array<{ weight: string | null; count: number }>;
  charges: Array<{ charge: string | null; count: number }>;
  salience: Array<{ salience: string | null; count: number }>;
  foundational: Array<{ name: string; entity_type: string }>;
}

// ── Telemetry (the health instruments) — /api/telemetry shape ───────────────
// Every section optional: a missing section renders as an honest
// 'unavailable' instrument, never a fabricated zero.

export interface Telemetry {
  overall?: number;
  timestamp?: string;
  subconscious?: {
    score?: number;
    status?: string;
    age?: string | null;
    processed_at?: string | null;
    mood?: unknown;
    hot_entities_count?: number;
    identity_hunt_proposed?: number;
  };
  database?: {
    score?: number;
    entities?: number;
    observations?: number;
    relations?: number;
    by_context?: Array<{ context: string | null; count: number }>;
  };
  threads?: {
    score?: number;
    active?: number;
    stale_total?: number;
    resolved_7d?: number;
    cooling?: number;
    stale?: number;
    graveyard?: number;
  };
  journals?: { score?: number; total?: number; this_week?: number };
  identity?: {
    score?: number;
    entries?: number;
    context_entries?: number;
    relational_states?: number;
    unprocessed?: number;
  };
  spine?: { entries?: number };
  compass?: {
    entries?: number;
    by_kind?: Array<{ kind: string; count: number }>;
    edges?: number;
    fresh?: number;
    stale?: number;
    unexercised?: number;
  };
  bonds?: { warm?: number; cooling?: number; cold?: number; distant?: number; untouched?: number };
  activity?: { score?: number; new_observations_7d?: number; surfaced_7d?: number };
  living_surface?: {
    avg_novelty?: number | null;
    orphans_30d?: number;
    archived_obs?: number;
    pending_proposals?: number;
  };
  graph?: {
    score?: number;
    connected?: number;
    disconnected?: number;
    empty?: number;
    sparse_ripe?: number;
    hubs?: number;
    avg_degree?: number;
    max_degree?: number;
    total_entities?: number;
  };
  entity_salience?: { foundational?: number; active?: number; background?: number; archive?: number };
  visual_memory?: { images?: number };
}

// ── /health — the proxy's enriched instrument reading ───────────────────────
// Shape from mind-observatory.ts: named checks with honest 'unavailable'
// entries (reason strings), plus the full telemetry passthrough for counts.

export interface HealthCheck {
  check: string;
  status: 'ok' | 'warn' | 'fail' | 'unavailable';
  detail?: string;
  reason?: string; // set on 'unavailable'
  value?: unknown;
}

export interface ObservatoryHealth {
  enabled: boolean;
  at: string;
  overall: 'ok' | 'warn' | 'fail';
  checks: HealthCheck[];
  telemetry: Telemetry | null;
  telemetry_error: string | null;
}

export function fetchObservatoryHealth(): Promise<ObsResult<ObservatoryHealth>> {
  return fetchObservatory<ObservatoryHealth>('/health');
}
