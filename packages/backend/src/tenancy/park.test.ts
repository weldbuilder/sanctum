// Hot park and revive of one tenant (tenancy/park.ts, tenancy/operator.ts) over real HTTP: park -> 503 on that tenant's routes while the other answers as before,
// revive -> back, a tenant that failed at boot is revived after its file is fixed, an unknown id, a wrong token, a double park. Real express, real tenants.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: () => { throw new Error('no model run in this test'); },
}));
vi.mock('../services/revien.js', async (orig) => ({ ...(await orig<object>()), recallForPrompt: async () => '', ingestTurn: async () => {} }));
vi.mock('../services/outlook-author.js', async (orig) => ({ ...(await orig<object>()), startOutlookAuthor: () => {}, stopOutlookAuthor: () => {} }));

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants, stopTenantServices, tenantLifecycle } from './boot.js';
import { currentTenant, enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantEnter, tenantResolve, setTenantRegistry, isReservedHost, resolveTenant } from './resolve.js';
import { loadOperatorToken, operatorBypassesResolve, operatorRouter } from './operator.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, safeTenantYaml, stopBootedTenants } from './test-runtime.js';
import { registry } from '../services/ws.js';
import { closeHouse } from './house.js';

const BAD_CRON = 'hosts: [cat.example.net]\norchestrator:\n  enabled: true\n  schedules:\n    morning: "60 * * * *"\n'; // '60' is not a minute: the scheduler throws at start
const GOOD = (id: string, extra = '') => `hosts: [${id}.example.net]\norchestrator:\n  enabled: true\n${extra}`;
const REVIEN = (port: number) => `revien:\n  enabled: true\n  url: http://127.0.0.1:${port}\n`;

let server: http.Server;
let port = 0;
let top = '';
let tenantsDir = '';
let opToken = '';
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;

function call(method: string, path: string, host: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json: unknown = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } ok({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', fail);
    req.end();
  });
}
const ping = (id: string) => call('GET', '/ping', `${id}.example.net`);
const op = (method: string, path: string, token: string | null = opToken) => call(method, path, 'operator.example.net', token === null ? {} : { 'x-internal-token': token });
const park = (id: string, token?: string | null) => op('POST', `/api/internal/tenants/${id}/park`, token);
const revive = (id: string, token?: string | null) => op('POST', `/api/internal/tenants/${id}/revive`, token);
const fakeSocket = () => ({ readyState: 1, send: vi.fn(), close: vi.fn() });

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  top = mkdtempSync(join(tmpdir(), 'sanctum-park-'));
  const cfg = processConfigFor(resolve(top, 'proc'));
  cfg.orchestrator.enabled = true;
  tenantsDir = makeTenantsDir({
    ada: { yaml: GOOD('ada', REVIEN(59901)) },
    bea: { yaml: GOOD('bea', REVIEN(59902)) },
    cat: { yaml: BAD_CRON },
  });
  (cfg as unknown as { tenants: unknown }).tenants = { dir: tenantsDir };
  registerProcessConfig(() => cfg);
  const app = express();
  runtimes = bootTenants(app, safeTenancyProcess(cfg, { fakeProvider: true }));
  opToken = loadOperatorToken(join(top, 'proc-data'))!;
  // The order server.ts uses: resolution stands aside for the operator's paths, the router sits after the body parsers and tenantEnter.
  app.use((req, res, next) => { if (operatorBypassesResolve(req)) next(); else tenantResolve(req, res, next); });
  app.use(express.json());
  app.use(tenantEnter);
  app.use('/api/internal/tenants', operatorRouter({ dataDir: join(top, 'proc-data') }));
  app.get('/ping', (_req, res) => { res.json({ id: currentTenant()?.id }); });
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null); closeHouse();
  rmSync(top, { recursive: true, force: true });
  rmSync(tenantsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the operator gate', () => {
  it('the operator token is a file of its own, owner-only, and not a tenant token', () => {
    expect(opToken).toMatch(/^[0-9a-f]{64}$/);
    expect(opToken).not.toBe(ada.token);
    if (process.platform !== 'win32') expect(statSync(join(top, 'proc-data', '.operator-token')).mode & 0o777).toBe(0o600);
  });
  it('no token, a wrong one and a tenant\'s own internal token all answer 404 (as internalOnly does); nothing changes', async () => {
    expect((await park('bea', null)).status).toBe(404);
    expect((await park('bea', 'x'.repeat(64))).status).toBe(404);
    expect((await park('bea', ada.token)).status).toBe(404);
    expect((await park('bea', bea.token)).status).toBe(404);
    expect((await revive('bea', ada.token)).status).toBe(404);
    expect((await ping('bea')).status).toBe(200);
  });
  it('an id nobody has is 404 (revive and park), and so is a string that is not an id', async () => {
    expect((await park('zed')).status).toBe(404);
    expect((await revive('zed')).status).toBe(404);
    expect((await park('NOT_AN_ID')).status).toBe(404);
  });
  it('lists every folder with its state', async () => {
    const r = await op('GET', '/api/internal/tenants');
    expect(r.status).toBe(200);
    expect(r.json).toEqual([
      { id: 'ada', state: 'running' }, { id: 'bea', state: 'running' },
      { id: 'cat', state: 'failed', error: expect.stringContaining('did not start') },
    ]);
  });
});

describe('park and revive, two tenants', () => {
  it('park A: 503 on A\'s routes and host, A\'s services and sockets stopped, B answers and runs as before', async () => {
    const adaSocket = fakeSocket();
    const beaSocket = fakeSocket();
    runInTenant(ada, () => registry.add('user', adaSocket as never));
    runInTenant(bea, () => registry.add('user', beaSocket as never));
    const adaStop = vi.spyOn(ada.services.orchestrator as { stop(): void }, 'stop');
    const beaStop = vi.spyOn(bea.services.orchestrator as { stop(): void }, 'stop');
    const beaOrchestrator = bea.services.orchestrator;
    const beaRevien = { enabled: bea.config.revien.enabled, parkedBy: bea.revienParkedBy };
    const beaConfig = bea.config;
    expect((await ping('ada')).status).toBe(200);

    const r = await park('ada');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: 'ada', state: 'parked' });

    expect((await ping('ada')).status).toBe(503);
    expect((await ping('ada')).json).toEqual({ error: 'tenant_unavailable' });
    expect(isReservedHost('ada.example.net')).toBe(true);
    expect(resolveTenant({ host: 'ada.example.net' })).toBeNull();
    expect(adaStop).toHaveBeenCalled();
    expect(adaSocket.close).toHaveBeenCalledWith(1013, 'companion parked');
    // the other tenant: nothing observable changed
    expect(beaSocket.close).not.toHaveBeenCalled();
    expect(beaStop).not.toHaveBeenCalled();
    expect(bea.services.orchestrator).toBe(beaOrchestrator);
    expect(bea.config).toBe(beaConfig);
    expect({ enabled: bea.config.revien.enabled, parkedBy: bea.revienParkedBy }).toEqual(beaRevien);
    expect(runInTenant(bea, () => registry.getCount())).toBe(1);
    expect(tenantLifecycle()!.runtimes.get('bea')).toBe(bea);
    const b = await ping('bea');
    expect(b.status).toBe(200);
    expect(b.json).toEqual({ id: 'bea' });
    expect((await op('GET', '/api/internal/tenants')).json).toEqual(expect.arrayContaining([{ id: 'ada', state: 'parked' }, { id: 'bea', state: 'running' }]));
    runInTenant(bea, () => registry.remove('user', beaSocket as never));
  });

  it('park A again is 409; revive of B (running) is 409', async () => {
    const again = await park('ada');
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('not_running');
    expect((await revive('bea')).status).toBe(409);
    expect((await revive('bea')).json.error).toBe('already_running');
    expect((await ping('ada')).status).toBe(503);
  });

  it('revive A: back, from its files, as a new runtime; B is the same object and still serves', async () => {
    const before = ada;
    const r = await revive('ada');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: 'ada', state: 'running' });
    const a = await ping('ada');
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ id: 'ada' });
    const now = tenantLifecycle()!.runtimes.get('ada')!;
    expect(now).not.toBe(before);
    expect(now.token).toBe(before.token);
    expect(now.services.orchestrator).toBeDefined();
    expect(isReservedHost('ada.example.net')).toBe(false);
    expect(tenantLifecycle()!.runtimes.get('bea')).toBe(bea);
    expect((await ping('bea')).json).toEqual({ id: 'bea' });
    ada = now;
    expect((await park('ada')).status).toBe(200); // and it can be parked again
    expect((await revive('ada')).status).toBe(200);
    ada = tenantLifecycle()!.runtimes.get('ada')!;
  });

  it('a tenant whose file was fixed while it was parked comes back with the fix; one that is still broken stays parked with the error recorded', async () => {
    expect((await park('bea')).status).toBe(200);
    writeFileSync(join(tenantsDir, 'bea', 'tenant.yaml'), safeTenantYaml(GOOD('bea').replace('orchestrator:', 'orchestrator:\n  schedules:\n    morning: "60 * * * *"')));
    const bad = await revive('bea');
    expect(bad.status).toBe(500);
    expect(bad.json.state).toBe('parked');
    expect(bad.json.error).toContain('did not start');
    expect((await ping('bea')).status).toBe(503);
    expect((await op('GET', '/api/internal/tenants')).json).toEqual(expect.arrayContaining([{ id: 'bea', state: 'parked', error: bad.json.error }]));
    writeFileSync(join(tenantsDir, 'bea', 'tenant.yaml'), safeTenantYaml(GOOD('bea', REVIEN(59902))));
    const ok = await revive('bea');
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ id: 'bea', state: 'running' });
    expect((await ping('bea')).json).toEqual({ id: 'bea' });
    bea = tenantLifecycle()!.runtimes.get('bea')!;
  });
});

describe('a tenant that failed at boot', () => {
  it('is listed failed, answers 503, cannot be parked (409), and is revived by the same route once its file is fixed', async () => {
    expect(runtimes.has('cat')).toBe(false);
    expect((await ping('cat')).status).toBe(503);
    expect((await park('cat')).status).toBe(409);
    const still = await revive('cat');
    expect(still.status).toBe(500);
    expect(still.json).toEqual({ id: 'cat', state: 'failed', error: expect.stringContaining('did not start') });
    expect((await ping('cat')).status).toBe(503);
    writeFileSync(join(tenantsDir, 'cat', 'tenant.yaml'), safeTenantYaml(GOOD('cat')));
    const r = await revive('cat');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: 'cat', state: 'running' });
    expect((await ping('cat')).json).toEqual({ id: 'cat' });
    expect(isReservedHost('cat.example.net')).toBe(false);
    expect((await ping('ada')).json).toEqual({ id: 'ada' });
    expect((await ping('bea')).json).toEqual({ id: 'bea' });
    // the new tenant's services run: shutdown stops them (and the runtimes the caller holds close their databases)
    await stopTenantServices(tenantLifecycle()!.runtimes.values());
    for (const rt of tenantLifecycle()!.runtimes.values()) rt.db.close();
  });
});
