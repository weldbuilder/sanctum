// The writable-root checks take the union of every tenant's roots, and boot refuses a layout where one tenant's roots touch another's files.
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import { resolve, join } from 'node:path';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy, runInTenant } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { layoutClash } from './layout.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { allWritableRoots, ledgerClash, personRoot, writableClash, writableRoots, setShippedRootForTests, shippedRoot } from '../services/plugins.js';

const proc = () => processConfigFor(resolve(tmpdir(), 'sanctum-process'));
function boot(tenants: Record<string, { yaml?: string; env?: string }>) {
  const cfg = proc();
  const root = makeTenantsDir(tenants);
  (cfg as unknown as { tenants: unknown }).tenants = { dir: root };
  const runtimes = bootTenants(express(), safeTenancyProcess(cfg));
  return { cfg, root, runtimes };
}
const two = () => boot({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: 'hosts: [bea.example.net]\n' } });

afterEach(async () => { await stopBootedTenants(); 
  enableTenancy(false);
  setTenantRegistry(new Map());
  vi.restoreAllMocks();
});

describe('the union of writable roots', () => {
  it('tenancy off: allWritableRoots(cfg) deep-equals writableRoots(cfg)', () => {
    const cfg = proc();
    expect(allWritableRoots(cfg)).toEqual(writableRoots(cfg));
    expect(allWritableRoots(cfg, { pluginsDir: true })).toEqual(writableRoots(cfg, { pluginsDir: true }));
  });

  it("tenant mode: a path inside the OTHER tenant's home is a clash for this tenant's check, and not without the union", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtimes } = two();
    const ada = runtimes.get('ada')!;
    const bea = runtimes.get('bea')!;
    const insideAda = join(ada.homeDir, 'somewhere');
    expect(runInTenant(bea, () => writableRoots(bea.config)).some((r) => r.path === ada.homeDir)).toBe(false); // bea alone does not know ada's home
    expect(runInTenant(bea, () => writableClash(insideAda, bea.config))).not.toBeNull();
    expect(runInTenant(bea, () => allWritableRoots(bea.config).some((r) => r.path === ada.homeDir))).toBe(true);
    // A ledger folder of bea's inside ada's home is refused too.
    expect(runInTenant(bea, () => ledgerClash(bea.config, join(insideAda, 'ledger.json')))).not.toBeNull();
    expect(runInTenant(bea, () => ledgerClash(bea.config))).toBeNull();
  });

  it("B's private_dir inside A's home: refused at boot, and by the clash check", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtimes } = two();
    const ada = runtimes.get('ada')!;
    const bea = runtimes.get('bea')!;
    expect(runInTenant(bea, () => writableClash(join(ada.homeDir, 'private'), bea.config))).not.toBeNull();
    enableTenancy(false);
    const second = boot({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: `hosts: [bea.example.net]\ndiscord:\n  private_dir: ${JSON.stringify(join(ada.homeDir, 'private'))}\n` } });
    expect([...second.runtimes.keys()]).toEqual(['ada']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('tenant bea skipped'))).toBe(true);
  });

  it("a plugins.dir inside another tenant's home is refused (person trust), and at boot", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtimes } = two();
    const ada = runtimes.get('ada')!;
    const bea = runtimes.get('bea')!;
    const cfg = { ...bea.config, plugins: { ...bea.config.plugins, trust: 'person', dir: join(ada.homeDir, 'plugins') } };
    expect(runInTenant(bea, () => personRoot(cfg))).toBe('');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('plugins.dir') && String(c[0]).includes('refused'))).toBe(true);
    enableTenancy(false);
    const second = boot({ ada: { yaml: 'hosts: [ada.example.net]\n' }, bea: { yaml: `hosts: [bea.example.net]\nplugins:\n  dir: ${JSON.stringify(join(ada.homeDir, 'plugins'))}\n` } });
    expect([...second.runtimes.keys()]).toEqual(['ada']);
  });

  it("a skipped tenant's declared home is still off limits to the others", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtimes, root } = boot({
      ada: { yaml: 'hosts: [ada.example.net]\n' },
      bea: { yaml: 'hosts: [bea.example.net]\nidentity:\n  timezone: Mars/Olympus_Mons\n' }, // refused: not the process clock
    });
    expect([...runtimes.keys()]).toEqual(['ada']);
    const ada = runtimes.get('ada')!;
    expect(runInTenant(ada, () => writableClash(join(root, 'bea', 'home', 'x'), ada.config))).not.toBeNull();
  });
});

describe('layoutClash', () => {
  it("catches a home that contains another tenant's data/, and names the tenant that fails", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { cfg, runtimes } = two();
    const ada = runtimes.get('ada')!;
    const bea = runtimes.get('bea')!;
    expect(layoutClash([ada, bea], cfg).size).toBe(0);
    bea.config.agent.cwd = ada.dir; // contains ada's data/, private/, .env and tenant.yaml
    const found = layoutClash([ada, bea], cfg);
    expect([...found.keys()]).toEqual(['bea']);
    expect(found.get('bea')).toContain("tenant ada's");
  });

  it("catches a root inside another tenant's data/", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { cfg, runtimes } = two();
    const ada = runtimes.get('ada')!;
    const bea = runtimes.get('bea')!;
    bea.config.hooks.extra_write_paths = [join(ada.dataDir, 'identity')];
    expect([...layoutClash([ada, bea], cfg).keys()]).toEqual(['bea']);
  });

  it("catches a root that contains the process's own data folder", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { cfg, runtimes } = two();
    const ada = runtimes.get('ada')!;
    ada.config.agent.cwd = resolve(tmpdir());
    const found = layoutClash([ada, runtimes.get('bea')!], cfg);
    expect(found.get('ada')).toBeDefined();
  });

  it('catches a root that contains the shipped plugin root, and the shipped scan refuses it too in tenant mode whatever the trust', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shipped = mkdtempSync(join(tmpdir(), 'sanctum-shipped-'));
    setShippedRootForTests(join(shipped, 'plugins'));
    try {
      const { cfg, runtimes } = two();
      const ada = runtimes.get('ada')!;
      const bea = runtimes.get('bea')!;
      expect(layoutClash([ada, bea], cfg).size).toBe(0);
      ada.config.agent.cwd = shipped; // contains <shipped>/plugins
      const found = layoutClash([ada, bea], cfg);
      expect(found.get('ada')).toContain('the shipped plugin root');
      expect(found.has('bea')).toBe(false);
      // Companion trust is the default; in tenant mode the shipped root is still held to the union of writable roots.
      expect(ada.config.plugins.trust ?? 'companion').toBe('companion');
      expect(runInTenant(ada, () => shippedRoot(ada.config))).toBe('');
      expect(runInTenant(bea, () => shippedRoot(bea.config))).toBe('');
      ada.config.agent.cwd = join(ada.dir, 'home');
      expect(runInTenant(bea, () => shippedRoot(bea.config))).toBe(join(shipped, 'plugins'));
    } finally {
      setShippedRootForTests(null);
    }
  });
});

describe('tenants under the process data folder', () => {
  it('tenants.dir inside <process data>/ boots: only a root that contains a process file is a clash, not one that sits inside the data folder', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cfg = processConfigFor(mkdtempSync(join(tmpdir(), 'sanctum-proc-')));
    const parent = join(dirname(cfg.server.db_path), 'tenants');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 't-'));
    mkdirSync(join(root, 'ada'));
    writeFileSync(join(root, 'ada', 'tenant.yaml'), safeTenantYaml('hosts: [ada.example.net]\n'));
    (cfg as unknown as { tenants: unknown }).tenants = { dir: root };
    const runtimes = bootTenants(express(), safeTenancyProcess(cfg));
    expect([...runtimes.keys()]).toEqual(['ada']);
    expect(layoutClash([...runtimes.values()], cfg).size).toBe(0);
    runtimes.get('ada')!.config.agent.cwd = dirname(cfg.server.db_path); // a root that CONTAINS the process data folder is still a clash
    expect(layoutClash([...runtimes.values()], cfg).get('ada')).toBeDefined();
  });
});

describe('a skipped tenant declared roots', () => {
  it("a symlinked root pointing into another tenant's data/ is dropped, so it cannot lock the victim out", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = proc();
    const root = makeTenantsDir({
      ada: { yaml: 'hosts: [ada.example.net]\n' },
      bea: { yaml: 'hosts: [bea.example.net]\nidentity:\n  timezone: Mars/Olympus_Mons\n' }, // skipped
    });
    mkdirSync(join(root, 'ada', 'data'), { recursive: true });
    symlinkSync(join(root, 'ada', 'data'), join(root, 'bea', 'home'), 'junction'); // bea's declared home is a link into ada's data/
    (cfg as unknown as { tenants: unknown }).tenants = { dir: root };
    const runtimes = bootTenants(express(), safeTenancyProcess(cfg));
    expect([...runtimes.keys()]).toEqual(['ada']);
    const ada = runtimes.get('ada')!;
    expect(runInTenant(ada, () => ledgerClash(ada.config))).toBeNull();
  });
});
