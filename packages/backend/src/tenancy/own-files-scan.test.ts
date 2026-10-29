// The boot scan that replaced TENANT_OWN_ENTRIES (round 4): tenant.yaml, .env, .mcp.json, all of data/ and private/, and the top level of home/ must hold no link and
// no second hard link, at any depth under data/ and private/ (never refused on count); rt.reload() and the loader run it; the quick form the per-request net runs looks one level down.
// And M3: tenants.dir is not the app folder and not an ancestor of it. Links need privileges on Windows: those cases return early when the platform refuses them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { loadTenantConfig, tenantFilesProblem, tenantHoldsAppProblem, tenantsDirProblem } from './config.js';
import { bootTenants } from './boot.js';
import { enableTenancy, registerProcessConfig } from './context.js';
import { createTenantRuntime } from './runtime.js';
import { processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { PROJECT_ROOT } from '../config.js';

const posix = process.platform !== 'win32';
const made: string[] = [];
afterEach(async () => { await stopBootedTenants(); enableTenancy(false); registerProcessConfig(() => null); vi.restoreAllMocks(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
function world() {
  const top = mkdtempSync(join(tmpdir(), 'sanctum-scan-'));
  made.push(top);
  const ada = join(top, 'tenants', 'ada');
  const outside = join(top, 'outside');
  mkdirSync(join(ada, 'home'), { recursive: true });
  mkdirSync(join(ada, 'data', 'a', 'b', 'c'), { recursive: true });
  mkdirSync(join(ada, 'private'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(ada, 'tenant.yaml'), safeTenantYaml('hosts: [ada.example.net]\n'));
  writeFileSync(join(outside, 'secret'), 'SECRET');
  return { top, ada, outside, secret: join(outside, 'secret'), tenants: join(top, 'tenants') };
}
const link = (t: string, at: string, k: 'file' | 'junction' = 'file'): boolean => { try { symlinkSync(t, at, k); return true; } catch { return false; } };

describe('the general scan', () => {
  it('a clean tenant folder is clean', () => { expect(tenantFilesProblem(world().ada)).toBe(''); });

  it('a link three levels deep under data/ refuses the tenant, naming the path relative to its folder (a fixed list of entries never looked there)', () => {
    const w = world();
    if (!link(w.secret, join(w.ada, 'data', 'a', 'b', 'c', 'journal.jsonl'))) return;
    expect(tenantFilesProblem(w.ada)).toBe("data/a/b/c/journal.jsonl in the tenant folder is a link; a tenant's own files and folders must be real ones inside its folder.");
  });
  it('a link to a folder four levels deep under private/', () => {
    const w = world();
    mkdirSync(join(w.ada, 'private', 'x', 'y', 'z'), { recursive: true });
    if (!link(w.outside, join(w.ada, 'private', 'x', 'y', 'z', 'dir'), 'junction')) return;
    expect(tenantFilesProblem(w.ada)).toMatch(/^private\/x\/y\/z\/dir in the tenant folder is a link/);
  });
  it.runIf(posix)('a hard-linked file deep under data/ (a backup made with cp -al is refused by design)', () => {
    const w = world();
    linkSync(w.secret, join(w.ada, 'data', 'a', 'b', 'copy'));
    expect(tenantFilesProblem(w.ada)).toBe("data/a/b/copy in the tenant folder has more than one hard link; a tenant's own files and folders must be real ones inside its folder.");
  });
  it('.mcp.json is checked too, and the top level of home/ (a link at home/notes), but not deeper in home/', () => {
    const w = world();
    mkdirSync(join(w.ada, 'home', 'deep'), { recursive: true });
    if (!link(w.secret, join(w.ada, 'home', 'deep', 'x'))) return; // home/ below its top level is the companion's own space: not scanned
    expect(tenantFilesProblem(w.ada)).toBe('');
    expect(link(w.secret, join(w.ada, 'home', 'notes'))).toBe(true);
    expect(tenantFilesProblem(w.ada)).toMatch(/^home\/notes in the tenant folder is a link/);
    rmSync(join(w.ada, 'home', 'notes'));
    expect(link(w.secret, join(w.ada, '.mcp.json'))).toBe(true);
    expect(tenantFilesProblem(w.ada)).toMatch(/^\.mcp\.json in the tenant folder is a link/);
  });
  it('the quick form (the per-request net) sees the first level of data/ and private/ and not deeper', () => {
    const w = world();
    if (!link(w.secret, join(w.ada, 'data', 'a', 'b', 'c', 'deep'))) return;
    expect(tenantFilesProblem(w.ada, { quick: true })).toBe('');
    expect(link(w.secret, join(w.ada, 'data', 'top'))).toBe(true);
    expect(tenantFilesProblem(w.ada, { quick: true })).toMatch(/^data\/top in the tenant folder is a link/);
  });
});

describe('the loader and rt.reload() run the scan', () => {
  const proc = (w: ReturnType<typeof world>) => processConfigFor(join(w.top, 'proc'));
  it('loadTenantConfig refuses a tenant with a link three levels deep, with the sentence', () => {
    const w = world();
    if (!link(w.secret, join(w.ada, 'data', 'a', 'b', 'c', 'x'))) return;
    expect(() => loadTenantConfig(proc(w), w.ada, 'ada')).toThrow(/^tenant ada: data\/a\/b\/c\/x in the tenant folder is a link/);
  });
  it('rt.reload() refuses a link that appeared after boot, keeps the old config, and the app is untouched', () => {
    const w = world();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cfg = proc(w);
    registerProcessConfig(() => cfg);
    const rt = createTenantRuntime(cfg, 'ada', w.ada);
    const before = rt.config;
    if (!link(w.secret, join(w.ada, 'data', 'a', 'b', 'late'))) { rt.db.close(); return; }
    expect(() => rt.reload()).toThrow(/data\/a\/b\/late in the tenant folder is a link/);
    expect(rt.config).toBe(before);
    rt.db.close();
  });
});

describe('M3: tenants.dir is not the app folder and not an ancestor of it', () => {
  const app = (top: string) => { const a = join(top, 'srv', 'app'); mkdirSync(join(a, 'tenants'), { recursive: true }); return a; };
  it('the app folder itself and an ancestor of it are refused; its own folder, and the shipped <app>/tenants, are fine', () => {
    const top = mkdtempSync(join(tmpdir(), 'sanctum-m3-')); made.push(top);
    const a = app(top);
    expect(tenantsDirProblem(a, a)).toMatch(/is the app folder itself/);
    expect(tenantsDirProblem(dirname(a), a)).toMatch(/^tenants\.dir holds the app folder/);
    expect(tenantsDirProblem(top, a)).toMatch(/^tenants\.dir holds the app folder/);
    expect(tenantsDirProblem(join(a, 'tenants'), a)).toBe('');
    mkdirSync(join(top, 'elsewhere'));
    expect(tenantsDirProblem(join(top, 'elsewhere'), a)).toBe('');
  });
  it('an ancestor reached through a link is refused too', () => {
    const top = mkdtempSync(join(tmpdir(), 'sanctum-m3-')); made.push(top);
    const a = app(top);
    if (!link(dirname(a), join(top, 'alias'), 'junction')) return;
    expect(tenantsDirProblem(join(top, 'alias'), a)).toMatch(/^tenants\.dir holds the app folder/);
  });
  it('a tenant folder that equals or holds the app folder is skipped (the check boot runs on each folder)', () => {
    const top = mkdtempSync(join(tmpdir(), 'sanctum-m3-')); made.push(top);
    const a = app(top);
    expect(tenantHoldsAppProblem(a, a)).toMatch(/is, or holds, the app folder/);
    expect(tenantHoldsAppProblem(dirname(a), a)).toMatch(/is, or holds, the app folder/);
    expect(tenantHoldsAppProblem(join(a, 'tenants'), a)).toBe('');
  });
  it('boot throws for a tenants.dir that holds the real app folder, before reading a single folder in it', () => {
    const cfg = processConfigFor(join(tmpdir(), 'sanctum-m3-proc'));
    (cfg as unknown as { tenants: unknown }).tenants = { dir: dirname(PROJECT_ROOT) };
    expect(() => bootTenants(express(), safeTenancyProcess(cfg))).toThrow(/tenants\.dir holds the app folder/);
  });
});

describe('what the scan skips: data/harness, data/tmp, data/files, data/logs (the write layer and the read guard cover them)', () => {
  it('a link or hard link inside those folders does not refuse a healthy tenant, however deep', () => {
    const w = world();
    for (const d of ['harness/claude/projects', 'tmp', 'files', 'logs']) mkdirSync(join(w.ada, 'data', d), { recursive: true });
    if (!link(w.secret, join(w.ada, 'data', 'harness', 'claude', 'projects', 'l'))) return;
    link(w.secret, join(w.ada, 'data', 'files', 'x'));
    link(w.secret, join(w.ada, 'data', 'tmp', 'x'));
    link(w.secret, join(w.ada, 'data', 'logs', 'x'));
    expect(tenantFilesProblem(w.ada)).toBe('');
  });
  it('the rest of data/ is still scanned, however many entries a folder holds', () => {
    const w = world();
    mkdirSync(join(w.ada, 'data', 'big'));
    for (let i = 0; i < 12; i += 1) writeFileSync(join(w.ada, 'data', 'big', `f${i}`), 'x');
    expect(tenantFilesProblem(w.ada)).toBe('');
    if (!link(w.secret, join(w.ada, 'data', 'big', 'zz'))) return;
    expect(tenantFilesProblem(w.ada)).toMatch(/^data\/big\/zz in the tenant folder is a link/);
  });
  it('the harness homes child.ts creates hold no link by construction (plain mkdir of real folders)', async () => {
    const { harnessHomes } = await import('./child.js');
    const w = world();
    const homes = harnessHomes({ dir: w.ada, dataDir: join(w.ada, 'data') } as never);
    expect(Object.keys(homes).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME']);
    expect(tenantFilesProblem(w.ada)).toBe('');
  });
});
