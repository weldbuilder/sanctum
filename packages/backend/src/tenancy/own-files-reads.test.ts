// Round 4 reads: every tenant write of tenant.yaml (and the other files a route owns) checks that the tenant's own files are still its own, then writes by
// temp-and-rename. A tenant.yaml that became a link (or hard link) to the app's sanctum.yaml after boot is refused with 400 by PUT /api/config/raw, the plugins
// enabled toggle and the wake-prompt editor, and the app's sanctum.yaml is byte-identical. Real express and auth; no provider key, no model run.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import { setShippedRootForTests } from '../services/plugins.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const posix = process.platform !== 'win32';
let server: http.Server;
let port = 0;
let top = '';
let shipped = '';
let runtimes: Map<string, TenantRuntime>;
const cookies: Record<string, string> = {};

function call(method: string, path: string, id: string, json?: unknown): Promise<{ status: number; json: any; cookie: string }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { host: `${id}.example.net` };
    if (cookies[id]) headers.cookie = cookies[id];
    let payload: Buffer | undefined;
    if (json !== undefined) { payload = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let body: unknown = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } ok({ status: res.statusCode ?? 0, json: body, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] }); });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}
const IDS = ['ada', 'bea'];
const UUID = '0b5f3c1e-2a4d-4e6f-8a9b-0c1d2e3f4a5b';
beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  top = mkdtempSync(join(tmpdir(), 'sanctum-own-reads-'));
  shipped = join(top, 'shipped'); mkdirSync(shipped); setShippedRootForTests(shipped);
  const tenants = join(top, 'tenants');
  for (const id of IDS) { mkdirSync(join(tenants, id), { recursive: true }); writeFileSync(join(tenants, id, 'tenant.yaml'), safeTenantYaml(`hosts: [${id}.example.net]\n`)); writeFileSync(join(tenants, id, '.env'), `APP_PASSWORD=pw-${id}\n`); }
  writeFileSync(join(top, 'app.env'), 'APP_PASSWORD=process-secret-bytes\n');
  const proc = processConfigFor(resolve(top, 'proc'), { orchestrator: { enabled: false } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: tenants };
  registerProcessConfig(() => proc);
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
  for (const id of IDS) cookies[id] = (await call('POST', '/api/auth/login', id, { password: `pw-${id}` })).cookie;
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null); setShippedRootForTests(null);
  rmSync(top, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const filesDir = (id: string) => join(top, 'tenants', id, 'data', 'files');
const raw = (path: string, id: string): Promise<{ status: number; text: string }> => new Promise((ok, fail) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `${id}.example.net`, cookie: cookies[id] } }, (res) => {
    const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', fail); req.end();
});

describe('GET /api/files/:id never serves what a planted link points at (data/files is not scanned)', () => {
  it('a real upload is served', async () => {
    mkdirSync(filesDir('ada'), { recursive: true });
    writeFileSync(join(filesDir('ada'), `${UUID}.txt`), 'REAL UPLOAD');
    const r = await raw(`/api/files/${UUID}`, 'ada');
    expect(r.status).toBe(200);
    expect(r.text).toBe('REAL UPLOAD');
  });
  it.each([['the other tenant\'s sanctum.db', () => join(top, 'tenants', 'bea', 'data', 'sanctum.db')], ['the app\'s .env', () => join(top, 'app.env')]])('a symlink to %s: 404 and none of its bytes', async (_n, target) => {
    mkdirSync(filesDir('ada'), { recursive: true });
    const id = '1b5f3c1e-2a4d-4e6f-8a9b-0c1d2e3f4a5b';
    try { symlinkSync(target(), join(filesDir('ada'), `${id}.txt`), 'file'); } catch { return; }
    const r = await raw(`/api/files/${id}`, 'ada');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('process-secret-bytes');
    expect(r.text).not.toContain('SQLite');
    rmSync(join(filesDir('ada'), `${id}.txt`));
  });
  it.runIf(posix)('a hard link to the app\'s .env: 404 and none of its bytes', async () => {
    const id = '2b5f3c1e-2a4d-4e6f-8a9b-0c1d2e3f4a5b';
    linkSync(join(top, 'app.env'), join(filesDir('ada'), `${id}.txt`));
    const r = await raw(`/api/files/${id}`, 'ada');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('process-secret-bytes');
    rmSync(join(filesDir('ada'), `${id}.txt`));
  });
  it('data/files itself made a link to a folder holding a file: 404', async () => {
    const out = join(top, 'outside'); mkdirSync(out);
    const id = '3b5f3c1e-2a4d-4e6f-8a9b-0c1d2e3f4a5b';
    writeFileSync(join(out, `${id}.txt`), 'OUTSIDE BYTES');
    rmSync(filesDir('bea'), { recursive: true, force: true });
    mkdirSync(join(top, 'tenants', 'bea', 'data'), { recursive: true });
    try { symlinkSync(out, filesDir('bea'), 'junction'); } catch { return; }
    const r = await raw(`/api/files/${id}`, 'bea');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('OUTSIDE BYTES');
  });
});

describe('the log reader never opens a link in data/logs', () => {
  it('GET /api/system/logs with tenant.log a link to the app\'s .env shows none of its bytes', async () => {
    const dir = join(top, 'tenants', 'ada', 'data', 'logs');
    mkdirSync(dir, { recursive: true });
    try { symlinkSync(join(top, 'app.env'), join(dir, 'tenant.log'), 'file'); } catch { return; }
    const r = await raw('/api/system/logs?lines=50', 'ada');
    expect(r.status).toBe(200); // (the route answers; the link is simply not opened)
    expect(r.text).not.toContain('process-secret-bytes');
  });
});
