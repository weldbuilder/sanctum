// Boot parks two tenants whose Revien address is the same (both enabled): both boot, neither has Revien, one line each names the other.
// Providers are faked (nothing here can start a model run).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../services/providers/index.js', () => ({
  activeProvider: () => 'claude', AbortError: class AbortError extends Error {}, listSessions: async () => [],
  query: () => { throw new Error('no model run in this test'); },
}));
vi.mock('../services/outlook-author.js', async (orig) => ({ ...(await orig<object>()), startOutlookAuthor: () => {}, stopOutlookAuthor: () => {} }));

import { bootTenants, stopTenantServices } from './boot.js';
import { enableTenancy, type TenantRuntime } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';

let runtimes: Map<string, TenantRuntime>;
const warned: string[] = [];
const on = (url: string) => `revien:\n  enabled: true\n  url: "${url}"\n`;

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
  const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
  cfg.orchestrator.enabled = false;
  (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
    ada: { yaml: `hosts: [ada.example.net]\n${on('http://127.0.0.1:7438')}` },
    bea: { yaml: `hosts: [bea.example.net]\n${on('http://127.0.0.1:7438')}` },
    cy: { yaml: `hosts: [cy.example.net]\n${on('http://127.0.0.1:7439')}` },
    di: { yaml: 'hosts: [di.example.net]\n' },
  }) };
  runtimes = bootTenants(express(), safeTenancyProcess(cfg));
});
afterAll(async () => {
  await stopBootedTenants();
  stopTenantServices(runtimes.values());
  for (const rt of runtimes.values()) rt.db.close();
  enableTenancy(false); setTenantRegistry(new Map());
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('Revien at boot', () => {
  it('parks both tenants on one address with one line each, keeps the tenant on its own address, and leaves the tenant that never turned it on off', () => {
    expect([...runtimes.keys()].sort()).toEqual(['ada', 'bea', 'cy', 'di']); // parked for Revien only: every tenant still boots
    const rev = (id: string) => runtimes.get(id)!.config.revien.enabled;
    expect([rev('ada'), rev('bea'), rev('cy'), rev('di')]).toEqual([false, false, true, false]);
    const lines = warned.filter((w) => w.includes('Revien parked'));
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.includes('tenant ada:'))).toMatch(/also used by tenant bea\b/);
    expect(lines.find((l) => l.includes('tenant bea:'))).toMatch(/also used by tenant ada\b/);
  });
});
