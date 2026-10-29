/** Pure helpers for the Identity settings section and the header notice.
 *  The shapes mirror the backend's (packages/backend/src/services/identity/types.ts): GET /api/identity/status,
 *  /history and /diff, and the `identity_status` socket message. */

export type IdentityState = 'ok' | 'pending' | 'unratified' | 'unavailable' | 'legacy';
export type IdentityAuthor = 'person' | 'companion' | 'filesystem' | 'baseline' | 'revert';
export type IdentityChangeKind = 'added' | 'removed' | 'modified';
export interface IdentityFileChange { path: string; kind: IdentityChangeKind }

export interface IdentityStatus {
  state: IdentityState;
  digest: string;
  ratified: { digest: string; at: string; by: 'person' | 'setup' } | null;
  pending: { changes: IdentityFileChange[]; author: IdentityAuthor | null; authors?: IdentityAuthor[]; since: string | null } | null;
  files: string[];
  skipped: string[];
  detail: string | null;
  /** The person can ratify now; with state unavailable this is the way out. Absent from an older server. */
  canRatify?: boolean;
  /** A standing warning about where the ledger sits (inside a folder the companion can write). */
  warning?: string | null;
  checkedAt: string;
}

export interface IdentityJournalEntry {
  at: string;
  digest_before: string;
  digest_after: string;
  files: { added: string[]; removed: string[]; modified: string[] };
  author: IdentityAuthor;
  detail: string;
  kind?: 'change' | 'ratify';
}

/** One file of GET /api/identity/diff. `diff` is unified text; `binary` and `truncated` files have none. */
export interface IdentityDiffFile { path: string; kind: IdentityChangeKind; diff?: string; binary?: boolean; truncated?: boolean }

const STATES: IdentityState[] = ['ok', 'pending', 'unratified', 'unavailable', 'legacy'];

export function isIdentityStatus(v: unknown): v is IdentityStatus {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.state === 'string' && (STATES as string[]).includes(r.state) && typeof r.digest === 'string' && typeof r.checkedAt === 'string' && Array.isArray(r.files);
}

/** A socket message that is an `identity_status` push: the record when it is well formed (null when it is not), undefined when it is some other message. */
export function identityPush(m: unknown): IdentityStatus | null | undefined {
  if (!m || typeof m !== 'object' || (m as { type?: unknown }).type !== 'identity_status') return undefined;
  const status = (m as { status?: unknown }).status;
  return isIdentityStatus(status) ? status : null;
}

/** The parts of a status the card shows beyond the digest: its state, what is ratified, who changed the files, and whether Ratify may go ahead. */
const statusKey = (s: IdentityStatus): string => JSON.stringify([
  s.state, s.digest, s.ratified?.digest ?? null,
  s.pending ? (s.pending.authors?.length ? s.pending.authors : s.pending.author ? [s.pending.author] : []) : null,
  s.canRatify === true,
]);
/** Whether a pushed status means the card must reload. The digest alone is not enough: another tab ratifying the displayed files moves the state
 *  (pending or unratified to ok) and the ratified digest with the live digest unchanged. Same everything: no reload. */
export const statusNeedsReload = (shown: IdentityStatus | null | undefined, pushed: IdentityStatus | null | undefined): boolean =>
  !!pushed && !!shown && statusKey(shown) !== statusKey(pushed);

export type Tone = 'ok' | 'warn' | 'muted';

export function identityBadge(state: IdentityState | undefined): { label: string; tone: Tone } {
  switch (state) {
    case 'ok': return { label: 'Ratified', tone: 'ok' };
    case 'pending': return { label: 'Change waiting', tone: 'warn' };
    case 'unratified': return { label: 'Not yet ratified', tone: 'warn' };
    case 'legacy': return { label: 'Not used', tone: 'muted' };
    default: return { label: 'Unavailable', tone: 'muted' };
  }
}

/** The chat header's line: only while a change waits or nothing has been ratified. Quieter than an error. */
export function identityHeaderNotice(status: IdentityStatus | null | undefined): string | null {
  if (!status) return null;
  if (status.state === 'pending') return 'Identity change waiting';
  if (status.state === 'unratified') return 'Identity not yet ratified';
  if (status.state === 'unavailable') return 'Identity needs attention';
  return null;
}

export function authorLabel(author: IdentityAuthor | null | undefined): string {
  switch (author) {
    case 'person': return 'you';
    case 'companion': return 'your companion';
    case 'filesystem': return 'something on disk';
    case 'baseline': return 'first look at the folder';
    case 'revert': return 'a rollback';
    default: return 'someone';
  }
}

/** "your companion and you": everyone who changed the files since the ratified version, in the order they first did. */
export function authorsLabel(authors: readonly (IdentityAuthor | null | undefined)[]): string {
  const words = authors.filter((a, i) => authors.indexOf(a) === i).map(authorLabel);
  if (words.length === 0) return authorLabel(null);
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function changeSummary(changes: IdentityFileChange[] | undefined): string {
  if (!changes || changes.length === 0) return '';
  return (['added', 'modified', 'removed'] as const)
    .map((k) => [k, changes.filter((c) => c.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? 'file' : 'files'} ${k}`)
    .join(', ');
}

export const changeLine = (c: IdentityFileChange): string => `${c.kind} ${c.path}`;

/** What the pending card says first. */
export function pendingHeadline(status: IdentityStatus): string {
  if (status.state !== 'pending' || !status.pending) return '';
  const list = status.pending.authors?.length ? status.pending.authors : status.pending.author ? [status.pending.author] : [];
  if (list.length === 0) return `Waiting for you: ${changeSummary(status.pending.changes) || 'the ratified copy is missing'}.`;
  const who = list.every((a) => a === 'filesystem') ? 'Changed on disk' : `Changed by ${authorsLabel(list)}`;
  return `${who}: ${changeSummary(status.pending.changes)}.`;
}

/** Whether the Ratify button shows: always while unratified or waiting; while unavailable only when the server says ratifying can go ahead. */
export const showRatifyWhenUnavailable = (status: IdentityStatus | null): boolean => !!status && status.state === 'unavailable' && status.canRatify === true;

/** Whether the Ratify button may be pressed: the files on screen are the ones the status is about. The person approves text they have been shown, so
 *  nothing is ratifiable before the files have loaded, or while they are of another digest than the status (the next load catches up). */
export const ratifyReady = (status: IdentityStatus | null, filesDigest: string): boolean => !!status && filesDigest !== '' && filesDigest === status.digest;
/** The damaged-ledger card may only offer Ratify once the text the person would approve is actually on screen: not while loading, never on an error. */
export const diffsShown = (diffs: unknown): boolean => diffs !== null && diffs !== 'loading' && diffs !== 'error' && typeof diffs === 'object';

/** What each journal line means now, against the live status. */
export type EntryState = 'ratified' | 'waiting' | 'superseded';
export function entryState(entry: IdentityJournalEntry, status: IdentityStatus | null): EntryState {
  if (entry.kind === 'ratify') return 'ratified';
  if (!status) return 'superseded';
  if (status.ratified && entry.digest_after === status.ratified.digest) return 'ratified';
  if (status.state === 'pending' && entry.digest_after === status.digest) return 'waiting';
  return 'superseded';
}

export const ENTRY_STATE_WORDS: Record<EntryState, string> = { ratified: 'ratified', waiting: 'waiting for you', superseded: 'replaced since' };

/** "profile.md, companion.md" for a journal line; a ratify line names nothing. */
export function entryFiles(entry: IdentityJournalEntry): string {
  const names = [...entry.files.added, ...entry.files.modified, ...entry.files.removed];
  if (names.length === 0) return entry.kind === 'ratify' ? '' : '(no files)';
  return names.slice(0, 4).join(', ') + (names.length > 4 ? `, and ${names.length - 4} more` : '');
}

export function entryTitle(entry: IdentityJournalEntry): string {
  if (entry.kind === 'ratify') return entry.author === 'baseline' ? 'Ratified at setup' : 'Ratified by you';
  switch (entry.author) {
    case 'person': return 'Edited by you';
    case 'companion': return 'Edited by your companion';
    case 'filesystem': return 'Changed on disk';
    case 'baseline': return 'First look at the folder';
    case 'revert': return 'Rolled back by you';
    default: return 'Changed';
  }
}

export function describeWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const mins = Math.round((now.getTime() - t.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return t.toLocaleDateString([], { month: 'short', day: 'numeric', year: t.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export type DiffLineKind = 'header' | 'hunk' | 'add' | 'del' | 'context';
export interface DiffLine { kind: DiffLineKind; text: string }

/** A unified diff as lines tagged for colouring. */
export function parseDiff(diff: string | undefined): DiffLine[] {
  if (!diff) return [];
  return diff.split('\n').map((text): DiffLine => {
    if (text.startsWith('--- ') || text.startsWith('+++ ')) return { kind: 'header', text };
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    return { kind: 'context', text };
  });
}

export function diffNote(f: IdentityDiffFile): string | null {
  if (f.binary) return 'Not shown: this file is not plain text.';
  if (f.truncated) return 'Not shown: this file is larger than 256 KB.';
  if (f.diff === undefined || f.diff === '') return 'No text changes.';
  return null;
}

export interface WriteFailure { message: string; reload: boolean }

/** What a refused save, ratify or revert says. A 409 means the files moved since the digest on screen: reload, never retry blind. */
export function interpretWriteFailure(status: number, body: unknown, what: 'save' | 'ratify' | 'revert' = 'save'): WriteFailure {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; detail?: unknown };
  const error = typeof b.error === 'string' ? b.error : '';
  const detail = typeof b.detail === 'string' ? b.detail : '';
  if (status === 401) return { message: 'Your session has ended. Sign in again.', reload: false };
  if (status === 409 && error === 'digest_mismatch') {
    return { message: what === 'save' ? 'The file changed since you opened it. Reload to see the current version.' : 'The identity files changed while you were looking. Reload and review them again.', reload: true };
  }
  if (status === 409 && error === 'nothing_to_revert') return { message: 'There is nothing waiting to roll back.', reload: true };
  if (status === 409) return { message: detail || 'That could not be done as things stand. Reload and try again.', reload: true };
  if (status === 503) return { message: detail || 'The identity check is not available right now.', reload: false };
  if (status === 400) return { message: detail || 'That was not accepted.', reload: false };
  return { message: detail || `It failed (${status}).`, reload: false };
}

export const isDirty = (original: string, draft: string): boolean => original !== draft;

/** The save button: something changed, nothing is in flight, and the text is within the size the server takes. */
export function canSave(original: string, draft: string, busy: boolean): boolean {
  return !busy && isDirty(original, draft) && new TextEncoder().encode(draft).length <= 1024 * 1024;
}

/** The note under the editor: what saving will do. A save ratifies only when the folder was at the ratified version. */
export function saveHint(status: IdentityStatus | null): string {
  if (!status) return '';
  if (status.state === 'ok') return 'Saving changes the file and ratifies it in one step.';
  if (status.state === 'pending') return 'A change is already waiting. Saving writes your edit but does not ratify it; review the waiting change first.';
  if (status.state === 'unratified') return 'Nothing is ratified yet. Saving writes your edit; ratify the whole set when you have read it.';
  if (status.state === 'legacy') return 'There is no identity folder, so saving is turned off.';
  return 'The identity check is not available, so saving is turned off.';
}

export const canEdit = (status: IdentityStatus | null): boolean => !!status && status.state !== 'unavailable' && status.state !== 'legacy';

/** The one sentence the Settings card says for a home with no identity/ folder. */
export const LEGACY_EXPLANATION = 'This home has no identity/ folder, so your companion\'s identity lives in CLAUDE.md and there is nothing to ratify. To move to ratified identity files, create an identity/ folder in the home with profile.md and companion.md, then restart.';
