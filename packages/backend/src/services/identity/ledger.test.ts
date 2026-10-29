import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IdentityDigestMismatch, IdentityRefused, checkIdentity, filesOf, journalFile, ledgerFile, markAnnounced, readIdentityLedger, readJournal,
  pruneIdentitySnapshots, ratifyIdentity, resetLedgerWarnings, revertIdentity, snapshotOf, snapshotsRoot, validIdentityFileName, writeIdentityFile, type LedgerOpts,
} from './ledger.js';
import { ratifyCacheStats, resetRatifyCache } from '../plugin-ratify.js';

// The fs calls a revert makes, recorded so a case-insensitive filesystem can be simulated from them (this runs on Linux, where names are case-sensitive).
const fsLog = vi.hoisted(() => ({ on: false, events: [] as string[] }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    unlinkSync: (p: any) => { if (fsLog.on) fsLog.events.push(`unlink ${p}`); return real.unlinkSync(p); },
    renameSync: (a: any, b: any) => { if (fsLog.on) fsLog.events.push(`rename ${b}`); return real.renameSync(a, b); },
  };
});

const roots: string[] = [];
function make(files: Record<string, string> = { 'profile.md': 'Profile v1', 'companion.md': 'Narrative v1' }) {
  const base = mkdtempSync(join(tmpdir(), 'sanctum-idledger-'));
  roots.push(base);
  const home = join(base, 'home');
  const ledgerDir = join(base, 'data', 'identity');
  mkdirSync(join(home, 'identity'), { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(home, 'identity', n), t);
  const opts: LedgerOpts = { ledgerDir, trustStat: false };
  const id = (n: string) => join(home, 'identity', n);
  return { base, home, ledgerDir, opts, id };
}

beforeEach(() => { resetLedgerWarnings(); resetRatifyCache(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('first sight: the baseline', () => {
  it('journals one baseline line, serves live (unratified) and writes no snapshot', () => {
    const t = make();
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unratified');
    expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(c.snapshot).toBeUndefined();
    const j = readJournal(t.ledgerDir);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ author: 'baseline', digest_before: '', digest_after: c.digest, files: { added: ['companion.md', 'profile.md'], removed: [], modified: [] } });
    expect(readIdentityLedger(t.ledgerDir).ledger.observed?.digest).toBe(c.digest);
    expect(readIdentityLedger(t.ledgerDir).ledger.ratified).toBeUndefined();
  });

  it('checking again journals nothing more', () => {
    const t = make();
    checkIdentity(t.home, t.opts); checkIdentity(t.home, t.opts); checkIdentity(t.home, t.opts);
    expect(readJournal(t.ledgerDir)).toHaveLength(1);
  });

  it('keeps its own folder: ledger.json, journal.jsonl, snapshots/ and nothing in the identity folder', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(readdirSync(t.ledgerDir).sort()).toEqual(['journal.jsonl', 'ledger.json', 'snapshots']);
    expect(readdirSync(join(t.home, 'identity')).sort()).toEqual(['companion.md', 'profile.md']);
  });
});

describe('a ledger folder that is not an absolute path', () => {
  it('is refused: nothing is written relative to the working directory, and the journal stays in the tmp tree', () => {
    const t = make();
    const rel = `zz-relative-ledger-${process.pid}`;
    try {
      const c = checkIdentity(t.home, { ledgerDir: rel, trustStat: false });
      expect(c.state).toBe('unavailable');
      expect(c.blocked).toBe(true);
      expect(c.detail).toContain('absolute');
      expect(existsSync(rel)).toBe(false);
      expect(existsSync(join(process.cwd(), 'ledger.json'))).toBe(false);
      expect(existsSync(join(process.cwd(), 'journal.jsonl'))).toBe(false);
      expect(() => ratifyIdentity(t.home, { ledgerDir: rel, trustStat: false }, { by: 'person' })).toThrow(IdentityRefused);
      expect(existsSync(rel)).toBe(false);
    } finally { rmSync(rel, { recursive: true, force: true }); }
  });
});

describe('ratify', () => {
  it('records the digest, copies the files into snapshots/<digest>/ and answers ok', () => {
    const t = make();
    const first = checkIdentity(t.home, t.opts);
    const c = ratifyIdentity(t.home, t.opts, { by: 'person', expected: first.digest });
    expect(c.state).toBe('ok');
    expect(c.snapshot).toBe(snapshotOf(t.ledgerDir, first.digest));
    expect(readFileSync(join(c.snapshot!, 'profile.md'), 'utf-8')).toBe('Profile v1');
    const l = readIdentityLedger(t.ledgerDir).ledger;
    expect(l.version).toBe(1);
    expect(l.ratified).toMatchObject({ digest: first.digest, by: 'person' });
    expect(Object.keys(l.ratified!.files).sort()).toEqual(['companion.md', 'profile.md']);
    expect(Date.parse(l.ratified!.ratified_at)).not.toBeNaN();
    const last = readJournal(t.ledgerDir)[0];
    expect(last).toMatchObject({ kind: 'ratify', author: 'person', digest_after: first.digest });
  });

  it('refuses a digest the person was not shown: 409-style mismatch, nothing written', () => {
    const t = make();
    const shown = checkIdentity(t.home, t.opts).digest;
    writeFileSync(t.id('profile.md'), 'changed after the person looked');
    expect(() => ratifyIdentity(t.home, t.opts, { by: 'person', expected: shown })).toThrow(IdentityDigestMismatch);
    expect(readIdentityLedger(t.ledgerDir).ledger.ratified).toBeUndefined();
    expect(existsSync(snapshotsRoot(t.ledgerDir)) ? readdirSync(snapshotsRoot(t.ledgerDir)) : []).toEqual([]);
  });

  it('keeps the current and the previous snapshot and prunes older ones', () => {
    const t = make();
    const digests: string[] = [];
    for (const v of ['a', 'b', 'c']) {
      writeFileSync(t.id('profile.md'), v);
      digests.push(ratifyIdentity(t.home, t.opts, { by: 'person' }).digest);
    }
    expect(readdirSync(snapshotsRoot(t.ledgerDir)).sort()).toEqual([digests[1], digests[2]].sort());
    expect(readIdentityLedger(t.ledgerDir).ledger.previous).toBe(digests[1]);
  });

  it('never touches a plugin ledger folder next to it', () => {
    const t = make();
    const plugins = join(t.base, 'data', 'plugins');
    mkdirSync(join(plugins, 'snapshots', 'x'), { recursive: true });
    writeFileSync(join(plugins, 'ratified.json'), '{}');
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'next');
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(existsSync(join(plugins, 'snapshots', 'x'))).toBe(true);
  });

  it('modes: files and folders are owner-only where the OS honours it', () => {
    if (process.platform === 'win32') return;
    const t = make();
    const c = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(statSync(ledgerFile(t.ledgerDir)).mode & 0o777).toBe(0o600);
    expect(statSync(journalFile(t.ledgerDir)).mode & 0o777).toBe(0o600);
    expect(statSync(c.snapshot!).mode & 0o777).toBe(0o700);
    expect(statSync(join(c.snapshot!, 'profile.md')).mode & 0o777).toBe(0o600);
  });
});

describe('ratifying what is already ratified', () => {
  it('is a no-op: no new journal line, no new copy, unchanged', () => {
    const t = make();
    const first = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(first.unchanged).toBeUndefined();
    const lines = readJournal(t.ledgerDir).length;
    const at = readIdentityLedger(t.ledgerDir).ledger.ratified!.ratified_at;
    for (let i = 0; i < 5; i++) {
      const again = ratifyIdentity(t.home, t.opts, { by: 'person', expected: first.digest });
      expect(again).toMatchObject({ state: 'ok', unchanged: true, digest: first.digest });
    }
    expect(readJournal(t.ledgerDir)).toHaveLength(lines);
    expect(readIdentityLedger(t.ledgerDir).ledger.ratified!.ratified_at).toBe(at);
  });

  it('a stale digest is still a mismatch, and a missing copy is still repaired by ratifying', () => {
    const t = make();
    const first = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(() => ratifyIdentity(t.home, t.opts, { by: 'person', expected: 'f'.repeat(64) })).toThrow(IdentityDigestMismatch);
    rmSync(first.snapshot!, { recursive: true });
    expect(ratifyIdentity(t.home, t.opts, { by: 'person' })).toMatchObject({ state: 'ok' });
    expect(existsSync(first.snapshot!)).toBe(true);
  });
});

describe('a change nobody declared', () => {
  it('is journaled once as filesystem, the state is pending, and the ratified copy is the one to serve', () => {
    const t = make();
    const ok = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('companion.md'), 'Narrative, rewritten');
    writeFileSync(t.id('new.md'), 'added');
    const c = checkIdentity(t.home, { ...t.opts, context: { harness: 'codex', turn: 'preparing' } });
    expect(c.state).toBe('pending');
    expect(c.ratified_digest).toBe(ok.digest);
    expect(c.snapshot).toBe(ok.snapshot);
    expect(c.author).toBe('filesystem');
    expect(c.changes).toEqual([{ path: 'companion.md', kind: 'modified' }, { path: 'new.md', kind: 'added' }]);
    expect(c.detected).toMatchObject({ author: 'filesystem', files: { added: ['new.md'], modified: ['companion.md'], removed: [] } });
    expect(c.detected!.detail).toContain('codex harness');
    expect(c.detected!.detail).toContain('preparing a turn');
    // The second check finds the same change and says nothing new.
    const again = checkIdentity(t.home, t.opts);
    expect(again.state).toBe('pending');
    expect(again.detected).toBeUndefined();
    expect(readJournal(t.ledgerDir).filter((e) => e.author === 'filesystem')).toHaveLength(1);
  });

  it('claims no more than it knows: the app\'s own check says whether a turn was running, nothing about who', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'x');
    const c = checkIdentity(t.home, { ...t.opts, context: { turn: 'running' } });
    expect(c.detected!.detail).toContain('a turn was running');
    expect(c.detected!.detail).not.toMatch(/companion wrote|the companion edited/i);
  });

  it('a removed file is pending too, and editing back to the ratified bytes makes it ok again', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    unlinkSync(t.id('companion.md'));
    expect(checkIdentity(t.home, t.opts)).toMatchObject({ state: 'pending', changes: [{ path: 'companion.md', kind: 'removed' }] });
    writeFileSync(t.id('companion.md'), 'Narrative v1');
    expect(checkIdentity(t.home, t.opts).state).toBe('ok');
  });

  it('files that are links are left out of the set, not followed', () => {
    const t = make();
    writeFileSync(join(t.home, 'secret.md'), 'private');
    try { symlinkSync(join(t.home, 'secret.md'), t.id('link.md')); } catch { return; }
    const c = checkIdentity(t.home, t.opts);
    expect(Object.keys(c.files!).sort()).toEqual(['companion.md', 'profile.md']);
    expect(c.skipped).toEqual(['link.md']);
  });
});

describe('a torn journal', () => {
  it('a last line cut short does not swallow the next entry', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    const before = readJournal(t.ledgerDir).length;
    appendFileSync(journalFile(t.ledgerDir), '{"at":"2026-10-21T00:00:00.000Z","digest_before":"x","digest_after'); // a write cut off mid-line, no newline
    writeIdentityFile(t.home, t.opts, { name: 'profile.md', text: 'after the tear', author: 'companion' });
    const j = readJournal(t.ledgerDir);
    expect(j).toHaveLength(before + 1);
    expect(j[0]).toMatchObject({ author: 'companion', files: { modified: ['profile.md'] } });
    // a journal that ends cleanly gets no stray blank line
    expect(readFileSync(journalFile(t.ledgerDir), 'utf-8').includes('\n\n')).toBe(false);
  });
});

describe('revert on a case-insensitive filesystem', () => {
  it('removes extras before it writes the ratified copy, so a live "Companion.md" cannot take the restored "companion.md" with it', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    unlinkSync(t.id('companion.md'));
    writeFileSync(t.id('Companion.md'), 'the same file on Windows and macOS');
    const shown = checkIdentity(t.home, t.opts).digest;
    fsLog.events = []; fsLog.on = true;
    let c;
    try { c = revertIdentity(t.home, t.opts, { expected: shown }); } finally { fsLog.on = false; }
    expect(c.state).toBe('ok');
    // Replay the calls on a filesystem that folds case: what is left must be the ratified set.
    const fold = (p: string) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    const onDisk = new Set(['companion.md', 'profile.md']); // "Companion.md" and "companion.md" are one entry there
    for (const ev of fsLog.events) {
      const [op, path] = [ev.slice(0, ev.indexOf(' ')), ev.slice(ev.indexOf(' ') + 1)];
      if (!path.startsWith(join(t.home, 'identity'))) continue;
      if (op === 'rename' && !fold(path).startsWith('.')) onDisk.add(fold(path));
      if (op === 'unlink' && !fold(path).startsWith('.')) onDisk.delete(fold(path));
    }
    expect([...onDisk].sort()).toEqual(['companion.md', 'profile.md']);
    expect(readFileSync(t.id('companion.md'), 'utf-8')).toBe('Narrative v1');
  });
});

describe('revert with nothing to roll back', () => {
  it('while unratified it says nothing has been ratified yet; while ok, that the files are the ratified ones', () => {
    const t = make();
    checkIdentity(t.home, t.opts);
    const unratified = (() => { try { revertIdentity(t.home, t.opts); } catch (e) { return e as IdentityRefused; } })();
    expect(unratified).toMatchObject({ code: 'nothing_to_revert' });
    expect(unratified!.message).toContain('nothing has been ratified yet');
    expect(unratified!.message).not.toContain('are the ratified ones');
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(() => revertIdentity(t.home, t.opts)).toThrow(/the identity files are the ratified ones/);
  });
});

describe('revert', () => {
  it('writes the ratified files back over live, removes files added since, journals revert', () => {
    const t = make();
    const ok = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'hostile rewrite');
    writeFileSync(t.id('extra.md'), 'extra');
    const pending = checkIdentity(t.home, t.opts);
    const c = revertIdentity(t.home, t.opts, { expected: pending.digest });
    expect(c.state).toBe('ok');
    expect(c.digest).toBe(ok.digest);
    expect(readFileSync(t.id('profile.md'), 'utf-8')).toBe('Profile v1');
    expect(existsSync(t.id('extra.md'))).toBe(false);
    expect(readJournal(t.ledgerDir)[0]).toMatchObject({ author: 'revert', digest_before: pending.digest, digest_after: ok.digest });
  });

  it('refuses when nothing is waiting, and on a digest that moved', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(() => revertIdentity(t.home, t.opts)).toThrow(IdentityRefused);
    writeFileSync(t.id('profile.md'), 'one');
    const shown = checkIdentity(t.home, t.opts).digest;
    writeFileSync(t.id('profile.md'), 'two');
    expect(() => revertIdentity(t.home, t.opts, { expected: shown })).toThrow(IdentityDigestMismatch);
    expect(readFileSync(t.id('profile.md'), 'utf-8')).toBe('two');
  });

  it('refuses a ratified copy that no longer matches its digest', () => {
    const t = make();
    const ok = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'live change');
    writeFileSync(join(ok.snapshot!, 'profile.md'), 'tampered snapshot');
    // The check no longer calls a copy that does not match its digest "ratified": there is nothing to roll back to, and the refusal says why.
    try { revertIdentity(t.home, t.opts); throw new Error('should refuse'); } catch (e) { expect(e).toBeInstanceOf(IdentityRefused); expect((e as Error).message).toMatch(/altered/); }
    expect(readFileSync(t.id('profile.md'), 'utf-8')).toBe('live change');
  });
});

describe('writes through the app', () => {
  it('the person edit writes, journals person, and ratifies when the folder was ok', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    const shown = checkIdentity(t.home, t.opts).digest;
    const c = writeIdentityFile(t.home, t.opts, { name: 'profile.md', text: 'Edited by hand', author: 'person', expected: shown });
    expect(c.state).toBe('ok');
    expect(c.ratified_now).toBe(true);
    expect(readFileSync(t.id('profile.md'), 'utf-8')).toBe('Edited by hand');
    const j = readJournal(t.ledgerDir);
    expect(j.filter((e) => e.author === 'filesystem')).toHaveLength(0);
    // the approval has its own line, after the edit, so History shows it
    expect(j[0]).toMatchObject({ kind: 'ratify', author: 'person', digest_after: c.digest });
    expect(j[1]).toMatchObject({ author: 'person', files: { modified: ['profile.md'] } });
    expect(j[1].kind).toBeUndefined();
  });

  it('with a change already waiting, the person edit does not ratify what they did not look at', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('companion.md'), 'someone else wrote this');
    const shown = checkIdentity(t.home, t.opts).digest;
    const c = writeIdentityFile(t.home, t.opts, { name: 'profile.md', text: 'mine', author: 'person', expected: shown });
    expect(c.ratified_now).toBe(false);
    expect(c.state).toBe('pending');
  });

  it('a stale digest is a mismatch and writes nothing', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    const shown = checkIdentity(t.home, t.opts).digest;
    writeFileSync(t.id('companion.md'), 'moved');
    expect(() => writeIdentityFile(t.home, t.opts, { name: 'profile.md', text: 'mine', author: 'person', expected: shown })).toThrow(IdentityDigestMismatch);
    expect(readFileSync(t.id('profile.md'), 'utf-8')).toBe('Profile v1');
  });

  it('the companion edit journals companion and never ratifies', () => {
    const t = make();
    const ok = ratifyIdentity(t.home, t.opts, { by: 'person' });
    const c = writeIdentityFile(t.home, t.opts, { name: 'companion.md', text: 'I changed myself', author: 'companion' });
    expect(c.state).toBe('pending');
    expect(c.author).toBe('companion');
    expect(c.ratified_digest).toBe(ok.digest);
    expect(c.snapshot).toBe(ok.snapshot);
    expect(readJournal(t.ledgerDir)[0]).toMatchObject({ author: 'companion', files: { modified: ['companion.md'] } });
  });

  it('a person edit while a companion change waits keeps both authors, in order; ratifying empties the list', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeIdentityFile(t.home, t.opts, { name: 'companion.md', text: 'I changed myself', author: 'companion' });
    const shown = checkIdentity(t.home, t.opts).digest;
    const c = writeIdentityFile(t.home, t.opts, { name: 'profile.md', text: 'mine', author: 'person', expected: shown });
    expect(c.state).toBe('pending');
    expect(c.authors).toEqual(['companion', 'person']);
    expect(c.author).toBe('person'); // the most recent, kept for older readers
    // a third change by the companion does not repeat or reorder
    const again = writeIdentityFile(t.home, t.opts, { name: 'notes.md', text: 'n', author: 'companion' });
    expect(again.authors).toEqual(['companion', 'person']);
    const ok = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(ok.state).toBe('ok');
    const next = writeIdentityFile(t.home, t.opts, { name: 'notes.md', text: 'later', author: 'companion' });
    expect(next.authors).toEqual(['companion']);
  });

  it('a ledger written by setup (observed has no authors list, author baseline) does not list "baseline" as an author of the first change', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'setup', journal: false });
    const raw = JSON.parse(readFileSync(ledgerFile(t.ledgerDir), 'utf-8'));
    delete raw.observed.authors; raw.observed.author = 'baseline';
    writeFileSync(ledgerFile(t.ledgerDir), JSON.stringify(raw));
    const c = writeIdentityFile(t.home, t.opts, { name: 'companion.md', text: 'first change', author: 'companion' });
    expect(c.authors).toEqual(['companion']);
  });

  it('refuses names that are not a plain file directly in identity/', () => {
    for (const bad of ['../x.md', 'a/b.md', 'a\\b.md', '.hidden', '..', '', 'avatar.png', 'con.md', 'x.md.', 'a:b', 'x\0y.md']) {
      expect(validIdentityFileName(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of ['profile.md', 'companion.profile.yaml', 'notes 2.md']) expect(validIdentityFileName(good)).toBe(true);
    const t = make();
    expect(() => writeIdentityFile(t.home, t.opts, { name: '../outside.md', text: 'x', author: 'companion' })).toThrow(/directly in identity/);
    expect(existsSync(join(t.home, 'outside.md'))).toBe(false);
  });

  it('refuses a second spelling of a name that is there (case-folded) and a link', () => {
    const t = make();
    expect(() => writeIdentityFile(t.home, t.opts, { name: 'PROFILE.md', text: 'x', author: 'companion' })).toThrow(/use that spelling/);
    writeFileSync(join(t.home, 'target.md'), 'T');
    try { symlinkSync(join(t.home, 'target.md'), t.id('linked.md')); } catch { return; }
    expect(() => writeIdentityFile(t.home, t.opts, { name: 'linked.md', text: 'x', author: 'companion' })).toThrow(IdentityRefused);
    expect(readFileSync(join(t.home, 'target.md'), 'utf-8')).toBe('T');
  });

  it('leaves no temp files behind in the identity folder', () => {
    const t = make();
    writeIdentityFile(t.home, t.opts, { name: 'notes.md', text: 'n', author: 'companion' });
    expect(readdirSync(join(t.home, 'identity')).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('a file over the size cap is refused', () => {
    const t = make();
    expect(() => writeIdentityFile(t.home, t.opts, { name: 'big.md', text: 'x'.repeat(1024 * 1024 + 1), author: 'person' })).toThrow(/at most/);
  });
});

describe('when the gate cannot work', () => {
  it('refuses a ledger folder inside identity/', () => {
    const t = make();
    const c = checkIdentity(t.home, { ...t.opts, ledgerDir: join(t.home, 'identity', 'ledger') });
    expect(c.state).toBe('unavailable');
    expect(c.blocked).toBe(true);
    expect(c.detail).toMatch(/inside the identity folder/);
    expect(existsSync(join(t.home, 'identity', 'ledger'))).toBe(false);
    expect(() => writeIdentityFile(t.home, { ...t.opts, ledgerDir: join(t.home, 'identity', 'ledger') }, { name: 'a.md', text: 'x', author: 'companion' })).toThrow(IdentityRefused);
  });

  it('the refusal for a ledger folder inside identity/ names the project default, not "beside the database"', () => {
    const t = make();
    const c = checkIdentity(t.home, { ...t.opts, ledgerDir: join(t.home, 'identity', 'ledger') });
    expect(c.state).toBe('unavailable');
    expect(c.detail).toContain('data/identity in the project');
    expect(c.detail).not.toContain('beside the database');
  });

  it('a damaged ledger.json is unavailable and is not overwritten', () => {
    const t = make();
    mkdirSync(t.ledgerDir, { recursive: true });
    writeFileSync(ledgerFile(t.ledgerDir), '{not json');
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.detail).toMatch(/not valid JSON/);
    expect(readFileSync(ledgerFile(t.ledgerDir), 'utf-8')).toBe('{not json');
    expect(c.damaged).toBe(true);
    expect(c.detail).toMatch(/ratify in the app/);
    expect(() => writeIdentityFile(t.home, t.opts, { name: 'profile.md', text: 'x', author: 'person' })).toThrow(IdentityRefused);
  });

  it('a damaged ledger.json has a way out: ratifying sets it aside, keeps it, and starts a new record', () => {
    const t = make();
    mkdirSync(t.ledgerDir, { recursive: true });
    writeFileSync(ledgerFile(t.ledgerDir), '{not json');
    const c = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(c.state).toBe('ok');
    const aside = readdirSync(t.ledgerDir).filter((n) => n.startsWith('ledger.json.damaged-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(t.ledgerDir, aside[0]), 'utf-8')).toBe('{not json');
    expect(readIdentityLedger(t.ledgerDir).damaged).toBeUndefined();
  });

  it('ratifying over a damaged ledger keeps the copies the set-aside file names, through a later prune', () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    appendFileSync(ledgerFile(t.ledgerDir), '{{ damaged');
    writeFileSync(t.id('profile.md'), 'Profile v2');
    const c = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(c.state).toBe('ok');
    const aside = readdirSync(t.ledgerDir).filter((n) => n.startsWith('ledger.json.damaged-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(t.ledgerDir, aside[0]), 'utf-8')).toContain(v1.digest);
    expect(existsSync(snapshotOf(t.ledgerDir, v1.digest))).toBe(true); // named by the set-aside ledger: still there
    pruneIdentitySnapshots(t.ledgerDir, { keepPrevious: true });
    expect(existsSync(snapshotOf(t.ledgerDir, v1.digest))).toBe(true);
    expect(existsSync(snapshotOf(t.ledgerDir, c.digest))).toBe(true);
  });

  it('an unavailable check still says when and by whom the identity was ratified', () => {
    const t = make();
    const v = ratifyIdentity(t.home, t.opts, { by: 'person' });
    rmSync(join(t.home, 'identity'), { recursive: true });
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.ratified_digest).toBe(v.digest);
    expect(c.ratified_at).toBeTruthy();
    expect(c.ratified_by).toBe('person');
  });

  it('a ledger overwritten with garbage (naming no copy) still keeps the old copies when the person ratifies', () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(ledgerFile(t.ledgerDir), 'garbage');
    writeFileSync(t.id('profile.md'), 'Profile v2');
    const c = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(c.state).toBe('ok');
    expect(existsSync(snapshotOf(t.ledgerDir, v1.digest))).toBe(true); // nothing is pruned on the set-aside path
    expect(existsSync(snapshotOf(t.ledgerDir, c.digest))).toBe(true);
  });

  it('ratifying while the ratified copy is missing names the copy that was being served as previous, and keeps it', () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'Profile v2');
    const v2 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    rmSync(v2.snapshot!, { recursive: true }); // v1 is served now
    writeFileSync(t.id('profile.md'), 'Profile v3');
    const v3 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(v3.state).toBe('ok');
    expect(readIdentityLedger(t.ledgerDir).ledger.previous).toBe(v1.digest);
    expect(existsSync(snapshotOf(t.ledgerDir, v1.digest))).toBe(true);
    expect(existsSync(snapshotOf(t.ledgerDir, v3.digest))).toBe(true);
  });

  it('a refused ratification over a damaged ledger (stale digest) sets nothing aside and starts no record', () => {
    const t = make();
    mkdirSync(t.ledgerDir, { recursive: true });
    writeFileSync(ledgerFile(t.ledgerDir), '{not json');
    expect(() => ratifyIdentity(t.home, t.opts, { by: 'person', expected: 'f'.repeat(64) })).toThrow(IdentityDigestMismatch);
    expect(readFileSync(ledgerFile(t.ledgerDir), 'utf-8')).toBe('{not json');
    expect(readdirSync(t.ledgerDir).filter((n) => n.startsWith('ledger.json.damaged-'))).toEqual([]);
    expect(readIdentityLedger(t.ledgerDir).damaged).toBeDefined();
  });

  it('with the ratified copy missing, the pending answer still says who changed the files', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'Profile v2');
    const v2 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeIdentityFile(t.home, t.opts, { name: 'companion.md', text: 'by the companion', author: 'companion' });
    rmSync(v2.snapshot!, { recursive: true });
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('pending');
    expect(c.detail).toMatch(/ratified copy is missing/);
    expect(c.author).toBe('companion');
    expect(c.authors).toEqual(['companion']);
    expect(c.since).toBeDefined();
  });

  it('with the ratified copy missing, the version before it is served as pending, with a note', () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'Profile v2');
    const v2 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(readIdentityLedger(t.ledgerDir).ledger.previous).toBe(v1.digest);
    rmSync(v2.snapshot!, { recursive: true });
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('pending');
    expect(c.snapshot).toBe(snapshotOf(t.ledgerDir, v1.digest));
    expect(c.detail).toMatch(/ratified copy is missing/);
    expect(c.changes).toEqual([{ path: 'profile.md', kind: 'modified' }]);
    expect(c.authors ?? []).toEqual([]);
    // an altered previous copy is not trusted
    writeFileSync(join(c.snapshot!, 'profile.md'), 'tampered');
    const d = checkIdentity(t.home, t.opts);
    expect(d.state).toBe('unavailable');
    expect(d.snapshot).toBeUndefined();
  });

  it('no identity folder: unavailable, with the ratified copy still named when there is one', () => {
    const t = make();
    const ok = ratifyIdentity(t.home, t.opts, { by: 'person' });
    rmSync(join(t.home, 'identity'), { recursive: true });
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.snapshot).toBe(ok.snapshot);
  });

  it('the ratified copy missing: unavailable, and ratifying again repairs it', () => {
    const t = make();
    const ok = ratifyIdentity(t.home, t.opts, { by: 'person' });
    rmSync(ok.snapshot!, { recursive: true });
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.snapshot).toBeUndefined();
    expect(ratifyIdentity(t.home, t.opts, { by: 'person' }).state).toBe('ok');
  });

  it('a file name over 120 characters is invisible to the check and to what is served (documented in CONFIGURATION.md)', () => {
    const t = make();
    const long = `${'n'.repeat(118)}.md`; // 121 characters
    expect(long.length).toBe(121);
    writeFileSync(t.id(long), 'not part of the set');
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unratified');
    expect(Object.keys(c.files ?? {}).sort()).toEqual(['companion.md', 'profile.md']);
    expect(validIdentityFileName(long)).toBe(false);
    writeFileSync(t.id(`${'n'.repeat(117)}.md`), 'exactly 120');
    expect(Object.keys(checkIdentity(t.home, t.opts).files ?? {})).toContain(`${'n'.repeat(117)}.md`);
  });

  it('a folder over the file cap cannot be hashed', () => {
    const t = make({});
    for (let i = 0; i < 2001; i++) writeFileSync(t.id(`f${i}.md`), '');
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.detail).toMatch(/more than 2000 files/);
  });
});

describe('the stat prefilter', () => {
  it('skips rehashing a file whose stat did not change, never trusts it with trustStat off', () => {
    if (process.platform === 'win32') return; // ctime is not a change time there: nothing is trusted
    const t = make();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000); // past the racy window
    checkIdentity(t.home, { ...t.opts, trustStat: true });
    const hashedBefore = ratifyCacheStats.hashed;
    vi.setSystemTime(Date.now() + 1000);
    checkIdentity(t.home, { ...t.opts, trustStat: true });
    expect(ratifyCacheStats.hashed).toBe(hashedBefore);
    expect(ratifyCacheStats.hits).toBeGreaterThan(0);
    const hitsBefore = ratifyCacheStats.hits;
    checkIdentity(t.home, { ...t.opts, trustStat: false });
    expect(ratifyCacheStats.hits).toBe(hitsBefore);
  });

  it('on win32 the default trusts nothing', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const t = make();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10_000);
      const o: LedgerOpts = { ledgerDir: t.ledgerDir };
      checkIdentity(t.home, o);
      checkIdentity(t.home, o);
      expect(ratifyCacheStats.hits).toBe(0);
    } finally { Object.defineProperty(process, 'platform', orig); }
  });
});

describe('announce and read helpers', () => {
  it('markAnnounced is true once per distinct digest', () => {
    const t = make();
    checkIdentity(t.home, t.opts);
    expect(markAnnounced(t.ledgerDir, 'a'.repeat(64))).toBe(true);
    expect(markAnnounced(t.ledgerDir, 'a'.repeat(64))).toBe(false);
    expect(markAnnounced(t.ledgerDir, 'b'.repeat(64))).toBe(true);
  });

  it('filesOf reads a ratified copy or live, and refuses a digest that is not a digest', () => {
    const t = make();
    const ok = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'live now');
    expect(filesOf(t.home, t.opts, ok.digest)!.get('profile.md')).toBe('Profile v1');
    expect(filesOf(t.home, t.opts, 'live')!.get('profile.md')).toBe('live now');
    expect(filesOf(t.home, t.opts, '../../etc')).toBeNull();
  });

  it('journal reads newest first and survives a torn line', () => {
    const t = make();
    checkIdentity(t.home, t.opts);
    writeFileSync(journalFile(t.ledgerDir), readFileSync(journalFile(t.ledgerDir), 'utf-8') + '{"at": torn\n');
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(readJournal(t.ledgerDir).map((e) => e.author)).toEqual(['person', 'baseline']);
  });
});

describe('the ratified copy is verified before it is served', () => {
  const twoVersions = () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(t.id('profile.md'), 'Profile v2');
    const v2 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    return { t, v1, v2 };
  };

  it('a byte changed in the ratified copy, live unchanged: not ok; the previous copy is served and the reason names the copy', () => {
    const { t, v1, v2 } = twoVersions();
    expect(checkIdentity(t.home, t.opts).state).toBe('ok');
    writeFileSync(join(v2.snapshot!, 'profile.md'), 'Profile v3'); // same length, other bytes
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('pending');
    expect(c.snapshot).toBe(snapshotOf(t.ledgerDir, v1.digest));
    expect(c.detail).toContain(`snapshots/${v2.digest.slice(0, 12)}`);
    expect(c.detail).toMatch(/altered/);
    expect(readFileSync(join(c.snapshot!, 'profile.md'), 'utf-8')).toBe('Profile v1');
  });

  it('a changed ratified copy with no previous: unavailable, nothing is served from it, the reason names it', () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(join(v1.snapshot!, 'companion.md'), 'Narrative v9');
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.snapshot).toBeUndefined();
    expect(c.detail).toContain(`snapshots/${v1.digest.slice(0, 12)}`);
  });

  it('a file added to the ratified copy is an alteration too', () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(join(v1.snapshot!, 'extra.md'), 'planted');
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.snapshot).toBeUndefined();
  });

  it('the previous copy altered while the ratified one is missing: unavailable', () => {
    const { t, v1, v2 } = twoVersions();
    rmSync(v2.snapshot!, { recursive: true });
    writeFileSync(join(snapshotOf(t.ledgerDir, v1.digest), 'profile.md'), 'Profile v0');
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.snapshot).toBeUndefined();
  });

  it('with the live folder unreadable, an altered ratified copy is not offered either', () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(join(v1.snapshot!, 'profile.md'), 'Profile vX');
    rmSync(join(t.home, 'identity'), { recursive: true });
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('unavailable');
    expect(c.snapshot).toBeUndefined();
    expect(c.detail).toMatch(/altered/);
  });

  it('ratify does not answer unchanged over an altered copy: it replaces the copy', () => {
    const t = make();
    const v1 = ratifyIdentity(t.home, t.opts, { by: 'person' });
    writeFileSync(join(v1.snapshot!, 'profile.md'), 'Profile vX');
    const again = ratifyIdentity(t.home, t.opts, { by: 'person' });
    expect(again.unchanged).toBeUndefined();
    expect(again.state).toBe('ok');
    expect(readFileSync(join(again.snapshot!, 'profile.md'), 'utf-8')).toBe('Profile v1');
  });

  it('ratify rereads the copy even when the stat prefilter would trust it', () => {
    if (process.platform === 'win32') return;
    const t = make();
    vi.useFakeTimers({ toFake: ['Date'] });
    const v1 = ratifyIdentity(t.home, { ...t.opts, trustStat: true }, { by: 'person' });
    vi.setSystemTime(Date.now() + 10_000);
    expect(checkIdentity(t.home, { ...t.opts, trustStat: true }).state).toBe('ok'); // warm and trusted
    expect(checkIdentity(t.home, { ...t.opts, trustStat: true }).state).toBe('ok');
    const f = join(v1.snapshot!, 'profile.md');
    const st = statSync(f);
    writeFileSync(f, 'Profile vX');
    utimesSync(f, st.atime, st.mtime);
    // the unchanged answer must not come from the cache: this edit changed ctime, but even so ratify reads the bytes
    const again = ratifyIdentity(t.home, { ...t.opts, trustStat: true }, { by: 'person' });
    expect(again.unchanged).toBeUndefined();
    expect(readFileSync(join(again.snapshot!, 'profile.md'), 'utf-8')).toBe('Profile v1');
  });

  describe('through the stat prefilter', () => {
    it('a same-size rewrite of the copy inside the racy window is distrusted: the check reads it again and sees the edit', () => {
      if (process.platform === 'win32') return;
      const t = make();
      const trusted: LedgerOpts = { ...t.opts, trustStat: true };
      const v1 = ratifyIdentity(t.home, trusted, { by: 'person' }); // real time: the copy was written moments ago
      expect(checkIdentity(t.home, trusted).state).toBe('ok');
      const f = join(v1.snapshot!, 'profile.md');
      const st = statSync(f);
      writeFileSync(f, 'Profile v9'); // same size
      utimesSync(f, st.atime, st.mtime); // and the mtime put back
      ratifyCacheStats.hits = 0;
      const c = checkIdentity(t.home, trusted);
      expect(c.state).toBe('unavailable');
      expect(c.snapshot).toBeUndefined();
      expect(ratifyCacheStats.hits).toBe(0); // nothing written moments ago is trusted, the live files included
    });

    it('past the racy window the copy is trusted from its stat (the per-turn cost is a walk, not a read), and with trustStat off never', () => {
      if (process.platform === 'win32') return;
      const t = make();
      const trusted: LedgerOpts = { ...t.opts, trustStat: true };
      vi.useFakeTimers({ toFake: ['Date'] });
      ratifyIdentity(t.home, trusted, { by: 'person' });
      vi.setSystemTime(Date.now() + 10_000);
      checkIdentity(t.home, trusted); // hashes both folders, now outside the window
      ratifyCacheStats.hits = 0; ratifyCacheStats.hashed = 0;
      vi.setSystemTime(Date.now() + 1000);
      expect(checkIdentity(t.home, trusted).state).toBe('ok');
      expect(ratifyCacheStats.hashed).toBe(0);
      expect(ratifyCacheStats.hits).toBe(4); // two live files, two in the copy
      ratifyCacheStats.hits = 0;
      checkIdentity(t.home, { ...t.opts, trustStat: false });
      expect(ratifyCacheStats.hits).toBe(0);
      expect(ratifyCacheStats.hashed).toBe(4);
    });

    it('an edit of the copy after it was trusted is caught (the edit moves ctime)', () => {
      if (process.platform === 'win32') return;
      const t = make();
      const trusted: LedgerOpts = { ...t.opts, trustStat: true };
      vi.useFakeTimers({ toFake: ['Date'] });
      const v1 = ratifyIdentity(t.home, trusted, { by: 'person' });
      vi.setSystemTime(Date.now() + 10_000);
      checkIdentity(t.home, trusted);
      vi.setSystemTime(Date.now() + 1000);
      expect(checkIdentity(t.home, trusted).state).toBe('ok');
      const f = join(v1.snapshot!, 'profile.md');
      const st = statSync(f);
      writeFileSync(f, 'Profile v9');
      utimesSync(f, st.atime, st.mtime);
      expect(checkIdentity(t.home, trusted).state).toBe('unavailable');
    });
  });
});

describe('a home with no identity folder (a legacy install)', () => {
  it('is legacy, not unavailable: nothing is read or written, and the detail says where identity lives', () => {
    const t = make();
    rmSync(join(t.home, 'identity'), { recursive: true });
    const c = checkIdentity(t.home, t.opts);
    expect(c.state).toBe('legacy');
    expect(c.digest).toBe('');
    expect(c.detail).toMatch(/CLAUDE\.md/);
    expect(c.detail).toMatch(/identity\//);
    expect(existsSync(t.ledgerDir)).toBe(false); // no ledger, no journal, no snapshots
    expect(() => ratifyIdentity(t.home, t.opts, { by: 'person' })).toThrow(IdentityRefused);
    expect(existsSync(t.ledgerDir)).toBe(false);
  });

  it('a folder that was ratified and then removed is unavailable, not legacy', () => {
    const t = make();
    ratifyIdentity(t.home, t.opts, { by: 'person' });
    rmSync(join(t.home, 'identity'), { recursive: true });
    expect(checkIdentity(t.home, t.opts).state).toBe('unavailable');
  });

  it('a dangling identity link is still unavailable (something is there, and it is broken)', () => {
    const t = make();
    rmSync(join(t.home, 'identity'), { recursive: true });
    try { symlinkSync(join(t.base, 'nowhere'), join(t.home, 'identity')); } catch { return; /* no symlinks here */ }
    expect(checkIdentity(t.home, t.opts).state).toBe('unavailable');
  });
});
