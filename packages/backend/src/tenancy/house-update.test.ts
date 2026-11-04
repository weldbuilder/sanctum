// The update routes in household mode, with REAL tenants booted and the real update check (only GitHub is a stub): the unprefixed /api/house/update runs
// outside any companion, so nothing it reads may be per-tenant. (The route's own tests mock the check, which is how a NoTenantContext 500 got through.)
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { closeHouse } from './house.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { authMiddleware, loginHandler } from '../middleware/auth.js';
import houseUpdateRoutes from '../routes/house-update.js';
import { _resetUpdateCache } from '../services/update-check.js';
import { _setUpdaterEnv } from '../services/updater.js';
import { repoFromPackageJson } from '../config.js';

const HOUSE_PW = 'house-password-1';
let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let github: string[] = [];
const realFetch = globalThis.fetch;

function call(method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let payload: Buffer | undefined;
    if (opts.json !== undefined) { payload = Buffer.from(JSON.stringify(opts.json)); headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        ok({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}
const login = async () => (await call('POST', '/api/auth/login', { json: { password: HOUSE_PW } })).headers['set-cookie']?.[0]?.split(';')[0] ?? '';

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const root = makeTenantsDir({
    ada: { yaml: 'identity:\n  companion_name: Ada\n', env: '' },
    bea: { yaml: 'identity:\n  companion_name: Bea\n', env: '' },
  });
  const base = mkdtempSync(join(tmpdir(), 'sanctum-house-update-'));
  const proc = processConfigFor(resolve(base, 'process'), { server: { db_path: join(base, 'process', 'data', 'sanctum.db') } });
  proc.auth.password = HOUSE_PW;
  proc.updates.repo = repoFromPackageJson(); // (named by package.json only: the check follows origin if it differs)
  (proc as unknown as { tenants: unknown }).tenants = { dir: root, auth: 'household' };
  registerProcessConfig(() => proc);
  _setUpdaterEnv({ dataDir: () => join(base, 'process', 'data'), busy: () => false });
  // GitHub is the only stub: the raw package.json of whatever repository the check asks for says 9.9.9.
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (/raw\.githubusercontent\.com|api\.github\.com/.test(String(url))) { github.push(String(url)); return { ok: true, status: 200, text: async () => JSON.stringify({ version: '9.9.9' }) }; }
    return realFetch(url, init);
  });

  const app = express();
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.get('/api/auth/check-plain', authMiddleware, (_req, res) => res.json({ ok: true }));
  app.use('/api/house/update', houseUpdateRoutes);
  server = http.createServer(app);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  closeHouse();
  enableTenancy(false);
  setTenantRegistry(new Map());
  registerProcessConfig(() => null);
  _setUpdaterEnv(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/house/update with real tenants', () => {
  it('answers 200 with the status (not a 500 NoTenantContext): the check reads the process config, outside any companion', async () => {
    _resetUpdateCache();
    const cookie = await login();
    expect(cookie).toMatch(/^sanctum_session=/);
    const res = await call('GET', '/api/house/update?force=1', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ household: true, companions: 2, latest: '9.9.9', update_available: true, job: null, password_set: true, branch: 'main' });
    expect(res.json.error).toBeUndefined();
    expect(github.length).toBeGreaterThan(0);
  });

  it('needs the session, answers 404 under a companion prefix, and the two writes still want the password again', async () => {
    expect((await call('GET', '/api/house/update')).status).toBe(401);
    const cookie = await login();
    expect((await call('GET', '/c/ada/api/house/update', { headers: { cookie } })).status).toBe(404);
    const none = await call('POST', '/api/house/update/start', { headers: { cookie }, json: {} });
    expect(none.status).toBe(401);
    expect(none.json.error).toBe('password_required');
  });
});
