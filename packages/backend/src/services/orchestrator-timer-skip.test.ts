// A timer's action turn that the fallback honesty guard skipped goes back to `waiting` ONCE and retries after the primary's unhealthy
// window; a plain-message timer (no prompt) is never held to the guard. The reminder marker has already gone out by then.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  timers: [] as any[], fired: [] as string[], reopened: [] as string[], waiting: [] as string[], calls: [] as any[],
  skip: true, kv: new Map<string, string>(),
}));
const { Skipped } = vi.hoisted(() => ({ Skipped: class Skipped extends Error { constructor() { super('autonomous turn skipped: no tool was called'); this.name = 'AutonomousSkipped'; } } }));
vi.mock('./agent.js', () => ({ AgentService: vi.fn(), AutonomousSkipped: Skipped }));
vi.mock('./push.js', () => ({}));
vi.mock('./ws.js', () => ({ registry: { getCount: () => 0, broadcast: () => {} } }));
vi.mock('./hooks.js', () => ({ fetchLifeStatus: async () => '' }));
vi.mock('./triggers.js', () => ({ evaluateConditions: () => true }));
vi.mock('./digest.js', () => ({ runDigest: () => {} }));
vi.mock('./rolling-watch.js', () => ({ rollingWatch: () => {} }));
vi.mock('./db.js', () => ({
  getConfigBool: (_k: string, d: boolean) => d, getConfigNumber: (_k: string, d: number) => d, getConfig: (k: string) => h.kv.get(k) ?? null, setConfig: (k: string, v: string) => { h.kv.set(k, v); }, deleteConfig: () => {}, getConfigsByPrefix: () => ({}),
  getDueTimers: () => h.timers.filter((t) => t.status !== 'fired'),
  markTimerFired: (id: string) => { h.fired.push(id); h.timers.find((t) => t.id === id).status = 'fired'; },
  markTimerWaiting: (id: string) => { h.waiting.push(id); },
  reopenTimerAsWaiting: (id: string) => { h.reopened.push(id); h.timers.find((t) => t.id === id).status = 'waiting'; },
  getThread: () => ({ id: 't1', type: 'named', name: 'T' }), getTodayThread: () => ({ id: 't1' }),
  createMessage: () => ({}), updateThreadActivity: () => {}, logCompanionAction: () => {},
}));
vi.mock('../config.js', () => ({
  getSanctumConfig: () => ({ identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' }, agent: { fallback: { unhealthy_minutes: 10 } }, orchestrator: { enabled: true, schedules: {}, failsafe: { enabled: false } } }),
  PROJECT_ROOT: '/tmp/test',
}));

import { Orchestrator } from './orchestrator.js';

const timer = (o: Record<string, unknown>) => ({ id: 'tm1', label: 'tea', context: '', prompt: '', thread_id: 't1', status: 'pending', created_at: 'x', fire_at: 'x', ...o });
const mk = () => new Orchestrator({
  isProcessing: () => false,
  processAutonomous: async (...a: any[]) => { h.calls.push(a); if (h.skip) throw new Skipped(); return 'done'; },
} as any);

beforeEach(() => {
  h.timers = []; h.fired = []; h.reopened = []; h.waiting = []; h.calls = []; h.skip = true; h.kv = new Map();
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('timer turns skipped by the fallback guard', () => {
  it('a timer with a prompt is an action (needsTools); a skip puts it back to waiting; it waits out the window, retries once, then stays fired', async () => {
    h.timers = [timer({ prompt: 'log my water' })];
    const o = mk() as any;
    await o.checkTimers();
    expect(h.calls[0][3]).toEqual({ needsTools: true });
    expect(h.reopened).toEqual(['tm1']);
    // inside the unhealthy window: not retried
    await o.checkTimers();
    expect(h.calls).toHaveLength(1);
    // after the window: retried once; skipped again, so it is left fired (no endless loop)
    vi.setSystemTime(new Date('2026-03-10T12:11:00Z'));
    await o.checkTimers();
    expect(h.calls).toHaveLength(2);
    expect(h.reopened).toEqual(['tm1']);
    await o.checkTimers();
    expect(h.calls).toHaveLength(2);
    // a restart (a new Orchestrator, same KV) does not reopen it again
    await (mk() as any).checkTimers();
    expect(h.calls).toHaveLength(2);
    expect(h.reopened).toEqual(['tm1']);
  });

  it('a restart keeps the window: a waiting timer is not retried early by a fresh orchestrator', async () => {
    h.timers = [timer({ prompt: 'log my water' })];
    await (mk() as any).checkTimers();
    await (mk() as any).checkTimers();
    expect(h.calls).toHaveLength(1);
  });

  it('a retry that runs (the primary is back) is done', async () => {
    h.timers = [timer({ prompt: 'log my water' })];
    const o = mk() as any;
    await o.checkTimers();
    h.skip = false;
    vi.setSystemTime(new Date('2026-03-10T12:11:00Z'));
    await o.checkTimers();
    expect(h.calls).toHaveLength(2);
    expect(h.timers[0].status).toBe('fired');
    await o.checkTimers();
    expect(h.calls).toHaveLength(2);
  });

  it('a timer with no prompt is a plain message: needsTools is false', async () => {
    h.timers = [timer({ prompt: '' })];
    h.skip = false;
    await (mk() as any).checkTimers();
    expect(h.calls[0][3]).toEqual({ needsTools: false });
  });
});
