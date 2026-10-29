// An install with no `tenants.auth` key becomes household on upgrade. One that looks per-tenant (hosts, tenant passwords, a default) must say which it wants:
// boot refuses and the wizard refuses, naming the key and both values. One with none of those signs stays household (the one-person default).
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import { join, resolve } from 'node:path';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig } from './context.js';
import { closeHouse, householdMode } from './house.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { authKeyMissingProblem } from '../../../../scripts/setup-inherit.mjs';

afterEach(async () => {
  await stopBootedTenants();
  closeHouse(); enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null);
  vi.restoreAllMocks();
});

function boot(tenants: Record<string, { yaml?: string; env?: string }>, block: Record<string, unknown>) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const root = makeTenantsDir(tenants);
  const base = makeTenantsDir({});
  const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { server: { db_path: resolve(base, 'p', 'data', 'sanctum.db') } });
  (proc as unknown as { tenants: unknown }).tenants = { dir: root, ...block };
  registerProcessConfig(() => proc);
  // (safeTenancyProcess pins per-tenant for the existing suite; this is the install that never wrote the key)
  const run = () => { safeTenancyProcess(proc); delete (proc as unknown as { tenants: Record<string, unknown> }).tenants.auth; if (block.auth) (proc as unknown as { tenants: Record<string, unknown> }).tenants.auth = block.auth; return bootTenants(express(), proc); };
  return { root, run };
}

const posix = process.platform !== 'win32';
const children: ChildProcess[] = [];
afterEach(() => { for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

describe('tenants.auth absent', () => {
  it.each([
    ['hosts in a tenant.yaml', { ada: { yaml: 'hosts: [ada.example.net]\n' } }, {}],
    ['APP_PASSWORD in a tenant .env', { ada: { env: 'APP_PASSWORD=own-password\n' } }, {}],
    ['tenants.default', { ada: {} }, { default: 'ada' }],
  ])('boot refuses on %s, naming tenants.auth and both values', (_what, tenants, block) => {
    const { root, run } = boot(tenants, block);
    expect(() => run()).toThrow(/tenants\.auth is not set.*per-tenant.*household/s);
    expect(householdMode()).toBe(false);
    expect(authKeyMissingProblem(root, block)).toMatch(/tenants\.auth/);
  });

  it('stays household with none of those signs', async () => {
    const { run } = boot({ ada: { yaml: 'identity:\n  companion_name: Ada\n' }, bea: {} }, {});
    const runtimes = run();
    expect(runtimes.size).toBe(2);
    expect(householdMode()).toBe(true);
  });

  it('says nothing when the key is set, whatever the signs', () => {
    const { root } = boot({ ada: { yaml: 'hosts: [ada.example.net]\n', env: 'APP_PASSWORD=x\n' } }, { default: 'ada', auth: 'per-tenant' });
    expect(authKeyMissingProblem(root, { auth: 'per-tenant', default: 'ada' })).toBe('');
    expect(authKeyMissingProblem(root, { auth: 'household', default: 'ada' })).toBe('');
  });

  // The check reads each tenant's .env and tenant.yaml through the guarded open: one tenant's folder never holds the boot, and a file that is not the
  // tenant's own is "no sign" here (the own-files scan refuses that tenant on its own later).
  it.runIf(posix)('a pipe at a tenant .env or tenant.yaml (a writer attached) is no sign and does not block', () => {
    const { root } = boot({ ada: {}, bea: {} }, {});
    for (const [id, file, payload] of [['ada', '.env', 'APP_PASSWORD=evil\n'], ['bea', 'tenant.yaml', 'hosts: [evil.example.net]\n']] as const) {
      const at = join(root, id, file);
      rmSync(at, { force: true });
      execFileSync('mkfifo', [at]);
      children.push(spawn('sh', ['-c', 'printf "%s" "$0" > "$1"', payload, at], { stdio: 'ignore' }));
    }
    expect(authKeyMissingProblem(root, {})).toBe('');
  });
  it('a tenant .env that is a link to an outside file holding APP_PASSWORD is no sign', () => {
    const { root } = boot({ ada: {} }, {});
    const outside = join(root, '..', 'outside.env');
    writeFileSync(outside, 'APP_PASSWORD=operator\n');
    rmSync(join(root, 'ada', '.env'), { force: true });
    try { symlinkSync(outside, join(root, 'ada', '.env'), 'file'); } catch { return; } // (links need privileges on some platforms)
    expect(authKeyMissingProblem(root, {})).toBe('');
  });
});
