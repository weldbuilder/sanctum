// GET /api/sessions in tenant mode lists the transcripts under the tenant's own data/harness/claude, never the process's store.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, type TenantRuntime } from './context.js';
import { tenantResolve, tenantEnter, setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';

const A = 'ada.example.net';
const B = 'bea.example.net';
let server: http.Server;
let port = 0;
let runtimes: Map<string, TenantRuntime>;

function call(method: string, path: string, host: string, opts: { cookie?: string; json?: unknown } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  return new Promise((ok, fail) => {
    const body = opts.json === undefined ? undefined : Buffer.from(JSON.stringify(opts.json));
    const headers: Record<string, string> = { host, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json: unknown = null; try { json = JSON.parse(text); } catch { /* */ } ok({ status: res.statusCode ?? 0, headers: res.headers, json }); });
    });
    req.on('error', fail); req.end(body);
  });
}
const cookieOf = async (host: string, password: string) => ((await call('POST', '/api/auth/login', host, { json: { password } })).headers['set-cookie']?.[0] ?? '').split(';')[0];

function seed(rt: TenantRuntime, id: string, prompt: string): void {
  mkdirSync(rt.homeDir, { recursive: true });
  const project = realpathSync.native(rt.homeDir).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = join(rt.dataDir, 'harness', 'claude', 'projects', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
}

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
  seed(runtimes.get('ada')!, 'sess-ada-1', 'a question only ada asked');
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
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('/api/sessions per tenant', () => {
  it('lists A\'s transcripts for A, nothing for B, and 401 without a session', async () => {
    const a = await call('GET', '/api/sessions', A, { cookie: await cookieOf(A, 'pw-ada') });
    expect(a.status).toBe(200);
    expect(a.json.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['sess-ada-1']);
    expect(a.json.sessions[0].firstPrompt).toBe('a question only ada asked');
    const b = await call('GET', '/api/sessions', B, { cookie: await cookieOf(B, 'pw-bea') });
    expect(b.status).toBe(200);
    expect(b.json.sessions).toEqual([]);
    expect((await call('GET', '/api/sessions', B, { cookie: await cookieOf(A, 'pw-ada') })).status).toBe(401);
  });
  it('/api/tts answers "not configured" for a tenant with no voice keys, and /api/system/status is that tenant\'s', async () => {
    const cookie = await cookieOf(A, 'pw-ada');
    const tts = await call('POST', '/api/tts', A, { cookie, json: { text: 'hello' } });
    expect(tts.status).toBe(503);
    expect(tts.json.error).toMatch(/not configured/i);
    const st = await call('GET', '/api/system/status', A, { cookie });
    expect(st.status).toBe(200);
    expect(st.json.websocketClients).toBe(0);
  });
});
