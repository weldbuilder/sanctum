// triggers.ts — Pure condition evaluator for impulse queue + event triggers

import { tenantLocal } from '../tenancy/context.js';
import { getDb } from './db.js';
import type { TriggerCondition } from './db.js';

export interface TriggerContext {
  presenceNow: 'active' | 'idle' | 'offline';
  presencePrev: 'active' | 'idle' | 'offline';
  agentFree: boolean;
  statusText: string;
  hour: number;
  minute: number;
  /** Today's calendar events from the warm House snapshot — lazily enriched by
   *  the orchestrator only when an active trigger uses calendar_within. */
  events?: { title: string; time: string }[];
  /** Parsed her.state.latest config (null when the key is absent). Undefined
   *  when enrichment was skipped or failed — conditions then evaluate false. */
  herState?: { sleepMin?: number | null } | null;
}

export function evaluateConditions(conditions: TriggerCondition[], context: TriggerContext): boolean {
  if (conditions.length === 0) return true;
  return conditions.every(c => evaluateSingle(c, context));
}

/** Compound nesting cap: depth 0 = top-level entries (AND-joined), depth 1 =
 *  inside one compound, depth 2 = inside a compound inside a compound (the one
 *  allowed level of nesting). A compound *encountered at* depth 2 would open a
 *  third level — it evaluates false with a one-time warn. */
const MAX_COMPOUND_DEPTH = 2;
// Per tenant (tenantLocal): a one-time warning is one per tenant, written to that tenant's own log; tenancy off, the one module flag as before.
const warnedLocal = tenantLocal<{ compoundDepth: boolean; routineMissing: boolean }>(() => ({ compoundDepth: false, routineMissing: false }));

function evaluateSingle(condition: TriggerCondition, ctx: TriggerContext, depth = 0): boolean {
  switch (condition.type) {
    case 'compound_or':
    case 'compound_and': {
      if (depth >= MAX_COMPOUND_DEPTH) {
        if (!warnedLocal.get().compoundDepth) {
          warnedLocal.get().compoundDepth = true;
          console.warn('[triggers] compound condition nested beyond one level — evaluates false');
        }
        return false;
      }
      const subs = Array.isArray(condition.conditions) ? condition.conditions : [];
      // Empty compound_or has no satisfiable branch → false; empty compound_and
      // is vacuously true (mirrors evaluateConditions' empty-array semantics).
      return condition.type === 'compound_or'
        ? subs.some(c => evaluateSingle(c, ctx, depth + 1))
        : subs.every(c => evaluateSingle(c, ctx, depth + 1));
    }
    case 'presence_state':
      return ctx.presenceNow === condition.state;
    case 'presence_transition':
      return ctx.presencePrev === condition.from && ctx.presenceNow === condition.to;
    case 'agent_free':
      return ctx.agentFree;
    case 'time_window':
      return evaluateTimeWindow(condition.after, condition.before, ctx.hour, ctx.minute);
    case 'routine_missing':
      // DEAD PATH (retired 2026-07-02): the regex contract against status text
      // never matched the local getCcStatus format, so this could never fire.
      // Use routine_due instead — it reads care_routines + care_entries
      // directly. The case is kept only so legacy rows don't throw.
      if (!warnedLocal.get().routineMissing) {
        warnedLocal.get().routineMissing = true;
        console.warn('[triggers] routine_missing is deprecated and never fires — replace with routine_due');
      }
      return false;
    case 'care_missing':
      return evaluateCareMissing(condition.category, condition.after, ctx.hour, ctx.minute);
    case 'calendar_within':
      return evaluateCalendarWithin(condition.minutes, ctx.events, ctx.hour, ctx.minute);
    case 'sleep_below':
      return typeof ctx.herState?.sleepMin === 'number' && ctx.herState.sleepMin < condition.minutes;
    case 'routine_due':
      return evaluateRoutineDue(condition.routineId, condition.grace_min ?? 0, ctx.hour, ctx.minute);
    default:
      return false;
  }
}


function evaluateTimeWindow(after: string, before: string | undefined, hour: number, minute: number): boolean {
  const nowMinutes = hour * 60 + minute;
  const afterMinutes = parseTimeString(after);
  if (afterMinutes === null) return false;
  if (!before) return nowMinutes >= afterMinutes;
  const beforeMinutes = parseTimeString(before);
  if (beforeMinutes === null) return false;
  if (afterMinutes <= beforeMinutes) return nowMinutes >= afterMinutes && nowMinutes < beforeMinutes;
  return nowMinutes >= afterMinutes || nowMinutes < beforeMinutes;
}

function parseTimeString(time: string): number | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// --- Watchers with eyes (Lane 3) — direct DB + enriched-context evaluators ---

function todayLondon(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

/** True when a care_entries row exists for today (Europe/London) + user + category. */
function hasCareEntry(category: string): boolean {
  const row = getDb()
    .prepare('SELECT id FROM care_entries WHERE date = ? AND person = ? AND category = ?')
    .get(todayLondon(), 'user', category);
  return !!row;
}

function evaluateCareMissing(category: string, after: string, hour: number, minute: number): boolean {
  const afterMinutes = parseTimeString(after);
  if (afterMinutes === null) return false;
  if (hour * 60 + minute < afterMinutes) return false;
  try {
    return !hasCareEntry(category);
  } catch {
    return false; // read failure never breaks the tick
  }
}

function evaluateCalendarWithin(
  minutes: number,
  events: { title: string; time: string }[] | undefined,
  hour: number,
  minute: number
): boolean {
  if (!events || events.length === 0) return false;
  const nowMinutes = hour * 60 + minute;
  return events.some(e => {
    const delta = minutesUntilEvent(e.time, nowMinutes);
    return delta !== null && delta >= 0 && delta <= minutes;
  });
}

/** Minutes from now until an event time string — "HH:MM" (local, from CC
 *  events) or an ISO datetime (Google). Null for all-day/empty/unparseable. */
function minutesUntilEvent(time: string, nowMinutes: number): number | null {
  if (!time || time === 'all-day') return null;
  const asMinutes = parseTimeString(time);
  if (asMinutes !== null) return asMinutes - nowMinutes;
  if (/^\d{4}-\d{2}-\d{2}$/.test(time)) return null; // bare date = all-day
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return null;
  return Math.round((ms - Date.now()) / 60000);
}

interface CareRoutineRow {
  id: string;
  label: string;
  category: string;
  window_start: string;
  window_end: string;
  days: string;
  active: number;
}

/** True when a care_routines row (by id, or any active one) is due today, the
 *  window closed more than grace_min ago, and no care_entries row completes it.
 *  Tolerant of the table not existing yet (Lane 1 owns the schema). */
function evaluateRoutineDue(routineId: string | undefined, graceMin: number, hour: number, minute: number): boolean {
  try {
    const db = getDb();
    const rows = (routineId
      ? db.prepare('SELECT * FROM care_routines WHERE id = ? AND active = 1').all(routineId)
      : db.prepare('SELECT * FROM care_routines WHERE active = 1').all()) as unknown as CareRoutineRow[];
    if (rows.length === 0) return false;
    const nowMinutes = hour * 60 + minute;
    const weekday = new Date()
      .toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short' })
      .toLowerCase(); // 'mon'..'sun'
    for (const routine of rows) {
      if (!routineDueToday(routine.days, weekday)) continue;
      const windowEnd = parseTimeString(routine.window_end);
      if (windowEnd === null) continue;
      if (nowMinutes <= windowEnd + graceMin) continue;
      if (hasCareEntry(routine.category)) continue;
      return true;
    }
    return false;
  } catch {
    return false; // care_routines may not exist yet — evaluate false, never throw
  }
}

/** days is 'daily' or a CSV of weekdays ('mon,wed,fri' — full names tolerated). */
function routineDueToday(days: string, weekday: string): boolean {
  if (!days || days === 'daily') return true;
  return days.split(',').some(d => d.trim().toLowerCase().slice(0, 3) === weekday);
}
