// D11, the alert half: when Discord sends keep failing the person is told once, in the app, and told again only after
// an hour; when a send goes out again on that lane the alert clears (one short line says so).
//
// Counted: kinds that mean a reply or run did not go out (`reply_failed`, `public_run_failed`, `gate_error`). Not counted:
// setup kinds (`api_key_missing`, `exclusions_failed`, queue kinds), which are standing states the status card already shows.
// Kinds only, never text. State is per tenant (tenantLocal): tenant A's failures never alert tenant B, and per lane inside a
// tenant (owner, public): a success on one lane clears that lane only. A `gate_error` carries the lane it fired on; one
// with no lane is its own bucket ('gate'), cleared by a send on either lane (the gate ran, so it works).
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

export type AlertLane = 'owner' | 'public' | 'gate';
/** Which lane a failure belongs to when the event does not say: the kind knows. */
const KIND_LANE: Record<string, AlertLane> = { reply_failed: 'owner', public_run_failed: 'public', gate_error: 'gate' };

interface LaneState { failures: number[]; active: boolean; lastAlertAt: number }
type AlertState = Record<AlertLane, LaneState>;
const fresh = (): LaneState => ({ failures: [], active: false, lastAlertAt: -Infinity });
const freshAll = (): AlertState => ({ owner: fresh(), public: fresh(), gate: fresh() });
const stateLocal = tenantLocal<AlertState>(freshAll);

export interface AlertOptions {
  now?: number;
  /** The lane the failure fired on, when the caller knows it. */
  lane?: string;
  /** Test hook: where the line goes. Default is today's daily thread. */
  post?: (text: string) => void;
}

function laneOf(kind: string, lane?: string): AlertLane {
  return lane === 'owner' || lane === 'public' ? lane : KIND_LANE[kind] ?? 'gate';
}
const laneName = (l: AlertLane): string => (l === 'gate' ? 'the send gate' : `the ${l} lane`);
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
  const lane = laneOf(kind, opts.lane);
  const st = stateLocal.get()[lane];
  st.failures = st.failures.filter((t) => now - t < windowMs && now >= t);
  st.failures.push(now);
  if (st.failures.length < count) return false;
  if (now - st.lastAlertAt < ALERT_MIN_GAP_MS && now >= st.lastAlertAt) return false;
  st.active = true;
  st.lastAlertAt = now;
  const mins = Math.round(windowMs / 60_000);
  (opts.post ?? defaultPost)(`Discord: ${st.failures.length} sends failed on ${laneName(lane)} in the last ${mins} minutes. Settings → Channels has the last reason; Settings → Logs, filter [discord], has the lines.`);
  return true;
}

/** Heard when a Discord reply went out on `lane`. Clears that lane's failures and, if its alert was up, says it is over. Returns true when it cleared one. */
export function noteDiscordSendOk(lane: 'owner' | 'public', opts: AlertOptions = {}): boolean {
  const all = stateLocal.get();
  let cleared = false;
  for (const l of [lane, 'gate'] as const) {
    const st = all[l];
    st.failures = [];
    if (!st.active) continue;
    st.active = false;
    cleared = true;
    (opts.post ?? defaultPost)(`Discord: sends are going out again on ${laneName(l === 'gate' ? lane : l)}.`);
  }
  return cleared;
}

/** Whether this tenant's alert is up, for one lane or (no lane) any (tests, and a future status field). */
export function discordAlertActive(lane?: AlertLane): boolean {
  const all = stateLocal.get();
  return lane ? all[lane].active : all.owner.active || all.public.active || all.gate.active;
}

/** Test hook. */
export function resetFailureAlert(): void { stateLocal.set(freshAll()); }

setEventListener((category, kind, opts) => { if (category === 'discord') noteDiscordFailure(kind, { now: opts?.now, lane: opts?.lane }); });
