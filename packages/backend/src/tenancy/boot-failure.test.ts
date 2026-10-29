// One tenant's service start failing never stops the others or the process (Codex, stage 3b): a tenant whose cron expression is invalid is
// skipped with one line, whatever it had started is stopped, its hosts are reserved (503), and the other tenant boots and serves.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({ id: (): string => '', seen: [] as { id: string; prompt: string; env?: Record<string, string | undefined> }[] }));
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
// The outlook author would make its own provider call a minute after boot; this file is about the orchestrator's runs.
vi.mock('../services/outlook-author.js', async (orig) => ({ ...(await orig<object>()), startOutlookAuthor: () => {}, stopOutlookAuthor: () => {} }));

import { bootTenants, stopTenantServices } from './boot.js';
import { currentTenant, enableTenancy, type TenantRuntime } from './context.js';
import { setTenantRegistry, resolveTenant, isReservedHost } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';

h.id = () => currentTenant()?.id ?? '';
let runtimes: Map<string, TenantRuntime>;
let warned: string[] = [];

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  cfg.orchestrator.enabled = true;
  (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
    // '60' is not a valid minute: croner throws when the scheduler starts.
    ada: { yaml: 'hosts: [ada.example.net]\norchestrator:\n  enabled: true\n  schedules:\n    morning: "60 * * * *"\n' },
    bea: { yaml: 'hosts: [bea.example.net]\norchestrator:\n  enabled: true\n' },
  }), default: 'ada' };
  runtimes = bootTenants(express(), safeTenancyProcess(cfg, { fakeProvider: true }));
});
afterAll(async () => {
  await stopBootedTenants();
  stopTenantServices(runtimes.values());
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map());
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('a tenant whose services do not start', () => {
  it('is skipped with one line; the other tenant boots; the skipped hosts answer 503; the skipped default is not a default', () => {
    expect([...runtimes.keys()]).toEqual(['bea']);
    const line = warned.find((w) => w.includes('tenant ada skipped'));
    expect(line).toBeDefined();
    expect(line).toContain('did not start');
    expect(line).not.toMatch(/\n/);
    expect(isReservedHost('ada.example.net')).toBe(true);
    expect(resolveTenant({ host: 'bea.example.net' })?.id).toBe('bea');
    expect(resolveTenant({ host: 'nobody.example.net' })).toBeNull();
    expect(warned.some((w) => w.includes('default tenant ada was skipped'))).toBe(true);
  });
});
