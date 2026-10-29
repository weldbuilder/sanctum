// Revien is one daemon with no tenant scope (services/revien.ts sends no tenant id). In tenant mode it is therefore off unless a tenant's own
// tenant.yaml turns it on, revien.url is never inherited, and two tenants on one address are both parked. Tenancy off is unchanged.
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTenantConfig } from './config.js';
import { enableTenancy, runInTenant } from './context.js';
import { fakeRuntime, makeTenantsDir, processConfigFor } from './test-runtime.js';
import { parkDuplicateRevien, reconcileRevienOnReload, revienClashes } from './revien.js';
import { mergeConfigDefaults, type SanctumConfig } from '../config.js';
import { ingestTurn, recallForPrompt } from '../services/revien.js';

afterEach(() => { vi.restoreAllMocks(); enableTenancy(false); });
const procBase = resolve(tmpdir(), 'sanctum-process');
const proc = (file: Record<string, unknown> = {}) => processConfigFor(procBase, { identity: { timezone: 'UTC' }, ...file });
const load = (file: Record<string, unknown>, root: string, id: string) => loadTenantConfig(proc(file), join(root, id), id, { processFile: file, quiet: true }).config;

describe('Revien in tenant mode', () => {
  it('is off for a tenant that does not turn it on, even when the operator\'s file has it on with its own address', () => {
    const root = makeTenantsDir({ ada: {} });
    const c = load({ revien: { enabled: true, url: 'http://daemon.example.net:7437', recall_limit: 20 } }, root, 'ada');
    expect(c.revien.enabled).toBe(false);
    expect(c.revien.url).toBe(mergeConfigDefaults({}).revien.url); // the operator's address is not inherited (the shipped default is only a default)
    expect(c.revien.recall_limit).toBe(mergeConfigDefaults({}).revien.recall_limit);
  });

  it('is on when the tenant\'s own tenant.yaml says so, with the tenant\'s own address', () => {
    const root = makeTenantsDir({ ada: { yaml: 'revien:\n  enabled: true\n  url: "http://ada-daemon.example.net:7438"\n' }, bea: { yaml: 'revien:\n  enabled: false\n' } });
    const ada = load({ revien: { enabled: false } }, root, 'ada');
    expect(ada.revien.enabled).toBe(true);
    expect(ada.revien.url).toBe('http://ada-daemon.example.net:7438');
    expect(load({}, root, 'bea').revien.enabled).toBe(false);
  });

  it('tenancy off is unchanged: the shipped default stays on and the single-tenant config keeps its Revien block', () => {
    expect(mergeConfigDefaults({}).revien).toEqual({ enabled: true, url: 'http://127.0.0.1:7437', recall_limit: 6, timeout_ms: 2500 });
  });

  it('with one daemon and no tenant scope, tenant A\'s turn is never recalled for tenant B (B is off, and sends nothing)', async () => {
    const seen: { path: string; body: string }[] = [];
    const store: string[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        seen.push({ path: String(req.url), body: b });
        const body = JSON.parse(b || '{}');
        if (req.url === '/v1/ingest') store.push(body.content);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.url === '/v1/recall' ? { results: store.map((content) => ({ content })) } : { ok: true }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const root = makeTenantsDir({ ada: { yaml: `revien:\n  enabled: true\n  url: ${JSON.stringify(url)}\n` }, bea: {} });
      const file = { revien: { url: 'http://operator-daemon.example.net:7437' } }; // the operator's own daemon (not ada's address); neither tenant inherits it
      enableTenancy(true);
      const A = fakeRuntime('ada', { config: load(file, root, 'ada') });
      const B = fakeRuntime('bea', { config: load(file, root, 'bea') });
      await runInTenant(A, () => ingestTurn({ threadId: 't1', user: 'ada private diagnosis', assistant: 'noted' }));
      expect(store).toHaveLength(1); // A, which turned Revien on with its own address, did reach it
      const before = seen.length;
      const got = await runInTenant(B, () => recallForPrompt('diagnosis'));
      await runInTenant(B, () => ingestTurn({ threadId: 't2', user: 'bea words', assistant: 'ok' }));
      expect(got).toBe('');
      expect(seen.length).toBe(before); // B never contacted the daemon at all
    } finally { await new Promise((r) => srv.close(r)); }
  });
});

describe('two tenants on one Revien address', () => {
  const cfgOf = (url: string, enabled = true) => ({ revien: { enabled, url, recall_limit: 6, timeout_ms: 2500 } }) as unknown as SanctumConfig;

  it('both are parked (enabled forced off), one line each naming the other tenant, no address in the line; a tenant on its own address keeps Revien', () => {
    const tenants = [
      { id: 'ada', config: cfgOf('http://127.0.0.1:7438') }, { id: 'bea', config: cfgOf('http://127.0.0.1:7438/') },
      { id: 'cy', config: cfgOf('http://127.0.0.1:7439') }, { id: 'di', config: cfgOf('http://127.0.0.1:7438', false) },
    ];
    expect([...revienClashes(tenants).entries()]).toEqual([['ada', ['bea']], ['bea', ['ada']]]); // (a disabled tenant on the address is no clash)
    const lines: string[] = [];
    parkDuplicateRevien(tenants, (m) => lines.push(m));
    expect(tenants.map((t) => t.config.revien.enabled)).toEqual([false, false, true, false]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/tenant ada: Revien parked.*tenant bea\b/);
    expect(lines[1]).toMatch(/tenant bea: Revien parked.*tenant ada\b/);
    for (const l of lines) { expect(l).not.toMatch(/\n/); expect(l).not.toContain('7438'); }
  });

  it('a reload that moves one tenant onto another\'s address parks the reloaded tenant only: the other tenant\'s config is not touched', () => {
    const other = { id: 'ada', config: cfgOf('http://127.0.0.1:7438') };
    const otherBefore = JSON.stringify(other.config);
    const otherObject = other.config;
    const mine = { id: 'bea', config: cfgOf('http://localhost:7438') };
    const lines: string[] = [];
    reconcileRevienOnReload(mine, [other], (m) => lines.push(m));
    expect(mine.config.revien.enabled).toBe(false);
    expect(other.config).toBe(otherObject);
    expect(JSON.stringify(other.config)).toBe(otherBefore);
    expect(lines).toHaveLength(1);
    const own = { id: 'bea', config: cfgOf('http://127.0.0.1:7440') };
    reconcileRevienOnReload(own, [other], (m) => lines.push(m));
    expect(own.config.revien.enabled).toBe(true);
  });
});
