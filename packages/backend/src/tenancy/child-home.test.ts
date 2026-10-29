// D7: in tenant mode a harness child gets a HOME and TMPDIR of its own under <tenant>/data/harness/, never the process's, and the sandbox temp
// root in the union/clash checks is the tenant's TMPDIR rather than /tmp. Tenancy off: childBaseEnv() is process.env itself.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, runInTenant, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { childBaseEnv, childRunBase, withRunEnv } from './child.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { realDeep } from '../services/plugin-paths.js';
import { writableRoots } from '../services/plugins.js';
import { buildExecArgs } from '../services/providers/codex-exec.js';

const saved: Record<string, string | undefined> = {};
const PROCESS = { HOME: resolve(tmpdir(), 'operator-home'), USERPROFILE: resolve(tmpdir(), 'operator-home'), TMPDIR: resolve(tmpdir(), 'operator-tmp'), TMP: resolve(tmpdir(), 'operator-tmp'), TEMP: resolve(tmpdir(), 'operator-tmp') };
let runtimes: Map<string, TenantRuntime>;
let ada: TenantRuntime;
let bea: TenantRuntime;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn');
  // tenants.dir sits under the system temp folder (the layout the 3b verifier found skipped every tenant when a tenant used Codex or dsh)
  const dir = makeTenantsDir({
    ada: { yaml: 'hosts: [ada.example.net]\n', env: 'AGENT_PROVIDER=codex\nHOME=/somewhere/else\nTMPDIR=/somewhere/else\n' },
    bea: { yaml: 'hosts: [bea.example.net]\n' },
  });
  for (const k of Object.keys(PROCESS)) saved[k] = process.env[k];
  Object.assign(process.env, PROCESS);
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  (cfg as unknown as { tenants: unknown }).tenants = { dir };
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

const inside = (root: string, p: string) => { const r = relative(realDeep(root).toLowerCase(), realDeep(p).toLowerCase()); return !r.startsWith('..') && !isAbsolute(r) && r !== ''; };
const lower = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));

describe('per-tenant HOME and TMPDIR', () => {
  it('both tenants boot with tenants.dir under the system temp folder (one Codex, one Claude)', () => {
    expect([...runtimes.keys()].sort()).toEqual(['ada', 'bea']);
  });

  it('the child env has HOME and TMPDIR/TMP/TEMP inside <tenant>/data/harness, owner-only, and the process values never appear', () => {
    for (const rt of [ada, bea]) {
      runInTenant(rt, () => {
        const env = lower(childBaseEnv());
        for (const name of ['HOME', 'TMPDIR', 'TMP', 'TEMP']) expect(inside(join(rt.dataDir, 'harness'), env[name]!)).toBe(true);
        expect(env.HOME).toBe(join(rt.dataDir, 'harness', 'home'));
        expect(env.TMPDIR).toBe(join(rt.dataDir, 'harness', 'tmp'));
        for (const name of ['HOME', 'TMPDIR']) {
          expect(statSync(env[name]!).isDirectory()).toBe(true);
          if (process.platform !== 'win32') expect(statSync(env[name]!).mode & 0o077).toBe(0);
        }
        if (process.platform === 'win32') expect(env.USERPROFILE).toBe(env.HOME);
        const values = Object.values(env);
        for (const p of Object.values(PROCESS)) expect(values).not.toContain(p);
        expect(values).not.toContain('/somewhere/else'); // nor a HOME the tenant's own .env names
      });
    }
    expect(runInTenant(ada, () => childBaseEnv().HOME)).not.toBe(runInTenant(bea, () => childBaseEnv().HOME));
  });

  it('a run env and the run base carry the tenant HOME too, and an override still wins', () => {
    runInTenant(ada, () => {
      expect(lower(childRunBase()).HOME).toBe(join(ada.dataDir, 'harness', 'home'));
      expect(lower(withRunEnv({ FOO: 'x' })!).HOME).toBe(join(ada.dataDir, 'harness', 'home'));
      expect(withRunEnv({ FOO: 'x' })!.FOO).toBe('x');
    });
  });

  it('Codex: the sandbox temp root is the tenant TMPDIR only: no /tmp, no process temp folder, no process TMPDIR', () => {
    const paths = runInTenant(ada, () => writableRoots(ada.config)).map((r) => r.path);
    expect(paths).toContain(join(ada.dataDir, 'harness', 'tmp'));
    for (const bad of ['/tmp', tmpdir(), PROCESS.TMPDIR]) expect(paths).not.toContain(bad);
  });

  it('dsh keeps /tmp and the process temp folders beside the tenant TMPDIR (no verified flag removes them from its sandbox), so the clash checks count them', () => {
    const roots = runInTenant(bea, () => writableRoots({ agent: { provider: 'dsh' } }, { tmpRoot: join(bea.dataDir, 'harness', 'tmp') }));
    const paths = roots.map((r) => r.path);
    expect(paths).toContain(join(bea.dataDir, 'harness', 'tmp'));
    if (process.platform !== 'win32') expect(paths).toContain('/tmp');
    expect(paths).toContain(tmpdir());
    expect(paths).toContain(PROCESS.TMPDIR);
  });

  it('a dsh tenant under a tenants.dir inside the system temp folder is refused at boot with the clear line; a Codex tenant there still boots', () => {
    if (process.platform === 'win32') return; // (no /tmp root there; the temp folder rule is the same but the paths differ)
    const warns: string[] = [];
    const savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }; for (const k of Object.keys(savedTmp)) delete process.env[k]; // (so the temp folder is the real /tmp for this test)
    const w = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    try {
      const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
      (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({ dee: { yaml: 'hosts: [dee.example.net]\n', env: 'AGENT_PROVIDER=dsh\n' } }) };
      expect(() => bootTenants(express(), safeTenancyProcess(cfg))).toThrow(/no tenant in .* could be started/);
      expect(warns.some((l) => l.includes('tenant dee skipped') && l.includes("dsh sandbox's /tmp") && !l.includes('\n'))).toBe(true);
    } finally { w.mockRestore(); for (const [k, v] of Object.entries(savedTmp)) if (v !== undefined) process.env[k] = v; enableTenancy(true); }
  });

  it('Codex is told to leave /tmp out in tenant mode, and not otherwise', () => {
    const args = (): string => buildExecArgs({ sandboxMode: 'workspace-write', cwd: '/x', networkAccess: false }).join(' ');
    expect(args()).toContain('sandbox_workspace_write.exclude_slash_tmp=true');
    enableTenancy(false);
    try { expect(args()).not.toContain('exclude_slash_tmp'); } finally { enableTenancy(true); }
  });
});

describe('tenancy off', () => {
  it('childBaseEnv() is process.env itself and writableRoots keeps /tmp for Codex', () => {
    enableTenancy(false);
    try {
      expect(childBaseEnv()).toBe(process.env);
      expect(childRunBase()).toBe(process.env);
      const cfg = { agent: { provider: 'codex', cwd: join(tmpdir(), 'x') } };
      const prev = process.env.AGENT_PROVIDER; delete process.env.AGENT_PROVIDER;
      try { expect(writableRoots(cfg).map((r) => r.path)).toContain(tmpdir()); } finally { if (prev !== undefined) process.env.AGENT_PROVIDER = prev; }
    } finally { enableTenancy(true); }
  });
});
