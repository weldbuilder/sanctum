// What a harness child gets in tenant mode (decision D2). The process holds a provider key P; ada's own .env holds T; bea has none.
// Every env builder (Claude via the provider switch, Codex, dsh) must see T for ada, nothing for bea, and never P.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import { statSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const seen: { env: Record<string, string | undefined> | undefined }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (p: { options?: { env?: Record<string, string | undefined> } }) => { seen.push({ env: p.options?.env }); return {}; },
  AbortError: class extends Error {},
  listSessions: async () => [],
}));

import { bootTenants } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { childBaseEnv, withRunEnv, spawnWrapper } from './child.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { query } from '../services/providers/index.js';
import { childEnv } from '../services/providers/child-env.js';
import { codexChildEnv } from '../services/providers/codex-exec.js';
import { realDeep } from '../services/plugin-paths.js';
import { buildExecEnv } from '../services/providers/dsh-exec.js';

const PROCESS_KEYS = { ANTHROPIC_API_KEY: 'P-anthropic', OPENAI_API_KEY: 'P-openai', DEEPSEEK_API_KEY: 'P-deepseek', MIND_API_KEY: 'P-mind', APP_PASSWORD: 'P-pass', SOME_OTHER_SECRET: 'P-other' };
const saved: Record<string, string | undefined> = {};
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;
const dshParams = { cwd: '/x', sandboxMode: 'workspace-write', apiKeyEnv: 'DEEPSEEK_API_KEY' } as never;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const k of Object.keys(PROCESS_KEYS)) saved[k] = process.env[k];
  Object.assign(process.env, PROCESS_KEYS);
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (cfg as unknown as { tenants: unknown }).tenants = {
    dir: makeTenantsDir({
      ada: { yaml: 'hosts: [ada.example.net]\n', env: 'ANTHROPIC_API_KEY=T-anthropic\nOPENAI_API_KEY=T-openai\nDEEPSEEK_API_KEY=T-deepseek\nAPP_PASSWORD=ada-pass\nMIND_API_KEY=T-mind\n' },
      bea: { yaml: 'hosts: [bea.example.net]\n' },
    }),
  };
  runtimes = bootTenants(express(), safeTenancyProcess(cfg));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
});
afterAll(async () => {
  await stopBootedTenants();
  for (const rt of runtimes.values()) rt.db.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});
afterEach(() => { seen.length = 0; });

const inside = (rt: TenantRuntime, p: string) => { const r = relative(realDeep(join(rt.dataDir, 'harness')).toLowerCase(), realDeep(p).toLowerCase()); return !r.startsWith('..') && !isAbsolute(r) && r !== ''; };

describe('child env in tenant mode', () => {
  it('the Claude, Codex and dsh builders see the tenant\'s keys and never the process\'s', () => {
    runInTenant(ada, () => {
      query({ prompt: 'hi' });
      const claude = seen[0].env!;
      const codex = codexChildEnv();
      const dsh = buildExecEnv(dshParams, childBaseEnv());
      // The tenant's own .env key is in its base env. The default auth choice is the subscription, and a run base applies the choice
      // (single-tenant behaviour), so the Claude and Codex run envs have no Anthropic key at all, never the process's.
      expect(childBaseEnv().ANTHROPIC_API_KEY).toBe('T-anthropic');
      expect(claude.ANTHROPIC_API_KEY).toBeUndefined();
      expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
      expect(codex.OPENAI_API_KEY).toBe('T-openai');
      expect(dsh.DEEPSEEK_API_KEY).toBe('T-deepseek');
      for (const env of [claude, codex, dsh]) expect(Object.values(env)).not.toContain('P-anthropic');
      for (const env of [claude, codex, dsh]) for (const p of Object.values(PROCESS_KEYS)) expect(Object.values(env)).not.toContain(p);
    });
  });

  it('a tenant with no key sees none, from any builder', () => {
    runInTenant(bea, () => {
      query({ prompt: 'hi' });
      const envs = [seen[0].env!, codexChildEnv(), buildExecEnv(dshParams, childBaseEnv())];
      for (const env of envs) {
        for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'SOME_OTHER_SECRET']) expect(env[name]).toBeUndefined();
        for (const p of Object.values(PROCESS_KEYS)) expect(Object.values(env)).not.toContain(p);
      }
    });
  });

  it('APP_PASSWORD and MIND_API_KEY are absent even when the tenant .env has them; the token and port are the tenant\'s', () => {
    runInTenant(ada, () => {
      const base = childBaseEnv();
      const names = Object.keys(base).map((k) => k.toUpperCase());
      expect(names).not.toContain('APP_PASSWORD');
      expect(names).not.toContain('MIND_API_KEY');
      expect(childEnv(base).MIND_API_KEY).toBeUndefined();
      expect(base.INTERNAL_TOKEN).toBe(ada.token);
      expect(base.SANCTUM_PORT).toBe(String(ada.config.server.port));
    });
    runInTenant(bea, () => expect(childBaseEnv().INTERNAL_TOKEN).toBe(bea.token));
    expect(ada.token).not.toBe(bea.token);
  });

  it('the harness homes sit inside <tenant>/data/harness, per tenant, owner-only', () => {
    for (const rt of [ada, bea]) {
      runInTenant(rt, () => {
        const env = childBaseEnv();
        for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME'] as const) {
          expect(inside(rt, env[name]!)).toBe(true);
          expect(statSync(env[name]!).isDirectory()).toBe(true);
          if (process.platform !== 'win32') expect(statSync(env[name]!).mode & 0o077).toBe(0);
        }
        expect(env.CLAUDE_CONFIG_DIR).toContain(`${sep}claude`);
      });
    }
    expect(runInTenant(ada, () => childBaseEnv().CODEX_HOME)).not.toBe(runInTenant(bea, () => childBaseEnv().CODEX_HOME));
  });

  it('nothing from process.env gets in unless it is on the allowlist', () => {
    runInTenant(ada, () => {
      const base = childBaseEnv();
      const allowed = new Set(['PATH', 'HOME', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'SHELL', 'USER', 'LOGNAME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
        'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'SYSTEMROOT',
        'INTERNAL_TOKEN', 'SANCTUM_PORT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', ...Object.keys(ada.env).map((k) => k.toUpperCase())]);
      for (const k of Object.keys(base)) {
        const up = k.toUpperCase();
        if (allowed.has(up) || up.startsWith('LC_')) continue;
        throw new Error(`${k} reached a tenant child env without being allowlisted or in the tenant .env`);
      }
      expect(base.SOME_OTHER_SECRET).toBeUndefined();
    });
  });

  it('allowlisted names match case-insensitively, as Windows enumerates them (Path, not PATH)', () => {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'Path');
    const before = process.env.Path;
    process.env.Path = 'C:\\tools';
    try {
      runInTenant(ada, () => {
        const base = childBaseEnv();
        // On Linux `Path` and `PATH` are two names and the one spelled `Path` must come through on its own merits. On Windows the
        // assignment writes through to whichever spelling the runner already has, so the value is looked up case-insensitively there.
        const got = process.platform === 'win32'
          ? Object.entries(base).find(([k]) => k.toUpperCase() === 'PATH')?.[1]
          : base.Path;
        expect(got).toBe('C:\\tools');
      });
    } finally {
      if (had) process.env.Path = before; else delete process.env.Path;
    }
  });

  it('withRunEnv applies overrides to a copy and never touches the base or process.env', () => {
    const before = JSON.stringify(Object.entries(process.env).sort());
    runInTenant(ada, () => {
      const env = withRunEnv({ ANTHROPIC_API_KEY: undefined, EXTRA: 'x' })!;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.EXTRA).toBe('x');
      expect(childBaseEnv().ANTHROPIC_API_KEY).toBe('T-anthropic');
      expect(withRunEnv(undefined)).toBeUndefined();
    });
    expect(JSON.stringify(Object.entries(process.env).sort())).toBe(before);
  });

  it('outside any tenant, with tenancy on, it throws instead of answering with the process env', () => {
    expect(() => childBaseEnv()).toThrow(/outside a tenant context/);
  });

  it('spawnWrapper is the identity seam', () => {
    const spec = { command: 'x', args: ['y'] };
    expect(spawnWrapper(ada, spec)).toBe(spec);
  });
});

describe('child env with tenancy off', () => {
  it('childBaseEnv() is process.env itself, and the builders see the process keys as before', () => {
    enableTenancy(false);
    try {
      expect(childBaseEnv()).toBe(process.env);
      expect(childEnv(childBaseEnv()).ANTHROPIC_API_KEY).toBe('P-anthropic');
      expect(childEnv(childBaseEnv()).MIND_API_KEY).toBeUndefined();
      expect(codexChildEnv().OPENAI_API_KEY).toBe('P-openai');
      expect(withRunEnv({})).toEqual({ ...process.env });
    } finally { enableTenancy(true); }
  });
});
