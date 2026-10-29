// Two tenants in one real express process: real auth.ts, db.ts and internal-token.ts, no provider key, no orchestrator.
// What this proves is that nothing one tenant does is visible to the other: not its session, its password, its token, its database,
// its saved key, its vector cache; and that the tenant survives the two places that call next() from a stream event.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import multer from 'multer';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { bootTenants } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { authMiddleware, loginHandler, sessionCheckHandler } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';
import { getDb } from '../services/db.js';
import { cacheEmbedding, searchVectors, getCacheStats } from '../services/vector-cache.js';
import { EMBEDDING_DIM } from '../services/embeddings.js';
import authPreferencesRoutes from '../routes/auth-preferences.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const A = 'ada.example.net';
const B = 'bea.example.net';

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;

function call(method: string, path: string, host: string | null, opts: { headers?: Record<string, string>; json?: unknown; raw?: Buffer } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (host) headers.host = host;
    let payload: Buffer | undefined = opts.raw;
    if (opts.json !== undefined) { payload = Buffer.from(JSON.stringify(opts.json)); headers['content-type'] = 'application/json'; }
    if (payload) headers['content-length'] = String(payload.length);
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

async function login(host: string, password: string): Promise<{ reply: Reply; cookie: string }> {
  const reply = await call('POST', '/api/auth/login', host, { json: { password } });
  const set = reply.headers['set-cookie']?.[0] ?? '';
  return { reply, cookie: set.split(';')[0] };
}

const dbFileOf = (rows: unknown): string => (rows as { name: string; file: string }[]).find((r) => r.name === 'main')!.file;
// Same file whatever the platform calls it (Windows short names, case): compare real paths.
const realpath = (p: string) => realpathSync.native(p);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
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

  const upload = multer({ storage: multer.memoryStorage() });
  app.post('/api/auth/login', loginHandler);
  app.get('/api/auth/check', sessionCheckHandler);
  app.get('/api/protected', authMiddleware, (_req, res) => res.json({ ok: true }));
  app.get('/api/internal/ping', internalOnly, (_req, res) => res.json({ ok: true }));
  app.post('/api/probe/json', (req, res) => res.json({ echoed: req.body?.x, file: dbFileOf(getDb().pragma('database_list')) }));
  app.post('/api/probe/upload', upload.single('file'), tenantEnter, (_req, res) => res.json({ file: dbFileOf(getDb().pragma('database_list')) }));
  app.get('/api/probe/vectors', (_req, res) => {
    const q = new Float32Array(EMBEDDING_DIM).fill(1);
    res.json({ count: getCacheStats().count, hits: searchVectors(q, 5).map((r) => r.messageId) });
  });
  app.use('/api', authPreferencesRoutes);
  app.use(globalErrorHandler);

  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await stopBootedTenants();
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false);
  setTenantRegistry(new Map());
  vi.restoreAllMocks();
});

describe('sessions and passwords', () => {
  it('logs in on A; the cookie works on A and is a 401 on B', async () => {
    const { reply, cookie } = await login(A, 'pw-ada');
    expect(reply.status).toBe(200);
    expect(cookie).toMatch(/^sanctum_session=/);
    expect((await call('GET', '/api/protected', A, { headers: { cookie } })).status).toBe(200);
    expect((await call('GET', '/api/protected', B, { headers: { cookie } })).status).toBe(401);
    expect((await call('GET', '/api/auth/check', B, { headers: { cookie } })).json).toEqual({ authenticated: false });
  });

  it("A's password on B is a 401, and B's own works", async () => {
    expect((await login(B, 'pw-ada')).reply.status).toBe(401);
    expect((await login(B, 'pw-bea')).reply.status).toBe(200);
    expect((await login(A, 'pw-bea')).reply.status).toBe(401);
  });

  it("A's session row is in A's sqlite file and not in B's (both files opened directly)", async () => {
    const { cookie } = await login(A, 'pw-ada');
    const token = cookie.split('=')[1];
    const rowsIn = (rt: TenantRuntime) => {
      const direct = new Database(rt.config.server.db_path, { readonly: true });
      try { return direct.prepare('SELECT token FROM web_sessions WHERE token = ?').all(token); } finally { direct.close(); }
    };
    expect(rowsIn(ada)).toHaveLength(1);
    expect(rowsIn(bea)).toHaveLength(0);
    expect(ada.config.server.db_path).not.toBe(bea.config.server.db_path);
  });
});

describe('resolution and the internal token', () => {
  it("A's token works for A, and is a 404 with B's host or no match", async () => {
    expect((await call('GET', '/api/internal/ping', A, { headers: { 'x-internal-token': ada.token } })).status).toBe(200);
    expect((await call('GET', '/api/internal/ping', '127.0.0.1', { headers: { 'x-internal-token': ada.token } })).status).toBe(200);
    expect((await call('GET', '/api/internal/ping', B, { headers: { 'x-internal-token': ada.token } })).status).toBe(404);
    expect((await call('GET', '/api/internal/ping', A, { headers: { 'x-internal-token': bea.token } })).status).toBe(404);
    expect((await call('GET', '/api/internal/ping', A, { headers: { 'x-internal-token': 'wrong' } })).status).toBe(404);
    expect((await call('GET', '/api/internal/ping', A)).status).toBe(404);
  });

  it('an unclaimed host is a 404 (no default tenant here), and a spoofed first X-Forwarded-Host does not pick the tenant', async () => {
    expect((await call('GET', '/api/auth/check', 'nobody.example.net')).status).toBe(404);
    const spoof = await call('POST', '/api/probe/json', 'internal', { headers: { 'x-forwarded-host': `${A}, ${B}` }, json: { x: 1 } });
    expect(realpath(spoof.json.file)).toBe(realpath(bea.config.server.db_path));
  });
});

describe('the tenant survives the two stream-event hops', () => {
  it("PRAGMA database_list in a JSON POST handler names the request tenant's file", async () => {
    const a = await call('POST', '/api/probe/json', A, { json: { x: 'a' } });
    const b = await call('POST', '/api/probe/json', B, { json: { x: 'b' } });
    expect(a.json.echoed).toBe('a');
    expect(realpath(a.json.file)).toBe(realpath(ada.config.server.db_path));
    expect(realpath(b.json.file)).toBe(realpath(bea.config.server.db_path));
  });

  it("PRAGMA database_list in a multer upload handler names the request tenant's file", async () => {
    const boundary = '----sanctumtest';
    const multipart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`);
    const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    const a = await call('POST', '/api/probe/upload', A, { headers, raw: multipart });
    const b = await call('POST', '/api/probe/upload', B, { headers, raw: multipart });
    expect(a.status).toBe(200);
    expect(realpath(a.json.file)).toBe(realpath(ada.config.server.db_path));
    expect(realpath(b.json.file)).toBe(realpath(bea.config.server.db_path));
  });
});

describe('per-database caches', () => {
  it("A's saved api_key is not returned under B, and each database holds only its own", async () => {
    const { cookie: ca } = await login(A, 'pw-ada');
    const { cookie: cb } = await login(B, 'pw-bea');
    const put = await call('PUT', '/api/auth-preferences', A, { headers: { cookie: ca }, json: { auth_mode: 'api_key', api_key: 'sk-ant-ada-secret-key' } });
    expect(put.status).toBe(200);
    const onA = await call('GET', '/api/auth-preferences', A, { headers: { cookie: ca } });
    const onB = await call('GET', '/api/auth-preferences', B, { headers: { cookie: cb } });
    expect(onA.json.api_key_set).toBe(true);
    expect(onB.json.api_key_set).toBe(false);
    expect(onB.json.auth_mode).toBe('subscription');
    expect(onB.body).not.toContain('ada-secret');
    const keyIn = (rt: TenantRuntime) => {
      const direct = new Database(rt.config.server.db_path, { readonly: true });
      try { return (direct.prepare('SELECT api_key FROM auth_preferences WHERE id = 1').get() as { api_key: string | null } | undefined)?.api_key ?? null; } finally { direct.close(); }
    };
    expect(keyIn(ada)).toBe('sk-ant-ada-secret-key');
    expect(keyIn(bea)).toBeNull();
  });

  it("A's vector cache entries are not found under B", async () => {
    const v = new Float32Array(EMBEDDING_DIM).fill(1);
    runInTenant(ada, () => cacheEmbedding('ada-message', v, { threadId: 't', threadName: 'T', role: 'user', createdAt: '2026-01-01T00:00:00Z' }));
    const onA = await call('GET', '/api/probe/vectors', A);
    const onB = await call('GET', '/api/probe/vectors', B);
    expect(onA.json).toEqual({ count: 1, hits: ['ada-message'] });
    expect(onB.json).toEqual({ count: 0, hits: [] });
  });
});

describe('outside any tenant', () => {
  it('getDb() throws instead of falling back to a process database', () => {
    expect(() => getDb()).toThrow(/outside a tenant context/);
  });
});
