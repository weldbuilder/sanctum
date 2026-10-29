// Household mode (docs/MULTI-TENANT.md, "Household mode"): one login for the house, one folder of companions behind it, a path prefix per companion.
//
// What is the house's (this file): the password (the process config's auth.password, the same one a single-tenant install has), the sessions
// (<process data dir>/house.db, the web_sessions table and nothing else) and the list of companions. What stays per companion, exactly as built: the
// database, home, harness homes, channels, scheduler, Revien, the own-files layer. Nothing here reads a tenant's database.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { WebSession } from '@sanctum/shared';
import { openDb } from '../services/db.js';
import { HOUSE_SCOPE_ID, bootedTenants, currentTenant, getProcessConfig, type TenantRuntime } from './context.js';

let household = false;
let houseDb: Database.Database | null = null;
// Every tenant folder found at boot, in id order, whether or not it started (the companion list says which are unavailable).
let companionIds: string[] = [];

/** True once bootTenants has switched household mode on (`tenants.auth: household`, the default). Tenancy off, or per-tenant: false. */
export function householdMode(): boolean { return household; }

/** Open the house store in `dataDir` (the process's data folder) and switch household mode on. Expired sessions are purged, as a tenant's are at boot. */
export function enableHousehold(dataDir: string, ids: string[]): void {
  mkdirSync(dataDir, { recursive: true });
  closeHouse();
  houseDb = openDb(join(dataDir, 'house.db'));
  houseDb.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(new Date().toISOString());
  companionIds = [...ids];
  household = true;
}

/** Switch household mode off and close the house store (shutdown, and a test's teardown). */
export function closeHouse(): void {
  household = false;
  companionIds = [];
  if (houseDb) { try { houseDb.close(); } catch { /* already closed */ } houseDb = null; }
}

/** The tenant folders found at boot (ids), booted or not. */
export function houseCompanionIds(): string[] { return [...companionIds]; }

/** Where the house store lives for a process config (next to the process's own database path). */
export function houseDataDir(processDbPath: string): string { return dirname(processDbPath); }

/** The house password: the process config's auth.password. Empty when none is set. */
export function housePassword(): string {
  try { return getProcessConfig().auth.password || ''; } catch { return ''; }
}

/** Hand the house password to every booted companion's config, so the code that reads `getSanctumConfig().auth.password` for "is a login set" (the
 *  setup gate, Settings, the boot line) says what the house says. Their own .env APP_PASSWORD is never read as a login in household mode. */
export function syncHousePassword(): void {
  const pw = housePassword();
  for (const rt of bootedTenants()) rt.config.auth.password = pw;
}

export interface SessionStore {
  create(p: { id: string; token: string; createdAt: string; expiresAt: string }): WebSession;
  get(token: string): WebSession | null;
  deleteExpired(): void;
  delete(token: string): void;
  deleteExcept(keepToken: string | null): number;
}

function houseHandle(): Database.Database {
  if (!houseDb) throw new Error('the house store is not open (household mode is off)');
  return houseDb;
}

/** The house's session store (house.db). Household mode only: authMiddleware, login, logout, the session check and the websocket read it there, and nothing
 *  else touches it. */
export function houseSessions(): SessionStore {
  return {
    create(p) {
      houseHandle().prepare('INSERT INTO web_sessions (id, token, created_at, expires_at) VALUES (?, ?, ?, ?)').run(p.id, p.token, p.createdAt, p.expiresAt);
      return { id: p.id, token: p.token, created_at: p.createdAt, expires_at: p.expiresAt };
    },
    get(token) {
      const row = houseHandle().prepare('SELECT * FROM web_sessions WHERE token = ?').get(token);
      return row ? (row as unknown as WebSession) : null;
    },
    deleteExpired() { houseHandle().prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(new Date().toISOString()); },
    delete(token) { houseHandle().prepare('DELETE FROM web_sessions WHERE token = ?').run(token); },
    deleteExcept(keep) { return Number(houseHandle().prepare('DELETE FROM web_sessions WHERE token IS NOT ?').run(keep).changes); },
  };
}

let scope: TenantRuntime | null = null;
/** A store for the house's own code that keeps tenantLocal state (the first-run setup code). It carries the process config and the house database; it is
 *  never registered as a tenant and its id cannot be a tenant's. */
export function houseScope(): TenantRuntime {
  if (!scope || scope.db !== houseDb) {
    scope = {
      id: HOUSE_SCOPE_ID, dir: '', dataDir: '', homeDir: '', privateDir: '', hosts: [], config: getProcessConfig(), env: {}, db: houseHandle(),
      token: '', locals: new Map(), services: {}, reload() { /* nothing */ }, setPassword() { /* nothing */ },
    };
  }
  return scope;
}

/** A server-issued path (`/api/files/<id>`) as the browser must use it: in household mode, inside a companion, `/c/<id>/api/files/<id>`; every other
 *  mode (and any path that does not start with `/api/`) is returned as given. Call it where the URL is MADE, so stored history keeps what was made. */
export function companionPath(path: string): string {
  if (!household || !(path.startsWith('/api/') || path === '/chat')) return path; // (static files such as /logo.png are the house's, never prefixed; /chat is a page the push click opens)
  const rt = currentTenant();
  return rt && rt.id !== HOUSE_SCOPE_ID ? `/c/${rt.id}${path}` : path;
}

/** The inverse, for a URL the browser sends back: the current companion's own prefix is removed (what is stored is the plain form). */
export function plainPath(path: string): string {
  if (!household) return path;
  const rt = currentTenant();
  const prefix = rt && rt.id !== HOUSE_SCOPE_ID ? `/c/${rt.id}` : '';
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}
