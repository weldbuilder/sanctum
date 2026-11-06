// The companion is only offered image generation when the backend can deliver it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ provider: 'none', appWrite: true }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const cfg = {
    agent: { get app_write() { return h.appWrite; }, cwd: '/nonexistent-agent-cwd' },
    get imagegen() { return { provider: h.provider, model: '', size: '1024x1024', safety_checker: false, timeout_ms: 1000 }; },
  };
  return { ...actual, getSanctumConfig: () => cfg };
});
vi.mock('../services/google-auth.js', () => ({ accountForApp: () => null, isScopeGranted: () => false, getClientForApp: () => null, GoogleAppNotBoundError: class extends Error {} }));
vi.mock('../services/db.js', () => ({ getThread: () => null, ensureDailyThread: () => ({ thread: { id: 'd' }, justCreated: false }), createMessage: vi.fn(), updateThreadActivity: vi.fn() }));
vi.mock('../services/ws.js', () => ({ registry: { broadcast: vi.fn() } }));
vi.mock('../services/files.js', () => ({ saveFile: vi.fn() }));
vi.mock('../routes/cc-mcp.js', () => ({ CC_TOOL_NAMES: ['cc_status'] }));

import workspace from './workspace-mcp.js';
import { shortToolList, fullToolHelp, topicHelp } from '../services/tool-help.js';
import { imagegenOffered } from '../services/imagegen/index.js';

let server: Server; let base = '';
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/mcp/workspace', workspace);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/workspace`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { h.provider = 'none'; h.appWrite = true; vi.stubEnv('RUNWARE_API_KEY', ''); vi.stubEnv('REPLICATE_API_TOKEN', ''); });
afterEach(() => vi.unstubAllEnvs());

const rpc = async (method: string, params?: unknown) =>
  (await (await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any;
const toolNames = async () => (await rpc('tools/list')).result.tools.map((t: any) => t.name);

describe('generate_image on the workspace MCP server', () => {
  it('absent when provider is none, even with keys set', async () => {
    vi.stubEnv('RUNWARE_API_KEY', 'k');
    expect(await toolNames()).not.toContain('generate_image');
    const call = await rpc('tools/call', { name: 'generate_image', arguments: { prompt: 'x' } });
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/Unknown tool/);
  });
  it('absent when the provider is set but its key is missing, or the other provider\'s key is the one present', async () => {
    h.provider = 'runware';
    expect(await toolNames()).not.toContain('generate_image');
    vi.stubEnv('REPLICATE_API_TOKEN', 't');
    expect(await toolNames()).not.toContain('generate_image');
  });
  it('absent when app writes are off', async () => {
    h.provider = 'runware'; vi.stubEnv('RUNWARE_API_KEY', 'k'); h.appWrite = false;
    expect(await toolNames()).not.toContain('generate_image');
  });
  it('present when provider and key are both there', async () => {
    h.provider = 'replicate'; vi.stubEnv('REPLICATE_API_TOKEN', 't');
    const tools = (await rpc('tools/list')).result.tools;
    const t = tools.find((x: any) => x.name === 'generate_image');
    expect(t.inputSchema.required).toEqual(['prompt']);
  });
});

describe('orientation / tool help line', () => {
  const o = { SC: 'res', userName: 'Sam', ccEnabled: false };
  it('is absent unless asked for, and present with image: true', () => {
    expect(shortToolList(o)).not.toContain('image');
    expect(fullToolHelp(o)).not.toContain('IMAGE GENERATION');
    expect(topicHelp(o, 'image')).toMatch(/^Topics: /);
    expect(shortToolList({ ...o, image: true })).toContain('res image "prompt"');
    expect(fullToolHelp({ ...o, image: true })).toContain('IMAGE GENERATION');
    expect(topicHelp({ ...o, image: true }, 'image')).toContain('res image');
  });
  it('the gate the callers use follows config: none -> false, provider+key -> true, app_write off -> false', () => {
    expect(imagegenOffered()).toBe(false);
    h.provider = 'runware';
    expect(imagegenOffered()).toBe(false);
    vi.stubEnv('RUNWARE_API_KEY', 'k');
    expect(imagegenOffered()).toBe(true);
    h.appWrite = false;
    expect(imagegenOffered()).toBe(false);
  });
});
