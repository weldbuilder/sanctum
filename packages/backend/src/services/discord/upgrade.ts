// Upgrading from the old `discord: { enabled, owner_user_id }` block. There are no private lists yet,
// so the word gate has nothing to read and (fail closed, as designed) every reply is blocked. That
// stays. What this adds: say so, loudly, once at start, and once a day in the daily thread, with the fix.

import type { GateStatus } from './gate.js';

export const MISSING_WORDS_NOTICE =
  'Discord is on, but its word list does not exist yet, so every reply is blocked and nothing is sent. '
  + 'Run `npm run setup` once: it creates the private folder with example lists. Replace the made-up entries with your own, and replies start again.';

export interface AnnounceDeps {
  /** The word list: its status, and the message that names the path (server log only). */
  inspect: () => { status: GateStatus; message?: string };
  warn: (msg: string) => void;
  dailyThreadId: () => string;
  /** Post a system line to a thread. */
  post: (threadId: string, text: string) => void;
  /** The daily thread id the notice last went to, so it is posted once a day, not once a restart. */
  getStamp: () => string | null;
  setStamp: (v: string) => void;
}

/** True when the words list is missing (and so the notice was due). Logs every time, posts at most once a day. */
export function announceMissingWords(d: AnnounceDeps): boolean {
  const { status, message } = d.inspect();
  if (status.state !== 'failed' || status.kind !== 'missing') return false;
  d.warn(`[Discord] ${message ?? 'the word list is missing'}. Every outgoing Discord message is BLOCKED until it exists. Run \`npm run setup\` to create the private folder and example lists (docs/DISCORD-PLAN.md, UPGRADE.md).`);
  const thread = d.dailyThreadId();
  if (d.getStamp() !== thread) {
    d.post(thread, MISSING_WORDS_NOTICE);
    d.setStamp(thread);
  }
  return true;
}
