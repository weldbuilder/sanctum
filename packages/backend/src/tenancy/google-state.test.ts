// Google OAuth per tenant (decision D6). The state carries the tenant and a nonce stored in that tenant's database; the callback, which arrives
// on localhost with no tenant host and no token, is routed by it. Tenancy off: the state is exactly what main produced.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { currentTenant, enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { startAuth, startHealthAuth, handleCallback } from '../services/google-auth.js';
import { loadConfig } from '../config.js';
import { initDb } from '../services/db.js';
import { consumeNonce, parseTenantState } from './google-state.js';

const A = 'ada.example.net';
const B = 'bea.example.net';
let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;

const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';
function get(path: string, host: string): Promise<{ status: number; json: any }> {
  return new Promise((ok, fail) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* */ } ok({ status: res.statusCode ?? 0, json }); });
    }).on('error', fail);
  });
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const root = makeTenantsDir({
    ada: { yaml: `hosts: [${A}]\n`, env: 'GOOGLE_CLIENT_ID=ada-id\nGOOGLE_CLIENT_SECRET=ada-secret\n' },
    bea: { yaml: `hosts: [${B}]\n`, env: 'GOOGLE_CLIENT_ID=bea-id\nGOOGLE_CLIENT_SECRET=bea-secret\n' },
  });
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (proc as unknown as { tenants: unknown }).tenants = { dir: root };
  const app = express();
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
  app.use(tenantResolve);
  app.use(tenantEnter);
  app.get('/api/google/auth/callback', (_req, res) => res.json({ tenant: currentTenant()?.id }));
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('the state names the tenant', () => {
  it('is <tenant>:<nonce>:main, with the health marker after the prefix, and the nonce is stored in that tenant only', () => {
    const main = stateOf(runInTenant(ada, () => startAuth().url));
    expect(main).toMatch(/^ada:[0-9a-f]{32}:main$/);
    const p = parseTenantState(main)!;
    expect(runInTenant(ada, () => ada.db.prepare('SELECT COUNT(*) c FROM google_oauth_state WHERE nonce = ?').get(p.nonce))).toEqual({ c: 1 });
    expect(bea.db.prepare("SELECT name FROM sqlite_master WHERE name = 'google_oauth_state'").get()).toBeUndefined();
    runInTenant(ada, () => ada.db.prepare("INSERT INTO google_accounts (id, email, connected_at, updated_at) VALUES ('acct1', 'x@example.net', 't', 't')").run());
    expect(stateOf(runInTenant(ada, () => startHealthAuth('acct1').url))).toMatch(/^ada:[0-9a-f]{32}:health:acct1$/);
  });
});

describe('the callback finds its tenant by state', () => {
  it('A\'s state with no tenant host enters A', async () => {
    const state = stateOf(runInTenant(ada, () => startAuth().url));
    expect(await get(`/api/google/auth/callback?code=c&state=${encodeURIComponent(state)}`, `localhost:${port}`)).toEqual({ status: 200, json: { tenant: 'ada' } });
    expect((await get(`/api/google/auth/callback?code=c&state=${encodeURIComponent(state)}`, A)).json).toEqual({ tenant: 'ada' });
  });
  it('A\'s state on B\'s host is a 404', async () => {
    const state = stateOf(runInTenant(ada, () => startAuth().url));
    expect((await get(`/api/google/auth/callback?code=c&state=${encodeURIComponent(state)}`, B)).status).toBe(404);
  });
  it('an unknown nonce, an unknown tenant, no state, plain "main" and a nonce from the other tenant are all 404', async () => {
    const real = parseTenantState(stateOf(runInTenant(ada, () => startAuth().url)))!;
    for (const state of [`ada:${'0'.repeat(32)}:main`, `zed:${real.nonce}:main`, '', 'main', `bea:${real.nonce}:main`]) {
      expect((await get(`/api/google/auth/callback?code=c&state=${encodeURIComponent(state)}`, 'localhost')).status, state).toBe(404);
    }
  });
  it('the callback itself refuses a state from another tenant and spends the nonce once', async () => {
    const state = stateOf(runInTenant(ada, () => startAuth().url));
    await expect(runInTenant(bea, () => handleCallback('c', { state }))).rejects.toThrow(/did not start here/);
    await expect(runInTenant(ada, () => handleCallback('c', { state: 'main' }))).rejects.toThrow(/did not start here/);
    const p = parseTenantState(state)!;
    expect(runInTenant(ada, () => consumeNonce(p.nonce))).toBe(true);
    expect(runInTenant(ada, () => consumeNonce(p.nonce))).toBe(false);
    await expect(runInTenant(ada, () => handleCallback('c', { state }))).rejects.toThrow(/did not start here/);
  });
});

describe('tenancy off', () => {
  it('the state is exactly what main produced', () => {
    enableTenancy(false);
    loadConfig();
    const fx = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'google-state-main.json'), 'utf8'));
    const prevId = process.env.GOOGLE_CLIENT_ID; const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = 'fx-id'; process.env.GOOGLE_CLIENT_SECRET = 'fx-secret';
    const db = initDb(':memory:');
    try {
      expect(stateOf(startAuth().url)).toBe(fx.main);
      db.prepare("INSERT INTO google_accounts (id, email, connected_at, updated_at) VALUES ('acct1', 'x@example.net', 't', 't')").run();
      expect(stateOf(startHealthAuth('acct1').url)).toBe(fx.health);
    } finally {
      db.close();
      if (prevId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = prevSecret;
      enableTenancy(true);
    }
  });
});
