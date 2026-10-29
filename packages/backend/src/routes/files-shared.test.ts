// The Files page's routes: its places and recent files, a file's bytes, and the shared shelf (shared/ in the companion's
// home), the only folder it may change. Every write outside the shelf, as written or through a link, is refused.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ home: '', workspace: '', outside: '' }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'files-shared-'));
  h.home = path.join(top, 'home'); h.workspace = path.join(top, 'workspace'); h.outside = path.join(top, 'outside');
  for (const d of [h.home, h.workspace, h.outside]) fs.mkdirSync(d);
  const cfg = {
    identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' },
    agent: { cwd: h.home },
    hooks: { safe_write_prefixes: [], workspace_root: h.workspace, vault_path: '', extra_write_paths: [] },
    integrations: {}, server: {},
  };
  return { ...actual, getSanctumConfig: () => cfg };
});
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() };
});

import router from './api.js';

let server: Server;
let base = '';
const app = express();
app.use(express.json());
app.use('/api', router);
beforeAll(async () => {
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); rmSync(join(h.home, '..'), { recursive: true, force: true }); });

const shelf = () => join(h.home, 'shared');
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const upload = (name: string, content: BlobPart, dir?: string) => {
  const form = new FormData();
  form.append('file', new Blob([content]), name);
  return fetch(`${base}/files/shared/upload${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`, { method: 'POST', body: form });
};
// A 1x1 PNG.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

describe('places', () => {
  it('lists the shelf (not made yet) and the roots, the home named for the companion', async () => {
    const res = await fetch(`${base}/files/places`);
    expect(res.status).toBe(200);
    const body = await res.json() as { shared: { exists: boolean; count: number }; places: Array<{ label: string; kind: string }> };
    expect(body.shared).toMatchObject({ exists: false, count: 0 });
    expect(body.places.map(p => [p.label, p.kind])).toEqual(expect.arrayContaining([["Echo's home", 'home'], ['Workspace', 'workspace']]));
  });
});

describe('the shelf', () => {
  it('an upload makes the shelf, keeps the name, and never replaces a file', async () => {
    const first = await upload('Garden sketch.png', PNG);
    expect(first.status).toBe(200);
    expect(readFileSync(join(shelf(), 'Garden sketch.png')).equals(Buffer.from(PNG))).toBe(true);
    const second = await upload('Garden sketch.png', PNG);
    expect(((await second.json()) as { entry: { name: string } }).entry.name).toBe('Garden sketch (2).png');
  });

  it('keeps a name in any script', async () => {
    expect((await upload('Café — notes ✿.txt', 'hello')).status).toBe(200);
    expect(existsSync(join(shelf(), 'Café — notes ✿.txt'))).toBe(true);
  });

  it('refuses an upload anywhere else: a root, a climb out, a planted link', async () => {
    expect((await upload('x.txt', 'x', h.workspace)).status).toBe(403);
    expect((await upload('x.txt', 'x', join(shelf(), '..'))).status).toBe(403);
    expect((await upload('x.txt', 'x', h.outside)).status).toBe(403);
    let linked = true;
    try { symlinkSync(h.outside, join(shelf(), 'door'), 'junction'); } catch { linked = false; }
    if (linked) expect((await upload('x.txt', 'x', join(shelf(), 'door'))).status).toBe(403);
    expect(existsSync(join(h.workspace, 'x.txt')) || existsSync(join(h.outside, 'x.txt')) || existsSync(join(h.home, 'x.txt'))).toBe(false);
    if (linked) rmSync(join(shelf(), 'door'), { force: true });
  });

  it('refuses a name it cannot keep: hidden, a path, a secret', async () => {
    for (const bad of ['.env', 'house.db', 'config.yaml']) expect((await upload(bad, 'x')).status).toBe(400);
  });

  it('makes a folder, uploads into it, and refuses a second folder by the same name', async () => {
    const made = await post('/files/shared/folder', { dir: shelf(), name: 'Recipes' });
    expect(made.status).toBe(200);
    expect((await post('/files/shared/folder', { dir: shelf(), name: 'Recipes' })).status).toBe(409);
    expect((await upload('lemon cake.md', '# cake', join(shelf(), 'Recipes'))).status).toBe(200);
    expect(readFileSync(join(shelf(), 'Recipes', 'lemon cake.md'), 'utf-8')).toBe('# cake');
    expect((await post('/files/shared/folder', { dir: h.workspace, name: 'Nope' })).status).toBe(403);
  });

  it('renames in place, refuses a taken name, and touches nothing outside the shelf', async () => {
    writeFileSync(join(shelf(), 'old.txt'), 'x');
    writeFileSync(join(shelf(), 'taken.txt'), 'x');
    expect((await post('/files/shared/rename', { path: join(shelf(), 'old.txt'), name: 'taken.txt' })).status).toBe(409);
    expect((await post('/files/shared/rename', { path: join(shelf(), 'old.txt'), name: 'new.txt' })).status).toBe(200);
    expect(existsSync(join(shelf(), 'new.txt')) && !existsSync(join(shelf(), 'old.txt'))).toBe(true);
    expect((await post('/files/shared/rename', { path: join(shelf(), 'new.txt'), name: '../escape.txt' })).status).toBe(400);
    writeFileSync(join(h.workspace, 'theirs.txt'), 'x');
    expect((await post('/files/shared/rename', { path: join(h.workspace, 'theirs.txt'), name: 'mine.txt' })).status).toBe(403);
    expect(existsSync(join(h.workspace, 'theirs.txt'))).toBe(true);
    expect((await post('/files/shared/rename', { path: shelf(), name: 'other' })).status).toBe(403);
  });

  it('never renames onto another file whose name differs only in case, and still changes a name\'s own case', async () => {
    writeFileSync(join(shelf(), 'Notes.txt'), 'upper');
    writeFileSync(join(shelf(), 'notes.txt'), 'lower');
    if (readFileSync(join(shelf(), 'Notes.txt'), 'utf-8') === 'upper') { // a filesystem that keeps both
      expect((await post('/files/shared/rename', { path: join(shelf(), 'Notes.txt'), name: 'notes.txt' })).status).toBe(409);
      expect(readFileSync(join(shelf(), 'notes.txt'), 'utf-8')).toBe('lower');
    }
    expect((await post('/files/shared/rename', { path: join(shelf(), 'notes.txt'), name: 'NOTES.txt' })).status).toBe(200);
  });

  it('an upload never follows a link planted in the shelf, even one pointing at nothing yet', async () => {
    const away = join(h.outside, 'planted.txt');
    try { symlinkSync(away, join(shelf(), 'planted.txt')); } catch { return; } // (no link rights on this machine)
    const res = await upload('planted.txt', 'x');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { entry: { name: string } }).entry.name).toBe('planted (2).txt');
    expect(existsSync(away)).toBe(false);
    rmSync(join(shelf(), 'planted.txt'), { force: true });
  });

  it('deletes a file or a whole folder in the shelf, never the shelf, never outside it', async () => {
    expect((await post('/files/shared/delete', { path: join(shelf(), 'new.txt') })).status).toBe(200);
    expect(existsSync(join(shelf(), 'new.txt'))).toBe(false);
    expect((await post('/files/shared/delete', { path: join(shelf(), 'Recipes') })).status).toBe(200);
    expect(existsSync(join(shelf(), 'Recipes'))).toBe(false);
    expect((await post('/files/shared/delete', { path: shelf() })).status).toBe(403);
    expect((await post('/files/shared/delete', { path: join(h.workspace, 'theirs.txt') })).status).toBe(403);
    expect((await post('/files/shared/delete', { path: join(shelf(), '..', 'workspace', 'theirs.txt') })).status).toBe(403);
    expect(existsSync(shelf()) && existsSync(join(h.workspace, 'theirs.txt'))).toBe(true);
  });
});

describe('a file’s bytes', () => {
  it('shows a picture inline, gives any file as a download, and nothing secret or outside', async () => {
    const pic = await fetch(`${base}/files/raw?path=${encodeURIComponent(join(shelf(), 'Garden sketch.png'))}`);
    expect(pic.status).toBe(200);
    expect(pic.headers.get('content-type')).toBe('image/png');
    expect(pic.headers.get('x-content-type-options')).toBe('nosniff');
    writeFileSync(join(h.workspace, 'notes.md'), '# notes');
    expect((await fetch(`${base}/files/raw?path=${encodeURIComponent(join(h.workspace, 'notes.md'))}`)).status).toBe(415);
    const dl = await fetch(`${base}/files/raw?path=${encodeURIComponent(join(h.workspace, 'notes.md'))}&download=1`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect(await dl.text()).toBe('# notes');
    writeFileSync(join(h.workspace, '.env'), 'KEY=1');
    expect((await fetch(`${base}/files/raw?path=${encodeURIComponent(join(h.workspace, '.env'))}&download=1`)).status).toBe(404);
    writeFileSync(join(h.outside, 'away.png'), Buffer.from(PNG));
    expect((await fetch(`${base}/files/raw?path=${encodeURIComponent(join(h.outside, 'away.png'))}`)).status).toBe(403);
  });
});

describe('recent files', () => {
  it('lists the newest across the shelf and the roots, once each', async () => {
    const body = await (await fetch(`${base}/files/recent?limit=20`)).json() as { files: Array<{ name: string; path: string }> };
    const names = body.files.map(f => f.name);
    expect(names).toContain('Garden sketch.png');
    expect(names).toContain('notes.md');
    expect(names).not.toContain('.env');
    expect(new Set(body.files.map(f => f.path)).size).toBe(body.files.length);
  });
});
