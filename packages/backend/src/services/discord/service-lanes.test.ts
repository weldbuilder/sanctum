// DiscordService end to end at the seam discord.js gives it: a message arrives, the lane is decided
// by channel, and the turn runs (or does not) on the right thread. discord.js, the DB, the config and
// the turn runner are stubs; the lane code, the debouncer and the thread resolver are the real ones.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-svc-lanes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const exclusionsFile = join(tmp, 'exclusions.txt');

const h = vi.hoisted(() => ({
  cfg: {} as any,
  threads: new Map<string, any>(),
  created: [] as any[],
  messages: [] as any[],
  kv: new Map<string, string>(),
  turns: [] as any[],
  publicRuns: [] as any[],
  publicImpl: null as null | ((a: any) => Promise<any>),
  sends: [] as any[],
  sendImpl: null as null | ((target: any, text: any, lane: string) => any),
  transcript: [] as any[],
  webMinutes: 999,
  legacyThreads: 0,
  turnImpl: null as null | ((o: any) => Promise<any>),
  client: null as any,
  excl: '',
  wordsStatus: { status: { state: 'loaded', entries: 3 } } as any,
  dbAllowedUsers: new Set<string>(),
  dbAllowedGuilds: new Set<string>(),
  harnessOk: true,
  legacyDeferMs: null as number | null,
  unreacts: [] as any[],
  refFetches: [] as string[],
  followUpMs: 20,
  saved: [] as any[],
  fetches: [] as string[],
  db: null as any,
  newDb: null as any,
  known: new Map<string, any>(),
  reacts: [] as any[],
  channelFetches: 0,
}));

vi.mock('discord.js', async () => {
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    user = { id: '900', tag: 'her#0001', username: 'her' };
    guilds = { cache: { size: 2, get: () => undefined } };
    channels = {
      cache: { get: () => undefined },
      fetch: async (id: string) => { h.channelFetches++; return { id, isThread: () => false, parentId: null, messages: { fetch: async (mid: string) => { const m = h.known.get(mid); if (!m) throw new Error('Unknown Message'); return m; } } }; },
    };
    constructor() { super(); h.client = this; }
    async login() {}
    destroy() {}
    isReady() { return true; }
  }
  return {
    Client,
    Events: { MessageCreate: 'messageCreate', ClientReady: 'clientReady', ShardDisconnect: 'shardDisconnect', ShardReconnecting: 'shardReconnecting', ShardResume: 'shardResume' },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 },
    Partials: { Channel: 1, Message: 2 },
  };
});
vi.mock('../db.js', async () => {
  // A real in-memory SQLite with the app's migration for the queues: a restart is a new service over the same db.
  const { default: Database } = await import('better-sqlite3');
  const { readFileSync, existsSync } = await import('node:fs');
  h.newDb = () => { const d = new Database(':memory:'); const f = new URL('../../../migrations/003_discord_queues.sql', import.meta.url); if (existsSync(f)) d.exec(readFileSync(f, 'utf-8')); return d; };
  return {
  getDb: () => h.db,
  createMessage: (m: any) => { h.messages.push(m); return { ...m, thread_id: m.threadId }; },
  createThread: (t: any) => { h.created.push(t); h.threads.set(t.id, t); return t; },
  getThread: (id: string) => h.threads.get(id) ?? null,
  updateThreadActivity: () => {},
  ensureDailyThread: () => ({ thread: { id: 'daily-2026-10-19' }, justCreated: false }),
  getConfig: (k: string) => h.kv.get(k) ?? null,
  setConfig: (k: string, v: string) => { h.kv.set(k, v); },
  countThreadsWithPrefix: (p: string) => h.legacyThreads + [...h.threads.keys()].filter((k) => k.startsWith(p)).length,
  };
});
vi.mock('../files.js', () => ({
  saveFile: (buf: Buffer, name: string, mime: string) => {
    h.saved.push({ name, mime, len: buf.length });
    return { fileId: `f${h.saved.length}`, filename: name, mimeType: mime, size: buf.length, contentType: mime.startsWith('image/') ? 'image' : 'file', url: `/api/files/f${h.saved.length}` };
  },
}));
vi.mock('../bot-token.js', () => ({ getBotToken: () => 'token' }));
vi.mock('../../config.js', () => ({
  getSanctumConfig: () => ({ identity: { user_name: 'Pat' }, discord: h.cfg }),
}));
vi.mock('./config.js', () => ({
  DISCORD_CONFIG: {
    get ownerUserId() { return h.cfg.owner.user_id; },
    get allowedUsers() { return h.dbAllowedUsers; },
    get allowedGuilds() { return h.dbAllowedGuilds; },
    debounceMs: 5,
  },
  getDiscordConfig: () => ({ ownerUserId: h.cfg.owner.user_id, ownerActiveThresholdMin: 3, deferPollIntervalMs: 60000, deferMaxAgeMs: h.legacyDeferMs, followUpDebounceMs: h.followUpMs }),
}));
vi.mock('./harness.js', () => ({ publicHarnessSupported: () => h.harnessOk }));
vi.mock('./paths.js', () => ({ getDiscordPaths: () => ({ exclusionsFile, wordsFile: '', namesFile: '', privateDir: '', refused: [] }) }));
vi.mock('./rules.js', () => ({ buildRulesContext: () => '', getUserRule: () => undefined }));
vi.mock('./send.js', () => ({
  sendGated: vi.fn(async (target: any, text: any, lane: string) => { h.sends.push({ target, text, lane }); return h.sendImpl ? h.sendImpl(target, text, lane) : { sent: true }; }),
  sendTyping: async (channel: any) => { await channel.sendTyping?.(); },
  logGateAtBoot: () => {},
  wordGateInspect: () => h.wordsStatus,
}));
vi.mock('./turn.js', () => ({
  runGatedTurn: vi.fn(async (o: any) => { h.turns.push(o); return h.turnImpl ? h.turnImpl(o) : { sent: true, attempts: 1 }; }),
}));
vi.mock('./public-runtime.js', () => ({
  PublicRunError: class PublicRunError extends Error { constructor(readonly kind: string) { super(`the public run failed (${kind})`); this.name = 'PublicRunError'; } },
  runPublicTurn: vi.fn(async (a: any) => { h.publicRuns.push(a); if (h.publicImpl) return h.publicImpl(a); return { text: 'public reply' }; }),
}));
vi.mock('./public-transcript.js', () => ({ publicTranscript: { append: (e: any) => { h.transcript.push(e); }, tail: () => [] } }));

import { DiscordService } from './index.js';
import { eventSummary, resetEvents } from '../logs.js';
import { resetFailureAlert, discordAlertActive } from './failure-alert.js';

const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const OWNER = '111';
const OWNER_CH = '222';
const GUILD = '500';

const config = (over: any = {}) => ({
  enabled: true,
  owner: { user_id: OWNER, channel_id: OWNER_CH },
  public: { enabled: false, guild_ids: [GUILD], role_ids: [], bots: 'never', bot_exchange_limit: 4, bot_hourly_limit: 20 },
  paused: false,
  deferral_hours: 24,
  ...over,
});

let seq = 0;
function message(over: any = {}) {
  const channelId = over.channelId ?? '600';
  const guildId = 'guildId' in over ? over.guildId : GUILD;
  const id = `m${seq++}`;
  const msg: any = {
    id,
    channelId,
    guildId,
    content: over.content ?? 'hello',
    attachments: new Map((over.attachments ?? []).map((a: any, i: number) => [`a${i}`, a])),
    webhookId: over.webhookId ?? null,
    author: { id: over.authorId ?? '333', username: over.username ?? 'someone', bot: !!over.bot },
    channel: {
      id: channelId, isThread: () => false, parentId: null, name: 'general', sendTyping: async () => {},
      messages: { fetch: async (arg: any) => { if (typeof arg === 'string') { h.refFetches.push(arg); return over.fetchRef ? over.fetchRef(arg) : Promise.reject(new Error('Unknown Message')); } over.onHistoryFetch?.(arg); return new Map((over.history?.(msg) ?? []).map((x: any) => [x.id, x])); } },
    },
    ...(over.reference ? { reference: { messageId: over.reference, channelId: over.referenceChannel ?? channelId, guildId } } : {}),
    reactions: { resolve: (emoji: string) => ({ users: { remove: async (uid: string) => { h.unreacts.push({ message: id, emoji, uid }); } } }) },
    mentions: {
      users: { has: (id: string) => (over.mention ?? true) && id === '900', get: (id: string) => over.mUsers?.[id] },
      members: { get: (id: string) => over.mMembers?.[id] },
      roles: { keys: () => over.roles ?? [], get: (id: string) => over.mRoles?.[id] },
      channels: { get: (id: string) => over.mChannels?.[id] },
      repliedUser: over.repliedToBot ? { id: '900' } : null,
    },
    react: async (emoji: string) => { h.reacts.push({ message: id, emoji }); },
    createdAt: new Date(),
  };
  h.known.set(id, msg);
  return msg;
}

const registry: any = { broadcast: vi.fn(), minutesSinceLastUserWebActivity: () => h.webMinutes, touchUserActivity: () => {} };
const settle = () => new Promise((r) => setTimeout(r, 60));
const send = async (m: any) => { h.client.emit('messageCreate', m); await settle(); };
let svc: DiscordService;

beforeEach(() => {
  h.cfg = config();
  h.threads.clear(); h.created = []; h.messages = []; h.kv.clear(); h.turns = [];
  h.publicRuns = []; h.publicImpl = null; h.sends = []; h.sendImpl = null; h.transcript = []; h.webMinutes = 999; h.legacyThreads = 0; h.turnImpl = null;
  registry.broadcast.mockClear();
  h.excl = 'user:100000000000000001\n';
  writeFileSync(exclusionsFile, h.excl);
  h.wordsStatus = { status: { state: 'loaded', entries: 3 } };
  h.dbAllowedUsers = new Set(); h.dbAllowedGuilds = new Set();
  h.harnessOk = true;
  h.legacyDeferMs = null; h.unreacts = []; h.refFetches = []; h.followUpMs = 20; h.saved = []; h.fetches = []; resetEvents(); resetFailureAlert();
  h.db = h.newDb(); h.known.clear(); h.reacts = []; h.channelFetches = 0;
  svc =new DiscordService({} as any, registry);
});

afterEach(async () => { await svc.stop(); });

describe('the owner lane', () => {
  it('owner in the owner channel gets one stable thread, discord-owner-<hash>, created once, for every message', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, guildId: GUILD, mention: false }));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, guildId: GUILD, mention: false, content: 'again' }));
    expect(h.turns).toHaveLength(2);
    expect(h.turns.map((t) => t.lane)).toEqual(['owner', 'owner']);
    expect(h.turns.map((t) => t.threadId)).toEqual([`discord-owner-${sha12(OWNER_CH)}`, `discord-owner-${sha12(OWNER_CH)}`]);
    expect(h.created).toHaveLength(1);
  });

  it('never routes to a web thread: the stub db has no getMostRecentActiveThread to call', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER }));
    expect(h.turns[0].threadId).toMatch(/^discord-owner-/);
  });

  it('every other user in the owner channel is dropped silently, a DB-allowlisted or paired one included', async () => {
    h.dbAllowedUsers = new Set(['333']);
    h.dbAllowedGuilds = new Set([GUILD]);
    await send(message({ channelId: OWNER_CH, authorId: '333' }));
    await send(message({ channelId: OWNER_CH, authorId: '333', bot: true }));
    expect(h.turns).toEqual([]);
  });

  it('keeps using an older discord-<channelId> thread for the owner channel', async () => {
    h.threads.set(`discord-${OWNER_CH}`, { id: `discord-${OWNER_CH}` });
    await send(message({ channelId: OWNER_CH, authorId: OWNER }));
    expect(h.turns[0].threadId).toBe(`discord-${OWNER_CH}`);
    expect(h.created).toEqual([]);
  });

  it('writes no discord.threadLane.* key (it was write-only)', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER }));
    expect([...h.kv.keys()].filter((k) => k.startsWith('discord.threadLane'))).toEqual([]);
  });

  it('stores the owner message as the user, and marks the lane on it', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, content: 'hi there' }));
    expect(h.messages[0]).toMatchObject({ role: 'user', content: 'hi there', metadata: { discordLane: 'owner' } });
  });
});

describe('the owner lane: a failed turn and the system lines', () => {
  const failing = (kind: string) => { h.turnImpl = async () => { throw Object.assign(new Error(`${kind}: ENOENT /home/x/secret.txt at Object.<anonymous> (/srv/app.js:1:1)`), { name: 'AgentTurnError', kind }); }; };

  it('an agent error is never sent: the owner gets one short system line, "reply failed: <class>", no path, no stack', async () => {
    failing('provider_error');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ channelId: OWNER_CH, authorId: OWNER }));
    expect(h.sends).toEqual([]);
    const notice = h.messages.find((m) => m.role === 'system' && /reply failed/.test(m.content));
    expect(notice).toBeDefined();
    expect(notice.content).toBe('reply failed: provider_error');
    expect(notice.content).not.toMatch(/secret|ENOENT|\/srv|at /);
    expect(notice.threadId).toBe(`discord-owner-${sha12(OWNER_CH)}`);
    expect(notice.metadata).toMatchObject({ kind: 'discord_notice' });
    vi.restoreAllMocks();
  });

  it('an unclassed error is just "error"', async () => {
    h.turnImpl = async () => { throw new Error('boom /home/x/y'); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ channelId: OWNER_CH, authorId: OWNER }));
    expect(h.messages.find((m) => /reply failed/.test(m.content))?.content).toBe('reply failed: error');
    vi.restoreAllMocks();
  });

  it('a withheld-reply line is marked kind: withheld, so the rolling history can leave it out', async () => {
    h.turnImpl = async (o: any) => { await o.onBlock({ attempt: 2, willRetry: false, result: { sent: false, reason: 'word', hits: ['Janie'], entries: ['Janie'] } }); return { sent: false, attempts: 2 }; };
    await send(message({ channelId: OWNER_CH, authorId: OWNER }));
    const line = h.messages.find((m) => m.role === 'system' && /withheld/i.test(m.content));
    expect(line.metadata).toMatchObject({ kind: 'withheld' });
  });
});

describe('the public lane', () => {
  const open = (over: any = {}) => { h.cfg = config({ public: { ...config().public, enabled: true, ...over } }); };
  const ran = () => [...h.turns, ...h.publicRuns];

  it('off (the default): a listed guild, a mention, a DB allowlist and a pairing change nothing', async () => {
    h.dbAllowedUsers = new Set(['333', OWNER]);
    h.dbAllowedGuilds = new Set([GUILD]);
    await send(message());
    await send(message({ authorId: OWNER })); // the owner posting in a guild channel that is not the owner channel
    expect(ran()).toEqual([]);
  });

  it('on: a mention in a listed guild is ONE isolated public run, not a Sanctum turn', async () => {
    open();
    await send(message({ channelId: '600', content: 'hello there', username: 'moss' }));
    expect(h.turns).toEqual([]);
    expect(h.publicRuns).toHaveLength(1);
    expect(h.publicRuns[0]).toMatchObject({ guildId: GUILD, channelId: '600', text: 'hello there', speaker: { id: '333', username: 'moss', bot: false } });
  });

  it('on: her reply goes out through the gated send as lane public, and is recorded as an out line', async () => {
    open();
    await send(message({ channelId: '600' }));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({ text: 'public reply', lane: 'public' });
    expect(h.transcript.filter((e) => e.kind === 'out')).toEqual([expect.objectContaining({ kind: 'out', text: 'public reply', len: 12, where: expect.objectContaining({ guild: GUILD, channel: '600' }) })]);
  });

  it('on: nothing is saved, no thread is made, nothing is broadcast, no lane key is written', async () => {
    open();
    await send(message({ channelId: '600' }));
    await send(message({ channelId: '600', content: 'and again' }));
    expect(h.messages).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.kv.size).toBe(0);
    expect(registry.broadcast).not.toHaveBeenCalled();
  });

  it('on: the owner posting in a public guild goes through the public lane like anyone', async () => {
    open();
    await send(message({ authorId: OWNER, channelId: '600' }));
    expect(h.turns).toEqual([]);
    expect(h.publicRuns).toHaveLength(1);
  });

  it('on: not addressed, an unlisted guild, a DM, a webhook and a bot are all ignored', async () => {
    open();
    await send(message({ mention: false }));
    await send(message({ guildId: '999' }));
    await send(message({ guildId: null }));
    await send(message({ webhookId: 'w1' }));
    await send(message({ bot: true }));
    expect(ran()).toEqual([]);
  });

  it('a blocked reply: one rewrite with the note, a blocked line with reason, hits and len and NO text, then silence', async () => {
    open();
    h.sendImpl = () => ({ sent: false, reason: 'word', hits: ['Janie'], entries: ['Janie'] });
    h.publicImpl = async () => ({ text: 'a reply that says Janie' });
    await send(message({ channelId: '600' }));
    expect(h.publicRuns).toHaveLength(2);
    expect(h.publicRuns[1].note).toMatch(/Janie/);
    const blocked = h.transcript.filter((e) => e.kind === 'blocked');
    expect(blocked).toHaveLength(2);
    expect(blocked[0]).toMatchObject({ reason: 'word', hits: ['Janie'], len: 23 });
    expect(JSON.stringify(blocked)).not.toContain('a reply that says');
    expect(blocked.every((b) => !('text' in b))).toBe(true);
    expect(h.transcript.filter((e) => e.kind === 'out')).toEqual([]);
    expect(h.messages).toEqual([]);
  });

  it('a failed run posts nothing, to anyone: silence, and nothing saved', async () => {
    open();
    const { PublicRunError } = await import('./public-runtime.js');
    h.publicImpl = async () => { throw new (PublicRunError as any)('SpawnError'); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ channelId: '600' }));
    expect(h.sends).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(registry.broadcast).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('an unexpected throw is recorded by the service as an error line: reason only, no text', async () => {
    open();
    h.publicImpl = async () => { throw new Error('ENOENT /home/x/secret'); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ channelId: '600' }));
    const err = h.transcript.filter((e) => e.kind === 'error');
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({ reason: 'error', len: 0 });
    expect(JSON.stringify(err)).not.toMatch(/secret|ENOENT/);
    vi.restoreAllMocks();
  });

  it('paused closes it at intake, and the owner channel carries on', async () => {
    h.cfg = config({ paused: true, public: { ...config().public, enabled: true } });
    await send(message());
    expect(ran()).toEqual([]);
    await send(message({ channelId: OWNER_CH, authorId: OWNER }));
    expect(h.turns.map((t) => t.lane)).toEqual(['owner']);
  });

  it('pausing between intake and the turn still stops it', async () => {
    open();
    h.client.emit('messageCreate', message());
    h.cfg = config({ paused: true, public: { ...config().public, enabled: true } });
    await settle();
    expect(ran()).toEqual([]);
  });

  it('an excluded author is not answered; a missing exclusions file silences the lane and warns once', async () => {
    open();
    await send(message({ authorId: '100000000000000001' }));
    expect(ran()).toEqual([]);
    rmSync(exclusionsFile);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await send(message());
    await send(message());
    expect(ran()).toEqual([]);
    expect(warn.mock.calls.filter((c) => /exclusions/i.test(String(c[0])))).toHaveLength(1);
    warn.mockRestore();
  });

  it('the warning comes back for a second outage once the file has loaded in between', async () => {
    open();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const excl = () => warn.mock.calls.filter((c) => /exclusions/i.test(String(c[0]))).length;
    rmSync(exclusionsFile);
    await send(message());
    await send(message());
    expect(excl()).toBe(1);
    writeFileSync(exclusionsFile, 'user:100000000000000001\n'); // back, and a message loads it
    await send(message());
    expect(h.publicRuns).toHaveLength(1);
    rmSync(exclusionsFile);
    await send(message());
    await send(message());
    expect(excl()).toBe(2);
    warn.mockRestore();
  });
});

describe('deferred public batches are re-checked against the exclusions file when they drain', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };

  it('an author added to the file while the message waited is not answered', async () => {
    open();
    h.webMinutes = 0; // the owner is on the web: the batch is deferred
    await send(message({ authorId: '334' }));
    expect(h.publicRuns).toEqual([]);
    writeFileSync(exclusionsFile, 'user:334\n');
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('a channel added to the file while it waited is not answered either', async () => {
    open();
    h.webMinutes = 0;
    await send(message({ channelId: '650' }));
    writeFileSync(exclusionsFile, 'channel:650\n');
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns).toEqual([]);
  });

  it('an exclusions file that went missing while it waited drops it too (the lane fails closed)', async () => {
    open();
    h.webMinutes = 0;
    await send(message({ authorId: '334' }));
    rmSync(exclusionsFile);
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns).toEqual([]);
  });

  it('nothing changed: it is answered when the owner goes idle', async () => {
    open();
    h.webMinutes = 0;
    await send(message({ authorId: '334' }));
    expect(h.publicRuns).toEqual([]);
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns).toHaveLength(1);
  });
});

describe('bots: the caps count HER REPLIES, not the messages that reach her', () => {
  const open = (over: any = {}) => { h.cfg = config({ public: { ...config().public, enabled: true, bots: 'capped', ...over } }); };
  const bot = (id = '801', over: any = {}) => message({ bot: true, authorId: id, ...over });

  it('per (channel, bot): two replies at a cap of two, then silence; the next human message resets', async () => {
    open({ bot_exchange_limit: 2 });
    for (let i = 0; i < 4; i++) await send(bot());
    expect(h.publicRuns).toHaveLength(2);
    await send(message({ mention: false })); // a fresh human message
    await send(bot());
    expect(h.publicRuns).toHaveLength(3);
  });

  it('messages that got no reply (a failed run) do not use the cap', async () => {
    open({ bot_exchange_limit: 2 });
    const { PublicRunError } = await import('./public-runtime.js');
    h.publicImpl = async () => { throw new (PublicRunError as any)('SpawnError'); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 4; i++) await send(bot());
    expect(h.publicRuns).toHaveLength(4);
    h.publicImpl = null;
    await send(bot());
    await send(bot());
    await send(bot());
    expect(h.publicRuns).toHaveLength(6); // two replies, then the cap
    vi.restoreAllMocks();
  });

  it('a blocked reply is not a reply either', async () => {
    open({ bot_exchange_limit: 1 });
    h.sendImpl = () => ({ sent: false, reason: 'paused', hits: [], entries: [] });
    await send(bot());
    await send(bot());
    expect(h.publicRuns).toHaveLength(2);
  });

  it('the hourly total counts replies across every bot and channel', async () => {
    open({ bot_exchange_limit: 100, bot_hourly_limit: 2 });
    await send(bot('801', { channelId: '601' }));
    await send(bot('802', { channelId: '602' }));
    await send(bot('803', { channelId: '603' }));
    expect(h.publicRuns).toHaveLength(2);
  });
});

// B-1 (Codex): `codex exec` cannot run without its shell tool, so the public lane is refused on that harness.
describe('the public lane on the Codex harness', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };

  it('start() says once that public Discord needs dsh or Claude', async () => {
    open();
    h.harnessOk = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await svc.start();
    await svc.start();
    const said = warn.mock.calls.map((c) => String(c[0])).filter((l) => /dsh or Claude/.test(l));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/Codex/);
    warn.mockRestore();
  });

  it('says nothing when the public lane is off, or the harness is supported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.harnessOk = false; // public still off
    await svc.start();
    open(); h.harnessOk = true;
    const s2 = new DiscordService({} as any, registry);
    await s2.start();
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /dsh or Claude/.test(l))).toEqual([]);
    await s2.stop();
    warn.mockRestore();
  });

  it('a public message is dropped at intake: no run, no send, no transcript line', async () => {
    open();
    h.harnessOk = false;
    await svc.start();
    await send(message({ channelId: '600' }));
    expect(h.publicRuns).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(h.transcript).toEqual([]);
  });

  it('the owner lane is not touched by the harness', async () => {
    open();
    h.harnessOk = false;
    await send(message({ authorId: OWNER, channelId: OWNER_CH }));
    expect(h.turns).toHaveLength(1);
  });
});

describe('start(): the legacy upgrade', () => {
  it('a missing words list is logged loudly and ONE system line goes to the daily thread naming the fix', async () => {
    h.wordsStatus = { status: { state: 'failed', kind: 'missing' }, message: 'cannot read the word list at /x (ENOENT)' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await svc.start();
    await svc.start();
    const lines = h.messages.filter((m) => m.threadId === 'daily-2026-10-19' && m.role === 'system');
    expect(lines).toHaveLength(1);
    expect(lines[0].content).toMatch(/npm run setup/);
    expect(lines[0].metadata).toMatchObject({ kind: 'discord_notice' });
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/npm run setup/);
    warn.mockRestore();
  });

  it('discord-public-* threads from the first lanes build are left in place, no longer written, and logged once', async () => {
    h.legacyThreads = 2;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await svc.start();
    await svc.start();
    const said = [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).filter((l) => /discord-public-/.test(l));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/2/);
    expect(h.created).toEqual([]);
    expect(h.messages.filter((m) => String(m.threadId).startsWith('discord-public-'))).toEqual([]);
    log.mockRestore(); warn.mockRestore();
  });
});

// ── B3a #2: a message that arrives while her run is still going is queued, never dropped (audit hole D1) ──
describe('follow-ups during a run (the sending buffer)', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };
  const gate = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };
  const slowFirst = (g: { promise: Promise<void> }) => {
    h.publicImpl = async (a: any) => { if (a.text === 'first') await g.promise; return { text: `reply to ${a.text}` }; };
  };

  it('public: a second message that lands after the debounce, while the first run is going, is answered after the first, in order', async () => {
    open();
    const g = gate();
    slowFirst(g);
    await send(message({ content: 'first' }));
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first']);
    await send(message({ content: 'second' }));
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first']); // held, not run beside it, not dropped
    g.release();
    await settle();
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first', 'second']);
    expect(h.sends.map((x) => x.text)).toEqual(['reply to first', 'reply to second']);
  });

  it('public: a third message merges into the same follow-up batch', async () => {
    open();
    const g = gate();
    slowFirst(g);
    await send(message({ content: 'first' }));
    await send(message({ content: 'two' }));
    await send(message({ content: 'three' }));
    g.release();
    await settle();
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first', 'two\nthree']);
    expect(h.sends).toHaveLength(2);
  });

  it('public: the follow-up waits the debounce after the run finishes, and a message in that window joins it', async () => {
    open();
    h.followUpMs = 150; // wide margin: Windows timers tick at ~15 ms, so a short sleep can overrun a short debounce
    const g = gate();
    slowFirst(g);
    await send(message({ content: 'first' }));
    await send(message({ content: 'two' }));
    g.release();
    await new Promise((r) => setTimeout(r, 5)); // the first run is done; the follow-up debounce (150 ms here) is still running
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first']);
    h.client.emit('messageCreate', message({ content: 'late' }));
    await new Promise((r) => setTimeout(r, 400));
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first', 'two\nlate']);
  });

  it('public: different users do not queue behind each other', async () => {
    open();
    const g = gate();
    slowFirst(g);
    await send(message({ content: 'first', authorId: '333' }));
    await send(message({ content: 'other', authorId: '444' }));
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first', 'other']);
    g.release();
    await settle();
  });

  it('public: a batch that becomes excluded while queued is dropped with a transcript blocked line (reason excluded), and no text', async () => {
    open();
    const g = gate();
    slowFirst(g);
    await send(message({ content: 'first' }));
    await send(message({ content: 'a private thing' }));
    writeFileSync(exclusionsFile, 'user:333\n');
    g.release();
    await settle();
    await settle();
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first']);
    const blocked = h.transcript.filter((e) => e.kind === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ reason: 'excluded', who: { id: '333' }, where: { guild: GUILD, channel: '600' }, len: 15 });
    expect('text' in blocked[0]).toBe(false);
    expect(JSON.stringify(blocked)).not.toContain('private thing');
  });

  it('public: paused while queued drops it too (the lane closes before each queued batch runs)', async () => {
    open();
    const g = gate();
    slowFirst(g);
    await send(message({ content: 'first' }));
    await send(message({ content: 'second' }));
    h.cfg = config({ paused: true, public: { ...config().public, enabled: true } });
    g.release();
    await settle();
    await settle();
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first']);
  });

  it('owner: a second message during a slow turn is answered after the first, in order, keyed by channel', async () => {
    const g = gate();
    h.turnImpl = async (o: any) => { if (o.content === 'first') await g.promise; return { sent: true, attempts: 1 }; };
    await send(message({ channelId: OWNER_CH, authorId: OWNER, content: 'first', mention: false }));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, content: 'second', mention: false }));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, content: 'third', mention: false }));
    expect(h.turns.map((t) => t.content)).toEqual(['first']);
    g.release();
    await settle();
    await settle();
    expect(h.turns.map((t) => t.content)).toEqual(['first', 'second\nthird']);
  });

  it('owner: the queued messages are not lost when the first turn fails', async () => {
    h.turnImpl = async (o: any) => { if (o.content === 'first') { await new Promise((r) => setTimeout(r, 80)); throw new Error('boom'); } return { sent: true, attempts: 1 }; };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ channelId: OWNER_CH, authorId: OWNER, content: 'first', mention: false }));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, content: 'second', mention: false }));
    await new Promise((r) => setTimeout(r, 150));
    expect(h.turns.map((t) => t.content)).toEqual(['first', 'second']);
    vi.restoreAllMocks();
  });
});

// ── B3a #4: the deferred queue's clock is discord.deferral_hours ──
describe('deferred batches expire by discord.deferral_hours', () => {
  const open = (over: any = {}) => { h.cfg = config({ public: { ...config().public, enabled: true }, ...over }); };
  const ownerThread = `discord-owner-${sha12(OWNER_CH)}`;
  const queue = (svc_: DiscordService) => (svc_ as any).deferredBatches as Array<{ batch: any; queuedAt: number }>;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const age = (ms: number) => { for (const e of queue(svc)) e.queuedAt -= ms; };
  const systemLines = () => h.messages.filter((m) => m.role === 'system');

  it('a batch 11 minutes old is still waiting at the default 24 hours (the legacy 10 minute clock is gone) and runs when the owner is idle', async () => {
    open();
    h.webMinutes = 0;
    await send(message({ authorId: '334' }));
    age(11 * MIN);
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns).toHaveLength(1);
    expect(systemLines()).toEqual([]);
    expect(h.unreacts.filter((u) => u.emoji === '⏳')).toHaveLength(1); // cleared when it left the queue
  });

  it('past deferral_hours it is dropped: the hourglass cleared, and ONE system line in the owner thread says how many messages from whom, never the text', async () => {
    open({ deferral_hours: 2 });
    h.webMinutes = 0;
    h.client.emit('messageCreate', message({ authorId: '334', username: 'moss', content: 'secret words one' }));
    h.client.emit('messageCreate', message({ authorId: '334', username: 'moss', content: 'secret words two' }));
    h.client.emit('messageCreate', message({ authorId: '335', username: 'fern', content: 'secret words three' }));
    await settle();
    expect(queue(svc)).toHaveLength(2); // one batch of two from moss, one from fern
    age(2 * HOUR + MIN);
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns).toEqual([]);
    expect(queue(svc)).toEqual([]);
    expect(h.unreacts.filter((u) => u.emoji === '⏳' && u.uid === '900')).toHaveLength(2);
    const lines = systemLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].threadId).toBe(ownerThread);
    expect(lines[0].content).toBe('3 Discord messages waited out the 2-hour deferral and were not answered: 2 from moss (@moss), 1 from fern (@fern).');
    expect(lines[0].content).not.toContain('secret');
    expect(lines[0].metadata).toMatchObject({ kind: 'discord_notice' });
  });

  it('expiry is announced even while the owner is still active on the web (it does not wait for idle)', async () => {
    open({ deferral_hours: 1 });
    h.webMinutes = 0;
    await send(message({ authorId: '334', username: 'moss' }));
    age(HOUR + MIN);
    await (svc as any).drainDeferredQueue(); // webMinutes is still 0
    expect(systemLines()).toHaveLength(1);
    expect(systemLines()[0].content).toBe('1 Discord message waited out the 1-hour deferral and was not answered: 1 from moss (@moss).');
    expect(queue(svc)).toEqual([]);
  });

  it('a batch dropped at the re-check (excluded, paused) also clears its hourglass', async () => {
    open();
    h.webMinutes = 0;
    await send(message({ authorId: '334' }));
    writeFileSync(exclusionsFile, 'user:334\n');
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns).toEqual([]);
    expect(h.unreacts.filter((u) => u.emoji === '⏳')).toHaveLength(1);
  });

  it('the legacy discord.deferMaxAgeMs wins only when it is set explicitly, with a one-time warning naming discord.deferral_hours', async () => {
    open();
    h.legacyDeferMs = 5 * MIN;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.webMinutes = 0;
    await send(message({ authorId: '334', username: 'moss' }));
    age(6 * MIN); // within 24 h, past the legacy 5 minutes
    await (svc as any).drainDeferredQueue();
    await send(message({ authorId: '334', username: 'moss' }));
    age(6 * MIN);
    await (svc as any).drainDeferredQueue();
    const lines = systemLines();
    expect(lines).toHaveLength(2);
    expect(lines[0].content).toMatch(/waited out the 5-minute deferral|waited out the/);
    const w = warn.mock.calls.map((c) => String(c[0])).filter((t) => /deferMaxAgeMs/.test(t));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/discord\.deferral_hours/);
    warn.mockRestore();
  });
});

// ── B3a #5: a reply's context is read (audit hole D8) ──
describe('reply context (message.reference)', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };
  const ref = (over: any = {}) => ({
    id: 'r1', content: over.content ?? 'the thing she said', author: { id: over.authorId ?? '900', username: over.username ?? 'her', bot: over.bot ?? true, globalName: over.globalName },
    member: over.displayName ? { displayName: over.displayName } : undefined,
    get attachments() { over.touched?.push('attachments'); return { size: 1 }; },
    get embeds() { over.touched?.push('embeds'); return []; },
  });

  it('public: the referenced message is fetched once and passed as replyContext {author, text, isHer}', async () => {
    open();
    await send(message({ content: 'what do you mean', reference: 'r1', fetchRef: async () => ref() }));
    expect(h.refFetches).toEqual(['r1']);
    expect(h.publicRuns[0].replyContext).toEqual({ author: 'her (@her), bot', text: 'the thing she said', isHer: true });
  });

  it('public: a reply to another person is not "her", and a display name is used when there is one', async () => {
    open();
    await send(message({ reference: 'r1', fetchRef: async () => ref({ authorId: '777', username: 'sage', bot: false, displayName: 'Sage', content: 'a question' }) }));
    expect(h.publicRuns[0].replyContext).toEqual({ author: 'Sage (@sage)', text: 'a question', isHer: false });
  });

  it('public: the text is flattened to one line and capped at 500 characters', async () => {
    open();
    const long = `line one\n\n\tline two\u0007 ${'x'.repeat(600)}`;
    await send(message({ reference: 'r1', fetchRef: async () => ref({ content: long }) }));
    const t = h.publicRuns[0].replyContext.text as string;
    expect(t).not.toMatch(/[\n\t\u0007]/);
    expect(t.startsWith('line one line two ')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(501);
  });

  it('public: a fetch that fails (deleted message) is no context, and she still answers', async () => {
    open();
    await send(message({ content: 'hello', reference: 'gone' }));
    expect(h.refFetches).toEqual(['gone']);
    expect(h.publicRuns).toHaveLength(1);
    expect(h.publicRuns[0].replyContext).toBeUndefined();
  });

  it('public: a fetch that hangs is given up on after the timeout (2 s in production), no context', async () => {
    open();
    (svc as any).replyFetchTimeoutMs = 30;
    await send(message({ content: 'hello', reference: 'slow', fetchRef: () => new Promise(() => {}) }));
    await settle();
    expect(h.publicRuns).toHaveLength(1);
    expect(h.publicRuns[0].replyContext).toBeUndefined();
  });

  it('public: attachments and embeds of the referenced message are never touched', async () => {
    open();
    const touched: string[] = [];
    await send(message({ reference: 'r1', fetchRef: async () => ref({ touched }) }));
    expect(h.publicRuns[0].replyContext).toBeDefined();
    expect(touched).toEqual([]);
  });

  it('public: no reference, no fetch; a reference into another channel is not fetched either', async () => {
    open();
    await send(message());
    await send(message({ reference: 'r9', referenceChannel: '601', fetchRef: async () => ref() }));
    expect(h.refFetches).toEqual([]);
    expect(h.publicRuns.every((r) => r.replyContext === undefined)).toBe(true);
  });

  it('owner: the frame carries the referenced message the same way', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'that one', reference: 'r1', fetchRef: async () => ref({ content: 'my earlier line' }) }));
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].platformContext).toMatch(/IN REPLY TO/);
    expect(h.turns[0].platformContext).toContain('her (@her), bot');
    expect(h.turns[0].platformContext).toContain('my earlier line');
    expect(h.turns[0].content).toBe('that one'); // the stored and remembered words are only the person's own
  });

  it('owner: a failed fetch leaves the frame without it', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, reference: 'gone' }));
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].platformContext).not.toMatch(/IN REPLY TO/);
  });
});

// ── B3a fold-in: a missing API key for the sealed run is said once per process, not per message ──
describe('api_key_missing is quiet per message', () => {
  it('three public messages with no API key: no per-message error log, no per-message warning from the service', async () => {
    h.cfg = config({ public: { ...config().public, enabled: true } });
    const { PublicRunError } = await import('./public-runtime.js');
    h.publicImpl = async () => { throw new (PublicRunError as any)('api_key_missing'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await send(message({ content: 'a' }));
    await send(message({ content: 'b' }));
    await send(message({ content: 'c' }));
    expect(h.sends).toEqual([]);
    expect(err.mock.calls.filter((c) => /Public run failed/.test(String(c[0])))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    err.mockRestore(); warn.mockRestore();
  });
});

// ── D9: mention tokens in the frame ──
describe('mentions are resolved in the frame, the record keeps the original', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };
  const people = { mUsers: { '900': { username: 'her' }, '444': { username: 'sage', globalName: 'Sage' } }, mRoles: { '700': { name: 'Gardeners' } }, mChannels: { '800': { name: 'greenhouse' } } };
  const raw = '<@900> ask <@!444> to tell <@&700> about <#800> @everyone';

  it('public: the run is handed the resolved text to frame, and the original text to record', async () => {
    open();
    await send(message({ content: raw, ...people }));
    expect(h.publicRuns).toHaveLength(1);
    expect(h.publicRuns[0].text).toBe(raw);
    expect(h.publicRuns[0].frameText).toBe('ask @Sage to tell @Gardeners about #greenhouse @everyone');
  });

  it('public: each message of a batch is resolved from its own mentions', async () => {
    open();
    const a = message({ content: '<@900> first <@444>', ...people });
    const b = message({ content: 'second <@555>', mUsers: { '555': { username: 'wren' } } });
    h.client.emit('messageCreate', a);
    h.client.emit('messageCreate', b);
    await settle();
    expect(h.publicRuns).toHaveLength(1);
    expect(h.publicRuns[0].frameText).toBe('first @Sage\nsecond @wren');
  });

  it('owner: the model gets the resolved text; the stored message and the remembered words stay as typed', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'tell <@444> and <#800>', ...people }));
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].promptContent).toBe('tell @Sage and #greenhouse');
    expect(h.turns[0].content).toBe('tell <@444> and <#800>');
    expect(h.messages[0].content).toBe('tell <@444> and <#800>');
  });

  it('@everyone and @here never address her, with or without a mention of anyone else', async () => {
    open();
    await send(message({ content: '@everyone hello', mention: false }));
    await send(message({ content: '@here hello <@444>', mention: false, ...people }));
    expect(h.publicRuns).toEqual([]);
  });
});

// ── D7: the history fetch leaves out the batch being answered ──
describe('owner history does not repeat the batch being answered (D7)', () => {
  const past = (id: string, content: string) => ({ id, content, createdAt: new Date(), author: { username: 'pat', bot: false }, attachments: { size: 0 } });

  it('the batch\'s own messages (by id) are not in the history block; the earlier ones are', async () => {
    await send(message({
      channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'the question right now',
      history: (self: any) => [past('old1', 'an earlier thing'), past('old2', 'another earlier thing'), self],
    }));
    const ctx = h.turns[0].platformContext as string;
    expect(ctx).toContain('RECENT CHANNEL HISTORY');
    expect(ctx).toContain('an earlier thing');
    expect(ctx).toContain('another earlier thing');
    expect(ctx).not.toContain('the question right now');
  });

  it('every message of a merged batch is left out, not only the last', async () => {
    const a = message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'first of two' });
    const b = message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'second of two', history: () => [past('old1', 'before both'), a, past('mid', 'someone else between')] });
    // one batch of two: the debouncer joins them (same channel and author)
    h.client.emit('messageCreate', a);
    h.client.emit('messageCreate', b);
    await settle();
    expect(h.turns).toHaveLength(1);
    const ctx = h.turns[0].platformContext as string;
    expect(ctx).toContain('before both');
    expect(ctx).toContain('someone else between');
    expect(ctx).not.toContain('first of two');
    expect(ctx).not.toContain('second of two');
  });

  it('asks for room to spare, so leaving the batch out does not shrink the history below 25', async () => {
    const asked: any[] = [];
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, onHistoryFetch: (a: any) => asked.push(a) }));
    expect(asked[0].limit).toBeGreaterThanOrEqual(26);
  });

  it('keeps the newest 25 of what is left', async () => {
    const many = Array.from({ length: 30 }, (_, i) => past(`h${i}`, `history-line-${i}`));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, history: () => many }));
    const ctx = h.turns[0].platformContext as string;
    expect((ctx.match(/history-line-/g) ?? []).length).toBe(25);
  });
});

// ── D4: attachments ──
describe('attachments (D4)', () => {
  const cdn = (name: string, over: any = {}) => ({ name, url: `https://cdn.discordapp.com/attachments/1/2/${name}?sig=x`, size: 1000, contentType: over.contentType ?? null, ...over });
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => { h.fetches.push(String(url)); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10) }; }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('owner: an image goes through the existing attachment path (saved, handed to the turn as images, stored on the message)', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'look', attachments: [cdn('pic.png', { contentType: 'image/png' })] }));
    expect(h.saved).toEqual([{ name: 'pic.png', mime: 'image/png', len: 10 }]);
    expect(h.turns[0].images).toEqual([{ fileId: 'f1', filename: 'pic.png', contentType: 'image' }]);
    expect(h.messages[0].metadata.attachments).toEqual([expect.objectContaining({ fileId: 'f1', filename: 'pic.png', contentType: 'image', url: '/api/files/f1' })]);
    expect(h.messages[0].content).toBe('look');
  });

  it('owner: other types are not fetched, are logged by name, and the companion is told they were not opened', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, attachments: [cdn('x.zip'), cdn('ok.txt', { contentType: 'text/plain' })] }));
    expect(h.fetches).toHaveLength(1);
    expect(h.turns[0].images.map((i: any) => i.filename)).toEqual(['ok.txt']);
    expect(log.mock.calls.flat().join('\n')).toContain('x.zip');
    expect(h.turns[0].platformContext).toContain('x.zip');
    log.mockRestore();
  });

  it('owner: discord.attachments.max_mb is the cap (default 8)', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, attachments: [cdn('seven.png', { size: 7 * 1024 * 1024 }), cdn('nine.png', { size: 9 * 1024 * 1024 })] }));
    expect(h.saved.map((x) => x.name)).toEqual(['seven.png']);
    h.cfg = config({ attachments: { max_mb: 1 } });
    h.saved = [];
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, attachments: [cdn('two.png', { size: 2 * 1024 * 1024 })] }));
    expect(h.saved).toEqual([]);
  });

  it('owner: a message with no attachments touches neither the network nor the files', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false }));
    expect(h.fetches).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.turns[0].images).toBeUndefined();
  });

  it('public: never fetched, never saved; the run is told what kinds were there, not opened', async () => {
    open();
    await send(message({ content: 'see this', attachments: [cdn('pic.png', { contentType: 'image/png' }), cdn('doc.pdf'), cdn('clip.mp4', { contentType: 'video/mp4' })] }));
    expect(h.fetches).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.publicRuns).toHaveLength(1);
    expect(h.publicRuns[0].attachments).toEqual(['image', 'file', 'video']);
    expect(h.publicRuns[0].text).toBe('see this');
  });

  it('public: a message without attachments passes none', async () => {
    open();
    await send(message({ content: 'plain' }));
    expect(h.publicRuns[0].attachments).toBeUndefined();
  });
});

// ── D11: failures reach the logs service ──
describe('failures are written to the logs service under the discord category (D11)', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };

  it('owner: reply failed records reply_failed with the error class, and the line carries no message text or path', async () => {
    h.turnImpl = async () => { throw Object.assign(new Error('boom /home/x/secret.txt'), { name: 'AgentTurnError', kind: 'provider_error' }); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ channelId: OWNER_CH, authorId: OWNER, content: 'private words' }));
    expect(eventSummary('discord')).toMatchObject({ count24h: 1, lastKind: 'reply_failed' });
    const line = err.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[discord] failure'));
    expect(line).toBe('[discord] failure kind=reply_failed class=provider_error');
    err.mockRestore();
  });

  it('public: a failed run records its kind (api_key_missing), every message counted, the line printed once', async () => {
    open();
    const { PublicRunError } = await import('./public-runtime.js');
    h.publicImpl = async () => { throw new (PublicRunError as any)('api_key_missing'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ content: 'a' })); await send(message({ content: 'b' })); await send(message({ content: 'c' }));
    expect(eventSummary('discord')).toMatchObject({ count24h: 3, lastKind: 'api_key_missing' });
    expect(err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('kind=api_key_missing'))).toHaveLength(1);
    err.mockRestore();
  });

  it('public: any other failed run is recorded as public_run_failed with its class', async () => {
    open();
    h.publicImpl = async () => { throw new Error('ENOENT /home/x/secret'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ content: 'a' }));
    expect(eventSummary('discord')).toMatchObject({ count24h: 1, lastKind: 'public_run_failed' });
    expect(err.mock.calls.flat().join('\n')).not.toMatch(/secret|ENOENT/);
    err.mockRestore();
  });

  it('an exclusions file that cannot be had is recorded as exclusions_failed, once per outage like its warning', async () => {
    open();
    rmSync(exclusionsFile, { force: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message()); await send(message());
    expect(eventSummary('discord')).toMatchObject({ count24h: 1, lastKind: 'exclusions_failed' });
    warn.mockRestore(); err.mockRestore();
  });

  it('nothing is recorded when nothing failed', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER }));
    expect(eventSummary('discord').count24h).toBe(0);
  });
});

// ── B3b verifier lows ──
describe('stop() with deferrals queued', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };
  const systemLines = () => h.messages.filter((m) => m.role === 'system');

  it('clears the hourglass on every queued deferral before dropping them, and says nothing to the owner', async () => {
    open();
    h.webMinutes = 0;
    await svc.start();
    await send(message({ authorId: '334' }));
    await send(message({ authorId: '335' }));
    expect((svc as any).deferredBatches).toHaveLength(2);
    await svc.stop();
    expect(h.unreacts.filter((u) => u.emoji === '\u23F3')).toHaveLength(2);
    expect((svc as any).deferredBatches).toHaveLength(0);
    expect(systemLines()).toEqual([]);
    expect(registry.broadcast).not.toHaveBeenCalled();
  });
});

describe('a follow-up batch is capped (20 messages, 8000 characters); beyond that a second batch queues behind', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };
  const gate = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('22 messages that arrive during a run are answered as a batch of 20 and a batch of 2, in order', async () => {
    open();
    const g = gate();
    h.publicImpl = async (a: any) => { if (a.text === 'first') await g.promise; return { text: 'ok' }; };
    await send(message({ content: 'first' }));
    for (let i = 0; i < 22; i++) { h.client.emit('messageCreate', message({ content: `m${i}` })); await nap(12); }
    expect(h.publicRuns).toHaveLength(1);
    g.release();
    await nap(500);
    expect(h.publicRuns.map((r) => r.text.split('\n').length)).toEqual([1, 20, 2]);
    expect(h.publicRuns[1].text.split('\n')[0]).toBe('m0');
    expect(h.publicRuns[2].text).toBe('m20\nm21');
  });

  it('3 x 3000 characters: the third does not fit in the first follow-up and queues behind it', async () => {
    open();
    const g = gate();
    h.publicImpl = async (a: any) => { if (a.text === 'first') await g.promise; return { text: 'ok' }; };
    await send(message({ content: 'first' }));
    for (const c of ['a', 'b', 'c']) { h.client.emit('messageCreate', message({ content: c.repeat(3000) })); await nap(12); }
    g.release();
    await nap(400);
    expect(h.publicRuns.map((r) => r.text.length)).toEqual([5, 6001, 3000]);
  });

  it('a single message over the cap is still taken whole, never dropped or split', async () => {
    open();
    const g = gate();
    h.publicImpl = async (a: any) => { if (a.text === 'first') await g.promise; return { text: 'ok' }; };
    await send(message({ content: 'first' }));
    h.client.emit('messageCreate', message({ content: 'z'.repeat(9000) }));
    await nap(12);
    g.release();
    await nap(300);
    expect(h.publicRuns.map((r) => r.text.length)).toEqual([5, 9000]);
  });
});

describe('identity_missing is said once per process; the transcript error line is still per message', () => {
  it('three public messages with no identity: one error line in the log, three counted', async () => {
    h.cfg = config({ public: { ...config().public, enabled: true } });
    const { PublicRunError } = await import('./public-runtime.js');
    h.publicImpl = async () => { throw new (PublicRunError as any)('identity_missing'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(message({ content: 'a' })); await send(message({ content: 'b' })); await send(message({ content: 'c' }));
    expect(err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('identity_missing'))).toHaveLength(1);
    expect(eventSummary('discord')).toMatchObject({ count24h: 3, lastKind: 'identity_missing' });
    err.mockRestore();
  });
});

// ── Pass C: the queues and the counters survive a restart ──
describe('a restart loses none of the queues (pass C)', () => {
  const open = (over: any = {}) => { h.cfg = config({ public: { ...config().public, enabled: true, ...(over.public ?? {}) }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'public')) }); };
  const rows = (table: string) => h.db.prepare(`SELECT * FROM ${table}`).all() as any[];
  const restart = async () => { await svc.stop(); svc = new DiscordService({} as any, registry); await svc.start(); return svc; };
  const gate = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const HOUR = 3_600_000;
  const ownerThread = `discord-owner-${sha12(OWNER_CH)}`;
  const hourglasses = () => h.reacts.filter((r) => r.emoji === '\u23F3');

  it('a deferred batch is written down, kept by stop(), put back (hourglass and all) at start(), and runs when the owner is idle', async () => {
    open();
    h.webMinutes = 0;
    await svc.start();
    await send(message({ authorId: '334', content: 'wait for me' }));
    expect(svc.getStats().deferredPending).toBe(1);
    expect(rows('discord_deferrals')).toHaveLength(1);
    await svc.stop();
    expect(rows('discord_deferrals')).toHaveLength(1); // a shutdown is not an expiry: the rows stay
    const before = hourglasses().length;
    await restart();
    expect(svc.getStats().deferredPending).toBe(1);
    expect(hourglasses().length).toBe(before + 1); // put back on the message
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns.map((r) => r.text)).toEqual(['wait for me']);
    expect(rows('discord_deferrals')).toHaveLength(0);
  });

  it('a batch deferred before the restart still expires on time, with the owner line (counts and names, never text)', async () => {
    open({ deferral_hours: 2 });
    h.webMinutes = 0;
    await svc.start();
    await send(message({ authorId: '334', username: 'moss', content: 'secret words one' }));
    await svc.stop();
    h.db.prepare('UPDATE discord_deferrals SET queued_at = queued_at - ?').run(3 * HOUR);
    await restart();
    const line = h.messages.find((m) => m.role === 'system' && /waited out/.test(m.content));
    expect(line).toBeDefined();
    expect(line.threadId).toBe(ownerThread);
    expect(line.content).toMatch(/1 Discord message waited out the 2-hour deferral/);
    expect(line.content).toMatch(/1 from moss/);
    expect(line.content).not.toContain('secret words');
    expect(svc.getStats().deferredPending).toBe(0);
    expect(rows('discord_deferrals')).toHaveLength(0);
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    expect(h.publicRuns).toEqual([]);
  });

  it('an expired batch whose messages are gone is still announced, from what was written down', async () => {
    open({ deferral_hours: 2 });
    h.webMinutes = 0;
    await svc.start();
    await send(message({ authorId: '334', username: 'moss' }));
    await svc.stop();
    h.db.prepare('UPDATE discord_deferrals SET queued_at = queued_at - ?').run(3 * HOUR);
    h.known.clear();
    await restart();
    expect(h.messages.find((m) => m.role === 'system' && /waited out/.test(m.content))?.content).toMatch(/1 from moss/);
  });

  it('a batch that has not expired but whose messages are gone is not lost silently: one owner line says so', async () => {
    open();
    h.webMinutes = 0;
    await svc.start();
    await send(message({ authorId: '334' }));
    await send(message({ authorId: '335' }));
    await svc.stop();
    h.known.clear();
    await restart();
    expect(svc.getStats().deferredPending).toBe(0);
    const lines = h.messages.filter((m) => m.role === 'system' && /could not be put back/.test(m.content));
    expect(lines).toHaveLength(1);
    expect(lines[0].content).toMatch(/2 /);
    expect(rows('discord_deferrals')).toHaveLength(0);
  });

  it('a follow-up that was waiting behind a run is kept and runs after the restart', async () => {
    open();
    const g = gate();
    h.publicImpl = async (a: any) => { if (a.text === 'first') await g.promise; return { text: 'ok' }; };
    await svc.start();
    await send(message({ content: 'first' }));
    await send(message({ content: 'second' }));
    expect(rows('discord_followups')).toHaveLength(1);
    await svc.stop(); // the process goes away with 'second' still waiting
    expect(rows('discord_followups')).toHaveLength(1);
    g.release();
    await nap(30);
    await restart();
    await nap(200);
    expect(h.publicRuns.map((r) => r.text)).toEqual(['first', 'second']);
    expect(rows('discord_followups')).toHaveLength(0);
  });

  it('follow-up batches keep their order and their cap after a restart', async () => {
    open();
    const g = gate();
    h.publicImpl = async (a: any) => { if (a.text === 'first') await g.promise; return { text: 'ok' }; };
    await svc.start();
    await send(message({ content: 'first' }));
    for (const c of ['a', 'b', 'c']) { h.client.emit('messageCreate', message({ content: c.repeat(3000) })); await nap(12); }
    expect(rows('discord_followups')).toHaveLength(2); // 6001 characters and 3000
    await svc.stop();
    g.release();
    await restart();
    await nap(400);
    expect(h.publicRuns.map((r) => r.text.length)).toEqual([5, 6001, 3000]);
  });

  it('the bot exchange cap survives a restart, and a human message resets it for good', async () => {
    open({ public: { bots: 'capped', bot_exchange_limit: 2 } });
    await send(message({ bot: true, authorId: '77', content: 'one' }));
    await send(message({ bot: true, authorId: '77', content: 'two' }));
    expect(h.publicRuns).toHaveLength(2);
    await restart();
    await send(message({ bot: true, authorId: '77', content: 'three' }));
    expect(h.publicRuns).toHaveLength(2); // capped, though this is a new process
    await send(message({ authorId: '333', content: 'a human speaks' }));
    await restart();
    await send(message({ bot: true, authorId: '77', content: 'four' }));
    expect(h.publicRuns.map((r) => r.text)).toEqual(['one', 'two', 'a human speaks', 'four']);
  });

  it('the hourly total survives a restart, and ages out of the hour on the clock', async () => {
    open({ public: { bots: 'capped', bot_exchange_limit: 9, bot_hourly_limit: 2 } });
    await send(message({ bot: true, authorId: '71', content: 'a' }));
    await send(message({ bot: true, authorId: '72', content: 'b' }));
    await restart();
    await send(message({ bot: true, authorId: '73', content: 'c' }));
    expect(h.publicRuns).toHaveLength(2);
    h.db.prepare('UPDATE discord_bot_replies SET at = at - ?').run(2 * HOUR);
    await restart();
    await send(message({ bot: true, authorId: '74', content: 'd' }));
    expect(h.publicRuns.map((r) => r.text)).toEqual(['a', 'b', 'd']);
  });

  it('with nothing written down, start() asks Discord for nothing', async () => {
    await svc.start();
    expect(h.channelFetches).toBe(0);
  });

  it('a database that cannot be read does not stop the gateway: it starts with empty queues and says so', async () => {
    open();
    h.webMinutes = 0;
    await svc.start();
    await send(message({ authorId: '334' }));
    await svc.stop();
    h.db.exec('DROP TABLE discord_deferrals');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await restart();
    expect(svc.isConnected()).toBe(true);
    expect(svc.getStats().deferredPending).toBe(0);
    expect(err.mock.calls.flat().join('\n')).toMatch(/queue/i);
    err.mockRestore();
  });
});

// ── Pass B3c: the restore is ordered and single-flight; a transient failure at boot loses nothing ──
describe('B3c: restore, owner changes and the hourglass', () => {
  const open = (over: any = {}) => { h.cfg = config({ public: { ...config().public, enabled: true, ...(over.public ?? {}) }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'public')) }); };
  const rows = (table: string) => h.db.prepare(`SELECT * FROM ${table}`).all() as any[];
  const restart = async () => { await svc.stop(); svc = new DiscordService({} as any, registry); await svc.start(); return svc; };
  const gate = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const HOUR = 3_600_000;
  const ownerLines = (re: RegExp) => h.messages.filter((m: any) => m.role === 'system' && re.test(m.content));
  /** Make the next `n` channel fetches fail with a transient error (n = Infinity: all of them). */
  const failFetches = (n: number) => {
    const real = h.client.channels.fetch;
    let left = n;
    h.client.channels.fetch = async (id: string) => { if (left > 0) { left--; throw new Error('503 Service Unavailable'); } return real(id); };
  };

  it('item 2: a restored owner follow-up and an owner message that arrives during a slow restore: the restored one first, one turn in flight at a time', async () => {
    let inflight = 0, maxInflight = 0;
    const g1 = gate();
    h.turnImpl = async (o: any) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      try { if (o.content === 'first') await g1.promise; if (o.content === 'second') await nap(40); return { sent: true, attempts: 1 }; } finally { inflight--; }
    };
    await svc.start();
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'first' }));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'second' }));
    await svc.stop();
    g1.release(); await nap(30);
    inflight = 0; maxInflight = 0; h.turns = [];

    svc = new DiscordService({} as any, registry);
    const slow = gate();
    const realFetch = h.client.channels.fetch;
    h.client.channels.fetch = async (id: string) => { await slow.promise; return realFetch(id); };
    const started = svc.start();
    await nap(40);
    h.client.emit('messageCreate', message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'third' }));
    await nap(80); // the debounce has passed: 'third' reached the service while the restore is still waiting on Discord
    expect(h.turns).toEqual([]); // and did not start a turn of its own ahead of the restored one
    slow.release();
    await started;
    await nap(400);
    expect(h.turns.map((t: any) => t.content)).toEqual(['second', 'third']);
    expect(maxInflight).toBe(1);
  });

  it('item 6: an owner-lane follow-up queued by the previous owner is dropped after owner.user_id changes, with one owner line', async () => {
    const g1 = gate();
    h.turnImpl = async (o: any) => { if (o.content === 'first') await g1.promise; return { sent: true, attempts: 1 }; };
    await svc.start();
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'first' }));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'queued by the old owner' }));
    await svc.stop();
    g1.release(); await nap(30);
    h.turns = []; h.messages = [];
    h.cfg = config({ owner: { user_id: '999', channel_id: OWNER_CH } });
    svc = new DiscordService({} as any, registry); await svc.start();
    await nap(150);
    expect(h.turns).toEqual([]);
    expect(ownerLines(/previous owner/i)).toHaveLength(1);
    expect(rows('discord_followups')).toHaveLength(0);
  });

  it('item 6: the same owner after a restart still gets the queued follow-up (the check is not a blanket drop)', async () => {
    const g1 = gate();
    h.turnImpl = async (o: any) => { if (o.content === 'first') await g1.promise; return { sent: true, attempts: 1 }; };
    await svc.start();
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'first' }));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'still mine' }));
    await svc.stop();
    g1.release(); await nap(30);
    h.turns = [];
    svc = new DiscordService({} as any, registry); await svc.start();
    await nap(150);
    expect(h.turns.map((t: any) => t.content)).toEqual(['still mine']);
  });

  it('item 4: a transient channel fetch failure at boot keeps the row; the next restore puts it back and the hourglass comes off when it is answered', async () => {
    open();
    h.webMinutes = 0;
    await svc.start();
    const m = message({ authorId: '334' });
    await send(m);
    await svc.stop();
    h.unreacts = [];
    svc = new DiscordService({} as any, registry);
    failFetches(1);
    await svc.start();
    expect(rows('discord_deferrals')).toHaveLength(1); // kept
    expect(svc.getStats().deferredPending).toBe(0);
    expect(ownerLines(/could not be put back/)).toHaveLength(0); // not announced as lost
    await restart(); // Discord is fine now
    expect(svc.getStats().deferredPending).toBe(1);
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    await nap(50);
    expect(h.unreacts.some((u: any) => u.message === m.id)).toBe(true);
    expect(h.publicRuns).toHaveLength(1);
    expect(rows('discord_deferrals')).toHaveLength(0);
  });

  it('item 4: a follow-up row survives a transient failure too', async () => {
    const g1 = gate();
    h.turnImpl = async (o: any) => { if (o.content === 'first') await g1.promise; return { sent: true, attempts: 1 }; };
    await svc.start();
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'first' }));
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content: 'second' }));
    await svc.stop();
    g1.release(); await nap(30);
    h.turns = [];
    svc = new DiscordService({} as any, registry);
    failFetches(1);
    await svc.start();
    await nap(100);
    expect(h.turns).toEqual([]);
    expect(rows('discord_followups')).toHaveLength(1);
    await restart();
    await nap(150);
    expect(h.turns.map((t: any) => t.content)).toEqual(['second']);
  });

  it('item 4: after 3 failed restores the row is dropped with the owner line, and the hourglass is left for the next start to clear', async () => {
    open();
    h.webMinutes = 0;
    await svc.start();
    const m = message({ authorId: '334' });
    await send(m);
    await svc.stop();
    h.unreacts = []; h.messages = [];
    for (let i = 1; i <= 3; i++) {
      svc = new DiscordService({} as any, registry);
      failFetches(Infinity);
      await svc.start();
      await svc.stop();
      if (i < 3) { expect(rows('discord_deferrals')).toHaveLength(1); expect(ownerLines(/could not be put back/)).toHaveLength(0); }
    }
    expect(rows('discord_deferrals')).toHaveLength(0);
    expect(ownerLines(/could not be put back/)).toHaveLength(1);
    expect(rows('discord_pending_unreact')).toHaveLength(1);
    // Discord is reachable again: the next start takes the hourglass off.
    svc = new DiscordService({} as any, registry); await svc.start();
    expect(h.unreacts.some((u: any) => u.message === m.id)).toBe(true);
    expect(rows('discord_pending_unreact')).toHaveLength(0);
  });

  it('item 4: a deferral that expired while Discord was unreachable is announced, and its hourglass is cleared by the next start', async () => {
    open({ deferral_hours: 2 });
    h.webMinutes = 0;
    await svc.start();
    const m = message({ authorId: '334', username: 'moss' });
    await send(m);
    await svc.stop();
    h.db.prepare('UPDATE discord_deferrals SET queued_at = queued_at - ?').run(3 * HOUR);
    h.unreacts = []; h.messages = [];
    svc = new DiscordService({} as any, registry);
    failFetches(Infinity);
    await svc.start();
    expect(ownerLines(/waited out/)).toHaveLength(1);
    expect(rows('discord_deferrals')).toHaveLength(0);
    expect(rows('discord_pending_unreact')).toHaveLength(1);
    await svc.stop();
    svc = new DiscordService({} as any, registry); await svc.start();
    expect(h.unreacts.some((u: any) => u.message === m.id)).toBe(true);
    expect(rows('discord_pending_unreact')).toHaveLength(0);
    expect(ownerLines(/waited out/)).toHaveLength(1); // not said again
  });

  it('item 4: drain takes the hourglass off BEFORE it deletes the row (a crash in between cannot strand the hourglass)', async () => {
    open();
    h.webMinutes = 0;
    await svc.start();
    const m = message({ authorId: '334' });
    let rowsAtUnreact = -1;
    m.reactions.resolve = () => ({ users: { remove: async () => { rowsAtUnreact = rows('discord_deferrals').length; } } });
    await send(m);
    h.webMinutes = 999;
    await (svc as any).drainDeferredQueue();
    await nap(50);
    expect(rowsAtUnreact).toBe(1);
    expect(rows('discord_deferrals')).toHaveLength(0);
    expect(h.publicRuns).toHaveLength(1);
  });

  it('item 4: expiry takes the hourglass off BEFORE it deletes the row, and says it once', async () => {
    open({ deferral_hours: 2 });
    h.webMinutes = 0;
    await svc.start();
    const m = message({ authorId: '334', username: 'moss' });
    let rowsAtUnreact = -1;
    m.reactions.resolve = () => ({ users: { remove: async () => { rowsAtUnreact = rows('discord_deferrals').length; } } });
    await send(m);
    (svc as any).deferredBatches[0].queuedAt -= 3 * HOUR;
    await Promise.all([(svc as any).expireDeferred(), (svc as any).expireDeferred()]); // two overlapping sweeps
    expect(rowsAtUnreact).toBe(1);
    expect(rows('discord_deferrals')).toHaveLength(0);
    expect(ownerLines(/waited out/)).toHaveLength(1);
  });
});


// D11: the failure alert is wired to the real send paths, per lane. Deleting either noteDiscordSendOk call fails here.
describe('the failure alert, per lane, through the real send paths', () => {
  const open = () => { h.cfg = config({ public: { ...config().public, enabled: true } }); };
  const alertLines = () => h.messages.filter((m) => m.metadata?.discordFailureAlert).map((m) => m.content as string);
  const ownerMsg = () => message({ channelId: OWNER_CH, authorId: OWNER });
  const publicMsg = () => message({ channelId: '600' });
  const failOwner = () => { h.turnImpl = async () => { throw new Error('boom'); }; };
  const failPublic = () => { h.publicImpl = async () => { throw new Error('boom'); }; };

  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('an owner reply that goes out clears the owner lane: the clear line names it', async () => {
    failOwner();
    for (let i = 0; i < 3; i++) await send(ownerMsg());
    expect(alertLines()).toEqual([expect.stringContaining('on the owner lane')]);
    expect(discordAlertActive('owner')).toBe(true);
    h.turnImpl = null;
    await send(ownerMsg());
    expect(discordAlertActive('owner')).toBe(false);
    expect(alertLines()).toHaveLength(2);
    expect(alertLines()[1]).toBe('Discord: sends are going out again on the owner lane.');
  });

  it('a public reply that goes out clears the public lane: the clear line names it', async () => {
    open(); failPublic();
    for (let i = 0; i < 3; i++) await send(publicMsg());
    expect(alertLines()).toEqual([expect.stringContaining('on the public lane')]);
    expect(discordAlertActive('public')).toBe(true);
    h.publicImpl = null;
    await send(publicMsg());
    expect(discordAlertActive('public')).toBe(false);
    expect(alertLines()[1]).toBe('Discord: sends are going out again on the public lane.');
  });

  it('owner replies going out do not clear a public alert, and say nothing about the public lane', async () => {
    open(); failPublic();
    for (let i = 0; i < 3; i++) await send(publicMsg());
    expect(discordAlertActive('public')).toBe(true);
    await send(ownerMsg());
    await send(ownerMsg());
    expect(discordAlertActive('public')).toBe(true);
    expect(alertLines()).toHaveLength(1);
  });

  it('a public lane that keeps failing reaches its threshold while the owner chats in between', async () => {
    open(); failPublic();
    await send(publicMsg()); await send(ownerMsg());
    await send(publicMsg()); await send(ownerMsg());
    await send(publicMsg());
    expect(alertLines()).toEqual([expect.stringContaining('3 sends failed on the public lane')]);
  });
});
