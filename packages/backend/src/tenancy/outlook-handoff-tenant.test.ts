// Outlook and the midnight handoff per tenant (stage 3b), through the real routes. A FAKE provider answers the author and handoff runs: no model,
// no key. A's snapshot is never served to B; a reauthor on A runs with A's env (never a process credential) and stores into A's database; a handoff
// on A reads and writes A's database only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({
  id: (): string => '',
  seen: [] as { id: string; env?: Record<string, string | undefined>; cwd?: string; system?: string }[],
  fake: (p: { options?: { env?: Record<string, string | undefined>; cwd?: string; systemPrompt?: string } }) => {
    const id = h.id();
    h.seen.push({ id, env: p.options?.env, cwd: p.options?.cwd, system: p.options?.systemPrompt });
    const text = JSON.stringify({ opener: `OPENER-${id}`, carry: `CARRY-${id}`, presence: { mood: `mood-${id}` }, topics: [], needsYou: [{ kind: 'notice', text: `NEEDS-${id}` }] });
    const it = (async function* () {
      yield { type: 'assistant', session_id: `s-${id}`, message: { content: [{ type: 'text', text }] } };
      yield { type: 'result', subtype: 'success', session_id: `s-${id}` };
    })();
    return Object.assign(it, { mcpServerStatus: async () => [], interrupt: async () => {}, close: () => {} });
  },
}));

// The turn provider (nothing here takes a turn) and the SDK the summarizer's Claude side-run uses (the author and the handoff run through it).
vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: (p: Parameters<typeof h.fake>[0]) => h.fake(p),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (p: Parameters<typeof h.fake>[0]) => h.fake(p) }));
vi.mock('../services/rolling-context.js', async (orig) => ({ ...(await orig<object>()), getRolling: () => ({ maybeCompact: async () => {}, readTurns: async () => [] }), rollingEnabledForActiveProvider: () => false }));
vi.mock('../services/revien.js', async (orig) => ({ ...(await orig<object>()), recallForPrompt: async () => '', ingestTurn: async () => {} }));

import { bootTenants, stopTenantServices } from './boot.js';
import { currentTenant, enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import { createMessage, createThread, getConfig, getDb, getThread } from '../services/db.js';

h.id = () => currentTenant()?.id ?? '';
const A = 'ada.example.net';
const B = 'bea.example.net';
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

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { orchestrator: { enabled: false } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
    ada: { yaml: `hosts: [${A}]\n`, env: 'APP_PASSWORD=pw-ada\n' },
    bea: { yaml: `hosts: [${B}]\n`, env: 'APP_PASSWORD=pw-bea\n' },
  }) };
  process.env.ANTHROPIC_API_KEY = 'P-process';
  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc, { fakeProvider: true }));
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
  delete process.env.ANTHROPIC_API_KEY;
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('outlook per tenant', () => {
  it("A's snapshot is never served to B; a reauthor on A runs with A's env and stores into A's database", async () => {
    const la = await call('POST', '/api/auth/login', A, { json: { password: 'pw-ada' } });
    const lb = await call('POST', '/api/auth/login', B, { json: { password: 'pw-bea' } });
    expect(la.cookie).toBeTruthy(); expect(lb.cookie).toBeTruthy();

    const re = await call('POST', '/api/outlook/reauthor', A, { cookie: la.cookie });
    expect(re.status).toBe(200);
    expect(re.json.authored).toBe(true);
    expect(JSON.stringify(re.json.snapshot)).toContain('NEEDS-ada');
    expect(runInTenant(ada, () => getConfig('outlook_needsYou'))).toContain('NEEDS-ada');
    expect(runInTenant(bea, () => getConfig('outlook_needsYou'))).toBeFalsy();

    // The model run was the tenant's: its token and harness homes, no process key, cwd its own home.
    const run = h.seen.find((s) => s.id === 'ada')!;
    expect(run.env?.INTERNAL_TOKEN).toBe(ada.token);
    expect(run.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.values(run.env ?? {})).not.toContain('P-process');
    expect(h.seen.filter((s) => s.id === 'bea')).toHaveLength(0);

    // B asks for its own board (assembled in B's context, from B's database): none of A's text, then and cached.
    for (let i = 0; i < 2; i++) {
      const snap = await call('GET', '/api/outlook', B, { cookie: lb.cookie });
      expect(snap.status).toBe(200);
      expect(JSON.stringify(snap.json)).not.toContain('NEEDS-ada');
      expect(JSON.stringify(snap.json)).not.toContain('mood-ada');
    }
    const fresh = await call('POST', '/api/outlook/refresh', B, { cookie: lb.cookie });
    expect(JSON.stringify(fresh.json)).not.toContain('NEEDS-ada');
    // A's cache still holds A's.
    expect(JSON.stringify((await call('GET', '/api/outlook', A, { cookie: la.cookie })).json)).toContain('NEEDS-ada');
    // A's cookie on B's host is not a session there.
    expect((await call('GET', '/api/outlook', B, { cookie: la.cookie })).status).toBe(401);
  });
});

describe('handoff per tenant', () => {
  it("a handoff on A reads A's yesterday, posts into A's today and stores A's carry; B is untouched", async () => {
    const la = await call('POST', '/api/auth/login', A, { json: { password: 'pw-ada' } });
    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const now = new Date().toISOString();
    runInTenant(ada, () => {
      createThread({ id: `daily-${yesterday}`, name: yesterday, type: 'daily', createdAt: now });
      createMessage({ id: 'm-ada-1', threadId: `daily-${yesterday}`, role: 'user', content: 'a day that only ada had', createdAt: now });
    });
    const before = runInTenant(bea, () => (getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n);
    const out = await call('POST', '/api/handoff/run', A, { cookie: la.cookie });
    expect(out.status).toBe(200);
    expect(out.json.ran).toBe(true);
    expect(out.json.opener).toBe('OPENER-ada');
    expect(runInTenant(ada, () => getThread(out.json.postedToThreadId))).toBeTruthy();
    expect(runInTenant(bea, () => getThread(out.json.postedToThreadId))).toBeFalsy();
    expect(runInTenant(ada, () => getConfig('handoff_carry'))).toContain('CARRY-ada');
    expect(runInTenant(bea, () => getConfig('handoff_carry'))).toBeFalsy();
    expect(runInTenant(bea, () => (getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n)).toBe(before);
    // The run's env is A's, and B's status shows no run.
    const run = h.seen.filter((s) => s.id === 'ada').pop()!;
    expect(run.env?.INTERNAL_TOKEN).toBe(ada.token);
    expect(Object.values(run.env ?? {})).not.toContain('P-process');
    const lb = await call('POST', '/api/auth/login', B, { json: { password: 'pw-bea' } });
    expect((await call('GET', '/api/handoff/status', B, { cookie: lb.cookie })).json.lastRunAt).toBeFalsy();
    expect((await call('GET', '/api/handoff/status', A, { cookie: la.cookie })).json.lastRunAt).toBeTruthy();
    // The midnight cron is one per tenant, each created inside its own tenant (stopping A's leaves B's).
  });
});
