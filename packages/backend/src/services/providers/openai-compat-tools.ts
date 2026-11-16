// The tools the fallback brain is offered: the `res` verbs that have an internal route, as OpenAI function definitions.
//
// `res` (tools/res.mjs) is a CLI over POST/GET /api/internal/*; a model on a plain chat-completions endpoint has no shell to run
// it in, so each verb here is the same request `res` would make, sent from this process to the same loopback route with the
// internal token. Nothing is re-implemented: the route handlers (and their write gate, tenant check and audit) answer as ever.
//
// The set is fixed and small on purpose: a mid-tier model picks reliably from sixteen well-described functions, and each one
// maps to exactly one route. A verb whose capability is not set up on this install (voice, pictures, the Command Center) is not
// offered at all, as the companion's orientation does not offer them either.
import type { ChatToolDef } from './openai-compat.js';

export interface ToolCtx {
  threadId: string;
  /** The companion's presence namespace (SANCTUM_NAMESPACE, else 'companion'): where `note` writes. */
  namespace: string;
}
/** What is set up on this install; a tool whose capability is off is left out. */
export interface ToolGates { voice: boolean; image: boolean; cc: boolean }

export interface ToolRequest { method: 'POST' | 'GET'; route: string; body?: unknown; timeoutMs?: number }
export interface FallbackTool {
  name: string;
  /** The `res` verb(s) this stands for. */
  verb: string;
  description: string;
  parameters: Record<string, unknown>;
  gate?: keyof ToolGates;
  /** The request to make, or a plain-words refusal of bad arguments (given back to the model as the tool result). */
  request(args: Record<string, any>, ctx: ToolCtx): ToolRequest | { error: string };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const s = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });

const CONDITION = obj({
  type: s('Condition type', { enum: ['agent_free', 'presence_state', 'presence_transition', 'time_window', 'routine_missing'] }),
  state: s('presence_state: active | idle | away'),
  from: s('presence_transition: previous state'),
  to: s('presence_transition: new state'),
  after: s('time_window: HH:MM, local time'),
  before: s('time_window: HH:MM, local time'),
  routine: s('routine_missing: the routine name'),
  after_hour: { type: 'integer', description: 'routine_missing: hour of day after which a missing routine counts' },
}, ['type']);

function trigger(kind: 'impulse' | 'watcher'): FallbackTool['request'] {
  return (a) => {
    const action = str(a.action);
    if (action === 'list') return { method: 'POST', route: 'trigger', body: { action: 'list', kind } };
    if (action === 'cancel') return str(a.trigger_id) ? { method: 'POST', route: 'trigger', body: { action: 'cancel', triggerId: a.trigger_id } } : { error: 'trigger_id is required to cancel' };
    if (action !== 'create') return { error: 'action must be create, list or cancel' };
    const conditions = Array.isArray(a.conditions) ? a.conditions : [];
    if (!str(a.label)) return { error: 'label is required' };
    if (conditions.length === 0) return { error: 'at least one condition is required' };
    return { method: 'POST', route: 'trigger', body: { action: 'create', kind, label: a.label, conditions, prompt: str(a.prompt), cooldownMinutes: a.cooldown_minutes } };
  };
}

export const FALLBACK_TOOLS: FallbackTool[] = [
  {
    name: 'ask', verb: 'ask',
    description: 'Ask the person for permission in the app before doing something that needs their yes. Waits for the answer (up to 10 minutes) and returns approved, denied or expired.',
    parameters: obj({ what: s('What you want to do, in one line'), detail: s('Optional detail') }, ['what']),
    request: (a, c) => str(a.what) ? { method: 'POST', route: 'approvals', body: { what: a.what, detail: str(a.detail), threadId: c.threadId, timeoutMs: 10 * 60_000 }, timeoutMs: 10 * 60_000 + 30_000 } : { error: 'what is required' },
  },
  {
    name: 'meal', verb: 'meal',
    description: 'Log that the person ate (the sentence they said is the consent), or scratch the latest logged meal.',
    parameters: obj({ action: s('log or undo', { enum: ['log', 'undo'] }), at: s('now, HH:MM or 2pm; default now'), note: s('What they ate, optional') }, ['action']),
    request: (a, c) => a.action === 'undo' ? { method: 'POST', route: 'meal', body: { action: 'undo', threadId: c.threadId } }
      : a.action === 'log' ? { method: 'POST', route: 'meal', body: { action: 'log', at: str(a.at) ?? 'now', note: str(a.note), threadId: c.threadId } } : { error: 'action must be log or undo' },
  },
  {
    name: 'cc', verb: 'cc', gate: 'cc',
    description: 'Command Center: care log, cycle, routines, pets, countdowns, wins. `tool` is a cc_* tool name (cc_status lists the state); `args` its arguments.',
    parameters: obj({ tool: s('The Command Center tool, e.g. cc_status or cc_care'), args: { type: 'object', description: 'Arguments for that tool', additionalProperties: true } }, ['tool']),
    request: (a, c) => str(a.tool) ? { method: 'POST', route: 'cc', body: { tool: a.tool, args: a.args && typeof a.args === 'object' ? a.args : {}, threadId: c.threadId } } : { error: 'tool is required' },
  },
  {
    name: 'share', verb: 'share',
    description: 'Share an existing file on this machine into the conversation. The path must be absolute and already exist.',
    parameters: obj({ path: s('Absolute path of the file') }, ['path']),
    request: (a, c) => str(a.path) ? { method: 'POST', route: 'share', body: { path: a.path, threadId: c.threadId } } : { error: 'path is required' },
  },
  {
    name: 'canvas', verb: 'canvas',
    description: 'Create a canvas (a document shown beside the chat) from text you write now, or replace the text of an existing canvas.',
    parameters: obj({
      action: s('create or update', { enum: ['create', 'update'] }), title: s('Title (create)'), content: s('The full text'),
      content_type: s('markdown, code, text or html; default markdown', { enum: ['markdown', 'code', 'text', 'html'] }), canvas_id: s('Canvas id (update)'),
    }, ['action', 'content']),
    request: (a, c) => {
      if (!str(a.content)) return { error: 'content is required' };
      if (a.action === 'create') return str(a.title) ? { method: 'POST', route: 'canvas', body: { action: 'create', title: a.title, content: a.content, contentType: str(a.content_type) ?? 'markdown', threadId: c.threadId } } : { error: 'title is required' };
      if (a.action === 'update') return str(a.canvas_id) ? { method: 'POST', route: 'canvas', body: { action: 'update', canvasId: a.canvas_id, content: a.content } } : { error: 'canvas_id is required' };
      return { error: 'action must be create or update' };
    },
  },
  {
    name: 'timer', verb: 'timer',
    description: 'Set, list or cancel a timer: a reminder that wakes you in this thread at a time, with an optional prompt for what to do then.',
    parameters: obj({
      action: s('create, list or cancel', { enum: ['create', 'list', 'cancel'] }), label: s('Short name (create)'), context: s('Why you set it (create)'),
      fire_at: s('When it fires: an ISO time, or minutes like "+30m" as the app accepts (create)'), prompt: s('What to do when it fires (create, optional)'), timer_id: s('Timer id (cancel)'),
    }, ['action']),
    request: (a, c) => {
      if (a.action === 'list') return { method: 'POST', route: 'timer', body: { action: 'list' } };
      if (a.action === 'cancel') return str(a.timer_id) ? { method: 'POST', route: 'timer', body: { action: 'cancel', timerId: a.timer_id } } : { error: 'timer_id is required' };
      if (a.action !== 'create') return { error: 'action must be create, list or cancel' };
      if (!str(a.label) || !str(a.fire_at)) return { error: 'label and fire_at are required' };
      return { method: 'POST', route: 'timer', body: { action: 'create', label: a.label, context: str(a.context), fireAt: a.fire_at, prompt: str(a.prompt), threadId: c.threadId } };
    },
  },
  {
    name: 'touch', verb: 'touch',
    description: 'React to a message with an emoji (or take the reaction back).',
    parameters: obj({ target: s('last, or last-2, last-3, ...'), emoji: s('The emoji'), remove: { type: 'boolean', description: 'Remove the reaction instead' } }, ['target', 'emoji']),
    request: (a, c) => str(a.target) && str(a.emoji) ? { method: 'POST', route: 'react', body: { target: a.target, emoji: a.emoji, threadId: c.threadId, ...(a.remove ? { action: 'remove' } : {}) } } : { error: 'target and emoji are required' },
  },
  {
    name: 'impulse', verb: 'impulse',
    description: 'An impulse: something you want to do the next time its conditions hold (once). Create, list or cancel.',
    parameters: obj({
      action: s('create, list or cancel', { enum: ['create', 'list', 'cancel'] }), label: s('Short name (create)'), conditions: { type: 'array', items: CONDITION, description: 'All must hold (create)' },
      prompt: s('What to do when it fires (create)'), trigger_id: s('Id (cancel)'),
    }, ['action']),
    request: trigger('impulse'),
  },
  {
    name: 'watch', verb: 'watch',
    description: 'A watcher: like an impulse but it repeats, with a cooldown. Create, list or cancel.',
    parameters: obj({
      action: s('create, list or cancel', { enum: ['create', 'list', 'cancel'] }), label: s('Short name (create)'), conditions: { type: 'array', items: CONDITION, description: 'All must hold (create)' },
      prompt: s('What to do when it fires (create)'), cooldown_minutes: { type: 'integer', description: 'Minimum minutes between firings (create)' }, trigger_id: s('Id (cancel)'),
    }, ['action']),
    request: trigger('watcher'),
  },
  {
    name: 'search', verb: 'search',
    description: 'Search every thread by meaning for something that was said.',
    parameters: obj({
      query: s('What to look for'), thread: s('Limit to one thread id'), limit: { type: 'integer', description: 'Most results' },
      role: s('companion or user', { enum: ['companion', 'user'] }), after: s('Only after this date, YYYY-MM-DD'), before: s('Only before this date, YYYY-MM-DD'),
    }, ['query']),
    request: (a) => str(a.query) ? { method: 'POST', route: 'search-semantic', body: { query: a.query, thread: str(a.thread), limit: Number.isInteger(a.limit) ? a.limit : undefined, role: str(a.role), after: str(a.after), before: str(a.before) }, timeoutMs: 30_000 } : { error: 'query is required' },
  },
  {
    name: 'context', verb: 'context',
    description: "Read, set or clear the person's current card (what they are wearing, their energy, the room).",
    parameters: obj({ action: s('get, set or clear', { enum: ['get', 'set', 'clear'] }), field: s('selfie, outfit, nails, hair, energy, room or freeform'), value: s('The value (set)') }, ['action']),
    request: (a) => {
      if (a.action === 'get') return { method: 'POST', route: 'context', body: { action: 'get' } };
      if (a.action === 'set') return str(a.field) && str(a.value) ? { method: 'POST', route: 'context', body: { action: 'set', field: a.field, value: a.value } } : { error: 'field and value are required' };
      if (a.action === 'clear') return { method: 'POST', route: 'context', body: { action: 'clear', field: str(a.field) } };
      return { error: 'action must be get, set or clear' };
    },
  },
  {
    name: 'note', verb: 'note',
    description: 'Set the note you show on the home mantelpiece, or clear it.',
    parameters: obj({ text: s('The note; omit with clear=true'), clear: { type: 'boolean', description: 'Clear the note' } }),
    request: (a, c) => a.clear ? { method: 'POST', route: 'context', body: { action: 'clear', namespace: c.namespace, field: 'note' } }
      : str(a.text) ? { method: 'POST', route: 'context', body: { action: 'set', namespace: c.namespace, field: 'note', value: a.text } } : { error: 'text is required (or clear=true)' },
  },
  {
    name: 'voice', verb: 'voice', gate: 'voice',
    description: 'Say something aloud as a voice note in this conversation. Emotion tags like [whispers] or [sighs] go inside the text.',
    parameters: obj({ text: s('What to say') }, ['text']),
    request: (a, c) => str(a.text) ? { method: 'POST', route: 'tts', body: { text: a.text, threadId: c.threadId } } : { error: 'text is required' },
  },
  {
    name: 'image', verb: 'image', gate: 'image',
    description: 'Make a picture from a description and post it in this conversation.',
    parameters: obj({ prompt: s('What the picture shows'), size: s('1024x1024, 1024x1536 or 1536x1024', { enum: ['1024x1024', '1024x1536', '1536x1024'] }) }, ['prompt']),
    request: (a, c) => str(a.prompt) ? { method: 'POST', route: 'image', body: { prompt: a.prompt, ...(str(a.size) ? { size: a.size } : {}), threadId: c.threadId }, timeoutMs: 150_000 } : { error: 'prompt is required' },
  },
  {
    name: 'schedule', verb: 'routine / schedule',
    description: 'Your scheduled autonomous sessions (routines): see their status, enable, disable, reschedule, create or remove one.',
    parameters: obj({
      action: s('status, enable, disable, reschedule, create or remove', { enum: ['status', 'enable', 'disable', 'reschedule', 'create', 'remove'] }),
      wake_type: s('The routine id (enable, disable, reschedule, remove)'), cron_expr: s('Cron expression (reschedule, create)'), label: s('Name (create)'), prompt: s('What to do when it fires (create)'),
    }, ['action']),
    request: (a) => {
      switch (a.action) {
        case 'status': return { method: 'POST', route: 'orchestrator', body: { action: 'status' } };
        case 'enable': case 'disable': return str(a.wake_type) ? { method: 'POST', route: 'orchestrator', body: { action: a.action, wakeType: a.wake_type } } : { error: 'wake_type is required' };
        case 'reschedule': return str(a.wake_type) && str(a.cron_expr) ? { method: 'POST', route: 'orchestrator', body: { action: 'reschedule', wakeType: a.wake_type, cronExpr: a.cron_expr } } : { error: 'wake_type and cron_expr are required' };
        case 'create': {
          if (!str(a.label) || !str(a.cron_expr)) return { error: 'label and cron_expr are required' };
          const wakeType = String(a.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          return { method: 'POST', route: 'orchestrator', body: { action: 'create_routine', wakeType, label: a.label, cronExpr: a.cron_expr, prompt: str(a.prompt) } };
        }
        case 'remove': return str(a.wake_type) ? { method: 'POST', route: 'orchestrator', body: { action: 'remove_routine', wakeType: a.wake_type } } : { error: 'wake_type is required' };
        default: return { error: 'unknown action' };
      }
    },
  },
  {
    name: 'pulse', verb: 'pulse',
    description: 'Pulse: the lightweight awareness check that can stay silent. See its status, turn it on or off, or set how often (minutes, at least 5).',
    parameters: obj({ action: s('status, enable, disable or frequency', { enum: ['status', 'enable', 'disable', 'frequency'] }), minutes: { type: 'integer', description: 'frequency: minutes between checks, at least 5' } }, ['action']),
    request: (a) => {
      if (a.action === 'status') return { method: 'POST', route: 'orchestrator', body: { action: 'pulse_status' } };
      if (a.action === 'enable' || a.action === 'disable') return { method: 'POST', route: 'orchestrator', body: { action: 'pulse_config', enabled: a.action === 'enable' } };
      if (a.action === 'frequency') return Number.isInteger(a.minutes) && a.minutes >= 5 ? { method: 'POST', route: 'orchestrator', body: { action: 'pulse_config', frequency: a.minutes } } : { error: 'minutes must be a whole number, at least 5' };
      return { error: 'unknown action' };
    },
  },
];

/** The tools offered this turn: what is set up, minus anything the caller disabled (by tool name, or by the MCP-style names
 *  `mcp__<server>__<tool>` and the `Bash`-style names the other harnesses use for the same verb). */
export function offeredTools(gates: ToolGates, disabledTools: ReadonlySet<string> = new Set(), disabledServers: ReadonlySet<string> = new Set()): FallbackTool[] {
  if (disabledServers.has('sanctum')) return [];
  return FALLBACK_TOOLS.filter((t) => (!t.gate || gates[t.gate]) && !disabledTools.has(t.name) && !disabledTools.has(toolUseName(t.name)));
}

/** The name the app's hooks, the audit log and the tool pills see: the same shape an MCP tool has on Claude, so a pill reads "Sanctum: Timer". */
export const toolUseName = (name: string): string => `mcp__sanctum__${name}`;

export const toToolDef = (t: FallbackTool): ChatToolDef => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } });
