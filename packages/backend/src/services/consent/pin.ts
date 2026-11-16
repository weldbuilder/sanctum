// The consent PIN: separate from the app password, optional in Open mode, required to switch Guard mode on or off,
// to grant anything in Guard mode, and to make anything more permissive than it is (turning back on something the person turned off or whose window ended). 4 to 8 digits.
// Stored as a scrypt hash in KV `consent.pin_hash`; compared in constant time; 5 wrong in a row lock it for 15 minutes.
// The PIN, its hash and the salt are never logged and never returned by any route.
import crypto from 'node:crypto';
import { deleteConfig, getConfig, setConfig } from '../db.js';
import { currentTenant } from '../../tenancy/context.js';

const KEY_HASH = 'consent.pin_hash';
const KEY_LOCK = 'consent.pin_lock_until';
const KEY_FAILS = 'consent.pin_fails';
export const PIN_MAX_FAILS = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000;
export const PIN_TOKEN_MS = 10 * 60 * 1000;
const PIN_RE = /^\d{4,8}$/;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function pinFormatOk(pin: unknown): pin is string { return typeof pin === 'string' && PIN_RE.test(pin); }
export function pinIsSet(): boolean { return !!getConfig(KEY_HASH); }

export function setPin(pin: string): void {
  if (!pinFormatOk(pin)) throw new Error('The PIN is 4 to 8 digits.');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32, SCRYPT);
  setConfig(KEY_HASH, `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`);
  deleteConfig(KEY_LOCK);
  deleteConfig(KEY_FAILS);
  tokens.clear();
}

export function clearPin(): void {
  deleteConfig(KEY_HASH);
  deleteConfig(KEY_LOCK);
  deleteConfig(KEY_FAILS);
  tokens.clear();
}

/** Epoch ms the lock ends, or null when not locked. */
export function lockedUntil(now = Date.now()): number | null {
  const v = Number(getConfig(KEY_LOCK));
  return Number.isFinite(v) && v > now ? v : null;
}

export type PinCheck =
  | { ok: true }
  | { ok: false; reason: 'not_set' | 'wrong' | 'locked'; locked_until?: number; attempts_left?: number };

export function verifyPin(pin: unknown, now = Date.now()): PinCheck {
  const stored = getConfig(KEY_HASH);
  if (!stored) return { ok: false, reason: 'not_set' };
  const lock = lockedUntil(now);
  if (lock) return { ok: false, reason: 'locked', locked_until: lock };
  // Whatever was typed goes through the same hash and compare, so a malformed entry costs the same as a wrong one.
  const [scheme, saltHex, hashHex] = stored.split('$');
  let match = false;
  if (scheme === 'scrypt' && saltHex && hashHex) {
    const want = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(typeof pin === 'string' ? pin : '', Buffer.from(saltHex, 'hex'), want.length, SCRYPT);
    match = want.length === got.length && crypto.timingSafeEqual(want, got) && pinFormatOk(pin);
  }
  if (match) {
    deleteConfig(KEY_FAILS);
    return { ok: true };
  }
  const fails = (Number(getConfig(KEY_FAILS)) || 0) + 1;
  if (fails >= PIN_MAX_FAILS) {
    setConfig(KEY_LOCK, String(now + PIN_LOCK_MS));
    deleteConfig(KEY_FAILS);
    return { ok: false, reason: 'locked', locked_until: now + PIN_LOCK_MS };
  }
  setConfig(KEY_FAILS, String(fails));
  return { ok: false, reason: 'wrong', attempts_left: PIN_MAX_FAILS - fails };
}

// ── verify tokens: in memory, 10 minutes, bound to the session that verified, used once ─────
// What the grant routes ask for. A token is {session, expiry}: another session cannot spend it, and spending it (a grant, a mode change, a
// re-enable) removes it, so each PIN-gated change takes its own PIN entry.
const tokens = new Map<string, { sessionId: string; exp: number }>();
const tokenKey = (t: string) => `${currentTenant()?.id ?? ''}|${t}`;

export function issueToken(sessionId: string, now = Date.now()): { token: string; expires_in: number } {
  for (const [k, v] of tokens) if (v.exp <= now) tokens.delete(k);
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(tokenKey(token), { sessionId, exp: now + PIN_TOKEN_MS });
  return { token, expires_in: Math.floor(PIN_TOKEN_MS / 1000) };
}

function tokenEntry(token: unknown, sessionId: string, now: number): { key: string; ok: boolean } {
  if (typeof token !== 'string' || !token) return { key: '', ok: false };
  const key = tokenKey(token);
  const t = tokens.get(key);
  if (!t) return { key, ok: false };
  if (t.exp <= now) { tokens.delete(key); return { key, ok: false }; }
  return { key, ok: t.sessionId === sessionId };
}

/** Is this token good for this session (without spending it)? For checking before the change is planned. */
export function tokenValid(token: unknown, sessionId: string, now = Date.now()): boolean { return tokenEntry(token, sessionId, now).ok; }

/** Spend the token: true once, for the session it was issued to, and never again. */
export function consumeToken(token: unknown, sessionId: string, now = Date.now()): boolean {
  const { key, ok } = tokenEntry(token, sessionId, now);
  if (ok) tokens.delete(key);
  return ok;
}

/** Test seam. */
export function _resetTokens(): void { tokens.clear(); }
