import { describe, it, expect } from 'vitest';
import {
  authorsLabel, LEGACY_EXPLANATION, statusNeedsReload, showRatifyWhenUnavailable, ratifyReady, diffsShown, isIdentityStatus, identityPush, identityBadge, identityHeaderNotice, authorLabel, changeSummary, pendingHeadline, entryState, entryFiles, entryTitle,
  describeWhen, parseDiff, diffNote, interpretWriteFailure, canSave, saveHint, canEdit, type IdentityStatus, type IdentityJournalEntry,
} from './identityState';

const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);
const status = (over: Partial<IdentityStatus> = {}): IdentityStatus => ({
  state: 'ok', digest: D1, ratified: { digest: D1, at: '2026-10-21T10:00:00.000Z', by: 'person' }, pending: null, files: ['companion.md'], skipped: [], detail: null, checkedAt: '2026-10-21T10:00:00.000Z', ...over,
});
const pending = (author: IdentityStatus['pending'] extends infer P ? any : never = 'companion'): IdentityStatus => status({
  state: 'pending', digest: D2, pending: { changes: [{ path: 'companion.md', kind: 'modified' }, { path: 'new.md', kind: 'added' }], author, since: '2026-10-21T11:00:00.000Z' },
});
const entry = (over: Partial<IdentityJournalEntry> = {}): IdentityJournalEntry => ({
  at: '2026-10-21T11:00:00.000Z', digest_before: D1, digest_after: D2, files: { added: [], removed: [], modified: ['companion.md'] }, author: 'companion', detail: 'x', ...over,
});

describe('isIdentityStatus', () => {
  it('accepts the record and refuses anything else', () => {
    expect(isIdentityStatus(status())).toBe(true);
    expect(isIdentityStatus(null)).toBe(false);
    expect(isIdentityStatus({ state: 'weird', digest: '', checkedAt: 'x', files: [] })).toBe(false);
    expect(isIdentityStatus({ state: 'ok', digest: '', checkedAt: 'x' })).toBe(false);
  });
});

describe('identityPush: the socket message', () => {
  it('reads an identity_status push, ignores every other message, and refuses a malformed record', () => {
    expect(identityPush({ type: 'identity_status', status: status() })).toMatchObject({ state: 'ok' });
    expect(identityPush({ type: 'mind_status', status: status() })).toBeUndefined();
    expect(identityPush({ type: 'identity_status', status: { state: 'ok' } })).toBeNull();
    expect(identityPush(null)).toBeUndefined();
  });
});

describe('the header notice', () => {
  it('says so only while a change waits or nothing is ratified', () => {
    expect(identityHeaderNotice(pending())).toBe('Identity change waiting');
    expect(identityHeaderNotice(status({ state: 'unratified', ratified: null }))).toBe('Identity not yet ratified');
    expect(identityHeaderNotice(status())).toBeNull();
    expect(identityHeaderNotice(status({ state: 'unavailable' }))).toBe('Identity needs attention');
    expect(identityHeaderNotice(null)).toBeNull();
  });
});

describe('an unavailable check has a way out', () => {
  it('the Ratify button shows while unavailable only when the server says ratifying can go ahead', () => {
    expect(showRatifyWhenUnavailable(status({ state: 'unavailable', canRatify: true }))).toBe(true);
    expect(showRatifyWhenUnavailable(status({ state: 'unavailable', canRatify: false }))).toBe(false);
    expect(showRatifyWhenUnavailable(status({ state: 'unavailable' }))).toBe(false);
    expect(showRatifyWhenUnavailable(status({ canRatify: true }))).toBe(false);
    expect(showRatifyWhenUnavailable(null)).toBe(false);
  });
  it('a pending state with no author (the ratified copy was missing) still heads the card', () => {
    const p = pending(null);
    expect(pendingHeadline(p)).toBe('Waiting for you: 1 file added, 1 file modified.');
  });
});

describe('badge, author, summary', () => {
  it('plain words for every state', () => {
    expect(identityBadge('ok')).toEqual({ label: 'Ratified', tone: 'ok' });
    expect(identityBadge('pending').tone).toBe('warn');
    expect(identityBadge('unratified').label).toBe('Not yet ratified');
    expect(identityBadge('unavailable').tone).toBe('muted');
    expect(identityBadge(undefined).label).toBe('Unavailable');
  });
  it('names who changed it without claiming more than the journal does', () => {
    expect(authorLabel('filesystem')).toBe('something on disk');
    expect(authorLabel('companion')).toBe('your companion');
    expect(authorLabel('person')).toBe('you');
    expect(authorLabel(null)).toBe('someone');
  });
  it('summarises the changes and heads the pending card', () => {
    expect(changeSummary([{ path: 'a', kind: 'added' }, { path: 'b', kind: 'modified' }, { path: 'c', kind: 'modified' }])).toBe('1 file added, 2 files modified');
    expect(changeSummary([])).toBe('');
    expect(pendingHeadline(pending('filesystem'))).toBe('Changed on disk: 1 file added, 1 file modified.');
    expect(pendingHeadline(status())).toBe('');
  });
  it('names every author since the ratified version in people words, not enum values', () => {
    const both = pending('person');
    both.pending!.authors = ['companion', 'person'];
    expect(pendingHeadline(both)).toBe('Changed by your companion and you: 1 file added, 1 file modified.');
    expect(authorsLabel(['companion', 'person', 'filesystem'])).toBe('your companion, you and something on disk');
    expect(authorsLabel(['companion', 'companion'])).toBe('your companion');
  });
});

describe('history', () => {
  it('a line is ratified when it is the ratified digest, waiting when it is the live pending one, replaced otherwise', () => {
    expect(entryState(entry({ digest_after: D1 }), status())).toBe('ratified');
    expect(entryState(entry({ digest_after: D2 }), pending())).toBe('waiting');
    expect(entryState(entry({ digest_after: 'c'.repeat(64) }), pending())).toBe('superseded');
    expect(entryState(entry({ kind: 'ratify' }), null)).toBe('ratified');
    expect(entryState(entry(), null)).toBe('superseded');
  });
  it('titles and file lists', () => {
    expect(entryTitle(entry({ author: 'person' }))).toBe('Edited by you');
    expect(entryTitle(entry({ author: 'baseline', kind: 'ratify' }))).toBe('Ratified at setup');
    expect(entryTitle(entry({ author: 'revert' }))).toBe('Rolled back by you');
    expect(entryFiles(entry({ files: { added: ['a'], modified: ['b'], removed: ['c', 'd', 'e', 'f'] } }))).toBe('a, b, c, d, and 2 more');
    expect(entryFiles(entry({ kind: 'ratify', files: { added: [], modified: [], removed: [] } }))).toBe('');
  });
  it('relative times', () => {
    const now = new Date('2026-10-21T12:00:00.000Z');
    expect(describeWhen('2026-10-21T11:59:40.000Z', now)).toBe('just now');
    expect(describeWhen('2026-10-21T11:30:00.000Z', now)).toBe('30 min ago');
    expect(describeWhen('2026-10-21T09:00:00.000Z', now)).toBe('3 h ago');
    expect(describeWhen(null, now)).toBe('');
    expect(describeWhen('not a date', now)).toBe('not a date');
  });
});

describe('diff display', () => {
  it('tags unified lines for colouring', () => {
    const lines = parseDiff('--- a/x\n+++ b/x\n@@ -1,1 +1,2 @@\n-old\n+new\n+more\n same');
    expect(lines.map((l) => l.kind)).toEqual(['header', 'header', 'hunk', 'del', 'add', 'add', 'context']);
    expect(parseDiff(undefined)).toEqual([]);
  });
  it('says why a file has no diff', () => {
    expect(diffNote({ path: 'a', kind: 'added', binary: true })).toMatch(/not plain text/);
    expect(diffNote({ path: 'a', kind: 'added', truncated: true })).toMatch(/256 KB/);
    expect(diffNote({ path: 'a', kind: 'modified', diff: '' })).toBe('No text changes.');
    expect(diffNote({ path: 'a', kind: 'modified', diff: '--- a\n+++ b' })).toBeNull();
  });
});

describe('failures', () => {
  it('a 409 digest mismatch on save says the file changed since you opened it, and to reload', () => {
    const f = interpretWriteFailure(409, { error: 'digest_mismatch' }, 'save');
    expect(f.message).toBe('The file changed since you opened it. Reload to see the current version.');
    expect(f.reload).toBe(true);
  });
  it('a 409 on ratify or revert says the files changed while you were looking', () => {
    expect(interpretWriteFailure(409, { error: 'digest_mismatch' }, 'ratify').message).toMatch(/changed while you were looking/);
    expect(interpretWriteFailure(409, { error: 'nothing_to_revert' }, 'revert').message).toMatch(/nothing waiting/);
  });
  it('other refusals pass the server\'s sentence along', () => {
    expect(interpretWriteFailure(400, { error: 'bad_name', detail: 'path must be the name of a file' }).message).toBe('path must be the name of a file');
    expect(interpretWriteFailure(401, null).message).toMatch(/Sign in/);
    expect(interpretWriteFailure(503, { detail: 'the ledger is damaged' }).message).toBe('the ledger is damaged');
    expect(interpretWriteFailure(500, null).message).toBe('It failed (500).');
  });
});

describe('the editor', () => {
  it('save is on only for a changed draft that is not already being saved and fits', () => {
    expect(canSave('a', 'b', false)).toBe(true);
    expect(canSave('a', 'a', false)).toBe(false);
    expect(canSave('a', 'b', true)).toBe(false);
    expect(canSave('a', 'x'.repeat(1024 * 1024 + 1), false)).toBe(false);
  });
  it('the hint says what saving does, and saving is off when the check is unavailable', () => {
    expect(saveHint(status())).toMatch(/ratifies it in one step/);
    expect(saveHint(pending())).toMatch(/does not ratify/);
    expect(saveHint(status({ state: 'unratified' }))).toMatch(/Nothing is ratified yet/);
    expect(canEdit(status({ state: 'unavailable' }))).toBe(false);
    expect(canEdit(null)).toBe(false);
    expect(canEdit(pending())).toBe(true);
  });
});

describe('diffsShown: the damaged-ledger card offers Ratify only once the text is on screen', () => {
  it('is false while loading, on an error, or with nothing, and true with loaded diffs', () => {
    expect(diffsShown(null)).toBe(false);
    expect(diffsShown('loading')).toBe(false);
    expect(diffsShown('error')).toBe(false);
    expect(diffsShown({ 'profile.md': { path: 'profile.md', diff: '+x' } })).toBe(true);
  });
});

describe('ratifyReady: the person approves only files they have been shown', () => {
  it('is false before the files load, and while they are of another digest than the status', () => {
    const damaged = status({ state: 'unavailable', canRatify: true, digest: D2 });
    expect(ratifyReady(damaged, '')).toBe(false);
    expect(ratifyReady(damaged, D1)).toBe(false);
    expect(ratifyReady(damaged, D2)).toBe(true);
    expect(ratifyReady(null, D2)).toBe(false);
  });
});

describe('legacy: no identity folder', () => {
  it('has no header notice, a quiet badge, no editing, and an explanation that names CLAUDE.md', () => {
    const s = status({ state: 'legacy', ratified: null, digest: '', canRatify: false });
    expect(isIdentityStatus(s)).toBe(true);
    expect(identityHeaderNotice(s)).toBeNull();
    expect(identityBadge('legacy').tone).toBe('muted');
    expect(canEdit(s)).toBe(false);
    expect(showRatifyWhenUnavailable(s)).toBe(false);
    expect(LEGACY_EXPLANATION).toMatch(/CLAUDE\.md/);
    expect(LEGACY_EXPLANATION).toMatch(/identity\//);
  });
});

describe('statusNeedsReload: which pushes make the card reload', () => {
  const waiting = (over: Partial<IdentityStatus> = {}) => status({ state: 'pending', digest: D2, pending: { changes: [{ path: 'companion.md', kind: 'modified' }], author: 'companion', authors: ['companion'], since: null }, canRatify: true, ...over });
  it('same digest, pending to ok (another tab ratified the files on screen): reload', () => {
    const ok = status({ digest: D2, ratified: { digest: D2, at: '2026-10-21T12:00:00.000Z', by: 'person' }, canRatify: true });
    expect(statusNeedsReload(waiting(), ok)).toBe(true);
    expect(statusNeedsReload(status({ state: 'unratified', digest: D2, ratified: null, canRatify: true }), ok)).toBe(true);
  });
  it('same digest, ok to pending: reload', () => {
    const ok = status({ digest: D2, ratified: { digest: D2, at: '2026-10-21T12:00:00.000Z', by: 'person' }, canRatify: true });
    expect(statusNeedsReload(ok, waiting())).toBe(true);
  });
  it('a different digest: reload', () => {
    expect(statusNeedsReload(waiting(), waiting({ digest: D1 }))).toBe(true);
  });
  it('the authors or canRatify moving at the same digest: reload', () => {
    const more = waiting({ pending: { changes: [], author: 'person', authors: ['companion', 'person'], since: null } });
    expect(statusNeedsReload(waiting(), more)).toBe(true);
    expect(statusNeedsReload(waiting(), waiting({ canRatify: false }))).toBe(true);
  });
  it('same everything (only the check time differs): no reload; nothing to compare: no reload', () => {
    expect(statusNeedsReload(waiting(), waiting({ checkedAt: '2026-10-21T12:30:00.000Z' }))).toBe(false);
    expect(statusNeedsReload(status(), status())).toBe(false);
    expect(statusNeedsReload(null, status())).toBe(false);
    expect(statusNeedsReload(status(), null)).toBe(false);
  });
});
