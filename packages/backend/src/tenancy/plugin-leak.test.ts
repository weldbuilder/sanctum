// A plugin is operator-trusted code in the shared process. It is told the tenant id and nothing else: nothing on app.locals names a runtime,
// and in tenant mode a plugin root must be operator-placed (<tenant>/plugins, never inside anything the companion can write).
// (Reading another tenant's folder with fs cannot be stopped in-process; docs/PLUGINS.md says so, and this test does not pretend otherwise.)
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, join } from 'node:path';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PROJECT_ROOT, getSanctumConfig } from '../config.js';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { buildTenantPluginMounts } from './plugin-mount.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { authMiddleware, loginHandler } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';
import { appWriteGate } from '../middleware/app-write.js';
import { writePluginsEnabled } from '../services/plugin-config.js';
import { loadPlugins, setShippedRootForTests } from '../services/plugins.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const A = 'ada.example.net';
const B = 'bea.example.net';
let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let cookieA = '';
let cookieB = '';
let warns: string[] = [];
let shipped = '';

const manifest = JSON.stringify({ id: 'leak', name: 'Leak', version: '0.0.1', harness: ['dsh'], routes: 'routes.mjs', tenant_aware: true, dsh: { rows: [{ id: 'r', name: 'some-package' }], runs: ['turn'] } });
const routes = `export default (api) => { const r = api.Router(); r.get('/x', (req, res) => res.json({
  localsTenants: req.app.locals.tenants === undefined ? 'undefined' : 'present',
  localsKeys: Object.keys(req.app.locals).filter((k) => k !== 'agentService' && k !== 'orchestrator' && k !== 'voiceService' && k !== 'pushService' && k !== 'discordService' && k !== 'telegramService'),
  tenantKeys: Object.keys(req.tenant),
  tenantId: req.tenant.id,
  appPassword: process.env.APP_PASSWORD === undefined ? 'undefined' : 'present',
})); return r; };\n`;
const putPlugin = (dir: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'sanctum.plugin.json'), manifest); writeFileSync(join(dir, 'routes.mjs'), routes); };

function call(method: string, path: string, host: string, cookie?: string, json?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { host };
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
const login = async (host: string, password: string) => ((await call('POST', '/api/auth/login', host, undefined, { password })).headers['set-cookie']?.[0] ?? '').split(';')[0];

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  shipped = mkdtempSync(join(tmpdir(), 'sanctum-shipped-'));
  setShippedRootForTests(shipped);
  const root = makeTenantsDir({
    // ada puts the plugin root inside her home, which her companion can write: refused.
    ada: { yaml: `hosts: [${A}]\nplugins:\n  dir: home/plugins\n  enabled: [leak]\n`, env: 'APP_PASSWORD=pw-ada\n' },
    // bea uses the one allowed place, <tenant>/plugins, a sibling of home/.
    bea: { yaml: `hosts: [${B}]\nplugins:\n  dir: plugins\n  enabled: [leak]\n`, env: 'APP_PASSWORD=pw-bea\n' },
  });
  putPlugin(join(root, 'ada', 'home', 'plugins', 'leak'));
  putPlugin(join(root, 'bea', 'plugins', 'leak'));
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (proc as unknown as { tenants: unknown }).tenants = { dir: root };
  registerProcessConfig(() => proc);
  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc));
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
  vi.restoreAllMocks();
});

describe('a plugin in tenant mode', () => {
  it('finds nothing named tenants (or any runtime) on req.app.locals', async () => {
    const r = await call('GET', '/api/plugins/leak/x', B, cookieB);
    expect(r.status).toBe(200);
    expect(r.json.localsTenants).toBe('undefined');
    expect(r.json.localsKeys).not.toContain('tenants');
  });

  it('sees req.tenant = { id } and nothing from the process environment, from <tenant>/plugins', async () => {
    const r = await call('GET', '/api/plugins/leak/x', B, cookieB);
    expect(r.json.tenantKeys).toEqual(['id']);
    expect(r.json.tenantId).toBe('bea');
    expect(r.json.appPassword).toBe('undefined');
  });

  it("a plugin root inside the tenant's own home is refused with one warning per tenant, and loads nothing", async () => {
    const r = await call('GET', '/api/plugins/leak/x', A, cookieA);
    expect(r.status).toBe(404);
    const list = await call('GET', '/api/plugins', A, cookieA);
    expect(list.json.plugins.filter((p: { error: string | null }) => p.error === null)).toEqual([]);
    expect(runInTenant(runtimes.get('ada')!, () => loadPlugins()).map((p) => p.id)).toEqual([]);
    expect(runtimes.has('ada')).toBe(true); // refused root, tenant not skipped
    expect(warns.filter((w) => w.includes('plugins.dir') && w.includes('refused'))).toHaveLength(1);
  });

  it("the shipped root of the repo is never written to by the tests", () => {
    expect(readdirSync(join(PROJECT_ROOT, 'plugins')).sort()).toEqual(['hello']);
  });
});
