import { Request, Response, NextFunction } from 'express';
import { parse as parseCookie } from 'cookie';
import crypto from 'crypto';
import {
  createWebSession,
  getWebSession,
  deleteExpiredSessions,
  getDb,
} from '../services/db.js';
import { getSanctumConfig } from '../config.js';
import { tenancyEnabled } from '../tenancy/context.js';
import { householdMode, houseSessions, housePassword } from '../tenancy/house.js';

const COOKIE_NAME = 'sanctum_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getCookieName(): string {
  return COOKIE_NAME;
}

// Household mode (tenancy/house.ts): the password is the house's (the process config's) and the sessions live in the house store, so these handlers
// need no current companion and the same cookie opens every companion. Everywhere else: the config and database the request is in, as always.
function authPassword(): string { return householdMode() ? housePassword() : getSanctumConfig().auth.password; }
function sessionFor(token: string): { expires_at: string } | null { return householdMode() ? houseSessions().get(token) : getWebSession(token); }
/** The session row for a cookie token, in whichever store holds this install's sessions (the house's in household mode). For the other code that checks a cookie. */
export function lookupSession(token: string): { expires_at: string } | null { return sessionFor(token); }

/** Explicit, dangerous, OFF-by-default local-dev escape hatch. When
 *  AUTH_DEV_OPEN=true AND no password is configured, protected routes pass
 *  through without a session. NEVER set this when the app is publicly reachable
 *  (e.g. behind the cloudflared tunnel) — it disables auth entirely. */
function devOpen(): boolean {
  // Tenant mode never opens: one process-wide variable would unseal every tenant that has no password yet.
  if (tenancyEnabled()) return false;
  return process.env.AUTH_DEV_OPEN === 'true';
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!authPassword()) {
    // FAIL CLOSED: an unset password must NOT mean "open". Without a configured
    // password there is no way to mint a valid session, so protected routes are
    // sealed (401) unless the explicit local-dev escape hatch is on.
    if (devOpen()) {
      next();
      return;
    }
    res.status(503).json({ error: 'Auth not configured — set APP_PASSWORD' });
    return;
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const cookies = parseCookie(cookieHeader);
  const sessionToken = cookies[COOKIE_NAME];

  if (!sessionToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const session = sessionFor(sessionToken);
  if (!session) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  if (new Date(session.expires_at) < new Date()) {
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  next();
}

export function loginHandler(req: Request, res: Response): void {
  const expected = authPassword();
  if (!expected) {
    res.status(500).json({ error: 'Authentication not configured' });
    return;
  }

  const { password } = req.body;
  if (!password) {
    res.status(400).json({ error: 'Password required' });
    return;
  }

  const inputBuffer = Buffer.from(password);
  const expectedBuffer = Buffer.from(expected);

  const maxLen = Math.max(inputBuffer.length, expectedBuffer.length);
  const paddedInput = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  inputBuffer.copy(paddedInput);
  expectedBuffer.copy(paddedExpected);

  const isValid = crypto.timingSafeEqual(paddedInput, paddedExpected) &&
                  inputBuffer.length === expectedBuffer.length;

  if (!isValid) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  if (householdMode()) houseSessions().deleteExpired(); else deleteExpiredSessions();

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  const row = {
    id: crypto.randomUUID(),
    token: sessionToken,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  if (householdMode()) houseSessions().create(row); else createWebSession(row);

  // secure/sameSite must reflect the ACTUAL request transport, NOT NODE_ENV.
  // NODE_ENV=production over plain HTTP (LAN / tailnet / pm2 without TLS) would
  // set a Secure cookie the browser silently drops — login appears to succeed
  // but the session cookie never sticks and the WS upgrade dies with a 401.
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? 'strict' : 'lax',
    maxAge: SESSION_DURATION_MS,
    path: '/',
  });

  res.json({ success: true });
}

export function logoutHandler(req: Request, res: Response): void {
  // The session row goes with the cookie (a stolen cookie value is dead the moment its owner signs out), in the store that holds it.
  try {
    const token = req.headers.cookie ? parseCookie(req.headers.cookie)[COOKIE_NAME] : undefined;
    if (token) deleteSessionRow(token);
  } catch (err) { console.warn('[auth] logout could not remove the session row:', (err as Error).message); }
  // Mirror the transport-based attributes the cookie was SET with, or the
  // clear won't target the same cookie.
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? 'strict' : 'lax',
    path: '/',
  });
  res.json({ success: true });
}

/** Remove one session row from the store that holds it (the house's, or the current database's). */
function deleteSessionRow(token: string): void {
  if (householdMode()) { houseSessions().delete(token); return; }
  getDb().prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
}

export function sessionCheckHandler(req: Request, res: Response): void {
  const authRequired = !!authPassword();
  // Household mode says so (the page needs to know whether to show the hallway or one companion); every other mode answers exactly as before.
  const mode = householdMode() ? { mode: 'household' as const } : {};
  if (!authRequired) {
    // No password configured. In dev-open mode the app is intentionally open
    // (auth_required:false). Otherwise we are FAIL-CLOSED: report that auth is
    // required but unconfigured so the UI can show "set APP_PASSWORD" rather
    // than falsely claiming the user is authenticated.
    if (devOpen()) {
      res.json({ authenticated: true, auth_required: false, ...mode });
      return;
    }
    res.json({ authenticated: false, auth_required: true, auth_unconfigured: true, ...mode });
    return;
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    res.json({ authenticated: false, ...mode });
    return;
  }

  const cookies = parseCookie(cookieHeader);
  const sessionToken = cookies[COOKIE_NAME];

  if (!sessionToken) {
    res.json({ authenticated: false, ...mode });
    return;
  }

  const session = sessionFor(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    res.json({ authenticated: false, ...mode });
    return;
  }

  res.json({ authenticated: true, ...mode });
}
