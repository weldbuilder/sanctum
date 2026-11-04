// What a park fences and what a revive checks (tenancy/park.ts): the database is closed, the running turn gets a bounded wait (and blocks a revive while it
// lives), a request already inside the companion answers 503 not 500, and a revive makes the same checks as a boot: layout, host taken or contested, Revien.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: () => { throw new Error('no model run in this test'); },
}));
vi.mock('../services/revien.js', async (orig) => ({ ...(await orig<object>()), recallForPrompt: async () => '', ingestTurn: async () => {} }));
vi.mock('../services/outlook-author.js', async (orig) => ({ ...(await orig<object>()), startOutlookAuthor: () => {}, stopOutlookAuthor: () => {} }));

vi.mock('./layout.js', async (orig) => { const real = await orig<typeof import('./layout.js')>(); return { ...real, layoutClash: vi.fn(real.layoutClash) }; });

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants, stopTenantServices, tenantLifecycle } from './boot.js';
import { currentTenant, enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantEnter, tenantResolve, setTenantRegistry, isReservedHost, resolveTenant } from './resolve.js';
import { loadOperatorToken, operatorBypassesResolve, operatorRouter } from './operator.js';
import { parkWait } from './park.js';
import { layoutClash } from './layout.js';
import { getDb } from '../services/db.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, safeTenantYaml, stopBootedTenants } from './test-runtime.js';
import { registry } from '../services/ws.js';
import { closeHouse } from './house.js';

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
let gate: Promise<void> = Promise.resolve();
let open: () => void = () => {};

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
const op = (method: string, path: string) => call(method, path, 'operator.example.net', { 'x-internal-token': opToken });
const park = (id: string) => op('POST', `/api/internal/tenants/${id}/park`);
const revive = (id: string) => op('POST', `/api/internal/tenants/${id}/revive`);
const live = (id: string) => tenantLifecycle()!.runtimes.get(id)!;
const writeYaml = (id: string, yaml: string) => writeFileSync(join(tenantsDir, id, 'tenant.yaml'), safeTenantYaml(yaml));
/** park + revive back to the plain files, so each test starts from two running tenants. */
async function reset(): Promise<void> {
  tenantLifecycle()!.contested.clear();
  writeYaml('ada', GOOD('ada', REVIEN(59911)));
  writeYaml('bea', GOOD('bea', REVIEN(59912)));
  for (const id of ['ada', 'bea']) {
    if (tenantLifecycle()!.runtimes.has(id)) await park(id);
    expect((await revive(id)).status).toBe(200);
  }
  ada = live('ada'); bea = live('bea');
}

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  top = mkdtempSync(join(tmpdir(), 'sanctum-park-fence-'));
  const cfg = processConfigFor(resolve(top, 'proc'));
  cfg.orchestrator.enabled = true;
  tenantsDir = makeTenantsDir({ ada: { yaml: GOOD('ada', REVIEN(59911)) }, bea: { yaml: GOOD('bea', REVIEN(59912)) } });
  (cfg as unknown as { tenants: unknown }).tenants = { dir: tenantsDir };
  registerProcessConfig(() => cfg);
  const app = express();
  runtimes = bootTenants(app, safeTenancyProcess(cfg, { fakeProvider: true }));
  opToken = loadOperatorToken(join(top, 'proc-data'))!;
  app.use((req, res, next) => { if (operatorBypassesResolve(req)) next(); else tenantResolve(req, res, next); });
  app.use(express.json());
  app.use(tenantEnter);
  app.use('/api/internal/tenants', operatorRouter({ dataDir: join(top, 'proc-data') }));
  app.get('/ping', (_req, res) => { res.json({ id: currentTenant()?.id }); });
  // A request already inside the companion when it parks: it waits on the gate, then reads the database (thrown error, or a handler that catches and answers 500).
  app.get('/inflight', async (_req, res, next) => { try { await gate; getDb().prepare('select 1').get(); res.json({ ok: true }); } catch (e) { next(e); } });
  app.get('/inflight-caught', async (_req, res) => { try { await gate; getDb().prepare('select 1').get(); res.json({ ok: true }); } catch { res.status(500).json({ error: 'caught' }); } });
  app.use(globalErrorHandler);
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
});
afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of tenantLifecycle()!.runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null); closeHouse();
  rmSync(top, { recursive: true, force: true });
  rmSync(tenantsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('what a park does to the runtime it leaves', () => {
  it('closes its database (and the other tenant\'s stays open), and asks the agent to stop', async () => {
    const stop = vi.fn(() => true);
    const real = ada.services.agentService;
    ada.services.agentService = { stopGeneration: stop, isProcessing: () => false, hasActiveQuery: () => false };
    expect(ada.db.open).toBe(true);
    expect((await park('ada')).status).toBe(200);
    expect(ada.db.open).toBe(false);
    expect(ada.parked).toBe(true);
    expect(bea.db.open).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    ada.services.agentService = real;
    await reset();
  });

  it('a request already inside the companion when it parks answers 503, not 500 (thrown error, and a handler that catches and answers 500)', async () => {
    for (const path of ['/inflight', '/inflight-caught']) {
      gate = new Promise<void>((ok) => { open = ok; });
      const pending = call('GET', path, 'ada.example.net');
      await new Promise((r) => setTimeout(r, 50)); // (it is inside the handler, waiting on the gate)
      expect((await park('ada')).status).toBe(200);
      open();
      const r = await pending;
      expect(r.status).toBe(503);
      await reset();
    }
    expect((await call('GET', '/inflight', 'ada.example.net')).status).toBe(200); // a revived companion answers as before
  });
});

describe('a turn that ignores the stop', () => {
  it('park waits up to the bound, reports turn_still_running, and revive is 409 until the turn ends', async () => {
    let busy = true;
    const stop = vi.fn(() => true);
    const real = ada.services.agentService;
    ada.services.agentService = { stopGeneration: stop, isProcessing: () => busy, hasActiveQuery: () => busy };
    const saved = parkWait.ms;
    parkWait.ms = 400;
    try {
      const started = Date.now();
      const r = await park('ada');
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ id: 'ada', state: 'parked', turn_still_running: true });
      expect(stop).toHaveBeenCalled();
      expect(ada.db.open).toBe(false); // (closed after the wait)
      const refused = await revive('ada');
      expect(refused.status).toBe(409);
      expect(refused.json.error).toBe('turn_still_running');
      expect(refused.json.message).toContain('harness child');
      expect((await ping('ada')).status).toBe(503);
      busy = false;
      expect((await revive('ada')).status).toBe(200);
    } finally { parkWait.ms = saved; ada.services.agentService = real; }
    ada = live('ada');
  });

  it('a turn that ends during the wait lets the park return at once, with no flag', async () => {
    let busy = true;
    const real = ada.services.agentService;
    ada.services.agentService = { stopGeneration: () => true, isProcessing: () => busy, hasActiveQuery: () => busy };
    setTimeout(() => { busy = false; }, 150);
    const started = Date.now();
    const r = await park('ada');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.json).toEqual({ id: 'ada', state: 'parked' });
    ada.services.agentService = real;
    await reset();
  });
});

describe('a revive makes the checks a boot makes', () => {
  it('the layout check a reload makes: it is asked about the running tenants and the revived one, and a clash it reports keeps the tenant down, with the line', async () => {
    expect((await park('ada')).status).toBe(200);
    vi.mocked(layoutClash).mockClear();
    vi.mocked(layoutClash).mockImplementationOnce((tenants) => new Map([['ada', `its writable root touches tenant bea's data/ (${tenants.length} checked)`]]));
    const r = await revive('ada');
    expect(r.status).toBe(500);
    expect(r.json.state).toBe('parked');
    expect(r.json.error).toBe("its writable root touches tenant bea's data/ (2 checked)");
    expect(vi.mocked(layoutClash).mock.calls[0][0].map((t) => t.id).sort()).toEqual(['ada', 'bea']);
    expect(tenantLifecycle()!.runtimes.has('ada')).toBe(false);
    expect((await revive('ada')).status).toBe(200); // (the same files, no clash reported)
    await reset();
  });

  it('a host a running tenant serves is not the revived tenant\'s', async () => {
    expect((await park('ada')).status).toBe(200);
    writeYaml('ada', GOOD('ada').replace('hosts: [ada.example.net]', 'hosts: [bea.example.net]'));
    const r = await revive('ada');
    expect(r.status).toBe(500);
    expect(r.json.error).toContain('is served by another tenant');
    expect((await ping('bea')).json).toEqual({ id: 'bea' });
    await reset();
  });

  it('a host two tenants once claimed (contested) is dropped from the revived tenant, not served', async () => {
    expect((await park('ada')).status).toBe(200);
    tenantLifecycle()!.contested.add('ada.example.net');
    const r = await revive('ada');
    expect(r.status).toBe(200);
    expect(live('ada').hosts).not.toContain('ada.example.net');
    expect((await ping('ada')).status).toBe(503);
    await reset();
  });

  it('Revien is reconciled from every tenant\'s files: a daemon address another tenant uses parks it on revive, and the other tenant is not written', async () => {
    expect((await park('ada')).status).toBe(200);
    writeYaml('ada', GOOD('ada', REVIEN(59912)));
    expect((await revive('ada')).status).toBe(200);
    const a = live('ada');
    expect(a.config.revien.enabled).toBe(false);
    expect(a.revienParkedBy).toEqual(['bea']);
    expect(bea.config.revien.enabled).toBe(true);
    expect(bea.revienParkedBy ?? []).toEqual([]);
    await reset();
  });
});
