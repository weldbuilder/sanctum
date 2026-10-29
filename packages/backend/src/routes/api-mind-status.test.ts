// GET /api/mind/status, POST /api/mind/test, and the Mind key source on GET /api/settings.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ kv: new Map<string, string>(), auth: true }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, getSanctumConfig: () => ({ identity: { user_name: 'Pat' }, integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } }, agent: {}, server: {} }) };
});
vi.mock('../services/db.js', async () => {
  const actual = await vi.importActual<typeof import('../services/db.js')>('../services/db.js');
  return { ...actual, getConfig: (k: string) => h.kv.get(k) ?? null, setConfig: (k: string, v: string) => { h.kv.set(k, v); }, getAllConfig: () => Object.fromEntries(h.kv) };
});
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: any, res: any, next: () => void) => (h.auth ? next() : res.status(401).json({ error: 'unauthorized' })) };
});

import router from './api.js';
import { MindWatchdog, setMindWatchdog } from '../services/mind-watchdog.js';
import { describeMindSettings } from '../services/mind-client.js';
import { startFakeMind } from '../test-helpers/fake-mind.js';

const KEY = 'route-secret-key-0123456789';
let fake: Awaited<ReturnType<typeof startFakeMind>>;
let server: Server;
let base = '';
let clock = { t: 5_000_000 };
const logs: string[] = [];
const app = express();
app.use(express.json());
app.use('/api', router);

beforeAll(async () => {
  fake = await startFakeMind({ key: KEY, mindId: 'alpha' });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => { setMindWatchdog(null); await fake.close(); await new Promise((r) => server.close(r)); });
beforeEach(() => {
  h.kv.clear(); h.auth = true; fake.state.mode = 'normal'; fake.state.delayMs = 0; fake.state.reqs.length = 0; logs.length = 0;
  clock = { t: 5_000_000 };
  setMindWatchdog(new MindWatchdog({ describe: describeMindSettings, now: () => clock.t, timeoutMs: 500, log: (l) => logs.push(l) }));
});
const saved = () => { h.kv.set('mind.enabled', 'true'); h.kv.set('mind.url', fake.root); h.kv.set('mind.mind_id', 'alpha'); h.kv.set('mind.api_key', KEY); };
const post = (body?: unknown) => fetch(`${base}/mind/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('GET /api/mind/status', () => {
  it('needs a session', async () => {
    h.auth = false;
    expect((await fetch(`${base}/mind/status`)).status).toBe(401);
  });
  it('is off when the Mind is off, with no request to any Mind', async () => {
    const res = await fetch(`${base}/mind/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'off', latencyMs: null });
    expect(fake.state.reqs).toHaveLength(0);
  });
  it('is incomplete when the mind id is missing', async () => {
    saved(); h.kv.delete('mind.mind_id');
    const body = (await (await fetch(`${base}/mind/status`)).json()) as any;
    expect(body.state).toBe('incomplete');
    expect(body.error).toMatch(/mind id missing/);
    expect(fake.state.reqs).toHaveLength(0);
  });
  it('returns the record, and never the key, the URL or the mind id', async () => {
    saved();
    const text = await (await fetch(`${base}/mind/status`)).text();
    expect(JSON.parse(text)).toMatchObject({ state: 'ok', version: '2.0.0-test' });
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['checkedAt', 'latencyMs', 'state', 'version']);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('127.0.0.1');
  });
  it('serves the last probe without probing on every visit', async () => {
    saved();
    await fetch(`${base}/mind/status`); await fetch(`${base}/mind/status`); await fetch(`${base}/mind/status`);
    expect(fake.state.reqs.filter((r) => r.path === '/health')).toHaveLength(1);
  });
});

describe('POST /api/mind/test', () => {
  it('needs a session', async () => {
    h.auth = false;
    expect((await post({})).status).toBe(401);
  });
  it('with no body tests the saved settings and records the result', async () => {
    saved();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'ok', version: '2.0.0-test' });
    expect((await (await fetch(`${base}/mind/status`)).json() as any).state).toBe('ok');
  });
  it('tests a draft without saving, recording or logging it', async () => {
    const res = await post({ url: fake.root, mind_id: 'alpha', api_key: KEY });
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ state: 'ok', version: '2.0.0-test' });
    expect(text).not.toContain(KEY);
    expect([...h.kv.keys()]).toEqual([]);
    expect(logs).toEqual([]);
    expect(((await (await fetch(`${base}/mind/status`)).json()) as any).state).toBe('off');
  });
  it('answers a refused draft key, an offline draft address and a missing mind id', async () => {
    expect(await (await post({ url: fake.root, mind_id: 'alpha', api_key: 'wrong' })).json()).toMatchObject({ state: 'unauthorized' });
    clock.t += 3000;
    expect(await (await post({ url: 'http://127.0.0.1:1', mind_id: 'alpha', api_key: KEY })).json()).toMatchObject({ state: 'offline' });
    clock.t += 3000;
    expect(await (await post({ url: fake.root, mind_id: '', api_key: KEY })).json()).toMatchObject({ state: 'incomplete', error: expect.stringMatching(/mind id missing/) });
  });
  it('lets a draft leave the key blank to use the saved one for the same URL', async () => {
    saved();
    expect(await (await post({ url: fake.root, mind_id: 'alpha', api_key: '' })).json()).toMatchObject({ state: 'ok' });
  });
  it('refuses a body that is not text fields', async () => {
    expect((await post({ url: 5 })).status).toBe(400);
    clock.t += 3000;
    expect((await post({ api_key: { a: 1 } })).status).toBe(400);
    clock.t += 3000;
    expect((await post({ url: 'x'.repeat(5000) })).status).toBe(400);
    expect(fake.state.reqs).toHaveLength(0);
  });
  it('answers 429 with Retry-After for a second test within two seconds, and for one in flight', async () => {
    expect((await post({ url: fake.root, mind_id: 'alpha', api_key: KEY })).status).toBe(200);
    clock.t += 500;
    const soon = await post({ url: fake.root, mind_id: 'alpha', api_key: KEY });
    expect(soon.status).toBe(429);
    expect(Number(soon.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await soon.json()) as any).error).toMatch(/wait|moment|second/i);
    clock.t += 5000;
    fake.state.delayMs = 200;
    const slow = post({ url: fake.root, mind_id: 'alpha', api_key: KEY });
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post({ url: fake.root, mind_id: 'alpha', api_key: KEY });
    expect(busy.status).toBe(429);
    expect(((await busy.json()) as any).error).toMatch(/already running/i);
    expect((await slow).status).toBe(200);
  });
});

describe('what the Settings routes say about the Mind key', () => {
  it('GET /settings names the environment as the key source, and still never shows the key', async () => {
    saved(); h.kv.delete('mind.api_key');
    vi.stubEnv('MIND_API_KEY', 'env-only-key-ABCD');
    try {
      const text = await (await fetch(`${base}/settings`)).text();
      const body = JSON.parse(text);
      expect(body.mind_key_source).toBe('environment');
      expect(body.mind_key_fingerprint).toBe('••••ABCD');
      expect(text).not.toContain('env-only-key-ABCD');
    } finally { vi.unstubAllEnvs(); }
  });
  it('GET /settings masks a short key to dots only, in the stored value and in the key info alike', async () => {
    saved(); h.kv.set('mind.api_key', 'tiny-key');
    const body = (await (await fetch(`${base}/settings`)).json()) as any;
    expect(body.config['mind.api_key']).toBe('••••');
    expect(body.mind_key_fingerprint).toBe('••••');
    h.kv.set('mind.api_key', 'a-long-enough-key-9876');
    const longer = (await (await fetch(`${base}/settings`)).json()) as any;
    expect(longer.config['mind.api_key']).toBe('••••9876');
    expect(longer.mind_key_fingerprint).toBe('••••9876');
  });
  it('GET /settings names where the URL comes from, and gives the effective URL when the card has none', async () => {
    saved();
    let body = (await (await fetch(`${base}/settings`)).json()) as any;
    expect(body.mind_url_source).toBe('settings');
    expect(body.mind_url_effective).toBeUndefined();
    h.kv.delete('mind.url');
    body = (await (await fetch(`${base}/settings`)).json()) as any;
    expect(body.mind_url_source).toBeNull();
  });
  it('GET /settings says "settings" when the card holds the key, and null when there is none', async () => {
    saved();
    expect(((await (await fetch(`${base}/settings`)).json()) as any).mind_key_source).toBe('settings');
    h.kv.clear();
    expect(((await (await fetch(`${base}/settings`)).json()) as any).mind_key_source).toBeNull();
  });
  it('saving a mind.* setting re-checks the watchdog; other keys do not', async () => {
    saved();
    await fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'mind.mind_id', value: 'alpha' }) });
    await vi.waitFor(() => expect(fake.state.reqs).toHaveLength(2)); // /health, then the read verb
    fake.state.reqs.length = 0;
    await fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'theme.x', value: 'y' }) });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.state.reqs).toHaveLength(0);
  });
});
