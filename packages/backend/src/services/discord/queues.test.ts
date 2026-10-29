// Pass C: the deferral queue, the follow-up buffer and the bot-exchange counters live in SQLite, so a restart loses
// none of them. The store is tested over the app's real schema (initDb runs the migration file).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, getSanctumConfig: () => ({ server: { db_path: ':memory:' }, identity: { user_name: 'Pat' } }) };
});

import { initDb, getDb } from '../db.js';
import { DiscordQueueStore, type DeferralRow, type FollowUpRow } from './queues.js';
import { BotLimiter } from './lanes.js';

const H = 3_600_000;
const row = (over: Partial<DeferralRow> = {}): DeferralRow => ({ lane: 'public', channelId: '600', guildId: '500', userId: '333', messageIds: ['m1', 'm2'], who: 'Moss (@moss)', count: 2, queuedAt: 1_000, ...over });

let store: DiscordQueueStore;
beforeEach(() => {
  initDb(':memory:');
  store = new DiscordQueueStore(getDb);
});

describe('the migration', () => {
  it('creates the four tables on a fresh database, and again without error (it runs every boot)', () => {
    const names = () => (getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'discord_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names()).toEqual(expect.arrayContaining(['discord_bot_exchanges', 'discord_bot_replies', 'discord_deferrals', 'discord_followups']));
    initDb(':memory:');
    expect(names()).toEqual(expect.arrayContaining(['discord_deferrals']));
  });
});

describe('deferrals', () => {
  it('round-trip in order, with what a restart needs to refetch them and to announce their expiry', () => {
    store.saveDeferrals([row(), row({ userId: '334', messageIds: ['m3'], who: 'Fern (@fern)', count: 1, queuedAt: 2_000, guildId: null, lane: 'owner' })]);
    const back = store.loadDeferrals();
    expect(back).toHaveLength(2);
    expect(back[0]).toEqual(row());
    expect(back[1]).toMatchObject({ lane: 'owner', guildId: null, userId: '334', messageIds: ['m3'], who: 'Fern (@fern)', count: 1, queuedAt: 2_000 });
  });

  it('saving replaces: what is no longer queued is gone', () => {
    store.saveDeferrals([row(), row({ userId: '334' })]);
    store.saveDeferrals([row({ userId: '334' })]);
    expect(store.loadDeferrals().map((r) => r.userId)).toEqual(['334']);
    store.saveDeferrals([]);
    expect(store.loadDeferrals()).toEqual([]);
  });

  it('a damaged row is skipped, not thrown', () => {
    store.saveDeferrals([row()]);
    getDb().prepare("UPDATE discord_deferrals SET message_ids = 'not json'").run();
    expect(store.loadDeferrals()).toEqual([]);
  });
});

describe('follow-ups', () => {
  const f = (key: string, over: Partial<FollowUpRow> = {}): FollowUpRow => ({ key, lane: 'public', channelId: '600', guildId: '500', userId: '333', messageIds: ['m1'], who: 'Moss (@moss)', count: 1, ...over });

  it('keep their key and their order, batch by batch', () => {
    store.saveFollowUps([f('public:600:333', { messageIds: ['a'] }), f('owner:222', { lane: 'owner', channelId: '222', userId: '111', messageIds: ['o1'] }), f('public:600:333', { messageIds: ['b'] })]);
    expect(store.loadFollowUps().map((r) => [r.key, r.messageIds[0]])).toEqual([['public:600:333', 'a'], ['owner:222', 'o1'], ['public:600:333', 'b']]);
  });

  it('saving replaces', () => {
    store.saveFollowUps([f('k')]);
    store.saveFollowUps([]);
    expect(store.loadFollowUps()).toEqual([]);
  });
});

describe('the bot-exchange counters', () => {
  it('round-trip: per (channel, bot) counts and the reply times', () => {
    store.saveLimiter({ exchanges: [{ channelId: '600', botId: '77', count: 3 }, { channelId: '601', botId: '78', count: 1 }], replies: [10 * H, 10 * H + 5] });
    const s = store.loadLimiter(10 * H + 10);
    expect(s.exchanges).toEqual(expect.arrayContaining([{ channelId: '600', botId: '77', count: 3 }, { channelId: '601', botId: '78', count: 1 }]));
    expect(s.replies).toEqual([10 * H, 10 * H + 5]);
  });

  it('the hourly window is only what is still inside the hour', () => {
    store.saveLimiter({ exchanges: [], replies: [1 * H, 5 * H + 1, 5 * H + 2] });
    expect(store.loadLimiter(6 * H).replies).toEqual([5 * H + 1, 5 * H + 2]);
  });
});

describe('BotLimiter over the store: a restart keeps the counts and the hour', () => {
  const limits = () => ({ exchange: 2, hourly: 3 });
  const persistence = (now: () => number) => ({ load: () => store.loadLimiter(now()), save: (s: any) => store.saveLimiter(s) });

  it('the per-(channel, bot) cap holds across a new limiter', () => {
    let t = 0;
    const a = new BotLimiter(limits, () => t, persistence(() => t));
    a.recordReply('600', '77'); a.recordReply('600', '77');
    const b = new BotLimiter(limits, () => t, persistence(() => t));
    expect(b.canReply('600', '77')).toBe(false);
    expect(b.canReply('600', '78')).toBe(true);
  });

  it('the hourly total holds across a new limiter, and ages out with the clock', () => {
    let t = 10 * H;
    const a = new BotLimiter(limits, () => t, persistence(() => t));
    a.recordReply('600', '1'); a.recordReply('601', '2'); a.recordReply('602', '3');
    expect(new BotLimiter(limits, () => t, persistence(() => t)).canReply('603', '4')).toBe(false);
    t += H + 1;
    expect(new BotLimiter(limits, () => t, persistence(() => t)).canReply('603', '4')).toBe(true);
  });

  it('a fresh human message resets the channel, and the reset is kept too', () => {
    const t = 0;
    const a = new BotLimiter(limits, () => t, persistence(() => t));
    a.recordReply('600', '77'); a.recordReply('600', '77');
    a.humanMessage('600');
    expect(new BotLimiter(limits, () => t, persistence(() => t)).canReply('600', '77')).toBe(true);
  });

  it('without persistence it is the in-memory limiter it always was', () => {
    const a = new BotLimiter(limits);
    a.recordReply('600', '77'); a.recordReply('600', '77');
    expect(a.canReply('600', '77')).toBe(false);
  });
});
