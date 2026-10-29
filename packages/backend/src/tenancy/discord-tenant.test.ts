// Discord per tenant (stage 3c). discord.js is a fake client: no gateway, login() only records the token. A message handler fired from outside any
// tenant (as discord.js does from a socket or a reconnect) still runs as its tenant; a bot token two tenants hold parks both.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

vi.mock('discord.js', async (orig) => ({ ...(await orig<object>()), Client: (await import('./fake-clients.js')).FakeClient }));
vi.mock('../services/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => new Float32Array(384) })); // createMessage fires a background embed (a model download on a fresh runner): none here

import { fakes, startKit, type Kit } from './fake-channels.js';
import { enableTenancy, runInTenant, currentTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { stopTenantServices } from './boot.js';
import { registry } from '../services/ws.js';
import { getServerRule } from '../services/discord/rules.js';
import { getDiscordActivity } from '../services/discord/index.js';
import { getDiscordPaths } from '../services/discord/paths.js';
import { wordGateStatus } from '../services/discord/send.js';
import { getDb } from '../services/db.js';
import { saveBotToken } from '../services/bot-token.js';
import type { DiscordService } from '../services/discord/index.js';

const hostOf = (n: string) => `${n}.example.net`;
const discordYaml = (extra = '') => `discord:\n  enabled: true\n  owner:\n    channel_id: oc\n    user_id: owner-1\n  public:\n    enabled: true\n    guild_ids: [g1]\n    exclusions_file: private/exclusions.txt\n${extra}`;
let kit: Kit;
let ada: TenantRuntime;
let bea: TenantRuntime;
let cal: TenantRuntime | undefined;
const warned: string[] = [];
const logged: string[] = [];

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
  kit = await startKit({
    ada: { host: hostOf('ada'), password: 'pw-ada', env: 'DISCORD_BOT_TOKEN=tok-ada-secret\n', yaml: discordYaml() },
    bea: { host: hostOf('bea'), password: 'pw-bea', env: 'DISCORD_BOT_TOKEN=tok-bea-secret\n', yaml: discordYaml() },
    cal: { host: hostOf('cal'), password: 'pw-cal', env: 'DISCORD_BOT_TOKEN=tok-shared-secret\n', yaml: discordYaml() },
    dan: { host: hostOf('dan'), password: 'pw-dan', env: 'DISCORD_BOT_TOKEN=tok-shared-secret\n', yaml: discordYaml() },
    eve: { host: hostOf('eve'), password: 'pw-eve', env: 'DISCORD_BOT_TOKEN=tok-eve-secret\n', yaml: discordYaml() },
    fay: { host: hostOf('fay'), password: 'pw-fay', yaml: discordYaml() },
    gus: { host: hostOf('gus'), password: 'pw-gus', env: 'DISCORD_BOT_TOKEN=tok-gus-secret\n', yaml: discordYaml() },
    hank: { host: hostOf('hank'), password: 'pw-hank', yaml: discordYaml() },
  });
  ada = kit.runtimes.get('ada')!;
  bea = kit.runtimes.get('bea')!;
  cal = kit.runtimes.get('cal');
  // The exclusions file the public lane needs (empty list), in each tenant's own private folder.
  for (const rt of kit.runtimes.values()) {
    const f = runInTenant(rt, () => getDiscordPaths().exclusionsFile);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '');
  }
});
afterAll(async () => {
  await stopTenantServices(kit.runtimes.values());
  await kit.close();
  for (const rt of kit.runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

const svc = (rt: TenantRuntime) => rt.services.discordService as DiscordService | undefined;
const clientOf = (rt: TenantRuntime) => fakes.discord.find((c) => c.token === runInTenant(rt, () => process.env.NEVER ?? rt.env.DISCORD_BOT_TOKEN))!;
const publicMessage = (id: string) => ({
  id, channelId: 'c9', guildId: 'g1', content: `hello ${id}`, webhookId: null, attachments: new Map(),
  author: { id: 'u-public', bot: false, username: 'pat' },
  channel: { isThread: () => false, parentId: null },
  mentions: { users: { has: (x: string) => x === 'bot-id' }, roles: new Map(), repliedUser: null },
  react: async () => {},
});
const deferrals = (rt: TenantRuntime) => (runInTenant(rt, () => getDb().prepare('SELECT count(*) AS n FROM discord_deferrals').get()) as { n: number }).n;

describe('one Discord service per tenant', () => {
  it('a tenant with a token gets its own client, logged in with its own token; the others\' tokens are not used for it', () => {
    expect(svc(ada)).toBeDefined();
    expect(svc(bea)).toBeDefined();
    expect(svc(ada)).not.toBe(svc(bea));
    expect(fakes.discord.map((c) => c.token)).toEqual(expect.arrayContaining(['tok-ada-secret', 'tok-bea-secret']));
    expect(fakes.discord.map((c) => c.token)).not.toContain('tok-shared-secret');
  });

  it("a message event on A's client lands in A's database only, even fired from outside any tenant (a socket or reconnect)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      runInTenant(ada, () => registry.touchUserWebActivity()); // the owner is on the web UI: a public message is deferred, not run (no model call)
      const handler = clientOf(ada).handlers.get('messageCreate')!;
      expect(currentTenant()).toBeUndefined(); // nothing is entered here: this is what discord.js's own callback looks like
      handler(publicMessage('1001'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(deferrals(ada)).toBe(1);
      expect(deferrals(bea)).toBe(0);
      expect(runInTenant(bea, () => registry.minutesSinceLastUserWebActivity())).toBeGreaterThan(1000); // B's registry is its own
    } finally { vi.useRealTimers(); }
  });

  it("rules and activity are the tenant's own: A's are never visible under B", () => {
    writeFileSync(join(ada.dataDir, 'discord-rules.json'), JSON.stringify({ servers: { g1: { id: 'g1', name: 'A server', context: 'only ada' } }, channels: {}, users: {} }));
    expect(runInTenant(ada, () => getServerRule('g1')?.context)).toBe('only ada');
    expect(runInTenant(bea, () => getServerRule('g1'))).toBeUndefined();
    runInTenant(ada, () => getDiscordActivity().set('u1', { name: 'pat', lastSeen: 1, channelId: 'c1' }));
    expect(runInTenant(ada, () => getDiscordActivity().size)).toBe(1);
    expect(runInTenant(bea, () => getDiscordActivity().size)).toBe(0);
  });

  it("the private lists are the tenant's own folder (confine forces it): A's paths sit under A, B's under B", () => {
    const pa = runInTenant(ada, () => getDiscordPaths());
    const pb = runInTenant(bea, () => getDiscordPaths());
    expect(pa.privateDir).toBe(join(ada.dir, 'private'));
    expect(pb.privateDir).toBe(join(bea.dir, 'private'));
    expect(pa.exclusionsFile.startsWith(ada.dir)).toBe(true);
    expect(runInTenant(ada, () => wordGateStatus())).toBeDefined();
  });
});

describe('a bot token two tenants hold parks both (D9)', () => {
  it('neither cal nor dan has a service or a client; each says so in one line naming the other; no line holds the token', () => {
    expect(kit.runtimes.has('cal') && kit.runtimes.has('dan')).toBe(true); // they otherwise boot
    for (const id of ['cal', 'dan']) expect(svc(kit.runtimes.get(id)!)).toBeUndefined();
    expect(fakes.discord.some((c) => c.token === 'tok-shared-secret')).toBe(false);
    const other = (id: string) => (id === 'cal' ? 'dan' : 'cal');
    for (const id of ['cal', 'dan']) {
      const lines = warned.filter((l) => l.includes(`tenant ${id}: Discord parked`));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`tenant ${other(id)}`);
    }
    for (const l of [...warned, ...logged]) expect(l).not.toContain('secret');
  });

  it('the routes see the tenant\'s own service: A is enabled, a parked tenant is not, and a toggle on the parked tenant is refused (409)', async () => {
    const ca = await kit.login('ada');
    const status = await kit.call('GET', '/api/discord/status', hostOf('ada'), { cookie: ca });
    expect(status.status).toBe(200);
    expect(status.json.enabled).toBe(true);
    expect(status.json.connected).toBe(true);
    const cc = await kit.login('cal');
    const parked = await kit.call('GET', '/api/discord/status', hostOf('cal'), { cookie: cc });
    expect(parked.json.enabled).toBe(false);
    const toggle = await kit.call('POST', '/api/discord/toggle', hostOf('cal'), { cookie: cc, json: { enabled: true } });
    expect(toggle.status).toBe(409);
    expect(JSON.stringify(toggle.json)).not.toContain('secret');
    expect(fakes.discord.some((c) => c.token === 'tok-shared-secret')).toBe(false);
  });

  it('stopping every tenant stops its client', async () => {
    expect(cal).toBeDefined();
    await stopTenantServices([ada]);
    expect(clientOf(ada).destroyed).toBe(true);
    expect(clientOf(bea).destroyed).toBe(false);
  });
});

describe('a live client keeps its token\'s owner even after the stored token changes (D9, live registry)', () => {
  const saveToken = (id: string, who: string, token: string) => kit.login(id).then((c) => kit.call('PUT', '/api/discord/token', hostOf(who), { cookie: c, json: { token } }));
  const toggle = (id: string) => kit.login(id).then((c) => kit.call('POST', '/api/discord/toggle', hostOf(id), { cookie: c, json: { enabled: true } }));

  it("A runs with T; A's stored token is changed to T2 without a restart; B taking T is refused (409) while A's client runs, and may take it once A's client stops", async () => {
    const eve = kit.runtimes.get('eve')!;
    expect(fakes.discord.some((c) => c.token === 'tok-eve-secret' && !c.destroyed)).toBe(true);
    runInTenant(eve, () => saveBotToken('discord', 'tok-eve2-secret')); // stored beats .env: configuration now says T2, the live client still runs T
    expect((await saveToken('fay', 'fay', 'tok-eve-secret')).status).toBe(200);
    const refused = await toggle('fay');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.json)).not.toContain('secret');
    expect(fakes.discord.filter((c) => c.token === 'tok-eve-secret' && !c.destroyed)).toHaveLength(1); // only A's
    await stopTenantServices([eve]); // A's client stops: the fingerprint is gone
    expect((await toggle('fay')).status).toBe(200);
    expect(fakes.discord.some((c) => c.token === 'tok-eve-secret' && !c.destroyed && c.ready)).toBe(true);
  });

  it("a tenant's own token change through the route stops its client and restarts it with the new token; the old fingerprint is gone", async () => {
    const before = fakes.discord.filter((c) => c.token === 'tok-gus-secret');
    expect(before).toHaveLength(1);
    expect((await saveToken('gus', 'gus', 'tok-gus2-secret')).status).toBe(200);
    expect(before[0].destroyed).toBe(true);
    expect(fakes.discord.some((c) => c.token === 'tok-gus2-secret' && c.ready && !c.destroyed)).toBe(true);
    // The old token is free (nobody runs it); the new one is held live by gus.
    expect((await saveToken('hank', 'hank', 'tok-gus-secret')).status).toBe(200);
    expect((await toggle('hank')).status).toBe(200);
    expect((await saveToken('hank', 'hank', 'tok-gus2-secret')).status).toBe(200);
    expect(warned.some((l) => l.includes('tenant hank: Discord parked') && l.includes('tenant gus'))).toBe(true);
  });
});
