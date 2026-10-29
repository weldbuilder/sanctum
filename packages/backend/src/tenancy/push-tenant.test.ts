// Push per tenant (stage 3b). web-push is a fake: nothing is sent anywhere. Subscriptions live in each tenant's own database; the VAPID keys come from
// each tenant's own .env (never the process's) and are passed with every send, because web-push's setVapidDetails is one global for the whole process.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const wp = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async (_s: unknown, _p?: unknown, _o?: unknown) => ({ statusCode: 201 })),
}));
vi.mock('web-push', () => ({ default: wp, ...wp }));

import { bootTenants, stopTenantServices } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import { listPushSubscriptions } from '../services/db.js';

const A = 'ada.example.net';
const B = 'bea.example.net';
const C = 'cal.example.net';
let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;

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
const login = async (host: string, password: string) => (await call('POST', '/api/auth/login', host, { json: { password } })).cookie;
const vapid = (n: string) => `VAPID_PUBLIC_KEY=pub-${n}\nVAPID_PRIVATE_KEY=priv-${n}\nVAPID_CONTACT=mailto:${n}@example.net\n`;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.VAPID_PUBLIC_KEY = 'pub-process';
  process.env.VAPID_PRIVATE_KEY = 'priv-process';
  process.env.VAPID_CONTACT = 'mailto:process@example.net';
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { orchestrator: { enabled: false } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
    ada: { yaml: `hosts: [${A}]\n`, env: `APP_PASSWORD=pw-ada\n${vapid('ada')}` },
    bea: { yaml: `hosts: [${B}]\n`, env: `APP_PASSWORD=pw-bea\n${vapid('bea')}` },
    cal: { yaml: `hosts: [${C}]\n`, env: 'APP_PASSWORD=pw-cal\n' },
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
  for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_CONTACT']) delete process.env[k];
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('push per tenant', () => {
  it("VAPID per tenant env: each tenant's public key is its own, the process's is never used, a keyless tenant says not configured", async () => {
    const [ca, cb, cc] = await Promise.all([login(A, 'pw-ada'), login(B, 'pw-bea'), login(C, 'pw-cal')]);
    expect((await call('GET', '/api/push/vapid-public', A, { cookie: ca })).json.publicKey).toBe('pub-ada');
    expect((await call('GET', '/api/push/vapid-public', B, { cookie: cb })).json.publicKey).toBe('pub-bea');
    expect((await call('GET', '/api/push/vapid-public', C, { cookie: cc })).json.publicKey).toBeNull();
    const test = await call('POST', '/api/push/test', C, { cookie: cc, json: {} });
    expect(test.status).toBe(503);
    expect(test.json.error).toMatch(/not configured/);
    // The web-push global is never set by a tenant's service (it would be one set of keys for every tenant).
    expect(wp.setVapidDetails).not.toHaveBeenCalled();
  });

  it("subscriptions live in each tenant's own database, and a test push goes to that tenant's subscriptions with that tenant's keys", async () => {
    const [ca, cb] = await Promise.all([login(A, 'pw-ada'), login(B, 'pw-bea')]);
    const sub = (n: string) => ({ endpoint: `https://push.example.net/${n}`, keys: { p256dh: `p-${n}`, auth: `a-${n}` }, deviceLabel: n });
    expect((await call('POST', '/api/push/subscribe', A, { cookie: ca, json: sub('ada-phone') })).status).toBe(200);
    expect((await call('POST', '/api/push/subscribe', B, { cookie: cb, json: sub('bea-phone') })).status).toBe(200);
    const endpoints = (rt: TenantRuntime) => runInTenant(rt, () => listPushSubscriptions()).map((s) => s.endpoint);
    expect(endpoints(ada)).toEqual(['https://push.example.net/ada-phone']);
    expect(endpoints(bea)).toEqual(['https://push.example.net/bea-phone']);
    expect(JSON.stringify((await call('GET', '/api/push/subscriptions', B, { cookie: cb })).json)).not.toContain('ada-phone');

    wp.sendNotification.mockClear();
    expect((await call('POST', '/api/push/test', A, { cookie: ca, json: {} })).status).toBe(200);
    expect(wp.sendNotification).toHaveBeenCalledTimes(1);
    const [target, , opts] = wp.sendNotification.mock.calls[0] as [{ endpoint: string }, unknown, { vapidDetails: { publicKey: string; privateKey: string; subject: string } }];
    expect(target.endpoint).toBe('https://push.example.net/ada-phone');
    expect(opts.vapidDetails).toEqual({ subject: 'mailto:ada@example.net', publicKey: 'pub-ada', privateKey: 'priv-ada' });

    wp.sendNotification.mockClear();
    expect((await call('POST', '/api/push/test', B, { cookie: cb, json: {} })).status).toBe(200);
    const [tb, , ob] = wp.sendNotification.mock.calls[0] as [{ endpoint: string }, unknown, { vapidDetails: { publicKey: string } }];
    expect(tb.endpoint).toBe('https://push.example.net/bea-phone');
    expect(ob.vapidDetails.publicKey).toBe('pub-bea');
    // A removes its subscription: B's stays.
    await call('POST', '/api/push/unsubscribe', A, { cookie: ca, json: { endpoint: 'https://push.example.net/ada-phone' } });
    expect(endpoints(ada)).toEqual([]);
    expect(endpoints(bea)).toEqual(['https://push.example.net/bea-phone']);
  });
});
