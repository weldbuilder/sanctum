// Guard fails closed. Before the database exists the gate is Open (boot); once it exists, state that cannot be read is NOT Open.
// (Order matters in this file: the first test runs before any database is initialised.)
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('../vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({ identity: { timezone: 'UTC' }, server: { db_path: ':memory:' } }),
  PROJECT_ROOT: '/tmp/test',
}));
import { initDb, getDb, setConfig } from '../db.js';
import { check, grant, mode, peek, runLimits, setMode, turnOff, _resetStateCache } from './gate.js';

const ctx = { harness: 'claude', threadId: 't1', tool: 'Bash', summary: 'ls' };
const errors = () => getDb().prepare("SELECT * FROM consent_receipts WHERE outcome = 'error'").all() as any[];

describe('before the database exists (boot)', () => {
  it('the default: Open, everything allowed, no throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mode()).toBe('open');
    expect(check('shell', ctx)).toMatchObject({ allow: true });
    expect(peek('web').allow).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('failing closed'))).toEqual([]); // (the receipt that cannot be written warns, as before)
    warn.mockRestore();
  });
});

describe('after the database is initialised', () => {
  beforeEach(() => { initDb(':memory:'); _resetStateCache(); vi.restoreAllMocks(); });

  it('corrupt consent.grants in Open mode: denied (Guard semantics), one error receipt and one warning, not one per call', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setConfig('consent.grants', '{not json');
    const r = check('shell', ctx);
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/cannot be read/);
    expect(check('web', ctx).allow).toBe(false);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ capability: '*', outcome: 'error' });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('failing closed'))).toHaveLength(1);
    // runLimits narrows too
    expect(runLimits({ sandboxMode: 'workspace-write', networkAccess: true }, { harness: 'codex' })).toMatchObject({ sandboxMode: 'read-only', networkAccess: false });
  });
  it('repairing the state lets the gate read again (and a later outage warns again)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setConfig('consent.grants', '{not json');
    expect(check('shell', ctx).allow).toBe(false);
    setConfig('consent.grants', '[]');
    expect(check('shell', ctx).allow).toBe(true);
    setConfig('consent.grants', 'nope');
    expect(check('shell', ctx).allow).toBe(false);
    expect(errors()).toHaveLength(2);
  });
  it('a grants value that is not a list is corrupt too', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setConfig('consent.grants', '{"a":1}');
    expect(check('shell', ctx).allow).toBe(false);
  });
  it('the database closed under Guard: mode() keeps the last mode read, and every check is denied', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMode('guard');
    grant('shell', 30);
    expect(check('shell', ctx).allow).toBe(true);
    getDb().close();
    expect(mode()).toBe('guard');
    expect(check('shell', ctx).allow).toBe(false);
    expect(peek('web').allow).toBe(false);
  });
  it('the database closed with no mode ever read: Guard, not Open', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getDb().close();
    expect(mode()).toBe('guard');
    expect(check('shell', ctx).allow).toBe(false);
  });
  it('the database closed after Open was read: mode() stays open, but the person\'s switch-offs cannot be read, so the check is still denied', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    turnOff('web');
    expect(mode()).toBe('open');
    getDb().close();
    expect(mode()).toBe('open');
    expect(check('shell', ctx).allow).toBe(false);
  });
});
