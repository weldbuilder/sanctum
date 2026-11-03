import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('./embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('./vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Echo', user_name: 'Alex', timezone: 'America/New_York' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
    command_center: { default_person: 'user' },
  }),
  PROJECT_ROOT: '/tmp/test',
}));
import { initDb, getDb, getConfig } from './db.js';
import { logMeal, undoMeal, mealCategoryFor, parseMealTime, zonedToUtc } from './meal.js';

beforeEach(() => initDb(':memory:'));

describe('meal time parsing', () => {
  it('reads the shapes people type', () => {
    expect(parseMealTime('10:30', '12:00')).toBe('10:30');
    expect(parseMealTime('2pm', '12:00')).toBe('14:00');
    expect(parseMealTime('2:15 PM', '12:00')).toBe('14:15');
    expect(parseMealTime('12am', '12:00')).toBe('00:00');
    expect(parseMealTime('now', '12:00')).toBe('12:00');
    expect(parseMealTime('', '12:00')).toBe('12:00');
    expect(parseMealTime('yesterday', '12:00')).toBeNull();
    expect(parseMealTime('25:00', '12:00')).toBeNull();
  });
  it('maps a time to breakfast, lunch or dinner', () => {
    expect(mealCategoryFor('07:00')).toBe('breakfast');
    expect(mealCategoryFor('10:59')).toBe('breakfast');
    expect(mealCategoryFor('13:00')).toBe('lunch');
    expect(mealCategoryFor('19:30')).toBe('dinner');
  });
  it('converts a house-local time to the right UTC instant across DST', () => {
    expect(zonedToUtc('2026-10-08', '10:30', 'America/New_York').toISOString()).toBe('2026-10-08T14:30:00.000Z'); // EDT
    expect(zonedToUtc('2026-12-08', '10:30', 'America/New_York').toISOString()).toBe('2026-12-08T15:30:00.000Z'); // EST
    expect(zonedToUtc('2026-10-08', '10:30', 'UTC').toISOString()).toBe('2026-10-08T10:30:00.000Z');
  });
});

describe('log and undo', () => {
  it('writes one care entry at the meal\'s own time and refreshes the context state', () => {
    const r = logMeal({ at: '10:30', note: 'eggs' });
    expect(r.category).toBe('breakfast');
    const row = getDb().prepare("SELECT * FROM care_entries WHERE category = 'breakfast'").get() as any;
    expect(row.value).toBe('10:30');
    expect(row.note).toBe('eggs');
    expect(row.created_at.endsWith(':30:00')).toBe(true);
    const state = JSON.parse(getConfig('her.state.latest')!);
    expect(state.lastMealAt).toBe(r.at);
  });
  it('a second meal later in the day becomes the latest; undo removes it and falls back to the earlier one', () => {
    const first = logMeal({ at: '08:00' });
    logMeal({ at: '13:00' });
    expect(JSON.parse(getConfig('her.state.latest')!).lastMealAt).not.toBe(first.at);
    expect(undoMeal()).toEqual({ category: 'lunch', hhmm: '13:00', note: null });
    expect(JSON.parse(getConfig('her.state.latest')!).lastMealAt).toBe(first.at);
    expect(undoMeal()).toEqual({ category: 'breakfast', hhmm: '08:00', note: null });
    expect(JSON.parse(getConfig('her.state.latest')!).lastMealAt).toBeNull();
    expect(undoMeal()).toBeNull();
  });
  it('a second meal in the same window keeps both (issue #1 follow-up: the 13:36 carrots and the 15:32 hamburger)', () => {
    const a = logMeal({ at: '13:36', note: 'carrots and greek yogurt' });
    const b = logMeal({ at: '15:32', note: 'hamburger' });
    expect(a.nthInCategory).toBe(1);
    expect(b.nthInCategory).toBe(2);
    const ledger = getDb().prepare("SELECT hhmm, note FROM meal_log WHERE category = 'lunch' ORDER BY at").all() as any[];
    expect(ledger).toEqual([{ hhmm: '13:36', note: 'carrots and greek yogurt' }, { hhmm: '15:32', note: 'hamburger' }]);
    // The care tracker's one lunch row: latest time, both notes, nothing mismatched.
    const rows = getDb().prepare("SELECT value, note, created_at FROM care_entries WHERE category = 'lunch'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('15:32');
    expect(rows[0].note).toBe('13:36 carrots and greek yogurt; 15:32 hamburger');
    // The care row is stamped at the meal's UTC instant; derive it so the test holds in EDT and EST alike.
    const lunchUtc = zonedToUtc(a.date, '15:32', 'America/New_York');
    expect(rows[0].created_at.endsWith(lunchUtc.toISOString().slice(11, 19))).toBe(true);
    expect(JSON.parse(getConfig('her.state.latest')!).lastMealAt).toBe(b.at);
    // A second lunch logged without a note keeps the earlier note and the row count.
    logMeal({ at: '15:40' });
    expect(getDb().prepare("SELECT note FROM care_entries WHERE category = 'lunch'").get()).toEqual({ note: '13:36 carrots and greek yogurt; 15:32 hamburger' });
    // Undo peels the latest meal only, and the care row follows the ledger.
    expect(undoMeal()).toEqual({ category: 'lunch', hhmm: '15:40', note: null });
    expect(undoMeal()).toEqual({ category: 'lunch', hhmm: '15:32', note: 'hamburger' });
    expect(getDb().prepare("SELECT value, note FROM care_entries WHERE category = 'lunch'").get()).toEqual({ value: '13:36', note: 'carrots and greek yogurt' });
    expect(JSON.parse(getConfig('her.state.latest')!).lastMealAt).toBe(a.at);
    expect(undoMeal()).toEqual({ category: 'lunch', hhmm: '13:36', note: 'carrots and greek yogurt' });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM care_entries WHERE category = 'lunch'").get()).toEqual({ n: 0 });
    expect(undoMeal()).toBeNull();
  });
  it('undo still removes a lunch the care tracker wrote before the ledger existed', () => {
    getDb().prepare("INSERT INTO care_entries (id, date, person, category, value, source) VALUES ('old', ?, 'user', 'lunch', '12:00', 'ui')")
      .run(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
    expect(undoMeal()).toEqual({ category: 'lunch', hhmm: '12:00', note: null });
    expect(undoMeal()).toBeNull();
  });
  it('refuses a time it cannot read', () => {
    expect(() => logMeal({ at: 'soonish' })).toThrow(/Could not read a time/);
  });
});
