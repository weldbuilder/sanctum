// D11: a tenant inherits the operator's sanctum.yaml (the FILE's values), minus the never-inherited keys, with tenant.yaml on top.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INHERIT_TABLE, inheritTableMarkdown, inheritedBase, loadTenantConfig, parseTenantsBlock, TENANT_ID_RE } from './config.js';
import { INHERIT_TABLE as TABLE_FILE, NEVER_INHERITED, TENANT_ID_RE as WIZARD_ID_RE, WIZARD_DEFAULTS } from '../../../../scripts/setup-inherit.mjs';
import { mergeConfigDefaults } from '../config.js';
import { tenantEditRefusal } from './edit.js';
import { enableTenancy, registerProcessConfig, runInTenant } from './context.js';
import { makeTenantsDir as makeDir, processConfigFor } from './test-runtime.js';
import { fakeRuntime } from './test-runtime.js';
import { isSecretKeyName, overlay, removalMarkers, withRemovalMarkers } from '../../../../scripts/setup-inherit.mjs';

// Item 10: every tenants folder this file makes is removed when it is done (the helper leaves them in the temp folder).
const madeDirs: string[] = [];
const makeTenantsDir = (tenants: Parameters<typeof makeDir>[0]): string => { const d = makeDir(tenants); madeDirs.push(d); return d; };
afterAll(() => {
  for (const d of madeDirs.splice(0)) { rmSync(d, { recursive: true, force: true }); expect(existsSync(d), `${d} removed`).toBe(false); }
});

afterEach(() => vi.restoreAllMocks());
const procBase = resolve(tmpdir(), 'sanctum-process');
/** The process config the way loadConfig builds it from `file`, and that same file as the tenants inherit it. */
const proc = (file: Record<string, unknown> = {}) => processConfigFor(procBase, { identity: { timezone: 'UTC' }, ...file });
const load = (file: Record<string, unknown>, root: string, id = 'ada', processCfg = proc(file)) => loadTenantConfig(processCfg, join(root, id), id, { processFile: file, quiet: true }).config;

describe('the inheritance table', () => {
  it('is one table: the config module exports the very rows the wizard reads', () => {
    expect(INHERIT_TABLE).toBe(TABLE_FILE);
    expect(TENANT_ID_RE.source).toBe(WIZARD_ID_RE.source);
  });

  it('is the list in docs/MULTI-TENANT.md, between its inherit-table markers', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../../../docs/MULTI-TENANT.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const m = /<!-- inherit-table:start -->\n([\s\S]*?)\n<!-- inherit-table:end -->/.exec(doc);
    expect(m, 'the page has the markers').not.toBeNull();
    expect(m![1]).toBe(inheritTableMarkdown());
  });

  it('names every top-level key of the shipped defaults, so a new section cannot be left out unnoticed', () => {
    const named = new Set(INHERIT_TABLE.flatMap((r) => r.paths.map((p) => p.split('.')[0])));
    for (const key of Object.keys(mergeConfigDefaults({}))) expect(named.has(key), `${key} is in the table`).toBe(true);
  });

  it('lists as never-inherited every path a tenant config is confined to, and the process-only keys', () => {
    for (const p of ['agent.cwd', 'agent.claude_md_path', 'agent.mcp_json_path', 'agent.system_prompt_file', 'hooks', 'identity', 'plugins.dir', 'plugins.ledger_dir',
      'discord.private_dir', 'discord.gate.words_file', 'discord.gate.names_file', 'discord.public.exclusions_file', 'orchestrator.wake_prompts_dir', 'orchestrator.wake_prompts_path',
      'hosts', 'server', 'cors', 'tenants', 'updates', 'auth']) expect(NEVER_INHERITED, p).toContain(p);
  });

  it('the wizard defaults it prunes against are the shipped defaults', () => {
    const d = mergeConfigDefaults({}) as unknown as Record<string, unknown>;
    const dig = (o: unknown, path: string) => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
    for (const [path, value] of Object.entries(WIZARD_DEFAULTS)) expect(dig(d, path), path).toEqual(value);
  });
});

describe('inheritedBase', () => {
  it('drops every never-inherited path and keeps the rest, without changing its input', () => {
    const file = {
      agent: { model: 'm', cwd: '/op/home', codex: { sandbox_mode: 'read-only', additional_directories: ['/op/x'], base_instructions_file: 'p.md' } },
      identity: { companion_name: 'Op' }, hooks: { workspace_root: '/op/w' }, hosts: ['op.example.net'], auth: { password: 'pw' },
      server: { port: 1 }, cors: { origins: [] }, tenants: { dir: 'd' }, updates: { check: false }, tools: { x: 1 },
      discord: { enabled: true, private_dir: '/op/p', owner_user_id: '123', owner: { user_id: '1' }, gate: { words_file: 'w.txt' }, paused: true },
      google: { enabled: true, client_id: 'id', client_secret: 's' }, plugins: { enabled: ['a'], dir: '/op/pl', ledger_dir: '/op/l', trust: 'person' },
      integrations: { life_api_url: 'http://x', mind_cloud: { enabled: true, mind_id: 'm1' } }, plugins_dir: 'old',
    };
    const copy = JSON.stringify(file);
    expect(inheritedBase(file)).toEqual({
      agent: { model: 'm', codex: { sandbox_mode: 'read-only' } }, tools: { x: 1 }, discord: { enabled: true, gate: {}, paused: true }, google: { enabled: true },
      plugins: { enabled: ['a'], trust: 'person' }, // (the whole integrations section is gone: it names the operator's servers)
    });
    expect(JSON.stringify(file)).toBe(copy);
  });
  it('is empty for no file, or one that is not a mapping', () => {
    for (const bad of [null, undefined, [], 'x', 3]) expect(inheritedBase(bad)).toEqual({});
  });
});

describe('a tenant inherits the process file and overrides it', () => {
  const file = {
    agent: { model: 'big-model', provider: 'codex', app_write: false, codex: { sandbox_mode: 'read-only', model: 'cx' }, rolling: { codex: false } },
    orchestrator: { failsafe: { enabled: true, gentle_minutes: 30 } }, plugins: { enabled: ['hello'], trust: 'person' }, command_center: { enabled: true, currency_symbol: 'E' },
    voice: { enabled: true }, discord: { paused: true, deferral_hours: 3 },
  };

  it('model, provider, agent settings, orchestrator cadence, plugins, command center and voice come from the file', () => {
    const root = makeTenantsDir({ ada: {} });
    const c = load(file, root);
    expect(c.agent.model).toBe('big-model');
    expect(c.agent.provider).toBe('codex');
    expect(c.agent.app_write).toBe(false);
    expect(c.agent.codex.sandbox_mode).toBe('read-only');
    expect(c.agent.codex.model).toBe('cx');
    expect(c.agent.rolling.codex).toBe(false);
    expect(c.agent.rolling.claude).toBe(true); // a key the file does not say keeps the default
    expect(c.orchestrator.failsafe).toMatchObject({ enabled: true, gentle_minutes: 30, concerned_minutes: 720 });
    expect(c.plugins.enabled).toEqual(['hello']);
    expect(c.plugins.trust).toBe('person');
    expect(c.command_center).toMatchObject({ enabled: true, currency_symbol: 'E' });
    expect(c.voice.enabled).toBe(true);
    expect(c.discord).toMatchObject({ paused: true, deferral_hours: 3 });
  });

  it('tenant.yaml wins key by key; a list it names replaces the operator\'s list', () => {
    const root = makeTenantsDir({ ada: { yaml: 'agent:\n  model: tenant-model\n  codex:\n    sandbox_mode: workspace-write\nplugins:\n  enabled: [other]\n' } });
    const c = load(file, root);
    expect(c.agent.model).toBe('tenant-model');
    expect(c.agent.provider).toBe('codex'); // still the operator's
    expect(c.agent.codex.sandbox_mode).toBe('workspace-write');
    expect(c.agent.codex.model).toBe('cx'); // the sibling key under the same mapping is still inherited
    expect(c.plugins.enabled).toEqual(['other']);
    expect(c.plugins.trust).toBe('person');
  });

  it('a second tenant gets the same inherited values and the first one\'s override does not reach it', () => {
    const root = makeTenantsDir({ ada: { yaml: 'agent:\n  model: ada-model\n' }, bea: {} });
    expect(load(file, root, 'ada').agent.model).toBe('ada-model');
    expect(load(file, root, 'bea').agent.model).toBe('big-model');
    expect(load(file, root, 'bea').agent.codex).not.toBe(load(file, root, 'ada').agent.codex); // nothing shared between two configs
  });

  it('nothing is written into the process file, the table input, or the next tenant\'s base', () => {
    const root = makeTenantsDir({ ada: {}, bea: {} });
    const before = JSON.stringify(file);
    load(file, root, 'ada');
    load(file, root, 'bea');
    expect(JSON.stringify(file)).toBe(before);
  });
});

describe('what a tenant never inherits', () => {
  const op = (root: string) => ({
    agent: { cwd: join(root, 'outside-home'), claude_md_path: join(root, 'outside.md'), mcp_json_path: join(root, 'outside.json'), model: 'm', codex: { additional_directories: [join(root, 'x')] } },
    identity: { companion_name: 'Operator', user_name: 'Op', timezone: 'UTC', ledger_dir: join(root, 'ledger') },
    hooks: { workspace_root: join(root, 'ws'), extra_write_paths: [join(root, 'w')] }, hosts: ['op.example.net'], auth: { password: 'operator-password' },
    discord: { enabled: true, private_dir: join(root, 'priv'), owner_user_id: '111111111111111111', owner: { user_id: '1', channel_id: '2' }, gate: { words_file: join(root, 'w.txt') } },
    telegram: { enabled: true, owner_chat_id: '777' }, google: { enabled: true, client_id: 'op-id', client_secret: 'op-secret' },
    plugins: { dir: join(root, 'plugins'), ledger_dir: join(root, 'pl-ledger'), enabled: ['hello'] },
    orchestrator: { wake_prompts_dir: join(root, 'wakes'), wake_prompts_path: join(root, 'wake.md'), enabled: true }, integrations: { mind_cloud: { enabled: true, mind_id: 'op-mind' } },
    server: { port: 9999, host: '0.0.0.0' }, cors: { origins: ['https://op.example.net'] }, updates: { check: false }, tenants: { dir: root },
  });

  it('paths, identity, hosts, secrets and the process-only keys are absent; the tenant folder\'s defaults stand', () => {
    const root = makeTenantsDir({ ada: {} });
    const file = op(root);
    const processCfg = proc({ server: { port: 4100, host: '127.0.0.1' }, cors: { origins: ['https://ada.example.net'] } });
    const loaded = loadTenantConfig(processCfg, join(root, 'ada'), 'ada', { processFile: file, quiet: true });
    const c = loaded.config;
    const t = (...p: string[]) => resolve(root, 'ada', ...p);
    expect(c.agent.cwd).toBe(t('home'));
    expect(c.agent.claude_md_path).toBe(join(t('home'), 'CLAUDE.md'));
    expect(c.agent.mcp_json_path).toBe(t('.mcp.json'));
    expect(c.agent.codex.additional_directories).toEqual([]);
    expect(c.identity.companion_name).not.toBe('Operator');
    expect(c.identity.user_name).not.toBe('Op');
    expect(c.identity.ledger_dir).toBe(t('data', 'identity'));
    expect(c.hooks.workspace_root).toBe('');
    expect(c.hooks.extra_write_paths).toEqual([]);
    expect(loaded.hosts).toEqual([]);
    expect(c.auth.password).toBe('');
    expect(c.discord.private_dir).toBe(t('private'));
    expect(c.discord.owner_user_id).toBe('');
    expect(c.discord.owner).toEqual({ user_id: '', channel_id: '' });
    expect(c.discord.gate.words_file).not.toBe(file.discord.gate.words_file);
    expect(c.telegram.owner_chat_id).toBe('');
    expect(c.google.client_id).toBe('');
    expect(c.google.client_secret).toBe('');
    expect(c.plugins.dir).toBe('');
    expect(c.plugins.ledger_dir).toBe(t('data', 'plugins'));
    expect(c.orchestrator.wake_prompts_dir).toBe(processCfg.orchestrator.wake_prompts_dir); // the shipped prompts, as before
    expect(c.integrations.mind_cloud.mind_id).toBe('');
    expect(c.server.port).toBe(4100); // the process's block, not the file's raw one
    expect(c.server.db_path).toBe(t('data', 'sanctum.db'));
    expect(c.cors).toEqual({ origins: ['https://ada.example.net'] });
    expect((c as unknown as Record<string, unknown>).tenants).toBeUndefined();
    // and what is inherited next to them still is
    expect(c.agent.model).toBe('m');
    expect(c.telegram.enabled).toBe(true);
    expect(c.plugins.enabled).toEqual(['hello']);
  });

  it('a process file value that would be refused for a tenant (an outside path) is simply not inherited, and the tenant still loads', () => {
    const root = makeTenantsDir({ ada: {} });
    expect(() => load(op(root), root)).not.toThrow();
  });

  it('the confinement still applies to what the tenant says itself, over an inheriting base', () => {
    const root = makeTenantsDir({ ada: { yaml: `agent:\n  cwd: ${JSON.stringify(join(tmpdir(), 'elsewhere'))}\n` } });
    expect(() => load({ agent: { model: 'm' } }, root)).toThrow(/agent\.cwd must be inside the tenant folder/);
  });

  it('the dry run of a candidate tenant.yaml inherits too, and refuses what boot would refuse', () => {
    const root = makeTenantsDir({ ada: {} });
    const file = { agent: { model: 'dry-model' } };
    const processCfg = proc(file);
    const ok = loadTenantConfig(processCfg, join(root, 'ada'), 'ada', { fileCfg: { agent: { provider: 'dsh' } }, processFile: file, quiet: true }).config;
    expect(ok.agent.model).toBe('dry-model');
    expect(ok.agent.provider).toBe('dsh');
    expect(() => loadTenantConfig(processCfg, join(root, 'ada'), 'ada', { fileCfg: { hooks: { workspace_root: join(tmpdir(), 'out') } }, processFile: file, quiet: true })).toThrow(/must be inside the tenant folder/);
    // the same refusal through the edit API's own dry run, which reads the registered process file
    registerProcessConfig(() => processCfg);
    enableTenancy(true);
    try {
      const rt = fakeRuntime('ada', { dir: join(root, 'ada') });
      const problem = runInTenant(rt, () => tenantEditRefusal({ hooks: { workspace_root: join(tmpdir(), 'out') } }, ''));
      expect(problem).toMatch(/inside the tenant folder/);
    } finally { enableTenancy(false); registerProcessConfig(() => null); }
  });
});

describe('tenants.inherit: false', () => {
  it('leaves the shipped defaults: nothing of the process file reaches the tenant', () => {
    const file = { agent: { model: 'big-model', provider: 'codex' }, plugins: { enabled: ['hello'] }, tenants: { dir: 'x', inherit: false } };
    const root = makeTenantsDir({ ada: { yaml: 'agent:\n  model: own\n' }, bea: {} });
    const off = (id: string) => loadTenantConfig(proc(file), join(root, id), id, { processFile: file, quiet: true }).config;
    expect(off('bea').agent.model).toBe(mergeConfigDefaults({}).agent.model);
    expect(off('bea').agent.provider).toBe('claude');
    expect(off('bea').plugins.enabled).toEqual([]);
    expect(off('ada').agent.model).toBe('own');
  });
  it('is read from the tenants block as a boolean and refuses anything else', () => {
    const base = resolve(tmpdir(), 'sanctum-base');
    expect(parseTenantsBlock({ tenants: { dir: 'd' } }, base)).toEqual({ dir: resolve(base, 'd') });
    expect(parseTenantsBlock({ tenants: { dir: 'd', inherit: false } }, base)).toEqual({ dir: resolve(base, 'd'), inherit: false });
    expect(parseTenantsBlock({ tenants: { dir: 'd', inherit: true } }, base)).toEqual({ dir: resolve(base, 'd'), inherit: true });
    expect(() => parseTenantsBlock({ tenants: { dir: 'd', inherit: 'no' } }, base)).toThrow(/true or false/);
  });
});

describe('inheritance reads the FILE, never the environment', () => {
  it('the real loadConfig with APP_PASSWORD, AGENT_MODEL and friends exported: none reaches a tenant unless the file names it', async () => {
    const keys = { APP_PASSWORD: 'PROCESS-PW', AGENT_MODEL: 'env-model', AGENT_PROVIDER: 'dsh', COMPANION_NAME: 'EnvName', USER_NAME: 'EnvUser', GOOGLE_CLIENT_SECRET: 'env-gsecret',
      GOOGLE_CLIENT_ID: 'env-gid', DISCORD_ENABLED: 'true', TELEGRAM_ENABLED: 'true', WORKSPACE_ROOT: '/env/ws', ANTHROPIC_API_KEY: 'sk-env-secret' };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(keys)) { saved[k] = process.env[k]; process.env[k] = v; }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      vi.resetModules();
      const cfgMod = await import('../config.js');
      const tcfg = await import('./config.js');
      const root = makeTenantsDir({ ada: {} });
      const file = join(root, 'sanctum.yaml');
      writeFileSync(file, `tenants:\n  dir: ${JSON.stringify(root)}\nagent:\n  model: file-model\n  provider: codex\nidentity:\n  timezone: UTC\nplugins:\n  enabled: [hello]\n`);
      const processCfg = cfgMod.loadConfig(file);
      // the process itself is the environment's: env wins over its file
      expect(processCfg.agent.model).toBe('env-model');
      expect(processCfg.agent.provider).toBe('dsh');
      const t = tcfg.loadTenantConfig(processCfg, join(root, 'ada'), 'ada').config;
      // the tenant inherits the file's values, not the environment's
      expect(t.agent.model).toBe('file-model');
      expect(t.agent.provider).toBe('codex');
      expect(t.plugins.enabled).toEqual(['hello']);
      // and none of the environment-only values
      expect(t.auth.password).toBe('');
      expect(t.identity.companion_name).not.toBe('EnvName');
      expect(t.identity.user_name).not.toBe('EnvUser');
      expect(t.google.client_id).toBe('');
      expect(t.google.client_secret).toBe('');
      expect(t.discord.enabled).toBe(false);
      expect(t.telegram.enabled).toBe(false);
      expect(t.hooks.workspace_root).toBe('');
      expect(JSON.stringify(t)).not.toMatch(/PROCESS-PW|sk-env-secret|env-gsecret/);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('a tenant\'s own .env still overrides what it inherited (its environment, not the process\'s)', () => {
    const file = { agent: { model: 'file-model' } };
    const root = makeTenantsDir({ ada: { env: 'AGENT_MODEL=ada-env-model\nAPP_PASSWORD=ada-pw\n' } });
    const c = load(file, root);
    expect(c.agent.model).toBe('ada-env-model');
    expect(c.auth.password).toBe('ada-pw');
  });

  it('with no process file registered (a config that has not loaded), a tenant inherits nothing and loads as before', () => {
    const root = makeTenantsDir({ ada: {} });
    const c = loadTenantConfig(proc(), join(root, 'ada'), 'ada', { quiet: true }).config;
    expect(c.agent.model).toBe(mergeConfigDefaults({}).agent.model);
  });
});

describe('what names a person or a server is never inherited (the whole integrations and revien sections)', () => {
  it('the operator\'s life status address, browser seat and Mind do not reach a tenant, nor does the Revien daemon address', () => {
    const root = makeTenantsDir({ bea: {} });
    const c = load({
      integrations: { life_api_url: 'http://life.example.net', browser_url: 'http://seat.example.net', mind_cloud: { enabled: true, mcp_url: 'http://mind.example.net', mind_id: 'op-mind' } },
      revien: { enabled: true, url: 'http://daemon.example.net:7437', recall_limit: 30, timeout_ms: 9000 },
    }, root, 'bea');
    const d = mergeConfigDefaults({});
    expect(c.integrations).toEqual(d.integrations);
    expect(c.revien.url).toBe(d.revien.url);
    expect(c.revien.recall_limit).toBe(d.revien.recall_limit);
    expect(c.revien.timeout_ms).toBe(d.revien.timeout_ms);
    expect(inheritedBase({ integrations: { browser_url: 'x' }, revien: { url: 'y' }, tools: { a: 1 } })).toEqual({ tools: { a: 1 } });
  });
  it('a tenant that names its own seat or address gets exactly those', () => {
    const root = makeTenantsDir({ bea: { yaml: 'integrations:\n  browser_url: "http://bea-seat.example.net"\nrevien:\n  enabled: true\n  url: "http://bea-daemon.example.net:7438"\n' } });
    const c = load({ integrations: { browser_url: 'http://seat.example.net', life_api_url: 'http://life.example.net' } }, root, 'bea');
    expect(c.integrations.browser_url).toBe('http://bea-seat.example.net');
    expect(c.integrations.life_api_url).toBe('');
    expect(c.revien).toMatchObject({ enabled: true, url: 'http://bea-daemon.example.net:7438' });
  });
  it('agent.dsh.command (a binary path) is never inherited; the rest of agent.dsh still is', () => {
    const root = makeTenantsDir({ bea: {} });
    const file = { agent: { dsh: { command: '/opt/operator/bin/dsh', api_key_env: 'OP_KEY_NAME', model: 'dsh-model' } } };
    const c = load(file, root, 'bea');
    expect(c.agent.dsh.command).toBe(mergeConfigDefaults({}).agent.dsh.command);
    expect(c.agent.dsh.model).toBe('dsh-model');
    expect(NEVER_INHERITED).toContain('agent.dsh.command');
  });
});

describe('a secret by its name is stripped from the inherited base at every depth', () => {
  it('my_plugin.api_key does not reach the tenant, and a sibling that is not a secret does', () => {
    const root = makeTenantsDir({ bea: {} });
    const c = load({ my_plugin: { api_key: 'sk-operator', endpoint: 'plugin.example.net', nested: { Client_Secret: 's', label: 'x' } } }, root, 'bea') as unknown as Record<string, Record<string, any>>;
    expect(c.my_plugin.api_key).toBeUndefined();
    expect(c.my_plugin.nested.Client_Secret).toBeUndefined();
    expect(c.my_plugin.endpoint).toBe('plugin.example.net');
    expect(c.my_plugin.nested.label).toBe('x');
    expect(JSON.stringify(c)).not.toMatch(/sk-operator/);
  });
  it('every name the rule lists is stripped (any case), wherever it sits, lists of mappings included; names that merely contain a word are kept', () => {
    const base = inheritedBase({
      voice: { elevenlabs_api_key: 'a', ApiKey: 'b', stt_token: 'c', password: 'd', db_passwd: 'e', credential: 'f', aws_credentials: 'g', signing_key: 'h', client_secret: 'i', my_apikey_name: 'j', enabled: true, monkeys: 3, keyboard: 'kept', tokens_per_turn: 5 },
      plugins: { list: [{ id: 'x', token: 't', name: 'n' }] },
    });
    expect(base.voice).toEqual({ enabled: true, monkeys: 3, keyboard: 'kept', tokens_per_turn: 5 });
    expect(base.plugins.list).toEqual([{ id: 'x', name: 'n' }]);
  });
  it('a tenant may still say a secret-named key itself, in its own tenant.yaml', () => {
    const root = makeTenantsDir({ bea: { yaml: 'my_plugin:\n  api_key: bea-own\n' } });
    expect((load({ my_plugin: { api_key: 'sk-operator' } }, root, 'bea') as unknown as { my_plugin: { api_key: string } }).my_plugin.api_key).toBe('bea-own');
  });
});

describe('a tenant takes away what it inherited (null removes a key, {} empties a mapping)', () => {
  const file = { orchestrator: { schedules: { operator_morning: '0 7 * * *', operator_night: '0 22 * * *' }, failsafe: { enabled: true, gentle_minutes: 30 } }, tools: { a: { on: true }, b: { on: true } } };
  it('schedules: {} leaves the tenant with no schedules while the rest of orchestrator is still inherited', () => {
    const root = makeTenantsDir({ bea: { yaml: 'orchestrator:\n  schedules: {}\n' } });
    const c = load(file, root, 'bea');
    expect(c.orchestrator.schedules).toEqual({});
    expect(c.orchestrator.failsafe).toMatchObject({ enabled: true, gentle_minutes: 30 });
  });
  it('orchestrator: ~ gives the tenant the pristine orchestrator defaults', () => {
    const root = makeTenantsDir({ bea: { yaml: 'orchestrator: ~\n' } });
    const { wake_prompts_dir: _d, wake_prompts_path: _p, ...got } = load(file, root, 'bea').orchestrator as unknown as Record<string, unknown>; // (the shipped prompt paths are resolved from the app)
    const { wake_prompts_dir: _d2, wake_prompts_path: _p2, ...want } = mergeConfigDefaults({}).orchestrator as unknown as Record<string, unknown>;
    expect(got).toEqual(want);
  });
  it('a key set to ~ removes only that inherited key', () => {
    const root = makeTenantsDir({ bea: { yaml: 'orchestrator:\n  schedules:\n    operator_night: ~\n' } });
    const c = load(file, root, 'bea');
    expect(c.orchestrator.schedules).toEqual({ operator_morning: '0 7 * * *' });
  });
  it('everything else still deep-merges: a mapping with keys adds to the inherited one, and the inherited tools are untouched', () => {
    const root = makeTenantsDir({ bea: { yaml: 'orchestrator:\n  schedules:\n    own: "0 9 * * *"\n' } });
    const c = load(file, root, 'bea');
    expect(c.orchestrator.schedules).toEqual({ operator_morning: '0 7 * * *', operator_night: '0 22 * * *', own: '0 9 * * *' });
    expect((c as unknown as { tools: unknown }).tools).toEqual(file.tools);
  });
  it('the candidate (dry-run) path reads the markers the same way', () => {
    const root = makeTenantsDir({ bea: {} });
    const c = loadTenantConfig(proc(file), join(root, 'bea'), 'bea', { fileCfg: { orchestrator: { schedules: {} } }, processFile: file, quiet: true }).config;
    expect(c.orchestrator.schedules).toEqual({});
  });
});

describe('the docs say what the code does', () => {
  const read = (f: string) => readFileSync(fileURLToPath(new URL(`../../../../docs/${f}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  it('MULTI-TENANT.md: Revien is per tenant only with its own daemon, the process one is never shared by default, ~ and {} are explained', () => {
    const doc = read('MULTI-TENANT.md');
    expect(doc).toMatch(/Revien[^\n]*own daemon/i);
    expect(doc).toMatch(/process[^\n]*Revien[^\n]*never shared|never shared[^\n]*Revien/i);
    expect(doc).toMatch(/`~`[^\n]*removes|set to `~`/);
    expect(doc).toMatch(/`\{\}`/);
  });
  it('CONFIGURATION.md: process-only keys are ignored with a warning at boot and refused by the wizard before it writes; the secret-name rule and ~ / {} are stated', () => {
    const doc = read('CONFIGURATION.md');
    expect(doc).toMatch(/ignored with a warning/i);
    expect(doc).toMatch(/npm run setup -- --tenant[^\n]*refuses such a file before writing/i);
    expect(doc).toMatch(/api_key/);
    expect(doc).toMatch(/set to `~`|`~`/);
  });
});

describe('~ means "not set by the tenant and not inherited; the default applies", at any depth (item 5)', () => {
  it('agent: { cwd: ~ } is the tenant\'s home/, with an operator agent section and without one', () => {
    const root = makeTenantsDir({ ada: { yaml: 'agent:\n  cwd: ~\n' } });
    for (const file of [{ agent: { model: 'operator-model', cwd: '/op/home' } }, {}]) {
      const c = load(file, root, 'ada');
      expect(c.agent.cwd).toBe(resolve(root, 'ada', 'home'));
    }
  });
  it('identity: { timezone: ~ } is the process timezone, not a refusal (and not null)', () => {
    const root = makeTenantsDir({ ada: { yaml: 'identity:\n  timezone: ~\n' } });
    const c = load({}, root, 'ada');
    expect(c.identity.timezone).toBe('UTC');
    expect(JSON.stringify(c)).not.toContain('"timezone":null');
  });
  it('agent: { model: ~ } is the default model, never null, with and without an operator model', () => {
    const root = makeTenantsDir({ ada: { yaml: 'agent:\n  model: ~\n  codex:\n    sandbox_mode: ~\n' } });
    for (const file of [{ agent: { model: 'operator-model', codex: { sandbox_mode: 'read-only' } } }, {}]) {
      const c = load(file, root, 'ada');
      expect(c.agent.model).toBe(mergeConfigDefaults({}).agent.model);
      expect(c.agent.codex.sandbox_mode).toBe(mergeConfigDefaults({}).agent.codex.sandbox_mode);
    }
  });
  it('a null on a key nobody had never survives anywhere in the result, and the candidate (dry-run) path agrees', () => {
    const root = makeTenantsDir({ ada: {} });
    const c = loadTenantConfig(proc({}), join(root, 'ada'), 'ada', { fileCfg: { agent: { cwd: null, model: null }, tools: { x: { y: null } } }, processFile: {}, quiet: true }).config;
    expect(c.agent.cwd).toBe(resolve(root, 'ada', 'home'));
    expect(c.agent.model).toBe(mergeConfigDefaults({}).agent.model);
    expect(overlay({}, { a: { b: { c: null, d: 1 } } })).toEqual({ a: { b: { d: 1 } } });
  });
});

describe('`inherit: false` inside a mapping replaces the inherited mapping with this one (item 6)', () => {
  const file = { agent: { model: 'operator-model', provider: 'codex', codex: { sandbox_mode: 'read-only', model: 'cx' } }, orchestrator: { schedules: { operator_morning: '0 7 * * *' }, failsafe: { enabled: true, gentle_minutes: 30 } } };
  it('the loader honours it at any depth and the key is never in the result', () => {
    const root = makeTenantsDir({ ada: { yaml: 'agent:\n  inherit: false\n  provider: claude\n  codex:\n    inherit: false\n    sandbox_mode: workspace-write\norchestrator:\n  schedules:\n    inherit: false\n    own: "0 9 * * *"\n' } });
    const c = load(file, root, 'ada') as unknown as Record<string, any>;
    expect(c.agent.model).toBe(mergeConfigDefaults({}).agent.model); // nothing under agent is inherited
    expect(c.agent.provider).toBe('claude');
    expect(c.agent.codex.model).toBe(mergeConfigDefaults({}).agent.codex.model);
    expect(c.agent.codex.sandbox_mode).toBe('workspace-write');
    expect(c.orchestrator.schedules).toEqual({ own: '0 9 * * *' });
    expect(c.orchestrator.failsafe).toMatchObject({ enabled: true, gentle_minutes: 30 }); // a sibling mapping is still inherited
    expect(JSON.stringify(c)).not.toContain('"inherit"');
  });
  it('at the top of the file it turns the whole inherited base off for that tenant', () => {
    const root = makeTenantsDir({ ada: { yaml: 'inherit: false\nagent:\n  provider: claude\n' } });
    const c = load(file, root, 'ada');
    expect(c.agent.model).toBe(mergeConfigDefaults({}).agent.model);
    expect(c.orchestrator.schedules).toEqual(mergeConfigDefaults({}).orchestrator.schedules);
  });
  it('the wizard\'s rewrite of `agent: ~` writes `inherit: false` with its values, and the tenant still inherits nothing under agent', () => {
    const tenantYaml = { agent: null };
    const inherited = inheritedBase(file) as Record<string, any>;
    const own = withRemovalMarkers({ agent: { provider: 'claude', codex: { sandbox_mode: 'workspace-write' } } }, removalMarkers(tenantYaml), inherited);
    expect(own).toEqual({ agent: { inherit: false, provider: 'claude', codex: { sandbox_mode: 'workspace-write' } } });
    const root = makeTenantsDir({ ada: {} });
    const c = loadTenantConfig(proc(file), join(root, 'ada'), 'ada', { fileCfg: own, processFile: file, quiet: true }).config;
    expect(c.agent.model).toBe(mergeConfigDefaults({}).agent.model);
    expect(c.agent.provider).toBe('claude');
    // the same for {}: written values keep the replacement
    expect(withRemovalMarkers({ agent: { provider: 'claude' } }, removalMarkers({ agent: {} }), inherited)).toEqual({ agent: { inherit: false, provider: 'claude' } });
    // an existing `inherit: false` mapping is a marker too, and survives a rewrite that wrote nothing under it
    expect(withRemovalMarkers({}, removalMarkers({ agent: { inherit: false, provider: 'claude' } }), inherited)).toEqual({ agent: { inherit: false } });
  });
  it('a null marker over a key the base does not hold is dropped by a rewrite (it says nothing), one over a held key is kept', () => {
    const inherited = inheritedBase(file) as Record<string, any>;
    expect(withRemovalMarkers({}, removalMarkers({ identity: { timezone: null }, agent: { cwd: null } }), inherited)).toEqual({});
    expect(withRemovalMarkers({}, removalMarkers({ agent: { model: null } }), inherited)).toEqual({ agent: { model: null } });
  });
  it('tenancy off: the real single-tenant loadConfig never reads, strips or acts on the key: a yaml with `inherit:` loads as main would (the key stays as written, nothing is replaced)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    const cfgMod = await import('../config.js');
    const root = makeTenantsDir({});
    const file = join(root, 'sanctum.yaml');
    writeFileSync(file, 'identity:\n  timezone: UTC\nagent:\n  inherit: false\n  model: file-model\ntools:\n  inherit: false\n  keep: 1\n');
    const withKey = cfgMod.loadConfig(file) as unknown as Record<string, any>;
    expect(withKey.agent.inherit).toBe(false); // not stripped
    expect(withKey.agent.model).toBe('file-model');
    expect(withKey.tools).toEqual({ inherit: false, keep: 1 });
    expect(withKey.tenants).toBeUndefined();
    // everything but the key is what the same file without it gives
    vi.resetModules();
    const again = await import('../config.js');
    writeFileSync(file, 'identity:\n  timezone: UTC\nagent:\n  model: file-model\ntools:\n  keep: 1\n');
    const without = again.loadConfig(file) as unknown as Record<string, any>;
    const strip = (c: Record<string, any>) => { const o = JSON.parse(JSON.stringify(c)); delete o.agent.inherit; delete o.tools.inherit; return o; };
    expect(strip(withKey)).toEqual(strip(without));
  });
});

describe('plural and plain secret names are never inherited (item 7)', () => {
  it('the five leaks are stripped: secrets, tokens, keys, private_key_pem, passphrase (lists of mappings included)', () => {
    const base = inheritedBase({
      my_plugin: { secrets: { github: 'ghp' }, tokens: ['t1', 't2'], keys: { a: 'k' }, private_key_pem: 'pem', passphrase: 'pp', endpoint: 'e' },
      list: [{ id: 'x', tokens: ['t'], keys: ['k'], name: 'n' }],
    }) as Record<string, any>;
    expect(base.my_plugin).toEqual({ endpoint: 'e' });
    expect(base.list).toEqual([{ id: 'x', name: 'n' }]);
    const root = makeTenantsDir({ ada: {} });
    const c = load({ my_plugin: { secrets: { github: 'ghp-operator' }, passphrase: 'pp-operator', endpoint: 'e' } }, root, 'ada');
    expect(JSON.stringify(c)).not.toMatch(/ghp-operator|pp-operator/);
  });
  it('the rule reads the last word: endpoint, keyboard and monkey_count still inherit; camelCase, dashes and the other plurals are caught', () => {
    for (const n of ['endpoint', 'keyboard', 'monkey_count', 'monkey', 'auth_header', 'webhook_url', 'bearer', 'session_cookie', 'tokens_per_turn', 'key_name']) expect(isSecretKeyName(n), n).toBe(false);
    for (const n of ['secrets', 'tokens', 'keys', 'private_key_pem', 'passphrase', 'passwords', 'credentials', 'apiKey', 'authToken', 'X-API-Key', 'githubSecrets', 'my_privatekey_id', 'ssh_private_key', 'pem']) expect(isSecretKeyName(n), n).toBe(true);
  });
  it('a secret under another name IS inherited (documented): auth_header, webhook_url, bearer, session_cookie', () => {
    const base = inheritedBase({ my_plugin: { auth_header: 'a', webhook_url: 'w', bearer: 'b', session_cookie: 'c' } }) as Record<string, any>;
    expect(base.my_plugin).toEqual({ auth_header: 'a', webhook_url: 'w', bearer: 'b', session_cookie: 'c' });
    const doc = readFileSync(fileURLToPath(new URL('../../../../docs/MULTI-TENANT.md', import.meta.url)), 'utf8');
    const conf = readFileSync(fileURLToPath(new URL('../../../../docs/CONFIGURATION.md', import.meta.url)), 'utf8');
    for (const text of [doc, conf]) expect(text).toMatch(/auth_header[\s\S]{0,80}webhook_url[\s\S]{0,80}bearer[\s\S]{0,80}session_cookie/);
  });
});

describe('the docs words of the round-3 nits (item 8)', () => {
  it('CONFIGURATION.md says those keys are ignored with a warning and the rest of the file applies', () => {
    const conf = readFileSync(fileURLToPath(new URL('../../../../docs/CONFIGURATION.md', import.meta.url)), 'utf8');
    expect(conf).toMatch(/ignored with a warning[^\n]*the rest of the file applies/);
    expect(conf).not.toMatch(/A `tenant\.yaml` that sets them is ignored with a warning/);
  });
});
