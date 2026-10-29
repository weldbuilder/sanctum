// The one-send-path rule, checked by RUNNING the service rather than reading it: DiscordService end to end over a
// discord.js whose every send-like method (send, reply, edit, forward, setTopic, setName, createWebhook, threads.create,
// setActivity, setPresence, DMs) is a spy. The real sender (send.ts) and the real turn runner are in the loop. The
// assertion is that every call to every spy happened INSIDE sendGated (the stack of a sendGated call), and that nothing
// ever reached one outside it, on either lane, for a clean reply, a long reply, a blocked reply and a failed turn.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-spy-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const wordsFile = join(tmp, 'words.txt');
const exclusionsFile = join(tmp, 'exclusions.txt');

const h = vi.hoisted(() => ({
  cfg: {} as any,
  client: null as any,
  inGate: 0,
  calls: [] as Array<{ name: string; inGate: boolean; payload: any }>,
  reply: 'a reply' as string,
  publicReply: 'a public reply' as string,
  failTurn: false,
  messages: [] as any[],
}));

vi.mock('discord.js', async () => {
  const { EventEmitter } = await import('node:events');
  const spy = (name: string) => vi.fn(async (payload?: any) => { h.calls.push({ name, inGate: h.inGate > 0, payload }); return { id: `sent-${name}` }; });
  class Client extends EventEmitter {
    user = { id: '900', tag: 'her#0001', username: 'her', setActivity: spy('client.user.setActivity'), setPresence: spy('client.user.setPresence'), send: spy('client.user.send'), setUsername: spy('client.user.setUsername') };
    guilds = { cache: { size: 1, get: () => undefined } };
    channels = { cache: { get: () => undefined } };
    constructor() { super(); h.client = this; }
    async login() {}
    destroy() {}
    isReady() { return true; }
  }
  (globalThis as any).__spy = spy;
  return {
    Client,
    Events: { MessageCreate: 'messageCreate', ClientReady: 'clientReady', ShardDisconnect: 'shardDisconnect', ShardReconnecting: 'shardReconnecting', ShardResume: 'shardResume' },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 8 },
  };
});
vi.mock('../db.js', () => ({
  createMessage: (m: any) => { h.messages.push(m); return { ...m, thread_id: m.threadId }; },
  createThread: () => ({}),
  getThread: () => ({ name: 'owner' }),
  updateThreadActivity: () => {},
  ensureDailyThread: () => ({ thread: { id: 'daily' }, justCreated: false }),
  getConfig: () => null,
  setConfig: () => {},
  countThreadsWithPrefix: () => 0,
}));
vi.mock('../files.js', () => ({ saveFile: () => ({}) }));
vi.mock('../bot-token.js', () => ({ getBotToken: () => 'token' }));
vi.mock('../../config.js', () => ({ getSanctumConfig: () => ({ identity: { user_name: 'Pat' }, discord: h.cfg }) }));
vi.mock('./config.js', () => ({
  DISCORD_CONFIG: { debounceMs: 5 },
  getDiscordConfig: () => ({ ownerUserId: '111', ownerActiveThresholdMin: 3, deferPollIntervalMs: 60000, deferMaxAgeMs: null, followUpDebounceMs: 20 }),
}));
vi.mock('./harness.js', () => ({ publicHarnessSupported: () => true }));
vi.mock('./paths.js', () => ({ getDiscordPaths: () => ({ exclusionsFile, wordsFile, namesFile: join(tmp, 'names.txt'), privateDir: tmp, refused: [] }) }));
vi.mock('./rules.js', () => ({ buildRulesContext: () => '' }));
vi.mock('./public-transcript.js', () => ({ publicTranscript: { append: () => {}, tail: () => [] } }));
vi.mock('./public-runtime.js', () => ({
  PublicRunError: class PublicRunError extends Error { constructor(readonly kind: string) { super(kind); } },
  runPublicTurn: async () => ({ text: h.publicReply }),
}));
// The REAL sender, with a marker around it: a spy called while a sendGated call is on the stack was reached through it.
vi.mock('./send.js', async (orig) => {
  const real = await orig<typeof import('./send.js')>();
  const wrapped: any = async (...a: any[]) => { h.inGate++; try { return await (real.sendGated as any)(...a); } finally { h.inGate--; } };
  wrapped.action = real.sendGated.action;
  return { ...real, sendGated: wrapped, gatedAction: real.sendGated.action };
});

import { DiscordService } from './index.js';

const OWNER = '111'; const OWNER_CH = '222'; const GUILD = '500';
let seq = 0;
function message(over: any = {}) {
  const spy = (globalThis as any).__spy as (n: string) => any;
  const channelId = over.channelId ?? '600';
  return {
    id: `m${seq++}`, channelId, guildId: GUILD, content: over.content ?? 'hello', attachments: new Map(), webhookId: null,
    author: { id: over.authorId ?? '333', username: 'someone', bot: false, send: spy('message.author.send') },
    member: { send: spy('message.member.send'), displayName: 'Someone' },
    channel: {
      id: channelId, isThread: () => false, parentId: null, name: 'general', sendTyping: async () => {},
      send: spy('channel.send'), setTopic: spy('channel.setTopic'), setName: spy('channel.setName'), createWebhook: spy('channel.createWebhook'),
      threads: { create: spy('channel.threads.create') },
      bulkDelete: spy('channel.bulkDelete'),
      messages: { fetch: async () => new Map(), pin: spy('channel.messages.pin') },
    },
    guild: {
      setName: spy('guild.setName'),
      members: { me: { setNickname: spy('guild.members.me.setNickname') } },
      channels: { create: spy('guild.channels.create') },
      scheduledEvents: { create: spy('guild.scheduledEvents.create') },
      stageInstances: { create: spy('guild.stageInstances.create') },
      roles: { create: spy('guild.roles.create') },
      emojis: { create: spy('guild.emojis.create') },
    },
    reply: spy('message.reply'), edit: spy('message.edit'), forward: spy('message.forward'), startThread: spy('message.startThread'),
    pin: spy('message.pin'), crosspost: spy('message.crosspost'),
    reactions: { resolve: () => undefined },
    mentions: { users: { has: (id: string) => (over.mention ?? true) && id === '900', get: () => undefined }, roles: { keys: () => [], get: () => undefined }, channels: { get: () => undefined }, members: { get: () => undefined }, repliedUser: null },
    react: spy('message.react'),
    createdAt: new Date(),
  };
}

const agent: any = {
  processMessage: async (_t: string, _c: string, _m: any, opts: any) => {
    if (h.failTurn) throw new Error('provider exploded');
    opts?.hold?.onHeld({ text: h.reply, commit() {}, discard() {} });
    return h.reply;
  },
  runExclusive: (fn: any) => fn(),
};
const registry: any = { broadcast: vi.fn(), minutesSinceLastUserWebActivity: () => 999, touchUserActivity: () => {} };
const settle = () => new Promise((r) => setTimeout(r, 80));
const send = async (m: any) => { h.client.emit('messageCreate', m); await settle(); };
let svc: DiscordService;

beforeEach(() => {
  h.cfg = { enabled: true, owner: { user_id: OWNER, channel_id: OWNER_CH }, public: { enabled: true, guild_ids: [GUILD], role_ids: [], bots: 'never', bot_exchange_limit: 4, bot_hourly_limit: 20 }, paused: false, deferral_hours: 24 };
  h.calls = []; h.inGate = 0; h.reply = 'a reply'; h.publicReply = 'a public reply'; h.failTurn = false; h.messages = [];
  writeFileSync(wordsFile, 'Maple Street\n');
  writeFileSync(exclusionsFile, '# nobody\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  svc = new DiscordService(agent, registry);
});
afterEach(async () => { await svc.stop(); vi.restoreAllMocks(); });

const outside = () => h.calls.filter((c) => !c.inGate);
const names = () => h.calls.map((c) => c.name);

describe('every send-like call is made by sendGated and by nothing else', () => {
  it('owner lane, a clean reply: one message.reply, inside the gate', async () => {
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false }));
    expect(names()).toEqual(['message.reply']);
    expect(outside()).toEqual([]);
    expect(h.calls[0].payload).toMatchObject({ content: 'a reply', allowedMentions: { parse: [] } });
  });

  it('owner lane, a long reply: the first chunk is message.reply and the rest channel.send, all inside the gate', async () => {
    h.reply = `${'word '.repeat(700)}`.trim();
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false }));
    await new Promise((r) => setTimeout(r, 500)); // the pause between chunks is 200 ms
    expect(names()[0]).toBe('message.reply');
    expect(names().slice(1).every((n) => n === 'channel.send')).toBe(true);
    expect(names().length).toBeGreaterThan(1);
    expect(outside()).toEqual([]);
  });

  it('public lane: one message.reply inside the gate, mentions off and the person replied to not pinged', async () => {
    await send(message());
    expect(names()).toEqual(['message.reply']);
    expect(outside()).toEqual([]);
    expect(h.calls[0].payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('a reply the gate withholds: nothing is sent at all, on either lane', async () => {
    h.reply = 'it is on Maple Street'; h.publicReply = 'it is on Maple Street';
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false }));
    await send(message());
    expect(h.calls).toEqual([]);
  });

  it('a failed turn: the owner is told in the thread (a system line), and no Discord method is touched', async () => {
    h.failTurn = true;
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false }));
    expect(h.calls).toEqual([]);
    expect(h.messages.some((m) => m.role === 'system' && /reply failed/.test(m.content))).toBe(true);
  });

  it('nothing ever calls setTopic, threads.create, forward, setActivity, setPresence, createWebhook, a DM send or an edit, whatever happens', async () => {
    await svc.start();
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false }));
    await send(message());
    h.failTurn = true;
    await send(message({ channelId: OWNER_CH, authorId: OWNER, mention: false }));
    const forbidden = ['channel.setTopic', 'channel.setName', 'channel.threads.create', 'message.forward', 'message.startThread', 'client.user.setActivity', 'client.user.setPresence', 'client.user.send', 'channel.createWebhook', 'message.author.send', 'message.member.send', 'message.edit',
      // B3c: every other call that puts a name, a nickname, a thread, a channel, an event, a role, an emoji or a pin in front of people.
      'client.user.setUsername', 'guild.setName', 'guild.members.me.setNickname', 'guild.channels.create', 'guild.scheduledEvents.create', 'guild.stageInstances.create',
      'guild.roles.create', 'guild.emojis.create', 'message.pin', 'channel.messages.pin', 'message.crosspost', 'channel.bulkDelete'];
    expect(names().filter((n) => forbidden.includes(n))).toEqual([]);
    // A reaction is allowed only as a plain unicode emoji (the hourglass); a custom emoji is a picture someone uploaded.
    const custom = /^<a?:\w+:\d+>$|^\w+:\d+$|^\d{15,}$/;
    expect(h.calls.filter((c) => c.name === 'message.react' && (typeof c.payload !== 'string' || custom.test(c.payload)))).toEqual([]);
    expect(outside().filter((c) => c.name !== 'message.react')).toEqual([]);
  });

  it('the spies are live: a call made outside the gate WOULD be seen (the test is not vacuous)', async () => {
    const m = message();
    await m.channel.setTopic('x');
    expect(outside().map((c) => c.name)).toEqual(['channel.setTopic']);
  });

  it('the B3c spies are live too: each of the new calls is recorded when made', async () => {
    const m: any = message();
    await m.guild.members.me.setNickname('x'); await m.guild.channels.create({}); await m.guild.scheduledEvents.create({});
    await m.guild.stageInstances.create({}); await m.guild.roles.create({}); await m.guild.emojis.create({}); await m.guild.setName('x');
    await m.pin(); await m.crosspost(); await m.channel.bulkDelete(5); await m.channel.messages.pin('1'); await h.client.user.setUsername('x');
    await m.react('<:wave:123456789012345678>');
    expect(names()).toEqual(['guild.members.me.setNickname', 'guild.channels.create', 'guild.scheduledEvents.create', 'guild.stageInstances.create', 'guild.roles.create', 'guild.emojis.create', 'guild.setName', 'message.pin', 'message.crosspost', 'channel.bulkDelete', 'channel.messages.pin', 'client.user.setUsername', 'message.react']);
  });
});
