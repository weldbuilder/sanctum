// Round 7, item 2: the operator's tenants.background_runs is a CEILING. effective = process AND tenant: a tenant may turn background runs off for itself, never on under
// an operator false; a tenant.yaml or config edit that says true under false is accepted and logged once as "background runs stay off: the operator has them off".
// (The process-false direction is background-runs.test.ts.) A fake provider counts every model call.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { effectiveBackgroundRuns, resetBackgroundCeilingNotes } from './background.js';
import { createTenantRuntime } from './runtime.js';
import { tenantEditRefusal } from './edit.js';
import { currentTenant, enableTenancy, registerProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import type { Orchestrator } from '../services/orchestrator.js';

h.id = () => currentTenant()?.id ?? '';
let runtimes: Map<string, TenantRuntime>;
const lines: string[] = [];

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  cfg.orchestrator.enabled = true;
  // The process allows background runs; ada is not told (on), bea turns them off for itself.
  (cfg as unknown as { tenants: unknown }).tenants = { background_runs: true, dir: makeTenantsDir({
    ada: { yaml: 'hosts: [ada.example.net]\n' },
    bea: { yaml: 'hosts: [bea.example.net]\nbackground_runs: false\n' },
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
const wake = (id: string) => runInTenant(rt(id), async () => { await (rt(id).services.orchestrator as Orchestrator).triggerManualWake('morning'); });
const countFor = (id: string) => h.calls.filter((c) => c === id).length;

describe('operator true: the tenant may turn it off for itself, and not turn it on from a false', () => {
  it('ada (not told) runs: the same wake reaches the (fake) provider; bea (false) does not and says so once', async () => {
    await wake('ada');
    await wake('bea');
    expect(countFor('ada')).toBeGreaterThan(0);
    expect(countFor('bea')).toBe(0);
    expect(lines.filter((l) => l.includes('tenant bea: background model runs are off'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('tenant ada: background model runs are off'))).toBe(false);
    expect(lines.some((l) => l.includes('background runs stay off'))).toBe(false);
  });
});

describe('effectiveBackgroundRuns is process AND tenant (default true each)', () => {
  const proc = (v: unknown) => ({ tenants: v === undefined ? {} : { background_runs: v } }) as never;
  it.each([
    [true, true, true], [true, false, false], [true, undefined, true],
    [false, true, false], [false, false, false], [false, undefined, false],
    [undefined, true, true], [undefined, false, false], [undefined, undefined, true],
    [true, 'yes', false], ['no', true, false], [true, 0, false], [true, 'false', false],
  ])('process %s, tenant %s -> %s', (p, t, want) => {
    expect(effectiveBackgroundRuns(proc(p), t === undefined ? {} : { background_runs: t })).toBe(want);
  });
});

describe('a tenant true under an operator false is accepted and told once (boot, reload and the config editor)', () => {
  const closers: Array<{ close(): void }> = [];
  afterEach(() => { for (const d of closers.splice(0)) { try { d.close(); } catch { /* closed */ } } enableTenancy(false); registerProcessConfig(() => null); });
  const operatorFalse = () => { const c = processConfigFor(resolve(tmpdir(), 'sanctum-process')); (c as unknown as { tenants: unknown }).tenants = { background_runs: false }; return c; };
  const told = (): string[] => lines.filter((l) => l.includes('tenant zed: background runs stay off: the operator has them off'));

  it('reload: a tenant.yaml that now says true is accepted, the line is printed once however often it reloads, and the switch stays off', () => {
    resetBackgroundCeilingNotes();
    const root = makeTenantsDir({ zed: { yaml: 'hosts: [zed.example.net]\n' } });
    const proc = operatorFalse();
    registerProcessConfig(() => proc);
    const z = createTenantRuntime(proc, 'zed', join(root, 'zed'));
    closers.push(z.db);
    enableTenancy(true);
    const before = told().length;
    writeFileSync(join(root, 'zed', 'tenant.yaml'), safeTenantYaml('hosts: [zed.example.net]\nbackground_runs: true\n'));
    z.reload(); z.reload();
    expect(told().length - before).toBe(1);
    expect(effectiveBackgroundRuns(proc, z.config)).toBe(false);
    expect(readFileSync(join(root, 'zed', 'tenant.yaml'), 'utf8')).toContain('background_runs: true'); // accepted as written
  });

  it('config editor: a save with background_runs: true is not refused, prints the line once, and a save that turns it off prints nothing', () => {
    resetBackgroundCeilingNotes();
    const root = makeTenantsDir({ zed: { yaml: 'hosts: [zed.example.net]\n' } });
    const proc = operatorFalse();
    registerProcessConfig(() => proc);
    const z = createTenantRuntime(proc, 'zed', join(root, 'zed'));
    closers.push(z.db);
    enableTenancy(true);
    const before = told().length;
    expect(runInTenant(z, () => tenantEditRefusal({ hosts: ['zed.example.net'], background_runs: false }, 'hosts: [zed.example.net]\n'))).toBeNull();
    expect(told().length - before).toBe(0);
    expect(runInTenant(z, () => tenantEditRefusal({ hosts: ['zed.example.net'], background_runs: true }, 'hosts: [zed.example.net]\n'))).toBeNull();
    expect(runInTenant(z, () => tenantEditRefusal({ hosts: ['zed.example.net'], background_runs: true }, 'hosts: [zed.example.net]\n'))).toBeNull();
    expect(told().length - before).toBe(1);
  });
});
