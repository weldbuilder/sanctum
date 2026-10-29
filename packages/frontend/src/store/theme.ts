/**
 * Runtime theme store — live CSS-variable overrides, no rebuild.
 *
 * v1 did theming at build-time (copy a CSS file, @import it, rebuild). This
 * replaces that with instant `document.documentElement.style.setProperty`
 * injection, persisted server-side (GET/PUT /api/theme, backed by the same
 * `config` key/value store every other setting uses) and cached in
 * localStorage so a reload doesn't flash back to defaults while the fetch
 * is in flight.
 *
 * The token list here is the editable subset of packages/frontend/src/index.css
 * :root (~104 tokens total) — curated to the ones components actually
 * reference by bare name, so an override genuinely cascades. Mirrored on the
 * backend (THEME_TOKEN_ALLOWLIST in packages/backend/src/routes/api.ts) —
 * keep both lists in sync if the editable set ever changes.
 */
import { create } from 'zustand';

import { BASE } from '../lib/base';
const CACHE_KEY = 'sanctum.themeOverrides';

import { THEME_TOKENS, FONT_CHOICES, type ThemeToken, type ThemeTokenKind } from '../theme/tokens';
import { setLegacyOverrides } from '../theme/apply';
export { THEME_TOKENS, FONT_CHOICES };
export type { ThemeToken, ThemeTokenKind };

/** Hand the legacy override set to the one applicator; it decides whether they apply (they do for Hedgewitch, not under a skin). */
function applyToDom(overrides: Record<string, string>): void {
  setLegacyOverrides(overrides);
}

function writeCache(overrides: Record<string, string>): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(overrides)); } catch { /* best-effort */ }
}

interface ThemeState {
  overrides: Record<string, string>;
  /** True once the server round-trip has resolved (success or failure) — the
   *  editor can wait for this before rendering so it never shows a value
   *  about to be overwritten by the fetch. */
  loaded: boolean;
  /** Apply synchronously from localStorage, before the network fetch resolves
   *  — called at module init in main.tsx to avoid a flash of default theme. */
  loadCache: () => void;
  /** GET /api/theme, then apply + re-cache. */
  fetchTheme: () => Promise<void>;
  /** Live-apply one token (editor calls this per keystroke/pick) + re-cache.
   *  Does NOT hit the network — callers debounce their own PUT via saveTheme. */
  setToken: (key: string, value: string) => void;
  /** Replace the whole override set (used by reset). */
  applyAll: (overrides: Record<string, string>) => void;
  /** PUT /api/theme. Returns whether it succeeded. */
  saveTheme: (overrides: Record<string, string>) => Promise<boolean>;
  /** Clear every override, locally and server-side. */
  resetTheme: () => Promise<boolean>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  overrides: {},
  loaded: false,

  loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        applyToDom(parsed);
        set({ overrides: parsed });
      }
    } catch { /* corrupt cache — ignore, defaults stand */ }
  },

  async fetchTheme() {
    try {
      const res = await fetch(`${BASE}/api/theme`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { overrides?: Record<string, string> };
        get().applyAll(data.overrides ?? {});
      }
    } catch { /* offline / not-yet-up — cached or default theme stands */ }
    set({ loaded: true });
  },

  setToken(key, value) {
    const next = { ...get().overrides, [key]: value };
    applyToDom(next);
    set({ overrides: next });
    writeCache(next);
  },

  applyAll(overrides) {
    applyToDom(overrides);
    set({ overrides });
    writeCache(overrides);
  },

  async saveTheme(overrides) {
    try {
      const res = await fetch(`${BASE}/api/theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ overrides }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async resetTheme() {
    get().applyAll({});
    return get().saveTheme({});
  },
}));

/** rgba()/hex → 6-digit hex, for seeding a native <input type="color">, which
 *  can't represent alpha. Alpha is dropped for display only — the stored
 *  override the user picks afterward is a plain opaque hex, same as every
 *  other token. Falls back to black on anything unparseable. */
export function toHexColor(value: string): string {
  const v = (value || '').trim();
  if (v.startsWith('#')) {
    if (v.length === 4) return '#' + [1, 2, 3].map(i => v[i] + v[i]).join('');
    if (v.length >= 7) return v.slice(0, 7);
    return '#000000';
  }
  const m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}
