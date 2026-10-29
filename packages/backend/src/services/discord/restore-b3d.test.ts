// DiscordService end to end at the seam discord.js gives it: a message arrives, the lane is decided
// by channel, and the turn runs (or does not) on the right thread. discord.js, the DB, the config and
// the turn runner are stubs; the lane code, the debouncer and the thread resolver are the real ones.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-restore-b3d-'));
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
  h.legacyDeferMs = null; h.unreacts = []; h.refFetches = []; h.followUpMs = 20; h.saved = []; h.fetches = []; resetEvents();
  h.db = h.newDb(); h.known.clear(); h.reacts = []; h.channelFetches = 0;
  svc =new DiscordService({} as any, registry);
});

afterEach(async () => { await svc.stop(); });

// B3d: the restore after a restart. Rows are left in SQLite the way a crash mid-turn does, then a new service starts
// over the same database with a misbehaving Discord.
const rows = (table: string) => h.db.prepare(`SELECT * FROM ${table}`).all() as any[];
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };
const ownerMsg = (content: string) => message({ channelId: OWNER_CH, authorId: OWNER, mention: false, content });
const lines = (re: RegExp) => h.messages.filter((m: any) => re.test(String(m.content))).length;
/** Leave one owner follow-up ('second') in SQLite, the way a crash mid-turn does. */
const leaveOwnerFollowUp = async () => {
  const g1 = gate();
  h.turnImpl = async (o: any) => { if (o.content === 'first') await g1.promise; return { sent: true, attempts: 1 }; };
  await svc.start();
  await send(ownerMsg('first'));
  await send(ownerMsg('second'));
  await svc.stop();
  g1.release(); await nap(30);
  h.turns = []; h.turnImpl = null;
};
const fresh = (fetchMs = 150, totalMs = 600) => {
  svc = new DiscordService({} as any, registry);
  (svc as any).restoreFetchMs = fetchMs;
  (svc as any).restoreTotalMs = totalMs;
  return svc;
};

describe('1: the restore never blocks the owner lane for good', () => {
  it('a restore fetch that never resolves: start() returns within the bound, the owner lane answers, the row stays, one attempt', async () => {
    await leaveOwnerFollowUp();
    fresh(200, 800);
    const realFetch = h.client.channels.fetch;
    let hang = true;
    h.client.channels.fetch = async (id: string) => (hang ? new Promise(() => {}) : realFetch(id));
    const t0 = Date.now();
    const started = svc.start();
    await nap(20);
    hang = false;
    h.client.emit('messageCreate', ownerMsg('new while hung'));
    await started;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((svc as any).deferTimer).not.toBeNull();
    expect((svc as any).restoring).toBe(false);
    await nap(400);
    expect(h.turns.map((t: any) => t.content)).toContain('new while hung');
    expect(rows('discord_followups')).toHaveLength(1);
    expect(rows('discord_restore_attempts').map((r: any) => r.attempts)).toEqual([1]);
    expect(lines(/could not be put back/)).toBe(0);
  }, 15000);

  it('only the keys that have saved rows are held', async () => {
    await leaveOwnerFollowUp();
    fresh(400, 1500);
    h.client.channels.fetch = async () => new Promise(() => {});
    void svc.start();
    await nap(20);
    expect((svc as any).restoring).toBe(true);
    expect([...(svc as any).restoringKeys]).toEqual([`owner:${OWNER_CH}`]);
    // A public message (a key with no saved row) is answered at once, while the restore is still hung.
    h.cfg = config({ public: { enabled: true, guild_ids: [GUILD], role_ids: [], bots: 'never', bot_exchange_limit: 4, bot_hourly_limit: 20 } });
    h.client.emit('messageCreate', message({ authorId: '333', mention: true }));
    await nap(150);
    expect(h.publicRuns).toHaveLength(1);
    await nap(1700);
    expect((svc as any).restoring).toBe(false);
    expect((svc as any).restoringKeys.size).toBe(0);
  }, 15000);

  it('the total bound ends a restore: the row the deadline never reached is kept with no attempt counted for it', async () => {
    await leaveOwnerFollowUp();
    const extra = message({ channelId: '601', authorId: '333' });
    h.db.prepare("INSERT INTO discord_followups (queue_key, lane, channel_id, guild_id, user_id, message_ids, who, msg_count) VALUES ('public:601:333', 'public', '601', ?, '333', ?, 'x', 1)").run(GUILD, JSON.stringify([extra.id]));
    fresh(400, 300);
    h.client.channels.fetch = async () => new Promise(() => {});
    await svc.start();
    expect(rows('discord_followups')).toHaveLength(2);
    expect(rows('discord_restore_attempts')).toHaveLength(1);
  }, 15000);
});

describe('2: a timeout is transient for message fetches too', () => {
  const failWith = async (make: () => unknown) => {
    await leaveOwnerFollowUp();
    fresh(); // the default test bounds are long enough for a failure that comes at once
    const realFetch = h.client.channels.fetch;
    h.client.channels.fetch = async (id: string) => { const c = await realFetch(id); return { ...c, messages: { fetch: async () => { throw make(); } } }; };
    await svc.start(); await nap(80);
    h.client.channels.fetch = realFetch;
  };
  const withCode = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);

  it('R5: an AbortError on a message fetch keeps the row, counts an attempt, announces nothing', async () => {
    await failWith(() => new DOMException('This operation was aborted', 'AbortError'));
    expect(rows('discord_followups')).toHaveLength(1);
    expect(rows('discord_restore_attempts').map((r: any) => r.attempts)).toEqual([1]);
    expect(lines(/could not be put back/)).toBe(0);
  });

  it.each([
    ['ETIMEDOUT', () => withCode('connect ETIMEDOUT', { code: 'ETIMEDOUT' })],
    ['ECONNRESET', () => withCode('read ECONNRESET', { code: 'ECONNRESET' })],
    ['a 503', () => withCode('Service Unavailable', { status: 503 })],
    ['a 429', () => withCode('You are being rate limited', { status: 429 })],
    ['an error with only a name', () => Object.assign(new Error(''), { name: 'TimeoutError' })],
    ['an unclassified error', () => new Error('something odd')],
  ])('%s on a message fetch keeps the row', async (_name, make) => {
    await failWith(make);
    expect(rows('discord_followups')).toHaveLength(1);
    expect(lines(/could not be put back/)).toBe(0);
  });

  it.each([
    ['Unknown Message (10008)', () => withCode('Unknown Message', { code: 10008 })],
    ['Unknown Channel (10003)', () => withCode('Unknown Channel', { code: 10003 })],
    ['Missing Access (50001)', () => withCode('Missing Access', { code: 50001 })],
  ])('%s is gone: the row goes, with the owner line', async (_name, make) => {
    await failWith(make);
    expect(rows('discord_followups')).toHaveLength(0);
    expect(lines(/could not be put back/)).toBe(1);
  });
});

describe('3: stop() during a restore', () => {
  it('R8: the in-flight restore runs no batch and arms nothing after stop(); a new service runs the batch once', async () => {
    await leaveOwnerFollowUp();
    const old = fresh(5000, 10000);
    const g = gate();
    const realFetch = h.client.channels.fetch;
    h.client.channels.fetch = async (id: string) => { await g.promise; return realFetch(id); };
    const started = old.start();
    await nap(50);
    await old.stop();
    g.release();
    await started;
    await nap(300);
    expect(h.turns).toEqual([]);
    expect((old as any).deferTimer).toBeNull();
    expect((old as any).followUps.size).toBe(0);
    expect((old as any).restoring).toBe(false);
    // The old restore wrote nothing: the row is still saved, for the next service.
    expect(rows('discord_followups')).toHaveLength(1);

    svc = new DiscordService({} as any, registry);
    await svc.start();
    await nap(300);
    expect(h.turns.map((t: any) => t.content)).toEqual(['second']);
  }, 15000);

  it('a stop() during the login is honoured too: nothing is restored or armed afterwards', async () => {
    await leaveOwnerFollowUp();
    const s = fresh();
    const g = gate();
    (h.client as any).login = async () => { await g.promise; };
    const started = s.start();
    await nap(20);
    await s.stop();
    g.release();
    await started;
    await nap(100);
    expect((s as any).started).toBe(false);
    expect((s as any).deferTimer).toBeNull();
    expect(h.turns).toEqual([]);
  });
});

describe('4: persistence while the restore runs', () => {
  const slowFetch = (ms: number) => {
    const realFetch = h.client.channels.fetch;
    h.client.channels.fetch = async (id: string) => { await nap(ms); return realFetch(id); };
    return realFetch;
  };

  it('R9: a message held during the restore does not rewrite the follow-up rows without the ones not yet restored', async () => {
    await leaveOwnerFollowUp();
    expect(rows('discord_followups')).toHaveLength(1);
    fresh(2000, 5000);
    slowFetch(300);
    void svc.start();
    await nap(30);
    h.client.emit('messageCreate', ownerMsg('held'));
    await nap(60);
    // A crash here (the process is gone, nothing more runs) would leave both: the saved row and the one just held.
    const during = rows('discord_followups').map((r: any) => JSON.parse(r.message_ids).length);
    expect(during).toHaveLength(2);
    await nap(700);
    // Restored batches come in front of the one that was held: the older runs first.
    expect(h.turns.map((t: any) => t.content)).toEqual(['second', 'held']);
    expect(rows('discord_followups')).toHaveLength(0);
  }, 15000);

  it('a deferral made during the restore does not rewrite the deferral rows without the ones not yet restored', async () => {
    h.cfg = config({ public: { enabled: true, guild_ids: [GUILD], role_ids: [], bots: 'never', bot_exchange_limit: 4, bot_hourly_limit: 20 } });
    h.webMinutes = 0; // the owner is on the web: public messages are deferred
    await svc.start();
    await send(message({ authorId: '333', mention: true }));
    await svc.stop();
    expect(rows('discord_deferrals')).toHaveLength(1);
    fresh(2000, 5000);
    slowFetch(300);
    void svc.start();
    await nap(30);
    h.client.emit('messageCreate', message({ authorId: '334', mention: true }));
    await nap(60);
    expect(rows('discord_deferrals')).toHaveLength(2);
    await nap(700);
    expect(rows('discord_deferrals')).toHaveLength(2);
    expect((svc as any).deferredBatches).toHaveLength(2);
  }, 15000);

  it('R4b: with Discord down and a pending unreact at every boot, the attempts reach 3 and the row goes at boot 3', async () => {
    await leaveOwnerFollowUp();
    h.db.prepare("INSERT INTO discord_pending_unreact (channel_id, message_id, attempts) VALUES ('600', 'mX', 0)").run();
    const log: string[] = [];
    for (let boot = 1; boot <= 3; boot++) {
      fresh();
      h.client.channels.fetch = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); };
      await svc.start(); await nap(60);
      log.push(`boot${boot} rows=${rows('discord_followups').length} attempts=${JSON.stringify(rows('discord_restore_attempts').map((r: any) => r.attempts))} unreact=${JSON.stringify(rows('discord_pending_unreact').map((r: any) => r.attempts))}`);
      await svc.stop();
    }
    expect(log).toEqual([
      'boot1 rows=1 attempts=[1] unreact=[1]',
      'boot2 rows=1 attempts=[2] unreact=[2]',
      'boot3 rows=0 attempts=[] unreact=[]',
    ]);
    expect(lines(/could not be put back/)).toBe(1);
  }, 15000);
});
