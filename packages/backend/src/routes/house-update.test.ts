// /api/house/update, /start, /rollback: a session plus the password again, one job at a time, house-only paths.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const h = vi.hoisted(() => ({ session: true, busy: false, gate: null as null | Promise<void> }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (_req: unknown, res: { status(n: number): { json(b: unknown): void } }, next: () => void) => (h.session ? next() : res.status(401).json({ error: 'Unauthorized' })),
  verifyPassword: (p: unknown) => p === 'correct horse',
}));
vi.mock('../services/update-check.js', () => ({
  checkForUpdate: async () => ({ version: '1.0.0', latest: '1.1.0', update_available: true, repo: 'echo/sanctum', branch: 'main', checked_at: '2026-11-03T00:00:00.000Z' }),
}));

import router from './house-update.js';
import { _jobDone, _setUpdaterEnv } from '../services/updater.js';
import { isHouseRoute } from '../tenancy/resolve.js';
import { makeRollbackCopy } from '../../../../scripts/updater-core.mjs';

const put = (root: string, rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const pkg = (v: string) => JSON.stringify({ name: 'fake', version: v, repository: 'github:echo/sanctum' });

let tmp: string, root: string, data: string, server: Server, base = '';
const realFetch = globalThis.fetch;
const app = express();
app.use(express.json());
// What the household resolver does for /c/<id>/...: strips the prefix from req.url (originalUrl keeps it) and sets the companion.
app.use((req, _res, next) => {
  const m = /^\/c\/([a-z0-9-]+)(\/.*)$/.exec(req.url);
  if (m) { req.url = m[2]; (req as unknown as { tenant: object }).tenant = { id: m[1] }; }
  next();
});
app.use('/api/house/update', router);

beforeAll(async () => { await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'house-update-')); root = join(tmp, 'app'); data = join(root, 'data');
  put(root, 'package.json', pkg('1.0.0'));
  h.session = true; h.busy = false; h.gate = null;
  // GitHub answers "1.0.0" (nothing newer), after the gate if a test holds one: a job that does nothing, but takes as long as the test needs.
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).includes('githubusercontent')) { if (h.gate) await h.gate; return { ok: true, status: 200, text: async () => JSON.stringify({ version: '1.0.0' }) }; }
    return realFetch(url, init);
  });
  _setUpdaterEnv({ root, dataDir: () => data, busy: () => h.busy, supervised: () => false });
});
afterEach(() => { vi.unstubAllGlobals(); _setUpdaterEnv(null); rmSync(tmp, { recursive: true, force: true }); });

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  realFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('GET /api/house/update', () => {
  it('needs a session', async () => {
    h.session = false;
    expect((await realFetch(`${base}/api/house/update`)).status).toBe(401);
  });
  it('answers the status shape', async () => {
    const res = await realFetch(`${base}/api/house/update`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      version: '1.0.0', latest: '1.1.0', update_available: true, repo: 'echo/sanctum', branch: 'main',
      self_update: { ok: expect.any(Boolean), mode: expect.stringMatching(/^(git|tarball)$/) },
      restart_mode: 'respawn', household: false, companions: 1, job: null,
      rollback: { available: false, version: null },
    });
  });
});

describe('POST /api/house/update/start', () => {
  it('needs a session, then the password again (401 when missing or wrong)', async () => {
    h.session = false;
    expect((await post('/api/house/update/start', { password: 'correct horse' })).status).toBe(401);
    h.session = true;
    const missing = await post('/api/house/update/start', {});
    expect(missing.status).toBe(401);
    expect((await missing.json()).error).toBe('password_required');
    const wrong = await post('/api/house/update/start', { password: 'nope' });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe('wrong_password');
    expect(await (await realFetch(`${base}/api/house/update`)).json()).toMatchObject({ job: null }); // nothing started
  });

  it('starts one job; a second while it runs is a 409', async () => {
    let release!: () => void;
    h.gate = new Promise<void>((r) => { release = r; });
    const first = await post('/api/house/update/start', { password: 'correct horse' });
    expect(first.status).toBe(202);
    expect((await first.json()).job).toMatchObject({ kind: 'update', state: 'checking', from: '1.0.0' });
    const second = await post('/api/house/update/start', { password: 'correct horse' });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('running');
    const rb = await post('/api/house/update/rollback', { password: 'correct horse' });
    expect(rb.status).toBe(409);
    expect((await rb.json()).error).toBe('running');
    release();
    await _jobDone();
    const status = await (await realFetch(`${base}/api/house/update`)).json();
    expect(status.job).toMatchObject({ state: 'done', error: null });
    expect(status.job.log.some((l: { line: string }) => /already have it/.test(l.line))).toBe(true);
  });

  it('is refused while a turn is running', async () => {
    h.busy = true;
    const res = await post('/api/house/update/start', { password: 'correct horse' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('turn_running');
  });
});

describe('POST /api/house/update/rollback', () => {
  it('needs the password and a rollback copy', async () => {
    expect((await post('/api/house/update/rollback', { password: 'nope' })).status).toBe(401);
    const none = await post('/api/house/update/rollback', { password: 'correct horse' });
    expect(none.status).toBe(409);
    expect((await none.json()).error).toBe('no_rollback');
  });

  it('restores the copy and, with no restart wired, says the app must be restarted', async () => {
    put(root, 'packages/backend/dist/server.js', 'old');
    makeRollbackCopy({ root, dataDir: data, version: '0.9.0', mode: 'tarball', branch: 'main' });
    put(root, 'packages/backend/dist/server.js', 'new');
    put(root, 'package.json', pkg('1.0.0'));
    expect((await (await realFetch(`${base}/api/house/update`)).json()).rollback).toMatchObject({ available: true, version: '0.9.0' });
    const res = await post('/api/house/update/rollback', { password: 'correct horse' });
    expect(res.status).toBe(202);
    expect((await res.json()).job).toMatchObject({ kind: 'rollback' });
    await _jobDone();
    expect(readFileSync(join(root, 'packages/backend/dist/server.js'), 'utf-8')).toBe('old');
    const status = await (await realFetch(`${base}/api/house/update`)).json();
    expect(status.job).toMatchObject({ state: 'rolled_back', to: '0.9.0', restart_pending: true });
    expect(status.rollback.available).toBe(false);
  });
});

describe('house-only paths', () => {
  it('a companion-prefixed path is a 404, and so is the internal token', async () => {
    for (const path of ['/c/ada/api/house/update', '/c/ada/api/house/update/start', '/c/ada/api/house/update/rollback']) {
      const res = path.endsWith('update') ? await realFetch(`${base}${path}`) : await post(path, { password: 'correct horse' });
      expect(res.status, path).toBe(404);
    }
    expect((await post('/api/house/update/start', { password: 'correct horse' }, { 'x-internal-token': 'anything' })).status).toBe(404);
    expect((await realFetch(`${base}/api/house/update`, { headers: { 'x-internal-token': 'anything' } })).status).toBe(404);
    expect(await (await realFetch(`${base}/api/house/update`)).json()).toMatchObject({ job: null }); // and nothing started
  });

  it('household mode lets the unprefixed path through with no companion', () => {
    expect(isHouseRoute('/api/house/update')).toBe(true);
    expect(isHouseRoute('/api/house/update/start')).toBe(true);
    expect(isHouseRoute('/api/house')).toBe(false);
    expect(isHouseRoute('/api/housekeeping')).toBe(false);
  });
});
