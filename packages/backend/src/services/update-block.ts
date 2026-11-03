// While an in-app update is installing, building or restarting, work that would start a model run or touch the files being swapped waits.
// One process-level flag (the updater sets it; the interactive entry points, the orchestrator's wakes, the outlook author, the handoff and the
// rolling summarizer check it, through backgroundRunsOff() in tenancy/context.ts and updateBlocking() here), and a count of the background
// model runs that are in flight, so the updater's start guard and its turn fence see runs that are not in the query queue.
let blocking = false;
let inFlight = 0;

/** True while an update job is installing, building or restarting. */
export function updateBlocking(): boolean { return blocking; }
export function setUpdateBlocking(on: boolean): void { blocking = on; }

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
export function _resetUpdateBlock(): void { blocking = false; inFlight = 0; }
