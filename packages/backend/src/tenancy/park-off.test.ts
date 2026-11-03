// Tenancy off: the park and revive routes do not exist. The router stands aside (next()) with or without the operator token, so the paths are as unknown as any
// other, and the park functions refuse (404) because there is nothing booted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tenancyEnabled } from './context.js';
import { loadOperatorToken, operatorRouter } from './operator.js';
import { ParkRefusal, parkTenant, reviveTenant, tenantStatuses } from './park.js';

let server: http.Server;
let port = 0;
let dir = '';
let token = '';

const call = (method: string, path: string, headers: Record<string, string> = {}): Promise<number> => new Promise((ok, fail) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode ?? 0)); });
  req.on('error', fail); req.end();
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sanctum-park-off-'));
  token = loadOperatorToken(dir);
  const app = express();
  app.use('/api/internal/tenants', operatorRouter(token));
  app.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((ok) => server.close(() => ok())); rmSync(dir, { recursive: true, force: true }); });

describe('tenancy off', () => {
  it('park and revive answer 404, with no token, a wrong one and the right one', async () => {
    expect(tenancyEnabled()).toBe(false);
    for (const action of ['park', 'revive']) {
      for (const headers of [{} as Record<string, string>, { 'x-internal-token': 'wrong' }, { 'x-internal-token': token }]) {
        expect(await call('POST', `/api/internal/tenants/ada/${action}`, headers)).toBe(404);
      }
    }
    expect(await call('GET', '/api/internal/tenants', { 'x-internal-token': token })).toBe(404);
  });
  it('the park functions refuse and list nothing', async () => {
    expect(tenantStatuses()).toEqual([]);
    await expect(parkTenant('ada')).rejects.toBeInstanceOf(ParkRefusal);
    expect(() => reviveTenant('ada')).toThrow(ParkRefusal);
  });
});
