import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ home: '', ledgerDir: '', lines: [] as any[], pushes: [] as any[], postThrows: false }));
vi.mock('../../config.js', () => ({
  getSanctumConfig: () => ({
    identity: { companion_name: 'Hazel', user_name: 'Pat', ledger_dir: h.ledgerDir, profile_path: '', companion_md_path: '' },
    agent: { cwd: h.home }, server: { db_path: ':memory:' },
  }),
}));
vi.mock('../db.js', () => ({
  ensureDailyThread: () => ({ thread: { id: 'daily-2026-10-21' } }),
  createMessage: (m: any) => { if (h.postThrows) throw new Error('db down'); h.lines.push(m); return { ...m, thread_id: m.threadId, created_at: m.createdAt }; },
}));
vi.mock('../ws.js', () => ({ registry: { broadcast: (m: any) => { h.pushes.push(m); } } }));

import { LINE_INTERVAL_MS, announceIdentity, pendingNotice, publishIdentity, resetIdentityNotify, startIdentityGate } from './notify.js';
import { identityForRun, setIdentityListener } from './guard.js';
import { currentIdentity } from './status.js';
import { checkIdentity, ratifyIdentity, readIdentityLedger, resetLedgerWarnings, revertIdentity, snapshotOf, writeIdentityFile } from './ledger.js';

const roots: string[] = [];
const id = (n: string) => join(h.home, 'identity', n);
const opts = () => ({ ledgerDir: h.ledgerDir, trustStat: false });
const cfg = () => ({ identity: { companion_name: 'Hazel', user_name: 'Pat', ledger_dir: h.ledgerDir, profile_path: '', companion_md_path: '' }, agent: { cwd: h.home }, server: { db_path: ':memory:' } }) as any;

beforeEach(() => {
  resetLedgerWarnings();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const root = mkdtempSync(join(tmpdir(), 'sanctum-idnotify-'));
  roots.push(root);
  h.home = join(root, 'home'); h.ledgerDir = join(root, 'data', 'identity');
  h.lines = []; h.pushes = []; h.postThrows = false;
  mkdirSync(join(h.home, 'identity'), { recursive: true });
  writeFileSync(id('profile.md'), 'P'); writeFileSync(id('companion.md'), 'N');
  resetIdentityNotify();
  setIdentityListener(announceIdentity);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setIdentityListener(null); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('an altered ratified copy', () => {
  it('posts one thread line naming the copy when the state becomes unavailable, and none while it lasts', () => {
    const v1 = ratifyIdentity(h.home, opts(), { by: 'person' });
    writeFileSync(join(v1.snapshot!, 'profile.md'), 'ALTERED');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0].content).toContain(`snapshots/${v1.digest.slice(0, 12)}`);
    expect(h.lines[0].content).toMatch(/^Identity needs attention: .*altered/);
    expect(h.lines[0].content).toContain('Runs use the live files.');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(1);
  });
});

describe('a change waiting is announced once per distinct digest', () => {
  it('posts one line to today\'s thread and pushes identity_status; the next turns say nothing more', () => {
    ratifyIdentity(h.home, opts(), { by: 'person' });
    writeFileSync(id('companion.md'), 'rewritten');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatchObject({ threadId: 'daily-2026-10-21', role: 'system', content: 'Identity change waiting: companion.md. Changed on disk. Settings → Identity.', metadata: { kind: 'identity_pending' } });
    expect(h.pushes.map((p) => p.type)).toEqual(['identity_status']);
    expect(h.pushes[0].status).toMatchObject({ state: 'pending', pending: { author: 'filesystem', authors: ['filesystem'], changes: [{ path: 'companion.md', kind: 'modified' }] } });
    identityForRun(cfg(), { harness: 'codex' });
    identityForRun(cfg(), { harness: 'dsh' });
    expect(h.lines).toHaveLength(1);
    expect(h.pushes).toHaveLength(1);
    expect(readIdentityLedger(h.ledgerDir).ledger.announced).toBe(checkIdentity(h.home, opts()).digest);
  });

  it('a writer in a loop: every new digest is pushed, but the thread gets one line per ten minutes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    ratifyIdentity(h.home, opts(), { by: 'person' });
    for (let i = 0; i < 30; i++) {
      writeFileSync(id('companion.md'), `loop ${i}`);
      identityForRun(cfg(), { harness: 'claude' });
      vi.setSystemTime(new Date(Date.now() + 4_000)); // 30 changes in two minutes
    }
    expect(h.lines).toHaveLength(1);
    expect(h.pushes.length).toBe(30);
    // the same digest again is not announced
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(1);
    // inside the interval: still quiet; past it: the next change gets its line
    vi.setSystemTime(new Date(Date.parse('2026-10-21T12:00:00Z') + LINE_INTERVAL_MS - 1000));
    writeFileSync(id('companion.md'), 'just inside');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(1);
    vi.setSystemTime(new Date(Date.parse('2026-10-21T12:00:00Z') + LINE_INTERVAL_MS + 1000));
    writeFileSync(id('companion.md'), 'after the interval');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(2);
    expect(readIdentityLedger(h.ledgerDir).ledger.announced).toBe(checkIdentity(h.home, opts()).digest);
  });

  it('a change that comes back is announced again: pending, ok, the same pending digest', () => {
    const original = 'N';
    ratifyIdentity(h.home, opts(), { by: 'person' });
    writeFileSync(id('companion.md'), 'again and again');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(1);
    // by hand back to the ratified bytes: a check finds ok and forgets the digest (not the time: the ten-minute quiet holds)
    writeFileSync(id('companion.md'), original);
    identityForRun(cfg(), { harness: 'claude' });
    expect(readIdentityLedger(h.ledgerDir).ledger.announced).toBeUndefined();
    expect(readIdentityLedger(h.ledgerDir).ledger.announced_at).toBeDefined();
    writeFileSync(id('companion.md'), 'again and again');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(1);
    // past the interval the same change is news again
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + LINE_INTERVAL_MS + 1000));
    writeFileSync(id('companion.md'), original);
    identityForRun(cfg(), { harness: 'claude' });
    writeFileSync(id('companion.md'), 'again and again');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(2);
    // the same after a rollback
    revertIdentity(h.home, opts());
    expect(readIdentityLedger(h.ledgerDir).ledger.announced).toBeUndefined();
    writeFileSync(id('companion.md'), 'again and again');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(3);
    // and after a ratify: the next change is a new move into pending
    ratifyIdentity(h.home, opts(), { by: 'person' });
    expect(readIdentityLedger(h.ledgerDir).ledger.announced).toBeUndefined();
    writeFileSync(id('companion.md'), 'a different change');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(4);
  });

  it('a writer that alternates between the ratified bytes and a change posts at most one line per ten minutes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    ratifyIdentity(h.home, opts(), { by: 'person' });
    for (let i = 0; i < 40; i++) {
      writeFileSync(id('companion.md'), 'EVIL');
      identityForRun(cfg(), { harness: 'claude' });
      writeFileSync(id('companion.md'), 'N');
      identityForRun(cfg(), { harness: 'claude' });
      vi.setSystemTime(new Date(Date.now() + 10_000)); // 40 cycles in under seven minutes
    }
    expect(h.lines).toHaveLength(1);
    vi.setSystemTime(new Date(Date.parse('2026-10-21T12:00:00Z') + LINE_INTERVAL_MS + 1000));
    writeFileSync(id('companion.md'), 'EVIL');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(2);
  });

  it('a push goes out when the state moves back to ok, so the header does not stay on "change waiting"', () => {
    ratifyIdentity(h.home, opts(), { by: 'person' });
    writeFileSync(id('companion.md'), 'waiting');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.pushes.at(-1).status.state).toBe('pending');
    writeFileSync(id('companion.md'), 'N'); // back to the ratified bytes
    identityForRun(cfg(), { harness: 'codex' });
    expect(h.pushes.at(-1).status).toMatchObject({ state: 'ok', pending: null });
    const n = h.pushes.length;
    identityForRun(cfg(), { harness: 'codex' }); // nothing moved: nothing pushed
    expect(h.pushes).toHaveLength(n);
  });

  it('one thread line on entering unavailable, none while it lasts, another when it comes back and goes again', () => {
    ratifyIdentity(h.home, opts(), { by: 'person' });
    identityForRun(cfg(), { harness: 'claude' });
    writeFileSync(join(h.ledgerDir, 'ledger.json'), '{broken');
    identityForRun(cfg(), { harness: 'claude' });
    identityForRun(cfg(), { harness: 'codex' });
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0].content).toMatch(/^Identity needs attention: .*not valid JSON.* Runs use the live files\. Settings → Identity\.$/);
    expect(h.lines[0].metadata.kind).toBe('identity_pending');
    expect(h.pushes.at(-1).status).toMatchObject({ state: 'unavailable', canRatify: true });
    ratifyIdentity(h.home, opts(), { by: 'person' }); // the way out
    identityForRun(cfg(), { harness: 'claude' });
    writeFileSync(join(h.ledgerDir, 'ledger.json'), '{broken again');
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(2);
  });

  it('names every author since the ratified version, in people words: "your companion and you"', () => {
    ratifyIdentity(h.home, opts(), { by: 'person' });
    writeIdentityFile(h.home, opts(), { name: 'profile.md', text: 'by the companion', author: 'companion' });
    writeIdentityFile(h.home, opts(), { name: 'companion.md', text: 'by the person', author: 'person' });
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines.at(-1).content).toBe('Identity change waiting: companion.md, profile.md. Changed by your companion and you. Settings → Identity.');
  });

  it('says "Changed on disk" for a change on disk, and lists mixed authors with the app\'s words; the line reflects the authors at the time it posts', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    ratifyIdentity(h.home, opts(), { by: 'person' });
    expect(pendingNotice({ state: 'pending', digest: 'a', authors: ['companion', 'filesystem'], changes: [{ path: 'profile.md', kind: 'modified' }] } as any))
      .toBe('Identity change waiting: profile.md. Changed by your companion and something on disk. Settings → Identity.');
    writeFileSync(id('companion.md'), 'by disk');
    identityForRun(cfg(), { harness: 'claude' });
    writeIdentityFile(h.home, opts(), { name: 'profile.md', text: 'by the person', author: 'person' });
    vi.setSystemTime(new Date(Date.now() + LINE_INTERVAL_MS + 1000));
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines.map((l) => l.content)).toEqual([
      'Identity change waiting: companion.md. Changed on disk. Settings → Identity.',
      'Identity change waiting: companion.md, profile.md. Changed by something on disk and you. Settings → Identity.',
    ]);
  });

  it('names the author: a companion edit reads "by your companion"', () => {
    ratifyIdentity(h.home, opts(), { by: 'person' });
    writeIdentityFile(h.home, opts(), { name: 'profile.md', text: 'by the companion', author: 'companion' });
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines[0].content).toBe('Identity change waiting: profile.md. Changed by your companion. Settings → Identity.');
  });

  it('nothing is said when the files are the ratified ones, or when nothing is ratified yet', () => {
    identityForRun(cfg(), { harness: 'claude' });
    ratifyIdentity(h.home, opts(), { by: 'person' });
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toEqual([]);
    expect(h.pushes.map((p) => p.status.state)).toEqual(['ok']); // only the move from unratified to ok is pushed
  });

  it('a thread line that cannot be saved is tried again at the next check, and the push still went out', () => {
    ratifyIdentity(h.home, opts(), { by: 'person' });
    writeFileSync(id('companion.md'), 'x');
    h.postThrows = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toEqual([]);
    expect(readIdentityLedger(h.ledgerDir).ledger.announced).toBeUndefined();
    h.postThrows = false;
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toHaveLength(1);
  });

  it('long or odd file names are cleaned in the line', () => {
    const line = pendingNotice({ state: 'pending', digest: 'a', author: 'filesystem', changes: [{ path: 'x"\n# SYSTEM.md', kind: 'added' }] } as any);
    expect(line).toBe('Identity change waiting: 1 file (.md). Changed on disk. Settings → Identity.');
  });
});

describe('publishIdentity and boot', () => {
  it('publishIdentity pushes the status record, never the digest of anything else', () => {
    publishIdentity(checkIdentity(h.home, opts()));
    expect(h.pushes[0]).toMatchObject({ type: 'identity_status', status: { state: 'unratified' } });
  });

  it('boot writes the baseline for a home with no ledger and leaves it unratified', () => {
    startIdentityGate();
    expect(readIdentityLedger(h.ledgerDir).ledger.observed?.author).toBe('baseline');
    expect(readIdentityLedger(h.ledgerDir).ledger.ratified).toBeUndefined();
    expect(h.lines).toEqual([]); // unratified is the header's job, not a thread line
  });

  it('boot warns (it does not refuse) when the ledger folder is inside a folder the companion can write', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.ledgerDir = join(h.home, 'data', 'identity'); // inside agent.cwd
    startIdentityGate();
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('[identity]') && m.includes('which the companion can write'))).toBe(true);
    expect(readIdentityLedger(h.ledgerDir).ledger.observed?.author).toBe('baseline'); // the gate still works
    warn.mockClear();
    h.ledgerDir = join(mkdtempSync(join(tmpdir(), 'sanctum-idelsewhere-')), 'identity');
    roots.push(join(h.ledgerDir, '..'));
    startIdentityGate();
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('which the companion can write'))).toBe(false);
  });

  it('boot keeps the previous copy that ledger.previous still names', () => {
    const v1 = ratifyIdentity(h.home, opts(), { by: 'person' });
    writeFileSync(id('profile.md'), 'P2');
    const v2 = ratifyIdentity(h.home, opts(), { by: 'person' });
    expect(readIdentityLedger(h.ledgerDir).ledger.previous).toBe(v1.digest);
    startIdentityGate();
    expect(existsSync(snapshotOf(h.ledgerDir, v1.digest))).toBe(true);
    expect(existsSync(snapshotOf(h.ledgerDir, v2.digest))).toBe(true);
    expect(readIdentityLedger(h.ledgerDir).ledger.previous).toBe(v1.digest);
  });

  it('boot announces a change that arrived while the app was down', () => {
    ratifyIdentity(h.home, opts(), { by: 'person' });
    writeFileSync(id('profile.md'), 'while the app was off');
    startIdentityGate();
    expect(h.lines).toHaveLength(1);
  });
});

describe('legacy: no identity folder', () => {
  it('no thread line, no ledger written, at boot or on any later check', () => {
    rmSync(join(h.home, 'identity'), { recursive: true });
    startIdentityGate();
    const cur = currentIdentity();
    expect(cur?.status.state).toBe('legacy');
    expect(cur?.status.canRatify).toBe(false);
    identityForRun(cfg(), { harness: 'claude' });
    expect(h.lines).toEqual([]);
    expect(existsSync(h.ledgerDir)).toBe(false);
    expect(h.pushes.every((p) => p.status.state === 'legacy')).toBe(true);
  });
});
