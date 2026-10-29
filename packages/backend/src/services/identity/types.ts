// The wire shapes of the identity ratification gate (docs/PLUGINS.md "Identity ratification"): GET /api/identity/status,
// GET /api/identity/history and the `identity_status` socket message. They live here and not in @sanctum/shared:
// the socket message goes out with the same cast as `mantelpiece_update`, and the frontend mirrors the shapes in
// components/settings/identityState.ts.

/** ok: the files on disk are the ratified ones. pending: they differ, and runs use the ratified copy until the person ratifies.
 *  unratified: nothing has been ratified yet (the live files are served). unavailable: the check could not run (`detail` says why).
 *  legacy: the home has no identity/ folder, so identity is the legacy CLAUDE.md and there is nothing to ratify (not a problem: no notice, no ledger). */
export type IdentityState = 'ok' | 'pending' | 'unratified' | 'unavailable' | 'legacy';
/** Who made a change to the identity files: the person (the in-app editor), the companion (its identity write verb),
 *  the filesystem (a change on disk that no app route made), baseline (first sight of the folder), revert (the person rolled back). */
export type IdentityAuthor = 'person' | 'companion' | 'filesystem' | 'baseline' | 'revert';
export interface IdentityFileChange { path: string; kind: 'added' | 'removed' | 'modified' }
export interface IdentityStatus {
  state: IdentityState;
  /** Digest of the identity files on disk now; '' when they could not be read. */
  digest: string;
  ratified: { digest: string; at: string; by: 'person' | 'setup' } | null;
  /** The change waiting for the person, when state is pending. `authors` is everyone who changed the files since the ratified version, in the order they first did;
   *  `author` is the most recent of them (kept for older readers). */
  pending: { changes: IdentityFileChange[]; author: IdentityAuthor | null; authors: IdentityAuthor[]; since: string | null } | null;
  /** Names of the identity files on disk now, and of entries left out (links). */
  files: string[];
  skipped: string[];
  /** One plain line when state is unavailable, or when the ledger could not be written. */
  detail: string | null;
  /** The person can ratify now (not so when the live folder cannot be read or the ledger folder is refused). With state unavailable this is the way out. */
  canRatify: boolean;
  /** A standing warning about how the ledger is set up (it sits where the companion can write), or null. */
  warning: string | null;
  checkedAt: string;
}
/** One line of the identity journal (GET /api/identity/history), newest first. */
export interface IdentityJournalEntry {
  at: string;
  digest_before: string;
  digest_after: string;
  files: { added: string[]; removed: string[]; modified: string[] };
  author: IdentityAuthor;
  detail: string;
  /** 'ratify': the line that records the person's approval (no file changed). */
  kind?: 'change' | 'ratify';
}
