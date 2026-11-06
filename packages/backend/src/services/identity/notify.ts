// Telling the person: one line in the active thread and a socket push when a change is first noticed, and a
// push whenever the state moves so the header notice follows it. The line is posted once per distinct digest
// (ledger.json remembers which one), so a change that waits for a day does not repeat itself every turn.
import { ensureDailyThread } from '../db.js';
import { registry } from '../ws.js';
import { postSystemLine } from '../system-line.js';
import { markAnnounced, readIdentityLedger, pruneIdentitySnapshots, type IdentityCheck } from './ledger.js';
import { nameList, setIdentityListener } from './guard.js';
import { tenantLocal } from '../../tenancy/context.js';
import { appLedger, currentIdentity, ledgerPlacementWarning, toStatus } from './status.js';

/** The socket message goes out with the same cast as `mantelpiece_update` (api.ts): the message type is not in @sanctum/shared. */
function broadcastStatus(check: IdentityCheck): void {
  registry.broadcast({ type: 'identity_status', status: toStatus(check) } as unknown as Parameters<typeof registry.broadcast>[0]);
}

/** Push the state to every open app (after a ratify, a revert, an edit). */
export function publishIdentity(check: IdentityCheck): void {
  try { broadcastStatus(check); } catch (e) { console.warn('[identity] could not broadcast the status:', e instanceof Error ? e.message : e); }
}

const AUTHOR_WORDS: Record<string, string> = {
  person: 'you', companion: 'your companion', filesystem: 'something on disk', baseline: 'the first look at the folder', revert: 'a rollback',
};
/** "your companion and you": the people-facing words for the authors since the ratified version, in the order they first changed it. */
export function authorsLabel(authors: readonly string[]): string {
  const words = authors.map((a) => AUTHOR_WORDS[a] ?? 'someone');
  if (words.length === 0) return 'someone';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The line for a change that is waiting. */
export function pendingNotice(check: IdentityCheck): string {
  const authors = check.authors?.length ? check.authors : check.author ? [check.author] : [];
  const who = authors.length > 0 && authors.every((a) => a === 'filesystem') ? 'Changed on disk' : `Changed by ${authorsLabel(authors)}`;
  return `Identity change waiting: ${nameList((check.changes ?? []).map((c) => c.path)).join(', ')}. ${who}. Settings → You & them.`;
}

/** While a change keeps waiting, at most one thread line per this long, even when the digest keeps changing (a writer in a loop). */
export const LINE_INTERVAL_MS = 10 * 60 * 1000;

// Per tenant in tenant mode, so one tenant's "already pushed" never silences another's notice.
const notifyState = tenantLocal(() => ({ lastPushed: '', lastState: '' }));
/** Forget what was last pushed and which state was last heard (tests, boot). */
export function resetIdentityNotify(): void { notifyState.set({ lastPushed: '', lastState: '' }); }

/** The line for a check that could not run, or whose ledger cannot be used. */
export function unavailableNotice(check: IdentityCheck): string {
  const why = (check.detail ?? 'the check could not run').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 240);
  const runs = check.snapshot ? 'Runs use the ratified copy.' : 'Runs use the live files.';
  return `Identity needs attention: ${why}. ${runs} Settings → You & them.`;
}

/** Heard for every check that found a change waiting (guard.ts). The socket push goes out whenever the state or the digest moved (cheap, and the
 *  header follows it). The thread line goes out when the state moves into pending, and while it stays pending at most one per LINE_INTERVAL_MS
 *  even when the digest keeps changing. ledger.json remembers the digest and the time of the last line. */
export function announceIdentity(check: IdentityCheck): void {
  const st = notifyState.get();
  const previous = st.lastState;
  st.lastState = check.state;
  if (check.state === 'unavailable' && previous !== 'unavailable') {
    // One line on entering the state, not on every check while it lasts.
    try { postSystemLine(ensureDailyThread().thread.id, unavailableNotice(check), 'identity_pending', { identityUnavailable: true }); } catch (e) { console.warn('[identity] could not post the thread line:', e instanceof Error ? e.message : e); }
  }
  if (check.state !== 'pending') {
    // Any other move of the state is pushed too, so an open app's header never stays on a state that has passed.
    const key = `${check.state}|${check.digest}`;
    if (key !== st.lastPushed) { publishIdentity(check); st.lastPushed = key; }
    return;
  }
  if (!check.digest) return;
  const l = appLedger();
  if (!l) return;
  const now = Date.now();
  const { announced, announced_at } = readIdentityLedger(l.opts.ledgerDir).ledger;
  const last = announced_at ? Date.parse(announced_at) : NaN;
  const quiet = announced === check.digest || (Number.isFinite(last) && now - last < LINE_INTERVAL_MS && now >= last);
  let posted = false;
  if (!quiet) {
    try {
      const thread = ensureDailyThread().thread;
      posted = postSystemLine(thread.id, pendingNotice(check), 'identity_pending', { identityDigest: check.digest });
    } catch (e) { console.warn('[identity] could not post the thread line:', e instanceof Error ? e.message : e); }
  }
  const key = `${check.state}|${check.digest}`;
  if (posted || key !== st.lastPushed) { publishIdentity(check); st.lastPushed = key; }
  if (posted) markAnnounced(l.opts.ledgerDir, check.digest, new Date(now));
}

/** Boot: register the listener, take the first look (a folder with no ledger gets its baseline line and answers unratified), drop snapshots
 *  nothing points at, and say what it found. Never throws. */
export function startIdentityGate(): void {
  setIdentityListener(announceIdentity);
  try {
    const l = appLedger();
    if (!l) { console.log('[identity] no ledger folder is configured: identity is read as it is, with no ratification'); return; }
    const placement = ledgerPlacementWarning();
    if (placement) console.warn(`[identity] ${placement}`);
    const cur = currentIdentity();
    if (!cur) return;
    try { pruneIdentitySnapshots(l.opts.ledgerDir, { keepPrevious: true }); } catch { /* old copies linger until the next ratification */ }
    const s = cur.status;
    console.log(`[identity] ${s.state}${s.state === 'pending' ? ` (${s.pending?.changes.length ?? 0} file${s.pending?.changes.length === 1 ? '' : 's'} waiting; runs use the ratified copy)` : s.state === 'unratified' ? ' (nothing ratified yet: Settings → You & them)' : s.state === 'unavailable' ? ` (${s.detail})` : s.state === 'legacy' ? ' (no identity/ folder: identity is CLAUDE.md, nothing to ratify)' : ''}`);
  } catch (e) { console.warn('[identity] boot check failed:', e instanceof Error ? e.message : e); }
}
