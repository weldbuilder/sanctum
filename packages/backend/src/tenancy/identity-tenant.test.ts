// Identity per tenant: the guard's listener and the notice's "already pushed" state are one per tenant, the ledger, journal and snapshots
// live in each tenant's data/identity, and a ratify on one tenant never reaches the other's ledger. Real express, real auth, no provider key.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { authMiddleware, loginHandler } from '../middleware/auth.js';
import { identityRouter, identityInternalRouter } from '../routes/identity.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import { startIdentityGate } from '../services/identity/notify.js';
import { identityForRun } from '../services/identity/guard.js';

const A = 'ada.example.net';
const B = 'bea.example.net';
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;

function call(method: string, path: string, host: string, opts: { cookie?: string; json?: unknown } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { host };
    if (opts.cookie) headers.cookie = opts.cookie;
    let payload: Buffer | undefined;
    if (opts.json !== undefined) { payload = Buffer.from(JSON.stringify(opts.json)); headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = JSON.parse(body); } catch { /* not json */ }
        ok({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}
async function login(host: string, password: string): Promise<string> {
  const r = await call('POST', '/api/auth/login', host, { json: { password } });
  return (r.headers['set-cookie']?.[0] ?? '').split(';')[0];
}
const ledgerDirOf = (rt: TenantRuntime) => join(rt.dataDir, 'identity');
function writeIdentity(rt: TenantRuntime, profile: string): void {
  mkdirSync(join(rt.homeDir, 'identity'), { recursive: true });
  writeFileSync(join(rt.homeDir, 'identity', 'profile.md'), profile);
  writeFileSync(join(rt.homeDir, 'identity', 'companion.md'), `companion of ${rt.id}`);
}
const systemLines = (rt: TenantRuntime) => (rt.db.prepare("SELECT content FROM messages WHERE role = 'system'").all() as { content: string }[]).map((r) => r.content);

let cookieA = '';
let cookieB = '';

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const root = makeTenantsDir({
    ada: { yaml: `hosts: [${A}]\n`, env: 'APP_PASSWORD=pw-ada\n' },
    bea: { yaml: `hosts: [${B}]\n`, env: 'APP_PASSWORD=pw-bea\n' },
  });
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (proc as unknown as { tenants: unknown }).tenants = { dir: root };
  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.use('/api/identity', identityRouter);
  app.use('/api/internal/identity', identityInternalRouter);
  app.use(globalErrorHandler);
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
  cookieA = await login(A, 'pw-ada');
  cookieB = await login(B, 'pw-bea');
});

afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false);
  setTenantRegistry(new Map());
  vi.restoreAllMocks();
});

describe('identity per tenant', () => {
  it('the ledger folder is inside each tenant folder, and the two differ', () => {
    expect(ada.config.identity.ledger_dir).toBe(ledgerDirOf(ada));
    expect(bea.config.identity.ledger_dir).toBe(ledgerDirOf(bea));
    expect(ledgerDirOf(ada)).not.toBe(ledgerDirOf(bea));
  });

  it('ratify on A writes ledger, journal and snapshot under A data/identity; B has none and B ledger bytes do not move', async () => {
    writeIdentity(ada, 'ada profile');
    writeIdentity(bea, 'bea profile');
    const beaStatus = await call('GET', '/api/identity/status', B, { cookie: cookieB });
    expect(beaStatus.status).toBe(200);
    const beaLedger = join(ledgerDirOf(bea), 'ledger.json');
    const beaBefore = existsSync(beaLedger) ? readFileSync(beaLedger) : null;

    const adaStatus = await call('GET', '/api/identity/status', A, { cookie: cookieA });
    const ratified = await call('POST', '/api/identity/ratify', A, { cookie: cookieA, json: { digest: adaStatus.json.digest } });
    expect(ratified.status).toBe(200);
    expect(existsSync(join(ledgerDirOf(ada), 'ledger.json'))).toBe(true);
    expect(existsSync(join(ledgerDirOf(ada), 'journal.jsonl'))).toBe(true);
    expect(readdirSync(join(ledgerDirOf(ada), 'snapshots')).length).toBeGreaterThan(0);

    const beaAfter = existsSync(beaLedger) ? readFileSync(beaLedger) : null;
    expect(beaAfter).toEqual(beaBefore);
    expect(existsSync(join(ledgerDirOf(bea), 'snapshots'))).toBe(false);
  });

  it("B's status on B's host never carries A's digest", async () => {
    const a = await call('GET', '/api/identity/status', A, { cookie: cookieA });
    const b = await call('GET', '/api/identity/status', B, { cookie: cookieB });
    expect(a.json.digest).toBeTruthy();
    expect(b.json.digest).toBeTruthy();
    expect(b.json.digest).not.toBe(a.json.digest);
    expect(b.body).not.toContain(a.json.digest);
    // And A's cookie on B's host is no session there at all.
    expect((await call('GET', '/api/identity/status', B, { cookie: cookieA })).status).toBe(401);
  });

  it('two tenants with pending changes keep separate pending state, listeners and thread lines', async () => {
    const bs = await call('GET', '/api/identity/status', B, { cookie: cookieB });
    expect((await call('POST', '/api/identity/ratify', B, { cookie: cookieB, json: { digest: bs.json.digest } })).status).toBe(200);
    // A changes on disk; B changes differently.
    writeFileSync(join(ada.homeDir, 'identity', 'profile.md'), 'ada profile, edited');
    writeFileSync(join(bea.homeDir, 'identity', 'companion.md'), 'bea companion, edited');
    // The checks that notice run in each tenant, as a harness run would.
    runInTenant(ada, () => identityForRun(ada.config, { harness: 'claude' }));
    runInTenant(bea, () => identityForRun(bea.config, { harness: 'claude' }));

    const a = await call('GET', '/api/identity/status', A, { cookie: cookieA });
    const b = await call('GET', '/api/identity/status', B, { cookie: cookieB });
    expect(a.json.state).toBe('pending');
    expect(b.json.state).toBe('pending');
    expect(a.json.pending.changes.map((c: { path: string }) => c.path)).toEqual(['profile.md']);
    expect(b.json.pending.changes.map((c: { path: string }) => c.path)).toEqual(['companion.md']);
    expect(a.json.digest).not.toBe(b.json.digest);

    // One thread line each, in that tenant's own database, naming that tenant's file only.
    const la = systemLines(ada).filter((t) => t.startsWith('Identity change waiting'));
    const lb = systemLines(bea).filter((t) => t.startsWith('Identity change waiting'));
    expect(la).toHaveLength(1);
    expect(lb).toHaveLength(1);
    expect(la[0]).toContain('profile.md');
    expect(la[0]).not.toContain('companion.md');
    expect(lb[0]).toContain('companion.md');
    expect(lb[0]).not.toContain('profile.md');

    // Ratifying A's change leaves B's still pending.
    expect((await call('POST', '/api/identity/ratify', A, { cookie: cookieA, json: { digest: a.json.digest } })).status).toBe(200);
    expect((await call('GET', '/api/identity/status', A, { cookie: cookieA })).json.state).toBe('ok');
    expect((await call('GET', '/api/identity/status', B, { cookie: cookieB })).json.state).toBe('pending');
  });

  it('startIdentityGate registers a listener per tenant (running it again in one tenant does not touch the other)', () => {
    expect(() => runInTenant(ada, () => startIdentityGate())).not.toThrow();
    runInTenant(bea, () => identityForRun(bea.config, { harness: 'claude' }));
    expect(systemLines(bea).filter((t) => t.startsWith('Identity change waiting'))).toHaveLength(1);
  });
});
