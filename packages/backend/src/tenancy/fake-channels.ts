// A small tenant server for the stage 3c tests (real auth, db and api routes over real tenants); the fake clients are in fake-clients.ts.
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { tenantResolve, tenantEnter } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess } from './test-runtime.js';
import { loginHandler } from '../middleware/auth.js';
import apiRoutes from '../routes/api.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import type { TenantRuntime } from './context.js';
import { fakes } from './fake-clients.js';
export { fakes, FakeClient, FakeBot } from './fake-clients.js';

export interface TenantSpec { host: string; password: string; env?: string; yaml?: string }
export interface Kit {
  runtimes: Map<string, TenantRuntime>;
  call(method: string, path: string, host: string, opts?: { cookie?: string; json?: unknown; headers?: Record<string, string> }): Promise<{ status: number; json: any; cookie: string }>;
  login(id: string): Promise<string>;
  close(): Promise<void>;
}

/** A real express app over real tenants (real auth, db and api routes), on a free port. The caller mocks discord.js / telegraf with the fakes above. */
export async function startKit(specs: Record<string, TenantSpec>): Promise<Kit> {
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { orchestrator: { enabled: false } });
  const tenants: Record<string, { yaml: string; env: string }> = {};
  for (const [id, s] of Object.entries(specs)) tenants[id] = { yaml: `hosts: [${s.host}]\n${s.yaml ?? ''}`, env: `APP_PASSWORD=${s.password}\n${s.env ?? ''}` };
  (proc as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir(tenants) };
  const app = express();
  const runtimes = bootTenants(app, safeTenancyProcess(proc));
  app.use(tenantResolve);
  app.use(express.json());
  app.use(tenantEnter);
  app.post('/api/auth/login', loginHandler);
  app.use('/api', apiRoutes);
  app.use(globalErrorHandler);
  const server = await new Promise<http.Server>((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const port = (server.address() as AddressInfo).port;
  const call: Kit['call'] = (method, path, host, opts = {}) => new Promise((ok, fail) => {
    const headers: Record<string, string> = { host, ...(opts.headers ?? {}) };
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
  return {
    runtimes, call,
    login: async (id) => (await call('POST', '/api/auth/login', specs[id].host, { json: { password: specs[id].password } })).cookie,
    close: async () => { await new Promise<void>((ok) => server.close(() => ok())); },
  };
}
