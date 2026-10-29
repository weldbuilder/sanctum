// Google's OAuth redirect lands on http://localhost:<port>/api/google/auth/callback: no tenant hostname, no token (decision D6). So inside a
// tenant the `state` carries the tenant: state = <tenantId>:<nonce>:<marker>, where marker is the existing 'main' or 'health:<accountId>'.
// The nonce is random, lives in THAT tenant's database for ten minutes, and is spent by the callback. resolve.ts reads the tenant id out of
// the state and enters that tenant only if its own database knows the nonce; google-auth.ts checks it again and spends it.
// The redirect URI stays http://localhost:<port>/api/google/auth/callback for every tenant: each tenant registers that same URI with its own OAuth client.
// Tenancy off: none of this is used and the state stays 'main' / 'health:<accountId>', byte for byte.
import crypto from 'node:crypto';
import { getDb } from '../services/db.js';

export const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_RE = /^([a-z0-9][a-z0-9-]{0,31}):([0-9a-f]{32}):(.+)$/;

function ensure(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS google_oauth_state (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
}

/** A new state for the current tenant's consent URL, with its nonce stored. `marker` rides after the tenant prefix. */
export function issueTenantState(tenantId: string, marker: string, now = Date.now()): string {
  ensure();
  const db = getDb();
  db.prepare('DELETE FROM google_oauth_state WHERE expires_at < ?').run(now);
  const nonce = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO google_oauth_state (nonce, expires_at) VALUES (?, ?)').run(nonce, now + STATE_TTL_MS);
  return `${tenantId}:${nonce}:${marker}`;
}

export function parseTenantState(state: unknown): { tenantId: string; nonce: string; marker: string } | null {
  if (typeof state !== 'string') return null;
  const m = STATE_RE.exec(state);
  return m ? { tenantId: m[1], nonce: m[2], marker: m[3] } : null;
}

/** In the current tenant's database, and not expired. Read only. */
export function nonceExists(nonce: string, now = Date.now()): boolean {
  ensure();
  return !!getDb().prepare('SELECT 1 FROM google_oauth_state WHERE nonce = ? AND expires_at >= ?').get(nonce, now);
}

/** Spend the nonce: true once, false after (or if it was never there or has expired). */
export function consumeNonce(nonce: string, now = Date.now()): boolean {
  ensure();
  const r = getDb().prepare('DELETE FROM google_oauth_state WHERE nonce = ? AND expires_at >= ?').run(nonce, now);
  return r.changes > 0;
}
