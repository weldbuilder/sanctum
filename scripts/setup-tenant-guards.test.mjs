// The tenant wizard's guards (round 2 of stage 4): what it refuses before it writes, each case against the backend's own loader or boot check
// (a wizard that accepts what boot would skip, or refuses what boot would take, is a bug), plus the Revien, browser-seat and file-mode rules.
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { applySetup, gatherSetupEnv } from './setup-apply.mjs';
import { buildAnswers, setupPlan, walkValues } from './setup-plan.mjs';
import { runSetup } from './setup-walk.mjs';
import { hostsProblems, overlay, processTimezoneOf, removalMarkers, tenantEnvProblems, tenantFolderProblem, tenantHostClaims, tenantYamlProblems, withRemovalMarkers } from './setup-inherit.mjs';
import { checkHostClaims, listTenants, loadTenantConfig } from '../packages/backend/src/tenancy/config.ts';
import { processConfigFor } from '../packages/backend/src/tenancy/test-runtime.ts';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const dotenv = require('dotenv');
const posix = process.platform !== 'win32';
const PROCESS_YAML = (tenants) => `identity:\n  timezone: "UTC"\nagent:\n  provider: "claude"\n  model: "operator-model"\ntenants:\n  dir: ${JSON.stringify(tenants)}\n  auth: per-tenant\n`;

const sandboxes = [];
afterEach(() => { for (const s of sandboxes.splice(0)) fs.rmSync(s.sbx, { recursive: true, force: true }); });
function sandbox({ operatorYaml, tenantYaml, tenantEnv } = {}) {
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-guards-')));
  const app = path.join(sbx, 'app');
  fs.mkdirSync(path.join(sbx, 'home'), { recursive: true });
  appFixture(fs, path, app);
  const tenants = path.join(app, 'tenants');
  const ada = path.join(tenants, 'ada');
  fs.mkdirSync(path.join(ada, 'home', 'identity'), { recursive: true });
  fs.writeFileSync(path.join(ada, 'home', 'identity', 'profile.md'), 'p\n');
  fs.writeFileSync(path.join(app, 'sanctum.yaml'), operatorYaml ?? PROCESS_YAML(tenants));
  if (tenantYaml !== undefined) fs.writeFileSync(path.join(ada, 'tenant.yaml'), tenantYaml);
  if (tenantEnv !== undefined) fs.writeFileSync(path.join(ada, '.env'), tenantEnv);
  const s = { sbx, app, tenants, ada };
  sandboxes.push(s);
  return s;
}

/** The wizard's own words and answers: a prompt is answered by the first queued pair whose text it contains, Enter otherwise. */
async function run(s, answers = [], opts = {}) {
  let out = '';
  const queue = [...answers];
  const io = {
    say: (t = '') => { out += `${t}\n`; },
    prompt: async (text) => { out += text; const hit = queue.length && text.includes(queue[0][0]) ? queue.shift()[1] : ''; out += `${hit}\n`; return hit; },
  };
  await runSetup({ root: s.app, io, processEnv: opts.processEnv ?? {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, tenant: 'ada', ...opts });
  return out;
}
const claude = [['Which one?', '2'], ['Anthropic API key', 'sk-ant-x'], ['App password', 'a-tenant-pass']];
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
/** Every file under `dir` as path -> bytes, for "nothing was written". */
const snapshot = (dir, out = {}) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(p, out); else if (e.isFile()) out[p] = fs.readFileSync(p).toString('hex'); else out[p] = 'link'; // (a link is recorded, never followed)
  }
  return out;
};
const link = (target, at) => { try { fs.symlinkSync(target, at, 'junction'); return true; } catch { return false; } };

// ── 3. a link is never a tenant folder ───────────────────────────────────────

describe('the tenant folder must be a real folder inside tenants.dir', () => {
  it('tenants/sym -> the app folder is refused and the process .env and sanctum.yaml are byte-identical', async () => {
    const s = sandbox();
    fs.writeFileSync(path.join(s.app, '.env'), 'APP_PASSWORD=operator-pw\nANTHROPIC_API_KEY=sk-operator\n');
    if (!link(s.app, path.join(s.tenants, 'sym'))) return; // (a platform that refuses links: nothing to test)
    const before = { env: readIf(path.join(s.app, '.env')), yaml: readIf(path.join(s.app, 'sanctum.yaml')), files: Object.keys(snapshot(s.app)).sort() };
    await expect(run(s, claude, { tenant: 'sym' })).rejects.toThrow(/is a link/);
    expect(readIf(path.join(s.app, '.env'))).toEqual(before.env);
    expect(readIf(path.join(s.app, 'sanctum.yaml'))).toEqual(before.yaml);
    expect(Object.keys(snapshot(s.app)).sort()).toEqual(before.files); // no tenant.yaml, no data/, nothing new in the app folder
    // boot agrees: its listing skips a link, so such a folder is never a tenant there either
    expect(listTenants(s.tenants)).toEqual(['ada']);
  });

  it('a link to a folder outside tenants.dir, and a link that points nowhere, are refused too (with --create as well)', async () => {
    const s = sandbox();
    const elsewhere = path.join(s.sbx, 'elsewhere');
    fs.mkdirSync(elsewhere);
    if (!link(elsewhere, path.join(s.tenants, 'out'))) return;
    await expect(run(s, claude, { tenant: 'out' })).rejects.toThrow(/is a link/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    if (link(path.join(s.sbx, 'nowhere'), path.join(s.tenants, 'gone'))) {
      await expect(run(s, claude, { tenant: 'gone', create: true })).rejects.toThrow(/is a link/);
    }
  });

  it('tenantFolderProblem: a real folder inside passes, a missing one passes (--create), the app folder and any folder that holds it do not', () => {
    const s = sandbox();
    expect(tenantFolderProblem(s.tenants, s.ada, s.app)).toBe('');
    expect(tenantFolderProblem(s.tenants, path.join(s.tenants, 'new'), s.app)).toBe('');
    expect(tenantFolderProblem(s.sbx, s.app, s.app)).toMatch(/is, or holds, the app folder/);
    expect(tenantFolderProblem(path.dirname(s.sbx), s.sbx, s.app)).toMatch(/is, or holds, the app folder/);
    expect(tenantFolderProblem(s.tenants, s.sbx, s.app)).toMatch(/outside the tenants folder/);
    fs.writeFileSync(path.join(s.tenants, 'file'), 'x');
    expect(tenantFolderProblem(s.tenants, path.join(s.tenants, 'file'), s.app)).toMatch(/not a folder/);
  });
});

// ── 4. the checks the backend makes, each against the backend ────────────────

const processCfgOf = (s) => processConfigFor(s.app, yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8')));
const processFileOf = (s) => yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8'));
const backendRefuses = (s, fn) => { try { fn(); return false; } catch { return true; } };

describe('parity (a): a host another tenant already claims', () => {
  it.each([
    ['the same host', 'shared.example.net', true], ['the same host, other case', 'Shared.Example.net', true], ['another host', 'mine.example.net', false],
  ])('%s', (_n, host, bad) => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.tenants, 'bea'));
    fs.writeFileSync(path.join(s.tenants, 'bea', 'tenant.yaml'), 'hosts: [shared.example.net]\n');
    const wizard = tenantYamlProblems({ hosts: [host] }, s.ada, 'UTC', { tenantsDir: s.tenants, tenantId: 'ada' });
    const backend = backendRefuses(s, () => checkHostClaims([{ id: 'bea', hosts: ['shared.example.net'] }, { id: 'ada', hosts: [host.toLowerCase()] }]));
    expect(wizard.length > 0).toBe(backend);
    expect(wizard.length > 0).toBe(bad);
    if (bad) expect(wizard.join(' ')).toMatch(/claimed by tenant bea/);
  });
  it('a tenant folder boot would skip (a malformed tenant.yaml) still holds its hosts', () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.tenants, 'bea'));
    fs.writeFileSync(path.join(s.tenants, 'bea', 'tenant.yaml'), 'hosts:\n  - held.example.net\nagent: [unclosed\n');
    expect(tenantHostClaims(s.tenants, 'ada').get('held.example.net')).toBe('bea');
  });
  it('the terminal refuses it at the hostname question (asked again) and writes nothing; the tenant\'s own host is no clash', async () => {
    const s = sandbox({ tenantYaml: 'hosts: [ada.example.net]\n' });
    fs.mkdirSync(path.join(s.tenants, 'bea'));
    fs.writeFileSync(path.join(s.tenants, 'bea', 'tenant.yaml'), 'hosts: [shared.example.net]\n');
    const said = await run(s, [['Hostname this tenant', 'shared.example.net'], ['Hostname this tenant', 'ada.example.net'], ...claude]);
    expect(said).toMatch(/shared\.example\.net is already claimed by tenant bea/);
    expect(yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).hosts).toEqual(['ada.example.net']);
  });
  it('and refuses it again before any write when a caller skips the question', () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.tenants, 'bea'));
    fs.writeFileSync(path.join(s.tenants, 'bea', 'tenant.yaml'), 'hosts: [shared.example.net]\n');
    const env = gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, discordToggle: null });
    const plan = setupPlan(env.existing, env);
    const { values } = walkValues(plan, { provider: 'claude', password: 'a-tenant-pass', anthropicKey: '' });
    const before = snapshot(s.ada);
    expect(() => applySetup({ ...buildAnswers(values, plan), tenantHost: 'shared.example.net' }, plan, {}, { writer: 'test' })).toThrow(/claimed by tenant bea/);
    expect(snapshot(s.ada)).toEqual(before);
  });
});

describe('parity (b): the tenant .env', () => {
  const elsewhere = (s) => path.join(s.sbx, 'elsewhere');
  it.each([
    ['AGENT_CWD outside', (s) => `AGENT_CWD=${elsewhere(s)}\n`, true],
    ['AGENT_CWD inside (relative)', () => 'AGENT_CWD=home\n', false],
    ['WORKSPACE_ROOT outside', (s) => `WORKSPACE_ROOT=${elsewhere(s)}\n`, true],
    ['VAULT_PATH outside', (s) => `VAULT_PATH=${elsewhere(s)}\n`, true],
    ['EXTRA_WRITE_PATHS with one outside', (s) => `EXTRA_WRITE_PATHS=scratch,${elsewhere(s)}\n`, true],
    ['EXTRA_WRITE_PATHS inside', () => 'EXTRA_WRITE_PATHS=scratch,other\n', false],
    ['a TZ other than the process\'s', () => 'TZ=Asia/Tokyo\n', true],
    ['the process\'s own TZ', () => 'TZ=UTC\n', false],
    ['keys the backend ignores for a tenant (PORT, HOST, DB_PATH)', (s) => `PORT=1\nHOST=0.0.0.0\nDB_PATH=${elsewhere(s)}\n`, false],
    ['nothing but the password', () => 'APP_PASSWORD=x\n', false],
  ])('%s: the wizard and the backend loader agree', (_n, text, bad) => {
    const s = sandbox();
    const envText = text(s);
    fs.writeFileSync(path.join(s.ada, '.env'), envText);
    const wizard = tenantEnvProblems(envText, s.ada, 'UTC');
    const backend = backendRefuses(s, () => loadTenantConfig(processCfgOf(s), s.ada, 'ada', { processFile: processFileOf(s), quiet: true }));
    expect(wizard.length > 0).toBe(backend);
    expect(wizard.length > 0).toBe(bad);
    // and the whole wizard walk refuses a tenant whose existing .env boot would refuse, before writing a byte
    expect(tenantYamlProblems({}, s.ada, 'UTC', { envText }).length > 0).toBe(bad);
  });

  it('the terminal wizard refuses a tenant whose .env has an outside path or another TZ, and the folder is unchanged', async () => {
    for (const text of ['AGENT_CWD=__OUT__\n', 'TZ=Asia/Tokyo\n']) {
      const s = sandbox();
      fs.writeFileSync(path.join(s.ada, '.env'), text.replace('__OUT__', path.join(s.sbx, 'elsewhere')));
      const before = snapshot(s.ada);
      await expect(run(s, claude)).rejects.toThrow(/tenant \.env|in the tenant \.env/);
      expect(snapshot(s.ada)).toEqual(before);
    }
  });
});

describe('parity (c): malformed host strings', () => {
  it.each([
    ['a bare name', 'ada.example.net', false], ['mixed case', 'Ada.Example.NET', false], ['an IPv6 literal', '[::1]', false], ['a name with a dash', 'a-b.example.net', false],
    ['a scheme', 'https://ada.example.net', true], ['a port', 'ada.example.net:8080', true], ['a path', 'ada.example.net/x', true], ['scheme, port and path', 'https://x.example.net:8080/p', true],
    ['an underscore', 'a_b.example.net', true], ['a leading dash', '-a.example.net', true], ['an empty label', 'a..example.net', true], ['a space inside', 'bad host', true],
    ['an empty string', '', true], ['a number', 123, true], ['a null entry', null, true],
  ])('%s: the wizard and the backend loader agree', (_n, host, bad) => {
    const s = sandbox();
    const cfg = { hosts: [host] };
    const wizard = tenantYamlProblems(cfg, s.ada, 'UTC');
    const backend = backendRefuses(s, () => loadTenantConfig(processCfgOf(s), s.ada, 'ada', { fileCfg: cfg, processFile: processFileOf(s), quiet: true }));
    expect(wizard.length > 0).toBe(backend);
    expect(wizard.length > 0).toBe(bad);
  });
  it('hosts that are one string are read as a list of one by both; one that is neither a string nor a list is refused by both', () => {
    const s = sandbox();
    for (const [hosts, bad] of [['ada.example.net', false], ['https://ada.example.net', true], [{ a: 1 }, true], [42, true], [null, false]]) {
      const wizard = hostsProblems(hosts).length > 0;
      const backend = backendRefuses(s, () => loadTenantConfig(processCfgOf(s), s.ada, 'ada', { fileCfg: { hosts }, processFile: processFileOf(s), quiet: true }));
      expect(wizard, JSON.stringify(hosts)).toBe(backend);
      expect(wizard, JSON.stringify(hosts)).toBe(bad);
    }
  });
  it('a bad host carried over from an existing tenant.yaml is refused (the wizard does not copy it forward), and the file is unchanged', async () => {
    const original = 'hosts: [ada.example.net, "https://x.example.net:8080/p"]\n';
    const s = sandbox({ tenantYaml: original });
    await expect(run(s, [['Hostname this tenant', ''], ...claude])).rejects.toThrow(/not a bare hostname/);
    expect(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).toBe(original);
  });
  it('server: in an existing tenant.yaml is refused before writing (boot would only ignore it with a warning)', async () => {
    const original = 'hosts: [ada.example.net]\nserver: { port: 1 }\n';
    const s = sandbox({ tenantYaml: original });
    await expect(run(s, [['Hostname this tenant', ''], ...claude])).rejects.toThrow(/server: belongs to the process/);
    expect(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).toBe(original);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = loadTenantConfig(processCfgOf(s), s.ada, 'ada', { processFile: processFileOf(s) });
    expect(c.hosts).toEqual(['ada.example.net']); // boot takes the tenant and ignores server:
    expect(warn.mock.calls.flat().join(' ')).toMatch(/belong to the process; ignored/);
    warn.mockRestore();
  });
});

describe('parity (d): the process timezone, resolved in the backend\'s order', () => {
  // The backend's process config takes TZ from the environment (the parent's, else the .env dotenv loaded: dotenv never overrides), then the file, then UTC.
  const backendTz = async (file, parentTz, dotenvText) => {
    const saved = process.env.TZ;
    const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
    try {
      const parsed = dotenvText ? dotenv.parse(dotenvText) : {};
      const tz = parentTz || parsed.TZ;
      if (tz) process.env.TZ = tz; else delete process.env.TZ;
      const dir = fs.mkdtempSync(path.join(tmpdir(), 'setup-guards-cfg-'));
      const p = path.join(dir, 'sanctum.yaml');
      fs.writeFileSync(p, file === null ? '' : yaml.dump(file));
      vi.resetModules(); // (loadConfig keeps the first config it built)
      const { loadConfig } = await import('../packages/backend/src/config.ts');
      const tzOut = loadConfig(p).identity.timezone;
      fs.rmSync(dir, { recursive: true, force: true });
      return tzOut;
    } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; logs.forEach((l) => l.mockRestore()); }
  };
  it.each([
    ['nothing says: UTC', null, undefined, undefined, 'UTC'],
    ['the file only', { identity: { timezone: 'Europe/Berlin' } }, undefined, undefined, 'Europe/Berlin'],
    ['the process .env beats the file', { identity: { timezone: 'Europe/Berlin' } }, undefined, 'TZ=America/New_York\n', 'America/New_York'],
    ['the parent environment beats the .env and the file', { identity: { timezone: 'Europe/Berlin' } }, 'Asia/Tokyo', 'TZ=America/New_York\n', 'Asia/Tokyo'],
    ['the parent environment beats the file', { identity: { timezone: 'Europe/Berlin' } }, 'Asia/Tokyo', undefined, 'Asia/Tokyo'],
  ])('%s', async (_n, file, parent, dotenvText, want) => {
    const s = sandbox({ operatorYaml: file === null ? '' : yaml.dump(file) });
    if (dotenvText) fs.writeFileSync(path.join(s.app, '.env'), dotenvText);
    const wizard = processTimezoneOf(s.app, readIf(path.join(s.app, 'sanctum.yaml')) ? (yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8')) || {}) : {}, parent ? { TZ: parent } : {});
    expect(wizard).toBe(want);
    expect(await backendTz(file, parent, dotenvText)).toBe(want);
  });
  it('the tenant plan uses it: a tenant on the process .env timezone is accepted, and one on the yaml\'s timezone (which the .env overrides) is refused', async () => {
    const s = sandbox();
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), `identity:\n  timezone: "Europe/Berlin"\ntenants:\n  dir: ${JSON.stringify(s.tenants)}\n  auth: per-tenant\n`);
    fs.writeFileSync(path.join(s.app, '.env'), 'TZ=UTC\n');
    const env = gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, discordToggle: null });
    expect(env.processTimezone).toBe('UTC');
    expect(tenantYamlProblems({ identity: { timezone: 'Europe/Berlin' } }, s.ada, env.processTimezone)).toHaveLength(1);
    expect(tenantYamlProblems({ identity: { timezone: 'UTC' } }, s.ada, env.processTimezone)).toHaveLength(0);
    const parent = gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: { TZ: 'Asia/Tokyo' }, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, discordToggle: null });
    expect(parent.processTimezone).toBe('Asia/Tokyo');
  });
});

// ── 6. what a tenant took away stays taken away when the wizard rewrites the file ─────────────

describe('removal markers survive a rewrite', () => {
  it('overlay, removalMarkers and withRemovalMarkers agree on ~ and {}', () => {
    const base = { orchestrator: { schedules: { a: '1', b: '2' }, enabled: true }, tools: { x: 1 } };
    const own = { orchestrator: { schedules: {} }, tools: null };
    expect(overlay(base, own)).toEqual({ orchestrator: { schedules: {}, enabled: true } });
    expect(overlay(base, { orchestrator: { schedules: { a: null } } })).toEqual({ orchestrator: { schedules: { b: '2' }, enabled: true }, tools: { x: 1 } });
    const rows = removalMarkers(own);
    expect(rows).toEqual([{ path: ['orchestrator', 'schedules'], value: {} }, { path: ['tools'], value: null }]);
    expect(withRemovalMarkers({ identity: { companion_name: 'A' } }, rows)).toEqual({ identity: { companion_name: 'A' }, orchestrator: { schedules: {} }, tools: null });
    expect(base.orchestrator.schedules).toEqual({ a: '1', b: '2' }); // (no input changed)
  });
  it('a tenant.yaml with orchestrator.schedules: {} and tools: ~ keeps both after the wizard runs, and the backend still reads them as removals', async () => {
    const op = (tenants) => `${PROCESS_YAML(tenants)}tools:\n  keep: 1\norchestrator:\n  schedules:\n    operator_morning: "0 7 * * *"\n`;
    const s = sandbox();
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), op(s.tenants));
    fs.writeFileSync(path.join(s.ada, 'tenant.yaml'), 'hosts: [ada.example.net]\norchestrator:\n  schedules: {}\ntools: ~\n');
    await run(s, [['Hostname this tenant', ''], ...claude]);
    const written = yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8'));
    expect(written.orchestrator).toEqual({ schedules: {} });
    expect(written.tools).toBeNull();
    const c = loadTenantConfig(processCfgOf(s), s.ada, 'ada', { processFile: processFileOf(s), quiet: true }).config;
    expect(c.orchestrator.schedules).toEqual({});
    expect(c.tools).toEqual(loadTenantConfig(processCfgOf(sandbox()), s.ada, 'ada', { processFile: null, quiet: true }).config.tools);
  });
});

// ── 2. Revien in the tenant wizard ───────────────────────────────────────────

describe('Revien in the tenant wizard', () => {
  it('is not the default, says in one line that a tenant needs its own daemon and address, and writes nothing about Revien on Enter', async () => {
    const s = sandbox();
    const said = await run(s, claude);
    expect(said.split('\n').filter((l) => /needs its own Revien daemon and address/.test(l))).toHaveLength(1);
    expect(said).toMatch(/Which one\? \[4\]/); // 4) None is the default; 1) Revien is still on offer
    expect(said).toContain('1) Revien');
    expect(yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).revien).toBeUndefined();
  });
  it('choosing Revien asks for the tenant\'s own address (a non-address is asked again) and writes enabled and url', async () => {
    const s = sandbox();
    const said = await run(s, [...claude, ['Which one?', '1'], ['Address of this tenant', 'not-an-address'], ['Address of this tenant', 'http://127.0.0.1:7438']]);
    expect(said).toMatch(/only this tenant uses/);
    expect(yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).revien).toEqual({ enabled: true, url: 'http://127.0.0.1:7438' });
    const file = processFileOf(s);
    const c = loadTenantConfig(processConfigFor(s.app, file), s.ada, 'ada', { processFile: file, quiet: true }).config;
    expect(c.revien).toMatchObject({ enabled: true, url: 'http://127.0.0.1:7438' });
  });
  it('the operator\'s own Revien block is not offered as the tenant\'s default (a tenant that never enabled it defaults to none)', async () => {
    const s = sandbox();
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), `${PROCESS_YAML(s.tenants)}revien:\n  enabled: true\n  url: "http://127.0.0.1:7437"\n`);
    const said = await run(s, claude);
    expect(said).toMatch(/Which one\? \[4\]/);
    expect(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).not.toContain('7437');
  });
  it('a tenant that already has its own Revien keeps it as the default and keeps its address', async () => {
    const s = sandbox({ tenantYaml: 'hosts: [ada.example.net]\nrevien:\n  enabled: true\n  url: "http://127.0.0.1:7438"\n' });
    const said = await run(s, [['Hostname this tenant', ''], ...claude]);
    expect(said).toMatch(/Which one\? \[1\]/);
    expect(yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).revien).toEqual({ enabled: true, url: 'http://127.0.0.1:7438' });
  });
  it('single-tenant is untouched: Revien is still the default and no address is asked', async () => {
    const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-guards-single-')));
    try {
      const app = path.join(sbx, 'app');
      fs.mkdirSync(path.join(sbx, 'home'), { recursive: true });
      appFixture(fs, path, app);
      let out = '';
      const queue = [['Which one?', '2'], ['Anthropic API key', 'k'], ['App password', 'a-long-password']];
      await runSetup({ root: app, io: { say: (t = '') => { out += `${t}\n`; }, prompt: async (t) => { out += t; const h = queue.length && t.includes(queue[0][0]) ? queue.shift()[1] : ''; out += `${h}\n`; return h; } }, processEnv: {}, homeDir: path.join(sbx, 'home'), codexInstalled: false, timezoneDefault: 'UTC' });
      expect(out).toMatch(/Which one\? \[1\]/);
      expect(out).not.toMatch(/own Revien daemon|Address of this tenant/);
    } finally { fs.rmSync(sbx, { recursive: true, force: true }); }
  });
});

// ── 1. the browser seat ──────────────────────────────────────────────────────

describe('a tenant\'s .mcp.json never points at the process browser seat', () => {
  const OPERATOR_SEAT = (tenants) => `${PROCESS_YAML(tenants)}integrations:\n  browser_url: "http://seat.example.net"\n`;
  it('the operator\'s integrations.browser_url does not make the wizard offer or write the browser entry for a tenant', async () => {
    const s = sandbox();
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), OPERATOR_SEAT(s.tenants));
    const said = await run(s, claude);
    expect(said).not.toMatch(/Add the "browser" entry|Replace the "browser" entry|Is the browser seat running/);
    expect(fs.existsSync(path.join(s.ada, '.mcp.json'))).toBe(false);
    expect(said).toMatch(/a tenant has browser tools only from a seat of its own/);
    expect(fs.existsSync(path.join(s.app, '.mcp.json'))).toBe(false);
  });
  it('a caller that sends browserEntry for a tenant with no seat of its own (the first-run page) writes no .mcp.json', () => {
    const s = sandbox();
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), OPERATOR_SEAT(s.tenants));
    const env = gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, discordToggle: null });
    expect(env.existing.integrations).toBeUndefined();
    const plan = setupPlan(env.existing, env);
    const { values } = walkValues(plan, { provider: 'claude', password: 'a-tenant-pass', anthropicKey: '' });
    applySetup({ ...buildAnswers(values, plan), browserEntry: true }, plan, {}, { writer: 'test' });
    expect(fs.existsSync(path.join(s.ada, '.mcp.json'))).toBe(false);
  });
  it('a tenant whose own tenant.yaml names a seat is offered the entry and gets it, in its own folder', async () => {
    const s = sandbox({ tenantYaml: 'hosts: [ada.example.net]\nintegrations:\n  browser_url: "http://ada-seat.example.net"\n' });
    const said = await run(s, [['Hostname this tenant', ''], ...claude, ['Add the "browser" entry', 'y']]);
    expect(said).toMatch(/Add the "browser" entry to/);
    const mcp = JSON.parse(fs.readFileSync(path.join(s.ada, '.mcp.json'), 'utf-8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['browser']);
    expect(fs.existsSync(path.join(s.app, '.mcp.json'))).toBe(false);
  });
});

// ── 8. a tenant .env keeps no loose mode ─────────────────────────────────────

describe.skipIf(!posix)('the tenant .env is owner-only after a rewrite', () => {
  it('a pre-existing tenant .env with a loose mode is 0600 after the wizard writes it; the single-tenant .env keeps its mode as before', async () => {
    const s = sandbox({ tenantEnv: 'APP_PASSWORD=old-password\n' });
    fs.chmodSync(path.join(s.ada, '.env'), 0o644);
    await run(s, [['Hostname this tenant', ''], ['Which one?', '2'], ['Anthropic API key', 'sk-ant-x'], ['App password', 'a-new-tenant-pass']]);
    expect(fs.readFileSync(path.join(s.ada, '.env'), 'utf-8')).toContain('a-new-tenant-pass');
    expect(fs.statSync(path.join(s.ada, '.env')).mode & 0o777).toBe(0o600);
    // single-tenant: byte-for-byte the old behaviour (the mode applies only on create)
    const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-guards-single-')));
    try {
      const app = path.join(sbx, 'app');
      fs.mkdirSync(path.join(sbx, 'home'), { recursive: true });
      appFixture(fs, path, app);
      fs.writeFileSync(path.join(app, '.env'), 'APP_PASSWORD=old-password\n');
      fs.chmodSync(path.join(app, '.env'), 0o644);
      const queue = [['Which one?', '2'], ['Anthropic API key', 'k'], ['App password', 'a-long-password']];
      await runSetup({ root: app, io: { say: () => {}, prompt: async (t) => (queue.length && t.includes(queue[0][0]) ? queue.shift()[1] : '') }, processEnv: {}, homeDir: path.join(sbx, 'home'), codexInstalled: false, timezoneDefault: 'UTC' });
      expect(fs.statSync(path.join(app, '.env')).mode & 0o777).toBe(0o644);
    } finally { fs.rmSync(sbx, { recursive: true, force: true }); }
  });
});
