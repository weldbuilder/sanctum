import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cron } from 'croner';
import {
  enableTenancy, tenancyEnabled, currentTenant, runInTenant, bindTenant, tenantLocal, NoTenantContext, tenantOrNull, getProcessConfig,
} from './context.js';
import { fakeRuntime } from './test-runtime.js';

afterEach(() => enableTenancy(false));

describe('tenancy off', () => {
  it('has no tenant and tenantLocal is one lazily created module value', () => {
    expect(tenancyEnabled()).toBe(false);
    expect(currentTenant()).toBeUndefined();
    let made = 0;
    const local = tenantLocal(() => ({ n: ++made }));
    expect(made).toBe(0);
    const a = local.get();
    expect(local.get()).toBe(a);
    expect(made).toBe(1);
    // A store does nothing while tenancy is off: still the same one object.
    expect(runInTenant(fakeRuntime('a'), () => local.get())).toBe(a);
    local.reset();
    expect(local.get()).not.toBe(a);
  });
  it('tenantOrNull is null, never a throw', () => {
    expect(tenantOrNull('x')).toBeNull();
  });
  it('getProcessConfig is the config.ts module config', async () => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = await import('./context.js');
    const cfgMod = await import('../config.js');
    expect(() => ctx.getProcessConfig()).toThrow(/Config not loaded/);
    const dir = mkdtempSync(join(tmpdir(), 'sanctum-ctx-'));
    const file = join(dir, 'sanctum.yaml');
    writeFileSync(file, 'identity:\n  companion_name: Ctx\n');
    const cfg = cfgMod.loadConfig(file);
    expect(ctx.getProcessConfig()).toBe(cfg);
    expect(cfgMod.getSanctumConfig()).toBe(cfg);
    vi.restoreAllMocks();
  });
});

describe('tenancy on', () => {
  it('gives two runtimes two distinct values and keeps each in rt.locals', () => {
    enableTenancy(true);
    const local = tenantLocal(() => ({ made: Symbol('v') }));
    const a = fakeRuntime('a');
    const b = fakeRuntime('b');
    const va = runInTenant(a, () => local.get());
    const vb = runInTenant(b, () => local.get());
    expect(va).not.toBe(vb);
    expect(runInTenant(a, () => local.get())).toBe(va);
    expect(a.locals.size).toBe(1);
    expect(b.locals.size).toBe(1);
    runInTenant(a, () => local.reset());
    expect(a.locals.size).toBe(0);
    expect(b.locals.size).toBe(1);
    runInTenant(b, () => local.set({ made: Symbol('set') }));
    expect(runInTenant(b, () => local.get())).not.toBe(vb);
  });

  it('throws NoTenantContext outside any store, for get, set, reset and tenantOrNull', () => {
    enableTenancy(true);
    const local = tenantLocal(() => 1);
    expect(() => local.get()).toThrow(NoTenantContext);
    expect(() => local.set(2)).toThrow(NoTenantContext);
    expect(() => local.reset()).toThrow(NoTenantContext);
    expect(() => tenantOrNull('x')).toThrow(NoTenantContext);
    expect(currentTenant()).toBeUndefined();
  });

  it('keeps the store across await, setTimeout, setInterval and a croner tick', async () => {
    enableTenancy(true);
    const a = fakeRuntime('a');
    const b = fakeRuntime('b');
    const seen = await Promise.all([a, b].map((rt) => runInTenant(rt, async () => {
      const ids: string[] = [];
      ids.push(currentTenant()!.id);
      await Promise.resolve();
      ids.push(currentTenant()!.id);
      await new Promise<void>((ok) => setTimeout(() => { ids.push(currentTenant()!.id); ok(); }, 5));
      await new Promise<void>((ok) => {
        let n = 0;
        const t = setInterval(() => { ids.push(currentTenant()!.id); if (++n === 2) { clearInterval(t); ok(); } }, 5);
      });
      await new Promise<void>((ok) => {
        // Every second, not a one-off date a few ms ahead: croner drops a date already past when it schedules, so a worker
        // paused that long under a full run never ticked and the test timed out. The next whole second is always ahead.
        const job = new Cron('* * * * * *', () => { ids.push(currentTenant()!.id); job.stop(); ok(); });
      });
      return ids;
    })));
    expect(seen[0]).toEqual(Array(6).fill('a'));
    expect(seen[1]).toEqual(Array(6).fill('b'));
  });

  it('bindTenant runs a callback made outside a request in its tenant', () => {
    enableTenancy(true);
    const a = fakeRuntime('a');
    const cb = bindTenant(a, (x: number) => `${currentTenant()!.id}:${x}`);
    expect(cb(7)).toBe('a:7');
    expect(currentTenant()).toBeUndefined();
  });
});
