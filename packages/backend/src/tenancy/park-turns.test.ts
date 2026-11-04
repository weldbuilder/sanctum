// What a park does to work that is queued or in flight (tenancy/park.ts): the active turn is interrupted, a queued turn never starts a provider call and its
// caller gets a tenant_parked AgentTurnError, and an Outlook author pass or handoff run in flight is waited for.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({ author: false, calls: 0, interrupts: 0, started: (() => {}) as () => void, release: (() => {}) as () => void, gate: null as Promise<void> | null }));

vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: () => {
    h.calls++;
    const it = (async function* () {
      h.started();
      if (h.gate) await h.gate;
      yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'reply' }] } };
      yield { type: 'result', subtype: 'success', session_id: 's' };
    })();
    return Object.assign(it, { mcpServerStatus: async () => [], interrupt: async () => { h.interrupts++; h.release(); }, close: () => {} });
  },
}));
vi.mock('../services/rolling-context.js', async (orig) => ({ ...(await orig<object>()), getRolling: () => ({ maybeCompact: async () => {}, readTurns: async () => [] }), rollingEnabledForActiveProvider: () => false }));
vi.mock('../services/revien.js', async (orig) => ({ ...(await orig<object>()), recallForPrompt: async () => '', ingestTurn: async () => {} }));
vi.mock('../services/hooks.js', async (orig) => ({
  ...(await orig<object>()), createHooks: () => ({}), buildOrientationContext: async () => '', prefetchMindContext: async () => '', maybeSnapshotTone: () => {},
}));
vi.mock('../services/outlook-author.js', async (orig) => ({ ...(await orig<object>()), startOutlookAuthor: () => {}, stopOutlookAuthor: () => {}, isOutlookAuthorRunning: () => h.author }));

import { bootTenants, tenantLifecycle } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { parkTenant } from './park.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { AgentTurnError, type AgentService } from '../services/agent.js';
import { createThread } from '../services/db.js';

let ada: TenantRuntime;
const agent = () => ada.services.agentService as AgentService;
const send = (text: string) => runInTenant(ada, () => agent().processMessage('t1', text, { name: 'T', type: 'named' }, { platform: 'web' }));

beforeAll(() => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: 'hosts: [bea.example.net]\n' } }) };
  process.env.ANTHROPIC_API_KEY = 'P-process';
  const runtimes = bootTenants(express(), safeTenancyProcess(cfg, { fakeProvider: true }));
  ada = runtimes.get('ada')!;
  runInTenant(ada, () => createThread({ id: 't1', name: 'T', type: 'named', createdAt: new Date().toISOString() }));
});
afterAll(async () => {
  await stopBootedTenants();
  delete process.env.ANTHROPIC_API_KEY;
  for (const rt of tenantLifecycle()!.runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } }
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('a park fences the queue', () => {
  it('two messages behind a provider that waits: the active one is interrupted, the queued ones never reach the provider, their callers get tenant_parked', async () => {
    const started = new Promise<void>((ok) => { h.started = ok; });
    h.gate = new Promise<void>((ok) => { h.release = ok; });
    const active = send('one');
    await started;
    const q1 = send('two').catch((e) => e);
    const q2 = send('three').catch((e) => e);
    expect(runInTenant(ada, () => agent().getQueueDepth())).toBe(2);
    expect(h.calls).toBe(1);

    const status = await parkTenant('ada');
    expect(status).toEqual({ id: 'ada', state: 'parked' });
    expect(h.interrupts).toBeGreaterThanOrEqual(1); // the active turn was interrupted
    await active.catch(() => {});
    for (const r of [await q1, await q2]) {
      expect(r).toBeInstanceOf(AgentTurnError);
      expect((r as AgentTurnError).kind).toBe('tenant_parked');
    }
    expect(h.calls).toBe(1); // no provider call after the stop
    // New work for the retired agent is refused too.
    await expect(send('four')).rejects.toMatchObject({ kind: 'tenant_parked' });
    expect(h.calls).toBe(1);
  });
});

describe('a park counts an Outlook author pass in flight', () => {
  it('waits for it, and returns once it ends', async () => {
    h.author = true;
    setTimeout(() => { h.author = false; }, 200);
    const started = Date.now();
    expect(await parkTenant('bea')).toEqual({ id: 'bea', state: 'parked' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});
