// A custom wake-up survives a restart as it was left: switched off stays off and does not fire, a changed time keeps the
// new time. custom_routine.<type>.* says what the routine is; cron.<type>.* holds what was changed since, as for the defaults.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({ store: new Map<string, string>(), dir: '' }));
vi.mock('./db.js', () => ({
  getConfig: (k: string) => h.store.get(k) ?? null,
  getConfigBool: (k: string, d: boolean) => (h.store.has(k) ? h.store.get(k) === 'true' || h.store.get(k) === '1' : d),
  getConfigNumber: (k: string, d: number) => (h.store.has(k) ? Number(h.store.get(k)) : d),
  setConfig: (k: string, v: string) => { h.store.set(k, v); },
  deleteConfig: (k: string) => { h.store.delete(k); },
  getConfigsByPrefix: (p: string) => Object.fromEntries([...h.store].filter(([k]) => k.startsWith(p))),
}));
vi.mock('./agent.js', () => ({ AgentService: vi.fn() }));
vi.mock('./push.js', () => ({}));
vi.mock('./ws.js', () => ({ registry: { getCount: vi.fn().mockReturnValue(0) } }));
vi.mock('./hooks.js', () => ({ fetchLifeStatus: vi.fn().mockResolvedValue('') }));
vi.mock('./triggers.js', () => ({ evaluateConditions: vi.fn().mockReturnValue(true) }));
vi.mock('./digest.js', () => ({ runDigest: vi.fn() }));
vi.mock('./rolling-watch.js', () => ({ rollingWatch: vi.fn() }));
vi.mock('../config.js', () => ({
  getSanctumConfig: () => ({
    identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' },
    orchestrator: {
      enabled: true,
      wake_prompts_dir: h.dir,
      wake_prompts_path: '/nonexistent/wake.md',
      schedules: {},
      failsafe: { enabled: false, gentle_minutes: 120, concerned_minutes: 720, emergency_minutes: 1440 },
    },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { Orchestrator } from './orchestrator.js';
import type { AgentService } from './agent.js';

let woke: string[];
let running: Orchestrator | null = null;
const boot = () => { running = new Orchestrator({ isProcessing: () => false } as unknown as AgentService); running.start(); return running; };
const restart = () => { running?.stop(); return boot(); };
const statusOf = async (o: Orchestrator, wakeType: string) => (await o.getStatus()).find(t => t.wakeType === wakeType);

beforeAll(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'sanctum-wakes-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  h.store.clear();
  h.store.set('watchtower.seed_care_watchers', 'false');
  h.store.set('digest.enabled', 'false');
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  woke = [];
  // Private, and not under test: the wake itself (only whether the croner reached it), and the minute loop's timers,
  // triggers and watchtower, which hours of fake time would otherwise run against a database this file does not have.
  const inside = Orchestrator.prototype as unknown as Record<'handleWake' | 'checkTimers' | 'checkTriggers' | 'checkWatchtower', (t?: string) => Promise<void>>;
  vi.spyOn(inside, 'handleWake').mockImplementation(async (wakeType?: string) => { woke.push(wakeType ?? ''); });
  for (const loop of ['checkTimers', 'checkTriggers', 'checkWatchtower'] as const) vi.spyOn(inside, loop).mockResolvedValue(undefined);
});
afterEach(() => { running?.stop(); running = null; vi.useRealTimers(); });

describe('a custom wake-up across a restart', () => {
  it('switched off, it comes back off and does not fire', async () => {
    const o = boot();
    expect(o.addRoutine({ wakeType: 'tea', label: 'Tea', cronExpr: '0 15 * * *', prompt: 'tea time' })).toBe(true);
    o.disableTask('tea');
    const again = restart();
    expect(await statusOf(again, 'tea')).toMatchObject({ enabled: false, status: 'stopped', category: 'routine', label: 'Tea' });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000); // past 15:00
    expect(woke).not.toContain('tea');
  });

  it('switched back on, it comes back on and fires', async () => {
    const o = boot();
    o.addRoutine({ wakeType: 'tea', label: 'Tea', cronExpr: '0 15 * * *', prompt: 'tea time' });
    o.disableTask('tea');
    restart().enableTask('tea');
    const again = restart();
    expect(await statusOf(again, 'tea')).toMatchObject({ enabled: true, status: 'scheduled' });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(woke).toContain('tea');
  });

  it('moved to a new time, it keeps the new time', async () => {
    const o = boot();
    o.addRoutine({ wakeType: 'tea', label: 'Tea', cronExpr: '0 15 * * *', prompt: 'tea time' });
    expect(o.rescheduleTask('tea', '30 16 * * *')).toBe(true);
    const again = restart();
    expect(await statusOf(again, 'tea')).toMatchObject({ cronExpr: '30 16 * * *', enabled: true });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000); // 16:00: not yet
    expect(woke).not.toContain('tea');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 17:00: past 16:30
    expect(woke).toContain('tea');
  });

  it('a routine that is new starts on, whatever a removed one of the same name had saved', async () => {
    const o = boot();
    o.addRoutine({ wakeType: 'tea', label: 'Tea', cronExpr: '0 15 * * *', prompt: 'tea time' });
    o.disableTask('tea');
    o.removeRoutine('tea');
    expect(o.addRoutine({ wakeType: 'tea', label: 'Tea again', cronExpr: '0 15 * * *', prompt: 'tea time' })).toBe(true);
    expect(await statusOf(o, 'tea')).toMatchObject({ enabled: true, status: 'scheduled' });
    expect(await statusOf(restart(), 'tea')).toMatchObject({ enabled: true, label: 'Tea again' });
  });
});
