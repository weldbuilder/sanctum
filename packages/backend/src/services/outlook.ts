// ===========================================================================
// House Outlook — assembly service
// ---------------------------------------------------------------------------
// "Walking into the house and feeling the current state." ONE HouseSnapshot is
// assembled on a rhythm from many LIVE sources, cached in memory (+ a config KV
// row for restart-survival), and served at GET /api/outlook.
//
// DESIGN INVARIANTS:
//   - PER-SOURCE ISOLATION. Each source is fetched in its OWN try/catch. A dead
//     source NEVER blanks the board: on failure we keep the LAST good data for
//     that section and mark `sources[name]` stale/error. One source's outage
//     cannot throw the whole assembly.
//   - BACKOFF. After a source fails, it gets a `retryAfter` (epoch ms). The
//     poller skips re-fetching that source until then, so a flaky upstream can't
//     burn a call every tick. Cleared on the next success.
//   - CACHE. The last good snapshot lives in module memory and is mirrored to a
//     `config` KV row (`outlook_snapshot`) so a restart serves the last board
//     immediately while the first fresh poll runs.
//
// Mirrors the status/stale/error + retry-backoff discipline of the cloud
// sanctum `home/outlook.ts`, but built clean for the per-source model this
// board needs. The LLM "themes digest" is a LATER phase (Phase 4) — `us.themes`
// is an empty array here.
// ===========================================================================

import type {
  HouseSnapshot,
  OutlookOrb,
  OutlookPresence,
  OutlookSourceStatus,
  OutlookScratchpadNote,
  OutlookTheme,
  OutlookNeedsYouItem,
  OutlookRoom,
  OutlookRecentThread,
  OutlookRecentAction,
  OutlookHouseSystems,
  McpServerInfo,
} from '@sanctum/shared';
import {
  getConfig,
  setConfig,
  getConfigsByPrefix,
  getDb,
  listSections,
  listPendingTimers,
  getActiveTriggers,
} from './db.js';
import { getSanctumConfig } from '../config.js';
import { bindCurrentTenant, tenantLocal } from '../tenancy/context.js';
import {
  getCareEntries,
  getCycleStatus,
  listCountdowns,
  listEvents,
  listScratchpadNotes,
  type CareEntry,
} from './cc.js';
import { listUpcomingEvents, listOpenTasks, listGmailMessages } from './google.js';
import { readHealthSummary } from '../routes/workspace-mcp.js';
import {
  readAuthoredPresence,
  readAuthoredTopics,
  readAuthoredNeedsYou,
} from './outlook-author.js';
import { registry } from './ws.js';

/** Minimal shapes the poller reads from the agent/orchestrator singletons for
 *  the houseSystems vitals. Kept structural (not the concrete classes) so this
 *  module stays free of a hard dependency cycle on agent.ts/orchestrator.ts. */
export interface OutlookVitalProviders {
  /** The agent service — for MCP server status. */
  agent?: { getMcpStatus(): McpServerInfo[] };
  /** The orchestrator — for routine/pulse/failsafe vitals. */
  orchestrator?: {
    getStatus(): Promise<Array<{ category: string; status: string; enabled: boolean }>>;
    getPulseConfig(): { enabled: boolean; frequency: number };
    getFailsafeConfig(): { enabled: boolean; gentle: number; concerned: number; emergency: number };
  };
}

// --- Tuning constants -------------------------------------------------------

/** How often the poller reassembles the snapshot while a client is connected. */
const POLL_INTERVAL_MS = 2.5 * 60 * 1000; // 2.5 min
/** How long nobody has to be connected before the poller backs off. */
const IDLE_AFTER_MS = 15 * 60 * 1000; // 15 min
/** Assembly cadence while idle (5× slower). NEVER zero — watchers/whisper
 *  (her.state.latest, triggers, the mind's sensorium push) need a heartbeat
 *  even when the house is dark. */
const IDLE_POLL_INTERVAL_MS = 12.5 * 60 * 1000; // 12.5 min
/** Slack so ordinary setInterval jitter can't skip an on-time assembly. */
const TICK_JITTER_MS = 10 * 1000;
/** Even when the snapshot content hasn't changed, refresh the KV mirror this
 *  often — bounds how stale the restart-survival copy can drift while the
 *  house is quiet. */
const KV_HEARTBEAT_MS = 30 * 60 * 1000; // 30 min
/** After a source fails, don't retry it until this long has passed. */
const SOURCE_BACKOFF_MS = 10 * 60 * 1000; // 10 min
/** KV config key the last good snapshot is mirrored to (restart survival). */
const SNAPSHOT_KV_KEY = 'outlook_snapshot';
/** The context digest declares its own age once the snapshot is older than this. */
const DIGEST_STALE_NOTE_MS = 30 * 60 * 1000; // 30 min
/** A KV-restored snapshot older than this is a fossil — assemble fresh instead
 *  of serving it as the current house. */
const KV_RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 h

// --- In-memory cache --------------------------------------------------------

// Per tenant (tenantLocal): one cache, one poller and one in-flight assembly for each tenant's database; tenancy off, the one module value as before.
interface OutlookState {
  cachedSnapshot: HouseSnapshot | null;
  pollTimer: NodeJS.Timeout | null;
  assembling: Promise<HouseSnapshot> | null;
  /** When the last assembly completed (any caller — poller, refresh, getOutlook). */
  lastAssembledAt: number;
  /** When the poller first observed nobody connected; null while a client is on. */
  disconnectedSince: number | null;
  /** Fingerprint of the last KV-persisted snapshot (volatile stamps stripped) — the write-on-change gate. */
  lastKvFingerprint: string | null;
  /** When the KV mirror was last actually written. */
  lastKvWriteAt: number;
  /** Whether the LAST assembly completed (the poller's own health → houseSystems.pollerOk). */
  pollerOk: boolean;
  /** Injected at startOutlookPoller() — the agent/orchestrator singletons the houseSystems vitals read from. Empty until the server wires them. */
  vitalProviders: OutlookVitalProviders;
}
const outlookLocal = tenantLocal<OutlookState>(() => ({
  cachedSnapshot: null, pollTimer: null, assembling: null, lastAssembledAt: 0, disconnectedSince: null,
  lastKvFingerprint: null, lastKvWriteAt: 0, pollerOk: false, vitalProviders: {},
}));
const outlookState = (): OutlookState => outlookLocal.get();

// --- Helpers ----------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function today(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: getSanctumConfig().identity.timezone,
  });
}

function defaultPerson(): string {
  return getSanctumConfig().command_center.default_person;
}

/** An empty snapshot skeleton — the starting point before any source fills. */
function emptySnapshot(): HouseSnapshot {
  return {
    generatedAt: nowIso(),
    hearth: { orb: null, presence: null },
    you: { mood: null, body: null, care: null },
    us: { themes: [], countdowns: [] },
    day: { events: [], tasks: [], mailNeedsReply: [] },
    needsYou: [],
    rooms: [],
    recentThreads: [],
    recentActions: [],
    houseSystems: { mcp: [], organs: {}, pollerOk: false },
    scratchpad: [],
    sources: {},
  };
}

/**
 * Run one source reader under isolation + backoff.
 *
 * - If the source is in backoff (its prior `retryAfter` is still in the future),
 *   we SKIP the fetch entirely and carry the prior status + prior data.
 * - On success: `apply(value)` mutates the draft, status → 'ok', updatedAt → now.
 * - On failure: the draft section is LEFT AS-IS (last good data is preserved by
 *   seeding the draft from the cache before polling), status → 'stale'|'error',
 *   updatedAt keeps the last successful time, and a fresh `retryAfter` is set.
 */
async function runSource<T>(
  draft: HouseSnapshot,
  prev: HouseSnapshot | null,
  name: string,
  fetcher: () => Promise<T>,
  apply: (value: T, draft: HouseSnapshot) => void,
): Promise<void> {
  const prevStatus = prev?.sources[name];
  const now = Date.now();

  // Respect an active backoff window — carry prior status/data untouched.
  if (prevStatus?.retryAfter && now < prevStatus.retryAfter) {
    draft.sources[name] = prevStatus;
    return;
  }

  try {
    const value = await fetcher();
    apply(value, draft);
    const status: OutlookSourceStatus = { status: 'ok', updatedAt: nowIso() };
    draft.sources[name] = status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep the LAST good updatedAt if we ever succeeded; otherwise mark now.
    const lastUpdatedAt = prevStatus?.updatedAt ?? nowIso();
    // 'stale' if we have prior good data to show, 'error' if we never did.
    const hadData = !!prevStatus && prevStatus.status !== 'error';
    draft.sources[name] = {
      status: hadData ? 'stale' : 'error',
      updatedAt: lastUpdatedAt,
      error: message,
      retryAfter: now + SOURCE_BACKOFF_MS,
    };
  }
}

// --- Source readers ---------------------------------------------------------
// Each reader is a thin adapter over an EXISTING source function. No fetch logic
// is reimplemented here.

/** hearth.orb — from the mantelpiece config rows (`context.companion.orb_*`). */
function readOrb(): OutlookOrb | null {
  const raw = getConfigsByPrefix('context.companion.');
  const color = raw['context.companion.orb_color'];
  if (!color) return null;
  const orb: OutlookOrb = { color };
  const motion = raw['context.companion.orb_motion'];
  const expression = raw['context.companion.expression'];
  if (motion) orb.motion = motion;
  if (expression) orb.expression = expression;
  // Pass through ALL five orb dimensions — shape/intensity/blend included, and
  // a fracture (unacked startle) is the loudest signal in the mapping; the
  // cockpit must not flatten it to a sphere.
  const shape = raw['context.companion.orb_shape'];
  const intensity = raw['context.companion.orb_intensity'];
  const blend = raw['context.companion.orb_blend'];
  if (shape) orb.shape = shape;
  if (intensity) orb.intensity = intensity;
  if (blend) orb.blend = blend;
  return orb;
}

/** hearth.presence — the companion's AUTHORED presence (the author service writes the
 *  `outlook_presence` KV row on its slow rhythm; this READS it). Null when
 *  unset or malformed. Parse + guard live in outlook-author.ts so the write and
 *  read sides share one normalizer. */
function readPresence(): OutlookPresence | null {
  return readAuthoredPresence();
}

/** us.themes — the companion's AUTHORED topics ("what we've been circling"). The author
 *  writes the `outlook_topics` KV row; this READS it. */
function readThemes(): OutlookTheme[] {
  return readAuthoredTopics();
}

/** snapshot.needsYou — the companion's AUTHORED "things asking for you" (decisions +
 *  notices). The author writes the `outlook_needsYou` KV row; this READS it. */
function readNeedsYou(): OutlookNeedsYouItem[] {
  return readAuthoredNeedsYou();
}

/** snapshot.rooms — the House panel. Sections (each with its thread count +
 *  last activity), the daily stream as one room, and a loose/uncategorized
 *  bucket for named threads with no section. Pure SQLite, never throws. */
function readRooms(): OutlookRoom[] {
  const db = getDb();
  const rooms: OutlookRoom[] = [];

  // Per-section named-thread rooms.
  const sections = listSections();
  for (const s of sections) {
    const agg = db.prepare(
      `SELECT COUNT(*) AS c, MAX(last_activity_at) AS last
         FROM threads
        WHERE section_id = ? AND archived_at IS NULL AND type = 'named'`
    ).get(s.id) as { c: number; last: string | null };
    rooms.push({
      id: s.id,
      name: s.name,
      kind: 'section',
      threadCount: agg.c,
      lastActivityAt: agg.last ? Date.parse(agg.last) : null,
    });
  }

  // The daily stream as one room.
  const daily = db.prepare(
    `SELECT COUNT(*) AS c, MAX(last_activity_at) AS last
       FROM threads WHERE type = 'daily' AND archived_at IS NULL`
  ).get() as { c: number; last: string | null };
  rooms.push({
    id: '__daily',
    name: 'Daily',
    kind: 'daily',
    threadCount: daily.c,
    lastActivityAt: daily.last ? Date.parse(daily.last) : null,
  });

  // Uncategorized — named threads with no section.
  const loose = db.prepare(
    `SELECT COUNT(*) AS c, MAX(last_activity_at) AS last
       FROM threads
      WHERE type = 'named' AND section_id IS NULL AND archived_at IS NULL`
  ).get() as { c: number; last: string | null };
  if (loose.c > 0) {
    rooms.push({
      id: '__uncategorized',
      name: 'Loose',
      kind: 'uncategorized',
      threadCount: loose.c,
      lastActivityAt: loose.last ? Date.parse(loose.last) : null,
    });
  }

  return rooms;
}

/** snapshot.recentThreads — the recent-threads rail. Most-recent first, with the
 *  room (section name / Daily / Loose) each lives in. Pure SQLite. */
function readRecentThreads(): OutlookRecentThread[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT t.id, t.name, t.type, t.last_activity_at AS last, s.name AS sectionName
       FROM threads t
       LEFT JOIN sections s ON s.id = t.section_id
      WHERE t.archived_at IS NULL
      ORDER BY t.last_activity_at DESC
      LIMIT 8`
  ).all() as Array<{
    id: string; name: string; type: string; last: string | null; sectionName: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    roomName: r.type === 'daily' ? 'Daily' : (r.sectionName ?? 'Loose'),
    lastActivityAt: r.last ? Date.parse(r.last) : null,
  }));
}

/** snapshot.recentActions — recent companion actions from the proprioceptive
 *  log. `success` is inferred from the kind (errors are logged as a 'error'/
 *  'failed' kind by convention); default true. `threadName` is left null —
 *  companion_actions doesn't carry a thread id. Pure SQLite. */
function readRecentActions(): OutlookRecentAction[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT kind, summary, created_at AS createdAt
       FROM companion_actions
      ORDER BY created_at DESC
      LIMIT 12`
  ).all() as Array<{ kind: string; summary: string; createdAt: string }>;
  return rows.map((r) => {
    const lower = r.kind.toLowerCase();
    const success = !(lower.includes('error') || lower.includes('fail'));
    return {
      kind: r.kind,
      summary: r.summary,
      success,
      createdAt: Date.parse(r.createdAt),
      threadName: null,
    };
  });
}

/** snapshot.houseSystems — OUR vitals (NOT Cloudflare). MCP from the agent
 *  service; organs (routines/timers/watches/pulse/failsafe) from the
 *  orchestrator + organ tables; pollerOk from this poller's own health. */
async function readHouseSystems(): Promise<OutlookHouseSystems> {
  const out: OutlookHouseSystems = { mcp: [], organs: {}, pollerOk: outlookState().pollerOk };

  // MCP servers — from the agent service's cached status.
  const vitalProviders = outlookState().vitalProviders;
  if (vitalProviders.agent) {
    out.mcp = vitalProviders.agent.getMcpStatus().map((m) => ({
      name: m.name,
      status: m.status,
      toolCount: m.toolCount,
    }));
  }

  // Organs from the orchestrator (routines / pulse / failsafe).
  if (vitalProviders.orchestrator) {
    try {
      const tasks = await vitalProviders.orchestrator.getStatus();
      const routineTasks = tasks.filter((t) => t.category === 'routine');
      out.organs.routines = {
        enabled: routineTasks.some((t) => t.enabled),
        count: routineTasks.filter((t) => t.status === 'scheduled').length,
      };
    } catch { /* orchestrator status is best-effort */ }

    try {
      const pulse = vitalProviders.orchestrator.getPulseConfig();
      out.organs.pulse = {
        enabled: pulse.enabled,
        detail: pulse.enabled ? `every ${pulse.frequency}m` : undefined,
      };
    } catch { /* best-effort */ }

    try {
      const fs = vitalProviders.orchestrator.getFailsafeConfig();
      out.organs.failsafe = {
        enabled: fs.enabled,
        detail: fs.enabled ? `gentle ${fs.gentle}m` : undefined,
      };
    } catch { /* best-effort */ }
  }

  // Timers (pending) + watches (active 'watcher' triggers) from organ tables.
  try {
    out.organs.timers = { count: listPendingTimers().length };
  } catch { /* best-effort */ }
  try {
    const watches = getActiveTriggers().filter((t) => t.kind === 'watcher');
    out.organs.watches = { count: watches.length };
  } catch { /* best-effort */ }

  out.pollerOk = outlookState().pollerOk;
  return out;
}

/** you.mood — today's `mood` care entry for the default person, if any. */
function readMood(): string | null {
  const entries = getCareEntries(today(), defaultPerson());
  const mood = entries.find((e) => e.category === 'mood');
  if (!mood) return null;
  return [mood.value, mood.note].filter(Boolean).join(' ') || null;
}

/** you.care — today's care toggles/ratings summarized for the default person. */
function readCare(): { label: string; done: boolean }[] {
  const entries = getCareEntries(today(), defaultPerson());
  return entries
    .filter((e: CareEntry) => e.category !== 'mood')
    .map((e) => ({
      label: e.category,
      // A boolean toggle is stored as the string 'true'; ratings/values count as
      // "done" when present at all.
      done: e.value === 'true' || (e.value !== null && e.value !== ''),
    }));
}

/** us.countdowns — next few upcoming countdowns from CC. */
function readCountdowns(): { label: string; when: string; daysAway?: number }[] {
  return listCountdowns()
    .filter((c) => typeof c.days_until !== 'number' || c.days_until >= 0)
    .slice(0, 5)
    .map((c) => ({
      label: c.title as string,
      when: c.target_date as string,
      daysAway: typeof c.days_until === 'number' ? c.days_until : undefined,
    }));
}

/** scratchpad — all persistent notes from the scratchpad_notes table, newest
 *  first. A failing read returns an empty array (error boundary in runSource). */
function readScratchpad(): OutlookScratchpadNote[] {
  return listScratchpadNotes()
    .reverse() // listScratchpadNotes returns ASC; we want newest first on the panel
    .map((n) => ({
      id: n.id as string,
      text: n.text as string,
      createdBy: (n.created_by ?? 'companion') as string,
      createdAt: (n.created_at ?? new Date().toISOString()) as string,
    }));
}

/** day.events — today's calendar. Google first (if connected), then merge the
 *  local CC events so the board is never empty just because Google isn't wired.
 *  A Google failure here throws so the source is marked stale; the CC events are
 *  applied unconditionally up front. */
async function readEvents(): Promise<{ time: string; title: string; allDay?: boolean }[]> {
  const out: { time: string; title: string; allDay?: boolean }[] = [];

  // Local CC events for today (never throws on connection — pure SQLite).
  const day = today();
  for (const e of listEvents({ start_date: day, end_date: day })) {
    out.push({
      time: e.all_day ? 'all-day' : (e.start_time ?? ''),
      title: e.title,
      allDay: !!e.all_day,
    });
  }

  // Google calendar for the rest of today (may throw if not connected/granted →
  // marks the source stale, CC events above still render).
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const gcal = await listUpcomingEvents({ timeMax: end.toISOString(), maxResults: 20 });
  for (const e of gcal) {
    out.push({
      time: e.allDay ? 'all-day' : (e.start ?? ''),
      title: e.summary,
      allDay: e.allDay,
    });
  }
  return out;
}

/** day.tasks — open Google Tasks. */
async function readTasks(): Promise<{ title: string; due?: string }[]> {
  const tasks = await listOpenTasks({ maxResults: 20 });
  return tasks.map((t) => ({
    title: t.title,
    due: t.due ?? undefined,
  }));
}

/** day.mailNeedsReply — recent unread inbox mail (a light "needs reply" proxy). */
async function readMail(): Promise<{ from: string; subject: string }[]> {
  const msgs = await listGmailMessages({ query: 'in:inbox is:unread', maxResults: 10 });
  return msgs.map((m) => ({ from: m.from, subject: m.subject }));
}

/** you.body — structured Google Health read (last sleep + HRV + cycle phase). */
async function readBody(): Promise<{ sleepSummary?: string; sleepMin?: number; hrvMs?: number; cyclePhase?: string }> {
  const h = await readHealthSummary();
  const body: { sleepSummary?: string; sleepMin?: number; hrvMs?: number; cyclePhase?: string } = {};
  if (h.sleepSummary) body.sleepSummary = h.sleepSummary;
  if (h.sleepMin !== null) body.sleepMin = h.sleepMin;
  if (h.hrvMs !== null) body.hrvMs = h.hrvMs;
  if (h.cyclePhase) body.cyclePhase = h.cyclePhase;
  return body;
}

/** Content fingerprint of a snapshot with the always-changing stamps stripped
 *  (generatedAt + per-source updatedAt/retryAfter), so "nothing in the house
 *  actually moved" is detectable across ticks. Status + error text stay in —
 *  a source flipping ok→stale IS a change worth persisting. */
function snapshotFingerprint(snap: HouseSnapshot): string {
  const clone = structuredClone(snap);
  clone.generatedAt = '';
  for (const status of Object.values(clone.sources)) {
    status.updatedAt = '';
    delete status.retryAfter;
  }
  return JSON.stringify(clone);
}

// --- Assembly ---------------------------------------------------------------

/** Assemble one fresh HouseSnapshot. Per-source isolated; never throws as a
 *  whole. Seeds the draft from the prior cache so failing sources keep their
 *  last good data. */
async function assemble(): Promise<HouseSnapshot> {
  const prev = outlookState().cachedSnapshot;
  // Seed the draft from prior data so a failing source carries forward.
  const draft: HouseSnapshot = prev
    ? structuredClone(prev)
    : emptySnapshot();
  draft.generatedAt = nowIso();

  // Synchronous local sources (SQLite / config) — wrapped for uniform status.
  await runSource(draft, prev, 'orb', async () => readOrb(), (v, d) => { d.hearth.orb = v; });
  await runSource(draft, prev, 'presence', async () => readPresence(), (v, d) => { d.hearth.presence = v; });
  await runSource(draft, prev, 'mood', async () => readMood(), (v, d) => { d.you.mood = v; });
  await runSource(draft, prev, 'care', async () => readCare(), (v, d) => { d.you.care = v; });
  await runSource(draft, prev, 'countdowns', async () => readCountdowns(), (v, d) => { d.us.countdowns = v; });

  // AUTHORED layer (written by the slow Sonnet author into config KV; this folds
  // the latest authoring into the snapshot). Pure SQLite reads — never block.
  await runSource(draft, prev, 'themes', async () => readThemes(), (v, d) => { d.us.themes = v; });
  await runSource(draft, prev, 'needsYou', async () => readNeedsYou(), (v, d) => { d.needsYou = v; });

  // House panel + proprioception (pure SQLite, isolated for uniform status).
  await runSource(draft, prev, 'rooms', async () => readRooms(), (v, d) => { d.rooms = v; });
  await runSource(draft, prev, 'recentThreads', async () => readRecentThreads(), (v, d) => { d.recentThreads = v; });
  await runSource(draft, prev, 'recentActions', async () => readRecentActions(), (v, d) => { d.recentActions = v; });
  await runSource(draft, prev, 'scratchpad', async () => readScratchpad(), (v, d) => { d.scratchpad = v; });

  // Async remote sources (Google / Health) — isolated + backed off on failure.
  await runSource(draft, prev, 'body', readBody, (v, d) => { d.you.body = v; });
  await runSource(draft, prev, 'events', readEvents, (v, d) => { d.day.events = v; });
  await runSource(draft, prev, 'tasks', readTasks, (v, d) => { d.day.tasks = v; });
  await runSource(draft, prev, 'mail', readMail, (v, d) => { d.day.mailNeedsReply = v; });

  // OUR house vitals (MCP + organs + poller health). Reads the agent/orchestrator
  // singletons injected at startOutlookPoller(); falls back to empties when unwired.
  await runSource(draft, prev, 'houseSystems', readHouseSystems, (v, d) => { d.houseSystems = v; });

  // The poller completed an assembly → it is healthy. Reflect it in the vitals
  // we just wrote (readHouseSystems samples pollerOk BEFORE this flips, so set it
  // on the draft directly too for the very first assembly).
  outlookState().pollerOk = true;
  draft.houseSystems.pollerOk = true;

  outlookState().cachedSnapshot = draft;
  outlookState().lastAssembledAt = Date.now();
  // Mirror to KV for restart survival (best-effort) — WRITE-ON-CHANGE (audit
  // win #3, 2026-07-03): skip the row rewrite when nothing but the timestamps
  // moved, with a 30-min heartbeat write so the mirror's generatedAt (read by
  // getOutlook's 6h restore gate) never drifts more than KV_HEARTBEAT_MS
  // behind reality.
  try {
    const fingerprint = snapshotFingerprint(draft);
    const now = Date.now();
    if (fingerprint !== outlookState().lastKvFingerprint || now - outlookState().lastKvWriteAt >= KV_HEARTBEAT_MS) {
      setConfig(SNAPSHOT_KV_KEY, JSON.stringify(draft));
      outlookState().lastKvFingerprint = fingerprint;
      outlookState().lastKvWriteAt = now;
    }
  } catch (err) {
    console.error('[outlook] failed to persist snapshot to KV:', err);
  }

  // Her state → the whisper (CC-SENSES Lane 2, 2026-07-02). Distill the fresh
  // snapshot into the `her.state.latest` config cache — the mirror of
  // `mind.weather.latest` that hooks.ts reads synchronously to ride the
  // per-turn [env] line. A sensor failure here must NEVER break the snapshot:
  // the whole derivation is best-effort garnish.
  try {
    // sleepMin rides you.body at RUNTIME (readBody writes it, the draft-seed
    // carry preserves it across body-source backoff) but stays off the shared
    // OutlookBody type for now — backend resolves @sanctum/shared via its
    // built dist .d.ts, and this build must not rebuild shared.
    const body = draft.you.body as ((typeof draft.you.body) & { sleepMin?: number }) | null;
    const state: {
      sleepMin: number | null;
      sleepLine: string | null;
      cycle: { day: number | null; phase: string; source: 'cc' | 'heuristic' } | null;
      nextEvent: { title: string; time: string } | null;
      lastMealAt: string | null;
      at: string;
    } = {
      sleepMin: typeof body?.sleepMin === 'number' ? body.sleepMin : null,
      sleepLine: body?.sleepSummary ?? null,
      cycle: null,
      nextEvent: null,
      lastMealAt: null,
      at: nowIso(),
    };

    // Cycle — CC's tracked cycle wins when the cycles table has rows; the
    // health heuristic (you.body.cyclePhase) is the fallback.
    try {
      const cc = getCycleStatus();
      if (!cc.noData && typeof cc.cycleDay === 'number' && cc.phase) {
        state.cycle = { day: cc.cycleDay, phase: String(cc.phase), source: 'cc' };
      }
    } catch { /* cycle read is best-effort */ }
    if (!state.cycle) {
      const phase = body?.cyclePhase;
      if (phase && phase !== 'insufficient_history') {
        state.cycle = { day: null, phase, source: 'heuristic' };
      }
    }

    // Next event — first upcoming TIMED event from today's board. CC rows
    // carry "HH:MM(:SS)"; Google rows carry ISO datetimes. Both normalize to
    // "HH:MM" in the house timezone so string comparison against now works.
    const tz = getSanctumConfig().identity.timezone;
    const nowHm = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
    });
    const timed = draft.day.events
      .filter((e) => !e.allDay && e.time && e.time !== 'all-day')
      .map((e) => {
        const hm = /^\d{2}:\d{2}/.test(e.time)
          ? e.time.slice(0, 5)
          : Number.isFinite(Date.parse(e.time))
            ? new Date(e.time).toLocaleTimeString('en-GB', {
                hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
              })
            : null;
        return hm ? { title: e.title, time: hm } : null;
      })
      .filter((e): e is { title: string; time: string } => e !== null && e.time >= nowHm)
      .sort((a, b) => a.time.localeCompare(b.time));
    if (timed.length > 0) state.nextEvent = timed[0];

    // Last meal — today's latest meal-ish care entry, straight from SQLite
    // (tolerant of a missing table). created_at is UTC `datetime('now')`
    // without a zone marker; normalize to real ISO before caching.
    try {
      const row = getDb().prepare(
        `SELECT MAX(created_at) AS last FROM care_entries
          WHERE date = ? AND category IN ('breakfast','lunch','dinner','meal','snack')`,
      ).get(today()) as { last: string | null } | undefined;
      if (row?.last) {
        const parsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(row.last)
          ? new Date(`${row.last.replace(' ', 'T')}Z`)
          : new Date(row.last);
        if (!Number.isNaN(parsed.getTime())) state.lastMealAt = parsed.toISOString();
      }
    } catch { /* meal read is best-effort */ }

    setConfig('her.state.latest', JSON.stringify(state));
  } catch { /* her-state cache is garnish — never breaks the snapshot */ }

  return draft;
}

/** Assemble, deduplicating concurrent callers onto one in-flight assembly. */
async function assembleOnce(): Promise<HouseSnapshot> {
  const st = outlookState();
  if (st.assembling) return st.assembling;
  const run = assemble().finally(() => { st.assembling = null; });
  st.assembling = run;
  return run;
}

// --- Public API -------------------------------------------------------------

/** Get the cached snapshot, assembling on first call if the cache is empty. */
export async function getOutlook(): Promise<HouseSnapshot> {
  const cached = outlookState().cachedSnapshot;
  if (cached) return cached;
  // Try the KV mirror first (restart survival) before a full assembly — but
  // only when it's recent enough to stand in for "the house right now". A
  // fossil (server down 6h+) posing as current is worse than waiting for the
  // fresh assembly. generatedAt is stamped on every assemble().
  const stored = getConfig(SNAPSHOT_KV_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as HouseSnapshot;
      const ageMs = Date.now() - Date.parse(parsed.generatedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= KV_RESTORE_MAX_AGE_MS) {
        outlookState().cachedSnapshot = parsed;
        return parsed;
      }
      console.log(
        `[outlook] KV snapshot too old to restore as current (${Number.isFinite(ageMs) ? `${Math.round(ageMs / 3600000)}h` : 'unparseable generatedAt'}) — assembling fresh`,
      );
    } catch {
      /* fall through to fresh assembly */
    }
  }
  return assembleOnce();
}

/** Force a fresh re-poll (manual refresh button + dev). Returns the new snapshot. */
export async function refreshOutlook(): Promise<HouseSnapshot> {
  return assembleOnce();
}

/** Start the background poller. Resilient: a poll error logs and reschedules,
 *  never crashes the process. Idempotent — calling twice is a no-op.
 *
 *  `providers` injects the agent/orchestrator singletons the houseSystems vitals
 *  read from. Optional so tests/headless boots can start the poller bare (vitals
 *  degrade to empties, not an error). */
export function startOutlookPoller(providers?: OutlookVitalProviders): void {
  const st = outlookState();
  if (providers) st.vitalProviders = providers;
  if (st.pollTimer) return;

  const tick = async () => {
    try {
      // Presence gate (audit win #3, 2026-07-03): full cadence while a client
      // is connected; once nobody has been connected for IDLE_AFTER_MS, back
      // off to IDLE_POLL_INTERVAL_MS. Never a full stop — the whisper cache
      // (her.state.latest), triggers, and the mind's sensorium keep getting a
      // heartbeat while the user is away. The timer keeps its 2.5-min beat and
      // this gate decides whether an assembly is due, so the first tick after
      // a reconnect snaps straight back to full cadence (board fresh within
      // one POLL_INTERVAL_MS of the user walking in).
      if (registry.isUserConnected()) {
        st.disconnectedSince = null;
      } else if (st.disconnectedSince === null) {
        st.disconnectedSince = Date.now();
      }
      const idle = st.disconnectedSince !== null && Date.now() - st.disconnectedSince >= IDLE_AFTER_MS;
      const dueInterval = idle ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
      if (Date.now() - st.lastAssembledAt < dueInterval - TICK_JITTER_MS) return;
      await assembleOnce();
    } catch (err) {
      // assemble() is per-source isolated, so this only fires on an unexpected
      // top-level fault. Mark the poller unhealthy, log, and keep the rhythm.
      st.pollerOk = false;
      console.error('[outlook] poll tick failed:', err);
    }
  };

  // Kick an immediate first assembly, then settle into the interval (tenant mode: the tick runs as the tenant that started the poller).
  void tick();
  const timer = setInterval(bindCurrentTenant(() => { void tick(); }), POLL_INTERVAL_MS);
  st.pollTimer = timer;
  // Don't keep the event loop alive solely for the poller.
  if (typeof timer.unref === 'function') timer.unref();
  console.log(
    `[outlook] poller started (every ${Math.round(POLL_INTERVAL_MS / 1000)}s connected, ` +
    `every ${Math.round(IDLE_POLL_INTERVAL_MS / 1000)}s after ${Math.round(IDLE_AFTER_MS / 60000)}m idle)`,
  );
}

/** Stop the poller (graceful shutdown). */
export function stopOutlookPoller(): void {
  const st = outlookState();
  if (st.pollTimer) {
    clearInterval(st.pollTimer);
    st.pollTimer = null;
  }
}

// --- Context digest seam (the last rail — WIRED 2026-07-02) ------------------
// A condensed text form of the snapshot, folded into the SESSION-mode
// orientation by hooks.ts buildOrientationContext — once per session, never
// per turn (context-rot lesson). The companion starts every session carrying the
// house instead of just displaying it. Kept next to the snapshot it digests.
export function snapshotToContextDigest(snapshot: HouseSnapshot): string {
  // Age honesty: once the snapshot stops being "now" (>30 min), the digest
  // says so — a KV-restored or stalled house view can't pass itself off as
  // the live house.
  let header = '[House Outlook]';
  const ageMs = Date.now() - Date.parse(snapshot.generatedAt);
  if (Number.isFinite(ageMs) && ageMs > DIGEST_STALE_NOTE_MS) {
    const mins = Math.round(ageMs / 60000);
    header += mins < 120
      ? ` (house view ${mins}m old)`
      : ` (house view ${Math.round(mins / 60)}h old)`;
  }
  const lines: string[] = [header];
  if (snapshot.hearth.presence?.mood) lines.push(`Presence: ${snapshot.hearth.presence.mood}`);
  if (snapshot.you.mood) lines.push(`User's mood: ${snapshot.you.mood}`);
  if (snapshot.you.body?.sleepSummary) lines.push(`Sleep: ${snapshot.you.body.sleepSummary}`);
  if (snapshot.day.events.length) {
    lines.push(`Today: ${snapshot.day.events.map((e) => e.title).slice(0, 4).join(', ')}`);
  }
  if (snapshot.day.tasks.length) {
    lines.push(`Open tasks: ${snapshot.day.tasks.length}`);
  }
  if (snapshot.needsYou.length) {
    lines.push(`Asking for the user: ${snapshot.needsYou.map((n) => n.text).slice(0, 3).join(' | ')}`);
  }
  // Next countdown — readCountdowns emits { label, when, daysAway } (see
  // OutlookCountdown in @sanctum/shared). daysAway can legitimately be
  // undefined (CC row without days_until), so fall back to the target date.
  const nextCountdown = snapshot.us.countdowns?.[0];
  if (nextCountdown?.label) {
    const { label, daysAway, when } = nextCountdown;
    if (typeof daysAway === 'number') {
      lines.push(daysAway === 0 ? `Countdown: ${label} today` : `Countdown: ${label} in ${daysAway}d`);
    } else if (when) {
      lines.push(`Countdown: ${label} (${when})`);
    }
  }
  return lines.join('\n');
}
