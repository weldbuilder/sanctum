import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { TENANT_ID_RE, isHousehold, isTenantId, parseTenantsBlock, listTenants, loadTenantConfig, checkHostClaims } from './config.js';
import { makeTenantsDir, processConfigFor } from './test-runtime.js';

afterEach(() => vi.restoreAllMocks());

describe('tenant ids', () => {
  it('accepts a, a-b, 0a and 32 characters', () => {
    for (const ok of ['a', 'a-b', '0a', '9', 'a'.repeat(32), 'ada-2']) expect(isTenantId(ok), ok).toBe(true);
  });
  it('rejects 33 characters, -a, A, a_b, .., empty and non-strings', () => {
    for (const bad of ['a'.repeat(33), '-a', 'A', 'a_b', '..', '', 'a/b', 'a b', 'a.b']) expect(TENANT_ID_RE.test(bad), bad).toBe(false);
    expect(isTenantId(5)).toBe(false);
    expect(isTenantId(undefined)).toBe(false);
  });
});

describe('parseTenantsBlock', () => {
  const base = resolve(tmpdir(), 'sanctum-base');
  it('is null with no block, and the block is resolved against the base', () => {
    expect(parseTenantsBlock({}, base)).toBeNull();
    expect(parseTenantsBlock({ tenants: null }, base)).toBeNull();
    expect(parseTenantsBlock({ tenants: { dir: 'tenants' } }, base)).toEqual({ dir: resolve(base, 'tenants') });
    expect(parseTenantsBlock({ tenants: { dir: base, default: 'ada' } }, base)).toEqual({ dir: base, default: 'ada' });
  });
  it('refuses a block without dir and a default that is not an id', () => {
    expect(() => parseTenantsBlock({ tenants: {} }, base)).toThrow(/tenants\.dir/);
    expect(() => parseTenantsBlock({ tenants: 'x' }, base)).toThrow(/mapping/);
    expect(() => parseTenantsBlock({ tenants: { dir: 'd', default: 'Ada' } }, base)).toThrow(/not a tenant id/);
  });
});

describe('listTenants', () => {
  it('lists valid id folders, sorted, and skips files and badly named folders', () => {
    const root = makeTenantsDir({ bea: {}, ada: {}, 'Not_Valid': {}, '-x': {} });
    expect(listTenants(root)).toEqual(['ada', 'bea']);
  });
  it('throws for a folder that does not exist', () => {
    expect(() => listTenants(join(mkdtempSync(join(tmpdir(), 'sanctum-none-')), 'missing'))).toThrow(/does not exist/);
  });
});

describe('checkHostClaims', () => {
  it('refuses one host claimed by two tenants', () => {
    expect(() => checkHostClaims([{ id: 'a', hosts: ['ada.example.net'] }, { id: 'b', hosts: ['ada.example.net'] }])).toThrow(/claimed by both/);
  });
  it('refuses a default that names no tenant, accepts one that does', () => {
    const t = [{ id: 'a', hosts: ['ada.example.net'] }, { id: 'b', hosts: ['bea.example.net'] }];
    expect(() => checkHostClaims(t, 'zed')).toThrow(/no tenant folder/);
    expect(() => checkHostClaims(t, 'b')).not.toThrow();
  });
});

describe('loadTenantConfig', () => {
  const procBase = resolve(tmpdir(), 'sanctum-process');
  const proc = () => processConfigFor(procBase, { server: { port: 4100, host: '127.0.0.1' }, identity: { timezone: 'UTC' }, cors: { origins: ['https://ada.example.net'] } });

  it('resolves relative paths and the defaults into the tenant folder', () => {
    const root = makeTenantsDir({ ada: { yaml: 'identity:\n  companion_name: Ada\nplugins:\n  dir: mine\n' } });
    const dir = join(root, 'ada');
    const { config } = loadTenantConfig(proc(), dir, 'ada');
    expect(config.server.db_path).toBe(resolve(dir, 'data', 'sanctum.db'));
    expect(config.agent.cwd).toBe(resolve(dir, 'home'));
    expect(config.discord.private_dir).toBe(resolve(dir, 'private'));
    expect(config.identity.ledger_dir).toBe(resolve(dir, 'data', 'identity'));
    expect(config.plugins.ledger_dir).toBe(resolve(dir, 'data', 'plugins'));
    expect(config.plugins.dir).toBe(resolve(dir, 'mine'));
    expect(config.identity.companion_name).toBe('Ada');
    // The process owns the listen address.
    expect(config.server.port).toBe(4100);
  });

  it('ignores server, cors, tenants and updates in tenant.yaml with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = makeTenantsDir({ ada: { yaml: 'server:\n  port: 1\n  db_path: /elsewhere.db\ncors:\n  origins: [https://evil.example.net]\nupdates:\n  repo: x/y\ntenants:\n  dir: /nope\n' } });
    const { config } = loadTenantConfig(proc(), join(root, 'ada'), 'ada');
    const mine = warn.mock.calls.filter((c) => String(c[0]).includes('[tenancy]'));
    expect(mine).toHaveLength(1);
    expect(String(mine[0][0])).toMatch(/server, cors, tenants, updates/);
    expect(config.server.port).toBe(4100);
    expect(config.server.db_path).toBe(resolve(root, 'ada', 'data', 'sanctum.db'));
    expect((config as unknown as { cors: { origins: string[] } }).cors.origins).toEqual(['https://ada.example.net']);
    expect('tenants' in config).toBe(false);
  });

  it('reads hosts, lower-cased, and refuses a host with a scheme or port', () => {
    const ok = makeTenantsDir({ ada: { yaml: 'hosts:\n  - Ada.Example.NET\n  - ada.example.net\n  - bea.example.net\n' } });
    expect(loadTenantConfig(proc(), join(ok, 'ada'), 'ada').hosts).toEqual(['ada.example.net', 'bea.example.net']);
    for (const bad of ['https://ada.example.net', 'ada.example.net:3000', 'a/b', '""']) {
      const root = makeTenantsDir({ ada: { yaml: `hosts: [${bad}]\n` } });
      expect(() => loadTenantConfig(proc(), join(root, 'ada'), 'ada'), bad).toThrow(/bare hostname/);
    }
  });

  it('does not let AGENT_MODEL (or any key) in process.env reach the tenant', () => {
    const before = process.env.AGENT_MODEL;
    process.env.AGENT_MODEL = 'process-model-must-not-leak';
    process.env.COMPANION_NAME = 'LeakedName';
    try {
      const root = makeTenantsDir({ ada: { yaml: 'agent:\n  model: tenant-model\n' }, bea: { env: 'AGENT_MODEL=bea-env-model\n' } });
      expect(loadTenantConfig(proc(), join(root, 'ada'), 'ada').config.agent.model).toBe('tenant-model');
      expect(loadTenantConfig(proc(), join(root, 'ada'), 'ada').config.identity.companion_name).not.toBe('LeakedName');
      // The tenant's own .env does apply.
      expect(loadTenantConfig(proc(), join(root, 'bea'), 'bea').config.agent.model).toBe('bea-env-model');
    } finally {
      if (before === undefined) delete process.env.AGENT_MODEL; else process.env.AGENT_MODEL = before;
      delete process.env.COMPANION_NAME;
    }
  });

  it('puts APP_PASSWORD from the tenant .env in config only: process.env is deep-equal before and after', () => {
    const root = makeTenantsDir({ ada: { env: 'APP_PASSWORD=ada-password\nPORT=1\nDB_PATH=/elsewhere.db\n' } });
    const before = JSON.parse(JSON.stringify(process.env));
    const { config, env } = loadTenantConfig(proc(), join(root, 'ada'), 'ada');
    expect(config.auth.password).toBe('ada-password');
    expect(env.APP_PASSWORD).toBeUndefined();
    // PORT, HOST and DB_PATH are the process's: a tenant .env cannot move its database or its listener.
    expect(config.server.port).toBe(4100);
    expect(config.server.db_path).toBe(resolve(root, 'ada', 'data', 'sanctum.db'));
    expect(JSON.parse(JSON.stringify(process.env))).toEqual(before);
  });

  it('refuses a timezone that differs from the process, one line, and inherits it when none is given', () => {
    const bad = makeTenantsDir({ ada: { yaml: 'identity:\n  timezone: Europe/Paris\n' } });
    expect(() => loadTenantConfig(proc(), join(bad, 'ada'), 'ada')).toThrow(/identity\.timezone "Europe\/Paris" differs from the process timezone "UTC"/);
    try { loadTenantConfig(proc(), join(bad, 'ada'), 'ada'); } catch (e) { expect((e as Error).message.split('\n')).toHaveLength(1); }
    const same = makeTenantsDir({ ada: { yaml: 'identity:\n  timezone: UTC\n' }, bea: {} });
    expect(loadTenantConfig(proc(), join(same, 'ada'), 'ada').config.identity.timezone).toBe('UTC');
    const procParis = processConfigFor(procBase, { identity: { timezone: 'Europe/Paris' } });
    expect(loadTenantConfig(procParis, join(same, 'bea'), 'bea').config.identity.timezone).toBe('Europe/Paris');
  });

  it('takes the shipped prompt files from the process and keeps its own working files in the tenant folder', () => {
    const root = makeTenantsDir({ ada: {} });
    const p = proc();
    const { config } = loadTenantConfig(p, join(root, 'ada'), 'ada');
    expect(config.orchestrator.wake_prompts_dir).toBe(p.orchestrator.wake_prompts_dir);
    expect(config.agent.codex.base_instructions_file).toBe(p.agent.codex.base_instructions_file);
    expect(config.agent.mcp_json_path).toBe(join(root, 'ada', '.mcp.json'));
    expect(config.agent.claude_md_path).toBe(join(resolve(root, 'ada', 'home'), 'CLAUDE.md'));
  });

  it("defaults the Claude frame to the tenant's own home copy; an explicit \"\" stays the preset; a path of its own is kept", () => {
    const root = makeTenantsDir({
      ada: {},
      bea: { yaml: 'agent:\n  system_prompt_file: ""\n' },
      cy: { yaml: 'agent:\n  system_prompt_file: home/frame.md\n' },
      dee: { yaml: 'agent:\n  system_prompt_file:\n' },
      eli: { yaml: 'agent:\n  cwd: elsewhere\n' },
    });
    const frame = (id: string) => loadTenantConfig(proc(), join(root, id), id).config.agent.system_prompt_file;
    expect(frame('ada')).toBe(join(resolve(root, 'ada', 'home'), 'config', 'companion-claude.md'));
    expect(frame('bea')).toBe('');
    expect(frame('cy')).toBe(join(resolve(root, 'cy', 'home'), 'frame.md'));
    expect(frame('dee')).toBe(join(resolve(root, 'dee', 'home'), 'config', 'companion-claude.md')); // (a bare key is "not set")
    expect(frame('eli')).toBe(join(resolve(root, 'eli', 'elsewhere'), 'config', 'companion-claude.md')); // follows the tenant's own cwd
  });

  it('two tenants never share a config object (writes into one are not seen by the other, or by a third)', () => {
    const root = makeTenantsDir({ ada: { env: 'APP_PASSWORD=pw-ada\n', yaml: 'agent:\n  model: m-ada\n' }, bea: { env: 'APP_PASSWORD=pw-bea\n' }, cy: {} });
    const p = proc();
    const a = loadTenantConfig(p, join(root, 'ada'), 'ada').config;
    const b = loadTenantConfig(p, join(root, 'bea'), 'bea').config;
    const c = loadTenantConfig(p, join(root, 'cy'), 'cy').config;
    expect([a.auth.password, b.auth.password, c.auth.password]).toEqual(['pw-ada', 'pw-bea', '']);
    expect(a.auth).not.toBe(b.auth);
    expect(a.agent).not.toBe(b.agent);
    a.agent.model = 'changed';
    expect(b.agent.model).not.toBe('changed');
    expect(p.auth.password).toBe('');
  });

  it('a malformed tenant.yaml is a boot error', () => {
    const root = makeTenantsDir({ ada: { yaml: '- a\n- b\n' } });
    expect(() => loadTenantConfig(proc(), join(root, 'ada'), 'ada')).toThrow(/must be a mapping/);
  });
});

describe('the real loadConfig does not leak into tenants', () => {
  it('a tenant with no .env gets none of the process environment, even after loadConfig wrote it', async () => {
    const keys = { APP_PASSWORD: 'PROCESS-PW', AGENT_MODEL: 'process-model', AGENT_PROVIDER: 'codex', COMPANION_NAME: 'ProcName', USER_NAME: 'ProcUser',
      GOOGLE_CLIENT_ID: 'proc-gid', GOOGLE_CLIENT_SECRET: 'proc-gsecret', WORKSPACE_ROOT: '/proc/ws', VAULT_PATH: '/proc/vault', EXTRA_WRITE_PATHS: '/proc/x,/proc/y' };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(keys)) { saved[k] = process.env[k]; process.env[k] = v; }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      vi.resetModules();
      const cfgMod = await import('../config.js');
      const tcfg = await import('./config.js');
      const root = makeTenantsDir({ ada: {} });
      const file = join(root, 'sanctum.yaml');
      (await import('node:fs')).writeFileSync(file, `tenants:\n  dir: ${JSON.stringify(root)}\n`);
      const proc = cfgMod.loadConfig(file);
      expect(proc.auth.password).toBe('PROCESS-PW');
      const t = tcfg.loadTenantConfig(proc, join(root, 'ada'), 'ada').config;
      expect(t.auth.password).toBe('');
      expect(t.agent.model).not.toBe('process-model');
      expect(t.agent.provider).not.toBe('codex');
      expect(t.identity.companion_name).not.toBe('ProcName');
      expect(t.identity.user_name).not.toBe('ProcUser');
      expect(t.google.client_id).not.toBe('proc-gid');
      expect(t.google.client_secret).not.toBe('proc-gsecret');
      expect(t.hooks.workspace_root).not.toBe('/proc/ws');
      expect(t.hooks.vault_path).not.toBe('/proc/vault');
      expect(t.hooks.extra_write_paths).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe('tenants.auth (household or per-tenant)', () => {
  const base = resolve(tmpdir(), 'sanctum-base');
  it('reads household and per-tenant; a missing key is household', () => {
    expect(parseTenantsBlock({ tenants: { dir: 'd', auth: 'household' } }, base)).toEqual({ dir: resolve(base, 'd'), auth: 'household' });
    expect(parseTenantsBlock({ tenants: { dir: 'd', auth: 'per-tenant' } }, base)).toEqual({ dir: resolve(base, 'd'), auth: 'per-tenant' });
    expect(isHousehold(parseTenantsBlock({ tenants: { dir: 'd', auth: 'household' } }, base))).toBe(true);
    expect(isHousehold(parseTenantsBlock({ tenants: { dir: 'd', auth: 'per-tenant' } }, base))).toBe(false);
    const missing = parseTenantsBlock({ tenants: { dir: 'd' } }, base);
    expect(missing).not.toHaveProperty('auth');
    expect(isHousehold(missing)).toBe(true);
    expect(isHousehold(parseTenantsBlock({ tenants: { dir: 'd', auth: null } }, base))).toBe(true);
    expect(isHousehold(null)).toBe(false); // (no tenants block: not a mode at all)
  });
  it('refuses any other value, naming the key', () => {
    for (const bad of ['both', 'Household', 'per_tenant', '', true, 1, [], {}]) {
      expect(() => parseTenantsBlock({ tenants: { dir: 'd', auth: bad } }, base), JSON.stringify(bad)).toThrow(/tenants\.auth: must be household or per-tenant/);
    }
  });
  it('is process-only: a tenant.yaml that says tenants.auth is ignored with the process-only warning, and the tenant config never carries it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = makeTenantsDir({ ada: { yaml: 'tenants:\n  auth: per-tenant\n' } });
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    (proc as unknown as { tenants: unknown }).tenants = { dir: root };
    const loaded = loadTenantConfig(proc, join(root, 'ada'), 'ada');
    expect((loaded.config as unknown as Record<string, unknown>).tenants).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toMatch(/tenants/);
  });
});
