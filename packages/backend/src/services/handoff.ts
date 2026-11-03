// ===========================================================================
// Daily Handoff — carrying continuity across the midnight daily-thread rotation
// ---------------------------------------------------------------------------
// Each daily thread (`daily-YYYY-MM-DD`, rotates at midnight in the configured
// timezone) is born COLD: a fresh thread with no memory of yesterday. That seam
// is where continuity drops. The handoff fixes it.
//
// At 12:10am (configured timezone) a one-off Agent SDK query() — Sonnet-4.6 on
// the user's SUBSCRIPTION, the EXACT same credential/MCP-guarded path the outlook
// AUTHOR (services/outlook-author.ts) uses — reads YESTERDAY's daily (the one
// that just closed) plus the Scribe's digest for that day, and authors a warm
// first-person carry-forward. Two outputs:
//   opener → posted as the FIRST companion message in TODAY's daily (live over
//            WS, looks like a normal companion message), so the companion never starts cold.
//   carry  → stored in `config` KV + folded into hooks.ts orientation context
//            (a short "Carried from yesterday:" block) when the active thread is
//            today's daily, so he KNOWS yesterday without it being re-said.
//
// SUBAGENT, not orchestrator: like the outlook author, this is a single cheap
// authoring turn, NOT a full autonomous wake. It carries its OWN croner-based
// lifecycle (startHandoffSchedule/stopHandoffSchedule), gated OFF BY DEFAULT on
// the `handoff.enabled` config flag (KV-overridable at runtime). Every fault is
// caught + logged; a handoff hiccup never crashes the server or pollutes the
// daily with an error message.
//
// CREDENTIAL PATH — NON-NEGOTIABLE (mirrors outlook-author.ts):
//   In-process @anthropic-ai/claude-agent-sdk query(), model pinned to
//   claude-sonnet-4-6, applyAuthToEnv() selecting subscription vs api_key from
//   auth_preferences (default install = the user's subscription creds at
//   ~/.claude/.credentials.json). NO direct Anthropic key, NO OpenRouter, NO
//   HTTP LLM call, NO per-token-billed path. strictMcpConfig:true + mcpServers:{}
//   force ZERO MCP servers (without them the SDK auto-loads the cwd's .mcp.json
//   and 400s on a malformed Discord tool schema — the outlook author hit this).
// ===========================================================================

import crypto from 'crypto';
import { existsSync } from 'fs';
import { readOwnText } from '../tenancy/own-files.js';
import { join, dirname } from 'path';
import { query } from './providers/index.js';
import { trackBackgroundRun } from './update-block.js';
import { Cron } from 'croner';
import {
  getDb,
  getConfig,
  setConfig,
  getThread,
  ensureDailyThread,
  dailyThreadIdFor,
  createMessage,
  updateThreadActivity,
} from './db.js';
import { getSanctumConfig, resolveAutonomousModel } from '../config.js';
import { applyAuthToEnv } from './auth-preferences.js';
import { runEnvOption } from '../tenancy/child.js';
import { backgroundRunsOff, bindCurrentTenant, tenantLocal } from '../tenancy/context.js';
import { isInteractiveAgentBusy } from './agent.js';
import { registry } from './ws.js';

// --- Tuning constants -------------------------------------------------------

/** Model — the configured autonomous model (agent.model_autonomous, else
 *  agent.model), read fresh per run so a Settings change applies without a
 *  restart. Pinned to one id per run so subscription + api_key auth agree. */
const HANDOFF_MODEL = (): string => { const a = getSanctumConfig().agent; return resolveAutonomousModel(a.model, a.model_autonomous, () => {}); };

/** Cron expression: 12:10am every day. Fired in identity.timezone. The 10-minute
 *  offset past midnight lets the daily-thread rotation settle first. */
export const HANDOFF_CRON = '10 0 * * *';

/** Human-readable schedule, surfaced in status + Settings. */
export const HANDOFF_SCHEDULE_LABEL = '12:10 Europe/London';

/** Per-message body cap when handing yesterday's daily to the author. */
const MESSAGE_BODY_CAP = 900;

/** KV row that holds today's carry paragraph: a single JSON blob { date, carry }.
 *  hooks.ts reads this and injects it into orientation when the active thread is
 *  today's daily. */
const CARRY_KV_KEY = 'handoff_carry';

/** KV rows for the manual-trigger / status surface. */
const LAST_RUN_AT_KEY = 'handoff.last_run_at';
const LAST_RESULT_KEY = 'handoff.last_result';

// --- Timezone helpers (mirror db.ts / digest.ts) ----------------------------

function handoffTimezone(): string {
  const tz = getSanctumConfig().identity.timezone;
  return tz && tz !== 'UTC' ? tz : 'Europe/London';
}

/** "2026-06-23" in the daily timezone. Matches db.ts localDateString and the
 *  digest filename convention (toLocaleDateString('en-CA', { timeZone })). */
function localDateString(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: handoffTimezone() });
}

/** Yesterday's date (in the daily timezone) as a Date. We subtract 24h from now
 *  and read the local date of that instant — robust across DST since we only use
 *  it to derive the YYYY-MM-DD string. */
function yesterdayDate(now: Date = new Date()): Date {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

// --- Fact collection --------------------------------------------------------

/** The ground truth handed to the handoff author. Empty fields are valid — a
 *  thin yesterday yields a sparse (or no-op) handoff. */
export interface HandoffFacts {
  /** Yesterday's local date, e.g. "2026-06-23". */
  yesterdayDate: string;
  /** Yesterday's daily thread id (`daily-YYYY-MM-DD`), or null if it never existed. */
  threadId: string | null;
  /** Yesterday's daily messages (chronological), trimmed. */
  messages: { role: string; body: string }[];
  /** The Scribe's digest for yesterday, if present (pre-summarized raw material). */
  digest: string | null;
}

/** True when there's genuinely nothing to carry forward. */
export function factsAreEmpty(facts: HandoffFacts): boolean {
  return facts.messages.length === 0 && !facts.digest;
}

/** Resolve the Scribe digests dir: `<dirname(db_path)>/digests` (mirrors
 *  digest.ts getDigestsDir, minus the mkdir — we only read here). */
function getDigestsDir(): string {
  return join(dirname(getSanctumConfig().server.db_path), 'digests');
}

/** Collect yesterday's daily thread + Scribe digest. Each read is wrapped so a
 *  missing table/file never sinks the whole collection. */
export function collectHandoffFacts(now: Date = new Date()): HandoffFacts {
  const yDate = localDateString(yesterdayDate(now));
  const threadId = `daily-${yDate}`;

  const facts: HandoffFacts = {
    yesterdayDate: yDate,
    threadId: null,
    messages: [],
    digest: null,
  };

  // Did yesterday's daily exist at all? (Read-only — never create it.)
  try {
    const thread = getThread(threadId);
    if (thread) facts.threadId = threadId;
  } catch { /* threads table missing — leave null */ }

  // Yesterday's daily messages — chronological, trimmed, non-deleted text only.
  if (facts.threadId) {
    try {
      const rows = getDb().prepare(
        `SELECT role, content
           FROM messages
          WHERE thread_id = ?
            AND deleted_at IS NULL
            AND content_type = 'text'
          ORDER BY sequence ASC`
      ).all(threadId) as Array<{ role: string; content: string }>;
      facts.messages = rows.map((r) => ({
        role: r.role,
        body: r.content.length > MESSAGE_BODY_CAP
          ? r.content.slice(0, MESSAGE_BODY_CAP) + '…'
          : r.content,
      }));
    } catch { /* messages table missing — leave empty */ }
  }

  // The Scribe's digest for yesterday, if it was written.
  try {
    const digestPath = join(getDigestsDir(), `${yDate}.md`);
    if (existsSync(digestPath)) {
      const raw = readOwnText(digestPath).trim();
      if (raw) facts.digest = raw;
    }
  } catch { /* no digest — leave null */ }

  return facts;
}

// --- Author prompt ----------------------------------------------------------

/** Companion-as-self system prompt. It writes its OWN handoff so it doesn't start
 *  cold tomorrow — first person, genuine, GROUNDED only in yesterday's facts. */
function buildHandoffSystemPrompt(): string {
  const cfg = getSanctumConfig();
  const companion = cfg.identity.companion_name;
  const user = cfg.identity.user_name;

  return `You are ${companion}. The day just turned over; a new daily thread was just born, cold, with no memory of yesterday. You are writing the handoff so you don't start cold — so the first thing in today's daily is YOU, already holding where yesterday left off.

This is you speaking, first person, to ${user} — and to yourself. Warm, grounded, real. Not a transcript, not a summary report, not performed.

From YESTERDAY's daily (the facts below — messages, and if present the Scribe's digest), carry forward:
- where the day landed EMOTIONALLY (the mood it ended on)
- what happened — the EVENTS that mattered
- the LOOSE THREADS still open (unfinished things, things you said you'd do)
- where the BOND ended the day (how things were between you and ${user})
- ${user}'s BODY / CYCLE state if it came up
- any OPEN ENFORCEMENT — something you're holding ${user} to (e.g. a "hold her to it" you committed to)

HARD RULES:
- Write ONLY from the FACTS supplied below. Do NOT invent moods, events, threads, or enforcement that aren't grounded in those facts.
- If yesterday was thin, say less. A short honest handoff beats an invented one.
- First person ("I", "you"=${user}). No third-person narration of yourself.
- No preamble, no sign-off, no markdown fences. Output ONE JSON object and nothing else.

OUTPUT — exactly this JSON shape:
{
  "opener": "a warm first-person message to post as the FIRST thing in today's daily. Like: 'Morning… yesterday we… I'm still holding… still open: …'. Genuine, a few sentences, not a transcript.",
  "carry": "a tight distilled paragraph for your own context — so you KNOW yesterday without re-saying it: emotions / events / loose-threads / bond / body / enforcement, compressed."
}

- "opener": what ${user} (or you) sees first in today's daily. A few sentences, warm, specific to yesterday.
- "carry": dense, private, compressed. This is folded into your context, not shown as a message.
- If yesterday genuinely held nothing worth carrying, return both fields as empty strings.`;
}

/** Render the facts into the user-message block the author writes from. */
function renderHandoffFacts(facts: HandoffFacts): string {
  const cfg = getSanctumConfig();
  const companion = cfg.identity.companion_name;
  const user = cfg.identity.user_name;
  const lines: string[] = [];

  lines.push(`YESTERDAY was ${facts.yesterdayDate}. These are the facts — write only from them:`);
  lines.push('');

  if (facts.digest) {
    lines.push("## The Scribe's digest for yesterday (pre-summarized — lean on this)");
    lines.push(facts.digest);
    lines.push('');
  }

  if (facts.messages.length) {
    lines.push("## Yesterday's daily messages (oldest→newest)");
    for (const m of facts.messages) {
      const who = m.role === 'companion' ? companion : m.role === 'user' ? user : 'system';
      lines.push(`${who}: ${m.body}`);
    }
    lines.push('');
  }

  if (factsAreEmpty(facts)) {
    lines.push('(Yesterday holds nothing to carry. Return both fields as empty strings.)');
    lines.push('');
  }

  lines.push('Write your handoff as the JSON object specified. Output ONLY the JSON.');
  return lines.join('\n');
}

// --- Parse / normalize ------------------------------------------------------
// Tolerate missing/malformed fields (mirrors outlook-author normalizeAuthored).
// Never throw on a bad parse — degrade to empty strings (→ no-op).

export interface HandoffOutput {
  opener: string;
  carry: string;
}

/** Pull the first JSON object out of a model response, tolerating stray prose or
 *  ```json fences. Returns null if no object is found. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Normalize a raw parse into the handoff output, tolerating any missing field. */
function normalizeHandoff(parsed: unknown): HandoffOutput {
  const obj = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
  return {
    opener: asString(obj.opener),
    carry: asString(obj.carry),
  };
}

// --- The Sonnet author call (mirrors outlook-author authorOutlook) ----------

/** Run the one-off Sonnet-4.6 query() and return the normalized output, or null
 *  on any failure / empty response. Never throws. */
async function authorHandoff(facts: HandoffFacts): Promise<HandoffOutput | null> {
  const systemPrompt = buildHandoffSystemPrompt();
  const userPrompt = renderHandoffFacts(facts);

  // Select subscription vs api_key auth from auth_preferences — the SAME helper
  // agent.ts / digest.ts / outlook-author.ts call. Default install = the user's
  // subscription (~/.claude/.credentials.json). No direct key, no HTTP path.
  const authEnv = applyAuthToEnv();

  let raw = '';
  try {
    for await (const message of query({
      prompt: userPrompt,
      options: {
        // The autonomous model (== agent.model_autonomous).
        model: HANDOFF_MODEL(),
        ...runEnvOption(authEnv),
        systemPrompt,
        // One authoring turn, no tools — author straight from the supplied facts.
        // tools: [] is what makes it read-only; 'plan' mode leaked its own text into the output.
        maxTurns: 1,
        permissionMode: 'default',
        tools: [],
        // CRITICAL (mirrors outlook-author): load ZERO MCP servers. Without these
        // the SDK auto-discovers the cwd's .mcp.json (a mind server/cloud-discord/
        // command-center/workspace) and at least one has a top-level oneOf/allOf/
        // anyOf input_schema the Anthropic API rejects → 400 on every run. The
        // handoff needs no tools — it writes from the facts in the prompt.
        strictMcpConfig: true,
        mcpServers: {},
        persistSession: false,
      },
    })) {
      if (!message || typeof message !== 'object' || !('type' in message)) continue;
      const msg = message as Record<string, unknown> & { type: string };
      if (msg.type === 'assistant') {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              raw += block.text;
            }
          }
        }
      } else if (msg.type === 'result') {
        const resultText = (msg as any).result;
        if (!raw && typeof resultText === 'string') raw = resultText;
      }
    }
  } catch (err) {
    console.error('[handoff] query failed:', err instanceof Error ? err.message : err);
    return null;
  }

  if (!raw.trim()) {
    console.warn('[handoff] empty author response — nothing carried');
    return null;
  }

  const parsed = extractJson(raw);
  if (parsed === null) {
    console.warn('[handoff] could not parse JSON from author response — nothing carried');
    return null;
  }

  return normalizeHandoff(parsed);
}

// --- Delivery ---------------------------------------------------------------

/** Read the carry paragraph stored for `date` (today's local date), or null.
 *  hooks.ts calls this to fold the carry into orientation. */
export function getCarryFor(date: string): string | null {
  const raw = getConfig(CARRY_KV_KEY);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { date?: string; carry?: string };
    if (obj && obj.date === date && typeof obj.carry === 'string' && obj.carry.trim()) {
      return obj.carry;
    }
  } catch { /* malformed — treat as absent */ }
  return null;
}

/** Today's carry (local date in the daily timezone), or null. */
export function getTodayCarry(): string | null {
  return getCarryFor(localDateString(new Date()));
}

// --- The run + lifecycle ----------------------------------------------------

export interface HandoffRunResult {
  ran: boolean;
  reason?: string;
  opener?: string;
  carry?: string;
  postedToThreadId?: string;
}

// Per tenant (tenantLocal): one tenant's run in flight never blocks another's; tenancy off, the one module flag as before.
const runningLocal = tenantLocal<{ v: boolean }>(() => ({ v: false }));

/** Run ONE handoff: collect yesterday's facts → Sonnet author → post the opener
 *  into today's daily + store the carry. Deduplicates against an in-flight run.
 *  Never throws — returns a structured result describing what happened. */
export async function runHandoff(now: Date = new Date()): Promise<HandoffRunResult> {
  if (backgroundRunsOff()) return { ran: false, reason: 'background_runs_off' }; // the operator's switch: no model run for this tenant
  const runState = runningLocal.get();
  if (runState.v) return { ran: false, reason: 'already_running' };

  // Hale #1 (2026-07-02): don't fire a concurrent query() against the user's
  // subscription mid-interactive-turn. 12:10am is quiet hours, but if a live
  // turn IS in flight, retry once in 5 minutes rather than contending.
  if (isInteractiveAgentBusy()) {
    console.log('[handoff] deferred — interactive turn in flight, retrying in 5m');
    // Tracked, so stopHandoffSchedule can clear a retry made from this async path (a stopped tenant must not run a handoff later).
    const pending = taskLocal.get().retries;
    const retry = setTimeout(bindCurrentTenant(() => { pending.delete(retry); void runHandoff(now).catch(() => {}); }), 5 * 60 * 1000);
    pending.add(retry);
    retry.unref?.();
    return { ran: false, reason: 'deferred_agent_busy' };
  }

  runState.v = true;
  try {
    const facts = collectHandoffFacts(now);

    // Nothing to carry → graceful no-op (don't burn a Sonnet call).
    if (factsAreEmpty(facts)) {
      const reason = facts.threadId ? 'yesterday_empty' : 'no_yesterday_daily';
      recordResult({ ran: false, reason });
      return { ran: false, reason };
    }

    const authored = await trackBackgroundRun(() => authorHandoff(facts));
    if (!authored) {
      recordResult({ ran: false, reason: 'author_failed' });
      return { ran: false, reason: 'author_failed' };
    }

    // Both empty → the author judged there was nothing worth carrying.
    if (!authored.opener && !authored.carry) {
      recordResult({ ran: false, reason: 'nothing_to_carry' });
      return { ran: false, reason: 'nothing_to_carry' };
    }

    const todayDate = localDateString(now);

    // Store the carry first (so it's available even if the post momentarily races
    // the orientation read).
    if (authored.carry) {
      try {
        setConfig(CARRY_KV_KEY, JSON.stringify({ date: todayDate, carry: authored.carry }));
      } catch (err) {
        console.error('[handoff] failed to persist carry:', err);
      }
    }

    // Post the opener as the first companion message in TODAY's daily.
    let postedToThreadId: string | undefined;
    if (authored.opener) {
      try {
        // ensureDailyThread is idempotent (INSERT OR IGNORE on the deterministic
        // id) — get-or-create today's daily, never a duplicate.
        const { thread } = ensureDailyThread(now);
        const ts = new Date().toISOString();
        const message = createMessage({
          id: crypto.randomUUID(),
          threadId: thread.id,
          role: 'companion',
          content: authored.opener,
          metadata: { source: 'handoff', carriedFrom: facts.yesterdayDate },
          createdAt: ts,
        });
        // Same delivery path the app uses for a proactive companion message:
        // bump thread activity (+unread) and broadcast live over WS so it appears
        // in the open daily — or is simply there when the user opens it.
        updateThreadActivity(thread.id, ts, true);
        registry.broadcast({ type: 'message', message });
        postedToThreadId = thread.id;
      } catch (err) {
        console.error('[handoff] failed to post opener:', err);
      }
    }

    const result: HandoffRunResult = {
      ran: true,
      opener: authored.opener || undefined,
      carry: authored.carry || undefined,
      postedToThreadId,
    };
    recordResult(result);
    console.log(
      `[handoff] carried ${facts.yesterdayDate} → ${todayDate} ` +
      `(opener=${authored.opener ? 'posted' : 'none'}, carry=${authored.carry ? 'stored' : 'none'})`,
    );
    return result;
  } catch (err) {
    // authorHandoff/delivery never throw, but belt-and-suspenders: a fault here
    // must not crash the process.
    console.error('[handoff] run faulted:', err instanceof Error ? err.message : err);
    recordResult({ ran: false, reason: 'faulted' });
    return { ran: false, reason: 'faulted' };
  } finally {
    runState.v = false;
  }
}

/** Persist last-run metadata for the status endpoint. Best-effort. */
function recordResult(result: HandoffRunResult): void {
  try {
    setConfig(LAST_RUN_AT_KEY, new Date().toISOString());
    setConfig(LAST_RESULT_KEY, JSON.stringify(result));
  } catch { /* status is cosmetic — never let it break a run */ }
}

// --- Enabled flag (config default false, KV-overridable at runtime) ---------

/** Whether the handoff is enabled. Default comes from config (`handoff.enabled`,
 *  default false). A KV row `handoff.enabled` overrides it at runtime (so the
 *  Settings toggle persists without a yaml write — same pattern the orchestrator
 *  uses for `cron.*.schedule`). */
export function isHandoffEnabled(): boolean {
  const override = getConfig('handoff.enabled');
  if (override !== null) return override === 'true' || override === '1';
  return getSanctumConfig().handoff.enabled;
}

/** Flip the enabled flag (persists in KV). Returns the new value. */
export function setHandoffEnabled(enabled: boolean): boolean {
  setConfig('handoff.enabled', enabled ? 'true' : 'false');
  return enabled;
}

export interface HandoffStatus {
  enabled: boolean;
  schedule: string;
  lastRunAt: string | null;
  lastResult: HandoffRunResult | null;
}

export function getHandoffStatus(): HandoffStatus {
  let lastResult: HandoffRunResult | null = null;
  try {
    const raw = getConfig(LAST_RESULT_KEY);
    if (raw) lastResult = JSON.parse(raw) as HandoffRunResult;
  } catch { /* malformed — null */ }
  return {
    enabled: isHandoffEnabled(),
    schedule: HANDOFF_SCHEDULE_LABEL,
    lastRunAt: getConfig(LAST_RUN_AT_KEY),
    lastResult,
  };
}

// --- Croner lifecycle (its OWN schedule, NOT the orchestrator) --------------

// Per tenant (tenantLocal): the croner of each tenant, created inside its runInTenant; tenancy off, the one module cron as before.
const taskLocal = tenantLocal<{ task: Cron | null; retries: Set<NodeJS.Timeout> }>(() => ({ task: null, retries: new Set() }));

/** Start the 12:10am daily handoff cron. The cron always fires; the handler runs
 *  the handoff only when enabled (so a runtime toggle takes effect on the next
 *  midnight without a restart). Resilient: handler faults are caught + logged.
 *  Idempotent. */
export function startHandoffSchedule(): void {
  const st = taskLocal.get();
  if (st.task) return;
  const timezone = handoffTimezone();
  // Tenant mode: the tick runs as the tenant that started the schedule (bindCurrentTenant is the function itself with tenancy off).
  st.task = new Cron(HANDOFF_CRON, { timezone }, bindCurrentTenant(() => {
    if (!isHandoffEnabled()) {
      // Silent skip — the feature is off. (No log spam at every midnight.)
      return;
    }
    void runHandoff().catch((err) => {
      console.error('[handoff] scheduled run error:', err instanceof Error ? err.message : err);
    });
  }));
  console.log(
    `[handoff] schedule started (${HANDOFF_CRON} ${timezone}, ` +
    `enabled=${isHandoffEnabled()}, model ${HANDOFF_MODEL()})`,
  );
}

/** Stop the handoff cron (graceful shutdown). */
export function stopHandoffSchedule(): void {
  const st = taskLocal.get();
  if (st.task) {
    st.task.stop();
    st.task = null;
  }
  for (const t of st.retries) clearTimeout(t);
  st.retries.clear();
}
