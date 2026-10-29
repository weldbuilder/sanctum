// Telegram per tenant (stage 3c). Telegraf is a fake bot: no polling, no network. A handler fired from outside any tenant still runs as its tenant,
// GIPHY_API_KEY is the tenant's, the internal send reaches only that tenant's bot, and a bot token two tenants hold parks both.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('telegraf', async () => ({ Telegraf: (await import('./fake-clients.js')).FakeBot }));
vi.mock('../services/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => new Float32Array(384) })); // createMessage fires a background embed (a model download on a fresh runner): none here

import { fakes, startKit, type Kit } from './fake-channels.js';
import { enableTenancy, runInTenant, currentTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { stopTenantServices } from './boot.js';
import { getTelegramConfig } from '../services/telegram/config.js';
import { saveBotToken } from '../services/bot-token.js';
import type { TelegramService } from '../services/telegram/index.js';

const hostOf = (n: string) => `${n}.example.net`;
const tgYaml = (chat = '') => `telegram:\n  enabled: true\n  owner_chat_id: "${chat}"\n`;
let kit: Kit;
let ada: TenantRuntime;
let bea: TenantRuntime;
const warned: string[] = [];
const logged: string[] = [];
const fetched: string[] = [];

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  process.env.GIPHY_API_KEY = 'giphy-process';
  vi.stubGlobal('fetch', async (url: string) => { fetched.push(String(url)); return { ok: false, status: 500 }; });
  kit = await startKit({
    ada: { host: hostOf('ada'), password: 'pw-ada', env: 'TELEGRAM_BOT_TOKEN=tok-ada-secret\nGIPHY_API_KEY=giphy-ada\n', yaml: tgYaml('chat-ada') },
    bea: { host: hostOf('bea'), password: 'pw-bea', env: 'TELEGRAM_BOT_TOKEN=tok-bea-secret\n', yaml: tgYaml() },
    cal: { host: hostOf('cal'), password: 'pw-cal', env: 'TELEGRAM_BOT_TOKEN=tok-shared-secret\n', yaml: tgYaml() },
    dan: { host: hostOf('dan'), password: 'pw-dan', env: 'TELEGRAM_BOT_TOKEN=tok-shared-secret\n', yaml: tgYaml() },
    eve: { host: hostOf('eve'), password: 'pw-eve', env: 'TELEGRAM_BOT_TOKEN=tok-eve-secret\n', yaml: tgYaml() },
    fay: { host: hostOf('fay'), password: 'pw-fay', yaml: tgYaml() },
    gus: { host: hostOf('gus'), password: 'pw-gus', env: 'TELEGRAM_BOT_TOKEN=tok-gus-secret\n', yaml: tgYaml() },
    hank: { host: hostOf('hank'), password: 'pw-hank', yaml: tgYaml() },
  });
  ada = kit.runtimes.get('ada')!;
  bea = kit.runtimes.get('bea')!;
});
afterAll(async () => {
  await stopTenantServices(kit.runtimes.values());
  await kit.close();
  for (const rt of kit.runtimes.values()) rt.db.close();
  delete process.env.GIPHY_API_KEY;
  vi.unstubAllGlobals();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

const svc = (rt: TenantRuntime) => rt.services.telegramService as TelegramService | undefined;
const botOf = (token: string) => fakes.telegram.find((b) => b.token === token)!;

describe('one Telegram service per tenant', () => {
  it("each tenant with a token gets its own bot with its own token; polling started for those two only", () => {
    expect(svc(ada)).toBeDefined();
    expect(svc(bea)).toBeDefined();
    expect(fakes.telegram.map((b) => b.token)).toEqual(expect.arrayContaining(['tok-ada-secret', 'tok-bea-secret']));
    expect(fakes.telegram.map((b) => b.token)).not.toContain('tok-shared-secret');
    expect(botOf('tok-ada-secret').launched).toBe(true);
  });

  it("the /start handler fired from outside any tenant stores the owner chat in that tenant's database only", async () => {
    const start = botOf('tok-bea-secret').handlers.find((h) => h.kind === 'command' && h.name === 'start')!;
    const replies: string[] = [];
    expect(currentTenant()).toBeUndefined();
    await start.fn({ chat: { id: 4242 }, reply: async (t: string) => { replies.push(t); } });
    expect(replies[0]).toMatch(/Connected/);
    expect(runInTenant(bea, () => getTelegramConfig().ownerChatId)).toBe('4242');
    expect(runInTenant(ada, () => getTelegramConfig().ownerChatId)).toBe('chat-ada');
  });

  it("GIPHY_API_KEY is the tenant's: A's key is used for A, the process's never, and a tenant without one makes no request", async () => {
    await runInTenant(ada, () => svc(ada)!.sendGifToOwner('cats'));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('api_key=giphy-ada');
    expect(fetched[0]).not.toContain('giphy-process');
    await runInTenant(bea, () => svc(bea)!.sendGifToOwner('cats'));
    expect(fetched).toHaveLength(1);
  });

  it("/api/telegram/status and the internal send answer for the tenant's own service; the other tenant's bot sends nothing", async () => {
    const ca = await kit.login('ada');
    const status = await kit.call('GET', '/api/telegram/status', hostOf('ada'), { cookie: ca });
    expect(status.json).toMatchObject({ enabled: true, connected: true, chatId: 'chat-ada' });
    const token = ada.token;
    const sent = await kit.call('POST', '/api/internal/telegram-send', hostOf('ada'), { json: { type: 'text', text: 'hello from ada' }, headers: { 'x-internal-token': token } });
    expect(sent.status).toBe(200);
    expect(botOf('tok-ada-secret').sent).toEqual([{ chat: 'chat-ada', text: 'hello from ada' }]);
    expect(botOf('tok-bea-secret').sent).toEqual([]);
    // A's token with B's host is refused (D1), and no bot sends.
    const cross = await kit.call('POST', '/api/internal/telegram-send', hostOf('bea'), { json: { type: 'text', text: 'x' }, headers: { 'x-internal-token': token } });
    expect(cross.status).toBe(404);
    expect(botOf('tok-bea-secret').sent).toEqual([]);
  });
});

describe('a Telegram bot token two tenants hold parks both (D9)', () => {
  it('cal and dan boot without a bot; each says so in one line naming the other; no line holds the token', () => {
    expect(kit.runtimes.has('cal') && kit.runtimes.has('dan')).toBe(true);
    for (const id of ['cal', 'dan']) expect(svc(kit.runtimes.get(id)!)).toBeUndefined();
    expect(fakes.telegram.some((b) => b.token === 'tok-shared-secret')).toBe(false);
    for (const id of ['cal', 'dan']) {
      const lines = warned.filter((l) => l.includes(`tenant ${id}: Telegram parked`));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`tenant ${id === 'cal' ? 'dan' : 'cal'}`);
    }
    for (const l of [...warned, ...logged]) expect(l).not.toContain('secret');
  });

  it('a toggle on a parked tenant is refused (409) and starts no bot', async () => {
    const cc = await kit.login('cal');
    const r = await kit.call('POST', '/api/telegram/toggle', hostOf('cal'), { cookie: cc, json: { enabled: true } });
    expect(r.status).toBe(409);
    expect(fakes.telegram.some((b) => b.token === 'tok-shared-secret')).toBe(false);
  });

  it("a tenant's stop stops its own bot only", async () => {
    await stopTenantServices([ada]);
    expect(botOf('tok-ada-secret').stopped).toBe(true);
    expect(botOf('tok-bea-secret').stopped).toBe(false);
  });
});

describe('a live bot keeps its token\'s owner even after the stored token changes (D9, live registry)', () => {
  const saveToken = (id: string, token: string) => kit.login(id).then((c) => kit.call('PUT', '/api/telegram/token', hostOf(id), { cookie: c, json: { token } }));
  const toggle = (id: string) => kit.login(id).then((c) => kit.call('POST', '/api/telegram/toggle', hostOf(id), { cookie: c, json: { enabled: true } }));

  it("A polls with T; A's stored token is changed to T2 without a restart; B taking T is refused (409) while A's bot runs, and may take it once A's bot stops", async () => {
    const eve = kit.runtimes.get('eve')!;
    expect(botOf('tok-eve-secret').stopped).toBe(false);
    runInTenant(eve, () => saveBotToken('telegram', 'tok-eve2-secret'));
    expect((await saveToken('fay', 'tok-eve-secret')).status).toBe(200);
    const refused = await toggle('fay');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.json)).not.toContain('secret');
    expect(fakes.telegram.filter((b) => b.token === 'tok-eve-secret')).toHaveLength(1); // only A's bot ever polled with it
    await stopTenantServices([eve]);
    expect((await toggle('fay')).status).toBe(200);
    expect(fakes.telegram.filter((b) => b.token === 'tok-eve-secret')).toHaveLength(2);
  });

  it("a tenant's own token change through the route stops its bot and restarts it with the new token; the old fingerprint is gone", async () => {
    const old = botOf('tok-gus-secret');
    expect((await saveToken('gus', 'tok-gus2-secret')).status).toBe(200);
    expect(old.stopped).toBe(true);
    expect(botOf('tok-gus2-secret').launched).toBe(true);
    expect((await saveToken('hank', 'tok-gus-secret')).status).toBe(200);
    expect((await toggle('hank')).status).toBe(200);
    expect((await saveToken('hank', 'tok-gus2-secret')).status).toBe(200);
    expect(warned.some((l) => l.includes('tenant hank: Telegram parked') && l.includes('tenant gus'))).toBe(true);
  });
});
