// The tenant context (docs/MULTI-TENANT.md, option (b)). One request, one tenant, carried in an AsyncLocalStorage store, so
// getDb(), getSanctumConfig() and getInternalToken() answer for the tenant the current request or task belongs to.
//
// The hard rule: with no `tenants:` block nothing in here is ever switched on. tenancyEnabled() stays false, currentTenant() is
// undefined, tenantLocal() is one lazily created module value, and every accessor falls through to the module singleton it always had.
//
// With tenancy on, an accessor called outside any store THROWS (NoTenantContext). It never falls back to the process singleton,
// because falling back is how one tenant's request would read another's database. Process-level code (boot, the listener) uses
// getProcessConfig() and says so.
//
// New API for this lives only in tenancy/: many test files partly mock config.js and db.js, and a new export on either would break
// them. config.ts registers its module config here once (registerProcessConfig) instead of exporting a new accessor.
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { SanctumConfig } from '../config.js';

export interface TenantRuntime {
  id: string;
  /** <tenants.dir>/<id> */
  dir: string;
  /** <dir>/data: the database, token, ledgers, files. */
  dataDir: string;
  /** <dir>/home: agent.cwd by default. */
  homeDir: string;
  /** <dir>/private: discord.private_dir by default. */
  privateDir: string;
  /** Lower-cased hostnames this tenant answers to. */
  hosts: string[];
  /** This tenant's config: defaults, tenant.yaml, the tenant's own .env. Never the process's. */
  config: SanctumConfig;
  /** The tenant's own .env, parsed. process.env is never written to. */
  env: Record<string, string>;
  db: BetterSqlite3.Database;
  /** The tenant's internal token (x-internal-token). */
  token: string;
  /** Per-tenant values behind tenantLocal(). */
  locals: Map<symbol, unknown>;
  /** Per-tenant services (later stages). */
  services: Record<string, unknown>;
  /** What this tenant's files say about Revien (`enabled`, `url`), captured when its config loads. The clash parking reads this, never `config.revien`
   *  (parking changes that). */
  revienConfigured?: { enabled: boolean; url: string };
  /** The other tenants whose configured Revien address this tenant's clashes with (it is parked while this is not empty). */
  revienParkedBy?: string[];
  /** Read this tenant's tenant.yaml and .env again (the setup wizard calls it after writing them): loadTenantConfig, the folder confinement and
   *  the layout check run first, and a tenant that would be skipped at boot keeps its old config and the call throws. Touches no other tenant.
   *  What the process captured at boot for it (its hosts, its started services) waits for a restart. */
  reload(): void;
  /** Hand this tenant's login password to its config at once (the wizard has just written it to the tenant's .env). Never an environment.
   *  Household mode: a no-op that answers with a sentence for the wizard's notes (the house has one password). */
  setPassword(password: string): string | void;
}

/** Thrown when tenancy is on and something asks for tenant state outside any tenant's request or task. */
export class NoTenantContext extends Error {
  constructor(what = 'tenant state') {
    super(`${what} was asked for outside a tenant context (tenancy is on and nothing entered a tenant)`);
    this.name = 'NoTenantContext';
  }
}

/** The id of the scope the house's own code runs in (the house first-run's setup code lives in tenantLocal state, which needs a store). It fails the tenant
 *  id regex, so no tenant folder can ever carry it. */
export const HOUSE_SCOPE_ID = '*house*';

const als = new AsyncLocalStorage<TenantRuntime>();
let enabled = false;

/** Switched on once, at boot, by bootTenants. Never switched on by a config with no `tenants:` block. */
export function enableTenancy(on = true): void { enabled = on; }
export function tenancyEnabled(): boolean { return enabled; }

/** The tenant the current request or task belongs to; undefined with tenancy off or outside any store. */
export function currentTenant(): TenantRuntime | undefined {
  return enabled ? als.getStore() : undefined;
}

/** For the accessors. Tenancy off: null (use the module singleton). Tenancy on: the current tenant, or throw. */
export function tenantOrNull(what: string): TenantRuntime | null {
  if (!enabled) return null;
  const rt = als.getStore();
  if (!rt) throw new NoTenantContext(what);
  return rt;
}

/** Run fn with `rt` as the current tenant. */
export function runInTenant<T>(rt: TenantRuntime, fn: () => T): T {
  return als.run(rt, fn);
}

/** fn, wrapped so every call runs in `rt` (for timers, cron ticks and listeners made outside a request). */
export function bindTenant<A extends unknown[], R>(rt: TenantRuntime, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => als.run(rt, () => fn(...args));
}

/** fn bound to the tenant that is current now, for a timer, cron tick or listener created inside a tenant but fired from outside any store.
 *  Tenancy off, or no tenant current: fn itself, unchanged. */
export function bindCurrentTenant<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const rt = currentTenant();
  return rt ? bindTenant(rt, fn) : fn;
}

export interface TenantLocal<T> { get(): T; set(value: T): void; reset(): void }

/** A module-level value that must not cross tenants (a cache over one database, a key held in memory).
 *  Tenancy off: one lazily created value for the process, as before. On, inside a tenant: one per runtime, kept in rt.locals.
 *  On, outside any tenant: throws NoTenantContext. */
export function tenantLocal<T>(init: () => T): TenantLocal<T> {
  const key = Symbol('tenantLocal');
  let moduleValue: { v: T } | null = null;
  return {
    get(): T {
      const rt = tenantOrNull('a tenant-local value');
      if (!rt) {
        if (!moduleValue) moduleValue = { v: init() };
        return moduleValue.v;
      }
      if (!rt.locals.has(key)) rt.locals.set(key, init());
      return rt.locals.get(key) as T;
    },
    set(value: T): void {
      const rt = tenantOrNull('a tenant-local value');
      if (!rt) { moduleValue = { v: value }; return; }
      rt.locals.set(key, value);
    },
    reset(): void {
      const rt = tenantOrNull('a tenant-local value');
      if (!rt) { moduleValue = null; return; }
      rt.locals.delete(key);
    },
  };
}

let processFileSource: (() => Record<string, unknown> | null) | null = null;
/** config.ts hands over the parsed sanctum.yaml (the FILE's values, before the environment touched anything) each time it loads one. */
export function registerProcessFile(source: () => Record<string, unknown> | null): void { processFileSource = source; }
/** The operator's sanctum.yaml as read, for tenant inheritance (tenancy/config.ts). null before a config loaded, or with no file. */
export function getProcessFile(): Record<string, unknown> | null { return processFileSource?.() ?? null; }

let processConfigSource: (() => SanctumConfig | null) | null = null;
/** config.ts hands over its module config once, when it is evaluated. */
export function registerProcessConfig(source: () => SanctumConfig | null): void { processConfigSource = source; }
/** The process-level config (server, cors, tenants), never a tenant's. For boot and listener code only. */
export function getProcessConfig(): SanctumConfig {
  const c = processConfigSource?.() ?? null;
  if (!c) throw new Error('Config not loaded. Call loadConfig() first.');
  return c;
}

/** The environment a piece of code may read keys from: the current tenant's own .env in tenant mode (never the process's), else process.env. */
export function envFor(what: string): Record<string, string | undefined> {
  return tenantOrNull(what)?.env ?? process.env;
}

// Every tenant, for the checks that must hold across all of them (the writable-root unions): the booted ones, each entered, and the
// configs of tenants that were skipped at boot, read as loosely as possible so a half-loaded tenant's folders are still off limits.
let allSource: { booted: () => TenantRuntime[]; skipped: () => SanctumConfig[] } = { booted: () => [], skipped: () => [] };
export function registerAllTenants(source: typeof allSource): void { allSource = source; }
/** The tenants that booted (empty with tenancy off). For checks that look at every tenant at once. */
export function bootedTenants(): TenantRuntime[] { return enabled ? allSource.booted() : []; }
/** fn(config) for every booted tenant (run inside that tenant, so its own .env answers) and then for every skipped tenant's declared config
 *  (run where the caller is). Tenancy off: empty, callers use their own config. */
export function mapAllTenants<T>(fn: (cfg: SanctumConfig) => T): T[] {
  if (!enabled) return [];
  return [
    ...allSource.booted().map((rt) => als.run(rt, () => fn(rt.config))),
    ...allSource.skipped().map((cfg) => fn(cfg)),
  ];
}

/** D7: the tenant's home (what git, ssh, gh, npm and every tool that reads ~/ see) and its temp folder, both under data/harness/ and created
 *  0700 (the mode is skipped on Windows). Pure paths: the folders are made by tenantHomeEnv. */
export function tenantHomePaths(rt: Pick<TenantRuntime, 'dataDir'>): { home: string; tmp: string } {
  return { home: join(rt.dataDir, 'harness', 'home'), tmp: join(rt.dataDir, 'harness', 'tmp') };
}

/** The tenant's TMPDIR when a tenant is current (the Codex and dsh temp root); undefined with tenancy off or outside a tenant. */
export function tenantTmpRoot(): string | undefined {
  const rt = currentTenant();
  return rt ? tenantHomePaths(rt).tmp : undefined;
}

/** Operator switch (tenants.background_runs, and a tenant's own background_runs): true when the CURRENT tenant's background model runs (orchestrator
 *  wakes, the outlook author, handoff, the rolling summarizer) are switched off. Tenancy off, or outside a tenant: false, so nothing reads the key. */
export function backgroundRunsOff(): boolean {
  const rt = currentTenant();
  return !!rt && rt.services.backgroundRuns === false;
}
