// The consent PIN: separate from the app password, optional in Open mode, required to switch Guard mode on or off,
// to grant anything in Guard mode, and to turn back on something the person turned off. 4 to 8 digits.
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

// ── verify tokens: in memory, 10 minutes, what the grant routes ask for ─────
const tokens = new Map<string, number>();
const tokenKey = (t: string) => `${currentTenant()?.id ?? ''}|${t}`;

export function issueToken(now = Date.now()): { token: string; expires_in: number } {
  for (const [k, exp] of tokens) if (exp <= now) tokens.delete(k);
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(tokenKey(token), now + PIN_TOKEN_MS);
  return { token, expires_in: Math.floor(PIN_TOKEN_MS / 1000) };
}

export function tokenValid(token: unknown, now = Date.now()): boolean {
  if (typeof token !== 'string' || !token) return false;
  const k = tokenKey(token);
  const exp = tokens.get(k);
  if (!exp) return false;
  if (exp <= now) { tokens.delete(k); return false; }
  return true;
}

/** Test seam. */
export function _resetTokens(): void { tokens.clear(); }
