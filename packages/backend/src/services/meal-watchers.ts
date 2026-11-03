// Whether the meal asks are on: one answer for every orientation source (env line, Routines line).
import { getActiveTriggers } from './db.js';

/** True when at least one meal care-watcher is live (pending/waiting). Paused
 *  and cancelled rows are absent from getActiveTriggers. Identified by the
 *  watcher's care_missing condition on a meal category, not its label, so a
 *  renamed watcher still counts. */
export function mealWatchersActive(): boolean {
  const meals = new Set(['breakfast', 'lunch', 'dinner']);
  return getActiveTriggers().some((t) => {
    if (t.kind !== 'watcher') return false;
    try {
      const conds = JSON.parse(t.conditions);
      return Array.isArray(conds) && conds.some((c) => c?.type === 'care_missing' && meals.has(c.category));
    } catch { return false; }
  });
}
