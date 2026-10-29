// Pass-2 hardening: things a tenant could reach in the process or in another tenant, each pinned by a test that failed before its fix.
import { describe, it, expect, afterEach, beforeAll, beforeEach, afterAll } from 'vitest';
import { enableTenancy, runInTenant } from './context.js';
import { fakeRuntime, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { describeMindSettingsFrom } from '../services/mind-client.js';

afterEach(async () => { await stopBootedTenants(); enableTenancy(false); delete process.env.MIND_API_KEY; });

describe('finding 2: the process MIND_API_KEY never reaches a tenant', () => {
  const read = (k: string) => ({ 'mind.enabled': 'true', 'mind.url': 'https://sink.example.net/mcp', 'mind.mind_id': 'm1' } as Record<string, string>)[k] ?? '';
  it('is not used in tenant mode, and the tenant own .env key is', () => {
    process.env.MIND_API_KEY = 'PROCESS-BEARER';
    enableTenancy(true);
    const none = runInTenant(fakeRuntime('ada', { env: {} }), () => describeMindSettingsFrom({ read }));
    expect(none.settings).toBeNull();
    expect(none.missing).toContain('api key');
    const own = runInTenant(fakeRuntime('bea', { env: { MIND_API_KEY: 'BEA-BEARER' } }), () => describeMindSettingsFrom({ read }));
    expect(own.settings?.bearer).toBe('BEA-BEARER');
  });
  it('single-tenant still reads the process environment', () => {
    process.env.MIND_API_KEY = 'PROCESS-BEARER';
    expect(describeMindSettingsFrom({ read }).settings?.bearer).toBe('PROCESS-BEARER');
  });
});

// ---- finding 3, 6, 7, 8: shared or credential-bound routes are refused in tenant mode ------------------------------------------------
import type { Request, Response } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountTenantRefusals, REFUSED_PREFIXES } from './guard.js';

describe('findings 3, 6, 7, 8 (and pass 3 #1): refused prefixes, any case, any method', () => {
  const caseVariants = (p: string) => [p, p.toUpperCase().replace(/:ID/, ':id'), p.replace(/(^|\/)([a-z])/g, (_m, a, c) => a + c.toUpperCase())];
  const app = express();
  mountTenantRefusals(app);
  app.use((_req, res) => res.json({ reached: true }));
  let srv: http.Server;
  let port = 0;
  beforeAll(async () => { await new Promise<void>((ok) => { srv = app.listen(0, '127.0.0.1', () => ok()); }); port = (srv.address() as AddressInfo).port; });
  afterAll(async () => { await new Promise<void>((ok) => srv.close(() => ok())); });
  const hit = (method: string, path: string) => new Promise<{ status: number; body: any }>((ok, fail) => {
    const r = http.request({ host: '127.0.0.1', port, method, path }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode ?? 0, body: JSON.parse(b) })); });
    r.on('error', fail); r.end();
  });
  const concrete = (p: string) => p.replace(':id', 'abc');

  it('the refused list is empty in this stage: mounting refusals adds nothing and every /api path reaches the handler (a list that is not empty is refused below)', async () => {
    if (REFUSED_PREFIXES.length > 0) { expect((await hit('GET', concrete(`/api/${REFUSED_PREFIXES[0]}`))).status).toBe(503); return; }
    const bare = express();
    const before = (bare as unknown as { _router?: { stack: unknown[] } })._router?.stack.length ?? 0;
    mountTenantRefusals(bare);
    expect((bare as unknown as { _router?: { stack: unknown[] } })._router?.stack.length ?? 0).toBe(before);
    for (const p of ['/api/telegram/x', '/api/discord', '/api/channels', '/api/internal/telegram-send']) {
      const r = await hit('GET', p);
      expect(r.status, p).toBe(200);
      expect(r.body.reached).toBe(true);
    }
  });
  for (const prefix of REFUSED_PREFIXES) {
    it(`/api/${prefix} answers 503 in lower, upper and mixed case, GET and POST, and below it`, async () => {
      for (const variant of caseVariants(`/api/${prefix}`)) {
        for (const method of ['GET', 'POST']) {
          for (const suffix of ['', '/x']) {
            const r = await hit(method, concrete(variant) + suffix);
            expect(r.status, `${method} ${concrete(variant)}${suffix}`).toBe(503);
            expect(r.body.error).toBe('service_unavailable');
          }
        }
      }
    });
  }
  it.each(['/api/threads', '/api/messages/abc/reactions', '/api/files/browse', '/api/auth/check', '/api/preferences', '/api/outlooks', '/api/config/raw'])('%s passes', async (path) => {
    expect((await hit('GET', path)).body).toEqual({ reached: true });
  });
});

// ---- finding 4: a tenant's files stay in the tenant's folder ---------------------------------------------------------------------
import { mkdirSync, symlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isInsideDir, pathProblems, tenantYamlEditProblem } from './confine.js';
import { loadTenantConfig } from './config.js';
import { makeTenantsDir, processConfigFor } from './test-runtime.js';
import { getSafeWritePrefixes } from '../services/hooks.js';

describe('finding 4: confinement', () => {
  const proc = () => processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  it('isInsideDir: inside, outside, dot-dot, sibling prefix, ~, and a symlink out', () => {
    const root = mkdtempSync(join(tmpdir(), 'sanctum-confine-'));
    const dir = join(root, 'ada');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'ada-evil'), { recursive: true });
    mkdirSync(join(root, 'bea'), { recursive: true });
    expect(isInsideDir(dir, 'home')).toBe(true);
    expect(isInsideDir(dir, join(dir, 'a', 'b', 'not-yet'))).toBe(true);
    expect(isInsideDir(dir, join(root, 'bea'))).toBe(false);
    expect(isInsideDir(dir, join(root, 'ada-evil'))).toBe(false);
    expect(isInsideDir(dir, '../bea')).toBe(false);
    expect(isInsideDir(dir, '~/x')).toBe(false);
    try { symlinkSync(join(root, 'bea'), join(dir, 'link'), 'junction'); expect(isInsideDir(dir, join(dir, 'link', 'x'))).toBe(false); } catch { /* no symlinks here */ }
  });
  it('tenant load refuses an absolute agent.cwd, a hooks root, and a ledger dir outside the folder', () => {
    const outside = join(tmpdir(), 'sanctum-elsewhere');
    for (const [yamlText, key] of [[`agent:\n  cwd: ${JSON.stringify(outside)}\n`, 'agent.cwd'], [`hooks:\n  workspace_root: ${JSON.stringify(outside)}\n`, 'hooks.workspace_root'],
      [`identity:\n  ledger_dir: ${JSON.stringify(outside)}\n`, 'identity.ledger_dir'], [`hooks:\n  extra_write_paths: [${JSON.stringify(outside)}]\n`, 'hooks.extra_write_paths'],
      ['agent:\n  mcp_json_path: ../other/.mcp.json\n', 'agent.mcp_json_path'], [`orchestrator:\n  wake_prompts_dir: ${JSON.stringify(outside)}\n`, 'orchestrator.wake_prompts_dir']]) {
      const root = makeTenantsDir({ ada: { yaml: yamlText } });
      expect(() => loadTenantConfig(proc(), join(root, 'ada'), 'ada'), key).toThrow(new RegExp(key.replace('.', '\\.')));
    }
  });
  it("tenant load refuses a write root that came from the tenant's own .env", () => {
    const root = makeTenantsDir({ ada: { env: `WORKSPACE_ROOT=${join(tmpdir(), 'sanctum-elsewhere')}\n` } });
    expect(() => loadTenantConfig(proc(), join(root, 'ada'), 'ada')).toThrow(/hooks\.workspace_root/);
  });
  it('a tenant with only relative, inside paths loads', () => {
    const root = makeTenantsDir({ ada: { yaml: 'agent:\n  cwd: me\nhooks:\n  workspace_root: me/work\n' } });
    expect(() => loadTenantConfig(proc(), join(root, 'ada'), 'ada')).not.toThrow();
    expect(pathProblems({ agent: { cwd: 'x' } }, join(root, 'ada'), { shipped: true })).toEqual([]);
  });
  it('getSafeWritePrefixes (the browse roots and the write gate) drops roots outside the tenant folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'sanctum-wp-'));
    const dir = join(root, 'ada');
    mkdirSync(dir, { recursive: true });
    const cfg = processConfigFor(root, { hooks: { workspace_root: join(root, 'bea') } });
    cfg.agent.cwd = join(dir, 'home');
    enableTenancy(true);
    const prefixes = runInTenant(fakeRuntime('ada', { dir, config: cfg }), () => getSafeWritePrefixes());
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.every((p) => !p.replace(/\\/g, '/').startsWith(join(root, 'bea').replace(/\\/g, '/')))).toBe(true);
    expect(prefixes.some((p) => p.replace(/\\/g, '/').includes('/ada/home'))).toBe(true);
  });
  it('tenantYamlEditProblem refuses hosts, timezone, process keys and outside paths, and allows an ordinary edit', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sanctum-edit-')), 'ada');
    mkdirSync(dir, { recursive: true });
    const current = { hosts: ['ada.example.net'], identity: { timezone: 'UTC', companion_name: 'A' } };
    expect(tenantYamlEditProblem({ ...current, identity: { ...current.identity, companion_name: 'B' } }, current, dir)).toBeNull();
    expect(tenantYamlEditProblem({ ...current, hosts: ['bea.example.net'] }, current, dir)).toMatch(/hosts/);
    expect(tenantYamlEditProblem({ ...current, identity: { timezone: 'Europe/Paris' } }, current, dir)).toMatch(/timezone/);
    expect(tenantYamlEditProblem({ ...current, server: { port: 1 } }, current, dir)).toMatch(/server/);
    expect(tenantYamlEditProblem({ ...current, agent: { cwd: join(dir, '..', 'bea') } }, current, dir)).toMatch(/agent\.cwd/);
  });
});

// ---- finding 5: one tenant's mistake never stops the process booting --------------------------------------------------------------
import express from 'express';
import { vi } from 'vitest';
import { bootTenants } from './boot.js';
import { setTenantRegistry, setReservedHosts, tenantResolve } from './resolve.js';

describe('finding 5: bad tenants are skipped at boot, not thrown', () => {
  it('skips a malformed yaml, a timezone mismatch and an outside path; boots the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = makeTenantsDir({
      ada: { yaml: 'hosts: [ada.example.net]\n' },
      bad1: { yaml: '- not\n- a mapping\n' },
      bad2: { yaml: 'hosts: [ada.example.net]\n' },
      bad3: { yaml: 'identity:\n  timezone: Europe/Paris\n' },
      bad4: { yaml: 'agent:\n  cwd: ../ada\n' },
    });
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    (proc as unknown as { tenants: unknown }).tenants = { dir: root };
    const rts = bootTenants(express(), safeTenancyProcess(proc));
    try {
      expect([...rts.keys()]).toEqual(['ada', 'bad2']); // bad2 is fine on its own: only the host it shares with ada is lost
      expect(rts.get('ada')!.hosts).toEqual([]);
      expect(rts.get('bad2')!.hosts).toEqual([]);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      for (const id of ['bad1', 'bad3', 'bad4']) expect(lines.filter((l) => l.includes(`tenant ${id} skipped`))).toHaveLength(1);
    } finally {
      for (const r of rts.values()) r.db.close();
      enableTenancy(false);
      setTenantRegistry(new Map());
      vi.restoreAllMocks();
    }
  });
  it('still stops for the operator mistakes: no tenant usable, a default that has no folder', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    (proc as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({ bad: { yaml: '- x\n' } }) };
    expect(() => bootTenants(express(), safeTenancyProcess(proc))).toThrow(/no tenant/);
    (proc as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({ ada: {} }), default: 'zed' };
    expect(() => bootTenants(express(), safeTenancyProcess(proc))).toThrow(/no tenant folder/);
    vi.restoreAllMocks();
  });
});

// ---- finding 10 and the nits: the 503 error is one line; a trailing dot is the same host ------------------------------------------------
import { TenantServiceUnavailable } from './errors.js';
import { requestHost } from './resolve.js';

describe('finding 10: TenantServiceUnavailable', () => {
  it('has no stack, only one line', () => {
    expect(new TenantServiceUnavailable('orchestrator').stack).toBe('TenantServiceUnavailable: orchestrator is not available per tenant yet');
  });
  it('plain errors stay 500, unavailable services are 503 through a catching handler, and nothing crosses requests', async () => {
    const { handleUnavailable } = await import('./errors.js');
    const { globalErrorHandler } = await import('../middleware/error-handler.js');
    const app = express();
    app.locals.__x = null;
    Object.defineProperty(app.locals, 'svc', { get() { throw new TenantServiceUnavailable('svc'); } });
    app.get('/plain', (_req, res) => { try { throw new Error('boom'); } catch (e) { if (handleUnavailable(e, res)) return; res.status(500).json({ error: 'plain' }); } });
    app.get('/unavailable', async (req, res) => { try { void req.app.locals.svc; res.json({}); } catch (e) { if (handleUnavailable(e, res)) return; res.status(500).json({ error: 'plain' }); } });
    app.get('/bad-gateway', (_req, res) => { res.status(502).json({ error: 'upstream' }); });
    app.get('/uncaught', (req) => { void req.app.locals.svc; });
    app.use(globalErrorHandler);
    const srv = await new Promise<http.Server>((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
    const port = (srv.address() as AddressInfo).port;
    const get = async (path: string) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, body: await r.json() }; };
    try {
      expect(await get('/unavailable')).toEqual({ status: 503, body: { error: 'service_unavailable', service: 'svc' } });
      expect(await get('/plain')).toEqual({ status: 500, body: { error: 'plain' } });
      expect(await get('/bad-gateway')).toEqual({ status: 502, body: { error: 'upstream' } });
      expect((await get('/uncaught')).status).toBe(503);
      expect((await get('/plain')).status).toBe(500);
    } finally { await new Promise<void>((ok) => srv.close(() => ok())); }
  });
});

describe('nits', () => {
  it('requestHost drops a trailing dot, with and without a port', () => {
    expect(requestHost({ host: 'ada.example.net.' })).toBe('ada.example.net');
    expect(requestHost({ host: 'Ada.Example.NET.:3000' })).toBe('ada.example.net');
  });
});

// ---- pass 3 #2: rolling-context is one instance per tenant -----------------------------------------------------------------------------
import { getRolling } from '../services/rolling-context.js';

describe('pass 3 #2: getRolling per tenant', () => {
  it('gives two tenants two instances, each stable, and the first caller does not fix the folder for the second', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sanctum-roll-'));
    const mk = (id: string) => { const cfg = processConfigFor(root); cfg.server.db_path = join(root, id, 'data', 'sanctum.db'); return fakeRuntime(id, { config: cfg }); };
    const ada = mk('ada');
    const bea = mk('bea');
    enableTenancy(true);
    const a1 = runInTenant(ada, () => getRolling());
    const b1 = runInTenant(bea, () => getRolling());
    expect(a1).not.toBe(b1);
    expect(runInTenant(ada, () => getRolling())).toBe(a1);
    expect(runInTenant(bea, () => getRolling())).toBe(b1);
    expect(() => getRolling()).toThrow(/outside a tenant context/);
    await expect(runInTenant(ada, () => a1.health())).resolves.toBeDefined();
  });
});

// ---- pass 3 #3: host ownership does not depend on which tenants load -------------------------------------------------------------
import { loadTenantConfig as loadTenantCfg } from './config.js';

describe('pass 3 #3: reserved hosts and the config dry run', () => {
  const boot = (tenants: Record<string, { yaml?: string }>, def?: string) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    (proc as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir(tenants), default: def };
    return bootTenants(express(), safeTenancyProcess(proc));
  };
  const after = (rts: Map<string, { db: { close(): void } }>) => { for (const r of rts.values()) r.db.close(); enableTenancy(false); setTenantRegistry(new Map()); setReservedHosts([]); vi.restoreAllMocks(); };
  const respond = (host: string) => {
    const out = { code: 0, body: undefined as any, status(c: number) { out.code = c; return out; }, json(b: unknown) { out.body = b; return out; } };
    let passed: string | null = null;
    const req = { headers: { host } } as unknown as Request;
    tenantResolve(req, out as unknown as Response, () => { passed = req.tenant?.id ?? ''; });
    return { code: out.code, body: out.body, passed };
  };

  it('(a) a skipped tenant host answers 503 tenant_unavailable, not the default and not another tenant', () => {
    const rts = boot({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: 'hosts: [bea.example.net]\nagent: 5\n' } }, 'ada');
    try {
      expect([...rts.keys()]).toEqual(['ada']);
      expect(respond('bea.example.net')).toMatchObject({ code: 503, body: { error: 'tenant_unavailable' }, passed: null });
      expect(respond('ada.example.net').passed).toBe('ada');
      expect(respond('unknown.example.net').passed).toBe('ada'); // the default still serves hosts nobody claims
    } finally { after(rts); }
  });

  it('(a) a malformed yaml still reserves the hosts it names', () => {
    const rts = boot({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: 'hosts: [bea.example.net]\n- broken\n' } });
    try { expect(respond('bea.example.net').code).toBe(503); } finally { after(rts); }
  });

  it('(b) a host two tenants claim is served by neither, and answers 503', () => {
    const rts = boot({ ada: { yaml: 'hosts: [ada.example.net, shared.example.net]\n' }, bea: { yaml: 'hosts: [bea.example.net, shared.example.net]\n' } }, 'ada');
    try {
      expect(respond('shared.example.net')).toMatchObject({ code: 503, body: { error: 'tenant_unavailable' }, passed: null });
      const withToken = { code: 0, status(c: number) { this.code = c; return this; }, json() { return this; } };
      tenantResolve({ headers: { host: 'shared.example.net', 'x-internal-token': rts.get('bea')!.token } } as unknown as Request, withToken as unknown as Response, () => { throw new Error('must not pass'); });
      expect(withToken.code).toBe(503);
      expect(respond('ada.example.net').passed).toBe('ada');
      expect(respond('bea.example.net').passed).toBe('bea');
    } finally { after(rts); }
  });

  it('(c) the dry run refuses a candidate yaml the tenant could not start with, and accepts a good one', () => {
    const root = makeTenantsDir({ ada: {} });
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    const dry = (fileCfg: unknown) => loadTenantCfg(proc, join(root, 'ada'), 'ada', { fileCfg, quiet: true });
    expect(() => dry({ agent: 5 })).toThrow();
    expect(() => dry({ identity: 'x' })).toThrow();
    expect(() => dry({ hosts: 5 })).toThrow(/hosts/);
    expect(() => dry('text')).toThrow(/mapping/);
    expect(() => dry({ identity: { companion_name: 'Ada' } })).not.toThrow();
  });
});

// ---- pass 3 #5: Google credentials and token secret come from the tenant, never the process ------------------------------------------
import { createTenantRuntime } from './runtime.js';
import { isConfigured, encryptSecret, decryptSecret } from '../services/google-auth.js';

describe('pass 3 #5: google-auth in tenant mode', () => {
  const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_TOKEN_SECRET'];
  const saved: Record<string, string | undefined> = {};
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const mk = (env: string) => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.GOOGLE_CLIENT_ID = 'proc-id'; process.env.GOOGLE_CLIENT_SECRET = 'proc-secret'; process.env.GOOGLE_TOKEN_SECRET = 'proc-token-secret';
    const root = makeTenantsDir({ ada: { env } });
    return createTenantRuntime(processConfigFor(join(root, 'p')), 'ada', join(root, 'ada'), {});
  };
  it('a tenant without those keys sees no Google credentials, and its sealed secrets do not open with the process key', () => {
    const rt = mk('');
    enableTenancy(true);
    try {
      expect(runInTenant(rt, () => isConfigured())).toBe(false);
      const blob = runInTenant(rt, () => encryptSecret('refresh-token'));
      enableTenancy(false);
      expect(decryptSecret(blob)).toBeNull(); // single-tenant would use GOOGLE_TOKEN_SECRET=proc-token-secret
      enableTenancy(true);
      expect(runInTenant(rt, () => decryptSecret(blob))).toBe('refresh-token');
    } finally { enableTenancy(false); rt.db.close(); }
  });
  it("a tenant's own .env keys are used", () => {
    const rt = mk('GOOGLE_CLIENT_ID=own-id\nGOOGLE_CLIENT_SECRET=own-secret\n');
    enableTenancy(true);
    try { expect(runInTenant(rt, () => isConfigured())).toBe(true); } finally { enableTenancy(false); rt.db.close(); }
  });
});

// ---- pass 3 #8: write roots resolve against the tenant folder ------------------------------------------------------------------------
describe('pass 3 #8: hooks paths in a tenant', () => {
  const proc = () => processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  it('a relative workspace_root, vault_path and list entries are the tenant folder', () => {
    const root = makeTenantsDir({ ada: { yaml: 'hooks:\n  workspace_root: .\n  vault_path: notes\n  extra_write_paths: [a/b]\n  safe_write_prefixes: [c]\n' } });
    const dir = join(root, 'ada');
    const { config } = loadTenantConfig(proc(), dir, 'ada');
    expect(config.hooks.workspace_root).toBe(resolve(dir));
    expect(config.hooks.vault_path).toBe(resolve(dir, 'notes'));
    expect(config.hooks.extra_write_paths).toEqual([resolve(dir, 'a', 'b')]);
    expect(config.hooks.safe_write_prefixes).toEqual([resolve(dir, 'c')]);
  });
  it('the string form of a list key is checked like the list (load and edit)', () => {
    const outside = join(tmpdir(), 'sanctum-elsewhere');
    const root = makeTenantsDir({ ada: { yaml: `hooks:\n  extra_write_paths: ${JSON.stringify(outside)}\n` } });
    expect(() => loadTenantConfig(proc(), join(root, 'ada'), 'ada')).toThrow(/extra_write_paths/);
    expect(tenantYamlEditProblem({ hooks: { extra_write_paths: outside } }, {}, join(root, 'ada'))).toMatch(/extra_write_paths/);
    expect(tenantYamlEditProblem({ agent: { codex: { additional_directories: outside } } }, {}, join(root, 'ada'))).toMatch(/additional_directories/);
  });
  it('a string list inside the folder loads as a list of one', () => {
    const root = makeTenantsDir({ ada: { yaml: 'hooks:\n  extra_write_paths: work\n' } });
    expect(loadTenantConfig(proc(), join(root, 'ada'), 'ada').config.hooks.extra_write_paths).toEqual([resolve(root, 'ada', 'work')]);
  });
});

// ---- pass 4 #1: odd spellings of a refused path never reach a handler ----------------------------------------------------------------
import { refuseInTenantMode } from './guard.js';

describe('pass 4 #1: // and friends', () => {
  let srv: http.Server;
  let port = 0;
  let reached = 0;
  beforeAll(async () => {
    enableTenancy(true);
    setTenantRegistry(new Map([['ada', fakeRuntime('ada')]]));
    const app = express();
    app.use(tenantResolve);
    mountTenantRefusals(app);
    const api = express.Router();
    api.use(refuseInTenantMode);
    api.use((_req, res) => { reached++; res.json({ reached: true }); });
    app.use('/api', api);
    app.use((_req, res) => { reached++; res.json({ reached: true }); });
    await new Promise<void>((ok) => { srv = app.listen(0, '127.0.0.1', () => ok()); });
    port = (srv.address() as AddressInfo).port;
  });
  beforeEach(() => enableTenancy(true)); // the file's afterEach switches it off
  afterAll(async () => { await new Promise<void>((ok) => srv.close(() => ok())); enableTenancy(false); setTenantRegistry(new Map()); });
  const hit = (method: string, path: string) => new Promise<number>((ok, fail) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: 'ada.example.net' } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode ?? 0)); });
    r.on('error', fail); r.end();
  });
  const spellings = (p: string) => [`/api//${p}`, `/api///${p}`, `//api/${p}`, `/api/x/../${p}`, `/api/./${p}`, `/api/${p.toUpperCase()}`, `/api/${p}/`, `/api//${p.toUpperCase()}/`, `/api/${p.replace('/', '%2F')}`, `/api\\${p}`];
  it('the refused list is empty in this stage: refuseInTenantMode passes every spelling through to the handler', async () => {
    if (REFUSED_PREFIXES.length > 0) return; // (the per-prefix cases below cover a list that is not empty)
    const before = reached;
    let ok = 0;
    for (const p of ['/api/telegram/x', '/api//discord', '/api/CHANNELS', '/api/internal/telegram-send']) {
      const status = await hit('GET', p);
      expect([200, 400], p).toContain(status); // (400: express refuses the odd spelling itself; never 503)
      if (status === 200) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(3);
    expect(reached).toBe(before + ok);
  });
  for (const prefix of REFUSED_PREFIXES) {
    it(`/api/${prefix}: every spelling answers 503 or 400, HEAD and POST and GET, and never reaches a handler`, async () => {
      const before = reached;
      const concrete = prefix.replace(':id', 'abc');
      for (const path of spellings(concrete)) {
        for (const method of ['GET', 'POST', 'HEAD']) {
          const status = await hit(method, path + (method === 'GET' ? '?q=1' : ''));
          expect([503, 400], `${method} ${path}`).toContain(status);
        }
      }
      expect(reached).toBe(before);
    });
  }
  it('the router-level refusal alone also catches // (the app-level mount cannot see it)', async () => {
    // (3c emptied the list; the machinery is tested with the prefixes it was written for, put back after.)
    const previous = REFUSED_PREFIXES.splice(0, REFUSED_PREFIXES.length, 'channels', 'telegram', 'discord');
    const app = express();
    const api = express.Router();
    api.use(refuseInTenantMode);
    api.use((_req, res) => { res.json({ reached: true }); });
    app.use('/api', api);
    const s = await new Promise<http.Server>((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
    const p = (s.address() as AddressInfo).port;
    try {
      const get = (path: string) => new Promise<number>((ok, fail) => { http.get({ host: '127.0.0.1', port: p, path }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode ?? 0)); }).on('error', fail); });
      expect(await get('/api//channels')).toBe(503);
      expect(await get('/api///Telegram/run/')).toBe(503);
      expect(await get('/api//discord/x/wake')).toBe(503); // (was /api//messages/x/regenerate: live per tenant since 3a)
      expect(await get('/api/threads')).toBe(200);
    } finally { REFUSED_PREFIXES.splice(0, REFUSED_PREFIXES.length, ...previous); await new Promise<void>((ok) => s.close(() => ok())); }
  });
  it('without tenancy the router-level refusal is a pass-through', async () => {
    enableTenancy(false);
    let passed = false;
    refuseInTenantMode({ path: '/outlook' } as Request, {} as Response, () => { passed = true; });
    expect(passed).toBe(true);
    enableTenancy(true);
  });
});

// ---- pass 4 #2: a scalar hosts: is one host -------------------------------------------------------------------------------------------
import { readHostsLoosely } from './config.js';

describe('pass 4 #2: scalar hosts', () => {
  it('readHostsLoosely reads a string as one host (so a skipped tenant still reserves it)', () => {
    const root = makeTenantsDir({ ada: { yaml: 'hosts: Scal.Example.NET.\nagent: 5\n' } });
    expect(readHostsLoosely(join(root, 'ada'))).toEqual(['scal.example.net']);
  });
  it('parseHosts accepts a string as a list of one, with a warning, and the tenant loads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = makeTenantsDir({ ada: { yaml: 'hosts: scal.example.net\n' } });
    const loaded = loadTenantConfig(processConfigFor(resolve(tmpdir(), 'sanctum-process')), join(root, 'ada'), 'ada');
    expect(loaded.hosts).toEqual(['scal.example.net']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('one hostname'))).toBe(true);
    vi.restoreAllMocks();
  });
});
