// Console output per tenant: a line written while a tenant is current lands in that tenant's own log and nowhere else.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import express from 'express';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableTenancy, runInTenant } from './context.js';
import { installTenantConsole, tenantLogFile, setTenantLogCap } from './console.js';
import { bootTenants } from './boot.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { fakeRuntime } from './test-runtime.js';
import { readLogs } from '../services/logs.js';

const root = mkdtempSync(join(tmpdir(), 'sanctum-console-'));
const mk = (id: string, token: string, pw: string, key: string) => fakeRuntime(id, {
  dir: join(root, id), dataDir: join(root, id, 'data'), token, config: { auth: { password: pw } } as never, env: { ANTHROPIC_API_KEY: key },
});
const ada = mk('ada', 'token-ada-0123456789', 'pw-ada-secret', 'sk-ada-key-0123');
const bea = mk('bea', 'token-bea-0123456789', 'pw-bea-secret', 'sk-bea-key-0123');
const stdout: string[] = [];
const fake = { log: (...a: unknown[]) => { stdout.push(a.join(' ')); }, info: (...a: unknown[]) => { stdout.push(a.join(' ')); }, warn: (...a: unknown[]) => { stdout.push(a.join(' ')); }, error: (...a: unknown[]) => { stdout.push(a.join(' ')); }, debug: (...a: unknown[]) => { stdout.push(a.join(' ')); } };
let restore: () => void;

beforeAll(() => { enableTenancy(true); restore = installTenantConsole(fake as unknown as Console); });
afterAll(async () => { await stopBootedTenants(); restore(); enableTenancy(false); });

describe('tenant console', () => {
  it('a tenant line lands in A\'s file with a parseable timestamp, not on stdout and not in B\'s file', () => {
    runInTenant(ada, () => { fake.log('hello from', 'ada'); fake.error('[x] failure kind=boom'); });
    expect(stdout).toEqual([]);
    const text = readFileSync(tenantLogFile(ada), 'utf8');
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z: hello from ada\n/);
    expect(text).toContain('failure kind=boom');
    expect(existsSync(tenantLogFile(bea))).toBe(false);
  });
  it('readLogs in A reads A\'s file; in B, nothing', () => {
    expect(runInTenant(ada, () => readLogs({ q: 'hello' })).lines.map((l) => l.text)).toEqual(['hello from ada']);
    const b = runInTenant(bea, () => readLogs());
    expect(b.lines).toEqual([]);
    expect(b.present).toEqual({ out: false, err: false });
  });
  it('a line with no tenant current goes to stdout as before', () => {
    fake.log('process line');
    expect(stdout).toEqual(['process line']);
    expect(existsSync(tenantLogFile(bea))).toBe(false);
  });
  it('the tenant\'s token, password and secret-named .env values never reach a file', () => {
    runInTenant(bea, () => fake.warn(`oops ${bea.token} and ${bea.config.auth.password} and ${bea.env.ANTHROPIC_API_KEY}`));
    const b = readFileSync(tenantLogFile(bea), 'utf8');
    for (const secret of [bea.token, 'pw-bea-secret', 'sk-bea-key-0123']) expect(b).not.toContain(secret);
    expect(b).toContain('[redacted]');
    expect(readFileSync(tenantLogFile(ada), 'utf8')).not.toContain('bea');
    expect(vi.isMockFunction(fake.log)).toBe(false);
  });
});

describe('size cap', () => {
  it('rotates tenant.log to tenant.log.1 past the cap, keeps the newest line in tenant.log, and readLogs reads the current file', () => {
    const cea = mk('cea', 'token-cea-0123456789', 'pw-cea-secret', 'sk-cea-key-0123');
    setTenantLogCap(300);
    try {
      runInTenant(cea, () => { for (let i = 0; i < 40; i++) fake.log(`line-${i} ${'x'.repeat(20)}`); });
      const file = tenantLogFile(cea);
      expect(existsSync(`${file}.1`)).toBe(true);
      expect(statSync(file).size).toBeLessThanOrEqual(300);
      expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(300);
      expect(readFileSync(file, 'utf8')).toContain('line-39 ');
      expect(readFileSync(file, 'utf8')).not.toContain('line-0 ');
      expect(readFileSync(`${file}.1`, 'utf8')).not.toContain('line-0 '); // the older rotation was replaced, not kept
      const read = runInTenant(cea, () => readLogs({ lines: 500 })).lines.map((l) => l.text);
      expect(read).toContain(`line-39 ${'x'.repeat(20)}`);
    } finally { setTenantLogCap(10 * 1024 * 1024); }
  });
});

describe('tenant boot lines', () => {
  it('a tenant\'s own boot lines go to its file, not stdout; the process [tenancy] lines stay on stdout', () => {
    const out: string[] = [];
    const lg = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const wr = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const dir = makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n', env: 'APP_PASSWORD=pw-boot-ada\n' } });
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    (proc as unknown as { tenants: unknown }).tenants = { dir };
    const undo = installTenantConsole(); // server.ts does this just before bootTenants
    const rts = bootTenants(express(), safeTenancyProcess(proc));
    try {
      const rt = rts.get('ada')!;
      const file = readFileSync(tenantLogFile(rt), 'utf8');
      expect(file).toContain('[Voice] GROQ_API_KEY not set');
      expect(file).toContain('[identity]');
      expect(out.filter((l) => l.includes('[Voice]') || l.includes('[identity]'))).toEqual([]);
      expect(out.some((l) => l.startsWith('[tenancy] tenant ada: ada.example.net'))).toBe(true);
    } finally {
      for (const rt of rts.values()) rt.db.close();
      enableTenancy(false); setTenantRegistry(new Map()); undo(); lg.mockRestore(); wr.mockRestore();
    }
  });
});
