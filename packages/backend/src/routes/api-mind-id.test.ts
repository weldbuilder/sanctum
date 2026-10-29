// mind_id is validated at save (PUT /api/settings, PUT /api/preferences) against the service's pattern.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ kv: new Map<string, string>(), root: '' }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  h.root = mkdtempSync(join(tmpdir(), 'mind-id-'));
  writeFileSync(join(h.root, 'sanctum.yaml'), 'identity:\n  companion_name: T\nintegrations:\n  mind_cloud:\n    enabled: true\n    mind_id: alpha\n');
  return { ...actual, PROJECT_ROOT: h.root, getSanctumConfig: () => ({ identity: { user_name: 'Pat' }, integrations: { mind_cloud: { enabled: true, mcp_url: '', mind_id: 'alpha' } }, server: {} }) };
});
vi.mock('../services/db.js', async () => {
  const actual = await vi.importActual<typeof import('../services/db.js')>('../services/db.js');
  return { ...actual, getConfig: (k: string) => h.kv.get(k) ?? null, setConfig: (k: string, v: string) => { h.kv.set(k, v); } };
});

vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: any, _res: any, next: () => void) => next() };
});

import router from './api.js';

let server: Server;
let base = '';
const app = express();
app.use(express.json());
app.use('/api', router);
beforeAll(async () => { await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`; });
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { h.kv.clear(); });
const put = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('PUT /api/settings mind.mind_id', () => {
  it('stores an id the service accepts, and clearing it', async () => {
    expect((await put('/settings', { key: 'mind.mind_id', value: 'alpha-1_B' })).status).toBe(200);
    expect(h.kv.get('mind.mind_id')).toBe('alpha-1_B');
    expect((await put('/settings', { key: 'mind.mind_id', value: '' })).status).toBe(200);
    expect(h.kv.get('mind.mind_id')).toBe('');
  });
  it.each(['has space', 'dot.id', 'a/b', 'x'.repeat(65), 'émile', '__proto__', 'constructor'])('refuses %j with a 400 that names the rule', async (bad) => {
    const res = await put('/settings', { key: 'mind.mind_id', value: bad });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('^[a-zA-Z0-9_-]{1,64}$');
    expect(h.kv.has('mind.mind_id')).toBe(false);
  });
  it('leaves other keys alone', async () => {
    expect((await put('/settings', { key: 'mind.url', value: 'http://x y' })).status).toBe(200);
  });
});

describe('PUT /api/preferences integrations.mind_cloud.mind_id', () => {
  it('refuses a bad id with a 400 and writes nothing', async () => {
    const before = readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8');
    const res = await put('/preferences', { integrations: { mind_cloud: { mind_id: 'bad id!' } } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('^[a-zA-Z0-9_-]{1,64}$');
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toBe(before);
  });
  it('saves a good id', async () => {
    const res = await put('/preferences', { integrations: { mind_cloud: { mind_id: 'beta_2' } } });
    expect(res.status).toBe(200);
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toContain('beta_2');
  });
});
