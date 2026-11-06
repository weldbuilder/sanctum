// The auth choice and every child's environment (stage 2b pass 2).
// Tenancy OFF: identical to main. applyAuthToEnv wrote process.env there, so every later child (Codex, dsh, the rolling summarizer)
// inherited it; the expectation is main's own output (__fixtures__/env-main.json, captured with the verifier's envdiff script on main).
// Tenant mode: process.env is never written, every child gets the tenant's base with the tenant's auth choice applied, and no process
// credential (key, OAuth token, config dir, token, password) reaches any of them, the rolling summarizer included (it is not mocked here).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const captured: { env?: Record<string, string | undefined> }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (p: { options?: { env?: Record<string, string | undefined> } }) => { captured.push({ env: p.options?.env }); return (async function* () { /* no messages */ })(); },
  AbortError: class extends Error {},
  listSessions: async () => [],
}));

import { loadConfig } from '../config.js';
import { initDb, getDb } from '../services/db.js';
import { applyAuthToEnv, updateAuthPreferences } from '../services/auth-preferences.js';
import { childEnv } from '../services/providers/child-env.js';
import { codexChildEnv } from '../services/providers/codex-exec.js';
import { buildExecEnv } from '../services/providers/dsh-exec.js';
import { runClaudeSummary } from '../services/summarizer/claude.js';
import { childRunBase, withRunEnv } from './child.js';
import { bootTenants } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { realDeep } from '../services/plugin-paths.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';

const KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MIND_API_KEY', 'CODEX_API_KEY'];
const pick = (e: Record<string, unknown>) => Object.fromEntries(KEYS.map((k) => [k, e[k] ?? null]));
const dshParams = { sandboxMode: 'workspace-write', cwd: '/tmp', apiKeyEnv: 'ANTHROPIC_API_KEY' } as never;
const PROCESS = { ANTHROPIC_API_KEY: 'P-anthropic', CLAUDE_CODE_OAUTH_TOKEN: 'P-oauth', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', OPENAI_API_KEY: 'P-openai', DEEPSEEK_API_KEY: 'P-deepseek', MIND_API_KEY: 'P-mind' };
const saved = new Map<string, string | undefined>();
const setProcessEnv = (extra: Record<string, string>) => {
  for (const k of [...Object.keys(PROCESS), ...Object.keys(extra)]) if (!saved.has(k)) saved.set(k, process.env[k]);
  Object.assign(process.env, PROCESS, extra);
};
const restoreProcessEnv = () => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } saved.clear(); };

async function summarizerEnv(): Promise<Record<string, string | undefined>> {
  captured.length = 0;
  await runClaudeSummary({ system: '', user: 'x', cwd: tmpdir(), model: 'm', signal: new AbortController().signal });
  return captured[0].env!;
}

describe('tenancy off: the child envs equal main\'s', () => {
  const golden = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'env-main.json'), 'utf8'));
  beforeAll(() => {
    enableTenancy(false);
    setProcessEnv({});
    const log = console.log; console.log = () => {};
    try { loadConfig(join(tmpdir(), 'sanctum-nonexistent.yaml')); } finally { console.log = log; }
    initDb(':memory:');
  });
  afterAll(restoreProcessEnv);

  it('subscription then api_key: process.env, the Claude turn, Codex, dsh and the rolling summarizer', async () => {
    const out: Record<string, unknown> = {};
    for (const mode of ['subscription', 'api_key'] as const) {
      if (mode === 'api_key') updateAuthPreferences({ auth_mode: 'api_key', api_key: 'sk-ant-PREF' });
      const r = applyAuthToEnv();
      const runEnv = withRunEnv(r);
      out[mode] = {
        processEnvAfter: pick(process.env as never),
        claudeTurn: pick(childEnv(runEnv ?? process.env)),
        codexChild: pick(codexChildEnv()),
        dshChildAnthropicRoute: pick(buildExecEnv(dshParams, childRunBase())),
        rollingSummarizer: pick(await summarizerEnv()),
      };
    }
    expect(out).toEqual(golden);
  });

  it('the wizard\'s process.env key is undone by the next subscription run, as on main', () => {
    getDb().prepare('DELETE FROM auth_preferences').run();
    updateAuthPreferences({ auth_mode: 'subscription' });
    process.env.ANTHROPIC_API_KEY = 'wizard-key';
    applyAuthToEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('tenant mode: no process credential in any child, process.env never written', () => {
  let runtimes: Map<string, TenantRuntime>;
  let ada: TenantRuntime;
  const EXTRA = { GITHUB_TOKEN: 'P-github', GROQ_API_KEY: 'P-groq', APP_PASSWORD: 'P-pass' };
  const AFTER_BOOT = { INTERNAL_TOKEN: 'P-internal', CLAUDE_CONFIG_DIR: '/p/claude', CODEX_HOME: '/p/codex', DSH_HOME: '/p/dsh' };
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setProcessEnv(EXTRA);
    const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n', env: 'OPENAI_API_KEY=T-openai\n' } }) };
    runtimes = bootTenants(express(), safeTenancyProcess(cfg));
    ada = runtimes.get('ada')!;
    for (const k of Object.keys(AFTER_BOOT)) saved.set(k, process.env[k]);
    Object.assign(process.env, AFTER_BOOT);
  });
  afterAll(async () => {
  await stopBootedTenants();
    for (const rt of runtimes.values()) rt.db.close();
    enableTenancy(false); setTenantRegistry(new Map()); restoreProcessEnv(); vi.restoreAllMocks();
  });

  it('subscription then api_key: every child is the tenant\'s, none carries a process value', async () => {
    const before = JSON.stringify(Object.entries(process.env).sort());
    const forbidden = [...Object.values(PROCESS), ...Object.values(EXTRA), ...Object.values(AFTER_BOOT)].filter((v) => v !== '1');
    for (const mode of ['subscription', 'api_key'] as const) {
      await runInTenant(ada, async () => {
        if (mode === 'api_key') updateAuthPreferences({ auth_mode: 'api_key', api_key: 'K-ada' });
        const envs = {
          claudeTurn: childEnv(withRunEnv(applyAuthToEnv())!),
          codex: codexChildEnv(),
          dsh: buildExecEnv(dshParams, childRunBase()),
          summarizer: await summarizerEnv(),
        };
        for (const [name, env] of Object.entries(envs)) {
          for (const v of Object.values(env)) expect(forbidden, `${name} carries a process value`).not.toContain(v);
          expect(Object.keys(env).map((k) => k.toUpperCase()), name).not.toContain('APP_PASSWORD');
          expect(env.CLAUDE_CODE_OAUTH_TOKEN, name).toBeUndefined();
        }
        // The summarizer is the tenant's: its token, its harness homes, its saved key (api_key) or none (subscription).
        const s = envs.summarizer;
        expect(s.INTERNAL_TOKEN).toBe(ada.token);
        for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME']) {
          const rel = relative(realDeep(join(ada.dataDir, 'harness')).toLowerCase(), realDeep(s[name]!).toLowerCase());
          expect(!rel.startsWith('..') && !isAbsolute(rel) && rel !== '', name).toBe(true);
        }
        expect(s.ANTHROPIC_API_KEY).toBe(mode === 'api_key' ? 'K-ada' : undefined);
        expect(s.OPENAI_API_KEY).toBe('T-openai');
        expect(s.GITHUB_TOKEN).toBeUndefined();
        expect(s.GROQ_API_KEY).toBeUndefined();
      });
    }
    expect(JSON.stringify(Object.entries(process.env).sort())).toBe(before);
  });
});
