// A tenant's own files and folders are its own (round 3, items 1, 2 and 9): a link (symlink or junction) or a hard-linked file at tenant.yaml, .env,
// home/, private/ or data/... skips the tenant at boot with one line naming the path, is refused by rt.reload(), and nothing outside the tenant
// folder (the app's .env, its data/) is read, written or created. Links need privileges on Windows: those cases skip when the platform refuses them.
// Providers are faked: nothing here can start a model run.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude', AbortError: class AbortError extends Error {}, listSessions: async () => [],
  query: () => { throw new Error('no model run in this test'); },
}));
vi.mock('../services/outlook-author.js', async (orig) => ({ ...(await orig<object>()), startOutlookAuthor: () => {}, stopOutlookAuthor: () => {} }));

import { bootTenants, stopTenantServices } from './boot.js';
import { enableTenancy, registerProcessConfig, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { loadTenantConfig, tenantFilesProblem, tenantsDirProblem } from './config.js';
import { createTenantRuntime } from './runtime.js';
import { processConfigFor, safeTenancyProcess, stopBootedTenants, safeTenantYaml } from './test-runtime.js';
import { PROJECT_ROOT } from '../config.js';

const posix = process.platform !== 'win32';
const made: string[] = [];
afterEach(async () => { await stopBootedTenants(); enableTenancy(false); setTenantRegistry(new Map()); registerProcessConfig(() => null); vi.useRealTimers(); vi.restoreAllMocks(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A scratch world: `app/` (the process's .env and data/), `tenants/ada` (clean) and `tenants/bea` (to be broken). */
function world() {
  const top = mkdtempSync(join(tmpdir(), 'sanctum-own-files-'));
  made.push(top);
  const app = join(top, 'app');
  mkdirSync(join(app, 'data', 'identity'), { recursive: true });
  writeFileSync(join(app, '.env'), 'APP_PASSWORD=process-secret\nANTHROPIC_API_KEY=sk-process\n');
  writeFileSync(join(app, 'data', 'identity', 'ledger.jsonl'), '{"line":1}\n');
  writeFileSync(join(app, 'other.yaml'), 'hosts: [stolen.example.net]\n');
  mkdirSync(join(top, 'elsewhere'), { recursive: true });
  const tenants = join(top, 'tenants');
  for (const id of ['ada', 'bea']) { mkdirSync(join(tenants, id), { recursive: true }); writeFileSync(join(tenants, id, 'tenant.yaml'), safeTenantYaml(`hosts: [${id}.example.net]\n`)); }
  return { top, app, tenants, ada: join(tenants, 'ada'), bea: join(tenants, 'bea'), elsewhere: join(top, 'elsewhere') };
}
type World = ReturnType<typeof world>;
const tryLink = (target: string, at: string, type: 'file' | 'junction' | 'hard'): boolean => {
  try { if (type === 'hard') linkSync(target, at); else symlinkSync(target, at, type); return true; } catch { return false; }
};
/** Every file under `dir` with its bytes, and every folder: "nothing was written, nothing was created". */
const snapshot = (dir: string, out: Record<string, string> = {}): Record<string, string> => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { out[p] = 'dir'; snapshot(p, out); } else if (e.isFile()) out[p] = readFileSync(p).toString('hex'); else out[p] = 'link';
  }
  return out;
};

interface Case { name: string; rel: string; build: (w: World) => boolean; posixOnly?: boolean }
const CASES: Case[] = [
  { name: 'tenants/bea/.env -> app/.env', rel: '.env', build: (w) => tryLink(join(w.app, '.env'), join(w.bea, '.env'), 'file') },
  { name: 'a hardlinked tenants/bea/.env', rel: '.env', posixOnly: true, build: (w) => tryLink(join(w.app, '.env'), join(w.bea, '.env'), 'hard') },
  { name: 'tenants/bea/tenant.yaml -> app/other.yaml', rel: 'tenant.yaml', build: (w) => { rmSync(join(w.bea, 'tenant.yaml')); return tryLink(join(w.app, 'other.yaml'), join(w.bea, 'tenant.yaml'), 'file'); } },
  { name: 'a hardlinked tenants/bea/tenant.yaml', rel: 'tenant.yaml', posixOnly: true, build: (w) => { rmSync(join(w.bea, 'tenant.yaml')); return tryLink(join(w.app, 'other.yaml'), join(w.bea, 'tenant.yaml'), 'hard'); } },
  { name: 'tenants/bea/data -> app/data', rel: 'data', build: (w) => tryLink(join(w.app, 'data'), join(w.bea, 'data'), 'junction') },
  { name: 'tenants/bea/private -> <outside>', rel: 'private', build: (w) => tryLink(w.elsewhere, join(w.bea, 'private'), 'junction') },
  { name: 'tenants/bea/home -> <outside>', rel: 'home', build: (w) => tryLink(w.elsewhere, join(w.bea, 'home'), 'junction') },
  { name: 'tenants/bea/data/identity -> app/data/identity', rel: 'data/identity', build: (w) => { mkdirSync(join(w.bea, 'data')); return tryLink(join(w.app, 'data', 'identity'), join(w.bea, 'data', 'identity'), 'junction'); } },
  { name: 'tenants/bea/data/sanctum.db -> <outside file>', rel: 'data/sanctum.db', build: (w) => { mkdirSync(join(w.bea, 'data')); writeFileSync(join(w.elsewhere, 'db'), 'x'); return tryLink(join(w.elsewhere, 'db'), join(w.bea, 'data', 'sanctum.db'), 'file'); } },
];

const beforeBoot = () => { vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] }); vi.spyOn(console, 'log').mockImplementation(() => {}); };
function boot(w: World): { runtimes: Map<string, TenantRuntime>; warned: string[] } {
  const warned: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
  const cfg = processConfigFor(join(w.top, 'proc'));
  cfg.orchestrator.enabled = false;
  (cfg as unknown as { tenants: unknown }).tenants = { dir: w.tenants };
  registerProcessConfig(() => cfg);
  return { runtimes: bootTenants(express(), safeTenancyProcess(cfg)), warned };
}
const stop = (r: Map<string, TenantRuntime>) => { stopTenantServices(r.values()); for (const rt of r.values()) { try { rt.db.close(); } catch { /* closed */ } } };

describe.each(CASES)('$name', (c) => {
  const set = (): World | null => { const w = world(); return c.build(w) ? w : null; };
  const ok = (): boolean => !(c.posixOnly && !posix);

  it('tenantFilesProblem names the path relative to the tenant folder', (t) => {
    const w = set(); if (!w || !ok()) return t.skip();
    const why = tenantFilesProblem(w.bea);
    expect(why).toContain(`${c.rel} in the tenant folder`);
    expect(why).not.toContain(w.top);
    expect(why).not.toContain('\n');
    expect(tenantFilesProblem(w.ada)).toBe('');
  });

  it('the loader refuses it and hands nothing of the linked file to the tenant', (t) => {
    const w = set(); if (!w || !ok()) return t.skip();
    const proc = processConfigFor(join(w.top, 'proc'));
    expect(() => loadTenantConfig(proc, w.bea, 'bea', { quiet: true })).toThrow(new RegExp(`tenant bea: ${c.rel.replace(/[.]/g, '\\.')} in the tenant folder`));
    expect(() => loadTenantConfig(proc, w.bea, 'bea', { quiet: true, fileCfg: {} })).toThrow(/in the tenant folder/); // the dry run too
    expect(() => createTenantRuntime(proc, 'bea', w.bea, {})).toThrow(/in the tenant folder/);
  });

  it('boot skips the tenant with one line naming the path; the other tenant boots; the app\'s .env and data/ are byte-identical and nothing new appears in them', (t) => {
    const w = set(); if (!w || !ok()) return t.skip();
    beforeBoot();
    const before = { app: snapshot(w.app), elsewhere: snapshot(w.elsewhere) };
    const { runtimes, warned } = boot(w);
    try {
      expect([...runtimes.keys()]).toEqual(['ada']);
      const lines = warned.filter((l) => l.includes('tenant bea skipped'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${c.rel} in the tenant folder`);
      expect(lines[0]).not.toContain(w.top); // relative to the tenant folder, never an absolute path
      expect(snapshot(w.app)).toEqual(before.app);
      expect(snapshot(w.elsewhere)).toEqual(before.elsewhere);
      expect(readFileSync(join(w.app, '.env'), 'utf8')).toBe('APP_PASSWORD=process-secret\nANTHROPIC_API_KEY=sk-process\n');
    } finally { stop(runtimes); }
  });
});

describe('a linked <tenant>/data (item 2)', () => {
  it('tenants/bea/data -> app/data: the identity ledger, the database and the token never land in the process\'s own data folder', (t) => {
    const w = world();
    if (!tryLink(join(w.app, 'data'), join(w.bea, 'data'), 'junction')) return t.skip();
    beforeBoot();
    const before = snapshot(join(w.app, 'data'));
    const { runtimes } = boot(w);
    try {
      expect([...runtimes.keys()]).toEqual(['ada']);
      expect(snapshot(join(w.app, 'data'))).toEqual(before); // no sanctum.db, no .internal-token, nothing in identity/
      expect(existsSync(join(w.app, 'data', 'sanctum.db'))).toBe(false);
      expect(existsSync(join(w.app, 'data', '.internal-token'))).toBe(false);
      expect(readFileSync(join(w.app, 'data', 'identity', 'ledger.jsonl'), 'utf8')).toBe('{"line":1}\n');
    } finally { stop(runtimes); }
  });
});

describe('rt.reload() refuses a tenant whose own files became links', () => {
  it('a .env replaced by a link after boot: the reload throws naming the path, the old config stays, the app .env is untouched', (t) => {
    const w = world();
    beforeBoot();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtimes } = boot(w);
    try {
      const ada = runtimes.get('ada')!;
      const before = ada.config;
      writeFileSync(join(w.ada, '.env'), 'APP_PASSWORD=ada-own\n');
      ada.reload(); // a clean .env reloads
      expect(ada.config.auth.password).toBe('ada-own');
      const good = ada.config;
      rmSync(join(w.ada, '.env'));
      if (!tryLink(join(w.app, '.env'), join(w.ada, '.env'), 'file')) return t.skip();
      expect(() => ada.reload()).toThrow(/\.env in the tenant folder is a link/);
      expect(ada.config).toBe(good);
      expect(before).not.toBe(good);
      expect(ada.config.auth.password).toBe('ada-own'); // the process's password was never handed over
      expect(readFileSync(join(w.app, '.env'), 'utf8')).toContain('process-secret');
    } finally { stop(runtimes); }
  });
});

describe('tenants.dir that is the app folder (item 9)', () => {
  it('boot refuses it, also through a link, with one sentence; a folder of its own is fine', (t) => {
    const w = world();
    expect(tenantsDirProblem(PROJECT_ROOT, PROJECT_ROOT)).toMatch(/is the app folder itself/);
    expect(tenantsDirProblem(w.tenants, PROJECT_ROOT)).toBe('');
    expect(tenantsDirProblem(join(PROJECT_ROOT, 'tenants'), PROJECT_ROOT)).toBe(''); // the default layout
    const cfg = processConfigFor(join(w.top, 'proc'));
    (cfg as unknown as { tenants: unknown }).tenants = { dir: resolve(PROJECT_ROOT) };
    expect(() => bootTenants(express(), safeTenancyProcess(cfg))).toThrow(/tenants\.dir is the app folder itself/);
    const via = join(w.top, 'via');
    if (!tryLink(PROJECT_ROOT, via, 'junction')) return t.skip();
    (cfg as unknown as { tenants: unknown }).tenants = { dir: via };
    expect(() => bootTenants(express(), safeTenancyProcess(cfg))).toThrow(/tenants\.dir is the app folder itself/);
  });
});
