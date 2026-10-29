// Round 3, items 3 and 4: a Revien park survives a reload (the clash is computed from what each tenant's files say, never from the effective config
// that parking changes), a park lifts only when the clash is gone, and two addresses are "the same" in every spelling that reaches one daemon.
// Providers are faked: nothing here can start a model run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude', AbortError: class AbortError extends Error {}, listSessions: async () => [],
  query: () => { throw new Error('no model run in this test'); },
}));
vi.mock('../services/outlook-author.js', async (orig) => ({ ...(await orig<object>()), startOutlookAuthor: () => {}, stopOutlookAuthor: () => {} }));

import { bootTenants, stopTenantServices } from './boot.js';
import { enableTenancy, registerProcessConfig, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { loadTenantConfig } from './config.js';
import { revienClashes } from './revien.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { DEFAULT_REVIEN_URL, normaliseRevienAddress } from '../../../../scripts/setup-inherit.mjs';
import { mergeConfigDefaults, type SanctumConfig } from '../config.js';

const made: string[] = [];
let warned: string[] = [];
let runtimes: Map<string, TenantRuntime> | null = null;
beforeEach(() => {
  warned = [];
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
});
afterEach(async () => { await stopBootedTenants(); 
  if (runtimes) { stopTenantServices(runtimes.values()); for (const rt of runtimes.values()) { try { rt.db.close(); } catch { /* closed */ } } runtimes = null; }
  enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null);
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const on = (url?: string) => `revien:\n  enabled: true\n${url ? `  url: "${url}"\n` : ''}`;
const yamlOf = (id: string, url?: string) => `hosts: [${id}.example.net]\n${url === undefined ? '' : on(url)}`;
const lines = () => warned.filter((w) => /Revien (parked|is back on)/.test(w));
function bootWith(tenants: Record<string, string>, processFile: Record<string, unknown> = {}) {
  const root = makeTenantsDir(Object.fromEntries(Object.entries(tenants).map(([id, yaml]) => [id, { yaml }])));
  made.push(root);
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { identity: { timezone: 'UTC' }, ...processFile });
  cfg.orchestrator.enabled = false;
  (cfg as unknown as { tenants: unknown }).tenants = { dir: root };
  registerProcessConfig(() => cfg);
  runtimes = bootTenants(express(), safeTenancyProcess(cfg));
  return { root, rt: runtimes, cfg, set: (id: string, yaml: string) => writeFileSync(join(root, id, 'tenant.yaml'), safeTenantYaml(yaml)) };
}
const enabledOf = (rt: Map<string, TenantRuntime>) => Object.fromEntries([...rt.entries()].map(([id, r]) => [id, r.config.revien.enabled]));

describe('a park is not undone by a reload (item 3)', () => {
  it('boot parks ada and bea; bea.reload() keeps both parked and says nothing new', () => {
    const { rt } = bootWith({ ada: yamlOf('ada', 'http://127.0.0.1:7438'), bea: yamlOf('bea', 'http://127.0.0.1:7438'), cy: yamlOf('cy', 'http://127.0.0.1:7439') });
    expect(enabledOf(rt)).toEqual({ ada: false, bea: false, cy: true });
    expect(lines()).toHaveLength(2);
    rt.get('bea')!.reload();
    expect(enabledOf(rt)).toEqual({ ada: false, bea: false, cy: true }); // 63cb50c: bea came back on, because ada's forced enabled:false no longer counted
    rt.get('ada')!.reload();
    expect(enabledOf(rt)).toEqual({ ada: false, bea: false, cy: true });
    expect(lines()).toHaveLength(2); // no change, no line
  });

  it('the clash is read from configured values: a tenant that never named Revien does not park a neighbour, and a tenant\'s own config is never an input', () => {
    const { rt } = bootWith({ ada: yamlOf('ada', 'http://127.0.0.1:7438'), bea: yamlOf('bea') });
    expect(enabledOf(rt)).toEqual({ ada: true, bea: false });
    rt.get('bea')!.reload(); rt.get('ada')!.reload();
    expect(enabledOf(rt)).toEqual({ ada: true, bea: false });
    expect(lines()).toHaveLength(0);
  });

  it('a park lifts only when the clash is gone: the clashing tenant moves address, each tenant is revived by its own reload, with one line each', () => {
    const { rt, set } = bootWith({ ada: yamlOf('ada', 'http://127.0.0.1:7438'), bea: yamlOf('bea', 'http://localhost:7438') });
    expect(enabledOf(rt)).toEqual({ ada: false, bea: false });
    warned.length = 0;
    rt.get('ada')!.reload();
    expect(enabledOf(rt)).toEqual({ ada: false, bea: false }); // still clashing: nothing lifts
    set('bea', yamlOf('bea', 'http://127.0.0.1:7441'));
    rt.get('bea')!.reload();
    expect(rt.get('bea')!.config.revien.enabled).toBe(true); // bea moved: its own park lifts
    expect(rt.get('ada')!.config.revien.enabled).toBe(false); // ada's park lifts on ada's own reload
    rt.get('ada')!.reload();
    expect(enabledOf(rt)).toEqual({ ada: true, bea: true });
    const l = lines();
    expect(l).toHaveLength(2);
    expect(l.find((x) => x.includes('tenant bea:'))).toMatch(/back on/);
    expect(l.find((x) => x.includes('tenant ada:'))).toMatch(/back on/);
    for (const x of l) { expect(x).not.toContain('7438'); expect(x).not.toContain('7441'); }
    // moving back onto each other parks again, naming the other tenant
    set('bea', yamlOf('bea', 'http://127.0.0.1:7438'));
    rt.get('bea')!.reload();
    expect(rt.get('bea')!.config.revien.enabled).toBe(false);
    expect(lines().pop()).toMatch(/tenant bea: Revien parked.*tenant ada\b/);
  });

  it('a park never changes the other tenant\'s config object: ada keeps its object and every value while bea moves onto her address and is parked', () => {
    const { rt, set } = bootWith({ ada: yamlOf('ada', 'http://127.0.0.1:7438'), bea: yamlOf('bea', 'http://127.0.0.1:7442') });
    const ada = rt.get('ada')!;
    const object = ada.config;
    const snapshot = JSON.stringify(ada.config);
    set('bea', yamlOf('bea', 'http://localhost:7438'));
    rt.get('bea')!.reload();
    expect(rt.get('bea')!.config.revien.enabled).toBe(false);
    expect(ada.config).toBe(object);
    expect(JSON.stringify(ada.config)).toBe(snapshot);
    expect(ada.config.revien.enabled).toBe(true);
  });

  it('a reload that fails (outside path) leaves the park state as it was', () => {
    const { rt, set } = bootWith({ ada: yamlOf('ada', 'http://127.0.0.1:7438'), bea: yamlOf('bea', 'http://127.0.0.1:7438') });
    set('bea', `${yamlOf('bea', 'http://127.0.0.1:7443')}hooks:\n  workspace_root: ${JSON.stringify(join(tmpdir(), 'not-the-tenants'))}\n`);
    expect(() => rt.get('bea')!.reload()).toThrow(/inside the tenant folder/);
    expect(enabledOf(rt)).toEqual({ ada: false, bea: false });
  });
});

describe('one daemon, many spellings (item 4)', () => {
  const same: [string, string][] = [
    ['http://127.0.0.1:7438', 'http://localhost:7438'], ['http://127.0.0.1:7438', 'http://[::1]:7438'], ['http://127.0.0.1:7438', 'http://0.0.0.0:7438'],
    ['http://127.0.0.1:7438', 'http://127.1:7438'], ['http://127.0.0.1:7438', 'http://LOCALHOST.:7438/'], ['http://127.0.0.1:7438', 'http://user:pw@127.0.0.1:7438/v1?x=1'],
    ['http://127.0.0.1:7438', 'http://[::ffff:127.0.0.1]:7438'], ['http://127.0.0.1:7438', 'http://127.0.0.2:7438'], ['http://localhost:7438', 'http://[::1]:7438/.'],
    ['http://127.0.0.1:80', 'http://127.0.0.1'], ['http://localhost/', 'http://127.0.0.1:80/x'], ['https://daemon.example.net:443', 'https://DAEMON.example.net./'],
    ['http://daemon.example.net:7438', 'http://daemon.example.net.:7438/path'],
  ];
  const different: [string, string][] = [
    ['http://127.0.0.1:7438', 'http://127.0.0.1:7439'], ['http://127.0.0.1:7438', 'https://127.0.0.1:7438'], ['http://127.0.0.1:7438', 'http://daemon.example.net:7438'],
    ['http://daemon-a.example.net:7438', 'http://daemon-b.example.net:7438'], ['http://127.0.0.1', 'http://127.0.0.1:81'], ['http://10.0.0.1:7438', 'http://127.0.0.1:7438'],
  ];
  it.each(same)('%s and %s are one daemon', (a, b) => { expect(normaliseRevienAddress(a)).toBe(normaliseRevienAddress(b)); });
  it.each(different)('%s and %s are two daemons', (a, b) => { expect(normaliseRevienAddress(a)).not.toBe(normaliseRevienAddress(b)); });

  it('revienClashes sees every alias as a clash, and boot parks both tenants whatever they spelled', () => {
    const cfgOf = (url: string) => ({ revien: { enabled: true, url, recall_limit: 6, timeout_ms: 2500 } }) as unknown as SanctumConfig;
    for (const [a, b] of same) expect([...revienClashes([{ id: 'ada', config: cfgOf(a) }, { id: 'bea', config: cfgOf(b) }]).keys()].sort(), `${a} ${b}`).toEqual(['ada', 'bea']);
    const { rt } = bootWith({ ada: yamlOf('ada', 'http://127.0.0.1:7438'), bea: yamlOf('bea', 'http://LOCALHOST.:7438/x'), cy: yamlOf('cy', 'http://[::1]:7439') });
    expect(enabledOf(rt)).toEqual({ ada: false, bea: false, cy: true });
  });

  it('a tenant that enables Revien with no url of its own is parked by the loader with one line (it is not skipped)', () => {
    const { rt } = bootWith({ ada: yamlOf('ada', ''), bea: 'hosts: [bea.example.net]\nrevien:\n  enabled: true\n' });
    expect([...rt.keys()].sort()).toEqual(['ada', 'bea']);
    expect(rt.get('bea')!.config.revien.enabled).toBe(false);
    const l = warned.filter((w) => /tenant bea: Revien parked, revien\.enabled needs the tenant's own revien\.url/.test(w));
    expect(l).toHaveLength(1);
    expect(l[0]).not.toMatch(/\n/);
    // the loader alone: parked, not thrown (a stray folder outside the booted tenants.dir, so tenancy is off for it)
    enableTenancy(false);
    const root = makeTenantsDir({ bea: { yaml: 'revien:\n  enabled: true\n' } }); made.push(root);
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { identity: { timezone: 'UTC' } });
    expect(loadTenantConfig(proc, join(root, 'bea'), 'bea', { quiet: true, processFile: { revien: { enabled: true, url: 'http://daemon.example.net:7437' } } }).config.revien.enabled).toBe(false);
  });

  it('a tenant address equal to the PROCESS address (the operator\'s url, or the shipped default) is parked with a line, in any spelling; its own address is fine', () => {
    expect(DEFAULT_REVIEN_URL).toBe(mergeConfigDefaults({}).revien.url);
    const operator = { revien: { enabled: true, url: 'http://daemon.example.net:7437' } };
    const { rt } = bootWith({
      ada: yamlOf('ada', 'http://DAEMON.example.net.:7437/x'), bea: yamlOf('bea', 'http://127.0.0.1:7438'), cy: yamlOf('cy', 'http://localhost:80'),
    }, operator);
    expect(enabledOf(rt)).toEqual({ ada: false, bea: true, cy: true });
    expect(warned.filter((w) => /tenant ada: Revien parked, revien\.url is the process's own Revien address/.test(w))).toHaveLength(1);
    // with the operator naming nothing, the shipped default 7437 is the process address
    runtimes && stopTenantServices(runtimes.values()); for (const r of runtimes?.values() ?? []) r.db.close(); runtimes = null; enableTenancy(false); setTenantRegistry(new Map());
    warned.length = 0;
    const second = bootWith({ ada: yamlOf('ada', 'http://localhost:7437'), bea: yamlOf('bea', 'http://[::1]:7438') });
    expect(enabledOf(second.rt)).toEqual({ ada: false, bea: true });
    expect(warned.filter((w) => w.includes('tenant ada: Revien parked, revien.url is the process'))).toHaveLength(1);
  });
});
