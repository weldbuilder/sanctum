// Round 3 follow-up: every tenant write of tenant.yaml (and the other files a route owns) checks that the tenant's own files are still its own, then writes by
// temp-and-rename. A tenant.yaml that became a link (or hard link) to the app's sanctum.yaml after boot is refused with 400 by PUT /api/config/raw, the plugins
// enabled toggle and the wake-prompt editor, and the app's sanctum.yaml is byte-identical. Real express and auth; no provider key, no model run.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { buildTenantPluginMounts } from './plugin-mount.js';
import { processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { authMiddleware, loginHandler } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';
import { appWriteGate } from '../middleware/app-write.js';
import { writePluginsEnabled } from '../services/plugin-config.js';
import { getSanctumConfig } from '../config.js';
import { setShippedRootForTests } from '../services/plugins.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const posix = process.platform !== 'win32';
const SANCTUM = 'identity:\n  timezone: "UTC"\nauth:\n  password: "process-secret"\n';
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
const IDS = ['clean', 'symlinked', 'hardlinked'];

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  top = mkdtempSync(join(tmpdir(), 'sanctum-own-files-routes-'));
  shipped = join(top, 'shipped'); mkdirSync(shipped); setShippedRootForTests(shipped);
  const tenants = join(top, 'tenants');
  for (const id of IDS) { mkdirSync(join(tenants, id), { recursive: true }); writeFileSync(join(tenants, id, 'tenant.yaml'), safeTenantYaml(`hosts: [${id}.example.net]\n`)); writeFileSync(join(tenants, id, '.env'), `APP_PASSWORD=pw-${id}\n`); }
  writeFileSync(join(top, 'sanctum.yaml'), SANCTUM);
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
  app.use('/api/plugins', buildTenantPluginMounts(runtimes.values(), () => ({
    auth: authMiddleware, internalOnly, writeGate: appWriteGate,
    api: { get config() { return getSanctumConfig(); }, log: () => {} },
    setEnabled: writePluginsEnabled,
  })));
  app.use('/api', apiRoutes);
  app.use(globalErrorHandler);
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
  for (const id of IDS) cookies[id] = (await call('POST', '/api/auth/login', id, { password: `pw-${id}` })).cookie;
  // Planted after boot, once everyone has signed in.
  const yaml = (id: string) => join(tenants, id, 'tenant.yaml');
  rmSync(yaml('symlinked')); rmSync(yaml('hardlinked'));
  try { symlinkSync(join(top, 'sanctum.yaml'), yaml('symlinked'), 'file'); } catch { /* platform refuses links */ }
  if (posix) linkSync(join(top, 'sanctum.yaml'), yaml('hardlinked')); else writeFileSync(yaml('hardlinked'), 'hosts: [hardlinked.example.net]\n');
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null); setShippedRootForTests(null);
  rmSync(top, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const linked = (id: string): boolean => (id === 'hardlinked' ? posix : readFileSync(join(top, 'tenants', id, 'tenant.yaml'), 'utf8') === SANCTUM);
describe.each(['symlinked', 'hardlinked'])('tenant.yaml is %s to the app\'s sanctum.yaml after boot', (id) => {
  const writes: [string, string, () => unknown][] = [
    ['PUT /api/config/raw', '/api/config/raw', () => ({ content: 'hosts: [x.example.net]\n' })],
    ['PUT /api/plugins/enabled', '/api/plugins/enabled', () => ({ enabled: [] })],
    ['PUT /api/orchestrator/wake-types/x', '/api/orchestrator/wake-types/x', () => ({ content: 'hello' })],
  ];
  it.each(writes)('%s answers 400 with the boot sentence and app/sanctum.yaml is byte-identical', async (_n, path, body) => {
    if (!linked(id)) return; // a platform that refuses the link
    const r = await call('PUT', path, id, body());
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/tenant\.yaml in the tenant folder (is a link|has more than one hard link)/);
    expect(readFileSync(join(top, 'sanctum.yaml'), 'utf8')).toBe(SANCTUM);
    expect(readdirSync(join(top, 'tenants', id)).filter((n) => n.includes('.tmp-') || n.includes('.bak'))).toEqual([]);
  });
});

describe('a clean tenant still saves', () => {
  it('PUT /api/config/raw and the plugins toggle write tenant.yaml by rename: the same content lands, no temp file is left, the app file is untouched', async () => {
    const file = join(top, 'tenants', 'clean', 'tenant.yaml');
    const r = await call('PUT', '/api/config/raw', 'clean', { content: 'hosts: [clean.example.net]\n# edited\n' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('hosts: [clean.example.net]\n# edited\n');
    const p = await call('PUT', '/api/plugins/enabled', 'clean', { enabled: [] });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(readdirSync(join(top, 'tenants', 'clean')).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(readFileSync(join(top, 'sanctum.yaml'), 'utf8')).toBe(SANCTUM);
  });
});
