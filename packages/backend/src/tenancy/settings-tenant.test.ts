// The settings service per tenant: each tenant resolves against its own tenant.yaml (with what it inherits), its own .env and its own database.
// The process environment is never an input (tenancy/child.ts rule), outside a tenant the service refuses, and secrets stay markers.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { bootTenants, stopTenantServices } from './boot.js';
import { enableTenancy, runInTenant, NoTenantContext, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { setConfig } from '../services/db.js';
import { saveBotToken, getBotToken } from '../services/bot-token.js';
import { resolveSetting, resolveSecret } from '../services/settings/index.js';

let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;

beforeAll(() => {
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  vi.stubEnv('AGENT_MODEL', 'process-model');
  vi.stubEnv('DISCORD_ENABLED', 'true');
  vi.stubEnv('MIND_API_KEY', 'PROCESS-MIND-KEY');
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { orchestrator: { enabled: false } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
    ada: { yaml: 'hosts: [ada.example.net]\nagent:\n  model: ada-yaml-model\nhandoff:\n  enabled: true\n', env: 'APP_PASSWORD=pw-ada\nAGENT_PROVIDER=codex\nDISCORD_BOT_TOKEN=ada-env-token\n' },
    bea: { yaml: 'hosts: [bea.example.net]\n', env: 'APP_PASSWORD=pw-bea\nAGENT_MODEL=bea-env-model\n' },
  }) };
  runtimes = bootTenants(express(), safeTenancyProcess(proc));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
});
afterAll(async () => {
  await stopBootedTenants();
  stopTenantServices(runtimes.values());
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('settings service in tenant mode', () => {
  it('never reads the process environment: the operator\'s AGENT_MODEL, DISCORD_ENABLED and MIND_API_KEY are not a tenant\'s', () => {
    runInTenant(ada, () => {
      expect(resolveSetting('agent.model')).toMatchObject({ value: 'ada-yaml-model', source: 'yaml' });
      expect(resolveSetting('discord.enabled')).toMatchObject({ value: false, source: 'default' });
      expect(resolveSecret('mind.api_key')).toBeNull();
    });
    runInTenant(bea, () => {
      expect(resolveSetting('agent.model')).toMatchObject({ value: 'bea-env-model', source: 'env' }); // bea's own .env
    });
  });

  it('each layer is the tenant\'s own: tenant.yaml, the tenant .env, the tenant database', () => {
    runInTenant(ada, () => {
      expect(resolveSetting('handoff.enabled')).toMatchObject({ value: true, source: 'yaml' });
      expect(resolveSetting('agent.provider')).toMatchObject({ value: 'codex', source: 'env' });
      setConfig('handoff.enabled', 'false');
      expect(resolveSetting('handoff.enabled')).toMatchObject({ value: false, source: 'db' });
    });
    runInTenant(bea, () => {
      expect(resolveSetting('handoff.enabled')).toMatchObject({ value: false, source: 'default' }); // ada's row is ada's
      expect(resolveSetting('agent.provider').source).not.toBe('env');
    });
  });

  it('bot tokens: the tenant\'s stored row beats its .env, and a secret is only a marker', () => {
    runInTenant(ada, () => {
      expect(getBotToken('discord')).toBe('ada-env-token');
      saveBotToken('discord', 'ada-db-token');
      expect(getBotToken('discord')).toBe('ada-db-token');
      const r = resolveSetting('discord.bot_token');
      expect(r.value).toEqual({ set: true, source: 'db' });
      expect(JSON.stringify(r)).not.toMatch(/ada-(db|env)-token/);
    });
    runInTenant(bea, () => expect(getBotToken('discord')).toBeNull());
  });

  it('the login password is a marker with the tenant\'s source, never the value', () => {
    runInTenant(ada, () => {
      const r = resolveSetting('auth.password');
      expect(r.value).toMatchObject({ set: true });
      expect(JSON.stringify(r)).not.toContain('pw-ada');
    });
  });

  it('outside any tenant, with tenancy on, it refuses', () => {
    expect(() => resolveSetting('agent.model')).toThrow(NoTenantContext);
  });
});
