// One tenant's runtime: its config, its database file, its internal token. Built once at boot (docs/MULTI-TENANT.md, "State").
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SanctumConfig } from '../config.js';
import { openDb } from '../services/db.js';
import { bootedTenants, getProcessConfig, runInTenant, type TenantRuntime } from './context.js';
import { retireLegacyModelRow } from '../services/settings/index.js';
import { loadTenantConfig } from './config.js';
import { TenantEditRefused, ownMkdirIn, ownWriteFileIn, readOwnTextIn } from './own-files.js';
import { layoutClash } from './layout.js';
import { configuredRevien, reconcileRevienOnReload } from './revien.js';
import { noteBackgroundCeiling } from './background.js';
import { housePassword, householdMode } from './house.js';
import { syncBackgroundRuns } from './background-sync.js';

/** Read the tenant's token from <data>/.internal-token, creating it (owner-only) on first use. */
function loadOrCreateToken(tenantDir: string, dataDir: string): string {
  const path = join(dataDir, '.internal-token');
  try {
    if (existsSync(path)) {
      const existing = readOwnTextIn(tenantDir, path).trim(); // (the guarded open: a pipe or a link at the token file is refused, never waited on)
      if (existing) return existing;
    }
  } catch (e) { if (e instanceof TenantEditRefused) throw e; /* anything else: fall through and make a new one */ }
  const secret = crypto.randomBytes(32).toString('hex');
  ownWriteFileIn(tenantDir, path, secret, { encoding: 'utf8', mode: 0o600 }); // (owner-only: the temp file is made 0600 before the rename)
  return secret;
}

/** Build the runtime for the tenant folder `dir`. Throws on anything that would let two tenants share state or one tenant borrow the process's. */
export function createTenantRuntime(
  processCfg: SanctumConfig,
  id: string,
  dir: string,
  processEnv: Record<string, string | undefined> = process.env,
  household = false,
): TenantRuntime {
  // One INTERNAL_TOKEN for the process would be every tenant's token: the per-tenant gate would be one shared gate.
  if (processEnv.INTERNAL_TOKEN) throw new Error('INTERNAL_TOKEN is set in the process environment; in tenant mode each tenant has its own token in <tenant>/data/.internal-token, so unset it');
  const tenantDir = resolve(dir);
  const { config, env, hosts, file } = loadTenantConfig(processCfg, tenantDir, id);

  const dataDir = join(tenantDir, 'data');
  if (process.platform === 'win32') ownMkdirIn(tenantDir, dataDir, { recursive: true });
  else ownMkdirIn(tenantDir, dataDir, { recursive: true, mode: 0o700 });

  const db = openDb(config.server.db_path);
  // The same purge the process does at boot; on the tenant's own handle, before the tenant is entered.
  db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(new Date().toISOString());

  const rt: TenantRuntime = {
    id, dir: tenantDir, dataDir, homeDir: config.agent.cwd, privateDir: config.discord.private_dir,
    hosts, config, env, file, db, token: loadOrCreateToken(tenantDir, dataDir), locals: new Map(), services: {}, revienConfigured: configuredRevien(config),
    reload() {
      // Everything the tenant would have to pass at boot, on the files as they are now: the config and its folder confinement (loadTenantConfig),
      // then where its writable roots sit against the other tenants and the process. Any failure leaves the config it has; no other tenant is touched.
      const process_ = getProcessConfig();
      const loaded = loadTenantConfig(process_, tenantDir, id);
      const others = bootedTenants().filter((t) => t.id !== id);
      const clash = layoutClash([...others, { ...rt, config: loaded.config, env: loaded.env, homeDir: loaded.config.agent.cwd, privateDir: loaded.config.discord.private_dir }], process_).get(id);
      if (clash) throw new Error(`tenant ${id}: ${clash}`);
      // Parking is recomputed from what every tenant's files say (the other tenants' effective config is not an input: parking changes it).
      const mine = { id, config: loaded.config, revienConfigured: configuredRevien(loaded.config), revienParkedBy: rt.revienParkedBy };
      reconcileRevienOnReload(mine, others);
      rt.revienConfigured = mine.revienConfigured;
      rt.revienParkedBy = mine.revienParkedBy;
      noteBackgroundCeiling(id, process_, loaded.config); // (a tenant.yaml that says true under an operator false is accepted and told once; it stays off)
      rt.config = loaded.config;
      if (householdMode()) rt.config.auth.password = housePassword(); // (a tenant .env APP_PASSWORD is not a login here)
      rt.env = loaded.env;
      rt.file = loaded.file;
      rt.homeDir = loaded.config.agent.cwd;
      rt.privateDir = loaded.config.discord.private_dir;
      syncBackgroundRuns(rt, process_);
      if (!household && JSON.stringify(loaded.hosts) !== JSON.stringify(rt.hosts)) console.warn(`[tenancy] tenant ${id}: hosts changed in tenant.yaml; they take effect at the next start`);
    },
    setPassword(password: string) {
      if (household || householdMode()) return 'The house has one password, so this companion keeps none of its own: the password answer was ignored.';
      rt.config.auth.password = password;
    },
  };
  runInTenant(rt, () => retireLegacyModelRow()); // the row /model used to write: named once, deleted
  return rt;
}

/** Two tenants with one token would answer to each other's internal calls. */
export function checkDistinctTokens(runtimes: { id: string; token: string }[]): void {
  const seen = new Map<string, string>();
  for (const r of runtimes) {
    const prior = seen.get(r.token);
    if (prior !== undefined) throw new Error(`tenants ${prior} and ${r.id} have the same internal token; each needs its own <tenant>/data/.internal-token`);
    seen.set(r.token, r.id);
  }
}
