// applyAuthToEnv() used to write process.env (ANTHROPIC_API_KEY, the OAuth token), which is every tenant's environment at once. Stage 2b
// makes it return the overrides for ONE run's child env; every caller merges them into that run's env (tenancy/child.ts runEnvOption) and
// process.env is never written. This pins that: the callers, the merge, process.env untouched, and one tenant's key never in another's run.
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTenants } from './boot.js';
import { enableTenancy } from './context.js';
import { setTenantRegistry } from './resolve.js';
import { mountTenantRefusals, REFUSED_PREFIXES } from './guard.js';
import { makeTenantsDir, processConfigFor, safeTenancyProcess, stopBootedTenants } from './test-runtime.js';
import { runInTenant } from './context.js';
import { withRunEnv } from './child.js';
import { applyAuthToEnv, updateAuthPreferences } from '../services/auth-preferences.js';

const SRC = resolve(__dirname, '..');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

afterEach(async () => { await stopBootedTenants(); enableTenancy(false); setTenantRegistry(new Map()); vi.restoreAllMocks(); });

describe('applyAuthToEnv per run', () => {
  it('has exactly these callers, and each merges the result into its own run env (a new caller, or one that drops the merge, fails here)', () => {
    const callers = walk(SRC)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /\bapplyAuthToEnv\(\)/.test(readFileSync(f, 'utf8')) && !f.endsWith(`${sep}auth-preferences.ts`))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .sort();
    expect(callers).toEqual([
      'services/agent.ts', // the per-tenant agent service
      'services/digest.ts', // the orchestrator's digest: no orchestrator in tenant mode yet
      'services/discord/public-runtime.ts', // Discord: /api/discord and the bot are off
      'services/handoff.ts', // /api/handoff is refused, the schedule is not started
      'services/outlook-author.ts', // /api/outlook is refused, the author is not started
      'tenancy/child.ts', // childRunBase(): the same choice applied to the base of Codex, dsh and the rolling summarizer
    ]);
    for (const f of callers.filter((c) => c !== 'tenancy/child.ts')) {
      const text = readFileSync(join(SRC, f), 'utf8');
      expect(text, f).toMatch(/const authEnv = applyAuthToEnv\(\)/);
      expect(text, f).toMatch(/\.\.\.runEnvOption\(authEnv\)/);
    }
    // And nothing in services/ writes the auth variables into process.env any more (routes/setup.ts is the first-run wizard, a process-level act).
    const writers = walk(join(SRC, 'services')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith(`${sep}auth-preferences.ts`))
      .filter((f) => /process\.env\.(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\s*=[^=]|delete process\.env\.(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)/.test(readFileSync(f, 'utf8')));
    expect(writers).toEqual([]);
    // auth-preferences.ts is the one writer, and only with tenancy off (the old behaviour, exactly).
    expect(readFileSync(join(SRC, 'services/auth-preferences.ts'), 'utf8')).toMatch(/if \(!tenancyEnabled\(\)\) \{\s*for \(const \[k, v\] of Object\.entries\(overrides\)\)/);
  });

  it('process.env is deep-equal before and after a run that applies auth preferences; each run env carries its own tenant\'s keys', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'P-process';
    const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({
      ada: { yaml: 'hosts: [ada.example.net]\n', env: 'ANTHROPIC_API_KEY=T-ada-env\n' },
      bea: { yaml: 'hosts: [bea.example.net]\n', env: 'ANTHROPIC_API_KEY=T-bea-env\n' },
    }) };
    const runtimes = bootTenants(express(), safeTenancyProcess(cfg));
    try {
      const before = JSON.stringify(Object.entries(process.env).sort());
      const [ada, bea] = [runtimes.get('ada')!, runtimes.get('bea')!];
      runInTenant(ada, () => updateAuthPreferences({ auth_mode: 'api_key', api_key: 'K-ada-saved' }));
      const adaRun = runInTenant(ada, () => withRunEnv(applyAuthToEnv())!);
      const beaRun = runInTenant(bea, () => withRunEnv(applyAuthToEnv())!); // subscription (the default): no key at all
      expect(adaRun.ANTHROPIC_API_KEY).toBe('K-ada-saved');
      expect(beaRun.ANTHROPIC_API_KEY).toBeUndefined();
      expect(JSON.stringify(Object.entries(process.env).sort())).toBe(before);
      expect(process.env.ANTHROPIC_API_KEY).toBe('P-process');
      for (const env of [adaRun, beaRun]) expect(Object.values(env)).not.toContain('P-process');
      expect(Object.values(adaRun)).not.toContain('T-bea-env');
    } finally {
      for (const rt of runtimes.values()) rt.db.close();
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('the routes into the still-refused callers answer 503 in tenant mode, and process.env is untouched', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = JSON.stringify(Object.entries(process.env).sort());
    const cfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    (cfg as unknown as { tenants: unknown }).tenants = { dir: makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n' } }) };
    const app = express();
    const runtimes = bootTenants(app, safeTenancyProcess(cfg));
    // (3c emptied the list; the guard is exercised with the prefixes it was written for, taken out again in the finally.)
    const previous = REFUSED_PREFIXES.splice(0, REFUSED_PREFIXES.length, 'telegram', 'channels', 'internal/telegram-send', 'discord');
    mountTenantRefusals(app);
    const server = await new Promise<http.Server>((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const port = (server.address() as AddressInfo).port;
    const hit = (method: string, path: string) => new Promise<number>((ok, fail) => {
      const r = http.request({ host: '127.0.0.1', port, method, path }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode ?? 0)); });
      r.on('error', fail); r.end();
    });
    try {
      for (const [m, p] of [['POST', '/api/telegram/anything'], ['GET', '/api/channels/status'], ['POST', '/api/internal/telegram-send'], ['POST', '/api/discord/anything']] /* (3b: handoff, outlook and orchestrator are live per tenant; these are still refused) */) {
        expect(await hit(m, p)).toBe(503);
      }
      for (const name of ['telegramService', 'discordService']) expect(() => (app.locals as Record<string, unknown>)[name]).toThrow(/outside a tenant context/); // (per tenant since 3c: outside a tenant it throws, never another's)
      expect(JSON.stringify(Object.entries(process.env).sort())).toBe(before);
    } finally {
      REFUSED_PREFIXES.splice(0, REFUSED_PREFIXES.length, ...previous);
      await new Promise<void>((ok) => server.close(() => ok()));
      for (const rt of runtimes.values()) rt.db.close();
    }
  });
});
