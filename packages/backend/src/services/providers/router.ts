// The brain router: which harness takes a turn, and what happens when it cannot.
//
// agent.ts has ONE call site (`routedQuery` where it used to call `query`). This module decides the order of brains for the
// turn (the primary harness, agent.provider; and the fallback, agent.fallback), runs the first, and, if it fails BEFORE it has
// said or done anything, classifies the failure and tries the next. Once a brain has produced output (a token, a tool call) the
// turn is its own: a later failure is surfaced as it always was, never retried on the other brain, because a second answer
// after a half answer, or a tool run twice, is worse than an error.
//
//   mode off    primary only.
//   mode always fallback first; the primary is the safety net.
//   mode auto   primary first, unless it is marked unhealthy, then the fallback first (primary still the net).
//               AUTH, CREDIT and RATE_LIMIT mark the primary unhealthy for `unhealthy_minutes`; HARNESS_MISSING marks it
//               until a primary run succeeds (or the provider setting changes). The other fallover classes (TIMEOUT, NETWORK,
//               SERVER, HARNESS_HUNG) move this turn only.
//
// State a status page needs goes to the KV: `brain_active` ('primary' | 'fallback') and `brain_last_error` (a class word, never
// a message). A change of brain is reported through `onEvent` (agent.ts posts the system line and the `brain_changed` message).
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { getSanctumConfig } from '../../config.js';
import type { FallbackConfig } from '../../config.js';
import { getConfig, setConfig } from '../db.js';
import { childRunBase } from '../../tenancy/child.js';
import { classifyFailure, isFalloverClass, type FailClass } from '../error-class.js';
import { query as primaryQuery, activeProvider } from './index.js';
import { openaiCompatQuery } from './openai-compat-harness.js';

export type Brain = 'primary' | 'fallback';

export interface BrainHealth {
  /** Epoch ms until which the primary is out of the order (AUTH, CREDIT, RATE_LIMIT), or null. */
  unhealthyUntil: number | null;
  /** HARNESS_MISSING: the provider whose binary was missing, or ''. Counts only while the primary is still that provider. */
  missingProvider: string;
}

/** The order of brains for one turn. Pure. */
export function planBrains(a: { mode: FallbackConfig['mode']; fallbackReady: boolean; health: BrainHealth; primaryName: string; now: number }): Brain[] {
  if (a.mode === 'off' || !a.fallbackReady) return ['primary'];
  if (a.mode === 'always') return ['fallback', 'primary'];
  const unhealthy = (a.health.unhealthyUntil !== null && a.health.unhealthyUntil > a.now) || (a.health.missingProvider !== '' && a.health.missingProvider === a.primaryName);
  return unhealthy ? ['fallback', 'primary'] : ['primary', 'fallback'];
}

/** What a failure of the primary does to its health. Pure. */
export function healthAfterFailure(cls: FailClass, prev: BrainHealth, o: { now: number; unhealthyMinutes: number; primaryName: string }): BrainHealth {
  if (cls === 'AUTH' || cls === 'CREDIT' || cls === 'RATE_LIMIT') return { ...prev, unhealthyUntil: o.now + Math.max(1, o.unhealthyMinutes) * 60_000 };
  if (cls === 'HARNESS_MISSING') return { ...prev, missingProvider: o.primaryName };
  return prev;
}

export type BrainEvent =
  | { type: 'fallover'; cls: FailClass | null; model: string }
  | { type: 'recovered' };

export interface BrainInfo {
  active: Brain;
  /** The fallback's tool state; null on the primary (its own tools are not counted here). */
  toolsOffered: number | null;
  toolsRun: number;
  /** The fallback refused `tools` (or the model has none): it can talk but cannot act. */
  degraded: boolean;
  /** This turn moved off the order's first choice, and why (null in `always` mode, where the fallback is simply first). */
  failedOver: boolean;
  cls: FailClass | null;
}

export interface RouterDeps {
  now(): number;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  config(): FallbackConfig | undefined;
  primaryName(): string;
  hasKey(envName: string): boolean;
  primary(params: { prompt: string | AsyncIterable<any>; options?: Options }): Query;
  fallback(params: { prompt: string | AsyncIterable<any>; options?: Options }): Query;
  onEvent?(e: BrainEvent): void;
  /** How long an attempt may produce nothing at all before it is called hung (HARNESS_HUNG). */
  firstOutputMs: number;
}

/** No visible output at all from a brain for this long = hung. A turn that has started producing output is never timed. */
export const FIRST_OUTPUT_MS = 180_000;

const K = { active: 'brain_active', lastError: 'brain_last_error', lastErrorAt: 'brain_last_error_at', fallbackError: 'brain_fallback_error', until: 'brain.primary_unhealthy_until', missing: 'brain.primary_missing' } as const;

export const defaultDeps: RouterDeps = {
  now: () => Date.now(),
  kvGet: (k) => { try { return getConfig(k); } catch { return null; } },
  kvSet: (k, v) => { try { setConfig(k, v); } catch (e) { console.warn('[brain] could not record', k, e instanceof Error ? e.message : e); } },
  config: () => getSanctumConfig().agent.fallback,
  primaryName: () => activeProvider(),
  hasKey: (name) => !!childRunBase()[name],
  primary: (p) => primaryQuery(p),
  fallback: (p) => openaiCompatQuery(p),
  firstOutputMs: FIRST_OUTPUT_MS,
};

const warned = new Set<string>();
const warnOnce = (k: string, msg: string): void => { if (!warned.has(k)) { warned.add(k); console.warn(msg); } };
/** Test hook. */
export function resetRouterWarnings(): void { warned.clear(); }

/** The fallback is configured AND usable: a provider, a mode other than off, an endpoint, a model and its key. A half-set block is
 *  one warning and the primary alone, never a turn that fails on the fallback's missing key. */
export function fallbackReady(d: Pick<RouterDeps, 'config' | 'hasKey'> = defaultDeps): boolean {
  const c = d.config();
  if (!c || c.provider !== 'openai-compat' || c.mode === 'off' || !c.mode) return false;
  const keyVar = (c.api_key_env || 'FALLBACK_API_KEY').trim();
  const missing = [!c.base_url?.trim() && 'agent.fallback.base_url', !c.model?.trim() && 'agent.fallback.model', !d.hasKey(keyVar) && keyVar].filter(Boolean);
  if (missing.length) { warnOnce('half', `[brain] agent.fallback is set (mode ${c.mode}) but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing: the primary harness runs alone until it is complete.`); return false; }
  return true;
}

export function readHealth(d: Pick<RouterDeps, 'kvGet'>): BrainHealth {
  const until = Number(d.kvGet(K.until));
  return { unhealthyUntil: Number.isFinite(until) && until > 0 ? until : null, missingProvider: d.kvGet(K.missing) ?? '' };
}
function writeHealth(d: Pick<RouterDeps, 'kvSet'>, h: BrainHealth): void {
  d.kvSet(K.until, h.unhealthyUntil ? String(h.unhealthyUntil) : '');
  d.kvSet(K.missing, h.missingProvider);
}

// ─── Reading a failure out of a message ──────────────────────────────────────────────────────────────────────────────

/** A message that is the brain failing: an assistant message carrying an SDK `error`, or a result that is not a success.
 *  Returns the class, or null when the message is not a failure at all. */
export function failureInMessage(msg: any): FailClass | null {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'assistant' && typeof msg.error === 'string') {
    const c = classifyFailure({ error: msg.error, message: textOfAssistant(msg) });
    return c;
  }
  if (msg.type === 'result' && (msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success'))) {
    // error_max_turns is the turn running out of room, not the brain being unavailable.
    if (msg.subtype === 'error_max_turns') return 'OTHER';
    return classifyFailure({ errors: msg.errors, result: msg.result });
  }
  return null;
}
function textOfAssistant(msg: any): string {
  const c = msg?.message?.content;
  return Array.isArray(c) ? c.map((b: any) => (b?.type === 'text' ? b.text : '')).join('') : typeof c === 'string' ? c : '';
}

/** A message the person would see or that did something: from here the turn belongs to this brain. */
export function isVisible(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case 'stream_event': { const t = msg.event?.type; return t === 'content_block_start' || t === 'content_block_delta' || t === 'content_block_stop'; }
    case 'assistant': case 'user': case 'tool_progress': case 'result': return true;
    default: return false;
  }
}

class Stalled extends Error { constructor() { super('no output'); this.name = 'Stalled'; } }

// ─── The Query ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function routedQuery(params: { prompt: string | AsyncIterable<any>; options?: Options }, ctx: { onEvent?: (e: BrainEvent) => void } = {}, over: Partial<RouterDeps> = {}): Query {
  const d: RouterDeps = { ...defaultDeps, ...over, onEvent: ctx.onEvent ?? over.onEvent };
  const cfg = d.config();
  const primaryName = d.primaryName();
  const ready = fallbackReady(d);
  const order = planBrains({ mode: cfg?.mode ?? 'off', fallbackReady: ready, health: readHealth(d), primaryName, now: d.now() });
  const parent = params.options?.abortController;
  const info: BrainInfo = { active: order[0], toolsOffered: null, toolsRun: 0, degraded: false, failedOver: false, cls: null };
  let current: Query | null = null;
  let currentAc: AbortController | null = null;

  function start(brain: Brain): Query {
    const ac = new AbortController();
    if (parent?.signal.aborted) ac.abort(); else parent?.signal.addEventListener('abort', () => ac.abort(), { once: true });
    currentAc = ac;
    const options = { ...(params.options ?? {}), abortController: ac } as Options;
    // The Claude Code child gets no option it does not know: `sanctum` is for the adapters.
    if (brain === 'primary' && primaryName === 'claude') delete (options as any).sanctum;
    let q: Query;
    try {
      q = (brain === 'primary' ? d.primary : d.fallback)({ prompt: params.prompt, options });
    } catch (e) {
      // A harness that cannot even start fails like one that fails on its first read: the same classification, the same fallover.
      q = (async function* () { throw e; })() as unknown as Query;
    }
    current = q;
    return q;
  }

  // The first attempt starts now, not on first read: agent.ts asks the query for its MCP status straight after creating it.
  const first = start(order[0]);
  if (order[0] === 'fallback' && cfg?.mode === 'auto') { info.failedOver = true; info.cls = (d.kvGet(K.lastError) as FailClass | null) || null; } // pinned off the primary

  type Failure = { cls: FailClass; err?: unknown; msgs?: any[] };
  const surface = async function* (f: Failure | null): AsyncGenerator<any> {
    if (f?.err) throw f.err;
    for (const b of f?.msgs ?? []) yield b;
  };

  async function* run(): AsyncGenerator<any> {
    let firstFailure: Failure | null = null;
    for (let i = 0; i < order.length; i++) {
      const brain = order[i];
      const q = i === 0 ? first : start(brain);
      info.active = brain;

      const buf: any[] = [];
      let committed = false;
      let failure: Failure | null = null;
      const it = q[Symbol.asyncIterator]();
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<never>((_, rej) => { stallTimer = setTimeout(() => rej(new Stalled()), d.firstOutputMs); });
      stall.catch(() => {});
      const clear = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = undefined; } };
      try {
        for (;;) {
          const r = await Promise.race([it.next(), committed ? new Promise<never>(() => {}) : stall]);
          if (r.done) break;
          const msg = r.value;
          if (!committed) {
            const fc = failureInMessage(msg);
            if (fc) { failure = { cls: fc, msgs: [...buf, msg] }; break; }
            if (!isVisible(msg)) { buf.push(msg); continue; }
            committed = true; clear();
            onCommit(brain);
            for (const b of buf) yield b;
            buf.length = 0;
          }
          yield msg;
        }
      } catch (e) {
        clear();
        if (parent?.signal.aborted) throw e;
        if (e instanceof Stalled) {
          currentAc?.abort(); void Promise.resolve(it.return?.()).catch(() => {});
          failure = { cls: 'HARNESS_HUNG', err: Object.assign(new Error('the harness produced no output (went silent)'), { kind: 'harness_hung' }) };
        } else if (committed) {
          throw e; // the turn is this brain's now: surfaced as it always was
        } else {
          failure = { cls: classifyFailure(e), err: e };
        }
      }
      clear();

      if (!failure) {
        if (!committed) { onCommit(brain); for (const b of buf) yield b; } // a run that ended with nothing visible
        finishInfo(q);
        if (brain === 'primary') primaryOk();
        return;
      }
      // A failure before anything was shown.
      if (failure.cls === 'CANCELLED' || parent?.signal.aborted) { yield* surface(failure); return; }
      if (!firstFailure) firstFailure = failure;
      currentAc?.abort();
      record(brain, failure.cls);
      const another = i < order.length - 1;
      // A broken fallback never blocks the primary; the primary hands over only for a class the fallback can fix.
      if (another && (brain === 'fallback' || isFalloverClass(failure.cls))) {
        if (brain === 'primary') { info.failedOver = true; info.cls = failure.cls; }
        continue;
      }
      // Nobody else to ask: the primary's failure is the news, as it was before the router existed.
      yield* surface(brain === 'primary' ? failure : firstFailure);
      return;
    }
  }

  /** Bookkeeping of a failed attempt. */
  function record(brain: Brain, cls: FailClass): void {
    if (brain === 'fallback') { d.kvSet(K.fallbackError, cls); return; }
    d.kvSet(K.lastError, cls);
    d.kvSet(K.lastErrorAt, new Date(d.now()).toISOString());
    if (ready && cfg) writeHealth(d, healthAfterFailure(cls, readHealth(d), { now: d.now(), unhealthyMinutes: cfg.unhealthy_minutes, primaryName }));
  }

  function onCommit(brain: Brain): void {
    info.active = brain;
    const was = (d.kvGet(K.active) as Brain | null) ?? 'primary';
    d.kvSet(K.active, brain);
    if (brain === 'fallback' && was !== 'fallback') d.onEvent?.({ type: 'fallover', cls: info.failedOver ? info.cls : null, model: cfg?.model ?? '' });
    else if (brain === 'primary' && was === 'fallback') d.onEvent?.({ type: 'recovered' });
  }
  function primaryOk(): void {
    const h = readHealth(d);
    if (h.unhealthyUntil !== null || h.missingProvider) writeHealth(d, { unhealthyUntil: null, missingProvider: '' });
  }
  function finishInfo(q: Query): void {
    const m = (q as any).meta as { toolsOffered: number; toolsRun: number; degraded: boolean } | undefined;
    if (m) { info.toolsOffered = m.toolsOffered; info.toolsRun = m.toolsRun; info.degraded = m.degraded; }
  }

  const gen = run();
  const live = () => current as Query | null;
  return Object.assign(gen, {
    brainInfo: (): BrainInfo => {
      const m = (live() as any)?.meta as { toolsOffered: number; toolsRun: number; degraded: boolean } | undefined;
      return m && info.active === 'fallback' ? { ...info, toolsOffered: m.toolsOffered, toolsRun: m.toolsRun, degraded: m.degraded } : { ...info };
    },
    interrupt: async () => { parent?.abort(); await live()?.interrupt?.(); },
    mcpServerStatus: async () => (await live()?.mcpServerStatus?.()) ?? [],
    setModel: async (m?: string) => { await live()?.setModel?.(m); },
    setPermissionMode: async (m: any) => { await live()?.setPermissionMode?.(m); },
    supportedCommands: async () => (await live()?.supportedCommands?.()) ?? [],
    supportedModels: async () => (await live()?.supportedModels?.()) ?? [],
  }) as unknown as Query;
}
