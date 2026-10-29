// The websocket per tenant (stage 3a): a real server, two tenants, a FAKE provider (no model, no key, no child process).
// The tenant is decided at the upgrade from host and cookie and never changes; a broadcast reaches that tenant's sockets only; a whole turn
// over A's socket runs as A (its database, its agent, its harness homes and token) and B sees nothing.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

const h = vi.hoisted(() => ({ seen: [] as { id: string; env?: Record<string, string | undefined> }[], id: (): string => '' }));
vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: (p: { options?: { env?: Record<string, string | undefined> } }) => {
    const id = h.id();
    h.seen.push({ id, env: p.options?.env });
    const it = (async function* () {
      yield { type: 'assistant', session_id: `s-${id}`, message: { content: [{ type: 'text', text: `reply-${id}` }] } };
      yield { type: 'result', subtype: 'success', session_id: `s-${id}` };
    })();
    return Object.assign(it, { mcpServerStatus: async () => [], interrupt: async () => {}, close: () => {} });
  },
}));
vi.mock('../services/rolling-context.js', async (orig) => ({ ...(await orig<object>()), getRolling: () => ({ maybeCompact: async () => {}, readTurns: async () => [] }), rollingEnabledForActiveProvider: () => false }));
vi.mock('../services/revien.js', async (orig) => ({ ...(await orig<object>()), recallForPrompt: async () => '', ingestTurn: async () => {} }));
vi.mock('../services/hooks.js', async (orig) => ({
  ...(await orig<object>()), createHooks: () => ({}), buildOrientationContext: async () => '', prefetchMindContext: async () => '', maybeSnapshotTone: () => {},
}));

import { bootTenants } from './boot.js';
import { currentTenant, enableTenancy, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import { createWebSocketServer } from '../services/ws.js';
import { realDeep } from '../services/plugin-paths.js';

h.id = () => currentTenant()?.id ?? '';
const A = 'ada.example.net';
const B = 'bea.example.net';
let server: http.Server;
let wss: ReturnType<typeof createWebSocketServer>;
let port = 0;
let ada: TenantRuntime;
let bea: TenantRuntime;
let runtimes: Map<string, TenantRuntime>;

async function login(host: string, password: string): Promise<string> {
  return new Promise((ok, fail) => {
    const body = JSON.stringify({ password });
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers: { host, 'content-type': 'application/json', 'content-length': String(body.length) } }, (res) => {
      res.resume(); res.on('end', () => ok((res.headers['set-cookie']?.[0] ?? '').split(';')[0]));
    });
    req.on('error', fail); req.end(body);
  });
}

interface Sock { ws: WebSocket; got: any[]; waitFor: (pred: (m: any) => boolean) => Promise<any> }
function open(host: string, origin: string, cookie: string): Promise<Sock> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Host: host, Origin: origin, Cookie: cookie } });
    const got: any[] = [];
    const waiters: { pred: (m: any) => boolean; done: (m: any) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      got.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.done(m); }
    });
    const waitFor = (pred: (m: any) => boolean) => new Promise<any>((done, bad) => {
      const hit = got.find(pred);
      if (hit) { done(hit); return; }
      waiters.push({ pred, done });
      ws.once('close', () => bad(new Error('socket closed while waiting')));
    });
    ws.on('open', () => { void waitFor((m) => m.type === 'connected').then(() => ok({ ws, got, waitFor }), fail); });
    ws.on('unexpected-response', (_req, res) => fail(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', () => { /* surfaced by unexpected-response or close */ });
  });
}
const refused = (host: string, origin: string, cookie: string) => open(host, origin, cookie).then(() => 0, (e: { status?: number }) => e.status ?? -1);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.ANTHROPIC_API_KEY = 'P-process';
  const root = makeTenantsDir({
    ada: { yaml: `hosts: [${A}]\n`, env: 'APP_PASSWORD=pw-ada\nANTHROPIC_API_KEY=T-ada\n' },
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
  server = http.createServer(app);
  wss = createWebSocketServer(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await stopBootedTenants();
  delete process.env.ANTHROPIC_API_KEY;
  wss.clients.forEach((c) => c.terminate());
  wss.close();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('the upgrade binds a socket to one tenant', () => {
  it('refuses A\'s cookie on B\'s host (401), B\'s origin on A\'s host (403), no cookie (401), an unclaimed host (404)', async () => {
    const cookieA = await login(A, 'pw-ada');
    expect(cookieA).toMatch(/^sanctum_session=/);
    expect(await refused(B, `https://${B}`, cookieA)).toBe(401);
    expect(await refused(A, `https://${B}`, cookieA)).toBe(403);
    expect(await refused(A, `https://${A}`, '')).toBe(401);
    expect(await refused('nobody.example.net', 'https://nobody.example.net', cookieA)).toBe(404);
  });

  it('the process-wide AUTH_DEV_OPEN escape hatch never opens a tenant socket (a tenant with no password stays closed)', async () => {
    const hadOpen = process.env.AUTH_DEV_OPEN;
    const pw = ada.config.auth.password;
    process.env.AUTH_DEV_OPEN = 'true';
    ada.config.auth.password = '';
    try {
      expect(await refused(A, `https://${A}`, '')).toBe(503);
    } finally {
      ada.config.auth.password = pw;
      if (hadOpen === undefined) delete process.env.AUTH_DEV_OPEN; else process.env.AUTH_DEV_OPEN = hadOpen;
    }
  });
});

describe('a turn over A\'s socket', () => {
  it('runs as A: A\'s database, A\'s agent and env; B\'s socket sees nothing and B\'s data is untouched', async () => {
    const cookieA = await login(A, 'pw-ada');
    const cookieB = await login(B, 'pw-bea');
    const sa = await open(A, `https://${A}`, cookieA);
    const sb = await open(B, `https://${B}`, cookieB);
    try {
      sa.ws.send(JSON.stringify({ type: 'message', threadId: '', content: 'hello from ada', contentType: 'text' }));
      await sa.waitFor((m) => JSON.stringify(m).includes('reply-ada')).catch(() => { throw new Error(JSON.stringify(sa.got.map((m) => m.type + ':' + (m.code ?? '')))); });
      // Everything A's turn broadcast has been delivered to A. B gets a pong for a ping sent now, which arrives after anything that had been sent to it.
      sb.ws.send(JSON.stringify({ type: 'ping' }));
      await sb.waitFor((m) => m.type === 'pong');
      const leaked = sb.got.filter((m) => m.type !== 'connected' && m.type !== 'pong' && m.type !== 'canvas_list');
      expect(leaked).toEqual([]);
      expect(JSON.stringify(sb.got)).not.toContain('hello from ada');

      const count = (rt: TenantRuntime, text: string) => (rt.db.prepare('SELECT COUNT(*) c FROM messages WHERE content = ?').get(text) as { c: number }).c;
      expect(count(ada, 'hello from ada')).toBe(1);
      expect(count(ada, 'reply-ada')).toBe(1);
      expect(count(bea, 'hello from ada')).toBe(0);
      expect(count(bea, 'reply-ada')).toBe(0);

      const run = h.seen.find((s) => s.id === 'ada')!;
      expect(h.seen.filter((s) => s.id !== 'ada')).toEqual([]);
      expect(Object.values(run.env ?? {})).not.toContain('P-process');
      expect([undefined, 'T-ada']).toContain(run.env?.ANTHROPIC_API_KEY); // A's own key, or none when the auth preference drops it; never the process's
      expect(run.env?.INTERNAL_TOKEN).toBe(ada.token);
      const real = (p: string) => realDeep(p).toLowerCase();
      const harness = real(resolve(ada.dataDir, 'harness')) + sep;
      for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME']) expect(real(run.env![k]!).startsWith(harness), k).toBe(true);
    } finally { sa.ws.close(); sb.ws.close(); }
  });

  it('a broadcast made in A\'s context reaches A\'s sockets only', async () => {
    const sa = await open(A, `https://${A}`, await login(A, 'pw-ada'));
    const sb = await open(B, `https://${B}`, await login(B, 'pw-bea'));
    try {
      const { registry } = await import('../services/ws.js');
      const { runInTenant } = await import('./context.js');
      runInTenant(ada, () => registry.broadcast({ type: 'thread_deleted', threadId: 'only-ada' } as never));
      await sa.waitFor((m) => m.type === 'thread_deleted' && m.threadId === 'only-ada');
      sb.ws.send(JSON.stringify({ type: 'ping' }));
      await sb.waitFor((m) => m.type === 'pong');
      expect(sb.got.some((m) => m.type === 'thread_deleted')).toBe(false);
      expect(runInTenant(ada, () => registry.getCount())).toBeGreaterThanOrEqual(1);
      expect(() => registry.broadcast({ type: 'thread_deleted', threadId: 'x' } as never)).toThrow(/outside a tenant context/);
    } finally { sa.ws.close(); sb.ws.close(); }
  });
});
