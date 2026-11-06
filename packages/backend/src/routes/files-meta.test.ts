// Generated images are identifiable in the Files list (sidecar meta + ?source= filter) and can be shared into a chat.
// Real router, real files.ts (in a temp folder), real in-memory database; only the provider's HTTP is stubbed.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({
  top: '',
  appWrite: true,
  cfg: { provider: 'runware', model: '', size: '1024x1024', safety_checker: false, timeout_ms: 5000 } as Record<string, unknown>,
  broadcasts: [] as any[],
  processed: [] as any[],
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  h.top = fs.mkdtempSync(path.join(os.tmpdir(), 'files-meta-'));
  const cfg = {
    identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' },
    agent: { get app_write() { return h.appWrite; }, cwd: h.top },
    hooks: { safe_write_prefixes: [], workspace_root: '', vault_path: '', extra_write_paths: [] },
    integrations: {}, server: {},
    get imagegen() { return h.cfg; },
  };
  return { ...actual, PROJECT_ROOT: h.top, getSanctumConfig: () => cfg };
});
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() };
});
vi.mock('../services/ws.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ws.js')>('../services/ws.js');
  return { ...actual, registry: { ...actual.registry, broadcast: (m: any) => { h.broadcasts.push(m); } } };
});

import router from './api.js';
import { initDb, createThread, getMessages } from '../services/db.js';
import { generateImage } from '../services/imagegen/index.js';
import { saveFile } from '../services/files.js';

let server: Server;
let base = '';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const realFetch = globalThis.fetch;
const app = express();
app.use(express.json());
app.locals.agentService = { processMessage: async (...args: any[]) => { h.processed.push(args); return ''; } };
app.use('/api', router);

beforeAll(async () => {
  initDb(':memory:');
  createThread({ id: 't1', name: 'Thread', type: 'named', createdAt: new Date().toISOString() });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); rmSync(h.top, { recursive: true, force: true }); });
beforeEach(() => {
  h.appWrite = true; h.broadcasts.length = 0; h.processed.length = 0;
  vi.stubEnv('RUNWARE_API_KEY', 'rk');
  vi.stubGlobal('fetch', (url: any, init?: any) => String(url).startsWith('https://api.runware.ai')
    ? Promise.resolve(new Response(JSON.stringify({ data: [{ imageBase64Data: PNG.toString('base64') }] })))
    : realFetch(url, init));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const list = async (q = '') => (await (await fetch(`${base}/files/list${q}`)).json()) as { files: any[]; totalCount: number };
const share = (id: string, body: unknown) => fetch(`${base}/files/${id}/share-to-chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('file meta + ?source filter', () => {
  it('a generated image carries meta in the list; an upload carries none; the filter keeps only generated files', async () => {
    const upload = saveFile(PNG, 'cat.png', 'image/png');
    const gen = await generateImage({ prompt: 'a fox in snow', postToChat: false });

    const all = await list();
    const g = all.files.find((f) => f.fileId === gen.file_id);
    const u = all.files.find((f) => f.fileId === upload.fileId);
    expect(g.meta).toMatchObject({ source: 'image-gen', prompt: 'a fox in snow', provider: 'runware', model: 'runware:100@1', filename: 'generated-image.png' });
    expect(typeof g.meta.createdAt).toBe('string');
    expect(u.meta).toBeUndefined();

    const only = await list('?source=image-gen');
    expect(only.files.map((f) => f.fileId)).toEqual([gen.file_id]);
    expect((await list('?source=nope')).files).toEqual([]);
    // GET /api/files is the same listing as /api/files/list.
    const bare = await (await fetch(`${base}/files?source=image-gen`)).json() as any;
    expect(bare.files.map((f: any) => f.fileId)).toEqual([gen.file_id]);
  });

  it('the sidecar is never listed as a file, and is removed with its file', async () => {
    const gen = await generateImage({ prompt: 'x', postToChat: false });
    const dir = join(h.top, 'data', 'files');
    expect(readdirSync(dir).some((n) => n === `${gen.file_id}.meta.json`)).toBe(true);
    expect((await list()).files.some((f) => f.filename.endsWith('.meta.json'))).toBe(false);
    expect((await fetch(`${base}/files/${gen.file_id}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(dir, `${gen.file_id}.meta.json`))).toBe(false);
  });
});

describe('POST /api/files/:id/share-to-chat', () => {
  it('posts a user message with the attachment, empty content, broadcasts it, and hands the file to the agent', async () => {
    const gen = await generateImage({ prompt: 'a lamp', postToChat: false });
    const r = await share(gen.file_id, { thread_id: 't1' });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    const stored = getMessages({ threadId: 't1', limit: 10 }).find((m) => m.id === j.message_id)!;
    expect(stored.role).toBe('user');
    expect(stored.content).toBe('');
    expect((stored.metadata as any).attachments).toEqual([expect.objectContaining({ fileId: gen.file_id, filename: 'generated-image.png', contentType: 'image', mimeType: 'image/png', url: expect.stringContaining(gen.file_id) })]);
    expect(h.broadcasts).toEqual([{ type: 'message', message: expect.objectContaining({ id: j.message_id, role: 'user' }) }]);
    await new Promise((r2) => setTimeout(r2, 10));
    expect(h.processed).toHaveLength(1);
    expect(h.processed[0][0]).toBe('t1');
    expect(h.processed[0][3]).toMatchObject({ platform: 'web', images: [{ fileId: gen.file_id, filename: 'generated-image.png', contentType: 'image' }] });
  });

  it('404 for a missing file or thread, 400 without thread_id, 403 when app writes are off', async () => {
    const gen = await generateImage({ prompt: 'x', postToChat: false });
    const noFile = await share('00000000-0000-4000-8000-000000000000', { thread_id: 't1' });
    expect(noFile.status).toBe(404);
    expect(await noFile.json()).toMatchObject({ error: 'file_not_found' });
    const noThread = await share(gen.file_id, { thread_id: 'nope' });
    expect(noThread.status).toBe(404);
    expect(await noThread.json()).toMatchObject({ error: 'thread_not_found' });
    expect((await share(gen.file_id, {})).status).toBe(400);
    h.appWrite = false;
    expect((await share(gen.file_id, { thread_id: 't1' })).status).toBe(403);
  });
});

describe('share-to-chat rate limit', () => {
  it('is limited to 10 a minute, like POST /files', async () => {
    const gen = await generateImage({ prompt: 'rl', postToChat: false });
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await share(gen.file_id, { thread_id: 'nope' })).status);
    expect(statuses).toContain(429);
  });
});
