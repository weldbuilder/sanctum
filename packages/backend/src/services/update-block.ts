// While an in-app update is installing, building or restarting, work that would start a model run or touch the files being swapped waits.
// One process-level flag (the updater sets it; the interactive entry points, the orchestrator's wakes, the outlook author, the handoff and the
// rolling summarizer check it, through backgroundRunsOff() in tenancy/context.ts and updateBlocking() here), and a count of the background
// model runs that are in flight, so the updater's start guard and its turn fence see runs that are not in the query queue.
let blocking = false;
let inFlight = 0;

/** True while an update job is installing, building or restarting. */
export function updateBlocking(): boolean { return blocking; }
export function setUpdateBlocking(on: boolean): void {
  const was = blocking;
  blocking = on;
  if (on && !was) noticed.clear();
  if (was && !on) {
    noticed.clear();
    for (const fn of [...clearedHooks]) { try { fn(); } catch (err) { console.warn('[update] a catch-up after the pause failed:', (err as Error).message); } }
  }
}

// ---- when the pause ends -------------------------------------------------------------
// The pause ends without a restart when an update fails or is only installed (a successful update replaces the process). What was skipped meanwhile
// is picked up once, by each scheduler that skipped something (`createCatchUp`), and each channel that turned a message away said so only once (`noticeOnce`).
const clearedHooks = new Set<() => void>();
const noticed = new Set<string>();
/** Run `fn` each time the pause ends. Returns the way to stop. */
export function onUpdateBlockCleared(fn: () => void): () => void { clearedHooks.add(fn); return () => { clearedHooks.delete(fn); }; }

/** True the first time `key` (a channel) is seen during this pause: the caller says "updating, back in a minute" then, and ignores the rest. Reset when the pause ends. */
export function noticeOnce(key: string): boolean {
  if (noticed.has(key)) return false;
  noticed.add(key);
  return true;
}
export const UPDATING_REPLY = 'Updating, back in a minute.';

export interface CatchUp {
  /** Something this scheduler would have run was skipped because of the pause. `item` names it (a wake type), so each is run once. */
  skipped(item?: string): void;
  /** The `skippedWhileBlocked` flag. */
  readonly skippedWhileBlocked: boolean;
  dispose(): void;
}
/** A scheduler's catch-up: when the pause ends and it skipped something, `run` is called ONCE with what was skipped (never when nothing was). `run` must be bound to the
 *  scheduler's tenant by the caller (bindCurrentTenant). */
export function createCatchUp(run: (items: string[]) => void | Promise<void>): CatchUp {
  const items = new Set<string>();
  let skippedWhileBlocked = false;
  const off = onUpdateBlockCleared(() => {
    if (!skippedWhileBlocked) return;
    skippedWhileBlocked = false;
    const list = [...items];
    items.clear();
    void Promise.resolve().then(() => run(list)).catch((err) => console.warn('[update] a catch-up pass failed:', (err as Error).message));
  });
  return {
    skipped(item = '') { skippedWhileBlocked = true; if (item) items.add(item); },
    get skippedWhileBlocked() { return skippedWhileBlocked; },
    dispose() { off(); },
  };
}

/** The notice shown where a new message was refused. */
export const UPDATE_BLOCK_NOTICE = 'An update is being installed, so new messages are paused for a minute or two.';

/** A turn refused because an update is running (HTTP 503). */
export class UpdateBlockedError extends Error {
  readonly status = 503;
  constructor() { super(UPDATE_BLOCK_NOTICE); this.name = 'UpdateBlockedError'; }
}

/** Run a background model run that is not in the query queue (the author, the handoff, the digest, the summarizer) so the updater can see it. */
export async function trackBackgroundRun<T>(fn: () => Promise<T>): Promise<T> {
  const done = trackBackgroundStart();
  try { return await fn(); } finally { done(); }
}
/** The same, for code that already has its own try/finally: call the returned function once when the run ends. */
export function trackBackgroundStart(): () => void {
  inFlight++;
  let ended = false;
  return () => { if (!ended) { ended = true; inFlight--; } };
}
export function backgroundRunsInFlight(): number { return inFlight; }
/** Test hook. */
export function _resetUpdateBlock(): void { blocking = false; inFlight = 0; noticed.clear(); }
