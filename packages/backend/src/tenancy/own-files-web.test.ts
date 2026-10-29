// Round 3, item 1 over HTTP: the first-run page's /api/setup/apply on a tenant whose own files became links (or hard links) after boot answers 400 with the
// boot sentence and writes nothing: the app's .env, its data/ and the link targets stay byte-identical. A clean tenant still saves (with a temp-and-rename write).
// Real express, real wizard; no provider key, no model run; `codex --version` faked.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { currentTenant, enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter } from './resolve.js';
import { processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import setupRoutes from '../routes/setup.js';
import { _resetSetupCode, ensureSetupCode } from '../services/setup-code.js';

vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawnSync: () => ({ status: 0 }) }));

const posix = process.platform !== 'win32';
const host = (id: string) => `${id}.example.net`;
let server: http.Server;
let port = 0;
let top = '';
let app = '';
let runtimes: Map<string, TenantRuntime>;
const codes: Record<string, string> = {};
const savedEnv = { APP_PASSWORD: process.env.APP_PASSWORD, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
const answers = { companionName: 'Bea', userName: 'Sam', provider: 'claude', anthropicKey: 'sk-ant-test-for-bea', password: 'tenant-bea-password' };

function post(id: string, path: string, json: unknown): Promise<{ status: number; json: any }> {
  return new Promise((ok, fail) => {
    const payload = Buffer.from(JSON.stringify(json));
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { host: host(id), 'x-setup-code': codes[id], 'content-type': 'application/json', 'content-length': String(payload.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let body: unknown = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } ok({ status: res.statusCode ?? 0, json: body }); });
    });
    req.on('error', fail);
    req.write(payload);
    req.end();
  });
}
const snapshot = (dir: string, out: Record<string, string> = {}): Record<string, string> => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { out[p] = 'dir'; snapshot(p, out); } else if (e.isFile()) out[p] = readFileSync(p).toString('hex'); else out[p] = 'link';
  }
  return out;
};

// One tenant per way of breaking, broken AFTER boot (a tenant that is broken at boot is skipped and never reached).
const BREAK: Record<string, { rel: string; apply: () => void }> = {
  envlink: { rel: '.env', apply: () => symlinkSync(join(app, '.env'), join(top, 'tenants', 'envlink', '.env'), 'file') },
  envhard: { rel: '.env', apply: () => linkSync(join(app, '.env'), join(top, 'tenants', 'envhard', '.env')) },
  yamllink: { rel: 'tenant.yaml', apply: () => { rmSync(join(top, 'tenants', 'yamllink', 'tenant.yaml')); symlinkSync(join(app, 'other.yaml'), join(top, 'tenants', 'yamllink', 'tenant.yaml'), 'file'); } },
  yamlhard: { rel: 'tenant.yaml', apply: () => { rmSync(join(top, 'tenants', 'yamlhard', 'tenant.yaml')); linkSync(join(app, 'other.yaml'), join(top, 'tenants', 'yamlhard', 'tenant.yaml')); } },
  datalink: { rel: 'data', apply: () => { rmSync(join(top, 'tenants', 'datalink', 'data'), { recursive: true, force: true }); symlinkSync(join(app, 'data'), join(top, 'tenants', 'datalink', 'data'), 'junction'); } },
  privlink: { rel: 'private', apply: () => symlinkSync(join(top, 'elsewhere'), join(top, 'tenants', 'privlink', 'private'), 'junction') },
};

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.APP_PASSWORD;
  delete process.env.ANTHROPIC_API_KEY;
  top = mkdtempSync(join(tmpdir(), 'sanctum-own-files-web-'));
  app = join(top, 'app');
  mkdirSync(join(app, 'data', 'identity'), { recursive: true });
  mkdirSync(join(top, 'elsewhere'));
  writeFileSync(join(app, '.env'), 'APP_PASSWORD=process-secret\nANTHROPIC_API_KEY=sk-process\n');
  writeFileSync(join(app, 'other.yaml'), 'hosts: [stolen.example.net]\n');
  writeFileSync(join(app, 'data', 'identity', 'ledger.jsonl'), '{"line":1}\n');
  const tenants = join(top, 'tenants');
  for (const id of ['clean', ...Object.keys(BREAK)]) { mkdirSync(join(tenants, id), { recursive: true }); writeFileSync(join(tenants, id, 'tenant.yaml'), safeTenantYaml(`hosts: [${host(id)}]\n`)); }
  const proc = processConfigFor(resolve(top, 'proc'));
  (proc as unknown as { tenants: unknown }).tenants = { dir: tenants };
  registerProcessConfig(() => proc);
  const server_ = express();
  server_.set('trust proxy', 1);
  runtimes = bootTenants(server_, safeTenancyProcess(proc));
  server_.use(tenantResolve);
  server_.use(express.json());
  server_.use(tenantEnter);
  server_.use('/api/setup', setupRoutes);
  server_.use(globalErrorHandler);
  await new Promise<void>((r) => { server = server_.listen(0, '127.0.0.1', () => r()); });
  port = (server.address() as AddressInfo).port;
  for (const rt of runtimes.values()) runInTenant(rt, () => { _resetSetupCode({ announce: (code) => { codes[currentTenant()!.id] = code; } }); ensureSetupCode(); });
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise((r) => server.close(r));
  for (const rt of runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false);
  registerProcessConfig(() => null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
  rmSync(top, { recursive: true, force: true });
});

describe('/api/setup/apply on a tenant whose own files became links', () => {
  it.each(Object.keys(BREAK))('%s: 400 with the boot sentence, nothing written, the app\'s files byte-identical', async (name) => {
    const { rel, apply } = BREAK[name];
    if ((name.endsWith('hard')) && !posix) return;
    try { apply(); } catch { return; } // a platform that refuses links: nothing to test
    const tdir = join(top, 'tenants', name);
    const before = { app: snapshot(app), elsewhere: snapshot(join(top, 'elsewhere')), names: readdirSync(tdir).sort(), yaml: readFileSync(join(tdir, 'tenant.yaml'), 'utf8') };
    const r = await post(name, '/api/setup/apply', { answers });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(JSON.stringify(r.json)).toContain(`${rel} in the tenant folder`);
    expect(snapshot(app)).toEqual(before.app);
    expect(snapshot(join(top, 'elsewhere'))).toEqual(before.elsewhere);
    expect(readdirSync(tdir).sort()).toEqual(before.names); // no backup, no temp file, nothing new beside the tenant's files
    expect(readFileSync(join(tdir, 'tenant.yaml'), 'utf8')).toBe(before.yaml);
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe('APP_PASSWORD=process-secret\nANTHROPIC_API_KEY=sk-process\n');
    expect(runtimes.get(name)!.config.auth.password).toBe('');
  });

  it('a clean tenant still saves: .env is 0600, replaced by rename (never a temp file left behind), and the app\'s files are untouched', async () => {
    const before = snapshot(app);
    const r = await post('clean', '/api/setup/apply', { answers });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const dir = join(top, 'tenants', 'clean');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('APP_PASSWORD=tenant-bea-password');
    if (posix) expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(snapshot(app)).toEqual(before);
  });
});
