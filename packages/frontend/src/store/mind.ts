import { create } from 'zustand';

// ─── Mind surface store ─────────────────────────────────────────────────────
// The /mind room's single data source (MIND-SURFACE-SPEC §Phase-1). One
// session-authed backend route returns the mind-shaped caches + freshness
// stamps; the browser NEVER holds the mind key — the backend proxies.
//
// LANE-A CONTRACT — GET /api/mind/surface (session-authed):
//   {
//     enabled: boolean,                      // the mind.enabled toggle
//     url?: string,                          // mind.url (base, no key)
//     key_fingerprint?: string | null,       // '••••42d8' style — never the key
//     weather?: {                            // mind.weather.latest cache
//       dominant, valence, arousal, texture,
//       front: { kind, days, avg_valence } | null,
//       startles: number, at: string,
//     } | null,
//     night?: {                              // mind.night.latest cache
//       dream: { id?, dream_date?, content?, emotional_seed?, recurrence_count? } | null,
//       risen: Array<{ content, cue, entity?, score? }>,
//       at: string,
//     } | null,
//     surface?: {                            // full living-surface cache
//       mood?, living_surface?: { drives?, unacked_startles?, risen_from_the_deep?,
//         weather_front?, pending_proposals?, orphan_count?, novelty_distribution?, ... },
//       recurring_patterns?: unknown[],
//       quiet_wants?: Array<{ body: string, at?: string }>,   // optional passthrough
//       at: string,
//     } | null,
//   }
//   enabled === false ⇒ the other blocks are absent (clean absence, no polls).
//
// TRANSITIONAL FALLBACK: if the route 404s (backend lane not landed yet in a
// dev window), we read `mind.enabled` from GET /api/settings so the sidebar
// gate still answers honestly. No data is fabricated — sections simply have
// nothing to render. Dies quietly once the route exists.

import { BASE } from '../lib/base';

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface MindFront {
  kind?: string;
  days?: number;
  avg_valence?: number;
}

export interface MindWeather {
  dominant?: string | null;
  valence?: number | null;
  arousal?: number | null;
  texture?: string | null;
  front?: MindFront | null;
  startles?: number;
  at?: string;
}

export interface MindDream {
  id?: number;
  dream_date?: string;
  content?: string;
  emotional_seed?: string | null;
  recurrence_count?: number;
}

export interface RisenMemory {
  content: string;
  cue: string;
  entity?: string | null;
  score?: number;
}

export interface MindNight {
  dream?: MindDream | null;
  risen?: RisenMemory[];
  at?: string;
}

export interface DriveGaugeEntry {
  drive: string;
  display_name: string;
  level: number;
  resting_toward: number;
  feel: string | null;
  panksepp_system?: string | null;
}

export interface DrivesGauge {
  updated_at?: string;
  env_freshness?: number;
  drives: DriveGaugeEntry[];
  open_wants?: number;
  note?: string;
}

export interface QuietWant {
  body: string;
  at?: string;
  charge?: number;
}

export interface LivingSurface {
  drives?: DrivesGauge;
  unacked_startles?: number;
  risen_from_the_deep?: RisenMemory[];
  weather_front?: MindFront | null;
  pending_proposals?: number;
  orphan_count?: number;
  novelty_distribution?: { high: number; medium: number; low: number };
}

export interface MindSurfaceBlob {
  mood?: MindWeather | null;
  living_surface?: LivingSurface | null;
  recurring_patterns?: unknown[];
  /** Optional passthrough — quiet-want bodies, if the backend carries them.
   *  The living-surface blob itself only holds the count; absent = count-only. */
  quiet_wants?: QuietWant[];
  processed_at?: string;
  at?: string;
}

export interface MindSurfaceResponse {
  enabled: boolean;
  url?: string;
  key_fingerprint?: string | null;
  weather?: MindWeather | null;
  night?: MindNight | null;
  surface?: MindSurfaceBlob | null;
}

// ── Store ───────────────────────────────────────────────────────────────────

interface MindState {
  /** null = not yet known (first fetch in flight); the sidebar hides /mind
   *  until this is literally true — clean absence, never an orphaned entry. */
  enabled: boolean | null;
  data: MindSurfaceResponse | null;
  /** When the last successful fetch landed (client clock) — the page's own
   *  "as of" is per-section from the cache stamps; this is just plumbing. */
  fetchedAt: number | null;
  loading: boolean;
  fetchSurface: () => Promise<void>;
}

export const useMindStore = create<MindState>((set, get) => ({
  enabled: null,
  data: null,
  fetchedAt: null,
  loading: false,

  async fetchSurface() {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await fetch(`${BASE}/api/mind/surface`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as MindSurfaceResponse;
        set({
          enabled: data.enabled !== false,
          data,
          fetchedAt: Date.now(),
          loading: false,
        });
        return;
      }
      if (res.status === 404) {
        // Route not landed yet — answer the gate from the config store.
        set({ enabled: await readEnabledFromSettings(), loading: false });
        return;
      }
      // Server error: keep a previously-known answer (its stamps carry the
      // age honestly); an unknown gate stays closed.
      set(s => ({ enabled: s.enabled ?? false, loading: false }));
    } catch {
      set(s => ({ enabled: s.enabled ?? false, loading: false }));
    }
  },
}));

/** Transitional: `mind.enabled` from the DB-config map. A missing key with a
 *  legacy `integrations.mind_api_key` present is treated as enabled so the
 *  live install doesn't lose its night shelf between the two lanes landing —
 *  Lane A's config seed makes this inference dead code. */
async function readEnabledFromSettings(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/settings`, { credentials: 'include' });
    if (!res.ok) return false;
    const { config } = (await res.json()) as { config?: Record<string, string> };
    if (!config) return false;
    if (config['mind.enabled'] !== undefined) return config['mind.enabled'] === 'true';
    return !!config['integrations.mind_api_key'];
  } catch {
    return false;
  }
}
