// The meal log's write path. The companion can see "no meal logged" on its
// context line; this is how it fills the hole on the person's say-so:
// "ate at 10:30" → res meal 10:30 → one care entry → "logged." Undo is
// "scratch that" → res meal undo. No form, no confirmation: the sentence is
// the consent. The entry is the same row the Command Center's care tracker
// writes, so both views agree.
import { getDb, getConfig, setConfig } from './db.js';
import { upsertCareEntry, deleteCareEntry } from './cc.js';
import { getSanctumConfig } from '../config.js';
import { randomUUID } from 'crypto';

const MEAL_CATEGORIES = ['breakfast', 'lunch', 'dinner', 'meal', 'snack'];

/** Which care category a meal at this local time counts as. */
export function mealCategoryFor(hhmm: string): 'breakfast' | 'lunch' | 'dinner' {
  const h = parseInt(hhmm.slice(0, 2), 10);
  return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : 'dinner';
}

/** "10:30", "10.30", "2pm", "2:15 pm", "now", "" → "HH:MM" local, or null when unreadable. */
export function parseMealTime(input: string | undefined, nowLocalHHMM: string): string | null {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s || s === 'now') return nowLocalHHMM;
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const tz = () => getSanctumConfig().identity.timezone;
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: tz() });
const localHHMM = (d = new Date()) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz() });

/** The UTC instant of `date` `hhmm` in the house timezone (two passes cover DST). */
export function zonedToUtc(date: string, hhmm: string, timeZone: string): Date {
  let guess = new Date(`${date}T${hhmm}:00Z`);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    const rendered = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:00Z`);
    const target = new Date(`${date}T${hhmm}:00Z`);
    guess = new Date(guess.getTime() + (target.getTime() - rendered.getTime()));
  }
  return guess;
}

const sqlUtc = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const fromSql = (s: string) => new Date(`${s.replace(' ', 'T')}Z`).toISOString();
const person = (p?: string) => p || getSanctumConfig().command_center.default_person;

type LedgerRow = { id: string; date: string; person: string; category: string; at: string; hhmm: string; note: string | null };

/** Today's meals from the ledger, latest first. */
function ledgerToday(date: string, who: string): LedgerRow[] {
  return getDb().prepare(
    `SELECT id, date, person, category, at, hhmm, note FROM meal_log WHERE date = ? AND person = ? ORDER BY at DESC, created_at DESC`,
  ).all(date, who) as LedgerRow[];
}

/** A care row written by the UI or by the old write path: no ledger behind it. */
function latestCareMealToday(date: string): { id: string; category: string; value: string | null; created_at: string } | null {
  return (getDb().prepare(
    `SELECT id, category, value, created_at FROM care_entries WHERE date = ? AND category IN (${MEAL_CATEGORIES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
  ).get(date, ...MEAL_CATEGORIES) as any) ?? null;
}

/**
 * The care tracker's one row per (date, person, category) is derived from the
 * ledger: the latest meal's time as the value, every note joined in order, and
 * created_at at the latest meal so the context line reads the right time. No
 * meals left in the category → the row goes.
 */
function syncCareRow(date: string, who: string, category: string): void {
  const meals = getDb().prepare(
    `SELECT id, at, hhmm, note FROM meal_log WHERE date = ? AND person = ? AND category = ? ORDER BY at ASC, created_at ASC`,
  ).all(date, who, category) as Array<{ id: string; at: string; hhmm: string; note: string | null }>;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM care_entries WHERE date = ? AND person = ? AND category = ?').get(date, who, category) as { id: string } | undefined;
  if (meals.length === 0) {
    if (existing) deleteCareEntry(existing.id);
    return;
  }
  const latest = meals[meals.length - 1];
  const note = meals.map((m) => (m.note ? (meals.length > 1 ? `${m.hhmm} ${m.note}` : m.note) : '')).filter(Boolean).join('; ') || null;
  const id = existing?.id ?? upsertCareEntry({ date, person: who, category, value: latest.hhmm, source: 'mcp' }).id;
  db.prepare(`UPDATE care_entries SET value = ?, note = ?, source = 'mcp', created_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(latest.hhmm, note, latest.at, id);
}

/** Keep the context line current without waiting for the outlook poller. */
function refreshHerMealState(lastMealAt: string | null): void {
  try {
    const raw = getConfig('her.state.latest');
    const state = raw ? JSON.parse(raw) : { sleepMin: null, sleepLine: null, cycle: null, nextEvent: null };
    state.lastMealAt = lastMealAt;
    state.at = new Date().toISOString();
    setConfig('her.state.latest', JSON.stringify(state));
  } catch { /* the poller rewrites it within minutes anyway */ }
}

function latestMealAt(date: string, who: string): string | null {
  const l = ledgerToday(date, who)[0];
  if (l) return fromSql(l.at);
  const c = latestCareMealToday(date);
  return c ? fromSql(c.created_at) : null;
}

export interface MealLogged { category: string; hhmm: string; date: string; at: string; note: string | null; /** how many meals today fall in this category, this one included */ nthInCategory: number }

/** Log a meal at a local time ("10:30", "2pm", "now"). Throws on an unreadable time.
 *  Every meal is kept: a second lunch is a second row in the ledger, and the
 *  care tracker's lunch row shows the latest time with both notes. */
export function logMeal(p: { at?: string; note?: string; person?: string } = {}): MealLogged {
  const hhmm = parseMealTime(p.at, localHHMM());
  if (!hhmm) throw new Error(`Could not read a time from "${p.at}". Use HH:MM, 2pm, or now.`);
  const date = localDate();
  const who = person(p.person);
  const category = mealCategoryFor(hhmm);
  const at = zonedToUtc(date, hhmm, tz());
  const note = p.note?.trim() || null;
  getDb().prepare(`INSERT INTO meal_log (id, date, person, category, at, hhmm, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), date, who, category, sqlUtc(at), hhmm, note, sqlUtc(new Date()));
  syncCareRow(date, who, category);
  const nth = (getDb().prepare('SELECT COUNT(*) AS n FROM meal_log WHERE date = ? AND person = ? AND category = ?').get(date, who, category) as { n: number }).n;
  refreshHerMealState(latestMealAt(date, who));
  return { category, hhmm, date, at: at.toISOString(), note, nthInCategory: nth };
}

/** Remove today's latest meal. Returns what was removed, or null when there was none. */
export function undoMeal(p: { person?: string } = {}): { category: string; hhmm: string | null; note: string | null } | null {
  const date = localDate();
  const who = person(p.person);
  const latest = ledgerToday(date, who)[0];
  if (latest) {
    getDb().prepare('DELETE FROM meal_log WHERE id = ?').run(latest.id);
    syncCareRow(date, who, latest.category);
    refreshHerMealState(latestMealAt(date, who));
    return { category: latest.category, hhmm: latest.hhmm, note: latest.note };
  }
  // Nothing in the ledger: a row the care tracker or the old write path made.
  const care = latestCareMealToday(date);
  if (!care) return null;
  deleteCareEntry(care.id);
  refreshHerMealState(latestMealAt(date, who));
  return { category: care.category, hhmm: care.value, note: null };
}
