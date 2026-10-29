// The wizard per tenant (npm run setup -- --tenant <id>): what it writes, what it refuses, and that what it writes is what the backend loads.
// The recorded terminal scenarios (tenant-* in __fixtures__/setup, replayed by setup-walk.test.mjs) pin the words and the bytes; these pin the rules.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { gatherSetupEnv, applySetup } from './setup-apply.mjs';
import { buildAnswers, setupPlan, walkValues } from './setup-plan.mjs';
import { runSetup } from './setup-walk.mjs';
import { harnessHomesFor, inheritedBase, pruneToDifferences, tenantYamlProblems } from './setup-inherit.mjs';
import { loadTenantConfig } from '../packages/backend/src/tenancy/config.ts';
import { harnessHomes } from '../packages/backend/src/tenancy/child.ts';
import { processConfigFor } from '../packages/backend/src/tenancy/test-runtime.ts';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const posix = process.platform !== 'win32';

function sandbox(processYaml) {
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-tenant-')));
  const app = path.join(sbx, 'app');
  fs.mkdirSync(path.join(sbx, 'home'), { recursive: true });
  appFixture(fs, path, app);
  const tenants = path.join(app, 'tenants');
  fs.mkdirSync(path.join(tenants, 'ada', 'home', 'identity'), { recursive: true });
  fs.writeFileSync(path.join(tenants, 'ada', 'home', 'identity', 'profile.md'), 'p\n');
  if (processYaml !== null) fs.writeFileSync(path.join(app, 'sanctum.yaml'), processYaml ?? `identity:\n  timezone: "UTC"\nagent:\n  provider: "claude"\n  model: "operator-model"\ntenants:\n  dir: ${JSON.stringify(tenants)}\n  auth: per-tenant\n`);
  return { sbx, app, tenants, ada: path.join(tenants, 'ada') };
}

/** Answer prompts by "contains" in order; an unmatched prompt takes Enter. Returns what was said. */
async function run(s, answers, opts = {}) {
  let out = '';
  const queue = [...answers];
  const io = {
    say: (t = '') => { out += `${t}\n`; },
    prompt: async (text) => { out += text; const hit = queue.length && text.includes(queue[0][0]) ? queue.shift()[1] : ''; out += `${hit}\n`; return hit; },
  };
  await runSetup({ root: s.app, io, processEnv: {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, tenant: 'ada', ...opts });
  return out;
}
const claude = [['Which one?', '2'], ['Anthropic API key', 'sk-ant-x'], ['App password', 'a-tenant-pass']];

describe('npm run setup -- --tenant', () => {
  it('writes a small tenant.yaml (only what differs from the operator\'s file and the defaults), a 0600 .env, and asks no port or phone question', async () => {
    const s = sandbox();
    try {
      const said = await run(s, [['Hostname', 'ada.example.net'], ["Your companion's name", 'Ada'], ...claude]);
      const written = yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8'));
      expect(Object.keys(written).sort()).toEqual(['command_center', 'hosts', 'identity', 'revien'].sort().filter((k) => k in written));
      expect(written.hosts).toEqual(['ada.example.net']);
      expect(written.agent?.model).toBeUndefined(); // the operator's model, inherited, not copied
      expect(written.agent?.provider).toBeUndefined();
      expect(written.agent?.cwd).toBeUndefined(); // <tenant>/home is the default
      expect(written.server).toBeUndefined();
      expect(written.cors).toBeUndefined();
      expect(fs.readFileSync(path.join(s.ada, '.env'), 'utf-8')).toMatch(/APP_PASSWORD=a-tenant-pass/);
      if (posix) expect(fs.statSync(path.join(s.ada, '.env')).mode & 0o777).toBe(0o600);
      expect(said).not.toMatch(/Phone address|port/i);
      expect(fs.existsSync(path.join(s.app, '.env'))).toBe(false); // the process's .env and yaml are untouched
      expect(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8')).toContain('operator-model');
    } finally { fs.rmSync(s.sbx, { recursive: true, force: true }); }
  });

  it('says where the tenant\'s logins live in one line, with the harness homes the backend gives that tenant\'s children', async () => {
    const s = sandbox();
    try {
      const said = await run(s, claude);
      const homes = harnessHomes({ dataDir: path.join(s.ada, 'data') });
      expect(harnessHomesFor(s.ada)).toEqual(homes);
      const lines = said.split('\n').filter((l) => l.includes('CLAUDE_CONFIG_DIR='));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(homes.CLAUDE_CONFIG_DIR);
      expect(lines[0]).toContain(homes.CODEX_HOME);
      expect(lines[0]).toContain(`DSH_HOME=${homes.DSH_HOME}`); // dsh logs in per tenant too
      expect(said).toContain(homes.DSH_HOME);
      expect(lines[0]).toMatch(/never copy credential files between tenants/);
      // the Claude step's own help names the same home
      expect(said).toContain('run `claude login` with CLAUDE_CONFIG_DIR / CODEX_HOME / DSH_HOME set to them');
    } finally { fs.rmSync(s.sbx, { recursive: true, force: true }); }
  });

  it('what it writes loads in the backend, over the inherited base, as the same tenant', async () => {
    const s = sandbox();
    try {
      await run(s, [['Hostname', 'ada.example.net'], ["Your companion's name", 'Ada'], ['Your name', 'Sam'], ...claude]);
      const file = yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8'));
      const proc = processConfigFor(s.app, file);
      const { config, hosts } = loadTenantConfig(proc, s.ada, 'ada', { processFile: file, quiet: true });
      expect(hosts).toEqual(['ada.example.net']);
      expect(config.agent.model).toBe('operator-model');
      expect(config.identity.companion_name).toBe('Ada');
      expect(config.agent.cwd).toBe(path.join(s.ada, 'home'));
      expect(config.auth.password).toBe('a-tenant-pass');
    } finally { fs.rmSync(s.sbx, { recursive: true, force: true }); }
  });

  it('refuses a tenants block with no auth key when the install looks per-tenant (a default, hosts, a tenant password), writing nothing', async () => {
    for (const [what, extraYaml, tenantFiles] of [['a default', '  default: ada\n', {}], ['hosts', '', { 'tenant.yaml': 'hosts: [ada.example.net]\n' }], ['a tenant password', '', { '.env': 'APP_PASSWORD=own\n' }]]) {
      const s = sandbox(null);
      try {
        fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), `identity:\n  timezone: "UTC"\nagent:\n  provider: "claude"\ntenants:\n  dir: ${JSON.stringify(s.tenants)}\n${extraYaml}`);
        for (const [f, text] of Object.entries(tenantFiles)) fs.writeFileSync(path.join(s.ada, f), text);
        const before = fs.readdirSync(s.ada).sort();
        await expect(run(s, [], { tenant: 'ada' }), what).rejects.toThrow(/tenants\.auth is not set.*per-tenant.*household/s);
        expect(fs.readdirSync(s.ada).sort()).toEqual(before);
      } finally { fs.rmSync(s.sbx, { recursive: true, force: true }); }
    }
  });

  it('refuses a missing tenants block, a bad id, and a missing folder without --create, writing nothing', async () => {
    const none = sandbox(null);
    try {
      await expect(run(none, [])).rejects.toThrow(/no tenants: block/);
      await expect(run(none, [], { tenant: 'Ada' })).rejects.toThrow(/not a tenant id/);
    } finally { fs.rmSync(none.sbx, { recursive: true, force: true }); }
    const s = sandbox();
    try {
      await expect(run(s, [], { tenant: 'bea' })).rejects.toThrow(/--create/);
      expect(fs.existsSync(path.join(s.tenants, 'bea'))).toBe(false);
      await run(s, claude, { tenant: 'bea', create: true });
      expect(fs.existsSync(path.join(s.tenants, 'bea', 'tenant.yaml'))).toBe(true);
    } finally { fs.rmSync(s.sbx, { recursive: true, force: true }); }
  });

  it('refuses to write a tenant.yaml the backend would skip, before any write, and says why', () => {
    const s = sandbox();
    try {
      const env = gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, discordToggle: null });
      const plan = setupPlan(env.existing, env);
      const { values } = walkValues(plan, { provider: 'claude', password: 'a-tenant-pass', anthropicKey: '' });
      const answers = buildAnswers(values, plan);
      const before = fs.readdirSync(s.ada).sort();
      // The wizard's own steps stop an outside folder; a caller that skips them gets the refusal here.
      expect(() => applySetup({ ...answers, home: path.join(s.sbx, 'elsewhere') }, plan, {}, { writer: 'test' })).toThrow(/agent\.cwd must be inside the tenant folder/);
      expect(() => applySetup({ ...answers, timezone: 'Europe/Berlin' }, plan, {}, { writer: 'test' })).toThrow(/differs from the process timezone/);
      expect(() => applySetup(answers, plan, {}, { writer: 'test', check: () => 'the backend says no' })).toThrow(/the backend says no/);
      expect(fs.readdirSync(s.ada).sort()).toEqual(before);
      expect(fs.existsSync(path.join(s.sbx, 'elsewhere'))).toBe(false);
    } finally { fs.rmSync(s.sbx, { recursive: true, force: true }); }
  });

  it('a tenant of an operator with tenants.inherit: false sees no inherited default and writes the full difference from the defaults', async () => {
    const s = sandbox();
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), `identity:\n  timezone: "UTC"\nagent:\n  provider: "codex"\n  model: "operator-model"\ntenants:\n  dir: ${JSON.stringify(s.tenants)}\n  auth: per-tenant\n  inherit: false\n`);
    try {
      const env = gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, discordToggle: null });
      expect(env.inherited).toEqual({});
      expect(env.existing.agent?.provider).toBeUndefined();
    } finally { fs.rmSync(s.sbx, { recursive: true, force: true }); }
  });
});

describe('the helpers', () => {
  it('pruneToDifferences keeps identity and hosts, drops what the base or the defaults already say, and removes empty mappings', () => {
    const cfg = { identity: { companion_name: 'Echo' }, hosts: ['a.example.net'], agent: { provider: 'claude', model: 'x', cwd: '/t/home', rolling: { claude: true }, codex: { additional_directories: [] } }, revien: { enabled: true }, plugins: { enabled: ['p'] } };
    expect(pruneToDifferences(cfg, { agent: { model: 'x' } }, ['agent.cwd'])).toEqual({ identity: { companion_name: 'Echo' }, hosts: ['a.example.net'], plugins: { enabled: ['p'] } });
    expect(pruneToDifferences(cfg, { agent: { provider: 'codex' } }, [])).toMatchObject({ agent: { provider: 'claude', model: 'x', cwd: '/t/home' } });
  });
  it('tenantYamlProblems agrees with the backend loader on what is refused', () => {
    const s = sandbox();
    try {
      const file = yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8'));
      const proc = processConfigFor(s.app, file);
      const outside = path.join(s.sbx, 'elsewhere');
      for (const [cfg, bad] of [
        [{ agent: { cwd: outside } }, true], [{ hooks: { workspace_root: outside } }, true], [{ discord: { private_dir: outside } }, true], [{ plugins: { ledger_dir: outside } }, true],
        [{ agent: { codex: { additional_directories: [outside] } } }, true], [{ identity: { timezone: 'Europe/Berlin' } }, true], [{ server: { port: 1 } }, true],
        [{ agent: { cwd: 'home' } }, false], [{ identity: { companion_name: 'Ada', timezone: 'UTC' } }, false], [{ agent: { model: 'm' } }, false],
      ]) {
        const wizard = tenantYamlProblems(cfg, s.ada, 'UTC').length > 0;
        let backend = false;
        try { loadTenantConfig(proc, s.ada, 'ada', { fileCfg: cfg, processFile: inheritedBase(file), quiet: true }); } catch { backend = true; }
        // (server: is ignored with a warning by the loader, refused by the wizard: a tenant.yaml should not say it at all)
        expect(wizard, JSON.stringify(cfg)).toBe('server' in cfg ? true : backend);
        expect(wizard, JSON.stringify(cfg)).toBe(bad);
      }
    } finally { fs.rmSync(s.sbx, { recursive: true, force: true }); }
  });
});
