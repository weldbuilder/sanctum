// Plugins in tenant mode: the tenant is injected (row, token, req.tenant), the list, cache and enabled file are per tenant, a plugin that is not
// tenant_aware is refused with one warning, and one plugin module serves every tenant. Real express, real auth; no provider key.
// The two probe plugins live in a temp "shipped" root (setShippedRootForTests): the one root two tenants can share, and nothing is written into the repo.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import yaml from 'js-yaml';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PROJECT_ROOT } from '../config.js';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { buildTenantPluginMounts } from './plugin-mount.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { authMiddleware, loginHandler } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';
import { appWriteGate } from '../middleware/app-write.js';
import { writePluginsEnabled } from '../services/plugin-config.js';
import { getSanctumConfig } from '../config.js';
import { loadPlugins, pluginRows, rescanPlugins, setShippedRootForTests } from '../services/plugins.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const A = 'ada.example.net';
const B = 'bea.example.net';
const PROBE = 'zz-tenant-probe';
const PLAIN = 'zz-tenant-plain';
let shipped = '';
let probeDir = '';
let plainDir = '';

interface Reply { status: number; headers: http.IncomingHttpHeaders; json: any }
let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;
let cookieA = '';
let cookieB = '';
let warns: string[] = [];

function call(method: string, path: string, host: string, opts: { cookie?: string; json?: unknown } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { host };
    if (opts.cookie) headers.cookie = opts.cookie;
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
async function login(host: string, password: string): Promise<string> {
  const r = await call('POST', '/api/auth/login', host, { json: { password } });
  return (r.headers['set-cookie']?.[0] ?? '').split(';')[0];
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  shipped = mkdtempSync(join(tmpdir(), 'sanctum-shipped-'));
  setShippedRootForTests(shipped);
  probeDir = join(shipped, PROBE);
  plainDir = join(shipped, PLAIN);
  mkdirSync(join(probeDir), { recursive: true });
  writeFileSync(join(probeDir, 'sanctum.plugin.json'), JSON.stringify({
    id: PROBE, name: 'Probe', version: '0.0.1', harness: ['dsh'], routes: 'routes.mjs', tenant_aware: true,
    dsh: { rows: [{ id: 'r', name: 'some-package' }], runs: ['turn'] },
  }));
  writeFileSync(join(probeDir, 'routes.mjs'), `globalThis.__tenantProbeImports = (globalThis.__tenantProbeImports || 0) + 1;
export default (api) => { const r = api.Router(); r.get('/who', (req, res) => res.json({ tenant: req.tenant, keys: Object.keys(req.tenant), enabled: api.config.plugins.enabled })); return r; };\n`);
  mkdirSync(plainDir, { recursive: true });
  writeFileSync(join(plainDir, 'sanctum.plugin.json'), JSON.stringify({ id: PLAIN, name: 'Plain', version: '0.0.1', harness: ['dsh'], dsh: { rows: [{ id: 'r', name: 'some-package' }], runs: ['turn'] } }));
  (globalThis as Record<string, unknown>).__tenantProbeImports = 0;

  const root = makeTenantsDir({
    ada: { yaml: `hosts: [${A}]\nplugins:\n  enabled: [${PROBE}, ${PLAIN}]\n`, env: 'APP_PASSWORD=pw-ada\n' },
    bea: { yaml: `hosts: [${B}]\nplugins:\n  enabled: [${PROBE}]\n`, env: 'APP_PASSWORD=pw-bea\n' },
  });
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (proc as unknown as { tenants: unknown }).tenants = { dir: root };
  registerProcessConfig(() => proc); // what config.ts does at load; the tenant.yaml dry run reads it
  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.use('/api/plugins', buildTenantPluginMounts(runtimes.values(), () => ({
    auth: authMiddleware, internalOnly, writeGate: appWriteGate,
    api: { get config() { return getSanctumConfig(); }, log: () => {} },
    setEnabled: writePluginsEnabled,
  })));
  app.use(globalErrorHandler);
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
  cookieA = await login(A, 'pw-ada');
  cookieB = await login(B, 'pw-bea');
});

afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false);
  setTenantRegistry(new Map());
  registerProcessConfig(() => null);
  setShippedRootForTests(null);
  rmSync(shipped, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__tenantProbeImports;
  vi.restoreAllMocks();
});

describe('plugins per tenant', () => {
  it('refuses a plugin that is not tenant_aware, with one warning per tenant naming it, and lists the tenant_aware one', async () => {
    const first = await call('GET', '/api/plugins', A, { cookie: cookieA });
    expect(first.status).toBe(200);
    await call('GET', '/api/plugins', A, { cookie: cookieA });
    const ids = first.json.plugins.map((p: { id: string }) => p.id);
    expect(ids).toContain(PROBE);
    // Not loaded: the list can only report it as named in plugins.enabled and not found.
    expect(first.json.plugins.find((p: { id: string }) => p.id === PLAIN).error).toBe('not found on disk');
    expect(runInTenant(ada, () => loadPlugins()).map((p) => p.id)).not.toContain(PLAIN);
    // Boot and two requests each scanned: one line per tenant (ada and bea), not one per scan.
    expect(warns.filter((w) => w.includes(PLAIN) && w.includes('not tenant_aware'))).toHaveLength(2);
  });

  it("each tenant's list shows its own enabled state: A has the probe on, B's request gets B's list", async () => {
    await call('PUT', '/api/plugins/enabled', B, { cookie: cookieB, json: { enabled: [] } });
    const a = await call('GET', '/api/plugins', A, { cookie: cookieA });
    const b = await call('GET', '/api/plugins', B, { cookie: cookieB });
    expect(a.json.plugins.find((p: { id: string }) => p.id === PROBE).enabled).toBe(true);
    expect(b.json.plugins.find((p: { id: string }) => p.id === PROBE).enabled).toBe(false);
    expect([...runInTenant(ada, () => getSanctumConfig().plugins.enabled)]).toContain(PROBE);
    expect(runInTenant(bea, () => getSanctumConfig().plugins.enabled)).toEqual([]);
    await call('PUT', '/api/plugins/enabled', B, { cookie: cookieB, json: { enabled: [PROBE] } });
  });

  it("a plugin row carries tenant 'ada' and ada's token, and bea's carries bea's", () => {
    const row = (rt: TenantRuntime) => runInTenant(rt, () => pluginRows({ harness: 'dsh', runKind: 'turn', threadId: 't1' }));
    const ra = row(ada).find((r) => r.id === `plugin:${PROBE}:r`);
    const rb = row(bea).find((r) => r.id === `plugin:${PROBE}:r`);
    expect(ra.config.sanctum.tenant).toBe('ada');
    expect(ra.config.sanctum.token).toBe(ada.token);
    expect(rb.config.sanctum.tenant).toBe('bea');
    expect(rb.config.sanctum.token).toBe(bea.token);
    expect(ada.token).not.toBe(bea.token);
  });

  it("the scan cache is per tenant: a rescan in A does not reset B's", () => {
    const b1 = runInTenant(bea, () => loadPlugins());
    const a1 = runInTenant(ada, () => loadPlugins());
    expect(runInTenant(ada, () => loadPlugins())).toBe(a1);
    runInTenant(ada, () => rescanPlugins());
    expect(runInTenant(bea, () => loadPlugins())).toBe(b1);
    expect(runInTenant(ada, () => loadPlugins())).not.toBe(a1);
  });

  it("PUT /enabled writes A's tenant.yaml only; B's file is byte-equal before and after", async () => {
    const fileA = join(ada.dir, 'tenant.yaml');
    const fileB = join(bea.dir, 'tenant.yaml');
    const beforeB = readFileSync(fileB);
    const beforeA = readFileSync(fileA, 'utf8');
    const put = await call('PUT', '/api/plugins/enabled', A, { cookie: cookieA, json: { enabled: [PROBE] } });
    expect(put.json).toMatchObject({ ok: true });
    expect(readFileSync(fileB)).toEqual(beforeB);
    const afterA = readFileSync(fileA, 'utf8');
    expect(afterA).not.toBe(beforeA);
    expect(afterA).toContain(PROBE);
    expect(afterA).not.toContain(PLAIN);
    expect(afterA).toContain(A);
    expect(runInTenant(ada, () => getSanctumConfig().plugins.enabled)).toEqual([PROBE]);
  });

  it('a plugin route sees req.tenant = { id } and nothing else, and the config of the tenant asking', async () => {
    const a = await call('GET', `/api/plugins/${PROBE}/who`, A, { cookie: cookieA });
    const b = await call('GET', `/api/plugins/${PROBE}/who`, B, { cookie: cookieB });
    expect(a.status).toBe(200);
    expect(a.json.tenant).toEqual({ id: 'ada' });
    expect(a.json.keys).toEqual(['id']);
    expect(b.json.tenant).toEqual({ id: 'bea' });
    expect(a.json.enabled).toEqual([PROBE]);
    expect(b.json.enabled).toEqual([PROBE]);
  });

  it("one routes.mjs module serves both tenants: it was imported once", async () => {
    await call('GET', `/api/plugins/${PROBE}/who`, A, { cookie: cookieA });
    await call('GET', `/api/plugins/${PROBE}/who`, B, { cookie: cookieB });
    expect((globalThis as Record<string, unknown>).__tenantProbeImports).toBe(1);
  });
});

describe('a refused PUT /enabled', () => {
  it('answers 400 with a reason that names no absolute path, and logs no stack', async () => {
    const file = join(ada.dir, 'tenant.yaml');
    const good = readFileSync(file, 'utf8');
    // The file was edited by hand after boot to something that would stop the tenant starting.
    const edited = yaml.load(good) as { agent?: Record<string, unknown> };
    writeFileSync(file, yaml.dump({ ...edited, agent: { ...edited.agent, cwd: join(tmpdir(), 'elsewhere-entirely') } }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const put = await call('PUT', '/api/plugins/enabled', A, { cookie: cookieA, json: { enabled: [PROBE] } });
      expect(put.status).toBe(400);
      expect(put.json.error).toBe('config_refused');
      expect(JSON.stringify(put.json)).not.toMatch(/elsewhere-entirely|[\\/]tmp|[A-Za-z]:\\/);
      expect(err).not.toHaveBeenCalled();
    } finally { err.mockRestore(); writeFileSync(file, good); }
  });

  it('the repo plugins/ folder holds only what ships', () => {
    expect(readdirSync(join(PROJECT_ROOT, 'plugins')).sort()).toEqual(['hello']);
  });
});
