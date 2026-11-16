// Sticker routes: real router, real files.ts (temp folder), real in-memory database.
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
  h.top = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-'));
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
beforeEach(() => { h.appWrite = true; h.authed = true; getDb().prepare('DELETE FROM stickers').run(); });

const up = (name: string | null, bytes: Buffer, filename = 'wave.png', type = 'image/png') => {
  const fd = new FormData();
  if (name !== null) fd.append('name', name);
  fd.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
  return fetch(`${base}/stickers`, { method: 'POST', body: fd });
};
const filesDir = () => join(h.top, 'data', 'files');

describe('sticker routes', () => {
  it('uploads a picture, lists it, and keeps it in the file store with source "sticker"', async () => {
    const r = await up('Wave', PNG);
    expect(r.status).toBe(201);
    const { sticker } = await r.json() as any;
    expect(sticker).toMatchObject({ name: 'Wave' });
    const list = await (await fetch(`${base}/stickers`)).json() as any;
    expect(list.stickers.map((s: any) => s.name)).toEqual(['Wave']);
    const meta = JSON.parse(readFileSync(join(filesDir(), `${sticker.fileId}.meta.json`), 'utf-8'));
    expect(meta.source).toBe('sticker');
    expect(existsSync(join(filesDir(), `${sticker.fileId}.png`))).toBe(true);
    // the picture is served by the ordinary file route
    expect((await fetch(`${base}/files/${sticker.fileId}`)).status).toBe(200);
  });

  it('refuses: no name, a duplicate name (any case), a non-image, a fake image, and more than 2 MB', async () => {
    expect((await up(null, PNG)).status).toBe(400);
    expect((await up('   ', PNG)).status).toBe(400);
    expect((await up('Wave', PNG)).status).toBe(201);
    const dup = await up('wAVE', PNG);
    expect(dup.status).toBe(409);
    expect((await dup.json() as any).error).toBe('name_taken');
    expect((await up('Doc', Buffer.from('hello'), 'a.txt', 'text/plain')).status).toBe(400);
    expect((await up('Fake', Buffer.from('not a png at all'), 'f.png', 'image/png')).status).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 10)]);
    expect((await up('Big', big)).status).toBe(413);
    expect((await up('Bad[name', PNG)).status).toBe(400);
    expect(((await (await fetch(`${base}/stickers`)).json()) as any).stickers).toHaveLength(1);
  });

  it('refuses names with a comma, edge whitespace, or more than 40 characters (400), and takes exactly 40', async () => {
    for (const bad of ['one, two', ' Wave', 'Wave ', '\tWave', 'x'.repeat(41)]) {
      const r = await up(bad, PNG);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(typeof ((await r.json()) as any).message).toBe('string');
    }
    expect((await up('x'.repeat(40), PNG)).status).toBe(201);
    expect(((await (await fetch(`${base}/stickers`)).json()) as any).stickers).toHaveLength(1);
  });

  it('upload answers 403 when app writes are off; list and delete do not', async () => {
    const { sticker } = await (await up('Wave', PNG)).json() as any;
    h.appWrite = false;
    const r = await up('Other', PNG);
    expect(r.status).toBe(403);
    expect((await r.json() as any).error).toBe('app_write_off');
    expect((await fetch(`${base}/stickers`)).status).toBe(200);
    expect((await fetch(`${base}/stickers/${sticker.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('every route needs a session', async () => {
    h.authed = false;
    expect((await fetch(`${base}/stickers`)).status).toBe(401);
    expect((await up('Wave', PNG)).status).toBe(401);
    expect((await fetch(`${base}/stickers/x`, { method: 'DELETE' })).status).toBe(401);
  });

  it('delete removes the row, the file and its sidecar; an unknown id is 404', async () => {
    const { sticker } = await (await up('Wave', PNG)).json() as any;
    const del = await fetch(`${base}/stickers/${sticker.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(existsSync(join(filesDir(), `${sticker.fileId}.png`))).toBe(false);
    expect(existsSync(join(filesDir(), `${sticker.fileId}.meta.json`))).toBe(false);
    expect(((await (await fetch(`${base}/stickers`)).json()) as any).stickers).toEqual([]);
    expect((await fetch(`${base}/stickers/${sticker.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
