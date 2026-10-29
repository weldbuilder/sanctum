// M1 (round 4): revien.enabled is a switch, not a truthiness test. In tenant mode it is on only when it is exactly `true`; `yes`, "true", 1 and "false" are off and logged
// once as "revien.enabled must be true or false"; the loader's dry run, the config editor and the wizard refuse a non-boolean; services/revien.ts reads the effective boolean
// only. A tenant that turns it on with no url, or with the process's address, is still parked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTenantConfig } from './config.js';
import { enableTenancy, registerProcessConfig, runInTenant } from './context.js';
import { tenantEditRefusal } from './edit.js';
import { configuredRevien } from './revien.js';
import { fakeRuntime, makeTenantsDir, processConfigFor } from './test-runtime.js';
import { mergeConfigDefaults } from '../config.js';
import { recallForPrompt } from '../services/revien.js';
import { revienProblems, tenantYamlProblems } from '../../../../scripts/setup-inherit.mjs';

afterEach(() => { vi.restoreAllMocks(); enableTenancy(false); registerProcessConfig(() => null); vi.unstubAllGlobals(); });
const procBase = resolve(tmpdir(), 'sanctum-process');
const proc = () => processConfigFor(procBase, { identity: { timezone: 'UTC' } });
const withYaml = (yamlText: string) => { const root = makeTenantsDir({ ada: { yaml: yamlText } }); return { root, dir: join(root, 'ada') }; };
const SPELLINGS: [string, string][] = [['yes', 'yes'], ['the string "true"', '"true"'], ['1', '1'], ['the string "false"', '"false"'], ['on', 'on'], ['a list', '[true]']];

describe.each(SPELLINGS)('revien.enabled: %s', (_name, spelling) => {
  const yamlText = `revien:\n  enabled: ${spelling}\n  url: "http://ada-daemon.example.net:7438"\n`;
  it('is off in the loaded config, and the tenant still loads, with one line', () => {
    const { dir } = withYaml(yamlText);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = loadTenantConfig(proc(), dir, `ada-${spelling.length}${spelling.charCodeAt(0)}`).config;
    expect(c.revien.enabled).toBe(false);
    expect(c.revien.enabled === true).toBe(false);
    expect(configuredRevien(c).enabled).toBe(false);
    const lines = warn.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes('revien.enabled must be true or false'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('ada-daemon'); // never the address
  });
  it('is logged once per tenant, however often it loads', () => {
    const { dir } = withYaml(yamlText);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = `once-${spelling.length}${spelling.charCodeAt(0)}`;
    for (let i = 0; i < 3; i += 1) loadTenantConfig(proc(), dir, id);
    expect(warn.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes('revien.enabled must be true or false'))).toHaveLength(1);
  });
  it('is refused by the loader\'s dry run, the config editor and the wizard, in the same words', () => {
    const { dir } = withYaml('hosts: [ada.example.net]\n');
    const candidate = { hosts: ['ada.example.net'], revien: { enabled: JSON.parse(spelling === 'yes' || spelling === 'on' ? JSON.stringify(spelling) : spelling), url: 'http://ada-daemon.example.net:7438' } };
    expect(() => loadTenantConfig(proc(), dir, 'ada', { fileCfg: candidate, quiet: true })).toThrow(/revien\.enabled must be true or false/);
    expect(revienProblems(candidate)).toEqual(['revien.enabled must be true or false']);
    expect(tenantYamlProblems(candidate as never, dir)).toContain('revien.enabled must be true or false');
    enableTenancy(true);
    const rt = fakeRuntime('ada', { dir });
    registerProcessConfig(() => proc());
    expect(runInTenant(rt, () => tenantEditRefusal(candidate, 'hosts: [ada.example.net]\n'))).toMatch(/would stop the tenant starting: revien\.enabled must be true or false/);
  });
});

describe('the booleans and the parks that were already right', () => {
  const load = (yamlText: string, id: string) => { const { dir } = withYaml(yamlText); return loadTenantConfig(proc(), dir, id, { quiet: true }).config; };
  it('true with the tenant\'s own url is on; false and an absent key are off', () => {
    expect(load('revien:\n  enabled: true\n  url: "http://ada-daemon.example.net:7438"\n', 'ok1').revien.enabled).toBe(true);
    expect(load('revien:\n  enabled: false\n  url: "http://ada-daemon.example.net:7438"\n', 'ok2').revien.enabled).toBe(false);
    expect(load('hosts: [ada.example.net]\n', 'ok3').revien.enabled).toBe(false);
  });
  it('true with no url, and true with the process\'s own address (any spelling of localhost), are parked', () => {
    expect(load('revien:\n  enabled: true\n', 'park1').revien.enabled).toBe(false);
    expect(load(`revien:\n  enabled: true\n  url: "${mergeConfigDefaults({}).revien.url.replace('127.0.0.1', 'localhost')}"\n`, 'park2').revien.enabled).toBe(false);
  });
});

describe('services/revien.ts in tenant mode reads the effective boolean only', () => {
  const recallWith = async (enabled: unknown): Promise<number> => {
    const fetched = vi.fn(async () => ({ ok: true, json: async () => ({ results: [] }) }));
    vi.stubGlobal('fetch', fetched);
    enableTenancy(true);
    const config = { revien: { enabled, url: 'http://ada-daemon.example.net:7438', recall_limit: 3, timeout_ms: 500 } } as never;
    await runInTenant(fakeRuntime('ada', { config }), () => recallForPrompt('a question'));
    return fetched.mock.calls.length;
  };
  it.each([['"false"', 'false'], ['yes', 'yes'], ['1', 1], ['"true"', 'true'], ['false', false]])('%s never reaches the daemon', async (_n, v) => { expect(await recallWith(v)).toBe(0); });
  it('true does', async () => { expect(await recallWith(true)).toBe(1); });
});
