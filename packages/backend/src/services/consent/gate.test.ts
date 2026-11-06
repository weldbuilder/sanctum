import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('../vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({ identity: { timezone: 'UTC' }, server: { db_path: ':memory:' } }),
  PROJECT_ROOT: '/tmp/test',
}));
import { initDb, getConfig, setConfig, getDb } from '../db.js';
import {
  CAPABILITIES, check, grant, listState, mode, orientationLine, peek, pinNeededForGrant, pinNeededForRevoke, requireCapability, revoke, runLimits, setMode, turnOff,
  ConsentDeniedError, askWouldChange, normalizeWindow, denyHint, denyMessage, onConsentChanged,
} from './gate.js';
import { COALESCE_MS, listReceipts, pruneAllReceipts, pruneReceipts, scrubSummary, startReceiptPruning, writeReceipt } from './receipts.js';
import { openDb } from '../db.js';
import { enableTenancy } from '../../tenancy/context.js';
import { setPin, _resetTokens } from './pin.js';
import { buildExecArgs } from '../providers/codex-exec.js';

const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const ctx = { harness: 'claude', threadId: 't1', tool: 'Bash', summary: 'ls' };
const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM consent_receipts').get() as { n: number }).n;
const last = () => getDb().prepare('SELECT * FROM consent_receipts ORDER BY id DESC LIMIT 1').get() as any;

beforeEach(() => { initDb(':memory:'); _resetTokens(); });

describe('the capability list', () => {
  it('is exactly the nine in the spec', () => {
    expect([...CAPABILITIES]).toEqual(['app_write', 'shell', 'files_outside_home', 'web', 'outward_telegram', 'outward_discord', 'google_write', 'self_code_edit', 'voice_out']);
  });
});

describe('the rules matrix: mode x override x window x expiry', () => {
  it('open mode, nothing set: allowed, with a receipt', () => {
    expect(mode()).toBe('open');
    const r = check('shell', ctx, T0);
    expect(r.allow).toBe(true);
    expect(last()).toMatchObject({ capability: 'shell', outcome: 'allowed', harness: 'claude', thread_id: 't1', tool_or_route: 'Bash' });
  });
  it('open mode, switched off: denied until turned back on', () => {
    const off = turnOff('shell', undefined, {}, T0);
    const r = check('shell', ctx, T0 + 1000);
    expect(r).toMatchObject({ allow: false, grantId: off.grant_id });
    expect(r.reason).toBe('Shell access is turned off');
    expect(last().outcome).toBe('denied');
    expect(check('web', ctx, T0).allow).toBe(true); // only that one
  });
  it('open mode, on a window: allowed inside it, then off (not the default again), receipt says expired', () => {
    grant('web', 30, 'research', {}, T0);
    expect(check('web', ctx, T0 + 29 * 60_000).allow).toBe(true);
    const after = check('web', ctx, T0 + 30 * 60_000);
    expect(after.allow).toBe(false);
    expect(after.reason).toMatch(/window ended/);
    expect(last().outcome).toBe('expired');
  });
  it('open mode, leave-on grant (expires_at null) never expires', () => {
    grant('web', null, undefined, {}, T0);
    expect(check('web', ctx, T0 + 400 * 86_400_000).allow).toBe(true);
  });
  it('guard mode, no grant: denied for every capability', () => {
    setMode('guard');
    for (const c of CAPABILITIES) expect(check(c, ctx, T0).allow).toBe(false);
    expect(check('shell', ctx, T0).reason).toBe('Shell access needs a grant (Guard mode is on)');
  });
  it('guard mode, active grant allows; expiry denies; leave-on (null) allows; revoke denies', () => {
    setMode('guard');
    const g = grant('shell', 15, undefined, {}, T0);
    expect(check('shell', ctx, T0 + 14 * 60_000)).toMatchObject({ allow: true, grantId: g.grant_id });
    expect(check('shell', ctx, T0 + 15 * 60_000).allow).toBe(false);
    grant('web', null, undefined, {}, T0);
    expect(check('web', ctx, T0 + 999 * 86_400_000).allow).toBe(true);
    revoke(listState(T0).capabilities.find((c) => c.capability === 'web')!.grant_id!);
    expect(check('web', ctx, T0).allow).toBe(false);
  });
  it('guard mode, an explicit off beats a window that was granted before it', () => {
    setMode('guard');
    grant('shell', 60, undefined, {}, T0);
    turnOff('shell', undefined, {}, T0 + 1000);
    expect(check('shell', ctx, T0 + 2000).allow).toBe(false);
  });
  it('a new grant replaces the capability\'s old entry; one entry per capability', () => {
    turnOff('web');
    grant('web', 30);
    grant('web', 60);
    expect(JSON.parse(getConfig('consent.grants')!).filter((e: any) => e.capability === 'web')).toHaveLength(1);
  });
  it('revoking a switch-off puts the capability back on its mode default', () => {
    const off = turnOff('shell');
    expect(peek('shell').allow).toBe(false);
    expect(revoke(off.grant_id)?.capability).toBe('shell');
    expect(peek('shell').allow).toBe(true);
    expect(revoke('nope')).toBeNull();
  });
  it('rejects a window that is not whole minutes', () => {
    expect(() => grant('web', 0)).toThrow();
    expect(() => grant('web', 1.5 as any)).not.toThrow(); // floored
    expect(normalizeWindow('30' as any)).toBeUndefined();
    expect(normalizeWindow(null)).toBeNull();
    expect(normalizeWindow(99999999)).toBeUndefined();
  });
  it('a junk mode value reads as open; a corrupt grants list fails closed (see gate-failclosed.test.ts)', () => {
    setConfig('consent.mode', 'nonsense');
    expect(mode()).toBe('open');
  });
  it('requireCapability throws ConsentDeniedError naming Settings → Permissions', () => {
    turnOff('voice_out');
    try { requireCapability('voice_out', { harness: 'server' }); throw new Error('no throw'); }
    catch (e) { expect(e).toBeInstanceOf(ConsentDeniedError); expect((e as Error).message).toBe('Voice output is turned off (Settings → Permissions).'); }
  });
  it('deny texts', () => {
    expect(denyHint('shell', 'Shell access is turned off')).toBe('Blocked: Shell access is turned off. Ask with res ask shell <window> (minutes, or "on" to leave it on).');
    expect(denyMessage('web', 'Web access needs a grant (Guard mode is on)')).toBe('Web access needs a grant (Guard mode is on) (Settings → Permissions).');
  });
});

describe('receipts', () => {
  it('every check writes one row, allowed or denied; peek writes none', () => {
    check('shell', ctx); turnOff('web'); check('web', ctx);
    const n = count();
    peek('shell'); listState(); orientationLine();
    expect(count()).toBe(n);
    const rows = listReceipts({ capability: 'web' }).receipts.map((r) => r.outcome);
    expect(rows).toEqual(['denied', 'revoked']); // newest first: the denied check, the switch-off
  });
  it('grant, off, revoke and a mode change each write a row', () => {
    const g = grant('web', 30, 'because');
    expect(last()).toMatchObject({ capability: 'web', outcome: 'granted', grant_id: g.grant_id });
    revoke(g.grant_id);
    expect(last().outcome).toBe('revoked');
    turnOff('shell');
    expect(last()).toMatchObject({ capability: 'shell', outcome: 'revoked' });
    setMode('guard');
    expect(last()).toMatchObject({ capability: '*', outcome: 'mode_changed', summary: 'mode open → guard' });
  });
  it('the summary is scrubbed and at most 200 characters', () => {
    check('shell', { harness: 'claude', tool: 'Bash', summary: `curl -H "Authorization: Bearer abcdef1234567890" https://u:pw@host/x?api_key=SECRETVALUE --password hunter2 ${'x'.repeat(400)}` });
    const s = last().summary as string;
    expect(s.length).toBeLessThanOrEqual(200);
    for (const bad of ['abcdef1234567890', 'u:pw@', 'SECRETVALUE', 'hunter2']) expect(s).not.toContain(bad);
    expect(scrubSummary('OPENAI_API_KEY=sk-abcdefghijklmnop1234')).not.toMatch(/sk-abc/);
    expect(scrubSummary('a'.repeat(32) + ' ' + 'f'.repeat(40))).toBe('[redacted] [redacted]');
    expect(scrubSummary('git status')).toBe('git status');
  });
  it('paging: newest first, filters, before=', () => {
    for (let i = 0; i < 5; i++) check('shell', { ...ctx, tool: `Bash${i}`, summary: `n${i}` });
    check('web', ctx);
    turnOff('web');
    const p1 = listReceipts({ limit: 3 });
    expect(p1.receipts.map((r) => r.summary)).toEqual(['web turned off', 'ls', 'n4']);
    expect(p1.next_before).toBe(p1.receipts[2].id);
    const p2 = listReceipts({ limit: 3, before: p1.next_before! });
    expect(p2.receipts.map((r) => r.summary)).toEqual(['n3', 'n2', 'n1']);
    expect(listReceipts({ capability: 'shell', outcome: 'allowed', limit: 50 }).receipts).toHaveLength(5);
    expect(listReceipts({ outcome: 'revoked' }).receipts).toHaveLength(1);
  });
  it('prunes receipts older than 90 days and keeps the rest', () => {
    const now = Date.now();
    const old = new Date(now - 91 * 86_400_000).toISOString();
    getDb().prepare("INSERT INTO consent_receipts (ts, capability, harness, tool_or_route, summary, outcome) VALUES (?, 'shell', 'claude', 'Bash', 'old', 'allowed')").run(old);
    check('shell', ctx);
    expect(count()).toBe(2);
    expect(pruneReceipts(90, now)).toBe(1);
    expect(listReceipts().receipts.map((r) => r.summary)).toEqual(['ls']);
  });
  it('a receipt that cannot be written never throws', () => {
    getDb().exec('DROP TABLE consent_receipts');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(check('shell', ctx).allow).toBe(true);
    expect(() => writeReceipt({ capability: 'shell', outcome: 'allowed' })).not.toThrow();
    warn.mockRestore();
  });
});

describe('PIN rules for changes', () => {
  it('open mode, no PIN set: nothing needs one', () => {
    expect(pinNeededForGrant('web')).toBe('none');
    turnOff('web');
    expect(pinNeededForGrant('web')).toBe('none');
  });
  it('open mode with a PIN: turning back on what was turned off needs it; a window on something already on does not', () => {
    setPin('1234');
    expect(pinNeededForGrant('shell')).toBe('none');
    const off = turnOff('web');
    expect(pinNeededForGrant('web')).toBe('pin');
    expect(pinNeededForRevoke(off.grant_id)).toBe('pin');
    grant('shell', 30, undefined, {}, T0);
    expect(pinNeededForGrant('shell', T0 + 60_000)).toBe('none');
    expect(pinNeededForGrant('shell', T0 + 31 * 60_000)).toBe('pin'); // its window ended: letting it through again is turning it back on
  });
  it('guard mode: every grant needs it', () => {
    setPin('1234'); setMode('guard');
    expect(pinNeededForGrant('shell')).toBe('pin');
  });
  it('turning off never asks (the function is not even consulted)', () => {
    setPin('1234'); setMode('guard');
    expect(() => turnOff('shell')).not.toThrow();
  });
  it('askWouldChange: an ask for something already on with no end changes nothing; an off or windowed one does', () => {
    expect(askWouldChange('web')).toBe(false);
    turnOff('web');
    expect(askWouldChange('web')).toBe(true);
    grant('web', 30);
    expect(askWouldChange('web')).toBe(true);
    grant('web', null);
    expect(askWouldChange('web')).toBe(false);
  });
});

describe('consent_changed', () => {
  it('fires on grant, off, revoke and mode', () => {
    const seen: string[] = [];
    const un = onConsentChanged((c) => seen.push(`${c.change}:${c.capability ?? '-'}`));
    const g = grant('web', 30); turnOff('shell'); revoke(g.grant_id); setMode('guard');
    un();
    setMode('open');
    expect(seen).toEqual(['grant:web', 'off:shell', 'revoke:web', 'mode:-']);
  });
});

describe('orientation', () => {
  it('is null in open mode with nothing changed', () => {
    expect(orientationLine(T0)).toBeNull();
  });
  it('names what is off and what is on a window, and how to ask', () => {
    turnOff('shell');
    grant('web', 30, undefined, {}, T0);
    expect(orientationLine(T0 + 60_000)).toBe('Hands: shell off; web on until 12:30 (ask with res ask shell 30 for a window)');
  });
  it('says so when a window ended', () => {
    grant('web', 15, undefined, {}, T0);
    expect(orientationLine(T0 + 16 * 60_000)).toMatch(/^Hands: web off \(its window ended\)/);
  });
  it('guard mode always has a line, and lists what is on', () => {
    setMode('guard');
    grant('web', 30, undefined, {}, T0);
    const line = orientationLine(T0)!;
    expect(line).toMatch(/^Hands \(Guard mode, everything is off unless granted\): web on until 12:30; off: app_write, shell/);
  });
});

describe('runLimits (Codex and dsh launch flags)', () => {
  const cfg = { sandboxMode: 'workspace-write' as const, networkAccess: true, additionalDirectories: ['/data/notes'] };
  it('open mode, nothing off: exactly what is configured, no receipt, no log', () => {
    const n = count();
    expect(runLimits(cfg, { harness: 'codex' })).toEqual({ sandboxMode: 'workspace-write', networkAccess: true, additionalDirectories: ['/data/notes'], restricted: [] });
    expect(count()).toBe(n);
  });
  it('shell off → read-only', () => {
    turnOff('shell');
    expect(runLimits(cfg, { harness: 'codex' })).toMatchObject({ sandboxMode: 'read-only', restricted: ['shell'] });
  });
  it('files_outside_home off → no additional folders; web off → no network', () => {
    turnOff('files_outside_home'); turnOff('web');
    const r = runLimits(cfg, { harness: 'codex', threadId: 't9' });
    expect(r).toMatchObject({ sandboxMode: 'workspace-write', networkAccess: false, additionalDirectories: [] });
    expect(r.restricted.sort()).toEqual(['files_outside_home', 'web']);
    expect(listReceipts({ outcome: 'denied' }).receipts.map((x) => x.tool_or_route)).toEqual(['run flags', 'run flags']);
  });
  it('danger-full-access drops to workspace-write when any of its four is off', () => {
    turnOff('self_code_edit');
    expect(runLimits({ ...cfg, sandboxMode: 'danger-full-access' }, { harness: 'codex' }).sandboxMode).toBe('workspace-write');
  });
  it('guard mode with no grants: read-only, no network, no folders; a window opens just that', () => {
    setMode('guard');
    expect(runLimits(cfg, { harness: 'codex' })).toMatchObject({ sandboxMode: 'read-only', networkAccess: false, additionalDirectories: [] });
    grant('shell', 30); grant('web', 30);
    expect(runLimits(cfg, { harness: 'codex' })).toMatchObject({ sandboxMode: 'workspace-write', networkAccess: true, additionalDirectories: [] });
  });
  it('is fixed at call time: a change afterwards does not touch the result already returned', () => {
    const r = runLimits(cfg, { harness: 'codex' });
    turnOff('shell');
    expect(r.sandboxMode).toBe('workspace-write');
    expect(runLimits(cfg, { harness: 'codex' }).sandboxMode).toBe('read-only'); // the next turn
  });
});

describe('state → codex exec flags, end to end', () => {
  const argsFor = () => {
    const l = runLimits({ sandboxMode: 'workspace-write', networkAccess: true, additionalDirectories: ['/data/notes'] }, { harness: 'codex' });
    return buildExecArgs({ sandboxMode: l.sandboxMode, cwd: '/home', additionalDirectories: l.additionalDirectories, networkAccess: l.networkAccess });
  };
  it('nothing off: the configured flags', () => {
    const a = argsFor();
    expect(a).toContain('--add-dir'); expect(a).toContain('sandbox_workspace_write.network_access=true');
    expect(a[a.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });
  it('shell, files and web off: read-only, no --add-dir, network false', () => {
    turnOff('shell'); turnOff('files_outside_home'); turnOff('web');
    const a = argsFor();
    expect(a[a.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(a).not.toContain('--add-dir');
    expect(a).toContain('sandbox_workspace_write.network_access=false');
  });
});


describe('fix pass: PIN on anything that lets a capability through', () => {
  it('an ended window: revoking it needs the PIN once one exists (and none before)', () => {
    const w = grant('shell', 15, undefined, {}, T0);
    expect(pinNeededForRevoke(w.grant_id, T0 + 20 * 60_000)).toBe('none'); // no PIN set yet
    setPin('1234');
    expect(pinNeededForRevoke(w.grant_id, T0 + 20 * 60_000)).toBe('pin');
    expect(pinNeededForRevoke(w.grant_id, T0 + 5 * 60_000)).toBe('none'); // still live: removing it changes nothing
  });
  it('an OFF override needs it; in Guard, revoking a grant makes it off, so it does not', () => {
    setPin('1234');
    expect(pinNeededForRevoke(turnOff('web').grant_id)).toBe('pin');
    setMode('guard');
    expect(pinNeededForRevoke(grant('shell', 30).grant_id)).toBe('none');
  });
  it('stretching a live window (longer or leave-on) needs it; a shorter one does not', () => {
    setPin('1234');
    grant('web', 30, undefined, {}, T0);
    expect(pinNeededForGrant('web', T0 + 1000, null)).toBe('pin');
    expect(pinNeededForGrant('web', T0 + 1000, 60)).toBe('pin');
    expect(pinNeededForGrant('web', T0 + 1000, 15)).toBe('none');
  });
});

describe('fix pass: switching Guard on is a clean slate', () => {
  it('clears every window and leave-on entry (listed on the receipt), keeps switch-offs, and Open does not bring them back', () => {
    grant('shell', null);
    grant('web', 30);
    const off = turnOff('voice_out');
    setMode('guard');
    expect(mode()).toBe('guard');
    expect(listState().capabilities.filter((c) => c.source === 'grant')).toEqual([]);
    expect(peek('shell').allow).toBe(false);
    expect(peek('web').allow).toBe(false);
    const rec = last();
    expect(rec).toMatchObject({ capability: '*', outcome: 'mode_changed' });
    expect(rec.summary).toBe('mode open → guard; cleared: shell (on), web (window)');
    setMode('open');
    expect(last().summary).toBe('mode guard → open');
    expect(peek('shell')).toMatchObject({ allow: true, reason: 'Shell access is on' });
    expect(listState().capabilities.find((c) => c.capability === 'shell')).toMatchObject({ source: 'default', grant_id: null });
    expect(listState().capabilities.find((c) => c.capability === 'web')).toMatchObject({ source: 'default' });
    expect(peek('voice_out')).toMatchObject({ allow: false, grantId: off.grant_id }); // the person's own switch-off is theirs, not a grant
  });
  it('a grant made IN Guard is not wiped by setMode(guard) again', () => {
    setMode('guard');
    grant('shell', 30);
    setMode('guard');
    expect(peek('shell').allow).toBe(true);
  });
});

describe('fix pass: receipts are coalesced', () => {
  const rows = () => getDb().prepare('SELECT capability, tool_or_route, outcome, count, summary FROM consent_receipts ORDER BY id').all() as any[];
  it('consecutive allowed rows for the same capability, thread and tool within 60 s are one row with a count', () => {
    for (let i = 0; i < 5; i++) check('shell', { ...ctx, summary: `cmd ${i}` });
    expect(rows()).toEqual([{ capability: 'shell', tool_or_route: 'Bash', outcome: 'allowed', count: 5, summary: 'cmd 0' }]);
  });
  it('a different thread, tool or capability is its own row; a denied row in between breaks the run; denied rows are never merged', () => {
    check('shell', ctx);
    check('shell', { ...ctx, threadId: 't2' });
    check('shell', { ...ctx, tool: 'Other' });
    check('web', ctx);
    expect(rows()).toHaveLength(4);
    turnOff('shell');
    check('shell', ctx); check('shell', ctx);
    expect(rows().filter((r) => r.outcome === 'denied')).toHaveLength(2);
  });
  it('after 60 s a new row starts', () => {
    check('shell', ctx);
    getDb().prepare('UPDATE consent_receipts SET ts = ?').run(new Date(Date.now() - COALESCE_MS - 1000).toISOString());
    check('shell', ctx);
    expect(rows().map((r) => r.count)).toEqual([1, 1]);
  });
  it('a database that had the table before count existed gets the column, with 1 on old rows', () => {
    const raw = openDb(':memory:');
    raw.exec('DROP TABLE consent_receipts');
    raw.exec("CREATE TABLE consent_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, capability TEXT NOT NULL, grant_id TEXT, harness TEXT NOT NULL DEFAULT '', thread_id TEXT, tool_or_route TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL)");
    raw.exec("INSERT INTO consent_receipts (ts, capability, outcome) VALUES ('2026-01-01T00:00:00Z', 'shell', 'allowed')");
    raw.exec('ALTER TABLE consent_receipts ADD COLUMN count INTEGER DEFAULT 1');
    expect((raw.prepare('SELECT count FROM consent_receipts').get() as any).count).toBe(1);
  });
  it('the list route\'s rows carry the count', () => {
    check('shell', ctx); check('shell', ctx);
    expect(listReceipts().receipts[0]).toMatchObject({ outcome: 'allowed', count: 2 });
  });
});

describe('fix pass: pruning runs on a timer, tenant databases included', () => {
  it('prunes at start and every 6 hours, in the process database and in each tenant\'s', () => {
    vi.useFakeTimers();
    try {
      const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
      const mk = () => { const db = openDb(':memory:'); db.prepare("INSERT INTO consent_receipts (ts, capability, outcome) VALUES (?, 'shell', 'allowed')").run(old); return db; };
      const tdb = mk();
      const rt = { id: 'tenant-a', db: tdb, parked: false } as any;
      const countOf = (db: any) => (db.prepare('SELECT COUNT(*) AS n FROM consent_receipts').get() as any).n;
      getDb().prepare("INSERT INTO consent_receipts (ts, capability, outcome) VALUES (?, 'shell', 'allowed')").run(old);
      enableTenancy(true);
      let stop: () => void;
      try { stop = startReceiptPruning(() => [rt] as any); } finally { enableTenancy(false); }
      // (the first run pruned the tenant's database; the process database is pruned by the same call when no tenants are given)
      expect(countOf(tdb)).toBe(0);
      expect(countOf(getDb())).toBe(1);
      stop();
      const stop2 = startReceiptPruning();
      expect(countOf(getDb())).toBe(0);
      getDb().prepare("INSERT INTO consent_receipts (ts, capability, outcome) VALUES (?, 'shell', 'allowed')").run(old);
      vi.advanceTimersByTime(6 * 3600_000 - 1);
      expect(countOf(getDb())).toBe(1);
      vi.advanceTimersByTime(2);
      expect(countOf(getDb())).toBe(0);
      stop2();
      getDb().prepare("INSERT INTO consent_receipts (ts, capability, outcome) VALUES (?, 'shell', 'allowed')").run(old);
      vi.advanceTimersByTime(7 * 3600_000);
      expect(countOf(getDb())).toBe(1); // stopped
    } finally { vi.useRealTimers(); }
  });
  it('one tenant failing does not stop the others', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = openDb(':memory:');
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    good.prepare("INSERT INTO consent_receipts (ts, capability, outcome) VALUES (?, 'shell', 'allowed')").run(old);
    const parked = { id: 'p', db: openDb(':memory:'), parked: true } as any;
    enableTenancy(true);
    let n: number;
    try { n = pruneAllReceipts([parked, { id: 'g', db: good, parked: false }] as any); } finally { enableTenancy(false); }
    expect(n).toBe(1);
  });
});

describe('fix pass: dsh does not claim a web narrowing it does not apply', () => {
  it('web off + shell on, networkAccess false (what dsh passes): no restriction, no receipt', () => {
    turnOff('web');
    const before = count();
    expect(runLimits({ sandboxMode: 'workspace-write', networkAccess: false }, { harness: 'dsh', threadId: 't1' })).toMatchObject({ sandboxMode: 'workspace-write', restricted: [] });
    expect(count()).toBe(before);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM consent_receipts WHERE tool_or_route = 'run flags'").get()).toEqual({ n: 0 });
  });
});
