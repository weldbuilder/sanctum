// Mind watchdog. The backend is what calls the Mind, so the backend watches it.
//
// One probe, two steps: GET /health (open; answers version and schema) to see that a sanctum-mind
// is there, then one cheap read verb (mind_thread list, limit 1) with the bearer and mind_id to
// prove the key and the id. The result is one record, { state, checkedAt, latencyMs, version?,
// error? }, with state ok | offline | unauthorized | forbidden | incomplete | off.
//
// What each outcome becomes:
//   /health unreachable, timed out, not a sanctum-mind, db down, oversized, any non-ok  -> offline (the reason in error)
//   /health ok, verb answers ok                                                         -> ok
//   /health ok, verb 401 unauthorized (the key is wrong)                                -> unauthorized
//   /health ok, verb 403 forbidden (the key is fine, that mind id is not allowed)       -> forbidden
//   /health ok, verb timeout / unreachable / 5xx / invalid_input / any other error      -> offline, with the
//        verb's error class in error (health answering does not make a Mind that cannot do its work "ok")
//   mind id, key or URL missing                                                         -> incomplete (no network)
//   switched off                                                                        -> off (no network)
//
// Off or incomplete (mind id, key or URL missing) never touches the network. A change of state is
// logged once and broadcast as `mind_status`; a state that holds is silent. The record never carries
// the key or the URL, and neither do the log lines.
//
// POST /api/mind/test runs the same probe now: against the saved settings (recorded like a tick) or
// against a draft from the form (never recorded, never logged, never stored). One test at a time,
// and no more than one per two seconds.
import type { MindStatus, MindState } from '@sanctum/shared';
import {
  callMindHealth, callMindVerb, describeMindSettings, mindIdProblem, mindRootFrom, savedMindId, savedMindKeyFor,
  type MindKeySource, type MindSettings, type MindSettingsReport,
} from './mind-client.js';
import { bindCurrentTenant, tenantLocal } from '../tenancy/context.js';

/** How often the saved Mind is probed. */
export const PROBE_INTERVAL_MS = 60_000;
export const PROBE_TIMEOUT_MS = 6000;
/** Least gap between two accepted POST /api/mind/test calls. */
export const TEST_MIN_GAP_MS = 2000;

export interface ProbeOptions { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number }

/** One probe of a complete target. Never throws, never logs. */
export async function probeMind(target: MindSettings, opts: ProbeOptions = {}): Promise<MindStatus> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = now();
  const record = (state: MindState, extra: { version?: string; error?: string; measured?: boolean } = {}): MindStatus => ({
    state,
    checkedAt: new Date(now()).toISOString(),
    latencyMs: extra.measured ? Math.max(0, now() - started) : null,
    ...(extra.version ? { version: extra.version } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  });

  const health = await callMindHealth(target.root, timeoutMs, fetchImpl);
  if (!health.ok) {
    const error = health.code === 'not_sanctum_mind' ? 'the address answers, but not as a sanctum-mind'
      : health.code === 'db_down' ? "the Mind is up but cannot reach its database"
      : health.code === 'timeout' ? 'no answer from the Mind (timed out)'
      : health.code === 'response_too_large' ? 'the address sent back far more than a sanctum-mind would'
      : health.code === 'unreachable' ? 'no answer from the Mind (could not connect)'
      : `the Mind answered with an error (${health.code.replace('http_', 'HTTP ')})`;
    return record('offline', { error, version: health.version });
  }
  const version = health.version;

  let verb;
  try {
    verb = await callMindVerb('mind_thread', { operation: 'list', status: 'active', limit: 1 }, timeoutMs, target, fetchImpl, { quiet: true });
  } catch {
    verb = { ok: false as const, code: 'unreachable', message: '' };
  }
  if (verb.ok) return record('ok', { version, measured: true });
  switch (verb.code) {
    case 'unauthorized': return record('unauthorized', { version, error: 'the Mind refused the key' });
    case 'forbidden': return record('forbidden', { version, error: 'this mind id is not allowed for this key' });
    case 'timeout': return record('offline', { version, error: 'the Mind answered /health but then timed out' });
    case 'unreachable': return record('offline', { version, error: 'the Mind stopped answering' });
    case 'not_sanctum_mind': return record('offline', { version, error: 'the address answers, but not as a sanctum-mind' });
    case 'invalid_input': return record('offline', { version, error: 'the Mind rejected the request (is this a matching sanctum-mind version?)' });
    default: return record('offline', { version, error: `the Mind answered with an error (${String(verb.code).slice(0, 40)})` });
  }
}

/** What a settings report says before any network: a status for off or incomplete, else the target to probe. */
export function evaluateReport(report: MindSettingsReport): { status: Pick<MindStatus, 'state' | 'error'> } | { target: MindSettings } {
  if (!report.enabled) return { status: { state: 'off' } };
  if (report.settings) return { target: report.settings };
  const parts = [report.missing.length ? `${report.missing.join(' and ')} missing` : '', ...(report.invalid ?? [])].filter(Boolean);
  return { status: { state: 'incomplete', error: parts.join('; ') } };
}

/**
 * One line about the Mind for a script that never prompts and never writes (npm run update): the same
 * probe the watchdog runs, or why there is none. No key, no URL.
 */
export async function mindCheckLine(report: MindSettingsReport, opts: ProbeOptions = {}): Promise<string> {
  const e = evaluateReport(report);
  if ('status' in e) {
    return e.status.state === 'off' ? 'Mind: off.' : `Mind: on, but ${e.status.error ?? 'not set up'}. Set it in Settings → Mind.`;
  }
  const s = await probeMind(e.target, opts);
  switch (s.state) {
    case 'ok': return `Mind: answered (${[s.version, s.latencyMs != null ? `${Math.round(s.latencyMs)} ms` : ''].filter(Boolean).join(', ')}).`;
    case 'unauthorized': return `Mind: answered, but it refused the key (${s.error ?? 'refused'}).`;
    case 'forbidden': return `Mind: answered, but ${s.error ?? 'this mind id is not allowed for this key'}.`;
    default: return `Mind: not answering (${s.error ?? 'no answer'}).`;
  }
}

/** The form's draft, as posted. Every field is optional text. */
export interface MindDraft { url?: string; mind_id?: string; api_key?: string }

export type MindTestResult =
  | { ok: true; status: MindStatus }
  | { ok: false; reason: 'busy' | 'too_soon'; retryAfterMs: number };

export interface WatchdogDeps {
  now?: () => number;
  describe?: () => MindSettingsReport;
  savedKeyFor?: (root: string) => { key: string; source: MindKeySource } | null;
  savedMindId?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  broadcast?: (status: MindStatus) => void;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class MindWatchdog {
  private status: MindStatus;
  private timer: unknown = null;
  private inFlight: Promise<MindStatus> | null = null;
  private again = false;
  private everProbed = false;
  private testing = false;
  private lastTestAt = -Infinity;
  private readonly now: () => number;
  private readonly describe: () => MindSettingsReport;
  private readonly savedKeyFor: NonNullable<WatchdogDeps['savedKeyFor']>;
  private readonly savedMindId: () => string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly broadcast: (status: MindStatus) => void;
  private readonly log: (line: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** Network probes run on the saved settings (tests assert off and incomplete never add to it). */
  probes = 0;

  constructor(deps: WatchdogDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.describe = deps.describe ?? describeMindSettings;
    this.savedKeyFor = deps.savedKeyFor ?? savedMindKeyFor;
    this.savedMindId = deps.savedMindId ?? savedMindId;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.intervalMs = deps.intervalMs ?? PROBE_INTERVAL_MS;
    this.broadcast = deps.broadcast ?? (() => {});
    this.log = deps.log ?? ((line) => console.log(line));
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; });
    this.clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.status = { state: 'off', checkedAt: new Date(this.now()).toISOString(), latencyMs: null };
  }

  /** The last record. */
  get(): MindStatus { return { ...this.status }; }

  /** Start the schedule: one check now, then one per interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    // Tenant mode: each tick runs as the tenant that started this watchdog (bindCurrentTenant is the function itself with tenancy off).
    this.timer = this.setTimer(bindCurrentTenant(() => { void this.check().catch(() => {}); }), this.intervalMs);
    void this.check().catch(() => {});
  }

  stop(): void {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }

  /** The record for a reader: off and incomplete are read from the settings now (no network); otherwise the last probe, running the first one if none has run. */
  async current(): Promise<MindStatus> {
    const e = evaluateReport(this.describe());
    if ('status' in e) return this.record(e.status.state, e.status.error);
    return this.everProbed ? this.get() : this.check();
  }

  /** One check of the saved settings. Concurrent callers share it. Off and incomplete do not touch the network. */
  check(): Promise<MindStatus> {
    if (!this.inFlight) this.inFlight = this.loop().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * A check because settings just changed. When one is already running it read the settings before the
   * change, so one more check is queued for when it ends (however many changes arrive meanwhile), and the
   * caller gets the final reading.
   */
  recheck(): Promise<MindStatus> {
    if (this.inFlight) this.again = true;
    return this.check();
  }

  private async loop(): Promise<MindStatus> {
    let result: MindStatus;
    do {
      this.again = false;
      result = await this.run();
    } while (this.again);
    return result;
  }

  private async run(): Promise<MindStatus> {
    const e = evaluateReport(this.describe());
    if ('status' in e) return this.record(e.status.state, e.status.error);
    this.probes += 1;
    const result = await probeMind(e.target, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, now: this.now });
    this.everProbed = true;
    return this.adopt(result);
  }

  private record(state: MindState, error?: string): MindStatus {
    return this.adopt({ state, checkedAt: new Date(this.now()).toISOString(), latencyMs: null, ...(error ? { error } : {}) });
  }

  private adopt(next: MindStatus): MindStatus {
    const prev = this.status;
    this.status = next;
    if (prev.state !== next.state) {
      this.log(`[Mind] watchdog: ${prev.state} -> ${next.state}${next.error ? ` (${next.error})` : ''}`);
      this.broadcast({ ...next });
    }
    return { ...next };
  }

  /**
   * "Test connection". With a draft it probes what the form holds, whether or not the Mind is switched
   * on, and touches nothing: not the record, not the log, not the socket. Without one it checks the saved
   * settings like a tick would. One at a time, one per TEST_MIN_GAP_MS.
   */
  async test(draft?: MindDraft): Promise<MindTestResult> {
    const t = this.now();
    if (this.testing) return { ok: false, reason: 'busy', retryAfterMs: TEST_MIN_GAP_MS };
    const wait = TEST_MIN_GAP_MS - (t - this.lastTestAt);
    if (wait > 0) return { ok: false, reason: 'too_soon', retryAfterMs: wait };
    this.testing = true;
    this.lastTestAt = t;
    try {
      if (!draft) return { ok: true, status: await this.check() };
      return { ok: true, status: await this.probeDraft(draft) };
    } finally {
      this.testing = false;
    }
  }

  private async probeDraft(draft: MindDraft): Promise<MindStatus> {
    const incomplete = (error: string): MindStatus => ({ state: 'incomplete', checkedAt: new Date(this.now()).toISOString(), latencyMs: null, error });
    const rawUrl = (draft.url ?? '').trim();
    // A blank mind id means the one in effect (the card's, else sanctum.yaml's): the card starts empty when
    // the id lives only in the yaml, and the test must not call that "missing".
    const mindId = (draft.mind_id ?? '').trim() || this.savedMindId();
    let apiKey = (draft.api_key ?? '').trim();
    let root = '';
    if (rawUrl) {
      if (!/^https?:\/\//i.test(rawUrl)) return incomplete('the URL must start with http:// or https://');
      root = mindRootFrom(rawUrl);
    }
    // The form never holds the saved key (it shows ••••last4), so a blank or masked key means "the saved
    // one", and only for the host it was saved for.
    if ((!apiKey || apiKey.startsWith('••••')) && root) apiKey = this.savedKeyFor(root)?.key ?? '';
    const missing = [!root && 'url', !apiKey && 'api key', !mindId && 'mind id'].filter((x): x is string => Boolean(x));
    if (missing.length) return incomplete(`${missing.join(' and ')} missing`);
    const problem = mindIdProblem(mindId);
    if (problem) return incomplete(problem);
    return probeMind({ root, bearer: apiKey, mindId }, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, now: this.now });
  }
}

// Per tenant (tenantLocal): each tenant has its own watchdog, so its state, probes and timer are its own; tenancy off, the one module instance as before.
const singleton = tenantLocal<MindWatchdog | null>(() => null);
export function getMindWatchdog(): MindWatchdog {
  let w = singleton.get();
  if (!w) { w = new MindWatchdog(); singleton.set(w); }
  return w;
}
/** Test hook, and server.ts / tenancy boot: install the instance that broadcasts. */
export function setMindWatchdog(instance: MindWatchdog | null): void { singleton.set(instance); }
