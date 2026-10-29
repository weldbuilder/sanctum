// What the Discord module keeps across a restart (docs/DISCORD-PLAN.md D1 and D5): the deferral queue, the follow-up
// buffer and the bot-exchange counters, in SQLite (migrations/003_discord_queues.sql).
//
// A queued batch is stored as ids and labels, never message text; the service fetches the messages again at start().
// Each save REPLACES the table with the current queue in one transaction: the queues are a handful of rows, and a
// replace can never leave a row behind that the service has dropped. Nothing here throws on a damaged row: it is skipped.

import type Database from 'better-sqlite3';
import { getDb } from '../db.js';

export interface QueuedBatchRow {
  lane: 'owner' | 'public';
  channelId: string;
  guildId: string | null;
  userId: string;
  /** Oldest first. */
  messageIds: string[];
  /** The speaker's label, for the expiry line when the messages cannot be fetched any more. */
  who: string;
  /** How many messages the batch held. */
  count: number;
}

export interface DeferralRow extends QueuedBatchRow { queuedAt: number }
export interface FollowUpRow extends QueuedBatchRow { key: string }

export interface LimiterState {
  exchanges: Array<{ channelId: string; botId: string; count: number }>;
  /** Epoch ms of each of her replies to a bot. */
  replies: number[];
}

export interface PendingUnreact { channelId: string; messageId: string; attempts: number }

/** The key a queued row's restore attempts are kept under. */
export const attemptKey = (queue: 'deferral' | 'followup', messageIds: string[]): string => `${queue}:${JSON.stringify(messageIds)}`;

const HOUR_MS = 3_600_000;

const ids = (raw: unknown): string[] | null => {
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && /^\d{1,25}$|^[\w-]{1,64}$/.test(x)) ? v : null;
  } catch { return null; }
};

const toBatch = (r: any): QueuedBatchRow | null => {
  const messageIds = ids(r.message_ids);
  if (!messageIds || (r.lane !== 'owner' && r.lane !== 'public')) return null;
  return { lane: r.lane, channelId: String(r.channel_id), guildId: r.guild_id == null ? null : String(r.guild_id), userId: String(r.user_id), messageIds, who: String(r.who ?? ''), count: Number(r.msg_count) || messageIds.length };
};

export class DiscordQueueStore {
  constructor(private readonly db: () => Database.Database = () => getDb()) {}

  saveDeferrals(rows: DeferralRow[]): void {
    const db = this.db();
    const ins = db.prepare('INSERT INTO discord_deferrals (lane, channel_id, guild_id, user_id, message_ids, who, msg_count, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      db.prepare('DELETE FROM discord_deferrals').run();
      for (const r of rows) ins.run(r.lane, r.channelId, r.guildId, r.userId, JSON.stringify(r.messageIds), r.who, r.count, r.queuedAt);
    })();
  }

  loadDeferrals(): DeferralRow[] {
    const out: DeferralRow[] = [];
    for (const r of this.db().prepare('SELECT * FROM discord_deferrals ORDER BY id').all() as any[]) {
      const b = toBatch(r);
      if (b) out.push({ ...b, queuedAt: Number(r.queued_at) });
    }
    return out;
  }

  saveFollowUps(rows: FollowUpRow[]): void {
    const db = this.db();
    const ins = db.prepare('INSERT INTO discord_followups (queue_key, lane, channel_id, guild_id, user_id, message_ids, who, msg_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      db.prepare('DELETE FROM discord_followups').run();
      for (const r of rows) ins.run(r.key, r.lane, r.channelId, r.guildId, r.userId, JSON.stringify(r.messageIds), r.who, r.count);
    })();
  }

  loadFollowUps(): FollowUpRow[] {
    const out: FollowUpRow[] = [];
    for (const r of this.db().prepare('SELECT * FROM discord_followups ORDER BY id').all() as any[]) {
      const b = toBatch(r);
      if (b) out.push({ ...b, key: String(r.queue_key) });
    }
    return out;
  }

  /** How many restores have failed for each queued row, by attemptKey(). Replaced whole on each save. */
  loadRestoreAttempts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.db().prepare('SELECT queue, message_ids, attempts FROM discord_restore_attempts').all() as any[]) {
      const n = Number(r.attempts);
      if (Number.isFinite(n) && n > 0) out.set(`${r.queue}:${r.message_ids}`, n);
    }
    return out;
  }

  saveRestoreAttempts(attempts: Map<string, number>): void {
    const db = this.db();
    const ins = db.prepare('INSERT INTO discord_restore_attempts (queue, message_ids, attempts) VALUES (?, ?, ?)');
    db.transaction(() => {
      db.prepare('DELETE FROM discord_restore_attempts').run();
      for (const [key, n] of attempts) {
        const i = key.indexOf(':');
        ins.run(key.slice(0, i), key.slice(i + 1), n);
      }
    })();
  }

  loadPendingUnreacts(): PendingUnreact[] {
    return (this.db().prepare('SELECT channel_id, message_id, attempts FROM discord_pending_unreact').all() as any[])
      .map((r) => ({ channelId: String(r.channel_id), messageId: String(r.message_id), attempts: Number(r.attempts) || 0 }));
  }

  /** Replace the pending list. */
  savePendingUnreacts(list: PendingUnreact[]): void {
    const db = this.db();
    const ins = db.prepare('INSERT OR REPLACE INTO discord_pending_unreact (channel_id, message_id, attempts) VALUES (?, ?, ?)');
    db.transaction(() => {
      db.prepare('DELETE FROM discord_pending_unreact').run();
      for (const p of list) ins.run(p.channelId, p.messageId, p.attempts);
    })();
  }

  saveLimiter(state: LimiterState): void {
    const db = this.db();
    const ex = db.prepare('INSERT INTO discord_bot_exchanges (channel_id, bot_id, count) VALUES (?, ?, ?)');
    const rep = db.prepare('INSERT INTO discord_bot_replies (at) VALUES (?)');
    db.transaction(() => {
      db.prepare('DELETE FROM discord_bot_exchanges').run();
      db.prepare('DELETE FROM discord_bot_replies').run();
      for (const e of state.exchanges) ex.run(e.channelId, e.botId, e.count);
      for (const at of state.replies) rep.run(at);
    })();
  }

  /** The counters as they stand at `now`: replies older than the hour are not part of the window any more. */
  loadLimiter(now: number = Date.now()): LimiterState {
    const db = this.db();
    const exchanges = (db.prepare('SELECT channel_id, bot_id, count FROM discord_bot_exchanges').all() as any[])
      .map((r) => ({ channelId: String(r.channel_id), botId: String(r.bot_id), count: Number(r.count) }))
      .filter((e) => Number.isFinite(e.count) && e.count > 0);
    const replies = (db.prepare('SELECT at FROM discord_bot_replies ORDER BY at').all() as any[])
      .map((r) => Number(r.at))
      .filter((at) => Number.isFinite(at) && now - at < HOUR_MS);
    return { exchanges, replies };
  }
}
