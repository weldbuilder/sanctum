// /api/channels per tenant (stage 3c): the list is the asking tenant's own, and a test goes through that tenant's own client only. Both clients are fakes.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('discord.js', async (orig) => ({ ...(await orig<object>()), Client: (await import('./fake-clients.js')).FakeClient }));
vi.mock('telegraf', async () => ({ Telegraf: (await import('./fake-clients.js')).FakeBot }));
vi.mock('../services/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => new Float32Array(384) })); // createMessage fires a background embed (a model download on a fresh runner): none here

import { fakes, startKit, type Kit } from './fake-channels.js';
import { enableTenancy } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { stopTenantServices } from './boot.js';

const hostOf = (n: string) => `${n}.example.net`;
const channelsYaml = (chat = '') => `discord:\n  enabled: true\ntelegram:\n  enabled: true\n  owner_chat_id: "${chat}"\n`;
let kit: Kit;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  kit = await startKit({
    ada: { host: hostOf('ada'), password: 'pw-ada', env: 'DISCORD_BOT_TOKEN=tok-da-secret\nTELEGRAM_BOT_TOKEN=tok-ada-secret\n', yaml: channelsYaml('chat-ada') },
    bea: { host: hostOf('bea'), password: 'pw-bea', env: 'DISCORD_BOT_TOKEN=tok-db-secret\nTELEGRAM_BOT_TOKEN=tok-bea-secret\n', yaml: channelsYaml() },
    cal: { host: hostOf('cal'), password: 'pw-cal', yaml: channelsYaml() },
  });
});
afterAll(async () => {
  await stopTenantServices(kit.runtimes.values());
  await kit.close();
  for (const rt of kit.runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

const byId = (json: any, id: string) => json.channels.find((c: { id: string }) => c.id === id);

describe('/api/channels per tenant', () => {
  it("lists the asking tenant's own channels: A's owner and state, B's own, and a tenant with no tokens shows both off", async () => {
    const [ca, cb, cc] = await Promise.all([kit.login('ada'), kit.login('bea'), kit.login('cal')]);
    const a = (await kit.call('GET', '/api/channels', hostOf('ada'), { cookie: ca })).json;
    const b = (await kit.call('GET', '/api/channels', hostOf('bea'), { cookie: cb })).json;
    const c = (await kit.call('GET', '/api/channels', hostOf('cal'), { cookie: cc })).json;
    expect(byId(a, 'telegram')).toMatchObject({ hasToken: true, enabled: true, connected: true, ownerId: 'chat-ada' });
    expect(byId(a, 'discord')).toMatchObject({ hasToken: true, enabled: true, connected: true });
    expect(byId(b, 'telegram')).toMatchObject({ hasToken: true, enabled: true, ownerId: null });
    expect(byId(c, 'telegram')).toMatchObject({ hasToken: false, enabled: false, connected: false });
    expect(byId(c, 'discord')).toMatchObject({ hasToken: false, enabled: false, connected: false });
  });

  it("test-send goes through the asking tenant's own client only", async () => {
    const [ca, cc] = await Promise.all([kit.login('ada'), kit.login('cal')]);
    const bot = (t: string) => fakes.telegram.find((x) => x.token === t)!;
    const before = { ada: bot('tok-ada-secret').getMe, bea: bot('tok-bea-secret').getMe };
    const t = (await kit.call('POST', '/api/channels/telegram/test', hostOf('ada'), { cookie: ca, json: {} })).json;
    expect(t).toEqual({ ok: true, message: 'bot @bot-ada' });
    expect(bot('tok-ada-secret').getMe).toBe(before.ada + 1);
    expect(bot('tok-bea-secret').getMe).toBe(before.bea);
    expect((await kit.call('POST', '/api/channels/discord/test', hostOf('ada'), { cookie: ca, json: {} })).json).toEqual({ ok: true, message: 'connected as discord-bot' });
    // A tenant with no client is told so, and no one else's client is used for it.
    expect((await kit.call('POST', '/api/channels/telegram/test', hostOf('cal'), { cookie: cc, json: {} })).json).toEqual({ ok: false, message: 'gateway not running' });
    expect(bot('tok-bea-secret').getMe).toBe(before.bea);
    expect((await kit.call('POST', '/api/channels/nope/test', hostOf('ada'), { cookie: ca, json: {} })).status).toBe(400);
  });

  it('without a login the channel routes stay behind the auth gate', async () => {
    for (const [m, p] of [['GET', '/api/channels'], ['POST', '/api/channels/telegram/test'], ['GET', '/api/discord/status'], ['GET', '/api/telegram/status']]) {
      expect((await kit.call(m, p, hostOf('ada'), m === 'POST' ? { json: {} } : {})).status, `${m} ${p}`).toBe(401);
    }
  });
});
