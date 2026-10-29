// The Discord admin routes (routes/discord.ts), over a real express app on a real port. Everything the routes
// reach (the gateway service, the DB, the lane config, the gate) is a stub; the router and its wiring are real.
import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ kv: new Map<string, string>(), service: null as any }));

vi.mock('../services/discord/index.js', () => ({ DiscordService: class { async start() {} async stop() {} getStats() { return { messagesReceived: 0, messagesProcessed: 0, deferred: 0, errors: 0, deferredPending: 0, connected: true, username: 'her', guilds: 1 }; } isConnected() { return true; } } }));
vi.mock('../services/ws.js', () => ({ registry: {} }));
vi.mock('../services/agent.js', () => ({ getActiveMessageId: () => null }));
vi.mock('../services/telegram/config.js', () => ({ getTelegramConfig: () => ({ ownerChatId: '' }) }));
vi.mock('../services/bot-token.js', () => ({ hasBotToken: () => true, getBotToken: () => 'token' }));
vi.mock('../services/db.js', () => ({
  getConfig: (k: string) => h.kv.get(k) ?? null,
  getConfigBool: (_k: string, d: boolean) => d,
  getConfigNumber: (_k: string, d: number) => d,
  setConfig: (k: string, v: string) => { h.kv.set(k, v); },
}));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const discord = actual.normalizeDiscordConfig({}, '/srv/home', { warn: () => {} });
  return { ...actual, getSanctumConfig: () => ({ identity: { user_name: 'Pat' }, discord }) };
});
vi.mock('../services/discord/paths.js', () => ({ getDiscordPaths: () => ({ privateDir: '/srv/sanctum-private', wordsFile: '', namesFile: '', exclusionsFile: '', refused: [] }) }));
vi.mock('../services/discord/intake.js', () => ({ exclusionsStatus: () => ({ state: 'loaded' }) }));
vi.mock('../services/discord/harness.js', () => ({ publicHarnessSupported: () => true }));
vi.mock('../services/discord/send.js', () => ({ wordGateStatus: () => ({ state: 'loaded', entries: 3 }), nameGuardStatus: () => ({ state: 'off' }) }));

import { discordRouter } from './discord.js';
import { logEvent, resetEvents } from '../services/logs.js';

let server: Server;
let base = '';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.app.locals.discordService = h.service; next(); });
app.use('/api/discord', discordRouter);

beforeAll(async () => { await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/discord`; });
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { h.kv.clear(); h.service = null; resetEvents(); });

describe('GET /api/discord/status: recentFailures (D11)', () => {
  it('is there on a fresh install, empty', async () => {
    const body: any = await (await fetch(`${base}/status`)).json();
    expect(body.recentFailures).toEqual({ count24h: 0, lastKind: null, lastAt: null });
  });

  it('counts the last 24 hours and names the last kind; kinds only, running or not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    logEvent('discord', 'gate_error');
    logEvent('discord', 'reply_failed', { class: 'provider_error' });
    const stopped: any = await (await fetch(`${base}/status`)).json();
    expect(stopped.recentFailures).toMatchObject({ count24h: 2, lastKind: 'reply_failed' });
    expect(typeof stopped.recentFailures.lastAt).toBe('string');
    expect(Object.keys(stopped.recentFailures).sort()).toEqual(['count24h', 'lastAt', 'lastKind']);
    h.service = new (await import('../services/discord/index.js')).DiscordService({} as any, {} as any);
    const running: any = await (await fetch(`${base}/status`)).json();
    expect(running.enabled).toBe(true);
    expect(running.recentFailures.count24h).toBe(2);
    vi.restoreAllMocks();
  });
});

describe('the pairing and rules routes are gone', () => {
  const gone: Array<[string, string]> = [
    ['GET', '/pairings'], ['POST', '/pairings/ABC123/approve'], ['POST', '/pairings/ABC123/deny'], ['DELETE', '/pairings/111'],
    ['GET', '/rules'], ['PUT', '/rules'],
    ['POST', '/rules/server'], ['DELETE', '/rules/server/1'], ['POST', '/rules/channel'], ['DELETE', '/rules/channel/1'], ['POST', '/rules/user'], ['DELETE', '/rules/user/1'],
  ];
  for (const [method, path] of gone) {
    it(`${method} /api/discord${path} is 404`, async () => {
      const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) });
      expect(res.status).toBe(404);
    });
  }

  it('status, toggle and settings are still served', async () => {
    expect((await fetch(`${base}/status`)).status).toBe(200);
    expect((await fetch(`${base}/settings`)).status).toBe(200);
    expect((await fetch(`${base}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
  });

  it('settings: the owner id is read and written, and the old admission keys are neither returned nor stored', async () => {
    const put: any = await (await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerUserId: '4242', allowedUsers: ['1'], allowedGuilds: ['2'], activeChannels: ['3'], requireMentionInGuilds: false, pairingExpiryMs: 5 }) })).json();
    expect(put.updated).toBe(1);
    expect(h.kv.get('discord.ownerUserId')).toBe('4242');
    for (const k of ['discord.allowedUsers', 'discord.allowedGuilds', 'discord.activeChannels', 'discord.requireMentionInGuilds', 'discord.pairingExpiryMs']) expect(h.kv.has(k)).toBe(false);
    const got: any = await (await fetch(`${base}/settings`)).json();
    expect(got.ownerUserId).toBe('4242');
    for (const k of ['allowedUsers', 'allowedGuilds', 'activeChannels', 'requireMentionInGuilds', 'pairingExpiryMs']) expect(k in got).toBe(false);
  });
});

describe('discord.deferMaxAgeMs is no longer a Settings value', () => {
  it('PUT does not write it and GET does not return it', async () => {
    h.kv.set('discord.deferMaxAgeMs', '900000');
    const put: any = await (await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deferMaxAgeMs: 5000 }) })).json();
    expect(put.updated).toBe(0);
    expect(h.kv.get('discord.deferMaxAgeMs')).toBe('900000'); // untouched
    expect('deferMaxAgeMs' in put).toBe(false);
    const got: any = await (await fetch(`${base}/settings`)).json();
    expect('deferMaxAgeMs' in got).toBe(false);
  });
});
