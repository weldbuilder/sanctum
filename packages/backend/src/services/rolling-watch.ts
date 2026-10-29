// Something has to read the health counter, or it is not monitoring.
//
// Once a day, on the orchestrator's half-hour tick, this looks at the rolling
// sidecars and, if any thread's folds are failing or had to be shortened since
// the last look, leaves one system note in today's thread saying which. It is
// the in-app equivalent of a morning digest line: short, dated, and only when
// there is something to say.
import { getConfig, setConfig, getTodayThread, createMessage } from './db.js';
import { getRolling, type RollingHealth } from './rolling-context.js';
import { randomUUID } from 'node:crypto';

const NOTED_KEY = 'rolling.watch_noted_date';
const SEEN_TRUNC_KEY = 'rolling.watch_truncated_seen';

/** The note for a health report, or '' when there is nothing worth saying. */
export function composeWatchNote(h: RollingHealth, truncatedSeenBefore: number): string {
  const failing = h.threads.filter((t) => t.failing);
  const newTrunc = Math.max(0, h.totals.truncated - truncatedSeenBefore);
  if (!failing.length && !newTrunc) return '';
  const parts: string[] = [];
  if (failing.length) {
    const list = failing.slice(0, 5).map((t) => `${t.threadId} (${t.failures?.count ?? 0}x: ${String(t.failures?.lastError || '').slice(0, 80)})`).join('; ');
    parts.push(`${failing.length} thread${failing.length === 1 ? '' : 's'} with a failing fold: ${list}${failing.length > 5 ? '; …' : ''}. Their older turns are out of the prompt until a fold succeeds.`);
  }
  if (newTrunc) parts.push(`${newTrunc} summar${newTrunc === 1 ? 'y' : 'ies'} had to be shortened to fit the segment cap since the last check.`);
  return `[rolling context check — ${parts.join(' ')} Run node tools/rolling-health.mjs for the full list.]`;
}

/** Runs on the orchestrator tick. Never throws. */
export async function rollingWatch(today: string): Promise<void> {
  try {
    if (getConfig(NOTED_KEY) === today) return;
    const thread = getTodayThread();
    if (!thread) return;
    const health = await getRolling().health();
    const seen = parseInt(getConfig(SEEN_TRUNC_KEY) || '0', 10) || 0;
    const note = composeWatchNote(health, seen);
    setConfig(NOTED_KEY, today);
    setConfig(SEEN_TRUNC_KEY, String(health.totals.truncated));
    if (!note) return;
    createMessage({
      id: randomUUID(), threadId: thread.id, role: 'system', content: note,
      metadata: { kind: 'rolling_watch', failing: health.totals.failing, stuck: health.totals.stuck, truncated: health.totals.truncated },
      createdAt: new Date().toISOString(),
    });
    console.warn(`[rolling-watch] ${note}`);
  } catch (err: any) {
    console.error(`[rolling-watch] failed: ${err?.message ?? err}`);
  }
}
