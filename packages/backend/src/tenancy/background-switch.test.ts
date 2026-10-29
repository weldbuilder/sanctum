// Round 8, item 1: background_runs is a switch, not a truthiness test. Both the operator's tenants.background_runs and a tenant's own value must be exactly `true`
// or `false`. Anything else (`no`, `off`, "false", 0, ...) is REFUSED, the way tenants.inherit is: the operator's at boot (error naming the key), a tenant's by
// skipping that tenant at boot and refusing /apply, a config edit and a reload with the same sentence (the dry run catches it).
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTenantConfig, parseTenantsBlock } from './config.js';
import { bootTenants, stopTenantServices } from './boot.js';
import { enableTenancy, registerProcessConfig, runInTenant } from './context.js';
import { tenantEditRefusal } from './edit.js';
import { effectiveBackgroundRuns } from './background.js';
import { createTenantRuntime } from './runtime.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, safeTenantYaml, stopBootedTenants } from './test-runtime.js';
import { tenantYamlProblems } from '../../../../scripts/setup-inherit.mjs';

afterEach(() => { vi.restoreAllMocks(); enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null); });
const procBase = resolve(tmpdir(), 'sanctum-process');
const proc = (tenants: Record<string, unknown> = {}) => { const c = processConfigFor(procBase, { identity: { timezone: 'UTC' } }); (c as unknown as { tenants: unknown }).tenants = tenants; return c; };
// As YAML text (what an operator or a tenant types) and as the value it parses to.
const SPELLINGS: Array<[string, string]> = [['no', 'no'], ['off', 'off'], ['the string "false"', '"false"'], ['0', '0'], ['yes', 'yes'], ['the string "true"', '"true"'], ['1', '1'], ['a list', '[false]']];
const WORDS = 'background_runs must be true or false';

describe.each(SPELLINGS)('background_runs: %s', (_n, spelling) => {
  it('operator side: tenants.background_runs refuses it at boot, naming the key', () => {
    const v = parsedValue(spelling);
    expect(() => parseTenantsBlock({ tenants: { dir: 'x', background_runs: v } })).toThrow(/tenants\.background_runs: must be true or false/);
    expect(() => bootTenants(express(), Object.assign(safeTenancyProcess(proc()), { tenants: { dir: makeTenantsDir({ ada: {} }), background_runs: v } }))).toThrow(/tenants\.background_runs: must be true or false/);
  });

  it('operator side: a value that got past the parser still reads as OFF, never on', () => {
    const v = parsedValue(spelling);
    expect(effectiveBackgroundRuns(proc({ background_runs: v }), {})).toBe(false);
    expect(effectiveBackgroundRuns(proc({}), { background_runs: v })).toBe(false);
  });

  it('tenant side: the loader, its dry run, the wizard, the config editor and reload all refuse it with the sentence', () => {
    const root = makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n' } });
    const dir = join(root, 'ada');
    const text = `hosts: [ada.example.net]\nbackground_runs: ${spelling}\n`;
    const candidate = parsedValue(spelling);
    expect(() => loadTenantConfig(proc(), dir, 'ada', { fileCfg: { hosts: ['ada.example.net'], background_runs: candidate }, quiet: true })).toThrow(new RegExp(WORDS));
    expect(tenantYamlProblems({ background_runs: candidate } as never, dir)).toContain(WORDS);
    const p = proc({ dir: root });
    registerProcessConfig(() => p);
    const rt = createTenantRuntime(p, 'ada', dir);
    try {
      enableTenancy(true);
      expect(runInTenant(rt, () => tenantEditRefusal({ hosts: ['ada.example.net'], background_runs: candidate }, 'hosts: [ada.example.net]\n'))).toMatch(new RegExp(`would stop the tenant starting: ${WORDS}`));
      writeYaml(dir, text);
      expect(() => rt.reload()).toThrow(new RegExp(WORDS));
      expect(() => loadTenantConfig(p, dir, 'ada', { quiet: true })).toThrow(new RegExp(WORDS));
    } finally { rt.db.close(); }
  });
});

describe('booleans stay valid on both sides', () => {
  it.each([[true, true, true], [true, false, false], [false, true, false], [false, false, false]])('operator %s, tenant %s -> %s', (o, t, want) => {
    expect(parseTenantsBlock({ tenants: { dir: 'x', background_runs: o } })).not.toBeNull();
    const root = makeTenantsDir({ ada: { yaml: `hosts: [ada.example.net]\nbackground_runs: ${t}\n` } });
    const p = proc({ background_runs: o });
    expect(effectiveBackgroundRuns(p, loadTenantConfig(p, join(root, 'ada'), 'ada', { quiet: true }).config)).toBe(want);
  });
});

describe('a tenant with a non-boolean is skipped at boot; the others boot', () => {
  it.each(SPELLINGS)('background_runs: %s in bea\'s tenant.yaml', async (_n, spelling) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] }); // (the outlook poller's first tick must not outlive the test)
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: `hosts: [bea.example.net]\nbackground_runs: ${spelling}\n` } });
    const p = proc({ dir: root });
    registerProcessConfig(() => p);
    const runtimes = bootTenants(express(), safeTenancyProcess(p));
    try {
      expect([...runtimes.keys()]).toEqual(['ada']);
      expect(warn.mock.calls.map((a) => a.join(' ')).join('\n')).toMatch(new RegExp(`tenant bea.*${WORDS}`));
    } finally {
      await stopBootedTenants();
      await stopTenantServices(runtimes.values());
      for (const r of runtimes.values()) r.db.close();
      vi.useRealTimers();
    }
  });
});

import { writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
function parsedValue(spelling: string): unknown { return (yaml.load(`v: ${spelling}\n`) as { v: unknown }).v; }
function writeYaml(dir: string, text: string): void { writeFileSync(join(dir, 'tenant.yaml'), safeTenantYaml(text)); }
