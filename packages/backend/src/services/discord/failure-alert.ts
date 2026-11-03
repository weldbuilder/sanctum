// D11, the alert half: when Discord sends keep failing the person is told once, in the app, and told again only after
// an hour; when a send goes out again the alert clears (one short line says so).
//
// Counted: kinds that mean a reply or run did not go out (`reply_failed`, `public_run_failed`, `gate_error`). Not counted:
// setup kinds (`api_key_missing`, `exclusions_failed`, queue kinds), which are standing states the status card already shows.
// Kinds only, never text. State is per tenant (tenantLocal): tenant A's failures never alert tenant B.
// Settings (database keys, like the other `discord.*` timings): `discord.failureAlertCount` (default 3) failures within
// `discord.failureAlertWindowMin` (default 10) minutes.

import { getConfigNumber, ensureDailyThread } from '../db.js';
import { postSystemLine } from '../system-line.js';
import { setEventListener } from '../logs.js';
import { tenantLocal } from '../../tenancy/context.js';

export const FAILURE_KINDS = new Set(['reply_failed', 'public_run_failed', 'gate_error']);
export const DEFAULT_ALERT_COUNT = 3;
export const DEFAULT_ALERT_WINDOW_MIN = 10;
/** Least gap between two alerts for one tenant. */
export const ALERT_MIN_GAP_MS = 3_600_000;

interface AlertState { failures: number[]; active: boolean; lastAlertAt: number }
const stateLocal = tenantLocal<AlertState>(() => ({ failures: [], active: false, lastAlertAt: -Infinity }));

export interface AlertOptions {
  now?: number;
  /** Test hook: where the line goes. Default is the app's own thread. */
  post?: (text: string) => void;
}

function clampInt(n: number, lo: number, hi: number, dflt: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}

export function alertSettings(): { count: number; windowMs: number } {
  let count = DEFAULT_ALERT_COUNT;
  let min = DEFAULT_ALERT_WINDOW_MIN;
  try {
    count = clampInt(getConfigNumber('discord.failureAlertCount', DEFAULT_ALERT_COUNT), 1, 100, DEFAULT_ALERT_COUNT);
    min = clampInt(getConfigNumber('discord.failureAlertWindowMin', DEFAULT_ALERT_WINDOW_MIN), 1, 1440, DEFAULT_ALERT_WINDOW_MIN);
  } catch { /* no database yet: the defaults */ }
  return { count, windowMs: min * 60_000 };
}

function defaultPost(text: string): void {
  try { postSystemLine(ensureDailyThread().thread.id, text, 'discord_notice', { discordFailureAlert: true }); } catch { /* the line is best effort */ }
}

/** Heard for every discord event the logs service records. Returns true when it raised the alert. */
export function noteDiscordFailure(kind: string, opts: AlertOptions = {}): boolean {
  if (!FAILURE_KINDS.has(kind)) return false;
  const now = opts.now ?? Date.now();
  const { count, windowMs } = alertSettings();
  const st = stateLocal.get();
  st.failures = st.failures.filter((t) => now - t < windowMs && now >= t);
  st.failures.push(now);
  if (st.failures.length < count) return false;
  if (now - st.lastAlertAt < ALERT_MIN_GAP_MS && now >= st.lastAlertAt) return false;
  st.active = true;
  st.lastAlertAt = now;
  const mins = Math.round(windowMs / 60_000);
  (opts.post ?? defaultPost)(`Discord: ${st.failures.length} sends failed in the last ${mins} minutes. Settings → Channels has the last reason; Settings → Logs, filter [discord], has the lines.`);
  return true;
}

/** Heard when a Discord reply went out. Clears the failures and, if an alert was up, says it is over. Returns true when it cleared one. */
export function noteDiscordSendOk(opts: AlertOptions = {}): boolean {
  const st = stateLocal.get();
  st.failures = [];
  if (!st.active) return false;
  st.active = false;
  (opts.post ?? defaultPost)('Discord: sends are going out again.');
  return true;
}

/** Whether this tenant's alert is up (tests, and a future status field). */
export function discordAlertActive(): boolean { return stateLocal.get().active; }

/** Test hook. */
export function resetFailureAlert(): void { stateLocal.set({ failures: [], active: false, lastAlertAt: -Infinity }); }

setEventListener((category, kind) => { if (category === 'discord') noteDiscordFailure(kind); });
