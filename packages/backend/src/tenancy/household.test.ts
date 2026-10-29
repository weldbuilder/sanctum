// Household mode (stage 5), in one real express process: one login, a path prefix per companion, the house store, the websocket at /c/<id>/ws.
// Real auth.ts, db.ts, ws.ts and internal-token.ts; two companions plus one that does not start; no provider key, no orchestrator, nothing that can run a model.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { bootTenants } from './boot.js';
import { currentTenant, enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { closeHouse, houseDataDir } from './house.js';
import { companionsRouter } from './companions.js';
import { tenantInfoRouter } from './info.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginRateLimiter } from '../middleware/security.js';
import { authMiddleware, loginHandler, logoutHandler, sessionCheckHandler } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';
import { getDb, createThread } from '../services/db.js';
import { createWebSocketServer } from '../services/ws.js';
import apiRoutes from '../routes/api.js';
import { saveFile } from '../services/files.js';
import { companionPath, plainPath } from './house.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const HOUSE_PW = 'house-password-1';
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

let server: http.Server;
let wss: ReturnType<typeof createWebSocketServer>;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;
let houseDbFile = '';
let warned: string[] = [];

function call(method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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

async function login(password = HOUSE_PW, path = '/api/auth/login'): Promise<{ reply: Reply; cookie: string }> {
  const reply = await call('POST', path, { json: { password } });
  return { reply, cookie: (reply.headers['set-cookie']?.[0] ?? '').split(';')[0] };
}

const dbFileOf = (rows: unknown): string => (rows as { name: string; file: string }[]).find((r) => r.name === 'main')!.file;
const real = (p: string) => realpathSync.native(p);
const rowsIn = (file: string, token: string) => {
  const direct = new Database(file, { readonly: true });
  try { return direct.prepare('SELECT token FROM web_sessions WHERE token = ?').all(token); } finally { direct.close(); }
};

interface Sock { ws: WebSocket; connected: any }
function open(path: string, cookie: string): Promise<Sock> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Origin: 'http://localhost:5173', Cookie: cookie } });
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'connected') ok({ ws, connected: m }); });
    ws.on('unexpected-response', (_req, res) => fail(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', () => { /* surfaced by unexpected-response */ });
  });
}
const refused = (path: string, cookie: string) => open(path, cookie).then((s) => { s.ws.close(); return 0; }, (e: { status?: number }) => e.status ?? -1);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
  const root = makeTenantsDir({
    ada: { yaml: 'identity:\n  companion_name: Ada\nhosts: [ada.example.net]\n', env: 'APP_PASSWORD=pw-ada-own\n' },
    bea: { yaml: 'identity:\n  companion_name: Bea\n', env: '' },
    cal: { yaml: 'hosts: 5\n' }, // (a tenant.yaml that does not load: skipped at boot)
    dee: { yaml: '' }, // (never named itself)
  });
  const avatarDir = join(root, 'ada', 'home', 'identity');
  mkdirSync(avatarDir, { recursive: true });
  writeFileSync(join(avatarDir, 'avatar.png'), Buffer.from([0x89, 0x50]));

  const base = mkdtempSync(join(tmpdir(), 'sanctum-house-'));
  const proc = processConfigFor(resolve(base, 'process'), { server: { db_path: join(base, 'process', 'data', 'sanctum.db') } });
  proc.auth.password = HOUSE_PW;
  (proc as unknown as { tenants: unknown }).tenants = { dir: root, default: 'ada', auth: 'household' }; // (safeTenancyProcess pins per-tenant only when the test does not say)
  registerProcessConfig(() => proc);
  houseDbFile = join(houseDataDir(proc.server.db_path), 'house.db');

  const app = express();
  app.set('trust proxy', 1);
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginRateLimiter, loginHandler);
  app.get('/api/auth/check', sessionCheckHandler);
  app.post('/api/auth/logout', logoutHandler);
  app.use('/api/tenant', tenantInfoRouter);
  app.use('/api/companions', companionsRouter);
  app.get('/api/protected', authMiddleware, (_req, res) => res.json({ ok: true }));
  app.get('/api/chat', authMiddleware, (_req, res) => res.json({ chat: true }));
  app.get('/api/identity', (_req, res) => res.json({ identity: true }));
  app.get('/api/internal/ping', internalOnly, (_req, res) => res.json({ tenant: currentTenant()?.id }));
  app.get('/api/probe', (req, res) => res.json({ who: currentTenant()?.id, file: dbFileOf(getDb().pragma('database_list')), url: req.url, original: req.originalUrl, query: req.query }));
  app.post('/api/probe/file', (_req, res) => res.json(saveFile(Buffer.from('hi'), 'a.txt', 'text/plain')));
  app.use('/api', apiRoutes); // (the real /api/health and /api/version)
  app.get('*', (req, res) => res.send(`page ${req.url}`));
  app.use(globalErrorHandler);
  server = http.createServer(app);
  wss = createWebSocketServer(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await stopBootedTenants();
  wss.clients.forEach((c) => c.terminate());
  wss.close();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  closeHouse();
  enableTenancy(false);
  setTenantRegistry(new Map());
  registerProcessConfig(() => null);
  vi.restoreAllMocks();
});

describe('one login, every companion', () => {
  it('opens /c/ada and /c/bea with the one cookie, each in its own database file', async () => {
    const { reply, cookie } = await login();
    expect(reply.status).toBe(200);
    expect(cookie).toMatch(/^sanctum_session=/);
    expect((await call('GET', '/c/ada/api/protected', { headers: { cookie } })).status).toBe(200);
    expect((await call('GET', '/c/bea/api/protected', { headers: { cookie } })).status).toBe(200);
    expect((await call('GET', '/c/ada/api/protected')).status).toBe(401);
    const a = (await call('GET', '/c/ada/api/probe', { headers: { cookie } })).json;
    const b = (await call('GET', '/c/bea/api/probe', { headers: { cookie } })).json;
    expect(a.who).toBe('ada');
    expect(b.who).toBe('bea');
    expect(real(a.file)).toBe(real(ada.config.server.db_path));
    expect(real(b.file)).toBe(real(bea.config.server.db_path));
    expect(real(a.file)).not.toBe(real(b.file));
  });

  it('keeps the session row in house.db only (all three files opened directly)', async () => {
    const { cookie } = await login();
    const token = cookie.split('=')[1];
    expect(rowsIn(houseDbFile, token)).toHaveLength(1);
    expect(rowsIn(ada.config.server.db_path, token)).toHaveLength(0);
    expect(rowsIn(bea.config.server.db_path, token)).toHaveLength(0);
  });

  it('a companion .env APP_PASSWORD is not a login, and is said once per companion at boot', async () => {
    expect((await login('pw-ada-own')).reply.status).toBe(401);
    expect((await login('pw-ada-own', '/c/ada/api/auth/login')).reply.status).toBe(401);
    expect(warned.filter((l) => l.includes('household mode: the house password applies; a tenant password (APP_PASSWORD in ada/.env'))).toHaveLength(1);
    expect(warned.some((l) => l.includes('APP_PASSWORD in bea/.env'))).toBe(false);
    expect(warned.some((l) => l.includes('hosts in ada/tenant.yaml are not read'))).toBe(true);
    expect(warned.some((l) => l.includes('tenants.default is not read'))).toBe(true);
    expect((await login(HOUSE_PW, '/c/bea/api/auth/login')).reply.status).toBe(200);
  });

  it('answers the session check as household, with the cookie and without', async () => {
    const { cookie } = await login();
    expect((await call('GET', '/api/auth/check', { headers: { cookie } })).json).toEqual({ authenticated: true, mode: 'household' });
    expect((await call('GET', '/api/auth/check')).json).toEqual({ authenticated: false, mode: 'household' });
  });

  it('logout deletes the session row, and the cookie is dead', async () => {
    const { cookie } = await login();
    const token = cookie.split('=')[1];
    expect(rowsIn(houseDbFile, token)).toHaveLength(1);
    expect((await call('POST', '/api/auth/logout', { headers: { cookie } })).status).toBe(200);
    expect(rowsIn(houseDbFile, token)).toHaveLength(0);
    expect((await call('GET', '/c/ada/api/protected', { headers: { cookie } })).status).toBe(401);
  });
});

describe('the path prefix is the only scope', () => {
  it('answers 404 companion_required for an unprefixed companion route, and lets the house routes and the page through', async () => {
    const { cookie } = await login();
    for (const path of ['/api/chat', '/api/identity', '/api/protected', '/mcp/cc', '/api/internal/ping']) {
      const r = await call('GET', path, { headers: { cookie } });
      expect(r.status, path).toBe(404);
      expect(r.json, path).toEqual({ error: 'companion_required' });
    }
    expect((await call('GET', '/')).body).toBe('page /');
    expect((await call('GET', '/sw.js')).body).toBe('page /sw.js');
    expect((await call('GET', '/assets/x.js')).body).toBe('page /assets/x.js');
  });

  it('serves /c/ada/api/tenant as ada, 404 for /c/nope, 400 for //', async () => {
    const { cookie } = await login();
    const t = await call('GET', '/c/ada/api/tenant', { headers: { cookie } });
    expect(t.status).toBe(200);
    expect(real(t.json.dir)).toBe(real(ada.dir));
    expect(t.json.hosts).toEqual([]); // (hosts are not read in household mode)
    expect((await call('GET', '/c/nope/api/tenant', { headers: { cookie } })).status).toBe(404);
    expect((await call('GET', '/c/ada//api/x', { headers: { cookie } })).status).toBe(400);
    expect((await call('GET', '/c/ada/../bea/api/tenant', { headers: { cookie } })).status).toBe(400);
  });

  it('strips the prefix from req.url, keeps req.originalUrl and the query, never makes a //', async () => {
    const { cookie } = await login();
    const r = (await call('GET', '/c/bea/api/probe?x=1&y=two', { headers: { cookie } })).json;
    expect(r.url).toBe('/api/probe?x=1&y=two');
    expect(r.original).toBe('/c/bea/api/probe?x=1&y=two');
    expect(r.query).toEqual({ x: '1', y: 'two' });
    expect((await call('GET', '/c/bea')).body).toBe('page /');
    expect((await call('GET', '/c/bea/')).body).toBe('page /');
    expect((await call('GET', '/c/bea/some/route')).body).toBe('page /some/route');
  });

  it('a skipped companion answers 503 under its prefix, a bad id is not a companion', async () => {
    const { cookie } = await login();
    const r = await call('GET', '/c/cal/api/tenant', { headers: { cookie } });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'tenant_unavailable' });
    expect((await call('GET', '/c/Ada/api/tenant', { headers: { cookie } })).body).toBe('page /c/Ada/api/tenant'); // (not a prefix: the page)
  });

  it('internal token: its own prefix or none resolves, another companion\'s prefix is a 404', async () => {
    const asAda = { 'x-internal-token': ada.token };
    expect((await call('GET', '/c/bea/api/internal/ping', { headers: asAda })).status).toBe(404);
    expect((await call('GET', '/c/ada/api/internal/ping', { headers: asAda })).json).toEqual({ tenant: 'ada' });
    expect((await call('GET', '/api/internal/ping', { headers: asAda })).json).toEqual({ tenant: 'ada' }); // (harness children carry the token and no prefix)
    expect((await call('GET', '/api/internal/ping', { headers: { 'x-internal-token': 'not-a-token' } })).status).toBe(404);
    expect((await call('GET', '/c/cal/api/internal/ping', { headers: asAda })).status).toBe(503);
  });
});

describe('GET /api/companions', () => {
  it('needs the house session', async () => {
    expect((await call('GET', '/api/companions')).status).toBe(401);
  });

  it('lists every folder found at boot with id, name, avatar_url and status, never a reason or a path', async () => {
    const { cookie } = await login();
    const r = await call('GET', '/api/companions', { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual([
      { id: 'ada', name: 'Ada', avatar_url: '/c/ada/api/identity/avatar', status: 'ready' },
      { id: 'bea', name: 'Bea', avatar_url: null, status: 'ready' },
      { id: 'cal', name: 'cal', avatar_url: null, status: 'unavailable' },
      { id: 'dee', name: 'dee', avatar_url: null, status: 'ready' }, // (unnamed: listed by id, not by the shipped default name)
    ]);
    expect(Object.keys(r.json[2]).sort()).toEqual(['avatar_url', 'id', 'name', 'status']);
    expect(r.body).not.toMatch(/sanctum-tenants|tmp|hosts/i);
  });
});

describe('the websocket upgrades at /c/<id>/ws', () => {
  it('enters ada at /c/ada/ws with the house cookie (the connected message is built from ada\'s own database)', async () => {
    runInTenant(ada, () => createThread({ name: 'only-in-ada', type: 'named', createdAt: new Date().toISOString() }));
    const { cookie } = await login();
    const a = await open('/c/ada/ws', cookie);
    const b = await open('/c/bea/ws', cookie);
    try {
      const names = (m: any) => m.threads.map((t: { name: string }) => t.name);
      expect(names(a.connected)).toContain('only-in-ada');
      expect(names(b.connected)).not.toContain('only-in-ada');
    } finally { a.ws.close(); b.ws.close(); }
  });

  it('404s any other path raw, 401s a bad or missing cookie, 404s an unknown companion, 503s an unavailable one', async () => {
    const { cookie } = await login();
    expect(await refused('/ws', cookie)).toBe(404);
    expect(await refused('/c/ada/other', cookie)).toBe(404);
    expect(await refused('/c/nope/ws', cookie)).toBe(404);
    expect(await refused('/c/cal/ws', cookie)).toBe(503);
    expect(await refused('/c/bea/ws', 'sanctum_session=not-a-session')).toBe(401);
    expect(await refused('/c/bea/ws', '')).toBe(401);
  });

  it('refuses the cookie once its session is gone', async () => {
    const { cookie } = await login();
    await call('POST', '/api/auth/logout', { headers: { cookie } });
    expect(await refused('/c/ada/ws', cookie)).toBe(401);
  });
});

describe('health and version are house routes', () => {
  it('answer with no companion and under a prefix, with the single-tenant shape', async () => {
    for (const path of ['/api/health', '/c/ada/api/health']) {
      const r = await call('GET', path);
      expect(r.status, path).toBe(200);
      expect(Object.keys(r.json)).toEqual(['status', 'uptime', 'memoryUsage', 'connections']);
      expect(r.json.status).toBe('ok');
      expect(typeof r.json.connections).toBe('number');
    }
    for (const path of ['/api/version', '/c/bea/api/version']) {
      const r = await call('GET', path);
      expect(r.status, path).toBe(200);
      expect(Object.keys(r.json)).toEqual(['buildId', 'version']);
    }
  });
});

describe('server-issued URLs carry the companion prefix where they are made', () => {
  it('an upload under /c/ada answers /c/ada/api/files/<id>, and /c/bea its own', async () => {
    const { cookie } = await login();
    const a = (await call('POST', '/c/ada/api/probe/file', { headers: { cookie } })).json;
    const b = (await call('POST', '/c/bea/api/probe/file', { headers: { cookie } })).json;
    expect(a.url).toBe(`/c/ada/api/files/${a.fileId}`);
    expect(b.url).toBe(`/c/bea/api/files/${b.fileId}`);
  });

  it('companionPath and plainPath: only /api/ paths, only inside a companion', () => {
    expect(companionPath('/api/files/x')).toBe('/api/files/x'); // (no companion: the house)
    runInTenant(ada, () => {
      expect(companionPath('/api/files/x')).toBe('/c/ada/api/files/x');
      expect(companionPath('/logo.png')).toBe('/logo.png');
      expect(companionPath('/chat')).toBe('/c/ada/chat'); // (the push click opens the companion, not the chooser)
      expect(companionPath('/avatars/01.svg')).toBe('/avatars/01.svg');
      expect(plainPath('/c/ada/api/identity/avatar/x')).toBe('/api/identity/avatar/x');
      expect(plainPath('/c/bea/api/identity/avatar/x')).toBe('/c/bea/api/identity/avatar/x');
      expect(plainPath('/api/identity/avatar/x')).toBe('/api/identity/avatar/x');
    });
  });
});

describe('round 2', () => {
  it('the login budget is one per address across every prefix (5 unprefixed wrong guesses, then 429 under /c/ada)', async () => {
    const from = { 'x-forwarded-for': '10.9.9.9' }; // (an address of its own: the budget is per address)
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/auth/login', { headers: from, json: { password: 'wrong-guess' } })).status).toBe(401);
    expect((await call('POST', '/c/ada/api/auth/login', { headers: from, json: { password: 'wrong-guess' } })).status).toBe(429);
    expect((await call('POST', '/c/bea/api/auth/login', { headers: from, json: { password: HOUSE_PW } })).status).toBe(429);
  });

  it('a socket path with // is refused like HTTP', async () => {
    const { cookie } = await login();
    expect(await refused('/c/ada/ws//', cookie)).toBe(400);
  });
});
