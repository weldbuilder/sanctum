// One AgentService per tenant (stage 2b). A FAKE provider stands in for the harness: no model, no key, no child process.
// Tenant A's turn is held open; tenant B's must complete meanwhile, and nothing of A's (presence, busy flag, active query, active message,
// the turn probe) may show under B.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({
  id: (): string => '',
  gates: {} as Record<string, Promise<void> | undefined>,
  started: {} as Record<string, () => void>,
  seen: [] as { id: string; cwd?: string; env?: Record<string, string | undefined> }[],
}));

vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude',
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: (p: { options?: { cwd?: string; env?: Record<string, string | undefined> } }) => {
    const id = h.id();
    h.seen.push({ id, cwd: p.options?.cwd, env: p.options?.env });
    const it = (async function* () {
      h.started[id]?.();
      if (h.gates[id]) await h.gates[id];
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

import { bootTenants } from './boot.js';
import { currentTenant, enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { appContext } from '../services/identity/guard.js';
import { isInteractiveAgentBusy, getActiveMessageId, type AgentService } from '../services/agent.js';
import { realDeep } from '../services/plugin-paths.js';
import { createThread, getMessages } from '../services/db.js';

h.id = () => currentTenant()?.id ?? '';
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;
let app: express.Express;
const agentOf = (rt: TenantRuntime) => rt.services.agentService as AgentService;
const deferred = () => { let ok!: () => void; const p = new Promise<void>((r) => { ok = r; }); return { p, ok }; };

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
    ada: { yaml: 'hosts: [ada.example.net]\n', env: 'ANTHROPIC_API_KEY=T-ada\n' },
    bea: { yaml: 'hosts: [bea.example.net]\n' },
  }) };
  process.env.ANTHROPIC_API_KEY = 'P-process';
  app = express();
  runtimes = bootTenants(app, safeTenancyProcess(cfg));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
  for (const rt of [ada, bea]) runInTenant(rt, () => createThread({ id: 't1', name: 'T', type: 'named', createdAt: new Date().toISOString() }));
});
afterAll(async () => {
  await stopBootedTenants();
  delete process.env.ANTHROPIC_API_KEY;
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('one agent per tenant', () => {
  it('each tenant has its own service, and app.locals answers with the current tenant\'s', () => {
    expect(agentOf(ada)).toBeTruthy();
    expect(agentOf(ada)).not.toBe(agentOf(bea));
    expect(runInTenant(ada, () => app.locals.agentService)).toBe(agentOf(ada));
    expect(runInTenant(bea, () => app.locals.agentService)).toBe(agentOf(bea));
    expect(() => app.locals.agentService).toThrow(/outside a tenant context/);
  });

  it('B\'s turn completes while A\'s is held; nothing of A\'s shows under B; the probe is per tenant; the run is the tenant\'s own', async () => {
    const startedA = deferred();
    const release = deferred();
    h.started.ada = startedA.ok;
    h.gates.ada = release.p;
    const turnA = runInTenant(ada, () => agentOf(ada).processMessage('t1', 'hello from ada', { name: 'T', type: 'named' }, { platform: 'web' }));
    await startedA.p; // A's turn is inside the provider now

    // B runs start to finish while A is still held.
    const replyB = await runInTenant(bea, () => agentOf(bea).processMessage('t1', 'hello from bea', { name: 'T', type: 'named' }, { platform: 'web' }));
    expect(replyB).toBe('reply-bea');

    // A is busy and active; B is idle and offline-or-dormant, with no active message and a free queue.
    expect(runInTenant(ada, () => agentOf(ada).isProcessing())).toBe(true);
    expect(runInTenant(ada, () => agentOf(ada).getPresenceStatus())).toBe('active');
    expect(runInTenant(ada, () => getActiveMessageId('t1'))).not.toBeNull();
    expect(runInTenant(bea, () => agentOf(bea).isProcessing())).toBe(false);
    expect(runInTenant(bea, () => agentOf(bea).getPresenceStatus())).toBe('dormant');
    expect(runInTenant(bea, () => getActiveMessageId('t1'))).toBeNull();
    expect(runInTenant(bea, () => agentOf(bea).getQueueDepth())).toBe(0);

    // The turn probe and the busy check answer per tenant; process level (no tenant current) says idle / not busy.
    expect(runInTenant(ada, () => appContext())).toEqual({ turn: 'running' });
    expect(runInTenant(bea, () => appContext())).toEqual({ turn: 'idle' });
    expect(runInTenant(ada, () => isInteractiveAgentBusy())).toBe(true);
    expect(runInTenant(bea, () => isInteractiveAgentBusy())).toBe(false);
    expect(appContext()).toEqual({ turn: 'idle' });
    expect(isInteractiveAgentBusy()).toBe(false);

    release.ok();
    expect(await turnA).toBe('reply-ada');
    expect(runInTenant(ada, () => agentOf(ada).isProcessing())).toBe(false);
    expect(runInTenant(ada, () => getActiveMessageId('t1'))).toBeNull();
    expect(runInTenant(ada, () => appContext())).toEqual({ turn: 'idle' });

    // Each reply landed in its own tenant's database only.
    const texts = (rt: TenantRuntime) => runInTenant(rt, () => getMessages({ threadId: 't1' })).map((m: { content: string }) => m.content);
    expect(texts(ada)).toContain('reply-ada');
    expect(texts(ada)).not.toContain('reply-bea');
    expect(texts(bea)).toContain('reply-bea');
    expect(texts(bea)).not.toContain('reply-ada');

    // cwd is the tenant's home; the env handed to the run is the tenant's (its token, its key, never the process's).
    const runA = h.seen.find((s) => s.id === 'ada')!;
    const runB = h.seen.find((s) => s.id === 'bea')!;
    const real = (p: string) => realDeep(p).toLowerCase();
    expect(real(runA.cwd!)).toBe(real(ada.homeDir));
    expect(real(runB.cwd!)).toBe(real(bea.homeDir));
    expect(real(ada.homeDir)).toBe(real(resolve(ada.dir, 'home')));
    expect(runA.env?.INTERNAL_TOKEN).toBe(ada.token);
    expect(runB.env?.INTERNAL_TOKEN).toBe(bea.token);
    expect(runB.env?.ANTHROPIC_API_KEY).toBeUndefined();
    for (const run of [runA, runB]) expect(Object.values(run.env ?? {})).not.toContain('P-process');
  });

  it('the MCP list and context usage are per tenant', () => {
    expect(runInTenant(ada, () => agentOf(ada).getContextUsage())).toEqual({ tokensUsed: 0, contextWindow: 0 });
    expect(runInTenant(bea, () => agentOf(bea).getMcpStatus())).toEqual([]);
  });
});
