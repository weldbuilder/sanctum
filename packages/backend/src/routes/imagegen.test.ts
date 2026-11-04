import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({
  cfg: { provider: 'runware', model: '', size: '1024x1024', safety_checker: false, timeout_ms: 5000 } as Record<string, unknown>,
  appWrite: true,
  saved: [] as Array<{ name: string; mime: string; size: number }>,
  messages: [] as any[],
  broadcasts: [] as any[],
  threads: new Set(['t1']),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const cfg = { agent: { get app_write() { return h.appWrite; }, cwd: '/nonexistent-agent-cwd' }, get imagegen() { return h.cfg; } };
  return { ...actual, getSanctumConfig: () => cfg };
});
vi.mock('../services/files.js', () => ({
  saveFile: (buf: Buffer, name: string, mime: string) => {
    h.saved.push({ name, mime, size: buf.length });
    return { fileId: '11111111-2222-3333-4444-555555555555', filename: name, mimeType: mime, size: buf.length, contentType: 'image', url: '/api/files/11111111-2222-3333-4444-555555555555' };
  },
}));
vi.mock('../services/db.js', () => ({
  createMessage: (m: any) => { h.messages.push(m); return { ...m }; },
  updateThreadActivity: vi.fn(),
  getThread: (id: string) => (h.threads.has(id) ? { id, type: 'named' } : null),
  ensureDailyThread: () => ({ thread: { id: 'daily-1', type: 'daily', name: 'Today' }, justCreated: false }),
}));
vi.mock('../services/ws.js', () => ({ registry: { broadcast: (m: any) => h.broadcasts.push(m) } }));

import { imagesRouter } from './imagegen.js';

let server: Server;
let base = '';
const PNG_B64 = Buffer.from('png-bytes').toString('base64');

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/images', imagesRouter);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/images`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const realFetch = globalThis.fetch;
let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.cfg = { provider: 'runware', model: '', size: '1024x1024', safety_checker: false, timeout_ms: 5000 };
  h.appWrite = true; h.saved.length = 0; h.messages.length = 0; h.broadcasts.length = 0;
  vi.stubEnv('RUNWARE_API_KEY', 'rk'); vi.stubEnv('REPLICATE_API_TOKEN', '');
  upstream = vi.fn(async () => new Response(JSON.stringify({ data: [{ imageBase64Data: PNG_B64 }] })));
  vi.stubGlobal('fetch', (url: any, init?: any) => (String(url).startsWith('https://api.runware.ai') ? upstream(url, init) : realFetch(url, init)));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const gen = (body: unknown) => fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/images/generate', () => {
  it('409 when the provider is none, and when the key is missing; no upstream call', async () => {
    h.cfg.provider = 'none';
    let r = await gen({ prompt: 'x' });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, error: 'imagegen_not_configured' });
    h.cfg.provider = 'runware'; vi.stubEnv('RUNWARE_API_KEY', '');
    r = await gen({ prompt: 'x' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).detail).toContain('RUNWARE_API_KEY');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('400 on missing/long prompt and bad size', async () => {
    expect(await (await gen({})).json()).toEqual({ ok: false, error: 'prompt_required' });
    expect(await (await gen({ prompt: '   ' })).json()).toEqual({ ok: false, error: 'prompt_required' });
    const long = await gen({ prompt: 'a'.repeat(2001) });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ ok: false, error: 'prompt_too_long' });
    const bad = await gen({ prompt: 'x', size: '512x512' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'bad_size' });
  });

  it('200: saves the file, posts and broadcasts a companion image message, returns the contract', async () => {
    const r = await gen({ prompt: 'a red door', size: '1024x1536', thread_id: 't1' });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j).toMatchObject({ ok: true, file_id: '11111111-2222-3333-4444-555555555555', url: '/api/files/11111111-2222-3333-4444-555555555555', provider: 'runware', model: 'runware:100@1' });
    expect(typeof j.ms).toBe('number');
    expect(j.message_id).toBe(h.messages[0].id);
    expect(h.saved).toEqual([{ name: 'generated-image.png', mime: 'image/png', size: Buffer.from('png-bytes').length }]);
    expect(h.messages[0]).toMatchObject({ threadId: 't1', role: 'companion', contentType: 'image' });
    expect(h.messages[0].content).toBe(''); // the bubble renders any content as text under the image
    expect(h.messages[0].metadata).toMatchObject({ source: 'image-gen', provider: 'runware', model: 'runware:100@1', prompt: 'a red door', fileId: j.file_id });
    expect(h.messages[0].metadata.attachments).toEqual([expect.objectContaining({ fileId: j.file_id, filename: 'generated-image.png', contentType: 'image' })]);
    expect(h.broadcasts).toEqual([{ type: 'message', message: expect.objectContaining({ id: j.message_id }) }]);
    const sent = JSON.parse(upstream.mock.calls[0][1].body)[0];
    expect([sent.width, sent.height]).toEqual([1024, 1536]);
  });

  it('post_to_chat:false saves but posts nothing; no thread is needed', async () => {
    const j = await (await gen({ prompt: 'x', post_to_chat: false, thread_id: 'nope' })).json() as any;
    expect(j.ok).toBe(true);
    expect(j.message_id).toBeUndefined();
    expect(h.messages).toHaveLength(0);
    expect(h.saved).toHaveLength(1);
  });

  it('no thread_id lands in today\'s daily; an unknown thread is 404', async () => {
    await gen({ prompt: 'x' });
    expect(h.messages[0].threadId).toBe('daily-1');
    expect((await gen({ prompt: 'x', thread_id: 'nope' })).status).toBe(404);
  });

  it('502 with a safe class on upstream failure, and the response never carries the upstream body or key', async () => {
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code: 'invalidApiKey', message: 'key rk rejected: secret-body' }] }), { status: 401 }));
    const r = await gen({ prompt: 'x' });
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'provider_error', provider: 'runware', detail: 'auth' });
    expect(text).not.toContain('secret-body');
    expect(text).not.toContain('rk');
    expect(h.messages).toHaveLength(0);
  });

  it('504 on provider timeout', async () => {
    h.cfg.timeout_ms = 30;
    upstream.mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))));
    const r = await gen({ prompt: 'x' });
    expect(r.status).toBe(504);
    expect(await r.json()).toEqual({ ok: false, error: 'provider_timeout', provider: 'runware' });
  });

  it('403 when app_write is off', async () => {
    h.appWrite = false;
    expect((await gen({ prompt: 'x' })).status).toBe(403);
  });

  it('a per-request provider override needs that provider\'s key', async () => {
    const r = await gen({ prompt: 'x', provider: 'replicate' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).detail).toContain('REPLICATE_API_TOKEN');
  });
});

describe('GET /api/images/status', () => {
  it('reports configured only when provider and key are both present', async () => {
    let j = await (await fetch(`${base}/status`)).json() as any;
    expect(j).toEqual({ ok: true, configured: true, offered: true, provider: 'runware', model: 'runware:100@1', providers_with_keys: ['runware'] });
    vi.stubEnv('RUNWARE_API_KEY', '');
    j = await (await fetch(`${base}/status`)).json() as any;
    expect(j).toEqual({ ok: true, configured: false, offered: false, reason: 'not_configured', provider: null, model: null, providers_with_keys: [] });
    h.cfg.provider = 'none'; vi.stubEnv('REPLICATE_API_TOKEN', 't');
    j = await (await fetch(`${base}/status`)).json() as any;
    expect(j).toMatchObject({ configured: false, offered: false, reason: 'not_configured', provider: null, providers_with_keys: ['replicate'] });
  });

  it('configured but app_write off: offered false, reason app_write_off, provider and model still reported', async () => {
    h.appWrite = false;
    const j = await (await fetch(`${base}/status`)).json() as any;
    expect(j).toEqual({ ok: true, configured: true, offered: false, reason: 'app_write_off', provider: 'runware', model: 'runware:100@1', providers_with_keys: ['runware'] });
  });
});
