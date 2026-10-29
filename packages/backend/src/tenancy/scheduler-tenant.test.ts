// The scheduler per tenant (stage 3b). Fake timers and a FAKE provider: no model, no key, no real orchestrator run in any process.
// A's timers write A's database only; B's due rows never fire in A; the orchestrator log is the tenant's own, capped; stopping A leaves B ticking;
// a croner tick runs as its tenant; a wake run's child env carries the tenant's token and no process credential.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({
  id: (): string => '',
  seen: [] as { id: string; prompt: string; env?: Record<string, string | undefined> }[],
}));

vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: (p: { prompt?: string; options?: { env?: Record<string, string | undefined> } }) => {
    const id = h.id();
    h.seen.push({ id, prompt: String(p.prompt ?? ''), env: p.options?.env });
    const it = (async function* () {
      yield { type: 'assistant', session_id: `s-${id}`, message: { content: [{ type: 'text', text: `reply-${id}` }] } };
      yield { type: 'result', subtype: 'success', session_id: `s-${id}` };
    })();
    return Object.assign(it, { mcpServerStatus: async () => [], interrupt: async () => {}, close: () => {} });
  },
}));
vi.mock('../services/rolling-context.js', async (orig) => ({ ...(await orig<object>()), getRolling: () => ({ maybeCompact: async () => {}, readTurns: async () => [] }), rollingEnabledForActiveProvider: () => false }));
vi.mock('../services/revien.js', async (orig) => ({ ...(await orig<object>()), recallForPrompt: async () => '', ingestTurn: async () => {} }));
vi.mock('../services/hooks.js', async (orig) => ({
  ...(await orig<object>()), createHooks: () => ({}), buildOrientationContext: async () => '', prefetchMindContext: async () => '', maybeSnapshotTone: () => {},
}));
// No embedding model in this file: createMessage fires a background embed (a model load, and without a cached model a download with its own timers),
// which is neither the orchestrator's work nor deterministic. A fixed vector keeps the run local and the timer count about the services only.
vi.mock('../services/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => new Float32Array(384) }));
// The outlook author would make its own provider call a minute after boot; this file is about the orchestrator's runs.
vi.mock('../services/outlook-author.js', async (orig) => ({ ...(await orig<object>()), startOutlookAuthor: () => {}, stopOutlookAuthor: () => {} }));

import { bootTenants, stopTenantServices } from './boot.js';
import { currentTenant, enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { setTenantLogCap } from './console.js';
import { trackTimers, type TimerTracker } from './test-timers.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import type { Orchestrator } from '../services/orchestrator.js';
import { logPath } from '../services/orchestrator.js';
import { createThread, createTimer, createTrigger, getDb, getThread, getTodayThread } from '../services/db.js';

h.id = () => currentTenant()?.id ?? '';
let runtimes: Map<string, TenantRuntime>;
let app: express.Express;
let timers: TimerTracker;
let ada: TenantRuntime;
let bea: TenantRuntime;
const orchOf = (rt: TenantRuntime) => rt.services.orchestrator as Orchestrator;
const minute = () => vi.advanceTimersByTimeAsync(60_000);
const timerStatus = (rt: TenantRuntime, id: string) => runInTenant(rt, () => (getDb().prepare('SELECT status FROM timers WHERE id = ?').get(id) as { status: string } | undefined)?.status);
const past = () => new Date(Date.now() - 1000).toISOString();
const real = (p: string) => p.replace(/\\/g, '/').toLowerCase();

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  timers = trackTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
    ada: { yaml: 'hosts: [ada.example.net]\n' },
    bea: { yaml: 'hosts: [bea.example.net]\n' },
  }) };
  process.env.ANTHROPIC_API_KEY = 'P-process';
  app = express();
  runtimes = bootTenants(app, safeTenancyProcess(cfg, { fakeProvider: true }));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
  for (const rt of [ada, bea]) runInTenant(rt, () => createThread({ id: 't1', name: 'T', type: 'named', createdAt: new Date().toISOString() }));
});
afterAll(async () => {
  await stopBootedTenants();
  stopTenantServices(runtimes.values());
  delete process.env.ANTHROPIC_API_KEY;
  setTenantLogCap(10 * 1024 * 1024);
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map());
  timers.restore();
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('one orchestrator per tenant', () => {
  it('each tenant has its own, started inside the tenant, and app.locals answers for the current tenant only', () => {
    expect(orchOf(ada)).toBeTruthy();
    expect(orchOf(ada)).not.toBe(orchOf(bea));
    expect(runInTenant(ada, () => app.locals.orchestrator)).toBe(orchOf(ada));
    expect(runInTenant(bea, () => app.locals.orchestrator)).toBe(orchOf(bea));
    expect(() => app.locals.orchestrator).toThrow(/outside a tenant context/);
  });

  it("a croner tick runs as its tenant: the wake lands in A's database only, and the run's env is A's", async () => {
    runInTenant(ada, () => orchOf(ada).addRoutine({ wakeType: 'probe', label: 'Probe', cronExpr: '* * * * *', prompt: 'probe prompt' }));
    await minute(); // 12:01:00: the croner fires, the fake provider answers
    const daily = runInTenant(ada, () => getTodayThread());
    expect(daily).toBeTruthy();
    expect(runInTenant(bea, () => getThread(daily!.id))).toBeFalsy();
    const run = h.seen.find((s) => s.id === 'ada' && s.prompt.includes('probe prompt'))!;
    expect(run).toBeTruthy();
    expect(run.env?.INTERNAL_TOKEN).toBe(ada.token);
    expect(Object.values(run.env ?? {})).not.toContain('P-process');
    expect(run.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(h.seen.filter((s) => s.id === 'bea' && s.prompt.includes('probe prompt'))).toHaveLength(0);
    runInTenant(ada, () => orchOf(ada).removeRoutine('probe'));
  });

  it("A's timer fires and writes A's database only; B's due trigger does not fire in A", async () => {
    runInTenant(ada, () => createTimer({ id: 'timer-a', label: 'ada timer', fireAt: past(), threadId: 't1', createdAt: past() }));
    runInTenant(bea, () => createTrigger({ id: 'trig-b', kind: 'impulse', label: 'bea impulse', conditions: [{ type: 'time_window', after: '00:00' }], prompt: 'bea only', threadId: 't1', createdAt: past() }));
    await minute();
    expect(timerStatus(ada, 'timer-a')).toBe('fired');
    expect(timerStatus(bea, 'timer-a')).toBeUndefined();
    const trig = (rt: TenantRuntime) => runInTenant(rt, () => getDb().prepare('SELECT * FROM triggers WHERE id = ?').get('trig-b') as { fire_count?: number; status?: string } | undefined);
    expect(trig(ada)).toBeUndefined();
    expect(trig(bea)?.fire_count ?? 0).toBeGreaterThan(0);
    // Each run was made by its own tenant's agent.
    expect(h.seen.some((s) => s.id === 'ada' && s.prompt.includes('ada timer'))).toBe(true);
    expect(h.seen.some((s) => s.id === 'bea' && s.prompt.includes('bea only'))).toBe(true);
    expect(h.seen.some((s) => s.id === 'ada' && s.prompt.includes('bea only'))).toBe(false);
  });

  it("the orchestrator log is under the tenant's data folder, not shared, and capped", () => {
    const fileA = join(ada.dataDir, 'logs', 'orchestrator.log');
    const fileB = join(bea.dataDir, 'logs', 'orchestrator.log');
    expect(existsSync(fileA)).toBe(true);
    expect(readFileSync(fileA, 'utf8')).toContain('Starting...');
    expect(readFileSync(fileA, 'utf8')).toContain('ada timer');
    expect(readFileSync(fileA, 'utf8')).not.toContain('bea impulse');
    expect(readFileSync(fileB, 'utf8')).toContain('bea impulse');
    expect(runInTenant(ada, () => real(logPath()))).toBe(real(fileA));
    // Outside any tenant the path is the checkout's logs/orchestrator.log, as before.
    enableTenancy(false);
    try { expect(real(logPath())).toMatch(/\/logs\/orchestrator\.log$/); expect(real(logPath())).not.toContain(real(ada.dir)); } finally { enableTenancy(true); }
    // The cap: one rotation, never unbounded.
    setTenantLogCap(2000);
    runInTenant(ada, () => { for (let i = 0; i < 80; i++) orchOf(ada).setFailsafeConfig({ gentle: 100 + i }); });
    expect(statSync(fileA).size).toBeLessThanOrEqual(2000 + 200);
    expect(existsSync(`${fileA}.1`)).toBe(true);
    setTenantLogCap(10 * 1024 * 1024);
  });

  it('stopping A leaves B ticking', async () => {
    runInTenant(ada, () => orchOf(ada).stop());
    runInTenant(ada, () => createTimer({ id: 'timer-a2', label: 'ada two', fireAt: past(), threadId: 't1', createdAt: past() }));
    runInTenant(bea, () => createTimer({ id: 'timer-b2', label: 'bea two', fireAt: past(), threadId: 't1', createdAt: past() }));
    await minute();
    expect(timerStatus(bea, 'timer-b2')).toBe('fired');
    expect(timerStatus(ada, 'timer-a2')).toBe('pending');
  });

  it('a stopped scheduler starts no timer from a late config call', () => {
    const before = vi.getTimerCount();
    runInTenant(ada, () => { orchOf(ada).setPulseConfig({ enabled: true }); orchOf(ada).setFailsafeConfig({ enabled: true }); });
    expect(vi.getTimerCount(), timers.live().join('\n---\n')).toBe(before);
  });

  it('stopTenantServices stops what is left and clears every timer', async () => {
    // Flush what the last turns left pending (a slow runner does this by itself), then stop; nothing may be left, and a stray prints where it was made.
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    stopTenantServices(runtimes.values());
    expect(vi.getTimerCount(), timers.live().join('\n---\n')).toBe(0);
  });
});
