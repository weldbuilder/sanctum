import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createTenantRuntime, checkDistinctTokens } from './runtime.js';
import { makeTenantsDir, processConfigFor } from './test-runtime.js';

const open: { db: { close(): void } }[] = [];
afterEach(() => { for (const r of open.splice(0)) { try { r.db.close(); } catch { /* closed */ } } vi.restoreAllMocks(); });
const proc = () => processConfigFor(resolve(tmpdir(), 'sanctum-process'));
const make = (root: string, id: string, env: Record<string, string> = {}) => { const rt = createTenantRuntime(proc(), id, join(root, id), env); open.push(rt); return rt; };

// Each test boots a tenant (a database file and its migrations), some twice: about 10 s on a Windows runner, past vitest's default 5 s.
describe('createTenantRuntime', { timeout: 30_000 }, () => {
  it('creates data/, its own database file and an owner-only token', () => {
    const root = makeTenantsDir({ ada: { env: 'APP_PASSWORD=pw\n', yaml: 'hosts: [ada.example.net]\n' } });
    const rt = make(root, 'ada');
    expect(rt.dataDir).toBe(resolve(root, 'ada', 'data'));
    expect(existsSync(join(rt.dataDir, 'sanctum.db'))).toBe(true);
    expect(rt.db.pragma('database_list', { simple: false })).toEqual(expect.arrayContaining([expect.objectContaining({ file: expect.stringContaining('sanctum.db') })]));
    expect(rt.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(rt.dataDir, '.internal-token'), 'utf8').trim()).toBe(rt.token);
    expect(rt.hosts).toEqual(['ada.example.net']);
    expect(rt.config.auth.password).toBe('pw');
    expect(rt.env.APP_PASSWORD).toBeUndefined();
    if (process.platform !== 'win32') {
      expect(statSync(rt.dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(rt.dataDir, '.internal-token')).mode & 0o777).toBe(0o600);
    }
  });

  it('reuses the token on the next boot', () => {
    const root = makeTenantsDir({ ada: {} });
    const first = make(root, 'ada');
    const token = first.token;
    first.db.close();
    expect(make(root, 'ada').token).toBe(token);
  });

  it('purges expired sessions on its own database', () => {
    const root = makeTenantsDir({ ada: {} });
    const first = make(root, 'ada');
    const ins = first.db.prepare('INSERT INTO web_sessions (id, token, created_at, expires_at) VALUES (?, ?, ?, ?)');
    ins.run('old', 'old-token', '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z');
    ins.run('new', 'new-token', '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z');
    first.db.close();
    const again = make(root, 'ada');
    expect(again.db.prepare('SELECT id FROM web_sessions ORDER BY id').all()).toEqual([{ id: 'new' }]);
  });

  it('refuses to boot with INTERNAL_TOKEN in the process environment', () => {
    const root = makeTenantsDir({ ada: {} });
    expect(() => createTenantRuntime(proc(), 'ada', join(root, 'ada'), { INTERNAL_TOKEN: 'shared' })).toThrow(/INTERNAL_TOKEN/);
    expect(existsSync(join(root, 'ada', 'data'))).toBe(false);
  });

  it('two tenants get two databases and two different tokens', () => {
    const root = makeTenantsDir({ ada: {}, bea: {} });
    const a = make(root, 'ada');
    const b = make(root, 'bea');
    expect(a.config.server.db_path).not.toBe(b.config.server.db_path);
    expect(a.token).not.toBe(b.token);
    expect(() => checkDistinctTokens([a, b])).not.toThrow();
  });

  it('two tenants with the same token is a boot error', () => {
    const root = makeTenantsDir({ ada: {}, bea: {} });
    const a = make(root, 'ada');
    const b = make(root, 'bea');
    expect(() => checkDistinctTokens([a, { id: b.id, token: a.token }])).toThrow(/same internal token/);
  });
});

describe('the database opened is a plain sqlite file', () => {
  it('can be opened directly by path', () => {
    const root = makeTenantsDir({ ada: {} });
    const rt = make(root, 'ada');
    const direct = new Database(rt.config.server.db_path, { readonly: true });
    expect(direct.prepare("SELECT name FROM sqlite_master WHERE name = 'web_sessions'").get()).toBeTruthy();
    direct.close();
  });
});
