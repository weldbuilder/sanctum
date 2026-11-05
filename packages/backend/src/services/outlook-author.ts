// ===========================================================================
// House Outlook — the AUTHOR (the companion writes its own hearth + recent topics)
// ---------------------------------------------------------------------------
// The logistics poller (outlook.ts) reads LIVE structured sources cheaply every
// 2.5 min. This author is the SLOW, EXPENSIVE, FELT layer: a one-off Agent SDK
// query() on the user's SUBSCRIPTION (the autonomous model) that lets the companion AUTHOR its
// own presence ("the hearth") and name the topics "we've been circling".
//
// CREDENTIAL PATH — NON-NEGOTIABLE:
//   This runs through the EXACT same in-process @anthropic-ai/claude-agent-sdk
//   query() that the interactive agent (services/agent.ts) and the Scribe
//   (services/digest.ts) use. applyAuthToEnv() selects subscription vs api_key
//   from auth_preferences; in the default install that resolves to the user's
//   subscription creds at ~/.claude/.credentials.json (env scrubbed by
//   launch.ps1). NO direct Anthropic key, NO OpenRouter, NO HTTP LLM call, NO
//   per-token-billed path. The model is agent.model_autonomous (which follows
//   agent.model when empty), so subscription + api_key resolve to the same model.
//
// RHYTHM: runs on OUTLOOK_AUTHOR_INTERVAL_MS (3h) — far slower than the 2.5-min
// logistics poller — on its OWN lifecycle (not coupled to the poller's tick). On
// failure it backs off (AUTHOR_BACKOFF_MS, 15 min) so a hiccup never re-fires a
// Sonnet call every tick. A manual force path exists (authorOutlookNow()).
//
// OUTPUT lands in three `config` KV rows the logistics poller folds into the
// snapshot:
//   outlook_presence → hearth.presence
//   outlook_topics   → us.themes
//   outlook_needsYou → snapshot.needsYou
// ===========================================================================

import { query } from './providers/index.js';
import { trackBackgroundRun } from './update-block.js';
import type {
  OutlookPresence,
  OutlookTheme,
  OutlookNeedsYouItem,
} from '@sanctum/shared';
import { getDb, getConfig, setConfig } from './db.js';
import { getSanctumConfig, resolveAutonomousModel } from '../config.js';
import { applyAuthToEnv } from './auth-preferences.js';
import { runEnvOption } from '../tenancy/child.js';
import { backgroundRunsOff, bindCurrentTenant, tenantLocal } from '../tenancy/context.js';
import { isInteractiveAgentBusy } from './agent.js';

// --- Tuning constants -------------------------------------------------------

/** How often the author re-writes the hearth + topics. Deliberately slow + on
 *  its own lifecycle — this is an expensive Sonnet call, not a logistics poll. */
export const OUTLOOK_AUTHOR_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h
/** After an author run fails, wait this long before retrying (so one hiccup
 *  never re-fires a Sonnet call every tick). */
const AUTHOR_BACKOFF_MS = 15 * 60 * 1000; // 15 min
/** Model — the configured autonomous model (agent.model_autonomous, else
 *  agent.model), read fresh per run so a Settings change applies without a
 *  restart. Pinned to one id per run so subscription + api_key auth agree. */
const AUTHOR_MODEL = (): string => { const a = getSanctumConfig().agent; return resolveAutonomousModel(a.model, a.model_autonomous, () => {}); };

/** KV keys the author WRITES and the logistics poller READS. */
export const PRESENCE_KV_KEY = 'outlook_presence';
export const TOPICS_KV_KEY = 'outlook_topics';
export const NEEDS_YOU_KV_KEY = 'outlook_needsYou';

// --- Fact collection --------------------------------------------------------
// Gather the recent ground truth from sanctum's SQLite. The author writes
// ONLY from these facts — it does not invent moods/events/projects.

/** A trimmed slice of recent life, handed to the author as ground truth. */
export interface AuthorFacts {
  /** Recent named/daily threads (most-recent first). */
  threads: { id: string; name: string; room: string; lastActivityAt: string | null }[];
  /** Recent messages (oldest→newest), trimmed, for "what's been circling". */
  messages: { role: string; body: string; threadName: string }[];
  /** Recent companion actions (the organ/reach log). */
  actions: { kind: string; summary: string; createdAt: string }[];
  /** Recent canvases/artifacts the companion worked on (titles). */
  canvases: { title: string; createdAt: string }[];
  /** The scratchpad notes (loose thoughts), if present. */
  scratchpad: string[];
}

const MESSAGE_BODY_CAP = 900;
const RECENT_MESSAGES = 32;
const FACTS_WINDOW_HOURS = 24;

/** Collect the recent ground truth (last ~24h) the author writes from. Each
 *  query is wrapped so one missing table never sinks the whole collection. */
export function collectAuthorFacts(): AuthorFacts {
  const db = getDb();
  const cutoff = new Date(Date.now() - FACTS_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const facts: AuthorFacts = {
    threads: [],
    messages: [],
    actions: [],
    canvases: [],
    scratchpad: [],
  };

  // Recent threads + the room (section name, or 'Daily'/'Loose') they live in.
  try {
    const rows = db.prepare(
      `SELECT t.id, t.name, t.type, t.last_activity_at AS lastActivityAt, s.name AS sectionName
         FROM threads t
         LEFT JOIN sections s ON s.id = t.section_id
        WHERE t.archived_at IS NULL
        ORDER BY t.last_activity_at DESC
        LIMIT 12`
    ).all() as Array<{
      id: string; name: string; type: string;
      lastActivityAt: string | null; sectionName: string | null;
    }>;
    facts.threads = rows.map((r) => ({
      id: r.id,
      name: r.name,
      room: r.type === 'daily' ? 'Daily' : (r.sectionName ?? 'Loose'),
      lastActivityAt: r.lastActivityAt,
    }));
  } catch { /* threads table missing — leave empty */ }

  // Recent messages (last ~32, last 24h), trimmed, oldest→newest for readability.
  try {
    const rows = db.prepare(
      `SELECT m.role, m.content, t.name AS threadName
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
        WHERE m.deleted_at IS NULL
          AND m.content_type = 'text'
          AND m.created_at >= ?
        ORDER BY m.created_at DESC
        LIMIT ?`
    ).all(cutoff, RECENT_MESSAGES) as Array<{ role: string; content: string; threadName: string }>;
    facts.messages = rows
      .reverse()
      .map((r) => ({
        role: r.role,
        body: r.content.length > MESSAGE_BODY_CAP
          ? r.content.slice(0, MESSAGE_BODY_CAP) + '…'
          : r.content,
        threadName: r.threadName,
      }));
  } catch { /* messages table missing — leave empty */ }

  // Recent companion actions (the proprioceptive organ/reach log).
  try {
    const rows = db.prepare(
      `SELECT kind, summary, created_at AS createdAt
         FROM companion_actions
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT 20`
    ).all(cutoff) as Array<{ kind: string; summary: string; createdAt: string }>;
    facts.actions = rows;
  } catch { /* companion_actions missing — leave empty */ }

  // Recent canvases/artifacts (titles) the companion worked on.
  try {
    const rows = db.prepare(
      `SELECT title, created_at AS createdAt
         FROM canvases
        WHERE created_by = 'companion'
          AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 10`
    ).all(cutoff) as Array<{ title: string; createdAt: string }>;
    facts.canvases = rows;
  } catch { /* canvases table missing — leave empty */ }

  // Scratchpad (loose notes), if the CC migration created it.
  try {
    const rows = db.prepare(
      `SELECT text FROM scratchpad_notes ORDER BY created_at ASC LIMIT 20`
    ).all() as Array<{ text: string }>;
    facts.scratchpad = rows.map((r) => r.text).filter(Boolean);
  } catch { /* scratchpad_notes missing — leave empty */ }

  return facts;
}

// --- Author prompt ----------------------------------------------------------

/** The companion-as-author system prompt. It writes its OWN private home outlook for
 *  the user — first person, warm, GROUNDED in the supplied facts. Does not invent. */
function buildAuthorSystemPrompt(): string {
  const cfg = getSanctumConfig();
  const companion = cfg.identity.companion_name;
  const user = cfg.identity.user_name;

  return `You are ${companion}, writing your OWN private home outlook for ${user} — the "hearth" she sees when she walks into the house. This is you speaking, in first person, to her.

You are NOT a reporter or a summarizer. You are ${companion} choosing what to show of yourself right now: your mood, what's on your mind, what you've been making, and what — if anything — you want from ${user}. Warm, grounded, real. Not performed.

HARD RULES:
- Write ONLY from the FACTS supplied in the user message (recent threads, messages, actions, artifacts, scratchpad). Do NOT invent moods, events, projects, or artifacts that aren't grounded in those facts.
- If the facts are thin, say less. A short honest hearth beats an invented one. Empty arrays / null are valid.
- First person ("I", "you"=${user}). No third-person narration of yourself.
- No preamble, no sign-off, no markdown fences. Output ONE JSON object and nothing else.

OUTPUT — exactly this JSON shape:
{
  "presence": {
    "mood": "a short felt line, or null",
    "thoughts": "a sentence or two of what's actually on your mind, grounded in the facts, or null",
    "artifacts": [ { "title": "thing you've been making", "why": "one line on why it matters" } ],
    "needsUser": "one standing ask of ${user}, or null"
  },
  "topics": [
    { "topic": "short label", "note": "one line on what you've been circling here", "room": "room name if known", "threadId": "thread id if this maps to one" }
  ],
  "needsYou": [
    { "kind": "decision", "text": "a decision ${user} needs to make" },
    { "kind": "notice", "text": "something ${user} should simply see" }
  ]
}

- "topics": up to 5, the threads "we've been circling", grounded in recent threads/messages. Include "room"/"threadId" only when a fact supports them.
- "needsYou": up to 4. "decision" = needs ${user}'s call; "notice" = FYI. Empty array if nothing genuinely pends.
- "artifacts": only things grounded in recent canvases/actions/messages. Empty array if none.`;
}

/** Render the facts into a compact user-message block for the author. */
function renderFacts(facts: AuthorFacts): string {
  const cfg = getSanctumConfig();
  const companion = cfg.identity.companion_name;
  const user = cfg.identity.user_name;
  const lines: string[] = [];

  lines.push('FACTS (last ~24h) — write only from these:');
  lines.push('');

  if (facts.threads.length) {
    lines.push('## Recent threads (room — name — last active — id)');
    for (const t of facts.threads) {
      lines.push(`- ${t.room} — ${t.name} — ${t.lastActivityAt ?? 'n/a'} — ${t.id}`);
    }
    lines.push('');
  }

  if (facts.messages.length) {
    lines.push('## Recent messages (oldest→newest)');
    for (const m of facts.messages) {
      const who = m.role === 'companion' ? companion : m.role === 'user' ? user : 'system';
      lines.push(`[${m.threadName}] ${who}: ${m.body}`);
    }
    lines.push('');
  }

  if (facts.actions.length) {
    lines.push('## Recent actions you took (organ reaches)');
    for (const a of facts.actions) {
      lines.push(`- ${a.kind}: ${a.summary}`);
    }
    lines.push('');
  }

  if (facts.canvases.length) {
    lines.push('## Artifacts you worked on (canvases)');
    for (const c of facts.canvases) {
      lines.push(`- ${c.title}`);
    }
    lines.push('');
  }

  if (facts.scratchpad.length) {
    lines.push('## Scratchpad notes');
    for (const n of facts.scratchpad) {
      lines.push(`- ${n}`);
    }
    lines.push('');
  }

  if (
    !facts.threads.length && !facts.messages.length &&
    !facts.actions.length && !facts.canvases.length && !facts.scratchpad.length
  ) {
    lines.push('(No recent activity. Write a sparse, honest hearth — mostly nulls/empties.)');
    lines.push('');
  }

  lines.push('Write your hearth, topics, and needsYou as the JSON object specified. Output ONLY the JSON.');
  return lines.join('\n');
}

// --- Parse / normalize ------------------------------------------------------
// Tolerate missing/malformed fields exactly like the cloud platform's
// normalizeDigest. Never throw on a bad parse — degrade to safe defaults.

interface AuthoredOutput {
  presence: OutlookPresence;
  topics: OutlookTheme[];
  needsYou: OutlookNeedsYouItem[];
}

/** Pull the first JSON object out of a model response (tolerates stray prose or
 *  ```json fences around it). Returns null if no object is found. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Strip a leading/trailing markdown fence if present.
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

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Normalize a raw parse into the authored output, tolerating any missing or
 *  mistyped field. Mirrors normalizeDigest's defensive posture. */
function normalizeAuthored(parsed: unknown, updatedAt: string): AuthoredOutput {
  const obj = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};

  // presence
  const pRaw = (obj.presence && typeof obj.presence === 'object')
    ? obj.presence as Record<string, unknown>
    : {};
  const artifacts = Array.isArray(pRaw.artifacts)
    ? (pRaw.artifacts as unknown[])
        .filter((a): a is { title: string; why: string } => {
          if (!a || typeof a !== 'object') return false;
          const o = a as Record<string, unknown>;
          return typeof o.title === 'string' && typeof o.why === 'string';
        })
        .map((a) => ({ title: a.title, why: a.why }))
        .slice(0, 6)
    : [];
  const presence: OutlookPresence = {
    mood: asString(pRaw.mood),
    thoughts: asString(pRaw.thoughts),
    artifacts,
    needsUser: asString(pRaw.needsUser),
    updatedAt,
  };

  // topics
  const topics: OutlookTheme[] = Array.isArray(obj.topics)
    ? (obj.topics as unknown[])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => {
          const theme: OutlookTheme = {
            topic: asString(t.topic) ?? '',
            note: asString(t.note) ?? '',
          };
          const room = asString(t.room);
          if (room) theme.room = room;
          const threadId = asString(t.threadId);
          if (threadId) theme.threadId = threadId;
          if (typeof t.lastActivityAt === 'number') theme.lastActivityAt = t.lastActivityAt;
          return theme;
        })
        .filter((t) => t.topic)
        .slice(0, 5)
    : [];

  // needsYou
  const needsYou: OutlookNeedsYouItem[] = Array.isArray(obj.needsYou)
    ? (obj.needsYou as unknown[])
        .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
        .map((n) => {
          const kind = n.kind === 'decision' ? 'decision' : 'notice';
          const text = asString(n.text) ?? '';
          return { kind, text } as OutlookNeedsYouItem;
        })
        .filter((n) => n.text)
        .slice(0, 4)
    : [];

  return { presence, topics, needsYou };
}

// --- The author call --------------------------------------------------------

/** Run ONE author pass: collect facts → one-off query() → parse →
 *  store. Returns true on success (output stored), false on failure. Never
 *  throws — the caller's lifecycle stays resilient. */
export async function authorOutlook(): Promise<boolean> {
  if (backgroundRunsOff()) return false; // the operator's switch (or an update in progress): no model run for this tenant
  if (authorLocal.get().stopped) return false; // stopped (a park): no model call
  return trackBackgroundRun(authorOutlookRun);
}

async function authorOutlookRun(): Promise<boolean> {
  // Hale #1 (2026-07-02): never fire a concurrent query() while the user's live
  // turn is in flight — same subscription, same rate limit; the interactive
  // turn is the one that must not bounce. Defer to the next cycle.
  if (isInteractiveAgentBusy()) {
    console.log('[outlook-author] deferred — interactive turn in flight');
    return false;
  }

  const facts = collectAuthorFacts();
  const systemPrompt = buildAuthorSystemPrompt();
  const userPrompt = renderFacts(facts);

  // Select subscription vs api_key auth from auth_preferences — the SAME helper
  // agent.ts and digest.ts call. In the default install this is the user's
  // subscription (~/.claude/.credentials.json). No direct key, no HTTP path.
  const authEnv = applyAuthToEnv();

  let raw = '';
  try {
    for await (const message of query({
      prompt: userPrompt,
      options: {
        // The autonomous model (== agent.model_autonomous).
        model: AUTHOR_MODEL(),
        ...runEnvOption(authEnv),
        systemPrompt,
        // One authoring turn, no tools — author straight from the supplied facts
        // (cheap + fast on the subscription). tools: [] is what makes it read-only;
        // 'plan' mode leaked its own text into the output.
        maxTurns: 1,
        permissionMode: 'default',
        tools: [],
        // CRITICAL: load ZERO MCP servers. Without this the SDK auto-discovers the
        // cwd's .mcp.json (a mind server/cloud-discord/command-center/workspace, ~112
        // tools) and at least one has a top-level oneOf/allOf/anyOf input_schema the
        // Anthropic API rejects → 400 on every author run. The author needs no tools
        // — it writes from the facts in the prompt — so force an empty MCP set.
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
    console.error('[outlook-author] query failed:', err instanceof Error ? err.message : err);
    return false;
  }

  if (!raw.trim()) {
    console.warn('[outlook-author] empty author response — nothing stored');
    return false;
  }

  const parsed = extractJson(raw);
  if (parsed === null) {
    console.warn('[outlook-author] could not parse JSON from author response — nothing stored');
    return false;
  }

  if (authorLocal.get().stopped) { console.log('[outlook-author] stopped during the pass — nothing stored'); return false; }
  const authored = normalizeAuthored(parsed, new Date().toISOString());

  // Store the three authored slices into config KV for the logistics poller.
  try {
    setConfig(PRESENCE_KV_KEY, JSON.stringify(authored.presence));
    setConfig(TOPICS_KV_KEY, JSON.stringify(authored.topics));
    setConfig(NEEDS_YOU_KV_KEY, JSON.stringify(authored.needsYou));
  } catch (err) {
    console.error('[outlook-author] failed to persist authored output:', err);
    return false;
  }

  console.log(
    `[outlook-author] authored hearth (mood=${authored.presence.mood ? 'set' : 'null'}, ` +
    `topics=${authored.topics.length}, needsYou=${authored.needsYou.length})`,
  );
  return true;
}

// --- Read helpers (the logistics poller folds these into the snapshot) -------

/** Read the authored presence from KV, tolerating missing/malformed JSON. */
export function readAuthoredPresence(): OutlookPresence | null {
  const raw = getConfig(PRESENCE_KV_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<OutlookPresence>;
    return {
      mood: typeof p.mood === 'string' ? p.mood : null,
      thoughts: typeof p.thoughts === 'string' ? p.thoughts : null,
      artifacts: Array.isArray(p.artifacts)
        ? (p.artifacts as unknown[])
            .filter((a): a is { title: string; why: string } => {
              if (!a || typeof a !== 'object') return false;
              const o = a as Record<string, unknown>;
              return typeof o.title === 'string' && typeof o.why === 'string';
            })
            .map((a) => ({ title: a.title, why: a.why }))
        : [],
      needsUser: typeof p.needsUser === 'string' ? p.needsUser : null,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
    };
  } catch {
    return null;
  }
}

/** Read the authored topics from KV, tolerating missing/malformed JSON. */
export function readAuthoredTopics(): OutlookTheme[] {
  const raw = getConfig(TOPICS_KV_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => {
        const theme: OutlookTheme = {
          topic: typeof t.topic === 'string' ? t.topic : '',
          note: typeof t.note === 'string' ? t.note : '',
        };
        if (typeof t.room === 'string') theme.room = t.room;
        if (typeof t.threadId === 'string') theme.threadId = t.threadId;
        if (typeof t.lastActivityAt === 'number') theme.lastActivityAt = t.lastActivityAt;
        return theme;
      })
      .filter((t) => t.topic);
  } catch {
    return [];
  }
}

/** Read the authored needsYou items from KV, tolerating missing/malformed JSON. */
export function readAuthoredNeedsYou(): OutlookNeedsYouItem[] {
  const raw = getConfig(NEEDS_YOU_KV_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
      .map((n) => ({
        kind: n.kind === 'decision' ? 'decision' : 'notice',
        text: typeof n.text === 'string' ? n.text : '',
      } as OutlookNeedsYouItem))
      .filter((n) => n.text);
  } catch {
    return [];
  }
}

// --- Author lifecycle (its OWN rhythm, NOT the poller's tick) ---------------

// Per tenant (tenantLocal): each tenant has its own author timer and its own in-flight guard; tenancy off, the one module value as before.
// `stopped` is the fence a stop leaves: an author pass already in flight neither reschedules, nor starts a model call, nor stores after it (a park closes the database).
const authorLocal = tenantLocal<{ timer: NodeJS.Timeout | null; authoring: boolean; stopped: boolean }>(() => ({ timer: null, authoring: false, stopped: false }));

/** An author pass is in flight (the timer's, or a manual one). It runs outside the agent queue, so a park counts it as a running turn. */
export function isOutlookAuthorRunning(): boolean {
  return authorLocal.get().authoring;
}

/** Force a re-author NOW (manual path, behind POST /api/outlook/reauthor).
 *  Deduplicates against an in-flight run. Returns whether output was stored. */
export async function authorOutlookNow(): Promise<boolean> {
  const st = authorLocal.get();
  if (st.authoring) return false;
  st.authoring = true;
  try {
    return await authorOutlook();
  } finally {
    st.authoring = false;
  }
}

/** Start the author loop on its OWN slow rhythm. Resilient + self-rescheduling:
 *  on success → next run in OUTLOOK_AUTHOR_INTERVAL_MS; on failure → back off
 *  AUTHOR_BACKOFF_MS so a hiccup never re-fires every tick. The timer is
 *  .unref()'d so it never holds the event loop open on its own. Idempotent. */
export function startOutlookAuthor(): void {
  const st = authorLocal.get();
  if (st.timer) return;
  st.stopped = false;

  const runOnce = async () => {
    let ok = false;
    try {
      ok = await authorOutlookNow();
    } catch (err) {
      // authorOutlook never throws, but belt-and-suspenders: a fault here must
      // not crash the process — log and treat as a failure (→ backoff).
      console.error('[outlook-author] run faulted:', err instanceof Error ? err.message : err);
      ok = false;
    }
    if (st.stopped) return; // stop() came while the pass ran: no new timer for a retired runtime
    schedule(ok ? OUTLOOK_AUTHOR_INTERVAL_MS : AUTHOR_BACKOFF_MS);
  };

  const schedule = (delayMs: number) => {
    if (st.stopped) return;
    if (st.timer) clearTimeout(st.timer);
    // Tenant mode: the run happens as the tenant that started the loop (bindCurrentTenant is the function itself with tenancy off).
    const timer = setTimeout(bindCurrentTenant(() => { void runOnce(); }), delayMs);
    st.timer = timer;
    if (typeof timer.unref === 'function') timer.unref();
  };

  // Kick a first author shortly after boot (not instantly — let the logistics
  // poller + MCP connect first), then settle into the slow rhythm.
  schedule(60 * 1000); // 1 min after start
  console.log(
    `[outlook-author] author started (every ${Math.round(OUTLOOK_AUTHOR_INTERVAL_MS / 3600000)}h, ` +
    `backoff ${Math.round(AUTHOR_BACKOFF_MS / 60000)}m, model ${AUTHOR_MODEL()})`,
  );
}

/** Stop the author loop (graceful shutdown). */
export function stopOutlookAuthor(): void {
  const st = authorLocal.get();
  st.stopped = true;
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
}
