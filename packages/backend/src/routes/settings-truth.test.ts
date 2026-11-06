// The GETs tell the truth: GET /api/preferences and GET /api/settings answer with the effective value of each registry key (default < sanctum.yaml
// < .env < SQLite) and a `sources` map, and the status routes report the same switch the boot used.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ kv: new Map<string, string>(), root: '' }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  h.root = mkdtempSync(join(tmpdir(), 'truth-'));
  writeFileSync(join(h.root, 'sanctum.yaml'), 'identity:\n  companion_name: FromFile\ndiscord:\n  enabled: true\ntelegram:\n  enabled: true\nagent:\n  model: file-model\n  model_autonomous: ""\nauth:\n  password: file-pw-secret\n');
  const cfg = {
    identity: { user_name: 'Pat' },
    integrations: { browser_url: '', mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } },
    server: { host: '127.0.0.1', port: 3099 }, auth: { password: 'file-pw-secret' }, agent: {},
    discord: actual.normalizeDiscordConfig({}, '/srv/home', { warn: () => {} }),
  };
  return { ...actual, PROJECT_ROOT: h.root, getSanctumConfig: () => cfg };
});
vi.mock('../services/db.js', async () => {
  const actual = await vi.importActual<typeof import('../services/db.js')>('../services/db.js');
  return { ...actual, getConfig: (k: string) => h.kv.get(k) ?? null, setConfig: (k: string, v: string) => { h.kv.set(k, v); }, getAllConfig: () => Object.fromEntries(h.kv), getConfigNumber: (_k: string, d: number) => d };
});
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: any, _res: any, next: () => void) => next() };
});

import router from './api.js';
import { discordRouter } from './discord.js';
import { registerProcessFile } from '../tenancy/context.js';

let server: Server;
let base = '';
const app = express();
app.use(express.json());
app.use('/api/discord', discordRouter);
app.use('/api', router);
beforeAll(async () => { vi.spyOn(console, 'log').mockImplementation(() => {});
  registerProcessFile(() => ({ discord: { enabled: true }, telegram: { enabled: true } })); // the sanctum.yaml the process was started with
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`; });
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { h.kv.clear(); });
afterEach(() => { vi.unstubAllEnvs(); });
const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`)).json();

describe('GET /api/preferences', () => {
  it('discord.enabled: KV=false, env=true, yaml=true -> false, source db (the yaml-first read used to say true)', async () => {
    vi.stubEnv('DISCORD_ENABLED', 'true');
    h.kv.set('discord.enabled', 'false');
    const body = await get('/preferences');
    expect(body.discord.enabled).toBe(false);
    expect(body.sources['discord.enabled']).toBe('db');
  });

  it('telegram and handoff follow the same rule; each source is named', async () => {
    h.kv.set('handoff.enabled', 'true');
    const body = await get('/preferences');
    expect(body.telegram.enabled).toBe(true);
    expect(body.sources['telegram.enabled']).toBe('yaml');
    expect(body.handoff.enabled).toBe(true);
    expect(body.sources['handoff.enabled']).toBe('db');
    vi.stubEnv('TELEGRAM_ENABLED', 'true');
    expect((await get('/preferences')).sources['telegram.enabled']).toBe('env');
  });

  it('carries the existing value fields unchanged in shape, plus sources for every registry key', async () => {
    const body = await get('/preferences');
    expect(body.identity).toEqual({ companion_name: 'FromFile', user_name: 'User', timezone: 'UTC' });
    // Changed on purpose: the six-tab Settings reads the memory choice and the picture fields too; every field that was here is still here.
    expect(Object.keys(body).sort()).toEqual(['agent', 'auth', 'command_center', 'discord', 'handoff', 'hooks', 'identity', 'imagegen', 'integrations', 'memory', 'memory_mixed', 'orchestrator', 'server', 'sources', 'telegram', 'voice']);
    expect(body.sources['identity.companion_name']).toBe('yaml');
    expect(body.sources['identity.user_name']).toBe('default');
    expect(body.sources['pulse.enabled']).toBe('default');
    expect(body.auth).toEqual({ has_password: true });
    expect(body.agent.model_autonomous).toBe(''); // follow-the-chat-model is shown as the file says it, so a save does not pin it
  });

  it('the chat model shown is the one the runtime uses: AGENT_MODEL beats the file; the old KV agent.model row is not a layer', async () => {
    expect(await get('/preferences').then((b) => [b.agent.model, b.sources['agent.model']])).toEqual(['file-model', 'yaml']);
    vi.stubEnv('AGENT_MODEL', 'env-model');
    expect(await get('/preferences').then((b) => [b.agent.model, b.sources['agent.model']])).toEqual(['env-model', 'env']);
    h.kv.set('agent.model', 'kv-model');
    expect(await get('/preferences').then((b) => [b.agent.model, b.sources['agent.model']])).toEqual(['env-model', 'env']);
  });

  it('the live port says when PORT is what is in force', async () => {
    vi.stubEnv('PORT', '4321');
    const body = await get('/preferences');
    expect(body.server.port).toBe(4321);
    expect(body.sources['server.port']).toBe('env');
  });
});

describe('GET /api/settings', () => {
  it('adds effective values and sources next to config; secrets are markers only', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 'tok-very-secret');
    h.kv.set('mind.api_key', 'mind-very-secret');
    h.kv.set('discord.enabled', 'false');
    const raw = await (await fetch(`${base}/settings`)).text();
    expect(raw).not.toContain('tok-very-secret');
    expect(raw).not.toContain('mind-very-secret');
    expect(raw).not.toContain('file-pw-secret');
    const body = JSON.parse(raw);
    expect(body.config['discord.enabled']).toBe('false');
    expect(body.effective['discord.enabled']).toBe(false);
    expect(body.sources['discord.enabled']).toBe('db');
    expect(body.effective['discord.bot_token']).toEqual({ set: true, source: 'env' });
    expect(body.sources['discord.bot_token']).toBe('env');
    expect(body.effective['mind.api_key']).toBeDefined();
    expect(body).toHaveProperty('mind_key_source');
  });
});

describe('the status routes report the switch boot uses', () => {
  it('GET /api/discord/status configEnabled: yaml true with no row is true; a false row wins', async () => {
    expect((await get('/discord/status')).configEnabled).toBe(true);
    h.kv.set('discord.enabled', 'false');
    expect((await get('/discord/status')).configEnabled).toBe(false);
  });

  it('GET /api/telegram/status and /api/channels, the same', async () => {
    expect((await get('/telegram/status')).configEnabled).toBe(true);
    const ch = await get('/channels');
    expect(ch.channels?.find((c: any) => c.id === 'telegram')?.configEnabled ?? ch.find?.((c: any) => c.id === 'telegram')?.configEnabled).toBe(true);
    h.kv.set('telegram.enabled', 'false');
    h.kv.set('discord.enabled', 'false');
    expect((await get('/telegram/status')).configEnabled).toBe(false);
    const ch2 = await get('/channels');
    const list = ch2.channels ?? ch2;
    expect(list.map((c: any) => c.configEnabled)).toEqual([false, false]);
  });
});
