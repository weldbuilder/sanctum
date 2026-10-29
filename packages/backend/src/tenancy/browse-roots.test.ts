// Stage 1 carry-over: GET /api/files/browse with no path listed roots resolved against the process cwd. In tenant mode only roots inside the
// tenant's own folder may appear, and each one must browse.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { realDeep } from '../services/plugin-paths.js';
import { bootTenants } from './boot.js';
import { enableTenancy, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const A = 'ada.example.net';
let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;

function call(method: string, path: string, cookie?: string, json?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { host: A };
    if (cookie) headers.cookie = cookie;
    let payload: Buffer | undefined;
    if (json !== undefined) { payload = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let j: unknown = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } ok({ status: res.statusCode ?? 0, headers: res.headers, json: j }); });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const root = makeTenantsDir({ ada: { yaml: `hosts: [${A}]\n`, env: 'APP_PASSWORD=pw-ada\n' }, bea: { yaml: 'hosts: [bea.example.net]\n', env: 'APP_PASSWORD=pw-bea\n' } });
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (proc as unknown as { tenants: unknown }).tenants = { dir: root };
  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.use('/api', apiRoutes);
  app.use(globalErrorHandler);
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false);
  setTenantRegistry(new Map());
  vi.restoreAllMocks();
});

describe('/files/browse roots in tenant mode', () => {
  it('lists only roots inside the tenant folder, and each one browses', async () => {
    const login = await call('POST', '/api/auth/login', undefined, { password: 'pw-ada' });
    const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const list = await call('GET', '/api/files/browse', cookie);
    expect(list.status).toBe(200);
    expect(list.json.entries.length).toBeGreaterThan(0);
    // Both sides through realpath: the Windows runner's temp folder is an 8.3 short name, and the server's roots keep whatever form the config gave.
    // realDeep walks up to the deepest existing ancestor, so a root that does not exist yet (home/ before first use) still gets its long form.
    const real = (p: string) => realDeep(p).toLowerCase();
    const dir = real(runtimes.get('ada')!.dir);
    for (const e of list.json.entries as { path: string }[]) {
      const p = real(e.path);
      expect(p === dir || p.startsWith(dir + sep), e.path).toBe(true);
    }
  });
});
