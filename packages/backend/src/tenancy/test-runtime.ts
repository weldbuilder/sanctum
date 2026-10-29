// A TenantRuntime for tests that need the shape and nothing behind it. Real ones come from createTenantRuntime.
import type { TenantRuntime } from './context.js';

export function fakeRuntime(id: string, over: Partial<TenantRuntime> = {}): TenantRuntime {
  return {
    id, dir: `/t/${id}`, dataDir: `/t/${id}/data`, homeDir: `/t/${id}/home`, privateDir: `/t/${id}/private`,
    hosts: [`${id}.example.net`], config: { marker: id } as never, env: {}, db: { marker: id } as never,
    token: `token-${id}`, locals: new Map(), services: {}, reload: () => {}, setPassword: () => {}, ...over,
  };
}

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { applyEnvOverrides, mergeConfigDefaults, resolveConfigPaths, type SanctumConfig } from '../config.js';

/** A process config the way loadConfig would build it, from `yamlObj`, without reading sanctum.yaml or process.env. */
export function processConfigFor(base: string, yamlObj: Record<string, unknown> = {}, env: Record<string, string> = {}): SanctumConfig {
  const merged = mergeConfigDefaults(yamlObj);
  applyEnvOverrides(merged, env);
  resolveConfigPaths(merged, base, yamlObj, env);
  return merged;
}

/** A binary that does not exist: where a tenant's dsh harness points in a test (on win32 `/bin/false` is not a thing either, and nothing may run). */
export const NO_HARNESS = process.platform === 'win32' ? 'C:\\sanctum-test-no-such-binary.exe' : '/bin/false';

/** The text of a tenant.yaml for a tenancy test: `extra` (yaml text, may be empty) plus `agent.dsh.command` pointing at nothing. Tenants do not inherit the process's
 *  dsh binary, so a tenant file the test writes must say it itself (unless `extra` already names `agent.dsh.command`). Every tenant.yaml a booting test writes goes
 *  through this (test-runtime.test.ts checks). */
export function safeTenantYaml(extra: string = ''): string {
  let doc: Record<string, unknown> | null;
  try { doc = (extra.trim() ? yaml.load(extra) : {}) as Record<string, unknown> | null; } catch { return extra; } // (a test of a broken file keeps it broken)
  if (doc !== null && doc !== undefined && (typeof doc !== 'object' || Array.isArray(doc))) return extra; // (not a mapping: a test of a bad file keeps it bad)
  const out: Record<string, unknown> = doc ? { ...doc } : {};
  if (out.agent !== undefined && out.agent !== null && (typeof out.agent !== 'object' || Array.isArray(out.agent))) return extra; // (a bad `agent:` stays bad)
  const agent = out.agent ? { ...(out.agent as Record<string, unknown>) } : {};
  const dsh = agent.dsh && typeof agent.dsh === 'object' && !Array.isArray(agent.dsh) ? { ...(agent.dsh as Record<string, unknown>) } : {};
  if (dsh.command === undefined) dsh.command = NO_HARNESS;
  agent.dsh = dsh;
  out.agent = agent;
  return yaml.dump(out);
}

/** A tenants folder in a temp dir with one folder per entry: `yamlText` is its tenant.yaml, `envText` its .env. */
export function makeTenantsDir(tenants: Record<string, { yaml?: string; env?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'sanctum-tenants-'));
  for (const [id, files] of Object.entries(tenants)) {
    mkdirSync(join(root, id), { recursive: true });
    if (files.yaml !== undefined) writeFileSync(join(root, id, 'tenant.yaml'), safeTenantYaml(files.yaml));
    if (files.env !== undefined) writeFileSync(join(root, id, '.env'), files.env);
  }
  return root;
}

/** The channel bot tokens a tenancy test must never boot with (a bot token in the environment would start a real channel client). */
const CHANNEL_TOKEN_ENV = ['DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'] as const;

/** The process-config fragment EVERY tenancy test boots with (the standing rule: booting `bootTenants` in a scratch tree counts as a scratch server). Applied in
 *  place to `cfg` and returned: orchestrator off, `tenants.background_runs: false`, handoff off, the dsh harness binary `/bin/false`, and no channel bot tokens
 *  in the environment. `{ fakeProvider: true }` keeps the orchestrator and background runs as the test set them: ONLY for a test file that replaces the provider
 *  with a fake (`vi.mock`), which `test-runtime.test.ts` checks. (The claude and codex harnesses have no binary setting; tenants do not inherit one; with
 *  background runs off and no orchestrator nothing starts a model run.) */
export function safeTenancyProcess<T extends object>(cfg: T, opts: { fakeProvider?: boolean } = {}): T {
  const c = cfg as unknown as Record<string, Record<string, unknown> | undefined>;
  c.tenants = { auth: 'per-tenant', ...(c.tenants ?? {}) }; // (the existing suite keeps hostname semantics; a test that says `auth: 'household'` keeps it)
  for (const k of CHANNEL_TOKEN_ENV) delete process.env[k];
  if (c.agent) c.agent.dsh = { ...((c.agent.dsh as object | undefined) ?? {}), command: NO_HARNESS };
  if (!opts.fakeProvider) {
    if (c.handoff) c.handoff.enabled = false;
    if (c.orchestrator) c.orchestrator.enabled = false;
    c.tenants = { ...(c.tenants ?? {}), background_runs: false };
  }
  return cfg;
}

/** The teardown every tenancy test that boots calls FIRST in its afterAll (before it closes the databases and turns tenancy off): stops every booted
 *  tenant's scheduler, watchdog, pollers and channels. Pass the runtimes, or nothing for the tenants booted now. */
export async function stopBootedTenants(runtimes?: Iterable<TenantRuntime>): Promise<void> {
  const { bootedTenants } = await import('./context.js');
  const { stopTenantServices } = await import('./boot.js');
  await stopTenantServices(runtimes ?? bootedTenants());
}
