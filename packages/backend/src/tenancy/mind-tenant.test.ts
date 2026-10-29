// The Mind watchdog per tenant (stage 3b). A fake fetch stands in for the Mind: no network. Two watchdogs keep two states; /api/mind/status on B never
// shows A's; saving a mind.* setting on A rechecks A only; the key a probe sends is the tenant's own, and it appears in no log line.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { bootTenants, stopTenantServices } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import { getMindWatchdog } from '../services/mind-watchdog.js';
import { setConfig } from '../services/db.js';

const A = 'ada.example.net';
const B = 'bea.example.net';
const KEY_A = 'KEY-ADA-0123456789';
const KEY_PROCESS = 'KEY-PROCESS-9876543210';
let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;
const logged: string[] = [];
const requests: { url: string; auth: string }[] = [];

const envelope = () => new Response(JSON.stringify({ ok: true, receipt: { projection: { version: '1.2.3', schema: 's1', db: 'up' } } }), { status: 200 });
const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  requests.push({ url: String(url), auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? '') });
  return envelope();
});

function call(method: string, path: string, host: string, opts: { cookie?: string; json?: unknown } = {}): Promise<{ status: number; json: any; cookie: string }> {
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
        ok({ status: res.statusCode ?? 0, json, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] });
      });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  vi.stubGlobal('fetch', fakeFetch);
  process.env.MIND_API_KEY = KEY_PROCESS;
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { orchestrator: { enabled: false } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
    ada: { yaml: `hosts: [${A}]\n`, env: `APP_PASSWORD=pw-ada\nMIND_API_KEY=${KEY_A}\n` },
    bea: { yaml: `hosts: [${B}]\n`, env: 'APP_PASSWORD=pw-bea\n' },
  }) };
  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
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
  stopTenantServices(runtimes.values());
  await new Promise<void>((ok) => server.close(() => ok()));
  delete process.env.MIND_API_KEY;
  vi.unstubAllGlobals();
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('Mind watchdog per tenant', () => {
  it('two watchdogs, two states: GET /api/mind/status on B never shows A', async () => {
    const wdA = runInTenant(ada, () => getMindWatchdog());
    const wdB = runInTenant(bea, () => getMindWatchdog());
    expect(wdA).not.toBe(wdB);
    const la = await call('POST', '/api/auth/login', A, { json: { password: 'pw-ada' } });
    const lb = await call('POST', '/api/auth/login', B, { json: { password: 'pw-bea' } });
    // A turns the Mind on through its settings route.
    for (const [key, value] of [['mind.url', 'http://mind-a.example.net/mcp'], ['mind.mind_id', 'mind-ada'], ['mind.enabled', 'true']]) {
      expect((await call('PUT', '/api/settings', A, { cookie: la.cookie, json: { key, value } })).status).toBe(200);
    }
    const a = await call('GET', '/api/mind/status', A, { cookie: la.cookie });
    expect(a.json.state).toBe('ok');
    expect(a.json.version).toBe('1.2.3');
    const b = await call('GET', '/api/mind/status', B, { cookie: lb.cookie });
    expect(b.json.state).toBe('off');
    expect(b.json.version).toBeUndefined();
    expect(runInTenant(bea, () => getMindWatchdog().get().state)).toBe('off');
    expect(runInTenant(ada, () => getMindWatchdog().get().state)).toBe('ok');
  });

  it("saving a mind.* setting on A rechecks A only; the key sent is A's own, never the process's", async () => {
    const la = await call('POST', '/api/auth/login', A, { json: { password: 'pw-ada' } });
    const probesA = wd(ada).probes;
    const probesB = wd(bea).probes;
    const sentBefore = requests.length;
    expect((await call('PUT', '/api/settings', A, { cookie: la.cookie, json: { key: 'mind.mind_id', value: 'mind-ada-2' } })).status).toBe(200);
    await runInTenant(ada, () => wd(ada).check()); // (the route's recheck is already running or done; check() shares it)
    expect(wd(ada).probes).toBeGreaterThan(probesA);
    expect(wd(bea).probes).toBe(probesB);
    const sent = requests.slice(sentBefore);
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) expect(r.url.startsWith('http://mind-a.example.net')).toBe(true);
    for (const r of requests.filter((x) => x.auth)) expect(r.auth).toBe(`Bearer ${KEY_A}`);
    expect(requests.map((r) => r.auth).join('\n')).not.toContain(KEY_PROCESS);
  });

  it('a tenant with the Mind on but no key of its own is incomplete, and nothing is sent for it (the process key is not used)', async () => {
    const lb = await call('POST', '/api/auth/login', B, { json: { password: 'pw-bea' } });
    for (const [key, value] of [['mind.url', 'http://mind-b.example.net/mcp'], ['mind.mind_id', 'mind-bea'], ['mind.enabled', 'true']]) {
      await call('PUT', '/api/settings', B, { cookie: lb.cookie, json: { key, value } });
    }
    const b = await call('GET', '/api/mind/status', B, { cookie: lb.cookie });
    expect(b.json.state).toBe('incomplete');
    expect(requests.some((r) => r.url.includes('mind-b'))).toBe(false);
    // And A's state is unchanged by B's settings.
    expect(wd(ada).get().state).toBe('ok');
    runInTenant(bea, () => setConfig('mind.enabled', 'false'));
  });

  it('no key appears in any log line, the tenant\'s or the process\'s', () => {
    const all = logged.join('\n');
    expect(all).not.toContain(KEY_A);
    expect(all).not.toContain(KEY_PROCESS);
    expect(all).not.toContain('0123456789');
  });
});

function wd(rt: TenantRuntime) { return runInTenant(rt, () => getMindWatchdog()); }
