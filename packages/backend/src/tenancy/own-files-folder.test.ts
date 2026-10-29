// Round 8, item 4: readOwnIn / readOwnTextIn take a folder. With tenancy on it must be inside the configured tenants.dir (by realpath) or be a registered tenant's
// folder; anything else is refused, whatever file is asked for. Tenancy off: unchanged.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { enableTenancy, registerAllTenants, registerProcessConfig } from './context.js';
import { readOwnIn, readOwnTextIn } from './own-files.js';
import { fakeRuntime, makeTenantsDir, processConfigFor } from './test-runtime.js';

afterEach(() => { enableTenancy(false); registerProcessConfig(() => null); registerAllTenants({ booted: () => [], skipped: () => [] }); });
const withTenants = (dir: string) => { const c = processConfigFor(resolve(tmpdir(), 'sanctum-process')); (c as unknown as { tenants: unknown }).tenants = { dir }; registerProcessConfig(() => c); };

describe('readOwnIn / readOwnTextIn folder check', () => {
  it('tenancy on: a folder inside tenants.dir reads; one outside is refused for both readers, even for a real file in it', () => {
    const root = makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n' } });
    const outside = mkdtempSync(join(tmpdir(), 'sanctum-elsewhere-'));
    writeFileSync(join(outside, 'x.txt'), 'plain');
    withTenants(root);
    enableTenancy(true);
    expect(readOwnTextIn(join(root, 'ada'), join(root, 'ada', 'tenant.yaml'))).toContain('ada.example.net');
    expect(readOwnIn(join(root, 'ada'), join(root, 'ada', 'tenant.yaml')).length).toBeGreaterThan(0);
    expect(() => readOwnTextIn(outside, join(outside, 'x.txt'))).toThrow(/not inside the tenants folder/);
    expect(() => readOwnIn(outside, join(outside, 'x.txt'))).toThrow(/not inside the tenants folder/);
    expect(() => readOwnTextIn(root, join(root, 'ada', 'tenant.yaml'))).toThrow(/not inside the tenants folder/); // the tenants folder itself is not a tenant
  });

  it('tenancy on: a link inside tenants.dir that leads outside is refused by its realpath', () => {
    const root = makeTenantsDir({ ada: {} });
    const outside = mkdtempSync(join(tmpdir(), 'sanctum-elsewhere-'));
    writeFileSync(join(outside, 'x.txt'), 'plain');
    try { symlinkSync(outside, join(root, 'eve'), 'dir'); } catch { return; } // (no symlinks here: nothing to test)
    withTenants(root);
    enableTenancy(true);
    expect(() => readOwnTextIn(join(root, 'eve'), join(root, 'eve', 'x.txt'))).toThrow();
  });

  it('tenancy on: a registered tenant\'s own folder is accepted even when it sits outside tenants.dir', () => {
    const root = makeTenantsDir({ ada: {} });
    const odd = mkdtempSync(join(tmpdir(), 'sanctum-registered-'));
    mkdirSync(join(odd, 'data'), { recursive: true });
    writeFileSync(join(odd, 'f.txt'), 'mine');
    withTenants(root);
    registerAllTenants({ booted: () => [fakeRuntime('odd', { dir: odd })], skipped: () => [] });
    enableTenancy(true);
    expect(readOwnTextIn(odd, join(odd, 'f.txt'))).toBe('mine');
  });

  it('tenancy off: any folder reads, as before', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sanctum-elsewhere-'));
    writeFileSync(join(outside, 'x.txt'), 'plain');
    expect(readOwnTextIn(outside, join(outside, 'x.txt'))).toBe('plain');
    expect(readOwnIn(outside, join(outside, 'x.txt')).toString()).toBe('plain');
  });
});
