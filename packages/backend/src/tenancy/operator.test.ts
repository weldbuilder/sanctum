// The operator's routes as a gate (tenancy/operator.ts): 404 for everything that is not the operator (as internalOnly answers), loopback peers only unless
// tenants.operator_routes_remote, the token file's mode and kind, a deleted file revoking at once, a companion's prefix or host staying 404, and the standard
// middleware (security headers, body parsers) running ahead of the routes. No tenants are booted: the gate is what is under test.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import helmet from 'helmet';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableTenancy } from './context.js';
import { setTenantRegistry, tenantResolve, tenantEnter } from './resolve.js';
import { loadOperatorToken, operatorBypassesResolve, operatorRouter } from './operator.js';

const posix = process.platform !== 'win32';
let dir = '';
let token = '';
const servers: http.Server[] = [];

async function serve(opts: { remote?: boolean; peer?: string; companionHost?: string } = {}): Promise<number> {
  const app = express();
  app.use((req, res, next) => { // (a test peer: the TCP address the router reads)
    if (opts.peer) Object.defineProperty(req.socket, 'remoteAddress', { value: opts.peer, configurable: true });
    if (opts.companionHost && req.headers.host === opts.companionHost) { (req as { tenant?: unknown }).tenant = { id: 'ada' }; }
    next();
  });
  app.use(helmet());
  app.use(express.json());
  app.use('/api/internal/tenants', operatorRouter({ dataDir: dir, remote: opts.remote }));
  app.use((_req, res) => { res.status(404).json({ error: 'elsewhere' }); });
  const server = await new Promise<http.Server>((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}
function call(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json: unknown = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ } ok({ status: res.statusCode ?? 0, headers: res.headers, json }); });
    });
    req.on('error', fail); req.end();
  });
}
const LIST = '/api/internal/tenants';

beforeAll(() => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  enableTenancy(true);
  setTenantRegistry(new Map());
});
afterAll(async () => {
  enableTenancy(false);
  for (const s of servers) await new Promise<void>((ok) => s.close(() => ok()));
  vi.restoreAllMocks();
});
beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'sanctum-operator-'));
  token = loadOperatorToken(dir)!;
});

describe('the gate answers 404, never 401 or 403', () => {
  it('the right token on a loopback peer lists; a missing, wrong or empty token is 404 with the same body', async () => {
    const port = await serve();
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(200);
    for (const headers of [{}, { 'x-internal-token': 'x'.repeat(64) }, { 'x-internal-token': '' }]) {
      const r = await call(port, LIST, headers as Record<string, string>);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: 'Not found' });
    }
  });
  it('runs after the standard middleware: the security headers are on the answer, success and 404 alike', async () => {
    const port = await serve();
    for (const headers of [{ 'x-internal-token': token }, {}]) {
      const r = await call(port, LIST, headers as Record<string, string>);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toBeDefined();
    }
  });
  it('a path that is not one of the operator\'s (odd spelling, another id shape) is 404 even with the token', async () => {
    const port = await serve();
    for (const path of ['/api/internal/tenants/ADA/park', '/api/internal/tenants/ada/destroy', '/api/internal/tenants/a_b/park']) {
      expect((await call(port, path, { 'x-internal-token': token }, 'POST')).status).toBe(404);
    }
  });
});

describe('loopback peers only', () => {
  it('a peer that is not loopback is 404 with the right token; tenants.operator_routes_remote: true lets it in', async () => {
    const remote = await serve({ peer: '203.0.113.9' });
    expect((await call(remote, LIST, { 'x-internal-token': token })).status).toBe(404);
    const allowed = await serve({ peer: '203.0.113.9', remote: true });
    expect((await call(allowed, LIST, { 'x-internal-token': token })).status).toBe(200);
    expect((await call(allowed, LIST, {})).status).toBe(404); // (still needs the token)
  });
  it('::1 and ::ffff:127.0.0.1 are loopback', async () => {
    for (const peer of ['::1', '::ffff:127.0.0.1']) {
      expect((await call(await serve({ peer }), LIST, { 'x-internal-token': token })).status).toBe(200);
    }
  });
  it('X-Forwarded-For is never trusted: a loopback peer that says it forwarded for someone is refused, and one that claims to be 127.0.0.1 from afar is still judged by its socket', async () => {
    const near = await serve();
    expect((await call(near, LIST, { 'x-internal-token': token, 'x-forwarded-for': '203.0.113.9' })).status).toBe(404); // a tunnel forwards from loopback
    expect((await call(near, LIST, { 'x-internal-token': token, 'cf-connecting-ip': '203.0.113.9' })).status).toBe(404);
    const far = await serve({ peer: '203.0.113.9' });
    expect((await call(far, LIST, { 'x-internal-token': token, 'x-forwarded-for': '127.0.0.1' })).status).toBe(404);
  });
});

describe('a companion\'s path or host is never the operator', () => {
  it('a request that resolved to a companion (req.tenant) is 404 with the token; the bypass is off for a companion prefix', async () => {
    const port = await serve({ companionHost: 'ada.example.net' });
    expect((await call(port, LIST, { 'x-internal-token': token, host: 'ada.example.net' })).status).toBe(404);
    expect((await call(port, LIST, { 'x-internal-token': token, host: 'operator.example.net' })).status).toBe(200);
    const req = (url: string, host = 'operator.example.net') => ({ originalUrl: url, url, headers: { host } }) as never;
    expect(operatorBypassesResolve(req(LIST))).toBe(true);
    expect(operatorBypassesResolve(req('/c/ada/api/internal/tenants'))).toBe(false);
    expect(operatorBypassesResolve(req('/api/internal/tenants/ada/park?x=1'))).toBe(true);
    expect(operatorBypassesResolve(req('/api/internal/tenants/../x'))).toBe(false);
    expect(operatorBypassesResolve(req('/API/internal/tenants'))).toBe(false);
    expect(operatorBypassesResolve(req('/api/internal/tenantsx'))).toBe(false);
  });
  it('with a companion\'s host in the registry, the bypass is off for that host and tenant resolution answers (404 here, no token it knows)', async () => {
    const fake = { id: 'ada', hosts: ['ada.example.net'], token: 'tok', config: {} } as never;
    setTenantRegistry(new Map([['ada', fake]]));
    try {
      const req = (host: string) => ({ originalUrl: LIST, url: LIST, headers: { host } }) as never;
      expect(operatorBypassesResolve(req('ada.example.net'))).toBe(false);
      expect(operatorBypassesResolve(req('operator.example.net'))).toBe(true);
      const app = express();
      app.use((rq, rs, nx) => { if (operatorBypassesResolve(rq)) nx(); else tenantResolve(rq, rs, nx); });
      app.use(tenantEnter);
      app.use('/api/internal/tenants', operatorRouter({ dataDir: dir }));
      const server = await new Promise<http.Server>((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
      servers.push(server);
      const port = (server.address() as AddressInfo).port;
      expect((await call(port, LIST, { 'x-internal-token': token, host: 'ada.example.net' })).status).toBe(404);
    } finally { setTenantRegistry(new Map()); }
  });
});

describe('the token file', () => {
  it('is created owner-only, a regular file', () => {
    if (posix) expect(statSync(join(dir, '.operator-token')).mode & 0o777).toBe(0o600);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
  it.skipIf(!posix)('a file with group or world bits disables the routes (404 with the right token), at boot and on the next request; restoring 600 turns them back on', async () => {
    const port = await serve();
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(200);
    chmodSync(join(dir, '.operator-token'), 0o640);
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(404);
    expect(loadOperatorToken(dir)).toBeNull();
    expect(readFileSync(join(dir, '.operator-token'), 'utf8').trim()).toBe(token); // (never overwritten)
    chmodSync(join(dir, '.operator-token'), 0o604);
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(404);
    chmodSync(join(dir, '.operator-token'), 0o600);
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(200);
  });
  it.skipIf(!posix)('a symlink or a directory is not a regular file: refused', async () => {
    const real = join(dir, 'real-token');
    writeFileSync(real, token, { mode: 0o600 });
    unlinkSync(join(dir, '.operator-token'));
    symlinkSync(real, join(dir, '.operator-token'));
    expect(loadOperatorToken(dir)).toBeNull();
    expect((await call(await serve(), LIST, { 'x-internal-token': token })).status).toBe(404);
  });
  it('deleting the file revokes the token on the very next request, and the routes stay off (nothing recreates it per request)', async () => {
    const port = await serve();
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(200);
    unlinkSync(join(dir, '.operator-token'));
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(404);
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(404);
  });
  it('replacing the file with a new secret revokes the old token', async () => {
    const port = await serve();
    writeFileSync(join(dir, '.operator-token'), 'f'.repeat(64), { mode: 0o600 });
    expect((await call(port, LIST, { 'x-internal-token': token })).status).toBe(404);
    expect((await call(port, LIST, { 'x-internal-token': 'f'.repeat(64) })).status).toBe(200);
  });
});
