import { describe, it, expect } from 'vitest';
import {
  ratificationBadge, changeSummary, changeLine, canReview, canReload, interpretRatifyFailure,
  orderFiles, describeDisabled, interpretFileView, ratifyFailureNote,
  readTrust, changedSinceView, canReviewAudit, describeChangeTime, interpretEnabledFailure, interpretSeenFailure, toggleEnabled,
  type PluginInfo,
} from './pluginsState';

const base: PluginInfo = {
  id: 'a', name: 'A', version: '1.0.0', harness: ['dsh'], routes: true, help: false,
  tenant_aware: false, enabled: true, error: null,
  ratification: { state: 'ok', digest: 'd1' },
};
const withState = (state: NonNullable<PluginInfo['ratification']>['state'], extra: Partial<PluginInfo> = {}): PluginInfo =>
  ({ ...base, ...extra, ratification: { ...base.ratification!, state } });

describe('ratificationBadge', () => {
  it('maps each state to plain words', () => {
    expect(ratificationBadge('ok').label).toBe('Ratified');
    expect(ratificationBadge('unratified').label).toBe('Not ratified');
    expect(ratificationBadge('changed').label).toBe('Changed since ratified');
    expect(ratificationBadge('unavailable').label).toBe('Unavailable');
  });
  it('treats an unknown state as unavailable', () => {
    expect(ratificationBadge('weird' as never).label).toBe('Unavailable');
  });
});

describe('changeSummary', () => {
  it('is empty text for no changes', () => {
    expect(changeSummary([])).toBe('');
    expect(changeSummary(undefined)).toBe('');
  });
  it('counts by kind, singular and plural', () => {
    expect(changeSummary([{ path: 'a', kind: 'added' }])).toBe('1 file added');
    expect(changeSummary([
      { path: 'a', kind: 'added' }, { path: 'b', kind: 'added' },
      { path: 'c', kind: 'modified' }, { path: 'd', kind: 'removed' },
    ])).toBe('2 files added, 1 file modified, 1 file removed');
  });
  it('changeLine puts the kind first', () => {
    expect(changeLine({ path: 'src/x.js', kind: 'modified' })).toBe('modified  src/x.js');
  });
});

describe('gating', () => {
  it('offers review only for unratified and changed', () => {
    expect(canReview(withState('unratified'))).toBe(true);
    expect(canReview(withState('changed'))).toBe(true);
    expect(canReview(withState('ok'))).toBe(false);
    expect(canReview(withState('unavailable'))).toBe(false);
  });
  it('offers reload only for routes + enabled + ratified', () => {
    expect(canReload(withState('ok'))).toBe(true);
    expect(canReload(withState('ok', { routes: false }))).toBe(false);
    expect(canReload(withState('ok', { enabled: false }))).toBe(false);
    expect(canReload(withState('changed'))).toBe(false);
    expect(canReload(withState('unratified'))).toBe(false);
  });
});

describe('interpretRatifyFailure', () => {
  it('digest_mismatch asks to review again and refreshes', () => {
    expect(interpretRatifyFailure(409, { error: 'digest_mismatch' })).toEqual({
      message: 'The files changed while you were reading. Review again.', refresh: true,
    });
  });
  it('plugin_invalid shows the detail without refreshing', () => {
    expect(interpretRatifyFailure(409, { error: 'plugin_invalid', detail: 'bad manifest' })).toEqual({
      message: 'This plugin cannot be ratified: bad manifest', refresh: false,
    });
  });
  it('falls back to the error text or status', () => {
    expect(interpretRatifyFailure(500, { error: 'boom' }).message).toBe('boom');
    expect(interpretRatifyFailure(500, null).message).toBe('Ratify failed (500)');
  });
});

describe('orderFiles', () => {
  const files = [
    { path: 'a.mjs', sha256: '1', size: 10 }, { path: 'b.md', sha256: '2', size: 20 },
    { path: 'c.json', sha256: '3', size: 30 }, { path: 'd.mjs', sha256: '4', size: 40 },
  ];
  it('lists changed files first (by path), marked with what changed, then the rest in their order', () => {
    const out = orderFiles(files, [{ path: 'd.mjs', kind: 'added' }, { path: 'b.md', kind: 'modified' }, { path: 'gone.txt', kind: 'removed' }]);
    expect(out.map((f) => f.path)).toEqual(['b.md', 'd.mjs', 'a.mjs', 'c.json']);
    expect(out.map((f) => f.change)).toEqual(['modified', 'added', undefined, undefined]);
  });
  it('is the list as it came when nothing changed', () => {
    expect(orderFiles(files, undefined).map((f) => f.path)).toEqual(['a.mjs', 'b.md', 'c.json', 'd.mjs']);
    expect(orderFiles(files, []).every((f) => f.change === undefined)).toBe(true);
  });
});

describe('describeDisabled', () => {
  it('full_access keeps its words', () => {
    const d = describeDisabled('full_access', undefined)!;
    expect(d.body).toMatch(/danger-full-access/);
    expect(d.body).toMatch(/workspace-write or read-only/);
  });
  it('ledger_writable names the root, the key to set, and why', () => {
    const d = describeDisabled('ledger_writable', 'agent.cwd /home/me/app')!;
    expect(d.title).toBe('Plugins are off.');
    expect(d.body).toContain('agent.cwd /home/me/app');
    expect(d.body).toContain('plugins.ledger_dir');
    expect(d.body).toMatch(/could change the record of what you approved/);
  });
  it('ledger_writable without a detail still reads', () => {
    expect(describeDisabled('ledger_writable', undefined)!.body).toContain('plugins.ledger_dir');
  });
  it('an unknown reason is a generic notice, and null is nothing', () => {
    expect(describeDisabled('something_new', undefined)!.title).toBe('Plugins are off.');
    expect(describeDisabled(null, undefined)).toBeNull();
  });
});

describe('interpretFileView', () => {
  it('text', () => {
    expect(interpretFileView(200, { path: 'a', sha256: 'x', size: 3, text: 'hey' })).toEqual({ kind: 'text', text: 'hey' });
    expect(interpretFileView(200, { path: 'a', sha256: 'x', size: 0, text: '' })).toEqual({ kind: 'text', text: '' });
  });
  it('binary or too large to show', () => {
    expect(interpretFileView(200, { path: 'a', sha256: 'x', size: 9, binary: true }).kind).toBe('binary');
  });
  it('errors say so in plain words', () => {
    expect(interpretFileView(404, null)).toEqual({ kind: 'error', message: 'That file is no longer in the plugin. Reload the list.' });
    expect(interpretFileView(409, { error: 'plugin_invalid', detail: 'links' })).toEqual({ kind: 'error', message: 'Cannot show it: links' });
    expect(interpretFileView(500, null).kind).toBe('error');
    expect(interpretFileView(200, { path: 'a' }).kind).toBe('error');
  });
});

describe('ratifyFailureNote', () => {
  it('a failed write of the record is explained', () => {
    expect(interpretRatifyFailure(500, { error: 'ledger_write_failed', detail: 'EACCES' }).message).toMatch(/could not save/i);
    expect(interpretRatifyFailure(500, { error: 'ledger_write_failed', detail: 'EACCES' }).message).toContain('EACCES');
  });
  it('ratifyFailureNote is the same text', () => {
    expect(ratifyFailureNote(500, { error: 'ledger_write_failed', detail: 'x' })).toBe(interpretRatifyFailure(500, { error: 'ledger_write_failed', detail: 'x' }).message);
  });
});

describe('companion mode helpers', () => {
  const comp = (audit: PluginInfo['audit'], extra: Partial<PluginInfo> = {}): PluginInfo => ({
    id: 'c', name: 'C', version: '1', harness: ['dsh'], routes: true, help: false, tenant_aware: false, enabled: true, error: null, warnings: [], audit, ...extra,
  });
  it('readTrust: companion only when the server says so; an older server is person mode', () => {
    expect(readTrust({ trust: 'companion', plugins: [] })).toBe('companion');
    expect(readTrust({ trust: 'person' })).toBe('person');
    expect(readTrust({ plugins: [] })).toBe('person');
    expect(readTrust(null)).toBe('person');
  });
  it('no ratification: the person-mode gates are off, not a crash', () => {
    const p = comp({ digest: 'd', last_change_at: null, changed_since_last_view: true, changes: [] });
    expect(canReview(p)).toBe(false);
    expect(ratificationBadge(undefined).label).toBe('Unavailable');
  });
  it('canReload in companion mode needs routes and enabled; an error does not hide it (a failed route import is how a broken edit is recovered)', () => {
    const p = comp(null);
    expect(canReload(p, 'companion')).toBe(true);
    expect(canReload({ ...p, error: 'broken' }, 'companion')).toBe(true);
    expect(canReload({ ...p, error: 'route import failed: SyntaxError' }, 'companion')).toBe(true);
    expect(canReload({ ...p, enabled: false }, 'companion')).toBe(false);
    expect(canReload({ ...p, routes: false }, 'companion')).toBe(false);
    expect(canReload(p)).toBe(false); // person mode: no ratification, no reload
  });
  it('the marker follows the audit summary', () => {
    expect(changedSinceView(comp({ digest: 'd', last_change_at: 'x', changed_since_last_view: true, changes: [] }))).toBe(true);
    expect(changedSinceView(comp({ digest: 'd', last_change_at: 'x', changed_since_last_view: false, changes: [] }))).toBe(false);
    expect(changedSinceView(comp(null))).toBe(false);
    expect(canReviewAudit(comp(null))).toBe(false);
    expect(canReviewAudit(comp({ digest: 'd', last_change_at: null, changed_since_last_view: false, changes: [] }))).toBe(true);
  });
  it('describeChangeTime', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    expect(describeChangeTime(null, now)).toBe('');
    expect(describeChangeTime('nonsense', now)).toBe('');
    expect(describeChangeTime('2026-10-20T11:59:50Z', now)).toBe('just now');
    expect(describeChangeTime('2026-10-20T11:30:00Z', now)).toBe('30 min ago');
    expect(describeChangeTime('2026-10-20T09:00:00Z', now)).toBe('3 h ago');
    expect(describeChangeTime('2026-09-01T09:00:00Z', now)).not.toBe('');
  });
  it('toggleEnabled adds or removes one id and leaves the rest', () => {
    expect(toggleEnabled(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleEnabled(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggleEnabled(['a'], 'a', true)).toEqual(['a']);
    expect(toggleEnabled([], 'z', false)).toEqual([]);
  });
  it('failure notes', () => {
    expect(interpretEnabledFailure(500, { error: 'config_write_failed', detail: 'disk full' })).toMatch(/sanctum\.yaml.*disk full.*Nothing changed/);
    expect(interpretEnabledFailure(400, null)).toMatch(/not accepted/);
    expect(interpretEnabledFailure(501, null)).toMatch(/cannot change/);
    expect(interpretSeenFailure(409, { error: 'digest_mismatch' })).toEqual({ message: 'The files changed while you were looking. Review again.', refresh: true });
    expect(interpretSeenFailure(409, { error: 'plugin_invalid', detail: 'too big' }).message).toMatch(/too big/);
    expect(interpretSeenFailure(500, null).refresh).toBe(false);
  });
});
