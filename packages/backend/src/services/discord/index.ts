// DiscordService — Gateway listener that routes Discord messages through AgentService.
//
// Two lanes that never touch (docs/DISCORD-PLAN.md). The lane is decided at intake, by CHANNEL
// (lanes.ts): the owner channel and the owner user are the owner lane, everything else is the public
// lane, and the public lane is closed unless public.enabled, the guild is listed, she is addressed,
// and the exclusions file loads. Nothing but the lane rules (lanes.ts) admits anyone.
//
// The owner lane is a Sanctum turn in one stable thread. The public lane is NOT: it is one isolated,
// read-only run per message with a file transcript (public-runtime.ts, public-transcript.ts), and it
// never saves a message, makes a thread, broadcasts, pushes or touches memory.

import {
  Client,
  GatewayIntentBits,
  Events,
} from 'discord.js';
import type { Message as DiscordMessage, TextChannel } from 'discord.js';
import crypto from 'crypto';
import { MessageDebouncer } from './debouncer.js';
import { buildRulesContext } from './rules.js';
import { getDiscordConfig } from './config.js';
import { formatChannelHistory } from './utils.js';
import { resolveMentions } from './mentions.js';
import { DiscordQueueStore, attemptKey, type DeferralRow, type FollowUpRow, type PendingUnreact, type QueuedBatchRow } from './queues.js';
import { attachmentKind, ingestOwnerAttachments, type DiscordAttachmentLike } from './attachments.js';
import { saveFile } from '../files.js';
import { sendGated, sendTyping, logGateAtBoot, wordGateInspect } from './send.js';
import { replyWithRetry, withheldNotice } from './retry.js';
import { runGatedTurn } from './turn.js';
import { BotLimiter, classify, isExcluded, type Exclusions, type IntakeContext, type IntakeMessage, type Lane } from './lanes.js';
import { resolveOwnerThread, type ThreadStore } from './threads.js';
import { runPublicTurn, PublicRunError } from './public-runtime.js';
import { publicTranscript } from './public-transcript.js';
import { bodyLine, speakerLabel, type PublicSpeaker } from './speaker.js';
import { errorClass } from '../error-class.js';
import { logEvent } from '../logs.js';
import { announceMissingWords } from './upgrade.js';
import { exclusionSource } from './intake.js';
import { publicHarnessSupported } from './harness.js';
import type { MessageBatch } from './types.js';
import type { AgentService } from '../agent.js';
import { postSystemLine } from '../system-line.js';
import { noteDiscordSendOk } from './failure-alert.js';
import { createMessage, createThread, getThread, ensureDailyThread, getConfig, setConfig, updateThreadActivity, countThreadsWithPrefix } from '../db.js';
import { getBotToken } from '../bot-token.js';
import { getSanctumConfig } from '../../config.js';
import { bindCurrentTenant, tenantLocal } from '../../tenancy/context.js';
import type { registry as registryInstance } from '../ws.js';

type ConnectionRegistry = typeof registryInstance;

// Module-level activity tracker — records last message per Discord user
interface ActivityEntry {
  name: string;
  lastSeen: number;
  channelId: string;
}

// (Tenant mode: one map per tenant, so one tenant's owner activity is never read under another.)
const recentActivityLocal = tenantLocal(() => new Map<string, ActivityEntry>());

export function getDiscordActivity(): Map<string, ActivityEntry> {
  return recentActivityLocal.get();
}

/** A merged follow-up batch holds at most this many messages or characters; beyond that, another batch queues behind it. */
const FOLLOW_UP_MAX_MESSAGES = 20;
const FOLLOW_UP_MAX_CHARS = 8000;
/** A queued row whose messages cannot be fetched at boot (Discord unreachable) is kept and tried again at the next
 *  restore; at the third failed restore it is dropped, with the owner line. */
const MAX_RESTORE_ATTEMPTS = 3;
/** The restore at start() is over within this long, whatever Discord does; one fetch in it takes at most RESTORE_FETCH_MS. */
const RESTORE_TOTAL_MS = 30_000;
const RESTORE_FETCH_MS = 10_000;
/** The backstop for the total bound waits this much longer than the deadline the steps themselves keep to. */
const RESTORE_GRACE_MS = 250;
/** An hourglass that could not be taken off is tried again at this many starts, then given up on. */
const MAX_UNREACT_ATTEMPTS = 3;

/** True when a failed Discord fetch is worth trying again later. Only an explicit answer that the thing is gone (Unknown
 *  Message, Unknown Channel, Missing Access or Permissions, a 403 or a 404) is not: a timeout or abort, a network error, a
 *  5xx, a rate limit and anything unrecognised are transient. A row is lost to a restore only when Discord says so. */
function isTransientFetchError(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; httpStatus?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof e?.code === 'number' ? e.code : Number.NaN;
  const status = Number(e?.status ?? e?.httpStatus);
  const text = String(e?.message ?? '');
  if ([10003, 10008, 50001, 50013].includes(code) || status === 403 || status === 404 || /unknown (channel|message)|missing (access|permissions)/i.test(text)) return false;
  return true;
}

/** One restore: the rows read at the start, and what became of each. */
interface RestoreRun {
  /** The service generation it began under. */
  gen: number;
  deadline: number;
  /** Set when the restore is over (or abandoned): whatever is still running from it does nothing more. */
  dead: boolean;
  concluded: boolean;
  timedOut: boolean;
  /** The saved state was read; without it nothing is written. */
  loaded: boolean;
  deferrals: DeferralRow[];
  followUps: FollowUpRow[];
  /** Rows looked at (restored, carried, expired, lost or dropped); the others were never reached. */
  done: Set<QueuedBatchRow>;
  /** Rows that now live in memory somewhere persisted separately (the live queue or the carried rows). */
  settled: Set<QueuedBatchRow>;
  restored: Map<string, MessageBatch[]>;
  attempts: Map<string, number>;
  nextAttempts: Map<string, number>;
  expired: DeferralRow[];
  lost: number;
  notOwner: number;
}

/** What fetching a queued row's messages came to: the batch, or nothing (and whether trying again later could help). */
type Fetched = { batch: MessageBatch; transient?: undefined; cutByDeadline?: undefined } | { batch?: undefined; transient: boolean; cutByDeadline?: boolean };

export class DiscordService {
  private client: Client;
  private debouncer: MessageDebouncer;
  private agentService: AgentService;
  private registry: ConnectionRegistry;
  // The sending buffer (audit hole D1): while a run is active for a key, new batches wait here instead of being
  // dropped. The key is (lane, channel, user) for the public lane and the channel alone for the owner lane.
  // Nothing is dropped while the process lives, and the waiting batches are kept in SQLite (queues.ts) and put back at start().
  private running = new Set<string>();
  // Batches waiting behind a running one, in order. Follow-ups merge into the LAST waiting batch until it is full
  // (FOLLOW_UP_MAX_MESSAGES / FOLLOW_UP_MAX_CHARS); the next then queues behind it.
  private followUps = new Map<string, { batches: MessageBatch[]; timer: ReturnType<typeof setTimeout> | null }>();
  private started = false;
  /** True while start() is putting the queues back. Only the keys in `restoringKeys` (those with saved rows) wait behind the
   *  restored batches; every other key runs as usual. */
  private restoring = false;
  private restoringKeys = new Set<string>();
  /** Bumped by every start() and stop(): a restore (or a login) that began under an older number was stopped, and does nothing more. */
  private generation = 0;
  /** The restore in progress, or null. */
  private restoreRun: RestoreRun | null = null;
  /** The whole restore is time-boxed, and so is each fetch in it: a Discord that never answers cannot hold the lanes. */
  private restoreTotalMs = RESTORE_TOTAL_MS;
  private restoreFetchMs = RESTORE_FETCH_MS;
  /** Rows whose messages could not be fetched at boot (a transient failure): kept in SQLite, tried again at the next restore. */
  private carriedDeferrals: DeferralRow[] = [];
  private carriedFollowUps: FollowUpRow[] = [];
  /** Failed restores per carried row (attemptKey), kept in SQLite. */
  private restoreAttempts = new Map<string, number>();
  /** Hourglasses that could not be taken off; the next start takes them off. */
  private pendingUnreacts: PendingUnreact[] = [];
  /** How long to wait for the message a reply points at. */
  private replyFetchTimeoutMs = 2000;
  /** Once-per-kind warnings (the exclusionsWarned pattern): the legacy setting, and the like. */
  private warnedOnce = new Set<string>();

  // Intake: the bot exchange caps (kept in SQLite, so a restart does not start them over) and the exclusions file.
  private limiter: BotLimiter;
  private store: DiscordQueueStore;
  private exclusionsWarned = new Set<string>();
  private legacyPublicLogged = false;
  private harnessLogged = false;

  // Deferred queue — holds non-owner Discord batches when owner is active on web UI
  private deferredBatches: Array<{ batch: MessageBatch; queuedAt: number }> = [];
  private deferTimer: ReturnType<typeof setInterval> | null = null;

  // Stats
  private stats = {
    messagesReceived: 0,
    messagesProcessed: 0,
    deferred: 0,
    errors: 0,
    startedAt: Date.now(),
  };

  constructor(agentService: AgentService, registry: ConnectionRegistry, store: DiscordQueueStore = new DiscordQueueStore()) {
    this.agentService = agentService;
    this.registry = registry;
    this.store = store;
    this.limiter = new BotLimiter(
      () => {
        const p = getSanctumConfig().discord.public;
        return { exchange: p.bot_exchange_limit, hourly: p.bot_hourly_limit };
      },
      Date.now,
      { load: (now) => this.store.loadLimiter(now), save: (state) => this.store.saveLimiter(state) },
    );

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // DMs are never handled, so no DM intent and no partials (the plan's wizard defaults).
    this.debouncer = new MessageDebouncer();
    this.debouncer.onBatch(bindCurrentTenant(this.handleBatch.bind(this))); // (a timer's callback runs as the tenant this service was built for)

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Every handler runs as the tenant this service was built for: discord.js calls them from its own sockets and timers (a reconnect, a
    // resume), where no tenant is current, so nothing here relies on the context propagating.
    const on = (event: string, fn: (...args: any[]) => void): void => { this.client.on(event as any, bindCurrentTenant(fn)); };
    on(Events.MessageCreate, (message: DiscordMessage) => {
      const botId = this.client.user?.id;
      if (!botId) return;
      // The lane is decided here, by channel. Ignored messages are dropped without a trace: an
      // unlisted guild's id is never logged.
      const decision = classify(this.toIntake(message, botId), this.intakeContext(botId));
      if (decision.lane === null) {
        if (decision.reason === 'exclusions-unavailable') this.warnExclusionsOnce();
        return;
      }
      this.stats.messagesReceived++;
      this.debouncer.add(message, decision.lane);
    });

    on(Events.ClientReady, (c) => {
      console.log(`[Discord] Logged in as ${c.user.tag}`);
      console.log(`[Discord] Guilds: ${c.guilds.cache.size}`);
    });

    on('error', (error) => {
      console.error('[Discord] Client error:', error);
    });

    on('warn', (msg) => {
      console.warn('[Discord] Warning:', msg);
    });

    on(Events.ShardDisconnect, (event, shardId) => {
      console.error(`[Discord] Shard ${shardId} disconnected (code ${event.code})`);
    });

    on(Events.ShardReconnecting, (shardId) => {
      console.log(`[Discord] Shard ${shardId} reconnecting...`);
    });

    on(Events.ShardResume, (shardId, replayedEvents) => {
      console.log(`[Discord] Shard ${shardId} resumed (${replayedEvents} events replayed)`);
    });
  }

  private toIntake(message: DiscordMessage, botId: string): IntakeMessage {
    const ch: any = message.channel;
    const roles = message.mentions?.roles;
    return {
      channelId: message.channelId,
      guildId: message.guildId ?? null,
      authorId: message.author.id,
      authorBot: !!message.author.bot,
      webhookId: message.webhookId ?? null,
      isThread: typeof ch?.isThread === 'function' ? !!ch.isThread() : false,
      parentId: ch?.parentId ?? null,
      mentionsBot: !!message.mentions?.users?.has(botId),
      mentionedRoleIds: roles ? [...roles.keys()] : [],
      repliesToBot: message.mentions?.repliedUser?.id === botId,
    };
  }

  private intakeContext(botUserId: string): IntakeContext {
    const d = getSanctumConfig().discord;
    return {
      botUserId,
      // The Settings override wins over yaml, as everywhere else in the module.
      ownerUserId: getDiscordConfig().ownerUserId,
      ownerChannelId: d.owner.channel_id,
      // On Codex the public lane cannot run (no toolless turn): closed at intake, whatever the config says.
      publicEnabled: d.public.enabled === true && publicHarnessSupported(),
      paused: d.paused === true,
      guildIds: d.public.guild_ids,
      roleIds: d.public.role_ids,
      bots: d.public.bots,
      exclusions: () => this.loadExclusions(),
      limiter: this.limiter,
    };
  }

  /** The exclusions file, read now. A load that works clears the warnings, so a second outage is said again. */
  private loadExclusions(): Exclusions {
    const ex = exclusionSource.get();
    this.exclusionsWarned.clear();
    return ex;
  }

  /** The public lane is silent when its exclusions file is missing or malformed: say so, once per kind. */
  private warnExclusionsOnce(): void {
    const s = exclusionSource.status();
    const kind = s.state === 'failed' ? s.kind : 'unusable';
    if (this.exclusionsWarned.has(kind)) return;
    this.exclusionsWarned.add(kind);
    logEvent('discord', 'exclusions_failed', { class: kind });
    console.warn(`[Discord] the public lane is SILENT: its exclusions file is ${kind}. Fix or create exclusions.txt in the private folder (npm run setup makes one); until then nobody in a public server is answered.`);
  }

  /** Why a public batch may no longer run, or null when it still may: the config and the exclusions file may have
   *  changed since intake (a deferral can be hours, a follow-up waits for a run), and the bot caps count replies,
   *  so they are checked now too. 'excluded' is the author or place being on the list; 'closed' is everything else. */
  private publicClosedReason(batch: MessageBatch): 'closed' | 'excluded' | null {
    const d = getSanctumConfig().discord;
    if (!(d.public.enabled === true && publicHarnessSupported() && !d.paused && !!batch.guildId && d.public.guild_ids.includes(batch.guildId))) return 'closed';
    try {
      const ch: any = batch.lastMessage.channel;
      const place = { authorId: batch.userId, channelId: batch.channelId, isThread: typeof ch?.isThread === 'function' ? !!ch.isThread() : false, parentId: ch?.parentId ?? null };
      if (isExcluded(this.loadExclusions(), place)) return 'excluded';
    } catch { return 'closed'; } // the file cannot be had: the lane is silent
    if (batch.firstMessage.author.bot) {
      if (d.public.bots !== 'capped' || !this.limiter.canReply(batch.channelId, batch.userId)) return 'closed';
    }
    return null;
  }

  /** Who sent a batch, as the frame and the record name them. */
  private speakerFor(batch: MessageBatch): PublicSpeaker {
    const author = batch.firstMessage.author;
    return {
      id: author.id,
      displayName: (batch.firstMessage as any).member?.displayName ?? (author as any).globalName ?? author.username,
      username: author.username,
      bot: !!author.bot,
    };
  }

  /** A batch as it is written down for a restart: ids and a label, never text. */
  private rowOf(batch: MessageBatch): QueuedBatchRow {
    return { lane: batch.lane, channelId: batch.channelId, guildId: batch.guildId, userId: batch.userId, messageIds: batch.messages.map((m) => m.id), who: speakerLabel(this.speakerFor(batch)), count: batch.messages.length };
  }

  /** Write the queues down. A database that cannot be written is said once per failure, never thrown into a message handler. */
  private saveQueue(what: string, fn: () => void): void {
    try { fn(); }
    catch (err) {
      console.error(`[Discord] Could not save the ${what}:`, errorClass(err));
      logEvent('discord', 'queue_save_failed', { class: errorClass(err) });
    }
  }

  /** The queue as it is written down: the rows carried from a restore that could not fetch them (older), then the live ones. */
  private persistDeferrals(): void {
    this.saveQueue('deferral queue', () => this.store.saveDeferrals([...this.unrestored('deferrals'), ...this.carriedDeferrals, ...this.deferredBatches.map((e): DeferralRow => ({ ...this.rowOf(e.batch), queuedAt: e.queuedAt }))]));
  }

  private persistFollowUps(): void {
    this.saveQueue('follow-up queue', () => this.store.saveFollowUps([...this.unrestored('followUps'), ...this.carriedFollowUps, ...[...this.followUps].flatMap(([key, e]) => e.batches.map((b): FollowUpRow => ({ ...this.rowOf(b), key })))]));
  }

  /** While a restore runs, the saved rows it has not dealt with yet: every write of the queue keeps them, so a crash (or a
   *  message held meanwhile) cannot lose the rows that were not put back yet. */
  private unrestored<K extends 'deferrals' | 'followUps'>(kind: K): Array<K extends 'deferrals' ? DeferralRow : FollowUpRow> {
    const run = this.restoreRun;
    if (!run || run.concluded) return [];
    return (run[kind] as QueuedBatchRow[]).filter((r) => !run.settled.has(r)) as any;
  }

  private persistRestoreState(): void {
    this.saveQueue('restore state', () => {
      this.store.saveRestoreAttempts(this.restoreAttempts);
      this.store.savePendingUnreacts(this.pendingUnreacts);
    });
  }

  /** Remember that the hourglass on this message must come off at the next start: Discord could not be reached now. */
  private addPendingUnreact(channelId: string, messageId: string | undefined): void {
    if (!messageId || this.pendingUnreacts.some((p) => p.channelId === channelId && p.messageId === messageId)) return;
    this.pendingUnreacts.push({ channelId, messageId, attempts: 0 });
  }

  /** Who and where a public batch is, as the transcript names them. Null when it has no listed place. */
  private publicPlace(batch: MessageBatch): { speaker: PublicSpeaker; isThread: boolean; fileChannel: string; where: { guild: string; channel: string; thread?: string } } | null {
    const ch: any = batch.lastMessage.channel;
    const isThread = typeof ch?.isThread === 'function' ? !!ch.isThread() : false;
    // A thread's record goes in its parent channel's file, with the thread id beside it.
    const fileChannel: string | null = isThread ? (ch.parentId ?? null) : batch.channelId;
    if (!batch.guildId || !fileChannel) return null;
    const speaker = this.speakerFor(batch);
    return { speaker, isThread, fileChannel, where: { guild: batch.guildId, channel: fileChannel, ...(isThread ? { thread: batch.channelId } : {}) } };
  }

  /** A public batch that was accepted and is now not allowed to run. Said in the log (no ids, no text); an
   *  exclusion is also written to the channel's record as a blocked line, so the person can see it was withdrawn. */
  private dropPublic(batch: MessageBatch, reason: 'closed' | 'excluded'): void {
    console.log('[Discord] A public message was dropped: the public lane is closed to it now (off, paused, the guild is no longer listed, the author or place is excluded, or a bot cap was reached).');
    if (reason !== 'excluded') return;
    try {
      const place = this.publicPlace(batch);
      if (!place) return;
      publicTranscript.append({
        kind: 'blocked',
        who: { id: place.speaker.id, name: speakerLabel(place.speaker), bot: place.speaker.bot },
        where: place.where, reason: 'excluded', hits: [], len: batch.combinedContent.length,
      });
    } catch (err) { console.error('[Discord] Could not record a dropped message:', errorClass(err)); }
  }

  private async handleBatch(batch: MessageBatch): Promise<void> {
    const { firstMessage, lastMessage } = batch;
    const isOwner = batch.lane === 'owner';

    // Defer non-owner Discord messages when owner is actively chatting on web UI
    // This prevents Discord conversations from interrupting the owner's flow
    // Uses web-specific activity — Telegram activity should NOT trigger deferral
    if (!isOwner) {
      const ownerActiveMinutes = this.registry.minutesSinceLastUserWebActivity();
      if (ownerActiveMinutes < getDiscordConfig().ownerActiveThresholdMin) {
        this.deferredBatches.push({ batch, queuedAt: Date.now() });
        this.persistDeferrals();
        this.stats.deferred++;
        lastMessage.react('\u23F3').catch(() => {}); // hourglass — message seen but delayed
        console.log(`[Discord] Deferred message from ${firstMessage.author.username} (owner active ${ownerActiveMinutes.toFixed(1)}m ago, ${this.deferredBatches.length} in queue)`);
        return;
      }
    }

    await this._processBatch(batch);
  }

  /** True while the restore may still put saved batches back on this key: new ones wait behind them. */
  private heldByRestore(key: string): boolean {
    return this.restoring && this.restoringKeys.has(key);
  }

  private sendingKey(batch: MessageBatch): string {
    return batch.lane === 'owner' ? `owner:${batch.channelId}` : `public:${batch.channelId}:${batch.userId}`;
  }

  private async _processBatch(batch: MessageBatch, fromQueue = false): Promise<void> {
    // Paused, switched off, excluded or capped since intake (a deferred or queued batch can wait): drop it.
    if (batch.lane === 'public') {
      const closed = this.publicClosedReason(batch);
      if (closed) { this.dropPublic(batch, closed); return; }
    }
    // The owner lane is the owner's: a batch queued by someone who is no longer the owner (owner.user_id changed since)
    // does not run as the owner.
    if (batch.lane === 'owner' && batch.userId !== getDiscordConfig().ownerUserId) {
      console.log('[Discord] An owner-lane message was dropped: its sender is no longer the owner.');
      return;
    }
    // A run is going (or a follow-up is already waiting its debounce, or the queues are still being put back after a
    // restart) for this key: join the follow-up, never drop and never run two at once.
    const key = this.sendingKey(batch);
    if (!fromQueue && (this.running.has(key) || this.followUps.has(key) || this.heldByRestore(key))) { this.holdFollowUp(key, batch); return; }

    this.running.add(key);
    try {
      if (batch.lane === 'public') await this.processPublic(batch);
      else await this.processOwner(batch);
    } finally {
      this.running.delete(key);
      if (this.followUps.has(key)) this.armFollowUp(key); // what arrived meanwhile runs after a quiet moment
    }
  }

  /** Queue a batch behind the running one: merged into the last waiting batch (one batch, in order) while that one has
   *  room, else queued behind it. */
  private holdFollowUp(key: string, batch: MessageBatch): void {
    const cur = this.followUps.get(key);
    if (cur) {
      const last = cur.batches[cur.batches.length - 1];
      const fits = last.messages.length + batch.messages.length <= FOLLOW_UP_MAX_MESSAGES
        && last.combinedContent.length + 1 + batch.combinedContent.length <= FOLLOW_UP_MAX_CHARS;
      if (fits) {
        cur.batches[cur.batches.length - 1] = {
          ...last,
          messages: [...last.messages, ...batch.messages],
          combinedContent: `${last.combinedContent}\n${batch.combinedContent}`,
          lastMessage: batch.lastMessage,
          channelHistory: undefined,
        };
      } else {
        cur.batches.push(batch);
      }
    } else {
      this.followUps.set(key, { batches: [batch], timer: null });
    }
    this.persistFollowUps();
    console.log(`[Discord] A message arrived while a reply was being made; it waits its turn (${[...this.followUps.values()].reduce((n, e) => n + e.batches.length, 0)} waiting)`);
    // While the run is going nothing is scheduled: its end arms the debounce. Between runs, each message restarts it.
    if (!this.running.has(key) && !this.heldByRestore(key)) this.armFollowUp(key);
  }

  private armFollowUp(key: string): void {
    const entry = this.followUps.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const e = this.followUps.get(key);
      if (!e) return;
      e.timer = null;
      // Never start a batch on a key that has a run going (or while the queues are being put back): it waits, and the end
      // of that run (or of the restore) arms it again.
      if (this.running.has(key) || this.heldByRestore(key)) return;
      const next = e.batches.shift();
      if (e.batches.length === 0) this.followUps.delete(key); else e.timer = null; // the rest wait for this one to finish
      this.persistFollowUps();
      if (!next) return;
      this._processBatch(next, true).catch((err) => console.error('[Discord] Follow-up error:', errorClass(err)));
    }, getDiscordConfig().followUpDebounceMs);
  }

  /** The owner lane: one Sanctum turn in the owner channel's stable thread. */
  private async processOwner(batch: MessageBatch): Promise<void> {
    const { firstMessage, lastMessage, channelId, userId } = batch;
    const lane: Lane = batch.lane;

    // Track activity for relational field context (the owner only: nothing public is tracked)
    recentActivityLocal.get().set(userId, {
      name: firstMessage.author.username,
      lastSeen: Date.now(),
      channelId,
    });

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    let ownerThreadId: string | null = null;

    try {
      // Touch owner's activity: only the owner reaches this path
      this.registry.touchUserActivity();

      // Show typing indicator (refresh every 8s — Discord typing expires after 10s)
      if ('sendTyping' in lastMessage.channel) {
        await sendTyping(lastMessage.channel, lane);
      }
      typingInterval = setInterval(() => {
        if ('sendTyping' in lastMessage.channel) {
          sendTyping(lastMessage.channel, lane).catch(() => {});
        }
      }, 8000);

      console.log(`[Discord] Processing from ${firstMessage.author.username} in ${channelId}`);

      // Pre-fetch channel history (25 messages)
      try {
        const channel = lastMessage.channel;
        if ('messages' in channel) {
          // The batch being answered is its own frame, not history (hole D7): leave its messages out by id, and ask for
          // that many extra so the history is still the 25 before it.
          const ids = new Set(batch.messages.map((m) => m.id));
          const history = await (channel as TextChannel).messages.fetch({ limit: Math.min(100, 25 + ids.size) });
          const older = [...history.values()].filter((m) => !ids.has(m.id)).reverse().slice(-25);
          batch.channelHistory = formatChannelHistory(older);
        }
      } catch (err) {
        console.warn('[Discord] Could not fetch channel history:', err);
      }

      // Resolve the thread. The owner channel is ONE stable thread, created on first use.
      const channelName = (() => {
        const c = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        return c && 'name' in c ? c.name : channelId;
      })();
      const resolved = resolveOwnerThread(this.ownerThreadStore(), channelId);
      const threadId = resolved.id;
      ownerThreadId = threadId;
      const threadName = getThread(threadId)?.name ?? `#${channelName}`;
      if (resolved.legacy) console.log(`[Discord] Owner channel is using its older thread ${threadId} (kept rather than starting a second)`);

      // Attachments (hole D4): the owner's go through the existing attachment path; nothing public ever does.
      const got = await this.takeAttachments(batch);

      // Store incoming message in SQLite
      const now = new Date().toISOString();
      const incomingMsg = createMessage({
        id: crypto.randomUUID(),
        threadId,
        role: 'user',
        content: batch.combinedContent,
        contentType: 'text',
        platform: 'discord',
        metadata: {
          discordUserId: userId,
          discordUsername: firstMessage.author.username,
          discordChannelId: channelId,
          discordGuildId: batch.guildId,
          discordMessageId: lastMessage.id,
          discordLane: lane,
          ...(got.saved.length ? { attachments: got.saved.map((a) => ({ fileId: a.fileId, filename: a.filename, contentType: a.contentType, url: a.url, mimeType: a.mimeType, size: a.size })) } : {}),
        },
        createdAt: now,
      });

      updateThreadActivity(threadId, now, true);
      this.registry.broadcast({ type: 'message', message: incomingMsg });

      // Build platform context (platform info + rules + channel history)
      const platformHeader = batch.guildId
        ? `=== PLATFORM: DISCORD ===\nResponding in #${(this.client.channels.cache.get(channelId) as TextChannel)?.name || channelId} on ${this.client.guilds.cache.get(batch.guildId)?.name || batch.guildId}.`
        : `=== PLATFORM: DISCORD ===\nResponding in DM with ${firstMessage.author.username}.`;
      const platformGuidance = [
        platformHeader,
        'Discord formatting: **bold**, *italic*, `code`, ```codeblocks```, > quotes, ||spoilers||.',
        'Max message length: 2000 chars (responses auto-split at 1900).',
        'Replying to the last message in this batch.',
        'Keep responses appropriate to the platform — not as terse as Telegram, but don\'t write essays.',
      ].join('\n');

      // The message this one replies to, when it replies to one (hole D8): the same read as the public lane.
      const replyContext = await this.resolveReplyContext(batch);
      const replyBlock = replyContext
        ? `\n\n=== IN REPLY TO ===\n${replyContext.author}${replyContext.isHer ? ' (that was you)' : ''}: ${replyContext.text}`
        : '';

      const rulesContext = buildRulesContext(userId, channelId, batch.guildId);
      const historyContext = batch.channelHistory
        ? `\n\n=== RECENT CHANNEL HISTORY (last 25 messages) ===\n${batch.channelHistory}`
        : '';
      const skippedBlock = got.skipped.length
        ? `\n\n=== ATTACHMENTS NOT OPENED ===\n${got.skipped.map((s) => `${s.name} (${s.reason === 'type' ? 'only images and text or documents are taken' : s.reason === 'too_large' ? 'over the size limit' : s.reason === 'too_many' ? 'too many in one message' : 'could not be downloaded'})`).join('\n')}`
        : '';
      const platformContext = `${platformGuidance}${replyBlock}${skippedBlock}\n\n${rulesContext}${historyContext}`;

      this.stats.messagesProcessed++;

      // Run the turn with the reply held, send it through the one gated path, and only a sent reply is
      // saved or remembered. A blocked reply gets one rewrite with the reason appended (to the prompt
      // only); a second block is silence (logged by the sender).
      const outcome = await runGatedTurn({
        agent: this.agentService,
        threadId,
        content: batch.combinedContent,
        promptContent: this.frameText(batch),
        ...(got.saved.length ? { images: got.saved.map((a) => ({ fileId: a.fileId, filename: a.filename, contentType: a.contentType })) } : {}),
        threadMeta: { name: threadName, type: 'named' },
        platformContext,
        lane,
        deliver: (text) => sendGated({ kind: 'reply', message: lastMessage }, text, lane),
        onBlock: (info) => {
          console.log(`[Discord] Reply withheld in ${channelId} (lane=${lane}, attempt ${info.attempt}${info.willRetry ? ', retrying once' : ', no more tries'})`);
          // The owner is told, in the thread, in entry names only.
          this.postOwnerNotice(threadId, withheldNotice(info));
        },
      });

      if (outcome.empty && !outcome.final) {
        console.log('[Discord] Empty response from agent');
      } else if (outcome.sent) {
        noteDiscordSendOk('owner');
        console.log(`[Discord] Sent reply to ${channelId}${outcome.attempts > 1 ? ' (after one rewrite)' : ''}`);
      }

    } catch (error) {
      // An agent error is never sent as the reply. The owner gets a short line naming the class of failure
      // (no message, path or stack: the server log has the rest), and it is never handed to memory.
      console.error('[Discord] Handler error:', error);
      this.stats.errors++;
      logEvent('discord', 'reply_failed', { class: errorClass(error), lane: 'owner' });
      if (ownerThreadId) this.postSystemLine(ownerThreadId, `reply failed: ${errorClass(error)}`, { kind: 'discord_notice' });
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  /**
   * One public message: an isolated, read-only run (public-runtime.ts), her reply through the gated send,
   * and the file transcript. It saves no message, makes no thread, broadcasts nothing, pushes nothing, and
   * a failed run is silence plus an error line (a class, never text). The gate's one rewrite works as ever.
   */
  private async processPublic(batch: MessageBatch): Promise<void> {
    const { firstMessage, lastMessage, channelId, userId } = batch;
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    try {
      const place = this.publicPlace(batch);
      if (!place) return;
      const { speaker, isThread, fileChannel, where } = place;
      const author = firstMessage.author;
      const her = { id: this.client.user?.id ?? '', name: this.client.user?.username ?? 'her', bot: true };

      if ('sendTyping' in lastMessage.channel) await sendTyping(lastMessage.channel, 'public').catch(() => {});
      typingInterval = setInterval(() => {
        if ('sendTyping' in lastMessage.channel) sendTyping(lastMessage.channel, 'public').catch(() => {});
      }, 8000);
      console.log(`[Discord] Public message in ${channelId}`);
      this.stats.messagesProcessed++;

      // What the message replied to (hole D8): read once, handed to every attempt. Never an attachment.
      const replyContext = await this.resolveReplyContext(batch);

      let history: string[] | undefined;
      let sentLen = 0;
      try {
        const outcome = await replyWithRetry({
          produce: async (note) => {
            const r = await runPublicTurn(
              { guildId: batch.guildId!, channelId: fileChannel, ...(isThread ? { threadId: channelId } : {}), speaker, text: batch.combinedContent, frameText: this.frameText(batch), ...(this.attachmentKinds(batch).length ? { attachments: this.attachmentKinds(batch) } : {}), ...(replyContext ? { replyContext } : {}), history, note },
              { schedule: (fn) => this.agentService.runExclusive(fn) },
            );
            history = r.history;
            return r.text;
          },
          deliver: async (text) => {
            sentLen = text.length;
            const result = await sendGated({ kind: 'reply', message: lastMessage }, text, 'public');
            if (result.sent) publicTranscript.append({ kind: 'out', who: her, where, text, len: text.length });
            return result;
          },
          onBlock: (info) => {
            console.log(`[Discord] Public reply withheld in ${channelId} (attempt ${info.attempt}${info.willRetry ? ', retrying once' : ', no more tries'})`);
            try {
              publicTranscript.append({ kind: 'blocked', who: her, where, reason: info.result.reason, hits: info.result.entries ?? info.result.hits ?? [], len: sentLen });
            } catch (err) { console.error('[Discord] Could not record a blocked reply:', errorClass(err)); }
          },
        });
        // Only a reply that went out counts against a bot's cap.
        if (outcome.sent) noteDiscordSendOk('public');
        if (outcome.sent && author.bot) this.limiter.recordReply(channelId, userId);
      } catch (err) {
        // Silence. A PublicRunError was already recorded by the run; anything else is recorded here, class only.
        this.stats.errors++;
        // No API key for the sealed dsh run, or no identity: the adapter already said so once per process; the lane is
        // silent, not noisy, and the one line below is the one line (the transcript still gets an error line per message).
        // Either way the logs service counts it, so the Settings log viewer and the status can show it.
        if (err instanceof PublicRunError && (err.kind === 'api_key_missing' || err.kind === 'identity_missing')) logEvent('discord', err.kind, { once: true });
        else {
          console.error(`[Discord] Public run failed (${errorClass(err)})`);
          logEvent('discord', 'public_run_failed', { class: errorClass(err), lane: 'public' });
        }
        if (!(err instanceof PublicRunError)) {
          try { publicTranscript.append({ kind: 'error', who: { id: speaker.id, name: speakerLabel(speaker), bot: speaker.bot }, where, reason: errorClass(err), len: 0 }); } catch { /* nothing more to do */ }
        }
      }
    } catch (error) {
      console.error('[Discord] Public handler error:', errorClass(error));
      this.stats.errors++;
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  private attachmentList(batch: MessageBatch): DiscordAttachmentLike[] {
    return batch.messages.flatMap((m: any) => [...(m.attachments?.values?.() ?? [])] as DiscordAttachmentLike[]);
  }

  /** What kinds of attachments a batch carried: all the public lane ever learns about them. */
  private attachmentKinds(batch: MessageBatch): string[] {
    return this.attachmentList(batch).map(attachmentKind);
  }

  /** The owner's attachments, downloaded and saved by the existing path. Never throws; nothing to do is free. */
  private async takeAttachments(batch: MessageBatch) {
    const list = this.attachmentList(batch);
    if (list.length === 0) return { saved: [], skipped: [] as Array<{ name: string; reason: string }> };
    const mb = getSanctumConfig().discord.attachments?.max_mb ?? 8;
    return ingestOwnerAttachments(list, { maxBytes: mb * 1024 * 1024, save: saveFile, log: (m) => console.log(m) });
  }

  /** What the model reads for a batch: each message's mention tokens resolved from its own `mentions` (hole D9), her own
   *  mention stripped. The stored and recorded text stays as typed. */
  private frameText(batch: MessageBatch): string {
    const botId = this.client.user?.id ?? '';
    return batch.messages.map((m) => resolveMentions(m.content, (m as any).mentions, botId)).join('\n');
  }

  /**
   * The message a reply points at, as `{author, text, isHer}`, or undefined: no reference, one into another channel,
   * a fetch that fails or takes longer than the timeout. Text only: the content, flattened and capped at 500, never
   * an attachment or an embed (those are not even read). Whatever it says is untrusted, like any message.
   */
  private async resolveReplyContext(batch: MessageBatch): Promise<{ author: string; text: string; isHer: boolean } | undefined> {
    try {
      const msg: any = batch.messages.find((m: any) => m?.reference?.messageId);
      const r = msg?.reference;
      if (!r?.messageId) return undefined;
      if ((r.channelId && r.channelId !== msg.channelId) || (r.guildId && msg.guildId && r.guildId !== msg.guildId)) return undefined;
      const fetch = msg.channel?.messages?.fetch;
      if (typeof fetch !== 'function') return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ref: any = await Promise.race([
        Promise.resolve(fetch.call(msg.channel.messages, r.messageId)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.replyFetchTimeoutMs); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      const a = ref?.author;
      if (!a) return undefined;
      const speaker: PublicSpeaker = { id: a.id, displayName: ref.member?.displayName ?? a.globalName ?? a.username, username: a.username, bot: !!a.bot };
      return {
        author: speakerLabel(speaker, true),
        text: bodyLine(typeof ref.content === 'string' ? ref.content : '', 500) || '(no text)',
        isHer: !!a.id && a.id === this.client.user?.id,
      };
    } catch { return undefined; } // deleted, no access, slow: no context, and the message is answered all the same
  }

  /** A short system line in the owner's thread. Entry names only, never what a reply said. */
  private postOwnerNotice(threadId: string, text: string): void {
    // kind: withheld keeps it out of the model's history (rolling-context.ts), where it would read as the person's words.
    this.postSystemLine(threadId, text, { discordWithheld: true, kind: 'withheld' });
  }

  /** A system line in a thread, shown on the web (services/system-line.ts, shared with the identity gate). Never throws. */
  private postSystemLine(threadId: string, text: string, metadata: Record<string, unknown>): void {
    const kind = metadata.kind === 'withheld' ? 'withheld' : 'discord_notice';
    postSystemLine(threadId, text, kind, metadata, { platform: 'discord', registry: this.registry });
  }

  /** How long a deferred message may wait. `discord.deferral_hours` (default 24, 1..48) is the setting; the legacy
   *  database key `discord.deferMaxAgeMs` wins only when it is explicitly set, with one warning naming the new one. */
  private deferralMs(): number {
    const hours = getSanctumConfig().discord.deferral_hours ?? 24;
    const legacy = getDiscordConfig().deferMaxAgeMs;
    if (legacy != null) {
      if (!this.warnedOnce.has('legacy-defer')) {
        this.warnedOnce.add('legacy-defer');
        console.warn(`[Discord] the old setting discord.deferMaxAgeMs (in the settings database) is set to ${legacy} ms and still decides how long a deferred message waits. The setting is now discord.deferral_hours in sanctum.yaml (1 to 48, currently ${hours}); clear the old key so that one applies.`);
      }
      return legacy;
    }
    return hours * 3_600_000;
  }

  /** The hourglass put on a message when it was deferred, taken off again: it has left the queue. */
  private async clearHourglass(batch: MessageBatch): Promise<void> {
    try {
      const botId = this.client.user?.id;
      const reaction = (batch.lastMessage as any).reactions?.resolve?.('\u23F3');
      if (botId && reaction) await reaction.users.remove(botId);
    } catch { /* it was cosmetic */ }
  }

  /** Drop the batches that waited out the clock, never silently: the hourglass is cleared and ONE line goes to the
   *  owner thread saying how many messages from whom (never what they said). */
  private async expireDeferred(): Promise<void> {
    const ms = this.deferralMs();
    const now = Date.now();
    const expired = this.deferredBatches.filter((e) => now - e.queuedAt > ms);
    if (expired.length === 0) return;
    // The hourglass comes off BEFORE the row is deleted: a crash in between leaves a row that the next start expires
    // again, never an hourglass nobody will take off.
    for (const e of expired) await this.clearHourglass(e.batch);
    // Another sweep may have taken some while the hourglasses were coming off: only the ones still queued are ours to announce.
    const mine = expired.filter((e) => this.deferredBatches.includes(e));
    if (mine.length === 0) return;
    this.deferredBatches = this.deferredBatches.filter((e) => !mine.includes(e));
    this.persistDeferrals();
    this.announceExpiry(mine.map((e) => ({ userId: e.batch.userId, label: speakerLabel(this.speakerFor(e.batch)), n: e.batch.messages.length })), ms);
  }

  /** The one owner-thread line for deferrals that waited out the clock: counts and names, never text. */
  private announceExpiry(items: Array<{ userId: string; label: string; n: number }>, ms: number): void {
    const byWho = new Map<string, { label: string; n: number }>();
    for (const it of items) {
      const who = byWho.get(it.userId) ?? { label: it.label || 'someone', n: 0 };
      who.n += it.n;
      byWho.set(it.userId, who);
    }
    const total = [...byWho.values()].reduce((n, w) => n + w.n, 0);
    const parts = [...byWho.values()].slice(0, 5).map((w) => `${w.n} from ${w.label}`);
    if (byWho.size > 5) parts.push(`${byWho.size - 5} more people`);
    const span = ms % 3_600_000 === 0 ? `${ms / 3_600_000}-hour` : `${Math.max(1, Math.round(ms / 60_000))}-minute`;
    const text = `${total} Discord message${total === 1 ? '' : 's'} waited out the ${span} deferral and ${total === 1 ? 'was' : 'were'} not answered: ${parts.join(', ')}.`;
    console.log(`[Discord] ${total} deferred message(s) expired after ${span}`);
    this.postToOwnerThread(text, { kind: 'discord_notice', discordDeferralExpired: true });
  }

  /** One system line in the owner's thread (the daily thread when no owner channel is set). Never throws. */
  private postToOwnerThread(text: string, metadata: Record<string, unknown>): void {
    try {
      const channelId = getSanctumConfig().discord.owner.channel_id;
      const threadId = channelId ? resolveOwnerThread(this.ownerThreadStore(), channelId).id : ensureDailyThread().thread.id;
      this.postSystemLine(threadId, text, metadata);
    } catch (err) {
      console.error('[Discord] Could not post a line to the owner thread:', errorClass(err));
    }
  }

  /** True once a restore is over or was stopped (stop() or a newer start()): nothing it still has in flight may touch the service. */
  private stale(run: RestoreRun): boolean {
    return run.dead || run.gen !== this.generation;
  }

  /** `p`, but no longer than one fetch may take in this restore (and never past the restore's deadline). A timeout rejects
   *  as a timeout: the thing did not answer, which is not the same as being gone. */
  private bounded<T>(p: Promise<T>, run: RestoreRun): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const left = run.deadline - Date.now();
    const ms = Math.max(1, Math.min(this.restoreFetchMs, left));
    // A fetch the restore's own deadline starved of its budget never had a fair try: the row is "not reached", not
    // "failed". The normal budget is one fetch's, or the whole restore's when that is shorter; under half of it is starved.
    const cutByDeadline = left < Math.min(this.restoreFetchMs, this.restoreTotalMs) / 2;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('This operation was aborted: timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT', cutByDeadline })), ms);
    });
    return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** A queued batch's messages, fetched again from Discord (the queues keep ids, not text). `transient` says that nothing
   *  could be had because Discord could not be reached (a later restore may do better), not because the messages are gone.
   *  Every fetch is time-boxed by the restore. */
  private async fetchBatch(row: QueuedBatchRow, run: RestoreRun): Promise<Fetched> {
    let channel: any;
    try { channel = await this.bounded(Promise.resolve().then(() => this.client.channels.fetch(row.channelId)), run); }
    catch (err) { return { transient: isTransientFetchError(err), cutByDeadline: !!(err as any)?.cutByDeadline }; }
    if (typeof channel?.messages?.fetch !== 'function') return { transient: false };
    const messages: DiscordMessage[] = [];
    let transient = false;
    for (const id of row.messageIds) {
      try { const m = await this.bounded(Promise.resolve().then(() => channel.messages.fetch(id)), run); if (m) messages.push(m); }
      catch (err) {
        if ((err as any)?.cutByDeadline) return { transient: true, cutByDeadline: true };
        if (isTransientFetchError(err)) { transient = true; break; } // Discord is not answering: the rest would only wait as long
        /* else deleted, or no access */
      }
    }
    if (transient) return { transient: true }; // the whole row is tried again at the next restore
    if (messages.length === 0) return { transient: false };
    return { batch: { lane: row.lane, messages, channelId: row.channelId, userId: row.userId, guildId: row.guildId, combinedContent: messages.map((m) => m.content).join('\n'), firstMessage: messages[0], lastMessage: messages[messages.length - 1] } };
  }

  /** Take the hourglass off a message by id: 'done' (or the message is gone), or 'retry' when Discord could not be reached. */
  private async removeHourglassById(channelId: string, messageId: string, run: RestoreRun): Promise<'done' | 'retry'> {
    try {
      await this.bounded((async () => {
        const botId = this.client.user?.id;
        const channel: any = await this.client.channels.fetch(channelId);
        const message: any = await channel?.messages?.fetch?.(messageId);
        const reaction = message?.reactions?.resolve?.('⏳');
        if (botId && reaction) await reaction.users.remove(botId);
      })(), run);
      return 'done';
    } catch (err) { return isTransientFetchError(err) ? 'retry' : 'done'; }
  }

  /** At start(): the hourglasses that could not be taken off before (Discord was unreachable) come off now. The list was
   *  read with the rest of the saved state before anything was written. Never throws. */
  private async clearPendingUnreacts(run: RestoreRun): Promise<void> {
    const list = this.pendingUnreacts;
    if (list.length === 0) return;
    const keep: PendingUnreact[] = [];
    for (const p of list) {
      if (this.stale(run)) return;
      if (Date.now() >= run.deadline) { run.timedOut = true; keep.push(p); continue; } // not reached: kept as it was
      const result = await this.removeHourglassById(p.channelId, p.messageId, run);
      if (this.stale(run)) return;
      if (result === 'retry' && p.attempts + 1 < MAX_UNREACT_ATTEMPTS) keep.push({ ...p, attempts: p.attempts + 1 });
    }
    this.pendingUnreacts = keep;
    this.persistRestoreState();
  }

  /**
   * At start(): put the deferral queue and the follow-up buffer back from SQLite. A deferral past its clock is not put
   * back: it is announced like any expiry (from the names written down, so even when its messages are gone). One whose
   * messages cannot be fetched any more is said so, once, in the owner thread; one that could not be fetched because
   * Discord could not be reached is kept and tried again at the next restore (dropped, with that line, at the third).
   * While this runs, new batches on a key that has saved rows wait behind the restored ones (nothing starts there, so no
   * two turns run on one key); every other key runs as usual. The whole restore is time-boxed (RESTORE_TOTAL_MS, and
   * RESTORE_FETCH_MS for each fetch): a row it did not get to is kept as it was, never counted as gone.
   * Never throws: a database that cannot be read means empty queues and a log line.
   */
  private async restoreQueues(gen: number): Promise<void> {
    const run: RestoreRun = {
      gen, deadline: Date.now() + this.restoreTotalMs, dead: false, concluded: false, timedOut: false, loaded: false,
      deferrals: [], followUps: [], done: new Set(), settled: new Set(), restored: new Map(),
      attempts: new Map(), nextAttempts: new Map(), expired: [], lost: 0, notOwner: 0,
    };
    this.restoreRun = run;
    this.restoring = true;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    try {
      // All the saved state is read before anything is written: a write made earlier (the hourglass list, a held message)
      // would replace a table with an incomplete picture of it.
      try {
        run.deferrals = this.store.loadDeferrals();
        run.followUps = this.store.loadFollowUps();
        run.attempts = this.store.loadRestoreAttempts();
        this.restoreAttempts = run.attempts;
        this.pendingUnreacts = this.store.loadPendingUnreacts();
        run.loaded = true;
      } catch (err) {
        console.error('[Discord] Could not read the saved queues; starting them empty:', errorClass(err));
        logEvent('discord', 'queue_load_failed', { class: errorClass(err) });
        return;
      }
      for (const r of run.followUps) this.restoringKeys.add(r.key);
      await Promise.race([
        this.restoreQueuesNow(run),
        // Every step is time-boxed on its own; this is the backstop for one that is not.
        new Promise<void>((resolve) => { backstop = setTimeout(() => { run.timedOut = true; resolve(); }, this.restoreTotalMs + RESTORE_GRACE_MS); }),
      ]);
    } catch (err) {
      console.error('[Discord] Could not put the queues back:', errorClass(err));
    } finally {
      if (backstop) clearTimeout(backstop);
      // Stopped meanwhile: stop() already put the state away. Nothing is written, run or armed from here.
      if (run.gen !== this.generation) { run.concluded = true; run.dead = true; return; }
      this.concludeRestore(run);
      run.dead = true;
      this.restoring = false;
      this.restoringKeys.clear();
      if (this.restoreRun === run) this.restoreRun = null;
      for (const key of [...this.followUps.keys()]) if (!this.running.has(key)) this.armFollowUp(key);
    }
  }

  private async restoreQueuesNow(run: RestoreRun): Promise<void> {
    await this.clearPendingUnreacts(run);
    if (this.stale(run)) return;
    if (run.deferrals.length === 0 && run.followUps.length === 0) return;

    const ms = this.deferralMs();
    const now = Date.now();
    /** A row that could not be fetched because Discord could not be reached: kept for the next restore, or given up on at the third. */
    const retryOrLose = (queue: 'deferral' | 'followup', r: QueuedBatchRow): boolean => {
      const key = attemptKey(queue, r.messageIds);
      const n = (run.attempts.get(key) ?? 0) + 1;
      if (n < MAX_RESTORE_ATTEMPTS) { run.nextAttempts.set(key, n); return true; }
      run.lost += r.count;
      if (queue === 'deferral') this.addPendingUnreact(r.channelId, r.messageIds[r.messageIds.length - 1]); // the hourglass, if it is still there, comes off at the next start
      return false;
    };
    const outOfTime = (): boolean => {
      if (Date.now() < run.deadline) return false;
      run.timedOut = true;
      return true;
    };

    for (const r of run.deferrals) {
      if (outOfTime()) return;
      const got = await this.fetchBatch(r, run);
      if (this.stale(run)) return;
      if (got.cutByDeadline) { run.timedOut = true; return; } // the deadline, not Discord, ended this fetch: the row is kept, no attempt counted
      if (now - r.queuedAt > ms) {
        run.expired.push(r);
        if (got.batch) await this.bounded(this.clearHourglass(got.batch), run).catch(() => {}); // best effort: the message may be gone
        else if (got.transient) this.addPendingUnreact(r.channelId, r.messageIds[r.messageIds.length - 1]); // Discord was unreachable: the next start does it
        if (this.stale(run)) return;
        run.done.add(r);
        continue;
      }
      if (got.batch) {
        this.deferredBatches.push({ batch: got.batch, queuedAt: r.queuedAt });
        run.settled.add(r);
        got.batch.lastMessage.react('⏳').catch(() => {}); // seen but delayed, as before the restart
      } else if (got.transient) {
        if (retryOrLose('deferral', r)) { this.carriedDeferrals.push(r); run.settled.add(r); }
      } else run.lost += r.count;
      run.done.add(r);
    }

    const ownerUserId = getDiscordConfig().ownerUserId;
    const ownerChannelId = getSanctumConfig().discord.owner.channel_id;
    for (const r of run.followUps) {
      // An owner-lane batch is the owner's only while the owner is who queued it, in the owner channel.
      if (r.lane === 'owner' && (r.userId !== ownerUserId || r.channelId !== ownerChannelId)) { run.notOwner += r.count; run.done.add(r); continue; }
      if (outOfTime()) return;
      const got = await this.fetchBatch(r, run);
      if (this.stale(run)) return;
      if (got.cutByDeadline) { run.timedOut = true; return; } // as above: not reached, not failed
      if (got.batch) {
        const list = run.restored.get(r.key);
        if (list) list.push(got.batch); else run.restored.set(r.key, [got.batch]);
      } else if (got.transient) {
        if (retryOrLose('followup', r)) { this.carriedFollowUps.push(r); run.settled.add(r); }
      } else run.lost += r.count;
      run.done.add(r);
    }
  }

  /** The end of a restore, however it ended: put the batches back, keep the rows that were not reached (a timeout is not
   *  "gone"), write the queues down, and say what happened. Runs once. */
  private concludeRestore(run: RestoreRun): void {
    if (run.concluded) return;
    run.concluded = true;
    if (!run.loaded) return;
    const carry = (queue: 'deferral' | 'followup', r: QueuedBatchRow) => {
      const key = attemptKey(queue, r.messageIds);
      const n = run.attempts.get(key);
      if (n) run.nextAttempts.set(key, n); // not tried this time: the count stays where it was
    };
    let unreached = 0;
    for (const r of run.deferrals) if (!run.done.has(r)) { unreached++; carry('deferral', r); this.carriedDeferrals.push(r); }
    for (const r of run.followUps) if (!run.done.has(r)) { unreached++; carry('followup', r); this.carriedFollowUps.push(r); }
    // The restored batches go in FRONT of any that arrived while this ran: they are older.
    for (const [key, list] of run.restored) {
      const cur = this.followUps.get(key);
      if (cur) cur.batches = [...list, ...cur.batches]; else this.followUps.set(key, { batches: list, timer: null });
    }
    this.restoreAttempts = run.nextAttempts;
    this.persistDeferrals();
    this.persistFollowUps();
    this.persistRestoreState();
    console.log(`[Discord] Put back ${this.deferredBatches.length} deferred batch(es) and ${[...this.followUps.values()].reduce((n, e) => n + e.batches.length, 0)} waiting follow-up batch(es) after the restart`);
    if (run.timedOut) console.warn(`[Discord] Putting the queues back ran out of time (Discord was slow or silent); ${unreached} saved batch(es) were not reached and are kept, and ${this.carriedDeferrals.length + this.carriedFollowUps.length} in all are tried again at the next restart`);
    else if (this.carriedDeferrals.length + this.carriedFollowUps.length) console.warn(`[Discord] Discord could not be reached for ${this.carriedDeferrals.length + this.carriedFollowUps.length} queued batch(es); they are kept and tried again at the next restart`);
    const ms = this.deferralMs();
    if (run.expired.length) this.announceExpiry(run.expired.map((r) => ({ userId: r.userId, label: r.who, n: r.count })), ms);
    const lost = run.lost;
    if (lost) {
      const text = `${lost} Discord message${lost === 1 ? '' : 's'} waiting in the queue could not be put back after the restart (the message${lost === 1 ? ' is' : 's are'} gone or cannot be reached) and ${lost === 1 ? 'was' : 'were'} not answered.`;
      this.postToOwnerThread(text, { kind: 'discord_notice', discordQueueLost: true });
    }
    const notOwner = run.notOwner;
    if (notOwner) {
      const text = `${notOwner} Discord message${notOwner === 1 ? '' : 's'} queued by the previous owner ${notOwner === 1 ? 'was' : 'were'} dropped after the restart: the owner has changed since ${notOwner === 1 ? 'it was' : 'they were'} queued.`;
      this.postToOwnerThread(text, { kind: 'discord_notice', discordQueueOwnerChanged: true });
    }
  }

  private ownerThreadStore(): ThreadStore {
    return {
      exists: (id) => !!getThread(id),
      create: (id, name) => {
        createThread({ id, name, type: 'named', createdAt: new Date().toISOString(), sessionType: 'v1' });
        console.log(`[Discord] Created thread: ${name} (${id})`);
      },
    };
  }

  private async drainDeferredQueue(): Promise<void> {
    if (this.deferredBatches.length === 0) return;

    const config = getDiscordConfig();
    // Expiry is the only way a deferral is dropped for age, and it does not wait for the owner to go idle.
    await this.expireDeferred();
    if (this.deferredBatches.length === 0) return;

    const ownerActiveMinutes = this.registry.minutesSinceLastUserWebActivity();
    if (ownerActiveMinutes < config.ownerActiveThresholdMin) return; // Owner still active on web — keep holding

    console.log(`[Discord] Owner idle ${ownerActiveMinutes.toFixed(1)}m — draining ${this.deferredBatches.length} deferred messages`);

    // Process one at a time to avoid flooding
    while (this.deferredBatches.length > 0) {
      // Re-check owner's web activity before each batch — stop draining if they come back to web
      if (this.registry.minutesSinceLastUserWebActivity() < config.ownerActiveThresholdMin) {
        console.log(`[Discord] Owner returned — pausing drain (${this.deferredBatches.length} remaining)`);
        break;
      }
      const entry = this.deferredBatches[0];
      // The hourglass comes off BEFORE the row is deleted: a crash in between leaves a row that is put back and answered
      // at the next start, never an hourglass nobody will take off.
      await this.clearHourglass(entry.batch);
      if (this.deferredBatches[0] !== entry) continue; // an expiry sweep or another drain took it meanwhile
      this.deferredBatches.shift();
      this.persistDeferrals();
      await this._processBatch(entry.batch);
    }
  }

  async start(): Promise<void> {
    const token = getBotToken('discord');
    if (!token) {
      console.error('[Discord] no token in DB or env — gateway disabled');
      return;
    }

    logGateAtBoot();
    // The public lane needs a harness that can run a toolless turn. Say so once, not per message.
    try {
      if (getSanctumConfig().discord.public.enabled === true && !publicHarnessSupported() && !this.harnessLogged) {
        this.harnessLogged = true;
        console.warn(`[Discord] the public lane is OFF: public Discord needs dsh or Claude as the harness; Codex cannot run it without its shell tool. The owner lane is unaffected. Switch agent.provider to dsh or claude to use the public lane.`);
      }
    } catch (err) {
      console.warn('[Discord] Could not check the harness for the public lane:', errorClass(err));
    }
    // The first lanes build routed public messages into discord-public-* threads. They are left in place
    // and no longer written; say so once per start.
    try {
      const n = countThreadsWithPrefix('discord-public-');
      if (n > 0 && !this.legacyPublicLogged) {
        this.legacyPublicLogged = true;
        console.log(`[Discord] ${n} thread(s) named discord-public-* from the first lanes build are still in your thread list. They are left as they are and are no longer written: public messages are now recorded in a file per channel (data/discord/public/), never in a thread. Delete the threads in the app if you do not want them.`);
      }
    } catch (err) {
      console.warn('[Discord] Could not look for old public threads:', errorClass(err));
    }
    // An upgrade from the old Discord block has no word list yet, so every reply is blocked (fail closed).
    // Say so loudly, and once a day in the daily thread, naming the fix.
    try {
      announceMissingWords({
        inspect: wordGateInspect,
        warn: (m) => console.warn(m),
        dailyThreadId: () => ensureDailyThread().thread.id,
        post: (threadId, text) => this.postSystemLine(threadId, text, { discordUpgradeNotice: true, kind: 'discord_notice' }),
        getStamp: () => getConfig('discord.wordsMissingNoticeThread'),
        setStamp: (v) => setConfig('discord.wordsMissingNoticeThread', v),
      });
    } catch (err) {
      console.error('[Discord] Could not announce the missing word list:', err);
    }
    const gen = ++this.generation;
    try {
      await this.client.login(token);
      if (gen !== this.generation) { this.client.destroy(); return; } // stop() came while logging in
      this.started = true;
      await this.restoreQueues(gen);
      if (gen !== this.generation) return; // stop() came during the restore: no timer, no batch

      // Start deferred queue drain timer
      this.deferTimer = setInterval(bindCurrentTenant(() => {
        this.drainDeferredQueue().catch(err =>
          console.error('[Discord] Drain error:', err)
        );
      }), getDiscordConfig().deferPollIntervalMs);

      console.log('[Discord] Gateway started');
    } catch (error) {
      console.error('[Discord] Failed to login:', error);
    }
  }

  async stop(): Promise<void> {
    this.generation++; // whatever start() still has in flight (a login, a restore) is over
    if (!this.started) return;
    console.log('[Discord] Shutting down gateway...');
    if (this.deferTimer) {
      clearInterval(this.deferTimer);
      this.deferTimer = null;
    }
    // Queued deferrals leave the queue here, so their hourglass comes off (nothing is waiting any more). No owner line:
    // this is a shutdown, not an expiry.
    const dropped = this.deferredBatches;
    this.deferredBatches = [];
    for (const e of dropped) await this.clearHourglass(e.batch);
    for (const e of this.followUps.values()) if (e.timer) clearTimeout(e.timer);
    this.followUps.clear();
    // A restore in flight is abandoned; its saved rows stay in SQLite for the next start.
    this.restoring = false;
    this.restoringKeys.clear();
    this.restoreRun = null;
    this.carriedDeferrals = [];
    this.carriedFollowUps = [];
    this.debouncer.destroy();
    this.client.destroy();
    this.started = false;
  }

  isConnected(): boolean {
    return this.started && this.client.isReady();
  }

  getStats() {
    return {
      ...this.stats,
      deferredPending: this.deferredBatches.length,
      connected: this.isConnected(),
      username: this.client.user?.username || null,
      guilds: this.client.guilds.cache.size,
    };
  }
}
