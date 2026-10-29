// The setup code: the one secret a fresh install has before it has a password.
//
// With no password configured the server fails closed (middleware/auth.ts), so the first-run wizard in the browser needs its own
// gate. A source-IP check is not one (a tunnel forwards every public request from loopback; see middleware/internal-token.ts). This
// is: twelve hex characters (48 bits from crypto.randomBytes) printed in the window where `npm start` runs, which the person
// setting up already has open.
//
//   - It is made once at boot and printed once, then lives in memory only: never written to disk, never in a response.
//   - It expires 30 minutes after it was made. A guess after that is refused and a new code is made and printed.
//   - Five wrong guesses are free. After that a wrong guess replaces the code (a new one is printed) and the count starts again, but
//     the code is replaced at most once every five minutes, so a stranger cannot make the terminal scroll with guesses.
//   - Wrong guesses are also counted per address (setupGuessBlocked): five in 15 minutes and that address is refused for the rest of
//     the window. Only a wrong guess counts: no code sent, an expired code and a right code never do.
//   - It stops mattering the moment a password exists: /api/setup/* then takes the normal session like every other route.
//
// A rotation prints the new code to the terminal too. The line goes straight to the process's stdout through `announce` (which a test
// replaces), not through console.*, so the app's own logging never carries it. If the app runs under a process manager that keeps
// stdout in a file, that file holds it: it is worth nothing 30 minutes later, or the moment a password exists.

import crypto from 'crypto';
import { HOUSE_SCOPE_ID, currentTenant, tenantLocal } from '../tenancy/context.js';

export const SETUP_CODE_HEX_CHARS = 12;
export const SETUP_CODE_TTL_MS = 30 * 60 * 1000;
/** Wrong guesses allowed before a further wrong guess may rotate the code. */
export const SETUP_CODE_FREE_FAILURES = 5;
/** The code is replaced for too many wrong guesses at most once in this long. */
export const SETUP_CODE_ROTATION_WINDOW_MS = 5 * 60 * 1000;
/** Wrong guesses one address may make in the window before it is refused (its own count, apart from the login limiter). */
export const SETUP_GUESS_LIMIT = 5;
export const SETUP_GUESS_WINDOW_MS = 15 * 60 * 1000;

export type SetupCodeVerdict = 'ok' | 'wrong' | 'rotated' | 'expired' | 'missing';

interface State { code: string; madeAt: number; failures: number }
// Tenancy off: one value each for the process, as always. Tenant mode: one per tenant (its own code, its own rotation clock, its own guess table),
// so a code printed for tenant ada opens ada's page and no other, and wrong guesses on one tenant's page never count against another's.
const stateL = tenantLocal<State | null>(() => null);
const lastRotationL = tenantLocal<number>(() => -Infinity);
const guessesL = tenantLocal(() => new Map<string, { count: number; resetAt: number }>());
const lastSweepL = tenantLocal<number>(() => -Infinity);
/** Addresses remembered at once. Behind `trust proxy` a forged X-Forwarded-For is a new address per request, so the
 * table is capped: past the cap the oldest entry goes (insertion order), which only ever forgets a guesser sooner. */
export const SETUP_GUESS_TABLE_MAX = 10_000;
const SWEEP_EVERY_MS = 60 * 1000;
let clock: () => number = Date.now;

type Announce = (code: string, why: 'boot' | 'expired' | 'too_many_guesses') => void;
const defaultAnnounce: Announce = (code, why) => {
  const lead = why === 'boot' ? 'Setup code' : why === 'expired' ? 'The setup code expired. New setup code' : 'Too many wrong guesses, so the setup code was replaced. New setup code';
  const rt = currentTenant();
  if (rt && rt.id === HOUSE_SCOPE_ID) {
    // Household mode: the house's own first-run (no password yet) has one code, apart from every companion's.
    process.stdout.write(`${lead} for the house:  ${code}\n`);
    return;
  }
  if (rt) {
    // Tenant mode: the operator reads the process's stdout, so the line goes there, naming the tenant; and to that tenant's own log, which only that
    // tenant can read (and the code is worth nothing once its password exists). Never the password or the token.
    process.stdout.write(`${lead} for tenant ${rt.id}:  ${code}\n`);
    tenantTap?.(`${lead} for tenant ${rt.id}:  ${code}`);
    return;
  }
  // process.stdout, not the app's logger: the code is not to land in data/logs.
  process.stdout.write(`${lead}:  ${code}\n`);
};
let announce: Announce = defaultAnnounce;
// Tenant mode: tenancy/boot.ts hands over a function that puts the same line in the current tenant's own log (this module logs nothing itself).
let tenantTap: ((line: string) => void) | null = null;
export function setTenantAnnounceTap(fn: ((line: string) => void) | null): void { tenantTap = fn; }

function mint(): State {
  return { code: crypto.randomBytes(SETUP_CODE_HEX_CHARS / 2).toString('hex'), madeAt: clock(), failures: 0 };
}

/** The code for now, made on first use. It is not checked for age here: see `setupCodeMatches`. */
export function setupCode(): string {
  let state = stateL.get();
  if (!state) { state = mint(); stateL.set(state); }
  return state.code;
}

/** Make the code if there is none, and replace it when it has expired (printing it); the status route calls this so a page opened
 *  after half an hour finds a new code in the terminal. Returns whether a code is live. */
export function ensureSetupCode(): void {
  const state = stateL.get();
  if (!state) { const made = mint(); stateL.set(made); announce(made.code, 'boot'); return; }
  if (clock() - state.madeAt > SETUP_CODE_TTL_MS) { const made = mint(); stateL.set(made); announce(made.code, 'expired'); }
}

/** Print the code made for this boot (server.ts, when no password is set). Printed once; a rotation prints its own. */
export function announceSetupCode(): string {
  const code = setupCode();
  announce(code, 'boot');
  return code;
}

/** Check what a visitor sent. 'ok' means the code is right and live. 'expired': it was right-looking but too old, or too old to
 *  matter: a new code was printed. 'wrong' and 'rotated': a wrong guess (the sixth and later also replaced the code, printed).
 *  'missing': nothing was sent (not a guess). Constant-time comparison. */
export function checkSetupCode(candidate: unknown): SetupCodeVerdict {
  if (typeof candidate !== 'string' || !candidate.trim()) return 'missing';
  let state = stateL.get();
  if (!state) { state = mint(); stateL.set(state); }
  if (clock() - state.madeAt > SETUP_CODE_TTL_MS) {
    // Too old to be accepted whatever it is. Not counted as a guess: nothing about a live code was learned.
    state = mint();
    stateL.set(state);
    announce(state.code, 'expired');
    return 'expired';
  }
  const a = Buffer.from(candidate.trim().toLowerCase());
  const b = Buffer.from(state.code);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) { state.failures = 0; return 'ok'; }
  state.failures += 1;
  // Past the free guesses a wrong guess replaces the code, but only once per rotation window; the count starts again with the new one.
  if (state.failures > SETUP_CODE_FREE_FAILURES && clock() - lastRotationL.get() >= SETUP_CODE_ROTATION_WINDOW_MS) {
    state = mint();
    stateL.set(state);
    lastRotationL.set(clock());
    announce(state.code, 'too_many_guesses');
    return 'rotated';
  }
  return 'wrong';
}

/** Is this address refused for too many wrong guesses? Asked before the code is checked, so a refused address learns nothing. Counts nothing. */
export function setupGuessBlocked(ip: string): boolean {
  const guesses = guessesL.get();
  const g = guesses.get(ip);
  if (!g) return false;
  if (clock() >= g.resetAt) { guesses.delete(ip); return false; }
  return g.count >= SETUP_GUESS_LIMIT;
}

/** Count one wrong guess against an address (the caller does this for 'wrong' and 'rotated' only). */
export function noteWrongGuess(ip: string): void {
  const t = clock();
  const guesses = guessesL.get();
  if (t - lastSweepL.get() >= SWEEP_EVERY_MS) { lastSweepL.set(t); for (const [k, g] of guesses) if (t >= g.resetAt) guesses.delete(k); }
  const g = guesses.get(ip);
  if (g) { g.count += 1; return; }
  while (guesses.size >= SETUP_GUESS_TABLE_MAX) { const oldest = guesses.keys().next().value; if (oldest === undefined) break; guesses.delete(oldest); }
  guesses.set(ip, { count: 1, resetAt: t + SETUP_GUESS_WINDOW_MS });
}

/** True when the candidate is the live code (a convenience over checkSetupCode). */
export function setupCodeMatches(candidate: unknown): boolean {
  return checkSetupCode(candidate) === 'ok';
}

/** Tests only. */
export function _resetSetupCode(opts: { now?: () => number; announce?: Announce } = {}): void {
  stateL.reset();
  lastRotationL.reset();
  lastSweepL.reset();
  guessesL.reset();
  clock = opts.now ?? Date.now;
  announce = opts.announce ?? defaultAnnounce;
}
