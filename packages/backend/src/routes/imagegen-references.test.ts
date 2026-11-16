// references / as_self on POST /api/images/generate and on the workspace MCP generate_image tool (real database and library; only the provider is stubbed).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ top: '', appWrite: true, cfg: {} as Record<string, unknown> }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  h.top = fs.mkdtempSync(path.join(os.tmpdir(), 'imgrefs-'));
  const cfg = { identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' }, agent: { get app_write() { return h.appWrite; }, cwd: h.top }, get imagegen() { return h.cfg; } };
  return { ...actual, PROJECT_ROOT: h.top, getSanctumConfig: () => cfg };
});
vi.mock('../services/google-auth.js', () => ({ accountForApp: () => null, isScopeGranted: () => false, getClientForApp: () => null, GoogleAppNotBoundError: class extends Error {} }));
vi.mock('../services/ws.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ws.js')>('../services/ws.js');
  return { ...actual, registry: { ...actual.registry, broadcast: vi.fn() } };
});
vi.mock('../routes/cc-mcp.js', () => ({ CC_TOOL_NAMES: ['cc_status'] }));

import { imagesRouter } from './imagegen.js';
import workspace from './workspace-mcp.js';
import { initDb, getDb } from '../services/db.js';
import { addReference } from '../services/media/references.js';
import { setMode, grant, turnOff } from '../services/consent/gate.js';

let server: Server; let base = '';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const PNG_B64 = Buffer.from('png-bytes').toString('base64');
const add = (name: string, self = false) => addReference({ name, self, buffer: PNG, filename: `${name}.png`, mime: 'image/png' });

beforeAll(async () => {
  initDb(':memory:');
  const app = express(); app.use(express.json());
  app.use('/api/images', imagesRouter); app.use('/mcp/workspace', workspace);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); rmSync(h.top, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.cfg = { provider: 'runware', model: '', reference_model: '', size: '1024x1024', safety_checker: false, timeout_ms: 5000 };
  h.appWrite = true;
  getDb().prepare('DELETE FROM "references"').run();
  vi.stubEnv('RUNWARE_API_KEY', 'rk'); vi.stubEnv('REPLICATE_API_TOKEN', '');
  upstream = vi.fn(async () => new Response(JSON.stringify({ data: [{ imageBase64Data: PNG_B64 }] })));
  vi.stubGlobal('fetch', (url: any, init?: any) => (String(url).startsWith('https://api.runware.ai') ? upstream(url, init) : realFetch(url, init)));
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const gen = (body: unknown) => fetch(`${base}/api/images/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sentTask = () => JSON.parse(upstream.mock.calls[0][1].body)[0];
const rpc = async (method: string, params?: unknown) =>
  (await (await fetch(`${base}/mcp/workspace`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any;

describe('POST /api/images/generate with references', () => {
  it('names go to the provider as reference images on the reference model; the response lists used and unknown names', async () => {
    add('Sam'); add('Lake house');
    const j = await (await gen({ prompt: 'a picnic', references: ['sam', 'Lake house', 'Nobody'], post_to_chat: false })).json() as any;
    expect(j).toMatchObject({ ok: true, model: 'bfl:3@1', references: ['Sam', 'Lake house'], unknown_references: ['Nobody'], as_self: false });
    expect(sentTask().model).toBe('bfl:3@1');
    expect(sentTask().inputs.referenceImages).toHaveLength(2);
    expect(sentTask().inputs.referenceImages[0]).toMatch(/^data:image\/png;base64,/);
  });

  it('as_self draws from the companion\'s own references first', async () => {
    add('Sam'); add('Echo', true);
    const j = await (await gen({ prompt: 'on the porch', as_self: true, references: ['Sam'], post_to_chat: false })).json() as any;
    expect(j).toMatchObject({ ok: true, references: ['Echo', 'Sam'], as_self: true });
  });

  it('no references: the body is the text-only one and the response lists none', async () => {
    add('Sam');
    const j = await (await gen({ prompt: 'a lamp', post_to_chat: false })).json() as any;
    expect(j).toMatchObject({ ok: true, model: 'runware:100@1', references: [], unknown_references: [], as_self: false });
    expect('inputs' in sentTask()).toBe(false);
  });

  it('400 on a bad shape: not an array, more than four, an empty or long or non-string name, a non-boolean as_self', async () => {
    for (const references of ['Sam', 5, ['a', 'b', 'c', 'd', 'e'], [''], ['  '], ['x'.repeat(41)], [3], [null]]) {
      const r = await gen({ prompt: 'x', references });
      expect(r.status, JSON.stringify(references)).toBe(400);
      expect(await r.json()).toEqual({ ok: false, error: 'bad_references' });
    }
    for (const as_self of ['yes', 1, 'true']) {
      const r = await gen({ prompt: 'x', as_self });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ ok: false, error: 'bad_as_self' });
    }
    expect(upstream).not.toHaveBeenCalled();
    expect((await gen({ prompt: 'x', references: ['x'.repeat(40)], post_to_chat: false })).status).toBe(200);
    expect((await gen({ prompt: 'x', references: [], post_to_chat: false })).status).toBe(200);
  });

  it('a provider failure still answers with a coarse class only', async () => {
    add('Sam');
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code: 'badReference', message: 'secret-body data:image' }] }), { status: 400 }));
    const r = await gen({ prompt: 'x', references: ['Sam'], post_to_chat: false });
    expect(r.status).toBe(502);
    const t = await r.text();
    expect(JSON.parse(t)).toEqual({ ok: false, error: 'provider_error', provider: 'runware', detail: 'bad_request' });
  });
});

describe('workspace MCP generate_image with references', () => {
  const call = (args: Record<string, unknown>) => rpc('tools/call', { name: 'generate_image', arguments: args });

  it('the schema offers references (array of strings, up to 4) and as_self (boolean); prompt stays the only required field', async () => {
    const t = (await rpc('tools/list')).result.tools.find((x: any) => x.name === 'generate_image');
    expect(t.inputSchema.required).toEqual(['prompt']);
    expect(t.inputSchema.properties.references).toMatchObject({ type: 'array', items: { type: 'string' }, maxItems: 4 });
    expect(t.inputSchema.properties.as_self).toMatchObject({ type: 'boolean' });
    expect(typeof t.inputSchema.properties.references.description).toBe('string');
  });

  it('passes the names and as_self through; a skipped name is told back in the one line', async () => {
    add('Echo', true); add('Sam');
    const r = await call({ prompt: 'a walk', as_self: true, references: ['Sam', 'Ghost'] });
    expect(r.result.isError).not.toBe(true);
    expect(r.result.content[0].text).toBe('Image generated and posted (runware, bfl:3@1) Not in your references, skipped: Ghost.');
    expect(sentTask().inputs.referenceImages).toHaveLength(2);
  });

  it('without references the line is the one it always was', async () => {
    const r = await call({ prompt: 'a walk' });
    expect(r.result.content[0].text).toBe('Image generated and posted (runware, runware:100@1)');
  });

  it('rejects a bad shape as a tool error, before any provider call', async () => {
    for (const args of [{ references: 'Sam' }, { references: ['a', 'b', 'c', 'd', 'e'] }, { references: [1] }, { as_self: 'yes' }]) {
      const r = await call({ prompt: 'x', ...args });
      expect(r.result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('workspace MCP generate_image and the consent gate', () => {
  const call = (args: Record<string, unknown>) => rpc('tools/call', { name: 'generate_image', arguments: args });
  const receipts = (outcome: string) => getDb().prepare("SELECT harness, tool_or_route, summary FROM consent_receipts WHERE capability = 'app_write' AND tool_or_route = 'generate_image' AND outcome = ?").all(outcome) as Array<{ harness: string; tool_or_route: string; summary: string }>;
  const reset = () => { getDb().prepare('DELETE FROM consent_receipts').run(); getDb().prepare("DELETE FROM config WHERE key LIKE 'consent.%'").run(); };
  beforeEach(reset);
  afterEach(reset);

  it('allowed: generates, and leaves an allowed receipt naming the tool, the harness and the prompt', async () => {
    const r = await call({ prompt: 'a red door' });
    expect(r.result.isError).not.toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(receipts('allowed')).toEqual([{ harness: 'claude', tool_or_route: 'generate_image', summary: 'a red door' }]);
  });

  it('app_write turned off in the gate: the tool answers "app_write is off", nothing reaches the provider, a denied receipt is written', async () => {
    turnOff('app_write');
    const r = await call({ prompt: 'a red door' });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe('app_write is off');
    expect(upstream).not.toHaveBeenCalled();
    expect(receipts('denied')).toHaveLength(1);
    expect(receipts('allowed')).toHaveLength(0);
  });

  it('guard mode: refused without a window, allowed with one', async () => {
    setMode('guard');
    expect((await call({ prompt: 'x' })).result.isError).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
    grant('app_write', 30);
    expect((await call({ prompt: 'x' })).result.isError).not.toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('a bad argument is answered before the gate is asked: no receipt is written', async () => {
    const r = await call({ prompt: 'x', references: 'Sam' });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/references must be/);
    expect(receipts('allowed')).toHaveLength(0);
  });
});
