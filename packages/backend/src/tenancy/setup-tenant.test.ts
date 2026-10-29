// The first-run page and Settings per tenant: /api/setup works on the folder of the tenant the host resolved to and no other, the setup code is
// each tenant's own, /apply never touches process.env or another tenant's folder, rt.reload() re-validates, and GET /api/tenant answers for the
// tenant asking. Real express, real auth, real wizard; no provider key, no model run, `codex --version` faked.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import crypto from 'crypto';
import { announceTenantSetupCodes, bootTenants } from './boot.js';
import { currentTenant, enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { installTenantConsole, tenantLogFile } from './console.js';
import { tenantInfoRouter } from './info.js';
import { loginHandler } from '../middleware/auth.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import setupRoutes from '../routes/setup.js';
import { _resetSetupCode, ensureSetupCode } from '../services/setup-code.js';
import { scanStats } from './own-files.js';

vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawnSync: () => ({ status: 0 }) }));

const A = 'ada.example.net';
const B = 'bea.example.net';
interface Reply { status: number; headers: http.IncomingHttpHeaders; json: any }

let server: http.Server;
let port = 0;
let root = '';
let ada: TenantRuntime;
let bea: TenantRuntime;
const codes: Record<string, string> = {};
const savedEnv = { APP_PASSWORD: process.env.APP_PASSWORD, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

function call(method: string, path: string, host: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { host, ...(opts.headers ?? {}) };
    let payload: Buffer | undefined;
    if (opts.json !== undefined) { payload = Buffer.from(JSON.stringify(opts.json)); headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json: unknown = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } ok({ status: res.statusCode ?? 0, headers: res.headers, json }); });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}
const withCode = (tenant: string) => ({ 'x-setup-code': codes[tenant] });
const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name)).sort();

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.APP_PASSWORD;
  delete process.env.ANTHROPIC_API_KEY;
  root = makeTenantsDir({ ada: { yaml: `hosts: [${A}]\n` }, bea: { yaml: `hosts: [${B}]\n` } });
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (proc as unknown as { tenants: unknown }).tenants = { dir: root };
  registerProcessConfig(() => proc);
  const app = express();
  app.set('trust proxy', 1);
  const runtimes = bootTenants(app, safeTenancyProcess(proc));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.use('/api/setup', setupRoutes);
  app.use('/api/tenant', tenantInfoRouter);
  app.use(globalErrorHandler);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  port = (server.address() as AddressInfo).port;
  // Each tenant's own code, captured as it is announced inside that tenant.
  for (const rt of [ada, bea]) runInTenant(rt, () => { _resetSetupCode({ announce: (code) => { codes[currentTenant()!.id] = code; } }); ensureSetupCode(); });
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise((r) => server.close(r));
  for (const rt of [ada, bea]) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false);
  registerProcessConfig(() => null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
});

describe('the setup code is each tenant\'s own', () => {
  it('has a different code per tenant; A\'s code opens A and is refused on B\'s host, and the other way round', async () => {
    expect(codes.ada).toMatch(/^[0-9a-f]{12}$/);
    expect(codes.bea).toMatch(/^[0-9a-f]{12}$/);
    expect(codes.ada).not.toBe(codes.bea);
    expect((await call('GET', '/api/setup/status', A)).json).toEqual({ password_set: false, needs_code: true });
    expect((await call('GET', '/api/setup/plan', A)).status).toBe(401);
    expect((await call('GET', '/api/setup/plan', A, { headers: withCode('ada') })).status).toBe(200);
    expect((await call('GET', '/api/setup/plan', B, { headers: withCode('ada') })).status).toBe(401);
    expect((await call('GET', '/api/setup/plan', A, { headers: withCode('bea') })).status).toBe(401);
    expect((await call('GET', '/api/setup/plan', B, { headers: withCode('bea') })).status).toBe(200);
  });

  it('the plan is tenant-scoped: its home, private folder and Codex config are inside the tenant, and it asks no phone question', async () => {
    const plan = (await call('GET', '/api/setup/plan', A, { headers: withCode('ada') })).json;
    const home = plan.steps.find((s: { id: string }) => s.id === 'home');
    expect(home.default).toBe(join(ada.dir, 'home'));
    expect(plan.steps.map((s: { id: string }) => s.id)).not.toContain('phoneOrigin');
    expect(plan.steps.map((s: { id: string }) => s.id)).not.toContain('tenantHost'); // a tenant cannot change its own hosts from inside
    expect(JSON.stringify(plan)).not.toContain(bea.dir);
  });

  it.runIf(process.platform !== 'win32')('a pipe at a tenant\'s tenant.yaml (a writer attached): GET /api/setup/plan answers 400 and never opens it, the other tenant\'s plan is unaffected', async () => {
    const file = join(bea.dir, 'tenant.yaml');
    const keep = readFileSync(file, 'utf8');
    rmSync(file);
    execFileSync('mkfifo', [file]);
    const writer: ChildProcess = spawn('sh', ['-c', 'printf "%s" "$0" > "$1"', 'hosts: [evil.example.net]\n', file], { stdio: 'ignore' });
    try {
      const r = await call('GET', '/api/setup/plan', B, { headers: withCode('bea') });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toMatch(/not a regular file|in the tenant folder/);
      expect(JSON.stringify(r.json)).not.toMatch(/evil/);
      expect((await call('GET', '/api/setup/plan', A, { headers: withCode('ada') })).status).toBe(200);
    } finally {
      try { writer.kill('SIGKILL'); } catch { /* gone */ }
      rmSync(file, { force: true });
      writeFileSync(file, keep);
    }
  });

  it('prints each tenant\'s code to stdout naming the tenant, and to that tenant\'s own log only; never a password or a token', () => {
    const restore = installTenantConsole();
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
    // The code is random hex, so it can spell the other tenant's name: draw one that does, every run (a real draw did,
    // about 1 in 400), so the check below is held to the line's words and never to its code.
    const draw = vi.spyOn(crypto, 'randomBytes').mockImplementationOnce((() => Buffer.from('79fdada7c104', 'hex')) as never);
    try {
      runInTenant(bea, () => _resetSetupCode()); // the default announcer
      announceTenantSetupCodes([bea]);
    } finally { spy.mockRestore(); draw.mockRestore(); restore(); }
    try {
      const line = out.join('');
      expect(line).toMatch(/Setup code for tenant bea:  79fdada7c104/);
      expect(line).not.toContain(bea.token);
      expect(line.replace(/[0-9a-f]{12}/, '<code>')).not.toMatch(/ada/); // the other tenant is never named
      const log = readFileSync(tenantLogFile(bea), 'utf8');
      expect(log).toMatch(/\[setup\] Setup code for tenant bea:/);
      expect(existsSync(tenantLogFile(ada)) ? readFileSync(tenantLogFile(ada), 'utf8') : '').not.toMatch(/Setup code for tenant bea/);
    } finally {
      // bea's code was just rotated by the default announcer: catch the next one again, pass or fail, so the tests after
      // this one (the /apply ones) still hold bea's current code
      runInTenant(bea, () => { _resetSetupCode({ announce: (code) => { codes.bea = code; } }); ensureSetupCode(); });
    }
  });
});

describe('/api/setup/apply on one tenant', () => {
  const answers = { companionName: 'Ada', userName: 'Sam', provider: 'claude', anthropicKey: 'sk-ant-test-for-ada', password: 'tenant-ada-password' };

  it('refuses answers that would put a tenant file outside its folder, writing nothing', async () => {
    const before = tree(ada.dir);
    const r = await call('POST', '/api/setup/apply', A, { headers: withCode('ada'), json: { answers: { ...answers, home: join(tmpdir(), 'elsewhere-home') } } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/outside the tenant folder/);
    expect(tree(ada.dir)).toEqual(before);
  });

  it('writes the tenant\'s own tenant.yaml and .env (0600), never process.env, never another tenant\'s folder', async () => {
    const beaBefore = tree(bea.dir);
    const envBefore = { ...process.env };
    const r = await call('POST', '/api/setup/apply', A, { headers: withCode('ada'), json: { answers } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.restartNeeded).toBe(true);
    const env = readFileSync(join(ada.dir, '.env'), 'utf8');
    expect(env).toContain('APP_PASSWORD=tenant-ada-password');
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-test-for-ada');
    if (process.platform !== 'win32') expect(statSync(join(ada.dir, '.env')).mode & 0o777).toBe(0o600);
    const written = yaml.load(readFileSync(join(ada.dir, 'tenant.yaml'), 'utf8')) as Record<string, any>;
    expect(written.hosts).toEqual([A]); // kept
    expect(written.identity.companion_name).toBe('Ada');
    expect(written.server).toBeUndefined();
    // nothing of the process or of tenant bea moved
    expect(tree(bea.dir)).toEqual(beaBefore);
    expect(process.env.APP_PASSWORD).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect({ ...process.env }).toEqual(envBefore);
    // the tenant's own config took the password (rt.setPassword + rt.reload), the other's did not
    expect(ada.config.auth.password).toBe('tenant-ada-password');
    expect(ada.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-for-ada');
    expect(bea.config.auth.password).toBe('');
    expect(bea.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('A\'s new password signs in on A and nowhere else; the setup page now takes the session, not the code', async () => {
    expect((await call('POST', '/api/auth/login', A, { json: { password: 'tenant-ada-password' } })).status).toBe(200);
    expect((await call('POST', '/api/auth/login', B, { json: { password: 'tenant-ada-password' } })).status).not.toBe(200); // B has no password yet: sealed
    expect((await call('GET', '/api/setup/plan', A, { headers: withCode('ada') })).status).toBe(401);
    expect((await call('GET', '/api/setup/status', A)).json).toEqual({ password_set: true, needs_code: false });
    expect((await call('GET', '/api/setup/status', B)).json).toEqual({ password_set: false, needs_code: true });
  });
});

describe('GET /api/tenant', () => {
  it('answers for the tenant asking, behind its own sign-in', async () => {
    const first = await call('GET', '/api/tenant', A); expect(first.status, JSON.stringify(first.json)).toBe(401);
    const login = await call('POST', '/api/auth/login', A, { json: { password: 'tenant-ada-password' } });
    const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const r = await call('GET', '/api/tenant', A, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ hosts: [A], dir: ada.dir });
    expect((await call('GET', '/api/tenant', B, { headers: { cookie } })).status).not.toBe(200); // A's session is nothing on B (sealed: B has no password yet)
    expect(JSON.stringify(r.json)).not.toContain(bea.dir);
  });
});

describe('rt.reload()', () => {
  it('re-runs the tenant load and the confinement: a tenant.yaml that would be skipped at boot is refused and the old config stays; others are untouched', () => {
    const file = join(ada.dir, 'tenant.yaml');
    const good = readFileSync(file, 'utf8');
    const before = ada.config;
    const beaConfig = bea.config;
    try {
      writeFileSync(file, yaml.dump({ ...(yaml.load(good) as Record<string, any>), hooks: { workspace_root: join(tmpdir(), 'not-the-tenants') } }));
      expect(() => ada.reload()).toThrow(/inside the tenant folder/);
      expect(ada.config).toBe(before);
      expect(bea.config).toBe(beaConfig);
      const parsed = yaml.load(good) as Record<string, any>;
      writeFileSync(file, yaml.dump({ ...parsed, agent: { ...(parsed.agent ?? {}), model: 'reloaded-model' } }));
      ada.reload();
      expect(ada.config.agent.model).toBe('reloaded-model');
      expect(ada.config.auth.password).toBe('tenant-ada-password'); // from its own .env
      expect(bea.config).toBe(beaConfig);
    } finally { writeFileSync(file, good); }
  });
});

describe('round 6, item 7: one scan per /apply', () => {
  it('a counter on the scan walk sees ONE full scan for a whole /apply: the pre-write check, the dry run of the candidate tenant.yaml and the reload share it', async () => {
    const before = { ...scanStats };
    const r = await call('POST', '/api/setup/apply', B, { headers: withCode('bea'), json: { answers: { companionName: 'Bea', userName: 'Sam', provider: 'claude', anthropicKey: 'sk-ant-test-for-bea', password: 'tenant-bea-password' } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(scanStats.full - before.full).toBe(1);
    expect(scanStats.only - before.only).toBe(0);
    expect(bea.config.auth.password).toBe('tenant-bea-password'); // (the reload did run, on the shared scan)
  });
});
