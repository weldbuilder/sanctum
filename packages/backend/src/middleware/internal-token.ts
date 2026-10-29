// Internal-token gate for the server-internal routes (/api/internal/*).
//
// The server may listen on a Tailscale or LAN address instead of loopback
// (server.host). Nothing here assumes where the caller connects from: the
// shared secret below is the whole gate.
//
// WHY THIS EXISTS: the old guard for these routes was a source-IP check
// (req.socket.remoteAddress === '127.0.0.1'). That is DEFEATED behind a
// cloudflared tunnel — cloudflared forwards every PUBLIC request FROM loopback,
// so a tunnelled attacker reads as local. These routes are called ONLY by the
// in-app agent (its SDK MCP http transport) and the `res` CLI, never by a
// browser user. So the correct gate is a server-internal SHARED SECRET, not
// the source IP.
//
// The token is generated/loaded once at boot:
//   1. env INTERNAL_TOKEN (power-user / explicit override), else
//   2. an auto-generated 32-byte hex persisted to a gitignored file beside the
//      DB (data/.internal-token) — mirrors the data/.google-key pattern in
//      services/google-auth.ts.
//
// The token is distributed to the callers OUT OF BAND:
//   - the in-app agent: headers in the agent's .mcp.json (workspace + command-center)
//   - the `res` CLI: tools/res.mjs reads the same env/file and sends the header
//   - the user-scope CLI MCP (~/.claude.json sanctum-google) needs the header too
//
// On mismatch we return 404 (not 403) so the route's existence isn't advertised.

import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import type { Request, Response, NextFunction } from 'express';
import { getSanctumConfig } from '../config.js';
import { tenantOrNull } from '../tenancy/context.js';

const HEADER_NAME = 'x-internal-token';

let _token: string | null = null;

/** Absolute path to the token file: a sibling of the DB file, `.internal-token`. */
function tokenFilePath(): string {
  const dbPath = getSanctumConfig().server.db_path;
  return join(dirname(dbPath), '.internal-token');
}

/** Where the live token is sourced from — for boot diagnostics that must NOT print
 *  the raw secret. Returns `env INTERNAL_TOKEN` or the on-disk file path. */
export function internalTokenSource(): string {
  return process.env.INTERNAL_TOKEN && process.env.INTERNAL_TOKEN.length > 0
    ? 'env INTERNAL_TOKEN'
    : tokenFilePath();
}

/** A non-revealing fingerprint of the token (last 4 chars) for safe logging. */
export function internalTokenFingerprint(): string {
  const t = getInternalToken();
  return t.length >= 4 ? `••••${t.slice(-4)}` : '••••';
}

/** Read the auto-generated internal token, creating it on first call. Mirrors
 *  the autoKeySecret() pattern in services/google-auth.ts. */
function autoToken(): string {
  const path = tokenFilePath();
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim();
      if (existing.length > 0) return existing;
    }
  } catch {
    // Fall through to (re)generate.
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Directory likely exists.
  }
  writeFileSync(path, secret, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600); // best-effort lockdown (no-op semantics on Windows)
  } catch {
    // chmod is advisory on some platforms — ignore.
  }
  return secret;
}

/** The internal shared secret. Always returns a usable value: env override, else
 *  the auto-managed token file (created on demand). Resolved once, then cached. */
export function getInternalToken(): string {
  const tenant = tenantOrNull('getInternalToken');
  if (tenant) return tenant.token;
  if (_token) return _token;
  const fromEnv = process.env.INTERNAL_TOKEN;
  _token = fromEnv && fromEnv.length > 0 ? fromEnv : autoToken();
  return _token;
}

/** Constant-time compare of two strings (timingSafeEqual needs equal lengths,
 *  so we hash both to a fixed width first). */
function tokensMatch(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Express middleware: require header `x-internal-token` === the internal token.
 *  On any mismatch / absence, respond 404 (do NOT advertise the route exists). */
export function internalOnly(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers[HEADER_NAME];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (!value || !tokensMatch(value, getInternalToken())) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}
