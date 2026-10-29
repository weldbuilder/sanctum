// Caches that feed a prompt must not cross tenants (stage 2b). Seed A's cache by reading A's home, then read under B: B gets its own
// (here: nothing, then its own files), never A's. Tenancy off: still one shared cache, as before.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { buildCommandRegistry } from '../services/commands.js';
import { scanSkills } from '../services/hooks.js';

let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;
const custom = () => buildCommandRegistry().filter((c) => /^(ada|bea)-cmd$/.test(c.name)).map((c) => c.name).sort();
const skills = () => scanSkills().map((s) => s.name).sort();

function seed(rt: TenantRuntime, id: string): void {
  const cmds = join(rt.homeDir, '.claude', 'commands');
  mkdirSync(cmds, { recursive: true });
  writeFileSync(join(cmds, `${id}-cmd.md`), `---\nname: ${id}-cmd\ndescription: ${id} only\n---\nbody\n`);
  const sk = join(rt.homeDir, '.claude', 'skills', `${id}-skill`);
  mkdirSync(sk, { recursive: true });
  writeFileSync(join(sk, 'SKILL.md'), `---\nname: ${id}-skill\ndescription: ${id} only\n---\nbody\n`);
}

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: 'hosts: [bea.example.net]\n' } }) };
  runtimes = bootTenants(express(), safeTenancyProcess(cfg));
  ada = runtimes.get('ada')!;
  bea = runtimes.get('bea')!;
});
afterAll(async () => {
  await stopBootedTenants();
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks();
});

describe('prompt caches per tenant', () => {
  it('A\'s commands and skills, once cached, are not B\'s; B gets its own after it has them', () => {
    seed(ada, 'ada');
    expect(runInTenant(ada, custom)).toEqual(['ada-cmd']);
    expect(runInTenant(ada, skills)).toEqual(['ada-skill']);
    // B has nothing yet, and A's cached lists (still inside their 60 s window) are not served to it.
    expect(runInTenant(bea, custom)).toEqual([]);
    expect(runInTenant(bea, skills)).toEqual([]);
    seed(bea, 'bea');
    // B's empty scan did not cache (a failed scan returns without storing), so it now sees its own, and only its own.
    expect(runInTenant(bea, custom)).toEqual(['bea-cmd']);
    expect(runInTenant(bea, skills)).toEqual(['bea-skill']);
    // A is unchanged and cached.
    expect(runInTenant(ada, custom)).toEqual(['ada-cmd']);
    expect(runInTenant(ada, skills)).toEqual(['ada-skill']);
  });

  it('outside any tenant, with tenancy on, a cache read throws rather than answering from some tenant\'s', () => {
    expect(() => skills()).toThrow(/outside a tenant context/);
  });
});
