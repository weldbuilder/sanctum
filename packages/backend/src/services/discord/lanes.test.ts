// The lane decision (docs/DISCORD-PLAN.md, "The shape"): by CHANNEL, not by user id. Owner iff the
// owner channel AND the owner user. Everything else is public, and the public lane is closed unless
// public.enabled, the guild is listed, she is addressed, and nothing about the author rules it out.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeDiscordConfig } from '../../config.js';
import { exclusionsStatus } from './intake.js';
import { BotLimiter, ExclusionSource, ExclusionsError, classify, parseExclusions, type Exclusions, type IntakeContext, type IntakeMessage } from './lanes.js';

const BOT = '900';
const OWNER = '111';
const OWNER_CH = '222';
const GUILD = '500';

const msg = (over: Partial<IntakeMessage> = {}): IntakeMessage => ({
  channelId: '600',
  guildId: GUILD,
  authorId: '333',
  authorBot: false,
  webhookId: null,
  isThread: false,
  parentId: null,
  mentionsBot: true,
  mentionedRoleIds: [],
  repliesToBot: false,
  ...over,
});

function ctx(over: Partial<IntakeContext> = {}): IntakeContext {
  const empty: Exclusions = { users: new Set(), threads: new Set(), channels: new Set() };
  return {
    botUserId: BOT,
    ownerUserId: OWNER,
    ownerChannelId: OWNER_CH,
    publicEnabled: true,
    paused: false,
    guildIds: [GUILD],
    roleIds: ['700'],
    bots: 'never',
    exclusions: () => empty,
    limiter: new BotLimiter(() => ({ exchange: 4, hourly: 20 })),
    ...over,
  };
}

const lane = (m: IntakeMessage, c: IntakeContext) => classify(m, c).lane;

describe('the owner lane: this channel, this user', () => {
  it('owner in the owner channel is the owner lane, mention or not', () => {
    expect(lane(msg({ channelId: OWNER_CH, authorId: OWNER, mentionsBot: false }), ctx())).toBe('owner');
  });
  it('the owner channel ignores every other user and every bot, silently', () => {
    expect(lane(msg({ channelId: OWNER_CH, authorId: '333' }), ctx())).toBeNull();
    expect(lane(msg({ channelId: OWNER_CH, authorId: '333', authorBot: true }), ctx({ bots: 'capped' }))).toBeNull();
    expect(lane(msg({ channelId: OWNER_CH, authorId: OWNER, authorBot: true }), ctx())).toBeNull();
    expect(lane(msg({ channelId: OWNER_CH, authorId: '333', webhookId: 'w1' }), ctx())).toBeNull();
  });
  it('the owner channel never falls through to the public lane, even when public is on and the guild is listed', () => {
    const c = ctx({ guildIds: [GUILD] });
    expect(lane(msg({ channelId: OWNER_CH, authorId: '333', guildId: GUILD, mentionsBot: true }), c)).toBeNull();
  });
  it('the owner posting anywhere else is public like anyone else', () => {
    expect(lane(msg({ authorId: OWNER, channelId: '600' }), ctx())).toBe('public');
    expect(lane(msg({ authorId: OWNER, channelId: '600' }), ctx({ publicEnabled: false }))).toBeNull();
    expect(lane(msg({ authorId: OWNER, channelId: '600', guildId: '999' }), ctx())).toBeNull();
  });
  it('an unset owner channel or user never matches', () => {
    expect(lane(msg({ channelId: OWNER_CH, authorId: OWNER }), ctx({ ownerChannelId: '' }))).toBe('public');
    expect(lane(msg({ channelId: OWNER_CH, authorId: OWNER }), ctx({ ownerUserId: '' }))).toBeNull();
  });
  it('paused does not reach the owner lane', () => {
    expect(lane(msg({ channelId: OWNER_CH, authorId: OWNER }), ctx({ paused: true }))).toBe('owner');
  });
  it('her own messages are ignored everywhere', () => {
    expect(lane(msg({ channelId: OWNER_CH, authorId: BOT }), ctx())).toBeNull();
    expect(lane(msg({ authorId: BOT }), ctx())).toBeNull();
  });
});

describe('the public lane is closed unless every gate is open', () => {
  it('public off: nothing, whatever pairing or an allowlist in the DB says', () => {
    expect(lane(msg(), ctx({ publicEnabled: false }))).toBeNull();
  });
  it('paused closes it at intake', () => {
    expect(lane(msg(), ctx({ paused: true }))).toBeNull();
  });
  it('DMs are never handled', () => {
    expect(lane(msg({ guildId: null }), ctx())).toBeNull();
    expect(lane(msg({ guildId: null, authorId: OWNER }), ctx())).toBeNull();
  });
  it('an unlisted guild is ignored', () => {
    expect(lane(msg({ guildId: '999' }), ctx())).toBeNull();
    expect(lane(msg(), ctx({ guildIds: [] }))).toBeNull();
  });
  it('a listed guild, addressed, is public', () => {
    expect(lane(msg(), ctx())).toBe('public');
  });
  it('any message with a webhookId gets no answer (PluralKit, Tupperbox), bots capped or not', () => {
    expect(lane(msg({ webhookId: 'w1' }), ctx())).toBeNull();
    expect(lane(msg({ webhookId: 'w1', authorBot: true }), ctx({ bots: 'capped' }))).toBeNull();
  });
});

describe('mention-only', () => {
  it('an explicit @mention, an allowlisted role, or a reply to her counts', () => {
    expect(lane(msg({ mentionsBot: true }), ctx())).toBe('public');
    expect(lane(msg({ mentionsBot: false, mentionedRoleIds: ['700'] }), ctx())).toBe('public');
    expect(lane(msg({ mentionsBot: false, repliesToBot: true }), ctx())).toBe('public');
  });
  it('anything else is not addressed: no mention, a role that is not on the list', () => {
    expect(lane(msg({ mentionsBot: false }), ctx())).toBeNull();
    expect(lane(msg({ mentionsBot: false, mentionedRoleIds: ['701'] }), ctx())).toBeNull();
  });
});

describe('bots', () => {
  // The caps count HER REPLIES (recordReply, called when a reply was sent), never the messages that reach her.
  const answer = (m: IntakeMessage, c: IntakeContext) => {
    const l = lane(m, c);
    if (l === 'public' && m.authorBot) c.limiter.recordReply(m.channelId, m.authorId);
    return l;
  };

  it('never: no answer to any bot, mention or not', () => {
    expect(lane(msg({ authorBot: true }), ctx({ bots: 'never' }))).toBeNull();
  });
  it('capped: a bot that addresses her is answered until her replies to it reach the cap, per (channel, bot)', () => {
    const c = ctx({ bots: 'capped', limiter: new BotLimiter(() => ({ exchange: 4, hourly: 20 })) });
    const bot = msg({ authorBot: true, authorId: '801' });
    expect([1, 2, 3, 4, 5, 6].map(() => answer(bot, c))).toEqual(['public', 'public', 'public', 'public', null, null]);
    // another bot in the same channel has its own count; the same bot elsewhere too
    expect(answer(msg({ authorBot: true, authorId: '802' }), c)).toBe('public');
    expect(answer(msg({ authorBot: true, authorId: '801', channelId: '601' }), c)).toBe('public');
  });
  it('capped: incoming messages are not counted: asking again and again without a reply never reaches the cap', () => {
    const c = ctx({ bots: 'capped', limiter: new BotLimiter(() => ({ exchange: 2, hourly: 20 })) });
    const bot = msg({ authorBot: true, authorId: '801' });
    expect(Array.from({ length: 10 }, () => lane(bot, c))).toEqual(Array(10).fill('public'));
    c.limiter.recordReply('600', '801');
    c.limiter.recordReply('600', '801');
    expect(lane(bot, c)).toBeNull();
  });
  it('capped: any fresh human message in the channel resets the reply count', () => {
    const c = ctx({ bots: 'capped', limiter: new BotLimiter(() => ({ exchange: 2, hourly: 20 })) });
    const bot = msg({ authorBot: true, authorId: '801' });
    expect([answer(bot, c), answer(bot, c), answer(bot, c)]).toEqual(['public', 'public', null]);
    // a human posts, addressed or not: the count resets
    expect(lane(msg({ mentionsBot: false }), c)).toBeNull();
    expect([answer(bot, c), answer(bot, c), answer(bot, c)]).toEqual(['public', 'public', null]);
  });
  it('capped: an unaddressed bot is not answered and does not use the cap', () => {
    const c = ctx({ bots: 'capped', limiter: new BotLimiter(() => ({ exchange: 1, hourly: 20 })) });
    expect(answer(msg({ authorBot: true, authorId: '801', mentionsBot: false }), c)).toBeNull();
    expect(answer(msg({ authorBot: true, authorId: '801' }), c)).toBe('public');
  });
  it('capped: an hourly total of replies across every bot and channel', () => {
    let now = 1_000_000;
    const limiter = new BotLimiter(() => ({ exchange: 100, hourly: 3 }), () => now);
    const c = ctx({ bots: 'capped', limiter });
    const answers = [0, 1, 2, 3, 4].map((i) => answer(msg({ authorBot: true, authorId: `80${i}`, channelId: `60${i}` }), c));
    expect(answers).toEqual(['public', 'public', 'public', null, null]);
    now += 61 * 60 * 1000; // an hour later the window has moved on
    expect(answer(msg({ authorBot: true, authorId: '809', channelId: '609' }), c)).toBe('public');
  });
  it('canReply does not count anything; recordReply does', () => {
    const l = new BotLimiter(() => ({ exchange: 1, hourly: 5 }));
    expect(l.canReply('600', '801')).toBe(true);
    expect(l.canReply('600', '801')).toBe(true);
    l.recordReply('600', '801');
    expect(l.canReply('600', '801')).toBe(false);
  });
  it('a human excluded from the exclusions file does not reset the cap', () => {
    const ex: Exclusions = { users: new Set(['333']), threads: new Set(), channels: new Set() };
    const c = ctx({ bots: 'capped', exclusions: () => ex, limiter: new BotLimiter(() => ({ exchange: 1, hourly: 20 })) });
    const bot = msg({ authorBot: true, authorId: '801' });
    expect([answer(bot, c), answer(bot, c)]).toEqual(['public', null]);
    lane(msg({ authorId: '333' }), c);
    expect(lane(bot, c)).toBeNull();
  });
});

describe('exclusions', () => {
  const ex = (text: string) => parseExclusions(text);
  const withEx = (text: string) => ctx({ exclusions: () => ex(text) });

  it('a listed user, thread or channel is not answered, even when addressed', () => {
    expect(lane(msg({ authorId: '333' }), withEx('user:333\n'))).toBeNull();
    expect(lane(msg({ channelId: '777', isThread: true, parentId: '600' }), withEx('thread:777\n'))).toBeNull();
    expect(lane(msg({ channelId: '600' }), withEx('channel:600\n'))).toBeNull();
    expect(lane(msg({ channelId: '777', isThread: true, parentId: '600' }), withEx('channel:600\n'))).toBeNull();
  });
  it('an unlisted one is answered', () => {
    expect(lane(msg({ authorId: '334' }), withEx('user:333\n'))).toBe('public');
    expect(lane(msg({ channelId: '601' }), withEx('channel:600\nthread:777\n'))).toBe('public');
    expect(lane(msg({ channelId: '778', isThread: true, parentId: '601' }), withEx('channel:600\nthread:777\n'))).toBe('public');
  });
  it('ids are treated uniformly: a thread id given as channel:, and a channel id given as thread:, both exclude', () => {
    expect(lane(msg({ channelId: '777', isThread: true, parentId: '600' }), withEx('channel:777\n'))).toBeNull();
    expect(lane(msg({ channelId: '600' }), withEx('thread:600\n'))).toBeNull();
    // and a thread under a channel that was listed as thread: is under it all the same
    expect(lane(msg({ channelId: '777', isThread: true, parentId: '600' }), withEx('thread:600\n'))).toBeNull();
  });
  it('channel:<id> also excludes every thread under that channel', () => {
    expect(lane(msg({ channelId: '801', isThread: true, parentId: '600' }), withEx('channel:600\n'))).toBeNull();
    expect(lane(msg({ channelId: '802', isThread: true, parentId: '600' }), withEx('channel:600\n'))).toBeNull();
  });
  it('a missing or malformed file makes the public lane silent, and never touches the owner lane', () => {
    const broken = ctx({ exclusions: () => { throw new ExclusionsError('missing', 'missing'); } });
    expect(lane(msg(), broken)).toBeNull();
    expect(lane(msg({ channelId: OWNER_CH, authorId: OWNER }), broken)).toBe('owner');
  });
  it('is checked before mention logic: an excluded author who is not addressed is just ignored, no cap reset', () => {
    expect(lane(msg({ authorId: '333', mentionsBot: false }), withEx('user:333\n'))).toBeNull();
  });

  describe('parseExclusions', () => {
    it('reads user:, thread:, channel:, comments and blanks', () => {
      const e = ex('# who she will not answer\n\nuser:100000000000000001\nthread:100000000000000002  # a note\n  channel:100000000000000003\nUSER:100000000000000004\n');
      expect([...e.users].sort()).toEqual(['100000000000000001', '100000000000000004']);
      expect([...e.threads]).toEqual(['100000000000000002']);
      expect([...e.channels]).toEqual(['100000000000000003']);
    });
    it('an empty or comments-only file is valid: nobody is excluded', () => {
      expect(ex('').users.size + ex('# nothing\n').channels.size).toBe(0);
    });
    it('malformed lines throw, naming the line and never repeating it', () => {
      for (const bad of ['100000000000000001', 'role:100000000000000001', 'user:', 'user:abc', 'user:12 34', 'thread:-5', '@someone']) {
        let err: unknown;
        try { ex(`user:100000000000000009\n${bad}\n`); } catch (e) { err = e; }
        expect(err, bad).toBeInstanceOf(ExclusionsError);
        expect((err as Error).message, bad).toMatch(/line 2/);
        if (bad.length > 8) expect((err as Error).message, bad).not.toContain(bad);
      }
    });
  });
});

describe('ExclusionSource', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sanctum-excl-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  let n = 0;
  const file = (body: string) => { const p = join(tmp, `e${n++}.txt`); writeFileSync(p, body); return p; };

  it('loads, reloads when the file changes, and fails by kind', () => {
    const p = file('user:100000000000000001\n');
    const src = new ExclusionSource({ path: () => p });
    expect(src.get().users.has('100000000000000001')).toBe(true);
    writeFileSync(p, 'user:100000000000000002\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(p, later, later);
    expect(src.get().users.has('100000000000000002')).toBe(true);
    expect(src.status()).toEqual({ state: 'loaded' });
    expect(new ExclusionSource({ path: () => join(tmp, 'nope.txt') }).status()).toEqual({ state: 'failed', kind: 'missing' });
    expect(new ExclusionSource({ path: () => file('nonsense\n') }).status()).toEqual({ state: 'failed', kind: 'malformed' });
    expect(new ExclusionSource({ path: () => '' }).status()).toEqual({ state: 'failed', kind: 'refused' });
  });
});

describe('config: public.role_ids', () => {
  it('reads the allowlisted role ids as strings and drops bare numbers', () => {
    const c = normalizeDiscordConfig({ public: { role_ids: ['700', 701, ' 702 '] } }, '/srv/home', { warn: () => {} });
    expect(c.public.role_ids).toEqual(['700', '702']);
    expect(normalizeDiscordConfig({}, '/srv/home', { warn: () => {} }).public.role_ids).toEqual([]);
  });
});

describe('the app\'s exclusions source (one instance, shared by intake and the status route)', () => {
  it('reports a state, never a path', () => {
    const s = exclusionsStatus();
    expect(['loaded', 'failed']).toContain(s.state);
    expect(JSON.stringify(s)).not.toMatch(/\//);
  });
});
