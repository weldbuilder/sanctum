// Round 8, item 2: a reload recomputes a tenant's effective background_runs. on -> off stops that tenant's orchestrator, outlook author and handoff schedule (and
// says so once); off -> on starts them the way boot does; the other tenant is untouched; an operator false stays a ceiling. A fake provider counts nothing here:
// the assertions are on the stop and start calls and the orchestrator's `stopped` flag.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({ id: (): string => '', calls: [] as string[] }));
vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude', AbortError: class AbortError extends Error {}, listSessions: async () => [],
  query: () => { throw new Error('no model run in this test'); },
}));
vi.mock('../services/outlook-author.js', async (orig) => {
  const real = await orig<typeof import('../services/outlook-author.js')>();
  return { ...real, startOutlookAuthor: vi.fn(() => { h.calls.push(`start-author:${h.id()}`); real.startOutlookAuthor(); }), stopOutlookAuthor: vi.fn(() => { h.calls.push(`stop-author:${h.id()}`); real.stopOutlookAuthor(); }) };
});
vi.mock('../services/handoff.js', async (orig) => {
  const real = await orig<typeof import('../services/handoff.js')>();
  return { ...real, startHandoffSchedule: vi.fn(() => { h.calls.push(`start-handoff:${h.id()}`); real.startHandoffSchedule(); }), stopHandoffSchedule: vi.fn(() => { h.calls.push(`stop-handoff:${h.id()}`); real.stopHandoffSchedule(); }) };
});

import { bootTenants, stopTenantServices } from './boot.js';
import { currentTenant, enableTenancy, registerProcessConfig, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, safeTenantYaml, stopBootedTenants } from './test-runtime.js';

h.id = () => currentTenant()?.id ?? '';
let runtimes: Map<string, TenantRuntime>;
let root: string;
const lines: string[] = [];

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  cfg.orchestrator.enabled = true;
  root = makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: 'hosts: [bea.example.net]\n' } });
  (cfg as unknown as { tenants: unknown }).tenants = { background_runs: true, dir: root };
  registerProcessConfig(() => cfg);
  runtimes = bootTenants(express(), safeTenancyProcess(cfg, { fakeProvider: true }));
});
afterAll(async () => {
  await stopBootedTenants();
  await stopTenantServices(runtimes.values());
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null);
  vi.useRealTimers(); vi.restoreAllMocks();
});

const rt = (id: string) => runtimes.get(id)!;
const orch = (id: string) => rt(id).services.orchestrator as unknown as { stopped: boolean };
const setYaml = (id: string, text: string) => writeFileSync(join(root, id, 'tenant.yaml'), safeTenantYaml(text));
const said = (re: RegExp) => lines.filter((l) => re.test(l));

describe('reload flips background runs', () => {
  it('boots with both tenants on: orchestrator running, author and handoff started', () => {
    expect(rt('ada').services.backgroundRuns).toBe(true);
    expect(orch('ada').stopped).toBe(false);
    expect(h.calls).toContain('start-author:ada');
    expect(h.calls).toContain('start-handoff:ada');
  });

  it('on -> off: ada\'s reload stops her orchestrator, author and handoff (as ada), says so once, and leaves bea running', () => {
    h.calls.length = 0;
    setYaml('ada', 'hosts: [ada.example.net]\nbackground_runs: false\n');
    rt('ada').reload();
    expect(rt('ada').services.backgroundRuns).toBe(false);
    expect(orch('ada').stopped).toBe(true);
    expect(h.calls).toEqual(expect.arrayContaining(['stop-author:ada', 'stop-handoff:ada']));
    expect(h.calls.filter((c) => c.endsWith(':bea'))).toEqual([]);
    expect(orch('bea').stopped).toBe(false);
    expect(rt('bea').services.backgroundRuns).toBe(true);
    expect(said(/tenant ada: background model runs are off \(reload\)/)).toHaveLength(1);
    rt('ada').reload(); // no flip: nothing more happens
    expect(said(/tenant ada: background model runs are off \(reload\)/)).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith('stop-author')).length).toBe(1);
  });

  it('off -> on (operator on): the reload starts them again as boot does, and says so once', () => {
    h.calls.length = 0;
    setYaml('ada', 'hosts: [ada.example.net]\nbackground_runs: true\n');
    rt('ada').reload();
    expect(rt('ada').services.backgroundRuns).toBe(true);
    expect(orch('ada').stopped).toBe(false);
    expect(h.calls).toEqual(expect.arrayContaining(['start-author:ada', 'start-handoff:ada']));
    expect(said(/tenant ada: background model runs are on \(reload\)/)).toHaveLength(1);
  });

  it('a non-boolean the tenant writes is refused at reload: the config, the flag and the timers stay as they were', () => {
    h.calls.length = 0;
    setYaml('ada', 'hosts: [ada.example.net]\nbackground_runs: "false"\n');
    expect(() => rt('ada').reload()).toThrow(/background_runs must be true or false/);
    expect(rt('ada').services.backgroundRuns).toBe(true);
    expect(orch('ada').stopped).toBe(false);
    expect(h.calls).toEqual([]);
  });
});
