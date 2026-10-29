// Which lane a message belongs to, decided at intake and by CHANNEL (docs/DISCORD-PLAN.md, "The shape").
//
//   owner   iff the message is in discord.owner.channel_id AND from discord.owner.user_id. The owner
//           channel ignores every other user and every bot, silently, and never falls through to public.
//   public  everything else, and only when: public.enabled, not paused, a guild (never a DM), the guild
//           is listed, no webhook, not a bot (unless `capped` and within the caps), the author and
//           thread are not on the exclusions file, and she is addressed (an @mention, an allowlisted
//           role, or a reply to one of her messages), and for a bot, her replies to it are under the caps.
//   ignored anything else: no answer, and nothing is logged (an unlisted guild's id is never written down).
//
// The decision is pure: it takes plain data, so it is tested without discord.js. Pairings, a DB
// allowlist of users or guilds, and the owner's id in a public room change none of it.

import { statSync } from 'node:fs';
import { readOwnOrApp } from '../../tenancy/own-files.js';
import { contentStamp } from './stamp.js';

export type Lane = 'owner' | 'public';

/** What intake needs to know about a message. Built from a discord.js Message in index.ts. */
export interface IntakeMessage {
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorBot: boolean;
  webhookId: string | null;
  /** The channel is a thread: channelId is the thread's id, parentId the channel it hangs off. */
  isThread: boolean;
  parentId: string | null;
  /** An explicit @mention of her user (not @everyone or @here). */
  mentionsBot: boolean;
  mentionedRoleIds: string[];
  /** A reply to one of her messages. */
  repliesToBot: boolean;
}

export interface Exclusions {
  users: Set<string>;
  threads: Set<string>;
  channels: Set<string>;
}

export interface IntakeContext {
  botUserId: string;
  ownerUserId: string;
  ownerChannelId: string;
  publicEnabled: boolean;
  paused: boolean;
  guildIds: string[];
  /** Roles that count as addressing her. */
  roleIds: string[];
  bots: 'never' | 'capped';
  /** The exclusions file, read now. Throws ExclusionsError when it cannot be had: the public lane is then silent. */
  exclusions: () => Exclusions;
  limiter: BotLimiter;
}

export type Intake = { lane: Lane } | { lane: null; reason: string };

const ignore = (reason: string): Intake => ({ lane: null, reason });

export function classify(m: IntakeMessage, c: IntakeContext): Intake {
  if (m.authorId === c.botUserId) return ignore('self');

  // The owner channel: this user, and only this user. Nobody and nothing else is heard here.
  if (c.ownerChannelId && m.channelId === c.ownerChannelId) {
    if (m.authorBot || m.webhookId) return ignore('owner-channel-bot');
    if (c.ownerUserId && m.authorId === c.ownerUserId) return { lane: 'owner' };
    return ignore('owner-channel-other');
  }

  // Everything else is the public lane, and the public lane is closed unless every gate is open.
  if (!c.publicEnabled) return ignore('public-off');
  if (c.paused) return ignore('paused');
  if (!m.guildId) return ignore('dm');
  if (!c.guildIds.includes(m.guildId)) return ignore('guild-not-listed');
  if (m.webhookId) return ignore('webhook');
  if (m.authorBot && c.bots !== 'capped') return ignore('bot');

  let ex: Exclusions;
  try { ex = c.exclusions(); } catch { return ignore('exclusions-unavailable'); }
  if (isExcluded(ex, m)) return ignore('excluded');

  // A fresh human message, addressed to her or not, starts the bot exchange counts over.
  if (!m.authorBot) c.limiter.humanMessage(m.channelId);

  const addressed = m.mentionsBot || m.repliesToBot || m.mentionedRoleIds.some((r) => c.roleIds.includes(r));
  if (!addressed) return ignore('not-addressed');

  // The caps count her REPLIES (recordReply, once one went out), so a message that gets no answer uses none.
  if (m.authorBot && !c.limiter.canReply(m.channelId, m.authorId)) return ignore('bot-cap');
  return { lane: 'public' };
}

/** A listed user, or a listed place: the message's own channel or thread, or the channel a thread hangs
 *  off. `channel:` and `thread:` are one list of place ids, so a thread id given as `channel:` (or a
 *  channel id given as `thread:`) excludes just the same, and `channel:<id>` covers every thread under it. */
export function isExcluded(ex: Exclusions, m: Pick<IntakeMessage, 'authorId' | 'channelId' | 'isThread' | 'parentId'>): boolean {
  if (ex.users.has(m.authorId)) return true;
  const listed = (id: string | null | undefined) => !!id && (ex.channels.has(id) || ex.threads.has(id));
  return listed(m.channelId) || (m.isThread && listed(m.parentId));
}

// ── bots: capped ───────────────────────────────────────────────────────────────

/** Where the limiter keeps its counters between runs of the process (queues.ts). */
export interface LimiterPersistence {
  load(now: number): { exchanges: Array<{ channelId: string; botId: string; count: number }>; replies: number[] };
  save(state: { exchanges: Array<{ channelId: string; botId: string; count: number }>; replies: number[] }): void;
}

/** Per (channel, bot) cap on HER REPLIES, and an hourly total of replies. Messages that reach her are not counted:
 *  only a reply that was sent is (recordReply). With a persistence the counters survive a restart: the per-bot counts as
 *  they stood, and the hourly window as the times of the replies still inside the hour. */
export class BotLimiter {
  private exchanges = new Map<string, number>();
  private hour: number[] = [];

  constructor(
    private readonly limits: () => { exchange: number; hourly: number },
    private readonly now: () => number = Date.now,
    private readonly persistence?: LimiterPersistence,
  ) {
    if (persistence) {
      try {
        const s = persistence.load(now());
        for (const e of s.exchanges) this.exchanges.set(`${e.channelId}:${e.botId}`, e.count);
        this.hour = [...s.replies];
      } catch (err) {
        console.error('[Discord] Could not load the bot exchange counters; starting them over:', (err as Error)?.name || 'error');
      }
    }
  }

  /** Whether she may answer `botId` in `channelId` now. Counts nothing. */
  canReply(channelId: string, botId: string): boolean {
    const { exchange, hourly } = this.limits();
    const t = this.now();
    this.hour = this.hour.filter((x) => t - x < 3_600_000);
    if (this.hour.length >= hourly) return false;
    return (this.exchanges.get(`${channelId}:${botId}`) ?? 0) < exchange;
  }

  /** She replied to `botId` in `channelId`: count it, against both the exchange and the hour. */
  recordReply(channelId: string, botId: string): void {
    const key = `${channelId}:${botId}`;
    this.exchanges.set(key, (this.exchanges.get(key) ?? 0) + 1);
    this.hour.push(this.now());
    this.save();
  }

  /** A fresh human message in the channel: every bot's exchange count there starts over. */
  humanMessage(channelId: string): void {
    let changed = false;
    for (const key of [...this.exchanges.keys()]) if (key.startsWith(`${channelId}:`)) { this.exchanges.delete(key); changed = true; }
    if (changed) this.save();
  }

  private save(): void {
    if (!this.persistence) return;
    const t = this.now();
    this.hour = this.hour.filter((x) => t - x < 3_600_000);
    try {
      this.persistence.save({
        exchanges: [...this.exchanges].map(([key, count]) => { const i = key.indexOf(':'); return { channelId: key.slice(0, i), botId: key.slice(i + 1), count }; }),
        replies: this.hour,
      });
    } catch (err) {
      console.error('[Discord] Could not save the bot exchange counters:', (err as Error)?.name || 'error');
    }
  }
}

// ── the exclusions file ────────────────────────────────────────────────────────

export type ExclusionsErrorKind = 'missing' | 'malformed' | 'refused' | 'unreadable';

export class ExclusionsError extends Error {
  constructor(message: string, readonly kind: ExclusionsErrorKind) {
    super(message);
    this.name = 'ExclusionsError';
  }
}

/** Lines `user:<id>`, `thread:<id>`, `channel:<id>`; `#` comments (also after an entry) and blank lines.
 *  Anything else throws, naming the line number and never repeating it. An empty file excludes nobody. */
export function parseExclusions(text: string): Exclusions {
  const out: Exclusions = { users: new Set(), threads: new Set(), channels: new Set() };
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const m = /^(user|thread|channel):(\d{1,25})$/i.exec(line);
    if (!m) throw new ExclusionsError(`line ${i + 1} of the exclusions file is not user:<id>, thread:<id> or channel:<id>`, 'malformed');
    const kind = m[1].toLowerCase();
    (kind === 'user' ? out.users : kind === 'thread' ? out.threads : out.channels).add(m[2]);
  }
  return out;
}

export type ExclusionsStatus = { state: 'loaded' } | { state: 'failed'; kind: ExclusionsErrorKind };

/** The exclusions file, re-read when its content changes. Missing or malformed throws. */
export class ExclusionSource {
  private cached: { path: string; stamp: string; value: Exclusions } | null = null;

  constructor(private readonly opts: { path: () => string }) {}

  get(): Exclusions {
    const path = this.opts.path();
    if (!path) throw new ExclusionsError('the exclusions file has no usable path (refused, or unset)', 'refused');
    try { statSync(path); }
    catch (e) {
      this.cached = null;
      const code = (e as NodeJS.ErrnoException).code;
      throw new ExclusionsError(`cannot read the exclusions file (${code || 'error'})`, code === 'ENOENT' ? 'missing' : 'unreadable');
    }
    // Content, not a stat stamp: a same-size edit that keeps the mtime leaves every stat field alone on Windows.
    let stamp: string;
    try { stamp = contentStamp(path); }
    catch (e) { this.cached = null; throw new ExclusionsError(`cannot read the exclusions file (${(e as NodeJS.ErrnoException).code || 'error'})`, 'unreadable'); }
    if (this.cached && this.cached.path === path && this.cached.stamp === stamp) return this.cached.value;
    this.cached = null;
    let text: string;
    try { text = readOwnOrApp(path); }
    catch (e) { throw new ExclusionsError(`cannot read the exclusions file (${(e as NodeJS.ErrnoException).code || 'error'})`, 'unreadable'); }
    const value = parseExclusions(text);
    this.cached = { path, stamp, value };
    return value;
  }

  status(): ExclusionsStatus {
    try { this.get(); return { state: 'loaded' }; }
    catch (e) { return { state: 'failed', kind: e instanceof ExclusionsError ? e.kind : 'unreadable' }; }
  }
}
