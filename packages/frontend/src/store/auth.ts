import { create } from 'zustand';

// ─── Auth store ───────────────────────────────────────────────────────────────
// Thin layer over the three /api/auth/* endpoints.
// All other stores/components read `useAuthStore` to know if they may proceed.
//
// The backend contract (auth.ts):
//   GET  /api/auth/check  → { authenticated: bool, auth_required?: bool, auth_unconfigured?: bool, mode?: 'household' }
//   POST /api/auth/login  ← { password: string }  → { success: true } + Set-Cookie
//   POST /api/auth/logout → { success: true }      + clears cookie

const BASE = import.meta.env.DEV ? 'http://127.0.0.1:3099' : '';

export type AuthStatus =
  | 'checking'          // initial check in flight
  | 'authenticated'     // session cookie valid
  | 'unauthenticated'   // password required, not yet provided
  | 'unconfigured';     // APP_PASSWORD not set on server (shouldn't happen in prod)

interface AuthState {
  status: AuthStatus;
  loginError: string | null;
  loggingIn: boolean;
  /** True when the server says it runs household mode (one login, a path prefix per companion): GET /api/auth/check answers `mode: 'household'`. */
  household: boolean;

  // Actions
  checkAuth: () => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'checking',
  loginError: null,
  loggingIn: false,
  household: false,

  async checkAuth() {
    set({ status: 'checking' });
    try {
      const res = await fetch(`${BASE}/api/auth/check`, { credentials: 'include' });
      const data = await res.json() as {
        authenticated: boolean;
        auth_required?: boolean;
        auth_unconfigured?: boolean;
        mode?: string;
      };
      set({ household: data.mode === 'household' });
      if (data.authenticated) {
        set({ status: 'authenticated' });
      } else if (data.auth_unconfigured) {
        set({ status: 'unconfigured' });
      } else {
        set({ status: 'unauthenticated' });
      }
    } catch {
      // Network error — show login (better than hanging on 'checking')
      set({ status: 'unauthenticated' });
    }
  },

  async login(password: string) {
    set({ loggingIn: true, loginError: null });
    try {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Cookie is now set — re-check to confirm + transition to authenticated
        await get().checkAuth();
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        set({
          loginError: data.error === 'Invalid password'
            ? "That's not the password."
            : (data.error ?? 'Login failed — try again.'),
          loggingIn: false,
        });
      }
    } catch {
      set({ loginError: 'Could not reach the server. Is it running?', loggingIn: false });
    }
  },

  async logout() {
    try {
      await fetch(`${BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      // Best-effort
    }
    set({ status: 'unauthenticated', loginError: null });
  },
}));
