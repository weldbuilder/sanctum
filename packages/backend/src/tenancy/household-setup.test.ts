// Household mode, setup (stage 5): a companion's wizard has no password step and ignores a password answer; the house's own first run (the one
// thing it owns) is the unprefixed /api/setup, behind the house's setup code, and writes the password to the process .env.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ proc: null as null | { auth: { password: string } }, source: 'dotenv' }));
// The process's password holder and reload are the real config.ts's in a running server; here they act on the test's process config.
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  setAppPassword: (pw: string) => { if (h.proc) h.proc.auth.password = pw; },
  reloadConfig: () => h.proc,
  getAppPasswordSource: () => h.source,
}));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawnSync: () => ({ status: 0 }) }));

import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { closeHouse, houseDataDir, houseScope } from './house.js';
import { houseSetupRouter, setHouseEnvPathForTest } from './house-setup.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginHandler, sessionCheckHandler } from '../middleware/auth.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import setupRoutes from '../routes/setup.js';
import { _resetSetupCode, ensureSetupCode } from '../services/setup-code.js';

interface Reply { status: number; headers: http.IncomingHttpHeaders; json: any }
let server: http.Server;
let port = 0;
let ada: TenantRuntime;
let houseDbFile = '';
let envFile = '';
let houseCode = '';
let proc: ReturnType<typeof processConfigFor>;

function call(method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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
const sessionCount = () => { const d = new Database(houseDbFile, { readonly: true }); try { return (d.prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n; } finally { d.close(); } };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.APP_PASSWORD;
  delete process.env.ANTHROPIC_API_KEY;
  const root = makeTenantsDir({ ada: { yaml: 'identity:\n  companion_name: Ada\n' } });
  const base = mkdtempSync(join(tmpdir(), 'sanctum-house-setup-'));
  proc = processConfigFor(resolve(base, 'process'), { server: { db_path: join(base, 'process', 'data', 'sanctum.db') } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: root, auth: 'household' }; // (safeTenancyProcess pins per-tenant only when the test does not say)
  h.proc = proc;
  registerProcessConfig(() => proc);
  houseDbFile = join(houseDataDir(proc.server.db_path), 'house.db');
  envFile = join(base, 'process.env');
  setHouseEnvPathForTest(envFile);

  const app = express();
  app.set('trust proxy', 1);
  const runtimes = bootTenants(app, safeTenancyProcess(proc));
  ada = runtimes.get('ada')!;
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.get('/api/auth/check', sessionCheckHandler);
  app.use('/api/setup', houseSetupRouter);
  app.use('/api/setup', setupRoutes);
  app.use(globalErrorHandler);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  port = (server.address() as AddressInfo).port;
  // The house's own code, captured as it is announced in the house scope.
  runInTenant(houseScope(), () => { _resetSetupCode({ announce: (code) => { houseCode = code; } }); ensureSetupCode(); });
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise((r) => server.close(r));
  for (const rt of [ada]) { try { rt.db.close(); } catch { /* closed */ } }
  closeHouse();
  enableTenancy(false);
  setTenantRegistry(new Map());
  registerProcessConfig(() => null);
  setHouseEnvPathForTest(null);
  vi.restoreAllMocks();
});

describe('the house first run', () => {
  it('asks for the house setup code, offers one step (the password) and nothing else', async () => {
    expect(houseCode).toMatch(/^[0-9a-f]{12}$/);
    expect((await call('GET', '/api/setup/status')).json).toEqual({ password_set: false, needs_code: true });
    expect((await call('GET', '/api/setup/plan')).status).toBe(401);
    expect((await call('GET', '/api/setup/plan', { headers: { 'x-setup-code': 'not-the-code' } })).status).toBe(401);
    const plan = await call('GET', '/api/setup/plan', { headers: { 'x-setup-code': houseCode } });
    expect(plan.status).toBe(200);
    expect(plan.json.steps.map((s: { id: string }) => s.id)).toEqual(['password']);
    expect(plan.json.mode).toBe('first_run');
    for (const path of ['/api/setup/test']) {
      const r = await call('POST', path, { headers: { 'x-setup-code': houseCode }, json: {} });
      expect(r.status, path).toBe(404);
    }
  });

  it('a companion\'s setup waits for the house password (409), whatever code is sent', async () => {
    const r = await call('GET', '/c/ada/api/setup/plan', { headers: { 'x-setup-code': houseCode } });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('house_password_required');
  });

  it('refuses a short password, then sets the process password (.env 0600 content, config holder), and signs in with it', async () => {
    // The page's own order: status, plan, validate as it is typed (bad, then good), apply, then the session check.
    const code = { 'x-setup-code': houseCode };
    expect((await call('POST', '/api/setup/validate', { json: { id: 'password', value: 'x' } })).status).toBe(401); // (the same gate)
    expect((await call('POST', '/api/setup/validate', { headers: code, json: { id: 'password', value: 'short' } })).json).toEqual({ ok: false, active: true, message: 'Use at least 8 characters.' });
    expect((await call('POST', '/api/setup/validate', { headers: code, json: { id: 'password', value: 'the-house-password' } })).json).toEqual({ ok: true, active: true, message: '' });
    expect((await call('POST', '/api/setup/validate', { headers: code, json: { id: 'home', value: 'x' } })).status).toBe(404);
    expect((await call('POST', '/api/setup/validate', { headers: code, json: {} })).status).toBe(400);
    const short = await call('POST', '/api/setup/apply', { headers: { 'x-setup-code': houseCode }, json: { answers: { password: 'short' } } });
    expect(short.status).toBe(400);
    expect(existsSync(envFile)).toBe(false);
    const r = await call('POST', '/api/setup/apply', { headers: { 'x-setup-code': houseCode }, json: { answers: { password: 'the-house-password' } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain('APP_PASSWORD=the-house-password');
    expect(proc.auth.password).toBe('the-house-password');
    expect(ada.config.auth.password).toBe('the-house-password'); // (the companions read "a login is set" from the house)
    expect((await call('GET', '/api/setup/status')).json).toEqual({ password_set: true, needs_code: false });
    const login = await call('POST', '/api/auth/login', { json: { password: 'the-house-password' } });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie']![0].split(';')[0];
    expect((await call('GET', '/api/auth/check', { headers: { cookie } })).json).toEqual({ authenticated: true, mode: 'household' });
    // Now the house's setup takes the session, not the code.
    expect((await call('GET', '/api/setup/plan', { headers: { 'x-setup-code': houseCode } })).status).toBe(401);
  });
});

describe("a companion's setup in household mode", () => {
  const cookieOf = async () => (await call('POST', '/api/auth/login', { json: { password: proc.auth.password } })).headers['set-cookie']![0].split(';')[0];

  it('has no password step, and says why in one line', async () => {
    const cookie = await cookieOf();
    const plan = await call('GET', '/c/ada/api/setup/plan', { headers: { cookie } });
    expect(plan.status).toBe(200);
    const ids = plan.json.steps.map((s: { id: string }) => s.id);
    expect(ids).not.toContain('password');
    expect(ids).toContain('companionName');
    expect(plan.json.notes.filter((n: string) => /household mode/.test(n) && /Password/.test(n))).toHaveLength(1);
  });

  it('/apply with a password answer ignores it with a note: the house password, the house sessions and the companion .env are unchanged', async () => {
    const cookie = await cookieOf();
    const sessionsBefore = sessionCount();
    const passwordBefore = proc.auth.password;
    const r = await call('POST', '/c/ada/api/setup/apply', { headers: { cookie }, json: { answers: { companionName: 'Ada', userName: 'Sam', provider: 'claude', anthropicKey: 'sk-ant-test-for-ada', password: 'a-companion-password' } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.notes.some((n: string) => /house has one password/.test(n))).toBe(true);
    const env = readFileSync(join(ada.dir, '.env'), 'utf8');
    expect(env).not.toContain('APP_PASSWORD');
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-test-for-ada');
    expect(proc.auth.password).toBe(passwordBefore);
    expect(ada.config.auth.password).toBe(passwordBefore);
    expect(sessionCount()).toBe(sessionsBefore);
    expect(readFileSync(envFile, 'utf8')).not.toContain('a-companion-password');
    // A companion's own setPassword is a no-op with a note.
    expect(ada.setPassword('x')).toMatch(/house has one password/);
    expect(ada.config.auth.password).toBe(passwordBefore);
    // (and a stray tenant .env APP_PASSWORD written by hand is still not a login after a reload)
    writeFileSync(join(ada.dir, '.env'), `${env}APP_PASSWORD=hand-written\n`);
    ada.reload();
    expect(ada.config.auth.password).toBe(passwordBefore);
  });
});

describe('the house password under a parent-supplied APP_PASSWORD', () => {
  it('says the old one comes back at the next restart (passwordKeptByParent), as the single-tenant apply does', async () => {
    const cookie = (await call('POST', '/api/auth/login', { json: { password: proc.auth.password } })).headers['set-cookie']![0].split(';')[0];
    h.source = 'parent_env';
    try {
      const r = await call('POST', '/api/setup/apply', { headers: { cookie }, json: { answers: { password: 'another-house-password' } } });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.passwordKeptByParent).toBe(true);
      expect(r.json.notes[0]).toMatch(/set by whatever starts this app/);
    } finally { h.source = 'dotenv'; }
  });
});
