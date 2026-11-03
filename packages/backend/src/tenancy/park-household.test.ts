// Park and revive in household mode with the real websocket: a parked companion's open socket is closed (1013), its prefix and its socket path answer 503, the
// house list says `unavailable`, the other companion's socket stays open and its routes answer; a revive brings it back at the same prefix.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { bootTenants } from './boot.js';
import { currentTenant, enableTenancy, registerProcessConfig, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { closeHouse } from './house.js';
import { listCompanions } from './companions.js';
import { loadOperatorToken, operatorRouter } from './operator.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import { createWebSocketServer } from '../services/ws.js';

const HOUSE_PW = 'house-password-1';
let server: http.Server;
let wss: ReturnType<typeof createWebSocketServer>;
let port = 0;
let base = '';
let tenantsDir = '';
let token = '';
let runtimes: Map<string, TenantRuntime>;

const call = (method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> => new Promise((ok, fail) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { let json: unknown = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } ok({ status: res.statusCode ?? 0, headers: res.headers, json }); });
  });
  req.on('error', fail); req.end();
});
const op = (action: 'park' | 'revive', id: string) => call('POST', `/api/internal/tenants/${id}/${action}`, { 'x-internal-token': token });
const cookieOf = async (): Promise<string> => {
  const body = Buffer.from(JSON.stringify({ password: HOUSE_PW }));
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }, (res) => { res.resume(); res.on('end', () => ok(String(res.headers['set-cookie']?.[0] ?? '').split(';')[0])); });
    req.on('error', fail); req.write(body); req.end();
  });
};
interface Sock { ws: WebSocket; closed: Promise<number> }
function open(path: string, cookie: string): Promise<Sock> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Origin: 'http://localhost:5173', Cookie: cookie } });
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    ws.on('message', (d) => { if (JSON.parse(String(d)).type === 'connected') ok({ ws, closed }); });
    ws.on('unexpected-response', (_req, res) => fail(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', () => { /* surfaced by unexpected-response */ });
  });
}
const refused = (path: string, cookie: string) => open(path, cookie).then((s) => { s.ws.close(); return 0; }, (e: { status?: number }) => e.status ?? -1);

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  tenantsDir = makeTenantsDir({ ada: { yaml: 'identity:\n  companion_name: Echo\n' }, bea: { yaml: 'identity:\n  companion_name: Sam\n' } });
  base = mkdtempSync(join(tmpdir(), 'sanctum-park-house-'));
  const proc = processConfigFor(resolve(base, 'process'), { server: { db_path: join(base, 'process', 'data', 'sanctum.db') } });
  proc.auth.password = HOUSE_PW;
  (proc as unknown as { tenants: unknown }).tenants = { dir: tenantsDir, auth: 'household' };
  registerProcessConfig(() => proc);
  const app = express();
  runtimes = bootTenants(app, safeTenancyProcess(proc));
  token = loadOperatorToken(join(base, 'process', 'data'))!;
  app.use('/api/internal/tenants', operatorRouter({ dataDir: join(base, 'process', 'data') }));
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.get('/api/probe', (_req, res) => res.json({ who: currentTenant()?.id }));
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
  for (const rt of runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  closeHouse(); enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null);
  rmSync(base, { recursive: true, force: true }); rmSync(tenantsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('household: park one companion, the other does not notice', () => {
  it('closes A\'s socket, answers 503 at A\'s prefix and socket, lists A unavailable, leaves B\'s socket and routes alone; revive brings A back', async () => {
    const cookie = await cookieOf();
    const a = await open('/c/ada/ws', cookie);
    const b = await open('/c/bea/ws', cookie);
    let bClosed = false;
    void b.closed.then(() => { bClosed = true; });
    expect(listCompanions().map((c) => [c.id, c.status])).toEqual([['ada', 'ready'], ['bea', 'ready']]);

    expect((await op('park', 'ada')).json).toEqual({ id: 'ada', state: 'parked' });
    expect(await a.closed).toBe(1013);
    expect((await call('GET', '/c/ada/api/probe', { cookie })).status).toBe(503);
    expect(await refused('/c/ada/ws', cookie)).toBe(503);
    expect(listCompanions()).toEqual([
      { id: 'ada', name: 'ada', avatar_url: null, status: 'unavailable' },
      expect.objectContaining({ id: 'bea', status: 'ready' }),
    ]);
    expect((await call('GET', '/c/bea/api/probe', { cookie })).json).toEqual({ who: 'bea' });
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect(bClosed).toBe(false);
    expect((await op('park', 'ada')).status).toBe(409);

    expect((await op('revive', 'ada')).json).toEqual({ id: 'ada', state: 'running' });
    expect((await call('GET', '/c/ada/api/probe', { cookie })).json).toEqual({ who: 'ada' });
    expect(listCompanions().map((c) => [c.id, c.status])).toEqual([['ada', 'ready'], ['bea', 'ready']]);
    const again = await open('/c/ada/ws', cookie);
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
    again.ws.close(); b.ws.close();
  });
});
