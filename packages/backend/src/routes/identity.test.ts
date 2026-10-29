// Identity ratification routes: the person's (session) and the companion's (internal token).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ home: '', ledgerDir: '', appWrite: true, noLedger: false, pushes: [] as any[], extraWritable: '' }));
vi.mock('../config.js', () => ({
  getSanctumConfig: () => ({
    auth: { password: 'pw' },
    identity: { companion_name: 'Hazel', user_name: 'Pat', ledger_dir: h.noLedger ? '' : h.ledgerDir, profile_path: '', companion_md_path: '' },
    agent: { cwd: h.home, app_write: h.appWrite },
    hooks: { extra_write_paths: h.extraWritable ? [h.extraWritable] : [] },
    server: { db_path: h.noLedger ? ':memory:' : join(h.ledgerDir, '..', 'sanctum.db') },
  }),
}));
vi.mock('../services/db.js', () => ({
  getWebSession: (t: string) => (t === 'good' ? { expires_at: new Date(Date.now() + 3600_000).toISOString() } : null),
  createWebSession: () => {}, deleteExpiredSessions: () => {},
  getCurrentDailyThread: () => ({ id: 'daily-test' }), ensureDailyThread: () => ({ thread: { id: 'daily-test' } }),
  createMessage: () => ({}),
}));
vi.mock('../services/ws.js', () => ({ registry: { broadcast: (m: any) => { h.pushes.push(m); } } }));

import { identityInternalRouter, identityRouter } from './identity.js';
import { setTurnProbe } from '../services/identity/guard.js';
import { checkIdentity, readJournal, ratifyIdentity, resetLedgerWarnings } from '../services/identity/ledger.js';

const TOKEN = 'test-internal-token-0123456789abcdef';
let server: Server;
let base = '';
const roots: string[] = [];
const id = (n: string) => join(h.home, 'identity', n);

beforeAll(async () => {
  process.env.INTERNAL_TOKEN = TOKEN;
  const app = express();
  app.use(express.json());
  app.use('/api/identity', identityRouter);
  app.use('/api/internal/identity', identityInternalRouter);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { delete process.env.INTERNAL_TOKEN; await new Promise((r) => server.close(r)); });
beforeEach(() => {
  resetLedgerWarnings();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const root = mkdtempSync(join(tmpdir(), 'sanctum-idroutes-'));
  roots.push(root);
  h.home = join(root, 'home');
  h.ledgerDir = join(root, 'data', 'identity');
  h.appWrite = true; h.noLedger = false; h.pushes = []; h.extraWritable = '';
  mkdirSync(join(h.home, 'identity'), { recursive: true });
  writeFileSync(id('profile.md'), 'Profile v1');
  writeFileSync(id('companion.md'), 'Narrative v1');
});
afterEach(() => {
  // Nothing the routes write may land outside the test's tmp tree (a relative ledger path once left ledger.json and journal.jsonl in the project root).
  expect(existsSync(join(process.cwd(), 'ledger.json'))).toBe(false);
  expect(existsSync(join(process.cwd(), 'journal.jsonl'))).toBe(false);
  vi.restoreAllMocks(); setTurnProbe(null); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const person = (path: string, init: RequestInit = {}) => fetch(`${base}/api/identity${path}`, { ...init, headers: { cookie: 'sanctum_session=good', 'content-type': 'application/json', ...(init.headers as object) } });
const send = (method: string, path: string, body?: unknown) => person(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const opts = () => ({ ledgerDir: h.ledgerDir, trustStat: false });
const ratified = () => ratifyIdentity(h.home, opts(), { by: 'person' });

const internal = (path: string, init: RequestInit = {}) => fetch(`${base}/api/internal/identity${path}`, { ...init, headers: { 'x-internal-token': TOKEN, 'content-type': 'application/json', ...(init.headers as object) } });

describe('GET /api/internal/identity/status (res identity status)', () => {
  it('needs the internal token; without it the route is not there', async () => {
    expect((await fetch(`${base}/api/internal/identity/status`)).status).toBe(404);
    expect((await fetch(`${base}/api/internal/identity/status`, { headers: { 'x-internal-token': 'wrong' } })).status).toBe(404);
  });

  it('says unratified on first sight, and journals the baseline', async () => {
    const body = await (await internal('/status')).json() as any;
    expect(body).toMatchObject({ state: 'unratified', ratified: null, pending: null, files: ['companion.md', 'profile.md'] });
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(readJournal(h.ledgerDir).map((e) => e.author)).toEqual(['baseline']);
  });

  it('reports a change on disk as pending with who made it, and what the app knew when it noticed', async () => {
    ratifyIdentity(h.home, { ledgerDir: h.ledgerDir, trustStat: false }, { by: 'person' });
    writeFileSync(id('companion.md'), 'rewritten behind the app');
    setTurnProbe(() => true);
    const body = await (await internal('/status')).json() as any;
    expect(body.state).toBe('pending');
    expect(body.pending).toMatchObject({ author: 'filesystem', changes: [{ path: 'companion.md', kind: 'modified' }] });
    const j = readJournal(h.ledgerDir)[0];
    expect(j.author).toBe('filesystem');
    expect(j.detail).toContain('while a turn was running');
  });

  it('names with control characters or a great length come out printable and capped', async () => {
    ratified();
    const posix = process.platform !== 'win32'; // a newline cannot be in a Windows file name
    writeFileSync(id('evil\u2028name.md'), 'x'); // U+2028 is accepted everywhere and is sanitised like a control character
    if (posix) writeFileSync(id('evil\nname.md'), 'x');
    writeFileSync(id(`${'l'.repeat(100)}.md`), 'x');
    const body = await (await internal('/status')).json() as any;
    const names: string[] = [...body.files, ...body.pending.changes.map((c: any) => c.path)];
    expect(names.length).toBeGreaterThan(posix ? 4 : 3);
    for (const n of names) {
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(n), JSON.stringify(n)).toBe(false);
      expect(n.length).toBeLessThanOrEqual(83);
    }
    expect(body.files).toContain('evil?name.md');
    // the app's own route keeps the real names the editor and the diff look files up by
    const mine = await (await person('/status')).json() as any;
    expect(mine.files).toContain('evil\u2028name.md');
    if (posix) expect(mine.files).toContain('evil\nname.md');
  });

  it('is read-only: a POST to it is not a route, and the app-write switch does not gate it', async () => {
    h.appWrite = false;
    expect((await internal('/status')).status).toBe(200);
    expect((await internal('/status', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('503 with a plain error when no ledger folder can be found', async () => {
    h.noLedger = true;
    const r = await internal('/status');
    expect(r.status).toBe(503);
  });
});

describe('when the ledger cannot be read, and where it sits', () => {
  it('a damaged ledger.json: unavailable with a reason, and the person can ratify their way out', async () => {
    ratified();
    writeFileSync(join(h.ledgerDir, 'ledger.json'), '{broken');
    const st = await (await person('/status')).json() as any;
    expect(st).toMatchObject({ state: 'unavailable', canRatify: true });
    expect(st.detail).toMatch(/not valid JSON/);
    const r = await send('POST', '/ratify', { digest: st.digest });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: { state: 'ok', ratified: { by: 'person' } } });
  });

  it('over a damaged ledger /files and /diff answer with the live files, so the person sees what they would ratify', async () => {
    ratified();
    writeFileSync(join(h.ledgerDir, 'ledger.json'), '{broken');
    writeFileSync(id('companion.md'), 'EVIL2');
    const st = await (await person('/status')).json() as any;
    expect(st).toMatchObject({ state: 'unavailable', canRatify: true });
    const fr = await person('/files');
    expect(fr.status).toBe(200);
    const files = await fr.json() as any;
    expect(files.digest).toBe(st.digest);
    expect(files.files).toEqual([{ name: 'companion.md', text: 'EVIL2' }, { name: 'profile.md', text: 'Profile v1' }]);
    const dr = await person('/diff?from=ratified&to=live');
    expect(dr.status).toBe(200);
    const diff = await dr.json() as any;
    expect(diff.files.map((f: any) => [f.path, f.kind])).toEqual([['companion.md', 'added'], ['profile.md', 'added']]);
    expect(diff.files[0].diff).toContain('+EVIL2');
  });

  it('/files stays 503 when the ledger folder is refused, not merely damaged', async () => {
    h.ledgerDir = join(h.home, 'identity', 'ledger');
    expect((await person('/files')).status).toBe(503);
  });

  it('canRatify is false when the ledger folder is refused (inside identity/)', async () => {
    h.ledgerDir = join(h.home, 'identity', 'ledger');
    const st = await (await person('/status')).json() as any;
    expect(st).toMatchObject({ state: 'unavailable', canRatify: false });
  });

  it('status carries a warning when the ledger folder is inside a folder the companion can write, and none when it is not', async () => {
    expect(((await (await person('/status')).json()) as any).warning).toBeNull();
    h.ledgerDir = join(h.home, 'data', 'identity'); // inside the home (agent.cwd)
    const st = await (await person('/status')).json() as any;
    expect(st.state).toBe('unratified'); // a warning, not a refusal
    expect(st.warning).toContain('which the companion can write');
    expect(st.warning).toContain('Where to put the house');
    h.ledgerDir = join(mkdtempSync(join(tmpdir(), 'sanctum-idelsewhere-')), 'identity');
    roots.push(join(h.ledgerDir, '..'));
    h.extraWritable = join(h.ledgerDir, '..');
    expect(((await (await person('/status')).json()) as any).warning).toContain('hooks.extra_write_paths');
  });
});

describe('res identity status', () => {
  it('prints the status JSON from the running server and exits 0', async () => {
    const res = fileURLToPath(new URL('../../../../tools/res.mjs', import.meta.url));
    const port = (server.address() as AddressInfo).port;
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(process.execPath, [res, 'identity', 'status'], {
        env: { ...process.env, SANCTUM_PORT: String(port), SANCTUM_HOST: '127.0.0.1', INTERNAL_TOKEN: TOKEN },
      }, (err, stdout) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout }));
    });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ state: 'unratified' });
  });
});

describe('the person\'s routes are session-only', () => {
  const calls: Array<[string, string, unknown?]> = [
    ['GET', '/status'], ['GET', '/history'], ['GET', '/files'], ['GET', '/diff'],
    ['POST', '/ratify', { digest: 'a'.repeat(64) }], ['POST', '/revert', { digest: 'a'.repeat(64) }], ['PUT', '/file', { path: 'a.md', text: 'x', digest: 'a'.repeat(64) }],
  ];
  it('without a session: 401, and the internal token does not stand in for one', async () => {
    for (const [method, path, body] of calls) {
      const bare = await fetch(`${base}/api/identity${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      expect(bare.status, `${method} ${path}`).toBe(401);
      const withToken = await fetch(`${base}/api/identity${path}`, { method, headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
      expect(withToken.status, `${method} ${path} with the internal token`).toBe(401);
    }
    expect(existsSync(h.ledgerDir) ? readdirSync(h.ledgerDir) : []).toEqual([]);
  });

  it('the companion\'s router has no ratify, revert or person-edit route', async () => {
    for (const [method, path] of [['POST', '/ratify'], ['POST', '/revert'], ['PUT', '/file'], ['GET', '/history'], ['GET', '/diff']] as const) {
      const r = await internal(path, { method, body: method === 'GET' ? undefined : '{}' });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('GET status, files, history', () => {
  it('status and files agree on the digest, and the files carry their text', async () => {
    const st = await (await person('/status')).json() as any;
    const fl = await (await person('/files')).json() as any;
    expect(fl.digest).toBe(st.digest);
    expect(fl.files).toEqual([{ name: 'companion.md', text: 'Narrative v1' }, { name: 'profile.md', text: 'Profile v1' }]);
  });

  it('history is newest first and bounded by limit', async () => {
    ratified();
    writeFileSync(id('profile.md'), 'x');
    const h1 = await (await person('/history')).json() as any;
    expect(h1.entries.map((e: any) => e.author)).toEqual(['filesystem', 'person', 'baseline']);
    expect(h1.ratified_digest).toMatch(/^[0-9a-f]{64}$/);
    const h2 = await (await person('/history?limit=1')).json() as any;
    expect(h2.entries).toHaveLength(1);
  });
});

describe('POST ratify and revert', () => {
  it('ratify needs a digest, and answers 409 when the files moved since the person looked', async () => {
    expect((await send('POST', '/ratify', {})).status).toBe(400);
    expect((await send('POST', '/ratify', { digest: 'nope' })).status).toBe(400);
    const shown = (await (await person('/status')).json() as any).digest;
    writeFileSync(id('profile.md'), 'moved after the person looked');
    const r = await send('POST', '/ratify', { digest: shown });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'digest_mismatch' });
    expect(checkIdentity(h.home, opts()).state).toBe('unratified');
  });

  it('ratify records the digest as the person\'s and answers ok', async () => {
    const shown = (await (await person('/status')).json() as any).digest;
    const r = await send('POST', '/ratify', { digest: shown });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.status).toMatchObject({ state: 'ok', ratified: { digest: shown, by: 'person' } });
    expect(readJournal(h.ledgerDir)[0]).toMatchObject({ kind: 'ratify', author: 'person' });
  });

  it('revert answers 409 with nothing waiting, and with a stale digest; otherwise puts the ratified files back', async () => {
    ratified();
    expect((await send('POST', '/revert', { digest: 'a'.repeat(64) })).status).toBe(409);
    writeFileSync(id('companion.md'), 'hostile');
    const shown = (await (await person('/status')).json() as any).digest;
    expect((await send('POST', '/revert', { digest: 'b'.repeat(64) })).status).toBe(409);
    expect(readFileSync(id('companion.md'), 'utf-8')).toBe('hostile');
    const r = await send('POST', '/revert', { digest: shown });
    expect(r.status).toBe(200);
    expect(readFileSync(id('companion.md'), 'utf-8')).toBe('Narrative v1');
    expect(readJournal(h.ledgerDir)[0].author).toBe('revert');
  });
});

describe('POST /api/identity/ratify when already ratified', () => {
  it('200 with unchanged: true, and the journal does not grow', async () => {
    ratified();
    const st = await (await person('/status')).json() as any;
    const before = readJournal(h.ledgerDir).length;
    for (let i = 0; i < 3; i++) {
      const r = await send('POST', '/ratify', { digest: st.digest });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, unchanged: true, status: { state: 'ok' } });
    }
    expect(readJournal(h.ledgerDir)).toHaveLength(before);
  });
});

describe('PUT /api/identity/file: the person\'s edit', () => {
  it('writes and ratifies in one step when nothing else was waiting', async () => {
    ratified();
    const fl = await (await person('/files')).json() as any;
    const r = await send('PUT', '/file', { path: 'profile.md', text: 'Edited in the app', digest: fl.digest });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, ratified: true, status: { state: 'ok' } });
    expect(readFileSync(id('profile.md'), 'utf-8')).toBe('Edited in the app');
  });

  it('409 when the files moved since the digest the editor showed; nothing is written', async () => {
    ratified();
    const fl = await (await person('/files')).json() as any;
    writeFileSync(id('companion.md'), 'someone got there first');
    const r = await send('PUT', '/file', { path: 'profile.md', text: 'mine', digest: fl.digest });
    expect(r.status).toBe(409);
    expect(readFileSync(id('profile.md'), 'utf-8')).toBe('Profile v1');
  });

  it('with a change waiting, the edit is saved but not ratified', async () => {
    ratified();
    writeFileSync(id('companion.md'), 'waiting');
    const fl = await (await person('/files')).json() as any;
    const body = await (await send('PUT', '/file', { path: 'profile.md', text: 'mine', digest: fl.digest })).json() as any;
    expect(body.ratified).toBe(false);
    expect(body.status.state).toBe('pending');
  });

  it('status lists the companion and then the person when both changed the files since the ratified version', async () => {
    ratified();
    expect((await internal('/file', { method: 'POST', body: JSON.stringify({ path: 'companion.md', text: 'by the companion' }) })).status).toBe(200);
    const fl = await (await person('/files')).json() as any;
    expect((await send('PUT', '/file', { path: 'profile.md', text: 'by the person', digest: fl.digest })).status).toBe(200);
    const st = await (await person('/status')).json() as any;
    expect(st.state).toBe('pending');
    expect(st.pending.authors).toEqual(['companion', 'person']);
    expect(st.pending.author).toBe('person');
    expect(h.pushes.at(-1).status.pending.authors).toEqual(['companion', 'person']);
  });

  it('refuses names that are not a plain file directly in identity/', async () => {
    ratified();
    const fl = await (await person('/files')).json() as any;
    for (const path of ['../outside.md', 'a/b.md', '..\\x.md', '.hidden', 'avatar.png', '']) {
      const r = await send('PUT', '/file', { path, text: 'x', digest: fl.digest });
      expect(r.status, JSON.stringify(path)).toBe(400);
    }
    expect((await send('PUT', '/file', { path: 'PROFILE.md', text: 'x', digest: fl.digest })).status).toBe(409);
    expect(existsSync(join(h.home, 'outside.md'))).toBe(false);
    expect(readdirSync(join(h.home, 'identity')).sort()).toEqual(['companion.md', 'profile.md']);
  });

  it('refuses to write through a link', async () => {
    writeFileSync(join(h.home, 'target.md'), 'T');
    try { symlinkSync(join(h.home, 'target.md'), id('linked.md')); } catch { return; }
    const fl = await (await person('/files')).json() as any;
    const r = await send('PUT', '/file', { path: 'linked.md', text: 'x', digest: fl.digest });
    expect(r.status).toBe(409);
    expect(readFileSync(join(h.home, 'target.md'), 'utf-8')).toBe('T');
  });

  it('400 without path, text or digest', async () => {
    expect((await send('PUT', '/file', { text: 'x', digest: 'a'.repeat(64) })).status).toBe(400);
    expect((await send('PUT', '/file', { path: 'a.md', text: 'x' })).status).toBe(400);
  });
});

describe('POST /api/internal/identity/file: the companion\'s edit', () => {
  const write = (body: unknown, headers: Record<string, string> = {}) => internal('/file', { method: 'POST', body: JSON.stringify(body), headers });

  it('needs the internal token and the app-write switch', async () => {
    expect((await fetch(`${base}/api/internal/identity/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"path":"a.md","text":"x"}' })).status).toBe(404);
    h.appWrite = false;
    const r = await write({ path: 'a.md', text: 'x' });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'app_write_off' });
    expect(existsSync(id('a.md'))).toBe(false);
  });

  it('writes the file, journals companion, and does not ratify it', async () => {
    const was = ratified();
    const r = await write({ path: 'companion.md', text: 'I changed myself' });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body).toMatchObject({ ok: true, ratified: false, status: { state: 'pending', pending: { author: 'companion' }, ratified: { digest: was.digest } } });
    expect(readFileSync(id('companion.md'), 'utf-8')).toBe('I changed myself');
    expect(readJournal(h.ledgerDir)[0]).toMatchObject({ author: 'companion', files: { modified: ['companion.md'] } });
    expect(readJournal(h.ledgerDir).filter((e) => e.kind === 'ratify')).toHaveLength(1); // only the person's own
  });

  it('refuses bad names and bodies', async () => {
    for (const path of ['../x.md', 'a/b.md', 'avatar.png', '.git']) expect((await write({ path, text: 'x' })).status, path).toBe(400);
    expect((await write({ path: 'a.md' })).status).toBe(400);
    expect((await write({ path: 'a.md', text: 5 })).status).toBe(400);
  });
});

describe('GET /api/identity/diff', () => {
  it('shows the unified diff of ratified to live, per file, text only', async () => {
    ratified();
    writeFileSync(id('companion.md'), 'Narrative v2\nsecond line');
    writeFileSync(id('new.md'), 'brand new');
    rmSync(id('profile.md'));
    const body = await (await person('/diff')).json() as any;
    expect(body.files.map((f: any) => [f.path, f.kind])).toEqual([['companion.md', 'modified'], ['new.md', 'added'], ['profile.md', 'removed']]);
    expect(body.files[0].diff).toBe('--- ' + body.from.slice(0, 8) + '/companion.md\n+++ live/companion.md\n@@ -1,1 +1,2 @@\n-Narrative v1\n+Narrative v2\n+second line');
    expect(body.files[1].diff).toContain('+brand new');
    expect(body.files[2].diff).toContain('-Profile v1');
  });

  it('between two ratified copies, by digest', async () => {
    const first = ratified();
    writeFileSync(id('profile.md'), 'Profile v2');
    const second = ratified();
    const body = await (await person(`/diff?from=${first.digest}&to=${second.digest}`)).json() as any;
    expect(body.files).toHaveLength(1);
    expect(body.files[0].diff).toContain('-Profile v1');
    expect(body.files[0].diff).toContain('+Profile v2');
  });

  it('404 for a digest with no copy, 400 for something that is not a digest', async () => {
    ratified();
    expect((await person(`/diff?from=${'c'.repeat(64)}`)).status).toBe(404);
    expect((await person('/diff?from=../../x')).status).toBe(400);
    expect((await person('/diff?to=live&from=ratified')).status).toBe(200);
  });

  it('a file over 256 KiB is named but not diffed, and a binary one says so', async () => {
    ratified();
    writeFileSync(id('big.md'), 'x'.repeat(300 * 1024));
    writeFileSync(id('bin.dat'), Buffer.from([1, 2, 0, 3]));
    const body = await (await person('/diff')).json() as any;
    expect(body.files.find((f: any) => f.path === 'big.md')).toEqual({ path: 'big.md', kind: 'added', truncated: true });
    expect(body.files.find((f: any) => f.path === 'bin.dat')).toEqual({ path: 'bin.dat', kind: 'added', binary: true });
  });
});

describe('the apps are told when the state moves', () => {
  const states = () => h.pushes.filter((p) => p.type === 'identity_status').map((p) => p.status.state);

  it('ratify, revert, the person\'s edit and the companion\'s edit each push identity_status', async () => {
    const shown = (await (await person('/status')).json() as any).digest;
    await send('POST', '/ratify', { digest: shown });
    expect(states()).toEqual(['ok']);
    await internal('/file', { method: 'POST', body: JSON.stringify({ path: 'companion.md', text: 'changed by the companion' }) });
    expect(states()).toEqual(['ok', 'pending']);
    const pending = (await (await person('/status')).json() as any).digest;
    await send('POST', '/revert', { digest: pending });
    expect(states()).toEqual(['ok', 'pending', 'ok']);
    const fl = await (await person('/files')).json() as any;
    await send('PUT', '/file', { path: 'profile.md', text: 'edited', digest: fl.digest });
    expect(states()).toEqual(['ok', 'pending', 'ok', 'ok']);
  });

  it('a refused write pushes nothing', async () => {
    await send('POST', '/ratify', { digest: 'a'.repeat(64) });
    expect(h.pushes).toEqual([]);
  });
});

describe('legacy: no identity folder', () => {
  it('both status routes say legacy, with the CLAUDE.md sentence, and write no ledger', async () => {
    rmSync(join(h.home, 'identity'), { recursive: true });
    for (const get of [() => person('/status'), () => internal('/status')]) {
      const body = await (await get()).json() as any;
      expect(body.state).toBe('legacy');
      expect(body.canRatify).toBe(false);
      expect(body.detail).toMatch(/CLAUDE\.md/);
    }
    expect(existsSync(h.ledgerDir)).toBe(false);
  });
});
