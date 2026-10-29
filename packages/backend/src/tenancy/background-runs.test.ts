// The operator's switch for background model runs (tenants.background_runs) is a CEILING (round 7): a fake provider counts every model call; with the switch
// off in the process yaml it stays at zero for every tenant, with one boot line each, and a tenant that asks for `background_runs: true` is told once and stays off.
// (The other direction, process on and a tenant off, is background-ceiling.test.ts.)
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({ id: (): string => '', calls: [] as string[] }));
vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: () => {
    h.calls.push(h.id());
    const it = (async function* () {
      yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'ok' }] } };
      yield { type: 'result', subtype: 'success', session_id: 's' };
    })();
    return Object.assign(it, { mcpServerStatus: async () => [], interrupt: async () => {}, close: () => {} });
  },
}));
vi.mock('../services/rolling-context.js', async (orig) => ({ ...(await orig<object>()), getRolling: () => ({ maybeCompact: async () => {}, readTurns: async () => [] }), rollingEnabledForActiveProvider: () => false }));
vi.mock('../services/revien.js', async (orig) => ({ ...(await orig<object>()), recallForPrompt: async () => '', ingestTurn: async () => {} }));
vi.mock('../services/hooks.js', async (orig) => ({
  ...(await orig<object>()), createHooks: () => ({}), buildOrientationContext: async () => '', prefetchMindContext: async () => '', maybeSnapshotTone: () => {},
}));
vi.mock('../services/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => new Float32Array(384) })); // createMessage fires a background embed (a model download on a fresh runner): none here

import { bootTenants, stopTenantServices } from './boot.js';
import { currentTenant, enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { runHandoff } from '../services/handoff.js';
import { authorOutlook } from '../services/outlook-author.js';
import type { Orchestrator } from '../services/orchestrator.js';
import type { AgentService } from '../services/agent.js';

h.id = () => currentTenant()?.id ?? '';
let runtimes: Map<string, TenantRuntime>;
const lines: string[] = [];

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  cfg.orchestrator.enabled = true;
  // The process says off for every tenant; bea asks for on (a ceiling: it stays off and is told once); cal says off again (a no-op).
  (cfg as unknown as { tenants: unknown }).tenants = { background_runs: false, dir: makeTenantsDir({
    ada: { yaml: 'hosts: [ada.example.net]\n' },
    bea: { yaml: 'hosts: [bea.example.net]\nbackground_runs: true\n' },
    cal: { yaml: 'hosts: [cal.example.net]\nbackground_runs: false\n' },
  }) };
  runtimes = bootTenants(express(), safeTenancyProcess(cfg, { fakeProvider: true }));
});
afterAll(async () => {
  await stopBootedTenants();
  await stopTenantServices(runtimes.values());
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map());
  vi.useRealTimers(); vi.restoreAllMocks();
});

const rt = (id: string) => runtimes.get(id)!;
const wake = (id: string) => runInTenant(rt(id), async () => {
  const o = rt(id).services.orchestrator as Orchestrator;
  await o.triggerManualWake('morning');
});
const countFor = (id: string) => h.calls.filter((c) => c === id).length;

describe('background_runs off', () => {
  it('prints one boot line for each tenant it is off for, bea included, and tells bea once that its true is a no-op', () => {
    for (const id of ['ada', 'bea', 'cal']) expect(lines.filter((l) => l.includes(`tenant ${id}: background model runs are off`))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('tenant bea: background runs stay off: the operator has them off'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('tenant ada: background runs stay off'))).toBe(false);
  });

  it('no wake, author or handoff starts a model run for a tenant it is off for (the counter stays at 0)', async () => {
    for (const id of ['ada', 'bea', 'cal']) {
      await wake(id);
      expect(await runInTenant(rt(id), () => authorOutlook())).toBe(false);
      expect((await runInTenant(rt(id), () => runHandoff())).reason).toBe('background_runs_off');
      await runInTenant(rt(id), () => (rt(id).services.agentService as AgentService).processAutonomous('no-such-thread', 'x'));
    }
    expect(countFor('ada')).toBe(0);
    expect(countFor('bea')).toBe(0); // (asked for true: the operator's false is a ceiling)
    expect(countFor('cal')).toBe(0);
  });

  it('the schedulers of the tenants it is off for are not started (no timer fires a run when time passes)', async () => {
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(6 * 3600 * 1000);
    for (const id of ['ada', 'bea', 'cal']) expect(countFor(id)).toBe(0);
  }, 60_000);
});
