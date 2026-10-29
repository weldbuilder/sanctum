// M5 (round 4): the mutating-request scan runs at app level (server.ts), after tenantEnter and before any router, so it covers the routers the api router's own middleware
// never saw: /api/plugins, /api/identity, /api/setup, /api/google, /mcp/cc, /mcp/workspace. It is the SECOND net (the write layer is the wall): a bounded quick check, answered only to
// a caller who holds the tenant's own login or token. Real express, auth and tenant resolution; no provider, no model run.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { mountTenantRefusals, tenantMutationScan } from './guard.js';
import { tenantWriteRefusal } from './own-files.js';
import { processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';

let server: http.Server;
let port = 0;
let top = '';
let runtimes: Map<string, TenantRuntime>;
let cookie = '';
let linked = false;

function call(method: string, path: string, opts: { cookie?: boolean; token?: string; json?: unknown } = {}): Promise<{ status: number; json: any; cookie: string }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { host: 'ada.example.net' };
    if (opts.cookie && cookie) headers.cookie = cookie;
    if (opts.token) headers['x-internal-token'] = opts.token;
    let payload: Buffer | undefined;
    if (opts.json !== undefined) { payload = Buffer.from(JSON.stringify(opts.json)); headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
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

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  top = mkdtempSync(join(tmpdir(), 'sanctum-own-net-'));
  const tenants = join(top, 'tenants');
  mkdirSync(join(tenants, 'ada'), { recursive: true });
  writeFileSync(join(tenants, 'ada', 'tenant.yaml'), safeTenantYaml('hosts: [ada.example.net]\n'));
  writeFileSync(join(tenants, 'ada', '.env'), 'APP_PASSWORD=pw-ada\n');
  mkdirSync(join(top, 'outside'));
  const proc = processConfigFor(resolve(top, 'proc'), { orchestrator: { enabled: false } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: tenants };
  registerProcessConfig(() => proc);
  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  mountTenantRefusals(app);
  app.use(['/api', '/mcp'], tenantMutationScan); // exactly where server.ts mounts it
  app.post('/api/auth/login', loginHandler);
  // Routers outside the api router, as server.ts mounts them (each names its own gate; here they just answer).
  for (const p of ['/api/plugins/x', '/api/identity/x', '/api/setup/x', '/api/google/x', '/api/internal/identity/x']) app.all(p, (_req, res) => { res.json({ reached: p }); });
  app.all('/mcp/cc', internalOnly, (_req, res) => { res.json({ reached: '/mcp/cc' }); });
  app.all('/mcp/workspace', internalOnly, (_req, res) => { res.json({ reached: '/mcp/workspace' }); });
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
  cookie = (await call('POST', '/api/auth/login', { json: { password: 'pw-ada' } })).cookie;
  // Planted after boot and after the login: data/plugins becomes a link to a folder outside the tenant.
  try { symlinkSync(join(top, 'outside'), join(tenants, 'ada', 'data', 'plugins'), 'junction'); linked = true; } catch { /* the platform refuses links */ }
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null);
  rmSync(top, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SENTENCE = /data\/plugins in the tenant folder is a link/;
const ROUTES = ['/api/plugins/x', '/api/identity/x', '/api/setup/x', '/api/google/x', '/api/internal/identity/x'];
describe.each(['POST', 'PUT', 'PATCH', 'DELETE'])('a %s once data/plugins became a link', (method) => {
  it.each(ROUTES)('%s: 400 with the boot sentence for the tenant\'s own session, before the router answers', async (path) => {
    if (!linked) return;
    const r = await call(method, path, { cookie: true, json: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.error).toMatch(SENTENCE);
    expect(r.json.reached).toBeUndefined();
  });
  it('/mcp/cc and /mcp/workspace: 400 for the tenant\'s internal token', async () => {
    if (!linked) return;
    const token = runtimes.get('ada')!.token;
    for (const path of ['/mcp/cc', '/mcp/workspace']) {
      const r = await call(method, path, { token, json: {} });
      expect(r.status, `${method} ${path}`).toBe(400);
      expect(r.json.error).toMatch(SENTENCE);
    }
  });
});

describe('what the net leaves alone', () => {
  it('reads are not scanned (GET answers from the router)', async () => {
    const r = await call('GET', '/api/identity/x', { cookie: true });
    expect(r.status).toBe(200);
    expect(r.json.reached).toBe('/api/identity/x');
  });
  it('an anonymous caller learns nothing about the folder: the router answers as it would (its own gate, here none)', async () => {
    const r = await call('POST', '/api/identity/x', { json: {} });
    expect(r.status).toBe(200);
    const m = await call('POST', '/mcp/cc', { json: {} });
    expect(m.status).toBe(404); // internalOnly's own answer
  });
  it('the check is bounded: it looks at the first level of data/ and private/, and a deep link is the write layer\'s to refuse', async () => {
    if (!linked) return;
    const rt = runtimes.get('ada')!;
    rmSync(join(rt.dir, 'data', 'plugins'), { force: true, recursive: false });
    mkdirSync(join(rt.dir, 'data', 'a', 'b', 'c'), { recursive: true });
    symlinkSync(join(top, 'outside'), join(rt.dir, 'data', 'a', 'b', 'c', 'deep'), 'junction');
    const r = await call('POST', '/api/identity/x', { cookie: true, json: {} });
    expect(r.status).toBe(200);
  });
  it('it is cheap: well under a millisecond or two per request on a typical folder (the full scan is for boot and reload)', () => {
    const rt = runtimes.get('ada')!;
    const t0 = process.hrtime.bigint();
    runInTenant(rt, () => { for (let i = 0; i < 200; i += 1) tenantWriteRefusal(); });
    const per = Number(process.hrtime.bigint() - t0) / 200 / 1e6;
    expect(per).toBeLessThan(10); // (a generous bound: measured at well under 1 ms on a quiet machine)
  });
});

describe('server.ts mounts the net where this test does', () => {
  it('app level, in tenant mode, after tenantEnter and before the first router (/api/plugins)', () => {
    const src = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    const enter = src.indexOf('app.use(tenantEnter)');
    const scan = src.indexOf("app.use(['/api', '/mcp'], tenantMutationScan)");
    const firstRouter = src.indexOf("app.use('/api/plugins'");
    expect(enter).toBeGreaterThan(0);
    expect(scan).toBeGreaterThan(enter);
    expect(firstRouter).toBeGreaterThan(scan);
    expect(src.slice(src.lastIndexOf('\n', scan), scan)).toMatch(/TENANT_MODE/);
  });
});
