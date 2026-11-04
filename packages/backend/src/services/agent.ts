import { query, activeProvider, AbortError, listSessions, type Options, type Query, type McpServerConfig, type ListSessionsOptions } from './providers/index.js';
import { senderIsOwnerFor } from './plugins.js';
import { getRolling, rollingEnabledForActiveProvider } from './rolling-context.js';
import { assembleRollingHistory, conversationBlock } from './rolling-history.js';
import { getInternalToken } from '../middleware/internal-token.js';
import { recallForPrompt, ingestTurn, MEMORY_HEADER } from './revien.js';
import type { McpServerInfo, EffortLevel } from '@sanctum/shared';
import { getFile } from './files.js';
import { createMessage, updateThreadSession, getThread, updateThreadActivity, createSessionRecord, endSessionRecord, setConfig, getConfig } from './db.js';
import { registry } from './ws.js';
import { createHooks, buildOrientationContext, prefetchMindContext, maybeSnapshotTone, type HookContext, type ToolInsertion } from './hooks.js';
import type { MessageSegment } from '@sanctum/shared';
import type { PushService } from './push.js';
import { getSanctumConfig, internalBaseUrl } from '../config.js';
import { loadCompanionIdentity } from '../identity/load.js';
import { setTurnProbe } from './identity/guard.js';
import { describeIdentitySource, renderIdentityPrompt, fillIdentityNames } from '../identity/render.js';
import { applyAuthToEnv, effectiveModel, getAuthPreferences } from './auth-preferences.js';
import { recordUsage } from './usage-log.js';
import { errorClass } from './error-class.js';
import { runEnvOption } from '../tenancy/child.js';
import { listTenantSessions } from '../tenancy/sessions.js';
import { harnessHomes } from '../tenancy/child.js';
import { companionPath } from '../tenancy/house.js';
import { updateBlocking, UpdateBlockedError } from './update-block.js';
import { backgroundRunsOff, currentTenant, envFor, tenancyEnabled, tenantLocal } from '../tenancy/context.js';
import crypto from 'crypto';
import { existsSync } from 'fs';
import { readOwnOrApp, readOwnText, writeThreadFile } from '../tenancy/own-files.js';
import { homeFramePath, resolveFrameFile } from './frame-file.js';
import { join, dirname } from 'path';

/** A finished reply the caller has not let go of yet. Discord asks for this so a reply its gate
 *  withholds is never saved as a companion message, shown on the web, pushed, or handed to memory. */
export interface HeldReply {
  /** The reply, as the model wrote it. */
  text: string;
  /** The reply was sent: save it as the companion message, show it, push it, and (when `ingest`) hand it to memory. Once. */
  commit(): void;
  /** The reply was not sent: drop it. Nothing was saved, shown, pushed or ingested. */
  discard(): void;
}

export interface HoldOptions {
  /** What memory should see as the user's words: the original, without any retry note appended to the prompt. */
  userText: string;
  /** False on the public lane: nothing public enters memory, committed or not. */
  ingest: boolean;
  /** Called once with the held reply, before processMessage returns. Not called when the turn produced nothing. */
  onHeld(reply: HeldReply): void;
}

/** A held turn (Discord) that failed. It carries a short class and nothing else: never the provider's message,
 *  a path or a stack, so it is safe to show the owner and to log. A held turn never returns an error as its
 *  reply: the web shows `[Agent error: ...]` to the owner, but a Discord reply goes out to a room. */
/** Thrown inside a turn that a park caught before its provider call; the turn's own catch turns it into a quiet end, never an error line. */
class ParkedBeforeQuery extends Error { constructor() { super('tenant parked'); this.name = 'ParkedBeforeQuery'; } }

export class AgentTurnError extends Error {
  constructor(readonly kind: string) {
    super(`agent turn failed (${kind})`);
    this.name = 'AgentTurnError';
  }
}

// Lazy-init: config isn't available at import time — defer until first use

/** (Re)load the companion identity from the home's identity folder (services/identity/source.ts, the one
 *  reader every harness uses). Called once from ensureInit and again per query: the folder holds a few
 *  small files, so reading it each time is cheap and an edit applies on the next turn, with no restart.
 *  Failure-tolerant: a read/render error keeps the last good copy instead of blanking the identity mid-flight. */
function refreshCompanionIdentity(): void {
  try {
    const config = getSanctumConfig();
    const identity = loadCompanionIdentity(config, { harness: 'claude' });
    const text = fillIdentityNames(renderIdentityPrompt(identity), config.identity);
    if (text === st().claudeMd) return;
    st().claudeMd = text;
    console.log(`Loaded companion identity from ${describeIdentitySource(identity)} (${st().claudeMd.length} chars)`);
  } catch (err) {
    console.warn('[agent] identity refresh failed — keeping last good copy:', (err as Error).message);
  }
}

function ensureInit() {
  if (st().initialized) return;
  st().initialized = true;
  const config = getSanctumConfig();
  st().agentCwd = config.agent.cwd;

  refreshCompanionIdentity();

  // Optional lean operating frame. When one resolves, frame + CLAUDE.md become the whole
  // system prompt (the claude_code preset is dropped). The same rule Codex and dsh use for
  // their base prompts: <home>/config/companion-claude.md wins, then agent.system_prompt_file.
  // Resolved and read fresh per query so Settings edits apply on the next turn.
  st().systemPromptFile = config.agent.system_prompt_file || '';
  if (activeProvider() === 'claude') {
    const found = resolveFrameFile(config.agent.cwd, st().systemPromptFile);
    if (found.path) {
      console.log(`System-prompt frame active: ${found.path} (claude_code preset replaced)`);
    } else if (st().systemPromptFile) {
      console.warn(`[agent] System-prompt frame file is missing: ${st().systemPromptFile}, and there is no copy at ${homeFramePath(config.agent.cwd)}. The claude_code preset will be used instead (no frame, no [Runtime] model line). Put the harness at ${homeFramePath(config.agent.cwd)} or set agent.system_prompt_file to "" to silence this.`);
    }
  }

  // Load .mcp.json
  const mcpJsonPath = config.agent.mcp_json_path;
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpJson = JSON.parse(readOwnText(mcpJsonPath));
      if (mcpJson.mcpServers) {
        for (const [name, mcpCfg] of Object.entries(mcpJson.mcpServers) as [string, any][]) {
          if (mcpCfg.type === 'url' || mcpCfg.type === 'http') {
            st().mcpServers[name] = { type: 'http', url: mcpCfg.url, headers: mcpCfg.headers };
          } else if (mcpCfg.type === 'sse') {
            st().mcpServers[name] = { type: 'sse', url: mcpCfg.url, headers: mcpCfg.headers };
          } else if (!mcpCfg.type || mcpCfg.type === 'stdio') {
            st().mcpServers[name] = { command: mcpCfg.command, args: mcpCfg.args, env: mcpCfg.env };
          }
        }
        console.log(`Loaded ${Object.keys(st().mcpServers).length} MCP servers from .mcp.json: ${Object.keys(st().mcpServers).join(', ')}`);
      }
    } catch (err) {
      console.warn('Failed to load .mcp.json:', err instanceof Error ? err.message : err);
    }
  }

  // The app's own tool servers, registered by the app itself so nobody has to
  // edit .mcp.json or copy a token: the Command Center tools (when it is on)
  // and the workspace (Google) tools. Claude path only: the Codex transport
  // cannot carry the token header, and Codex reaches the same tools through
  // `res cc` instead. A hand-written entry with the same url wins.
  if (activeProvider() === 'claude' && config.agent.app_write !== false) {
    const base = internalBaseUrl(config.server);
    const headers = { 'x-internal-token': getInternalToken() };
    const builtIns: Array<[string, string]> = [['sanctum-workspace', `${base}/mcp/workspace`]];
    if (config.command_center.enabled) builtIns.unshift(['sanctum-cc', `${base}/mcp/cc`]);
    for (const [name, url] of builtIns) {
      const already = Object.values(st().mcpServers).some((s: any) => s?.url === url);
      if (!already && !st().mcpServers[name]) st().mcpServers[name] = { type: 'http', url, headers };
    }
  }
}

// Presence state

// Context window tracking

// Active query tracking (for abort, MCP control, rewind)

// ---------------------------------------------------------------------------
// QueryQueue — priority-based queue replacing boolean queryLock
// Agent SDK V1 can only run one query at a time, so we queue excess requests
// ---------------------------------------------------------------------------

const PRIORITIES = {
  web_interactive: 0,    // Owner typing in UI
  discord_owner: 1,      // Owner on Discord
  discord_other: 2,      // Other users
  autonomous: 3,         // Orchestrator wakes
} as const;

const MAX_QUEUE_DEPTH = 5;
const QUEUE_TIMEOUT_MS = 90_000;

interface QueueEntry {
  priority: number;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  execute: () => Promise<string>;
  enqueuedAt: number;
  /** A held turn (Discord) must never be handed a busy or timeout line as its reply. */
  rejectInsteadOfReply?: boolean;
}

class QueryQueue {
  private queue: QueueEntry[] = [];
  private running = false;
  /** Set by close() (a park): nothing new is accepted and nothing queued starts. */
  private closed = false;

  /** Close the queue and reject everything still waiting with `err` (the running entry is left to end by its own interrupt). */
  close(err: () => Error): void {
    this.closed = true;
    const waiting = this.queue;
    this.queue = [];
    for (const e of waiting) e.reject(err());
  }

  get isProcessing(): boolean {
    return this.running;
  }

  get depth(): number {
    return this.queue.length;
  }

  async enqueue(priority: number, execute: () => Promise<string>, opts: { rejectInsteadOfReply?: boolean } = {}): Promise<string> {
    if (this.closed) throw new AgentTurnError('tenant_parked');
    // If idle, run immediately
    if (!this.running && this.queue.length === 0) {
      this.running = true;
      try {
        return await execute();
      } finally {
        this.running = false;
        this.processNext();
      }
    }

    // Queue is full — reject
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      if (opts.rejectInsteadOfReply) throw new AgentTurnError('queue_full');
      const cfg = getSanctumConfig();
      return `[${cfg.identity.companion_name} is busy — please try again in a moment]`;
    }

    // Enqueue with priority
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ priority, resolve, reject, execute, enqueuedAt: Date.now(), rejectInsteadOfReply: !!opts.rejectInsteadOfReply });
      // Sort by priority (lower number = higher priority)
      this.queue.sort((a, b) => a.priority - b.priority);
    });
  }

  private async processNext(): Promise<void> {
    if (this.closed) return;
    // Prune timed-out entries
    const now = Date.now();
    this.queue = this.queue.filter(entry => {
      if (now - entry.enqueuedAt > QUEUE_TIMEOUT_MS) {
        if (entry.rejectInsteadOfReply) entry.reject(new AgentTurnError('queue_timeout'));
        else entry.resolve('[Request timed out in queue]');
        return false;
      }
      return true;
    });

    if (this.queue.length === 0) return;

    const next = this.queue.shift()!;
    this.running = true;

    try {
      const result = await next.execute();
      next.resolve(result);
    } catch (err) {
      next.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = false;
      this.processNext();
    }
  }
}

// Everything one companion's agent holds between calls. An AgentService instance owns none of it: this state is tenantLocal, keyed by the
// ALS context the call runs in, so "one AgentService per tenant" is a registration (boot builds one per tenant and puts it in rt.services);
// the isolation comes from the context, not from the instance. Per tenant in tenant mode (tenantLocal: one state per runtime, so tenant A's turn never
// queues behind tenant B's and B never sees A's presence, active query or MCP status); one for the process otherwise, exactly as the
// module variables were.
interface AgentState {
  /** Lazy-init: config isn't available at import time, so the first use fills the rest in. */
  initialized: boolean;
  claudeMd: string;
  systemPromptFile: string;
  agentCwd: string;
  mcpServers: Record<string, McpServerConfig>;
  presence: 'active' | 'dormant' | 'waking' | 'offline';
  /** Context window tracking. */
  contextTokens: number;
  contextWindow: number;
  /** Active query tracking (for abort, MCP control, rewind). */
  abort: AbortController | null;
  activeQuery: Query | null;
  queue: QueryQueue;
  /** quiesce() ran: this companion is being parked and starts no new turn. */
  parked: boolean;
  /** Cached MCP server status (refreshed on each query). */
  mcpStatus: McpServerInfo[];
  /** Active streaming message id per thread. Set when a turn's stream begins and cleared when the turn ends, so out-of-band callers (the
   *  canvas REST route hit by the `res canvas` organ mid-turn) can ask "what message is streaming in thread X right now?" and link a
   *  created canvas back to that turn. */
  activeMessage: Map<string, string>;
}
const stateLocal = tenantLocal<AgentState>(() => ({
  initialized: false, claudeMd: '', systemPromptFile: '', agentCwd: '', mcpServers: {}, presence: 'offline', contextTokens: 0, contextWindow: 0,
  abort: null, activeQuery: null, queue: new QueryQueue(), parked: false, mcpStatus: [], activeMessage: new Map(),
}));
const st = (): AgentState => stateLocal.get();

// Extract a short summary from thinking text (first sentence, capped at ~120 chars)
function extractThinkingSummary(text: string): string {
  const trimmed = text.replace(/^\s+/, '');
  // Find first sentence boundary
  const match = trimmed.match(/^(.+?(?:\.\s|!\s|\?\s|\n))/);
  if (match) {
    const sentence = match[1].trim();
    if (sentence.length <= 120) return sentence;
    return sentence.slice(0, 117) + '...';
  }
  // No sentence boundary found — take first 120 chars
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117) + '...';
}

interface ThinkingInsertion {
  textOffset: number;
  content: string;
  summary: string;
  /** Set for narration: assistant text that was followed by a tool call in the same turn. It is not the
   *  reply. It covers fullResponse[textOffset, endOffset), which buildSegments must not emit as text. */
  narration?: boolean;
  endOffset?: number;
}

// ─── Attachment delivery to the in-process query() ───────────────────────────
// Attachments reach the model as a FILEPATH note injected into the agent's
// prompt, NOT as base64 image blocks. Two reasons (both sound):
//   1. base64 inflates ~33% — a 1.4MB photo becomes ~1.9MB of injected text per
//      image, heavy enough to choke delivery.
//   2. a filepath + the Read tool is universal — it covers images, arbitrary
//      files (PDF/docs), AND audio, not just API-accepted image types, and it
//      unifies with how generated voice .mp3s are already served by path.
// The files live at PROJECT_ROOT/data/files/{uuid}.{ext}; getFile() returns the
// absolute on-disk path WITH extension. AGENT_CWD is the companion's home dir, so the
// path is out-of-tree — the ABSOLUTE path is essential. Reads are NOT gated (the
// write-gate only blocks Write/Edit), so Read reaches the file. Read renders
// images and reads text/PDF directly; for audio it's noted as an audio file.

/** A pending attachment to surface to the model, identified by upload fileId. */
export interface AgentImageInput {
  fileId: string;
  filename?: string;
  /** Render/handling kind: image | audio | file. Defaults to file when absent. */
  contentType?: 'image' | 'audio' | 'file';
}

/**
 * Resolve uploaded attachment fileIds to a single system-aside note for the
 * agent's prompt, pointing at each file's ABSOLUTE on-disk path and instructing
 * the agent to use its Read tool. Best-effort: a fileId that can't be resolved
 * off disk is skipped (never blocks the turn). Returns '' when nothing resolves.
 */
function buildAttachmentNote(attachments: AgentImageInput[] | undefined, userName: string): string {
  if (!attachments || attachments.length === 0) return '';
  const resolved: Array<{ filename: string; kind: 'image' | 'audio' | 'file'; path: string }> = [];
  for (const att of attachments) {
    try {
      const info = getFile(att.fileId);
      if (!info) continue;
      const kind = att.contentType
        ?? (info.mimeType.startsWith('image/') ? 'image'
          : info.mimeType.startsWith('audio/') ? 'audio'
          : 'file');
      resolved.push({
        filename: att.filename || info.filename,
        kind,
        path: info.path.replace(/\\/g, '/'),
      });
    } catch (err) {
      console.warn(`[agent] buildAttachmentNote: failed to resolve ${att.fileId}:`, err);
    }
  }
  if (resolved.length === 0) return '';

  const noun = resolved.length === 1 ? 'file' : 'files';
  const lines = resolved.map(r => {
    const action = r.kind === 'audio'
      ? `audio file at that path — Read it / transcribe as needed`
      : `${r.kind} saved at ${r.path} — use your Read tool on that path to view it`;
    return resolved.length === 1
      ? `"${r.filename}" (${r.kind}) ${action}`
      : `  - "${r.filename}" (${r.kind}) ${action}`;
  });
  const header = `${userName} attached ${resolved.length} ${noun}:`;
  return resolved.length === 1
    ? `\n\n[${header} ${lines[0]}]`
    : `\n\n[${header}\n${lines.join('\n')}]`;
}

// Build interleaved text/tool/thinking segments from response text + insertions
export function buildSegments(fullResponse: string, toolInsertions: ToolInsertion[], thinkingBlocks: ThinkingInsertion[] = []): MessageSegment[] {
  if (toolInsertions.length === 0 && thinkingBlocks.length === 0) return [];

  // Merge all insertions into one sorted list
  type Insertion = { textOffset: number } & (
    | { kind: 'tool'; data: ToolInsertion }
    | { kind: 'thinking'; data: ThinkingInsertion }
  );

  const allInsertions: Insertion[] = [
    ...toolInsertions.map(t => ({ textOffset: t.textOffset, kind: 'tool' as const, data: t })),
    ...thinkingBlocks.map(t => ({ textOffset: t.textOffset, kind: 'thinking' as const, data: t })),
  ].sort((a, b) => a.textOffset - b.textOffset);

  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const ins of allInsertions) {
    const offset = Math.min(ins.textOffset, fullResponse.length);
    if (offset > cursor) {
      const gap = fullResponse.slice(cursor, offset);
      if (gap.trim()) segments.push({ type: 'text', content: gap });
    }
    if (ins.kind === 'tool') {
      segments.push({
        type: 'tool',
        toolId: ins.data.toolId,
        toolName: ins.data.toolName,
        input: ins.data.input,
        output: ins.data.output,
        isError: ins.data.isError,
      });
    } else {
      segments.push({
        type: 'thinking',
        content: ins.data.content,
        summary: ins.data.summary,
        ...(ins.data.narration ? { narration: true } : {}),
      });
    }
    cursor = ins.kind === 'thinking' && ins.data.narration
      ? Math.max(offset, Math.min(ins.data.endOffset ?? offset, fullResponse.length))
      : Math.max(cursor, offset);
  }

  // Trailing text after last insertion
  if (cursor < fullResponse.length) {
    const tail = fullResponse.slice(cursor);
    if (tail.trim()) segments.push({ type: 'text', content: tail });
  }

  return segments;
}

// Cached MCP server status (refreshed on each query)

// Active streaming message id per thread. Set when a turn's stream begins and
// cleared when the turn ends, so out-of-band callers (the canvas REST route hit
// by the `res canvas` organ mid-turn) can ask "what message is streaming in
// thread X right now?" and link a created canvas back to that turn.

/** The id of the message currently streaming in `threadId`, or null if no turn
 *  is active there (e.g. a canvas created outside a conversation). */
export function getActiveMessageId(threadId: string): string | null {
  return st().activeMessage.get(threadId) ?? null;
}

export class AgentService {
  private pushService: PushService | null = null;

  setPushService(service: PushService): void {
    this.pushService = service;
  }

  getPresenceStatus(): 'active' | 'dormant' | 'waking' | 'offline' {
    return st().presence;
  }

  isProcessing(): boolean {
    return st().queue.isProcessing;
  }

  /** A park (tenancy/park.ts): from here no turn starts. Everything queued is rejected with a `tenant_parked` AgentTurnError, a turn that has not yet reached the
   *  provider call stops there, and new work is refused. The turn already inside the provider call is stopped by stopGeneration(), which a park calls next. */
  quiesce(): void {
    const state = st();
    state.parked = true;
    state.queue.close(() => new AgentTurnError('tenant_parked'));
  }

  /** True once this companion is being parked (quiesce) or its runtime is leaving/parked. */
  private fenced(): boolean {
    if (st().parked) return true;
    const rt = currentTenant();
    return !!(rt && (rt.leaving || rt.parked));
  }

  /** A harness query (its child process) is open for the running turn. A park waits for this, and a revive is refused while it is true. */
  hasActiveQuery(): boolean {
    return st().activeQuery !== null;
  }

  getQueueDepth(): number {
    return st().queue.depth;
  }

  getMcpStatus(): McpServerInfo[] {
    return st().mcpStatus;
  }

  getContextUsage(): { tokensUsed: number; contextWindow: number } {
    return { tokensUsed: st().contextTokens, contextWindow: st().contextWindow };
  }

  /** The id of the message currently streaming in `threadId`, or null. */
  getActiveMessageId(threadId: string): string | null {
    return getActiveMessageId(threadId);
  }

  stopGeneration(): boolean {
    let stopped = false;
    // query.interrupt() is what actually halts an in-flight streaming turn —
    // the SDK keeps draining the current turn through a bare abortController.abort(),
    // so the controller alone does NOT stop generation mid-stream. Call interrupt()
    // first (best-effort), then abort the controller as a belt-and-suspenders.
    const { activeQuery, abort } = st();
    if (activeQuery && typeof (activeQuery as { interrupt?: () => Promise<void> }).interrupt === 'function') {
      Promise.resolve((activeQuery as { interrupt: () => Promise<void> }).interrupt()).catch(() => { /* best-effort */ });
      stopped = true;
    }
    if (abort) {
      abort.abort();
      stopped = true;
    }
    return stopped;
  }

  async reconnectMcpServer(name: string): Promise<{ success: boolean; error?: string }> {
    const q = st().activeQuery;
    if (!q) {
      return { success: false, error: 'No active session — will apply on next message' };
    }
    try {
      await q.reconnectMcpServer(name);
      // Refresh cached status
      const statuses = await q.mcpServerStatus();
      st().mcpStatus = statuses.map(s => ({
        name: s.name, status: s.status, error: s.error,
        toolCount: s.tools?.length ?? 0,
        tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
        scope: s.scope,
      }));
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async toggleMcpServer(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    const q = st().activeQuery;
    if (!q) {
      return { success: false, error: 'No active session — will apply on next message' };
    }
    try {
      await q.toggleMcpServer(name, enabled);
      // Refresh cached status
      const statuses = await q.mcpServerStatus();
      st().mcpStatus = statuses.map(s => ({
        name: s.name, status: s.status, error: s.error,
        toolCount: s.tools?.length ?? 0,
        tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
        scope: s.scope,
      }));
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async rewindFiles(userMessageId: string, dryRun?: boolean): Promise<{ canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }> {
    const q = st().activeQuery;
    if (!q) {
      return { canRewind: false, error: 'No active session' };
    }
    try {
      return await q.rewindFiles(userMessageId, { dryRun });
    } catch (err) {
      return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listSessions(limit = 50): Promise<unknown[]> {
    ensureInit();
    try {
      // Tenant mode: the tenant's own transcript store (data/harness/claude), never the process's (tenancy/sessions.ts says why).
      const rt = currentTenant();
      if (rt) return listTenantSessions(harnessHomes(rt).CLAUDE_CONFIG_DIR, st().agentCwd, limit);
      const sessions = await listSessions({ dir: st().agentCwd, limit });
      return sessions;
    } catch (err) {
      console.error('Failed to list sessions:', err);
      return [];
    }
  }

  async processMessage(threadId: string, content: string, threadMeta?: { name: string; type: 'daily' | 'named' }, opts?: {
    platform?: 'web' | 'discord' | 'telegram' | 'api';
    platformContext?: string;
    /** Whether the sender is the owner. Only Discord sets it (false for a non-owner); web, API, ws
     *  and Telegram are owner-only surfaces that say so through `platform`. Reaches plugins as
     *  `sanctum.senderIsOwner`. */
    senderIsOwner?: boolean;
    /** Uploaded attachments to surface to the model as a filepath note (+Read). */
    images?: AgentImageInput[];
    /** Hold the finished reply instead of saving it (see HeldReply). Web, API and Telegram never set it. */
    hold?: HoldOptions;
    /** 'none': this turn never touches the owner's memory: no recall, no Mind prefetch, no rolling history,
     *  nothing handed to memory afterwards. Nothing sets it today but the guarantee lives here, so a caller
     *  cannot forget a piece of it. */
    memory?: 'none';
  }): Promise<string> {
    if (updateBlocking()) throw new UpdateBlockedError(); // an in-app update is installing: no new turn until it ends
    // Determine priority based on platform
    const platform = opts?.platform || 'web';
    let priority: number;
    if (platform === 'web') {
      priority = PRIORITIES.web_interactive;
    } else if (platform === 'telegram') {
      // Telegram is owner-only — always high priority
      priority = PRIORITIES.discord_owner;
    } else if (platform === 'discord') {
      // Check if it's the owner by inspecting platformContext
      // Discord messages from the owner get higher priority
      const isOwner = opts?.platformContext?.includes('owner');
      priority = isOwner ? PRIORITIES.discord_owner : PRIORITIES.discord_other;
    } else {
      priority = PRIORITIES.web_interactive;
    }

    return st().queue.enqueue(priority, async () => {
      if (this.fenced()) throw new AgentTurnError('tenant_parked'); // a turn that was queued when the park began never starts
      st().presence = 'waking';
      registry.broadcast({ type: 'presence', status: 'waking' });
      return this._processQuery(threadId, content, false, threadMeta, opts);
    }, { rejectInsteadOfReply: !!opts?.hold });
  }

  /** Run `fn` in the query queue (one run at a time, Discord priority) without a thread: the public lane's
   *  isolated runs wait their turn behind the owner's live turn and never run beside it. A full queue or a
   *  wait that timed out rejects with an AgentTurnError rather than returning a line that could be sent. */
  runExclusive(fn: () => Promise<string>): Promise<string> {
    return st().queue.enqueue(PRIORITIES.discord_other, fn, { rejectInsteadOfReply: true });
  }

  async processAutonomous(threadId: string, prompt: string, modelOverride?: string): Promise<string> {
    // The operator's switch (tenants.background_runs / the tenant's own): every autonomous run (wake, pulse, impulse, watcher) is one entry here.
    if (backgroundRunsOff()) return '';
    return st().queue.enqueue(PRIORITIES.autonomous, async () => {
      return this._processQuery(threadId, prompt, true, undefined, undefined, modelOverride);
    });
  }

  private async _processQuery(threadId: string, content: string, isAutonomous = false, threadMeta?: { name: string; type: 'daily' | 'named' }, platformOpts?: { platform?: 'web' | 'discord' | 'telegram' | 'api'; platformContext?: string; senderIsOwner?: boolean; images?: AgentImageInput[]; hold?: HoldOptions; memory?: 'none' }, modelOverride?: string): Promise<string> {
    if (this.fenced()) throw new AgentTurnError('tenant_parked'); // parked: no new turn, whatever queued it
    ensureInit();
    const noMemory = platformOpts?.memory === 'none';
    const thread = getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    const cfg = getSanctumConfig();

    // Stream message placeholder
    const streamMsgId = crypto.randomUUID();

    // Response and tool tracking (declared early so hookContext can reference)
    let fullResponse = '';
    let wasInterrupted = false;
    const toolInsertions: ToolInsertion[] = [];
    const thinkingBlocks: ThinkingInsertion[] = [];
    let currentThinkingAccum = '';
    // Per-text-block state for streaming text_delta tokens. A turn may contain
    // multiple text blocks (e.g. text -> tool -> text); each non-first block is
    // joined to the prior accumulated text with a single '\n\n', inserted once
    // right before that block's first delta.
    let currentTextBlockStarted = false;
    let currentTextBlockHasDelta = false;
    // Structural dedup between the delta-stream and the assembled `assistant`
    // message. Counts how many text blocks were actually delta-streamed this
    // turn; the assistant handler skips by index rather than by string match
    // (endsWith would double a block if the SDK post-normalizes text, and would
    // swallow a legitimately-repeated block). Both live at _processQuery scope so
    // they persist across ALL assistant messages in the turn (text -> tool -> text
    // spans two assistant messages but one continuous stream) and reset to 0 on
    // each new _processQuery invocation / on compaction.
    let textBlocksStreamedViaDelta = 0;
    let assistantTextBlockIndex = 0;
    // Per-turn thinking-block counter. Drives a stable block id for live
    // streaming (`${streamMsgId}-think-${seq}`). Lives at _processQuery scope
    // like the text-block counters above so it spans all assistant messages in
    // the turn; reset to 0 on compaction (see the compaction reset block).
    let thinkingBlockSeq = 0;
    // Narration: text that is followed by a tool call in the same turn is thinking, not the reply. `replyBase` is
    // where the text after the latest tool call starts in fullResponse; the live stream only shows that tail.
    let replyBase = 0;
    let narrationSeq = 0;
    const replyTail = (): string => fullResponse.slice(replyBase).replace(/^\s+/, '');
    const sealNarration = (): void => {
      const raw = fullResponse.slice(replyBase);
      const content = raw.trim();
      const start = replyBase;
      replyBase = fullResponse.length;
      if (!content) return;
      const id = `${streamMsgId}-narr-${++narrationSeq}`;
      const summary = extractThinkingSummary(content);
      thinkingBlocks.push({ textOffset: start + (raw.length - raw.trimStart().length), endOffset: fullResponse.length, content, summary, narration: true });
      registry.broadcast({ type: 'thinking', id, content, summary, textOffset: start, isComplete: true, narration: true });
      if (!hold) registry.broadcast({ type: 'stream_token', messageId: streamMsgId, token: '' });
    };
    // The current thinking block's stable id + interleave offset, captured at
    // its content_block_start and reused for its deltas + stop.
    let thinkingId = '';
    let thinkingOffset = 0;

    // MEASUREMENT HARNESS (temp): cadence logging gated behind MEASURE_THINKING=1.
    // Grep prefix: [THINK-CADENCE]. Answers: do summarized thinking deltas stream
    // incrementally (many small) or arrive in big chunks, and how do they interleave
    // with text tokens and tool calls? Silent + zero-cost when the env is unset.
    const MEASURE = process.env.MEASURE_THINKING === '1';
    const mStart = Date.now();
    const mt = (): string => `+${(Date.now() - mStart).toString().padStart(6)}ms`;
    let mThinkDeltaCount = 0; // deltas in the current block
    let mThinkBlockChars = 0; // chars in the current block
    let mThinkDeltaTotal = 0; // deltas across all blocks
    let mThinkCharsTotal = 0; // thinking chars across all blocks
    let mThinkBlocks = 0; // completed thinking blocks
    let mTokenCount = 0; // stream_token broadcasts
    let mToolCount = 0; // tool_use sightings

    const rollingOn = rollingEnabledForActiveProvider();
    const claudeRolling = rollingOn && activeProvider() === 'claude';
    // Under rolling the thread is the memory, so a session id from before the
    // switch is dropped: resumed later it would know none of the rolling-era
    // turns. Dropping it is what makes the carry-over below fire instead.
    if (claudeRolling && thread.current_session_id) {
      updateThreadSession(threadId, null);
      thread.current_session_id = null;
    }
    // Rolling off on Claude and no session to resume, but the thread has
    // turns: rolling was just switched off (or the session was lost). The
    // thread is carried into this fresh session once, and the thread says so;
    // after that the session holds the conversation itself.
    let bridge = false;
    if (!claudeRolling && activeProvider() === 'claude' && !thread.current_session_id) {
      try { bridge = (await getRolling().readTurns(threadId)).length > 0; } catch { bridge = false; }
    }

    // Build hook context
    const platform = platformOpts?.platform || 'web';
    const hookContext: HookContext = {
      threadId,
      threadName: threadMeta?.name ?? thread.name,
      threadType: threadMeta?.type ?? thread.type,
      streamMsgId,
      isAutonomous,
      registry,
      sessionId: thread.current_session_id || null,
      platform,
      platformContext: platformOpts?.platformContext,
      noMemory,
      userContent: content,
      toolInsertions,
      getTextLength: () => fullResponse.length,
    };

    // First message of this session — include static orientation content (tools, skills, vault)
    // Rolling context runs every turn fresh (no resumed session) on either
    // harness, so every turn gets the full first-message orientation.
    const isFirstMessage = !thread.current_session_id || rollingOn;

    // Apply user-supplied auth (subscription vs. ANTHROPIC_API_KEY) before
    // building options. Safe because QueryQueue serializes — no concurrent
    // queries with conflicting envs.
    const authEnv = applyAuthToEnv();

    // Build query options — V1 API (full config support)
    // Two-tier model: autonomous wakes use cheaper model (configurable)
    // Interactive queries use primary model (configurable)
    // User overrides from auth_preferences win over YAML defaults.
    const yamlInteractive = cfg.agent.model || envFor('the agent model').AGENT_MODEL || 'claude-sonnet-5-5';
    // Model precedence (interactive path):
    //   1. explicit per-call modelOverride (scheduled-wake model) — wins verbatim
    //   2. thread.model — per-thread picker, applies to the next message
    //   3. effectiveModel('interactive', yaml) — config/YAML default
    // Autonomous wakes keep their own two-tier path (override → model_autonomous)
    // untouched; the per-thread model only steers the interactive surface.
    const threadModel = (!isAutonomous && thread.model && thread.model.trim())
      ? thread.model.trim()
      : null;
    const model = (modelOverride && modelOverride.trim())
      ? modelOverride.trim()
      : threadModel
        ? threadModel
        : isAutonomous
          ? effectiveModel('autonomous', cfg.agent.model_autonomous)
          : effectiveModel('interactive', yamlInteractive);
    // Per-thread reasoning effort (interactive path only). Adaptive thinking is
    // always on (set below); effort guides its depth. Invalid/null → omit so the
    // SDK defaults to 'high'. Manual thinking budgets are deprecated — not used.
    const VALID_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    const threadEffort = (!isAutonomous && thread.effort &&
      (VALID_EFFORT as readonly string[]).includes(thread.effort))
      ? (thread.effort as EffortLevel)
      : undefined;
    // System prompt. When a frame file resolves, the lean frame +
    // CLAUDE.md REPLACE the claude_code preset entirely (no generic harness on
    // top — the real register fix). Read fresh so Settings edits apply on the next turn.
    // Falls back to preset + CLAUDE.md append when no frame file resolves.
    // The identity half gets the same live-edit treatment: re-read when its
    // source files' mtimes changed (was memoized forever at first init).
    refreshCompanionIdentity();
    // The path is the process's own (a home copy, or a configured file that may be the app's shipped one), so it is read with readOwnOrApp: guarded
    // inside a tenant's folder, a plain read for the app's file (readOwnText would refuse that in tenant mode).
    // Only the Claude harness sends it (Codex and dsh carry their own base prompts), so the other minds do not read it.
    const frameFile = activeProvider() === 'claude' ? resolveFrameFile(st().agentCwd, st().systemPromptFile).path : '';
    const frame = frameFile ? readOwnOrApp(frameFile).trim() : '';
    // Runtime self-knowledge: the claude_code preset normally tells the model
    // which model it is. Replacing the preset (the register fix) dropped that, so
    // the companion could only guess its version. Re-inject the RESOLVED model (per-thread
    // aware) on the frame path so he can state it as fact. The preset path still
    // carries it natively, so only the frame branch needs the note.
    const runtimeNote = `\n\n[Runtime] Model serving this turn: ${model}. This line is injected by the home and is the ground truth for "what model are you on?" — state it directly; don't second-guess your own version.`;
    const systemPrompt: Options['systemPrompt'] = frame
      ? `${st().claudeMd ? `${frame}\n\n${st().claudeMd}` : frame}${runtimeNote}`
      : (st().claudeMd
          ? { type: 'preset', preset: 'claude_code', append: st().claudeMd }
          : { type: 'preset', preset: 'claude_code' });

    const options: Options = {
      model,
      systemPrompt,
      cwd: st().agentCwd,
      ...runEnvOption(authEnv),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,
      // Nothing from ~/.claude or a project .claude leaks into the companion:
      // the SDK path is isolated by default; this pins it.
      settingSources: [],
      // SDK auto-compaction is off unless agent.auto_compact says otherwise. The
      // SDK's summary replaces the thread's own words with a digest it wrote,
      // and the companion comes back from it with less of itself. Upstream left
      // the SDK default (on) and never exposed the switch.
      // Claude's auto-memory follows agent.harness_memory (default off), so it
      // never fights Revien or the person's own memory system for the same job.
      settings: { autoCompactEnabled: !!cfg.agent.auto_compact, autoMemoryEnabled: !!cfg.agent.harness_memory },

      includePartialMessages: true,
      // Thinking display is driven by the PER-THREAD setting (thread.show_thinking).
      //   show_thinking === true  → 'summarized': reasoning blocks are non-empty
      //     and stream into the collapsible thinking pill in the UI.
      //   show_thinking === false → display omitted: empty thinking blocks, no
      //     events — the quietest path.
      // (MEASURE_THINKING is retained below ONLY for [THINK-CADENCE] stdout
      // logging; it no longer decides display.)
      thinking: thread.show_thinking
        ? { type: 'adaptive', display: 'summarized' as const }
        : { type: 'adaptive' },
      // Per-thread effort guides adaptive-thinking depth. Omitted when null/invalid
      // so the SDK applies its default ('high'). Interactive path only.
      ...(threadEffort && { effort: threadEffort }),
      hooks: createHooks(hookContext),
      // Plugin: native skill discovery from .claude/skills/
      plugins: [{ type: 'local' as const, path: join(st().agentCwd, '.claude').replace(/\\/g, '/') }],
      // Explicitly pass MCP servers — SDK isolation mode doesn't auto-discover .mcp.json
      ...(Object.keys(st().mcpServers).length > 0 && { mcpServers: st().mcpServers }),
      // Use ONLY the explicit mcpServers above — ignore the global ~/.claude MCP config.
      // This is the real ghost fix: kills the ambient bleed (sanctuary, google-workspace,
      // imessage, etc.) that nulling the env vars did NOT remove.
      strictMcpConfig: true,
    };

    // Resume existing session if available. Under rolling context there is
    // nothing to resume: every turn is a fresh run and the thread is the memory.
    if (thread.current_session_id && !claudeRolling) {
      options.resume = thread.current_session_id;
    }
    // Under rolling the run is never resumed, so the SDK has no reason to leave
    // a session file on disk for every message.
    if (claudeRolling) options.persistSession = false;

    // Record the active streaming message for this thread so a canvas created
    // mid-turn (via the canvas REST route) can link back to it. Cleared in the
    // finally below when the turn ends.
    st().activeMessage.set(threadId, streamMsgId);

    // A held reply (Discord) is not streamed to the web: it may yet be withheld, and a streamed
    // reply is shown whole. It appears once, when it is committed.
    const hold = platformOpts?.hold;
    if (!hold) {
      registry.broadcast({
        type: 'stream_start',
        messageId: streamMsgId,
        threadId,
      });
    }

    let sessionId: string | null = null;
    // Set when the turn failed. A held turn (Discord) then throws it as an AgentTurnError after teardown
    // instead of returning "[Agent error: ...]" as the reply.
    let turnError: string | null = null;

    try {
      st().presence = 'active';
      registry.broadcast({ type: 'presence', status: 'active' });

      // Write thread ID for CLI tool integration (only if cwd dir exists)
      writeThreadFile(cfg.agent.cwd, threadId); // (a tenant: never through a link the companion planted at this name; the turn goes on)

      // Build orientation context. Prepended to the prompt because SessionStart
      // hooks don't fire in V1 query(). Context-rot fix (harvested from
      // the reference app): first message of a session → 'session' mode (full snapshot:
      // CHAT TOOLS, skills, life status, mantelpiece, recently-reached). Every
      // subsequent turn → 'turn' mode (one [env] line). Keeps mutable state from
      // fossilizing into the never-compacted interactive session.
      const orientation = await buildOrientationContext(
        hookContext,
        isFirstMessage ? 'session' : 'turn',
      );

      // First message of a session → pre-fetch the Mind's orientation (mind_orient),
      // since V1 query() doesn't fire the SessionStart hook that would normally do
      // this. Skipped for autonomous wakes (own context path) and when the Mind is off.
      let memoryPrefetch = '';
      if (isFirstMessage && !isAutonomous && !noMemory) {
        try {
          memoryPrefetch = await prefetchMindContext();
        } catch { /* memory prefetch is best-effort */ }
      }

      // Attachment delivery: when the user attached files, append a system-aside
      // note pointing the agent at each file's absolute on-disk path and telling
      // it to Read them. This rides INTO the agent's prompt only — it is NOT in
      // the user's persisted/displayed message (the bubble renders the thumbnail
      // separately from metadata.attachments). Filepath + Read is universal
      // (images, PDFs, docs, audio) and avoids base64 inflation. No attachments
      // → empty string → zero behavioral change for text-only turns.
      const attachmentNote = buildAttachmentNote(platformOpts?.images, cfg.identity.user_name);
      if (attachmentNote) {
        console.log(`[agent] attaching ${platformOpts?.images?.length} file path(s) to prompt for thread ${threadId}`);
      }

      // Rolling context on the Claude path: the app owns the history. The prompt
      // is context → recalled memory → derived summary → dropped-turns notice →
      // [Conversation so far] → [Current message], the same shape as the Codex
      // adapter builds. Identity rides in the system prompt here, so no block.
      let rollingHistory: Awaited<ReturnType<typeof assembleRollingHistory>> | null = null;
      let claudeMemoryBlock = '';
      let bridgeNote = '';
      if (claudeRolling) {
        if (!noMemory) rollingHistory = await assembleRollingHistory(threadId, content, isAutonomous, { named: true });
        if (!isAutonomous && !noMemory) {
          const memory = await recallForPrompt(content, threadId);
          if (memory) claudeMemoryBlock = `${MEMORY_HEADER}\n${memory}`;
        }
      } else if (bridge && !noMemory) {
        rollingHistory = await assembleRollingHistory(threadId, content, isAutonomous, { force: true, named: true });
        if (rollingHistory.turns > 0) {
          const n = rollingHistory.turns;
          const s = rollingHistory.segments;
          const at = new Date().toLocaleTimeString('en-GB', { timeZone: cfg.identity.timezone, hour: '2-digit', minute: '2-digit' });
          bridgeNote = `[Long-conversation memory is off for this thread. The earlier conversation above (${n} turn${n === 1 ? '' : 's'}${s ? `, the oldest in ${s} summar${s === 1 ? 'y' : 'ies'}` : ''}) was carried into this fresh session once; from here the session itself holds what is said.]`;
          try {
            const note = createMessage({
              id: crypto.randomUUID(), threadId, role: 'system',
              content: `[long-conversation memory is off — the earlier conversation in this thread (${n} turn${n === 1 ? '' : 's'}${s ? `, the oldest in ${s} summar${s === 1 ? 'y' : 'ies'}` : ''}) was carried into a fresh session once at ${at}. From here the session holds the conversation itself; turn long-conversation memory back on in Settings to keep folding. Nothing was deleted.]`,
              metadata: { kind: 'rolling_bridge', turns: n, segments: s },
              createdAt: new Date().toISOString(),
            });
            registry.broadcast({ type: 'message', message: note });
          } catch (err) { console.warn('[rolling] could not write the carry-over note:', err instanceof Error ? err.message : err); }
          console.log(`[rolling] thread=${threadId} carried ${n} turns (${s} summaries) into a fresh Claude session; long-conversation memory is off`);
        }
      }
      const contextBlock = memoryPrefetch
        ? `[Context]\n${orientation}\n\n${memoryPrefetch}\n[/Context]`
        : `[Context]\n${orientation}\n[/Context]`;
      const enrichedPrompt = (rollingHistory
        ? [
            contextBlock,
            claudeMemoryBlock,
            rollingHistory.summary,
            rollingHistory.notice,
            conversationBlock(rollingHistory.lines),
            bridgeNote,
            `[Current message]\n${content}`,
          ].filter(Boolean).join('\n\n')
        : `${contextBlock}\n\n${content}`) + attachmentNote;

      // A park that began while this turn was still getting ready (before it had a query to interrupt) ends it here: no provider call. No await sits between this
      // check and query() below, so a park is either seen here or finds the query it must interrupt.
      if (this.fenced()) throw new ParkedBeforeQuery();

      // Abort controller for stop_generation support
      const abort = new AbortController();
      st().abort = abort;
      options.abortController = abort;

      // File checkpointing for rewind support
      options.enableFileCheckpointing = true;

      // V1 query — single params object with the plain string prompt and options.
      // Attachments ride along as the filepath note already folded into
      // enrichedPrompt (see buildAttachmentNote above); no streaming-input branch
      // is needed, which keeps resume/session handling simple and uniform.
      // Codex / dsh: the adapter owns thread history and needs the raw user message.
      if (activeProvider() !== 'claude') (options as any).sanctum = { threadId, userContent: content, contextBlock, autonomous: isAutonomous, senderIsOwner: isAutonomous ? undefined : senderIsOwnerFor(platformOpts?.platform, platformOpts?.senderIsOwner), ...(hold ? { noIngest: true } : {}), ...(noMemory ? { memory: 'none' } : {}) };
      const result = query({ prompt: enrichedPrompt, options });
      st().activeQuery = result;

      // Refresh MCP server status (non-blocking — caches for settings panel)
      result.mcpServerStatus().then(statuses => {
        st().mcpStatus = statuses.map(s => ({
          name: s.name,
          status: s.status,
          error: s.error,
          toolCount: s.tools?.length ?? 0,
          tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
          scope: s.scope,
        }));
        console.log(`MCP status refreshed: ${st().mcpStatus.length} servers`);
      }).catch(err => {
        console.warn('Failed to get MCP status:', err instanceof Error ? err.message : err);
      });

      // Simplified stream loop — hooks handle tool activity, audit, images
      // Inner try/catch for AbortError (stop_generation)
      try {
      for await (const msg of result) {
        // Capture session ID from any message
        if (msg && typeof msg === 'object' && 'session_id' in msg) {
          const newSessionId = msg.session_id as string;
          if (newSessionId && newSessionId !== sessionId) {
            sessionId = newSessionId;
            // Update hook context so hooks log the correct session
            hookContext.sessionId = sessionId;
          }
        }

        if (!msg || typeof msg !== 'object' || !('type' in msg)) continue;

        const msgType = (msg as any).type;

        // Capture thinking from raw stream events (SDK strips them from assistant messages)
        if (msgType === 'stream_event') {
          const streamEvent = (msg as any).event;
          if (streamEvent?.type === 'content_block_start' && streamEvent?.content_block?.type === 'thinking') {
            currentThinkingAccum = '';
            // Stable per-block id + interleave offset, captured here and reused
            // for this block's deltas + stop.
            thinkingId = `${streamMsgId}-think-${++thinkingBlockSeq}`;
            thinkingOffset = fullResponse.length;
            if (MEASURE) {
              mThinkDeltaCount = 0;
              mThinkBlockChars = 0;
              console.log(`[THINK-CADENCE] ${mt()} THINK-START block#${mThinkBlocks + 1}`);
            }
          } else if (streamEvent?.type === 'content_block_delta' && streamEvent?.delta?.type === 'thinking_delta') {
            const thinkingText = streamEvent.delta.thinking || '';
            if (thinkingText) {
              currentThinkingAccum += thinkingText;
              // Stream the growing block live. Volume is low (~13 deltas/turn),
              // so per-delta broadcast needs no throttle. Cheap running summary:
              // the first line, capped at ~80 chars.
              const runningSummary = currentThinkingAccum
                .split('\n', 1)[0]
                .slice(0, 80);
              registry.broadcast({
                type: 'thinking',
                id: thinkingId,
                content: currentThinkingAccum,
                summary: runningSummary,
                textOffset: thinkingOffset,
                isComplete: false,
              });
              if (MEASURE) {
                mThinkDeltaCount++;
                mThinkDeltaTotal++;
                mThinkBlockChars += thinkingText.length;
                mThinkCharsTotal += thinkingText.length;
                console.log(`[THINK-CADENCE] ${mt()} thinking_delta len=${thinkingText.length} (block delta#${mThinkDeltaCount}, blockChars=${mThinkBlockChars}; allDeltas=${mThinkDeltaTotal}, allChars=${mThinkCharsTotal})`);
              }
            }
          } else if (streamEvent?.type === 'content_block_stop' && currentThinkingAccum) {
            if (MEASURE) {
              mThinkBlocks++;
              console.log(`[THINK-CADENCE] ${mt()} THINK-STOP block#${mThinkBlocks} deltas=${mThinkDeltaCount} finalLen=${currentThinkingAccum.length}`);
            }
            const summary = extractThinkingSummary(currentThinkingAccum);
            thinkingBlocks.push({
              textOffset: thinkingOffset,
              content: currentThinkingAccum,
              summary,
            });
            registry.broadcast({
              type: 'thinking',
              id: thinkingId,
              content: currentThinkingAccum,
              summary,
              textOffset: thinkingOffset,
              isComplete: true,
            });
            currentThinkingAccum = '';
          }

          // Stream text deltas token-by-token. The SDK emits these partial
          // stream_events for a text content block BEFORE the assembled
          // `assistant` SDKMessage, so by the time the assistant handler runs
          // the text is already in fullResponse. The assistant handler is made
          // idempotent below to avoid double-emitting.
          if (streamEvent?.type === 'content_block_start' && streamEvent?.content_block?.type === 'text') {
            currentTextBlockStarted = true;
            currentTextBlockHasDelta = false;
          } else if (streamEvent?.type === 'content_block_delta' && streamEvent?.delta?.type === 'text_delta') {
            const deltaText: string = streamEvent.delta.text || '';
            if (deltaText) {
              if (!currentTextBlockHasDelta) {
                // First delta of this text block. Count it HERE (at the first
                // delta), not at content_block_stop. The assembled `assistant`
                // SDKMessage can arrive BEFORE this block's content_block_stop
                // event — if the counter were still 0 then, the assistant
                // handler's index check (0 < 0) would fail and the fallback
                // would append the whole block again, doubling fullResponse.
                // Deltas always precede the assembled message, so counting at
                // the first delta closes that race.
                textBlocksStreamedViaDelta++;
                // Insert the '\n\n' separator once, before the first delta of a
                // non-first text block (i.e. fullResponse already has content).
                if (fullResponse) fullResponse += '\n\n';
              }
              currentTextBlockHasDelta = true;
              fullResponse += deltaText;
              if (!hold) registry.broadcast({
                type: 'stream_token',
                messageId: streamMsgId,
                token: replyTail(),
              });
              if (MEASURE) {
                mTokenCount++;
                console.log(`[THINK-CADENCE] ${mt()} stream_token #${mTokenCount} (text_delta) chunkLen=${deltaText.length} totalTextLen=${fullResponse.length}`);
              }
            }
          } else if (streamEvent?.type === 'content_block_stop' && currentTextBlockStarted) {
            // Counting now happens at the first delta (see above) to avoid a
            // race with the assembled assistant message. Here we only clear the
            // per-block flags.
            currentTextBlockStarted = false;
            currentTextBlockHasDelta = false;
          }
        }

        if (msgType === 'assistant') {
          const assistantMsg = msg as any;
          if (assistantMsg.message?.content) {
            for (const block of assistantMsg.message.content) {
              if (block.type === 'text' && block.text) {
                // Structural dedup against the delta stream. The stream_event
                // branch above runs FIRST, so any block that delta-streamed is
                // already in fullResponse. We track how many text blocks were
                // delta-streamed (textBlocksStreamedViaDelta) and walk the
                // assistant message's text blocks in order (assistantTextBlockIndex).
                // If this block's index falls within the delta-streamed count it
                // was already emitted -> skip. Otherwise fall back to append +
                // broadcast. This is immune to SDK post-normalization (endsWith
                // would double the block) and to legitimately-repeated text
                // (endsWith would swallow the second copy). The index increments
                // for every text block regardless of skip/fallback.
                if (assistantTextBlockIndex < textBlocksStreamedViaDelta) {
                  if (MEASURE) {
                    console.log(`[THINK-CADENCE] ${mt()} assistant text block already streamed (skip dedup, idx=${assistantTextBlockIndex}/${textBlocksStreamedViaDelta}) len=${block.text.length}`);
                  }
                } else {
                  if (fullResponse) fullResponse += '\n\n' + block.text;
                  else fullResponse = block.text;

                  if (!hold) registry.broadcast({
                    type: 'stream_token',
                    messageId: streamMsgId,
                    token: replyTail(),
                  });
                  if (MEASURE) {
                    mTokenCount++;
                    console.log(`[THINK-CADENCE] ${mt()} stream_token #${mTokenCount} (assistant fallback, idx=${assistantTextBlockIndex}/${textBlocksStreamedViaDelta}) chunkLen=${block.text.length} totalTextLen=${fullResponse.length}`);
                  }
                }
                assistantTextBlockIndex++;
              } else if (block.type === 'tool_use') {
                sealNarration();
                if (MEASURE) {
                  mToolCount++;
                  console.log(`[THINK-CADENCE] ${mt()} tool_use #${mToolCount} name=${block.name} id=${block.id}`);
                }
              }
              // Thinking blocks are captured from stream_event, not here (avoids duplicates)
            }
          }
        } else if (MEASURE && msgType === 'user') {
          // Tool results return as user-role messages with tool_result blocks.
          const userMsg = msg as any;
          const blocks = userMsg.message?.content;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                console.log(`[THINK-CADENCE] ${mt()} tool_result for id=${block.tool_use_id}`);
              }
            }
          }
        } else if (msgType === 'result') {
          const resultMsg = msg as any;

          // Extract context window usage from result
          if (resultMsg.usage || resultMsg.model_usage) {
            const usage = resultMsg.usage || {};
            const modelUsage = resultMsg.model_usage;

            // Get context window size from model usage if available
            if (modelUsage) {
              for (const model of Object.values(modelUsage) as any[]) {
                if (model?.context_window) {
                  st().contextWindow = model.context_window;
                }
                if (model?.input_tokens) {
                  st().contextTokens = model.input_tokens + (model.output_tokens || 0);
                }
              }
            } else if (usage.input_tokens) {
              st().contextTokens = usage.input_tokens + (usage.output_tokens || 0);
            }

            // Per-turn usage log for API-key users. Skip for subscription mode
            // because the user's plan covers it — no cost attribution to surface.
            const authPrefs = getAuthPreferences();
            if (authPrefs.auth_mode === 'api_key' && authPrefs.usage_tracking_enabled) {
              try {
                if (modelUsage) {
                  for (const [modelName, m] of Object.entries(modelUsage) as [string, any][]) {
                    recordUsage({
                      model: modelName,
                      inputTokens: m?.input_tokens || 0,
                      outputTokens: m?.output_tokens || 0,
                      cacheCreationTokens: m?.cache_creation_input_tokens || 0,
                      cacheReadTokens: m?.cache_read_input_tokens || 0,
                    });
                  }
                } else if (usage.input_tokens || usage.output_tokens) {
                  // dsh: `usage` is the context-meter figure (last step); `spend` is the sum over steps.
                  const sp = resultMsg.spend || usage;
                  recordUsage({
                    model,
                    inputTokens: sp.input_tokens || 0,
                    outputTokens: sp.output_tokens || 0,
                    cacheCreationTokens: sp.cache_creation_input_tokens || 0,
                    cacheReadTokens: sp.cache_read_input_tokens || 0,
                  });
                }
              } catch (logErr) {
                console.warn('Failed to record usage:', logErr instanceof Error ? logErr.message : logErr);
              }
            }

            if (st().contextWindow > 0 && st().contextTokens > 0) {
              const percentage = Math.round((st().contextTokens / st().contextWindow) * 100);
              console.log(`Context usage: ${st().contextTokens} / ${st().contextWindow} (${percentage}%)`);
              registry.broadcast({
                type: 'context_usage',
                percentage,
                tokensUsed: st().contextTokens,
                contextWindow: st().contextWindow,
              });
            }
          }

          if (resultMsg.subtype !== 'success') {
            console.error('Agent error:', resultMsg.subtype, resultMsg.errors);
            // A held turn (Discord) must not send what a failed run managed to say before it failed: any failure
            // subtype rejects it, whatever text came first. The web keeps its partial text, as the owner can see it is partial.
            if (hold && typeof resultMsg.subtype === 'string') turnError = turnError ?? (resultMsg.subtype === 'error_max_turns' ? 'max_turns' : 'provider_error');
            else if (!fullResponse.trim()) turnError = turnError ?? 'provider_error';
          }
        } else if (msgType === 'system') {
          const systemMsg = msg as any;
          // Detect compaction boundary
          if (systemMsg.subtype === 'compact_boundary' && systemMsg.compact_metadata) {
            const preTokens = systemMsg.compact_metadata.pre_tokens || st().contextTokens;
            console.log(`[Compaction] Context compacted. Pre-tokens: ${preTokens}`);
            registry.broadcast({
              type: 'compaction_notice',
              preTokens,
              message: `Context compacted (was ${Math.round(preTokens / 1000)}K tokens)`,
              isComplete: true,
            });
            // Reset tracking — new context window after compaction
            st().contextTokens = 0;
            // Reset response buffer — pre-compaction text was incomplete and post-compaction
            // re-grounding monologue must not leak into Discord/phone replies
            if (fullResponse) {
              console.log(`[Compaction] Resetting fullResponse (was ${fullResponse.length} chars, platform: ${platform})`);
              fullResponse = '';
            }
            toolInsertions.length = 0;
            thinkingBlocks.length = 0;
            // Reset text-streaming state so post-compaction streaming starts from
            // a clean slate — a mid-block compaction must not desync the '\n\n'
            // separator or the index/counter dedup against the next assistant message.
            currentTextBlockStarted = false;
            currentTextBlockHasDelta = false;
            textBlocksStreamedViaDelta = 0;
            assistantTextBlockIndex = 0;
            // Reset thinking-block streaming state too — same rationale as the
            // text counters above; a mid-block compaction must re-derive ids
            // and offsets cleanly for post-compaction thinking blocks.
            thinkingBlockSeq = 0;
            currentThinkingAccum = '';
            replyBase = 0;
            narrationSeq = 0;
          } else if (systemMsg.status === 'compacting') {
            console.log('[Compaction] Compacting in progress...');
          }
        } else if (msgType === 'rate_limit_event') {
          const rle = msg as any;
          const info = rle.rate_limit_info;
          if (info && (info.status === 'rejected' || info.status === 'allowed_warning')) {
            registry.broadcast({
              type: 'rate_limit',
              status: info.status,
              resetsAt: info.resetsAt,
              rateLimitType: info.rateLimitType,
              utilization: info.utilization,
            });
            console.log(`[Agent] Rate limit: ${info.status}, type: ${info.rateLimitType}, resets: ${info.resetsAt}`);
          }
        } else if (msgType === 'tool_progress') {
          const tp = msg as any;
          registry.broadcast({
            type: 'tool_progress',
            toolId: tp.tool_use_id,
            toolName: tp.tool_name,
            elapsed: tp.elapsed_time_seconds,
          });
        }
      }
      } catch (abortErr) {
        if (abortErr instanceof AbortError || (abortErr instanceof Error && abortErr.name === 'AbortError')) {
          console.log('[Agent] Generation stopped by user');
          wasInterrupted = true;
          registry.broadcast({ type: 'generation_stopped' });
        } else {
          throw abortErr; // Re-throw non-abort errors to outer catch
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (error instanceof ParkedBeforeQuery) {
        wasInterrupted = true; // ended by a park before any provider call: no error bubble, nothing persisted
        console.log('[Agent] turn ended before its provider call: the companion is being parked');
      } else {
      console.error('Agent query error:', errMsg, error);
      if (hold) turnError = errorClass(error);
      else fullResponse = fullResponse || `[Agent error: ${errMsg}]`;
      }
    } finally {
      // Clean up active query tracking
      st().abort = null;
      st().activeQuery = null;
      // Turn is over — no message is streaming in this thread anymore.
      st().activeMessage.delete(threadId);
      // Track session transition and update for future resume. Under rolling
      // context no session is ever resumed, so the thread keeps none: switching
      // rolling off later starts clean instead of resuming one turn's worth.
      if (sessionId && !claudeRolling) {
        const previousSessionId = thread.current_session_id;
        const now = new Date().toISOString();

        // End the previous session record (if tracked)
        if (previousSessionId && previousSessionId !== sessionId) {
          try {
            endSessionRecord({ sessionId: previousSessionId, endedAt: now, endReason: 'resumed' });
          } catch { /* Previous session may not have a record yet */ }
        }

        // Create a record for the new session
        if (sessionId !== previousSessionId) {
          try {
            createSessionRecord({
              id: crypto.randomUUID(),
              threadId,
              sessionId,
              sessionType: (thread.session_type as 'v1' | 'v2') || 'v2',
              startedAt: now,
              // Lineage: the new session succeeds the prior one (compaction/resume).
              parentSessionId: previousSessionId || undefined,
            });
          } catch (err) {
            if (!(err instanceof Error && err.message.includes('UNIQUE'))) {
              console.warn('Failed to create session record:', err);
            }
          }
        }

        updateThreadSession(threadId, sessionId);
      }

      // Delta-orientation stamp (PACK B): the ONE write. Marks "a turn ended
      // here, now" per-thread + globally, so the next orientation (session-mode
      // snapshot or autonomous wake slice) can render "Since you were last here
      // (Xh ago)" from the companion_actions diary. Cheap KV; best-effort.
      try {
        const stampIso = new Date().toISOString();
        setConfig(`thread.lastTurnAt.${threadId}`, stampIso);
        setConfig('session.lastTurnAt', stampIso);
      } catch { /* the stamp is garnish — never let it break turn teardown */ }

      st().presence = 'dormant';
      registry.broadcast({ type: 'presence', status: 'dormant' });

      if (MEASURE) {
        const avgDelta = mThinkDeltaTotal > 0 ? (mThinkCharsTotal / mThinkDeltaTotal).toFixed(1) : '0';
        const shape = mThinkDeltaTotal === 0
          ? 'no-thinking'
          : (mThinkDeltaTotal / Math.max(mThinkBlocks, 1)) >= 5
            ? 'MANY-SMALL-DELTAS'
            : 'FEW-LARGE-CHUNKS';
        console.log(`[THINK-CADENCE] ${mt()} SUMMARY blocks=${mThinkBlocks} thinkDeltas=${mThinkDeltaTotal} thinkChars=${mThinkCharsTotal} avgDeltaChars=${avgDelta} textTokens=${mTokenCount} toolCalls=${mToolCount} durationMs=${Date.now() - mStart} shape=${shape}`);
      }
    }

    // A held turn that failed is an error, never a reply: nothing is held, saved, shown, pushed or ingested.
    if (hold && turnError) throw new AgentTurnError(turnError);

    // Interrupted before any content streamed (e.g. stop-and-steer fired early):
    // don't persist a "[No response]" ghost bubble. generation_stopped already
    // cleared the streaming UI, and the steer message becomes the next turn.
    if (wasInterrupted && !fullResponse.trim()) {
      return '';
    }

    // Build segments for interleaved tool/thinking display
    const segments = buildSegments(fullResponse, toolInsertions, thinkingBlocks);
    const messageMetadata: Record<string, unknown> | undefined =
      segments.length > 0 ? { segments } : undefined;

    const finalText = fullResponse || '[No response]';
    // Everything that follows a reply that has been sent. For an ordinary turn that is every reply; for a
    // held one (Discord) it runs only when the caller commits, after the gated send went out.
    const finish = (): void => {
      // Store final message
      const companionMessage = createMessage({
        id: streamMsgId,
        threadId,
        role: 'companion',
        content: finalText,
        contentType: 'text',
        platform,
        metadata: messageMetadata,
        createdAt: new Date().toISOString(),
      });

      // Compaction-insurance tone tracker: every ~15 persisted messages per
      // thread, snapshot the keyword-based emotional arc so PreCompact can
      // preserve it. Zero-LLM, <1ms; never blocks the turn.
      try { maybeSnapshotTone(threadId); } catch { /* best-effort */ }

      // Rolling context on the Claude path: hand the exchange to memory, then
      // fold older history in the background so the fold note lands after the
      // reply. Neither blocks or fails the turn. (Codex does the same in its adapter.)
      const ingestOk = !noMemory && (hold ? hold.ingest : true);
      if (claudeRolling && fullResponse) {
        if (!isAutonomous && ingestOk) void ingestTurn({ threadId, user: hold ? hold.userText : content, assistant: fullResponse });
        if (!noMemory) try { void Promise.resolve(getRolling().maybeCompact(threadId)).catch(() => {}); } catch { /* ignore */ }
      } else if (hold && ingestOk && fullResponse && !isAutonomous && activeProvider() !== 'claude') {
        // Codex and dsh ingest inside their adapters; a held turn told them not to, so it is done here.
        // Claude with rolling off ingests nothing on the web path, so a held turn does not either.
        void ingestTurn({ threadId, user: hold.userText, assistant: fullResponse });
      }

      // End stream (a held reply was never streamed: it arrives as one message)
      if (hold) registry.broadcast({ type: 'message', message: companionMessage });
      else registry.broadcast({
        type: 'stream_end',
        messageId: streamMsgId,
        final: companionMessage,
      });

      // Push notification for offline user
      if (this.pushService && fullResponse) {
        const preview = fullResponse.substring(0, 120).replace(/\n/g, ' ');
        this.pushService.sendIfOffline({
          title: isAutonomous ? `${cfg.identity.companion_name} (autonomous)` : cfg.identity.companion_name,
          body: preview,
          threadId,
          tag: `msg-${streamMsgId}`,
          url: companionPath('/chat'),
        }).catch(err => console.error('Push error:', err));
      }
    };

    if (hold) {
      let settled = false;
      hold.onHeld({
        text: fullResponse,
        commit: () => { if (settled) return; settled = true; finish(); },
        discard: () => { settled = true; },
      });
    } else {
      finish();
    }

    return fullResponse;
  }
}

// ---------------------------------------------------------------------------
// Agent singleton accessor (Hale finding #1, 2026-07-02). The background
// subagents (outlook-author, handoff, digest) call the SDK's query() directly,
// OUTSIDE the QueryQueue — two concurrent query() calls contend for the same
// subscription rate limit and can bounce the user's live interactive turn. This
// gives them a shared busy-check so they defer to the interactive path.
// (Registered by server.ts right after construction.)
// ---------------------------------------------------------------------------
const liveLocal = tenantLocal<AgentService | null>(() => null);

/** Registered right after construction: server.ts for the process (tenancy off), boot for each tenant, inside that tenant. */
export function registerAgentService(agent: AgentService): void {
  liveLocal.set(agent);
  setTurnProbe(() => agent.isProcessing()); // the identity journal says whether a turn was running when a change on disk was first noticed
}

/** True when the interactive QueryQueue is mid-turn. Background authors
 *  should defer rather than fire a concurrent query(). With tenancy on and no tenant current there is no agent to be busy: false. */
export function isInteractiveAgentBusy(): boolean {
  if (tenancyEnabled() && !currentTenant()) return false;
  return liveLocal.get()?.isProcessing() ?? false;
}
