// Reference routes: real router, real files.ts (temp folder), real in-memory database.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ top: '', appWrite: true, authed: true }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  h.top = fs.mkdtempSync(path.join(os.tmpdir(), 'refroutes-'));
  const cfg = {
    identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' },
    agent: { get app_write() { return h.appWrite; }, cwd: h.top },
    hooks: { safe_write_prefixes: [], workspace_root: '', vault_path: '', extra_write_paths: [] },
    integrations: {}, server: {},
  };
  return { ...actual, PROJECT_ROOT: h.top, getSanctumConfig: () => cfg };
});
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: unknown, res: any, next: () => void) => (h.authed ? next() : res.status(401).json({ error: 'unauthorized' })) };
});

import router from './api.js';
import { initDb, getDb } from '../services/db.js';

let server: Server;
let base = '';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const app = express();
app.use(express.json());
app.use('/api', router);

beforeAll(async () => {
  initDb(':memory:');
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); rmSync(h.top, { recursive: true, force: true }); });
beforeEach(() => { h.appWrite = true; h.authed = true; getDb().prepare('DELETE FROM "references"').run(); });

const up = (name: string | null, bytes: Buffer, fields: Record<string, string> = {}, filename = 'a.png', type = 'image/png') => {
  const fd = new FormData();
  if (name !== null) fd.append('name', name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
  return fetch(`${base}/references`, { method: 'POST', body: fd });
};
const patch = (id: string, body: unknown) => fetch(`${base}/references/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const list = async () => ((await (await fetch(`${base}/references`)).json()) as any).references as any[];
const filesDir = () => join(h.top, 'data', 'files');

describe('reference routes', () => {
  it('uploads with name, self and note; lists it; stores source "reference"; serves the picture', async () => {
    const r = await up('Echo', PNG, { self: '1', note: 'Echo in the green coat' });
    expect(r.status).toBe(201);
    const { reference } = await r.json() as any;
    expect(reference).toMatchObject({ name: 'Echo', self: true, note: 'Echo in the green coat' });
    expect(reference.url).toContain(`/api/files/${reference.fileId}`);
    expect(Object.keys(reference).sort()).toEqual(['createdAt', 'fileId', 'id', 'name', 'note', 'self', 'url']);
    expect((await list()).map((x) => x.name)).toEqual(['Echo']);
    expect(JSON.parse(readFileSync(join(filesDir(), `${reference.fileId}.meta.json`), 'utf-8')).source).toBe('reference');
    expect((await fetch(`${base}/files/${reference.fileId}`)).status).toBe(200);
    const filtered = await (await fetch(`${base}/files?source=reference`)).json() as any;
    expect(filtered.files.map((f: any) => f.id ?? f.fileId)).toContain(reference.fileId);
  });

  it('self and note default to off and empty', async () => {
    const { reference } = await (await up('Sam', PNG)).json() as any;
    expect(reference).toMatchObject({ self: false, note: '' });
  });

  it('error codes: name_taken 409, too_large 413, self_limit 409, library_full 409, the rest 400', async () => {
    expect((await up(null, PNG)).status).toBe(400);
    expect((await up('Sam', PNG)).status).toBe(201);
    const dup = await up('sAM', PNG);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).error).toBe('name_taken');
    expect((await up('Doc', Buffer.from('hello'), {}, 'a.txt', 'text/plain')).status).toBe(400);
    expect((await up('Pipe|name', PNG)).status).toBe(400);
    const big = await up('Big', Buffer.concat([PNG, Buffer.alloc(1_000_001)]));
    expect(big.status).toBe(413);
    expect(((await big.json()) as any).error).toBe('too_large');
    for (let i = 0; i < 4; i++) expect((await up(`Me${i}`, PNG, { self: '1' })).status).toBe(201);
    const s = await up('Me5', PNG, { self: '1' });
    expect(s.status).toBe(409);
    expect(((await s.json()) as any).error).toBe('self_limit');
    for (let i = (await list()).length; i < 12; i++) expect((await up(`T${i}`, PNG)).status).toBe(201);
    const full = await up('Extra', PNG);
    expect(full.status).toBe(409);
    expect(((await full.json()) as any).error).toBe('library_full');
  });

  it('PATCH changes self and note, validates the shape, and maps errors', async () => {
    const { reference } = await (await up('Sam', PNG)).json() as any;
    const r = await patch(reference.id, { self: true, note: 'Sam by the lake' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).reference).toMatchObject({ self: true, note: 'Sam by the lake' });
    expect((await list())[0]).toMatchObject({ self: true, note: 'Sam by the lake' });
    expect((await patch(reference.id, { self: 'yes' })).status).toBe(400);
    expect((await patch(reference.id, { note: 'n'.repeat(201) })).status).toBe(400);
    expect((await patch('missing', { note: 'x' })).status).toBe(404);
    for (let i = 0; i < 3; i++) await up(`Me${i}`, PNG, { self: '1' });
    const other = await (await up('Lake house', PNG)).json() as any;
    const full = await patch(other.reference.id, { self: true });
    expect(full.status).toBe(409);
    expect(((await full.json()) as any).error).toBe('self_limit');
  });

  it('writes answer 403 when app writes are off; the list does not', async () => {
    const { reference } = await (await up('Sam', PNG)).json() as any;
    h.appWrite = false;
    const r = await up('Other', PNG);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toBe('app_write_off');
    expect((await patch(reference.id, { note: 'x' })).status).toBe(403);
    expect((await fetch(`${base}/references/${reference.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await fetch(`${base}/references`)).status).toBe(200);
    expect(await list()).toHaveLength(1);
  });

  it('every route needs a session', async () => {
    h.authed = false;
    expect((await fetch(`${base}/references`)).status).toBe(401);
    expect((await up('Sam', PNG)).status).toBe(401);
    expect((await patch('x', { note: 'x' })).status).toBe(401);
    expect((await fetch(`${base}/references/x`, { method: 'DELETE' })).status).toBe(401);
  });

  it('delete removes the row, the file and its sidecar; an unknown id is 404', async () => {
    const { reference } = await (await up('Sam', PNG)).json() as any;
    const del = await fetch(`${base}/references/${reference.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(existsSync(join(filesDir(), `${reference.fileId}.png`))).toBe(false);
    expect(existsSync(join(filesDir(), `${reference.fileId}.meta.json`))).toBe(false);
    expect(await list()).toEqual([]);
    expect((await fetch(`${base}/references/${reference.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
