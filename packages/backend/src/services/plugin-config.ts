// Writes plugins.enabled into sanctum.yaml (trust: companion, PUT /api/plugins/enabled). The same
// approach as the settings routes in routes/api.ts: load the file with js-yaml, change the one key, dump
// with the same options; written to a temp file and renamed so a crash leaves the old file whole. The file holds
// secrets, so it is written through its real path (a symlinked sanctum.yaml stays a link), keeps its mode, and the
// previous content is kept as sanctum.yaml.bak (one backup, overwritten each time, same mode).
import { closeSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import yaml from 'js-yaml';
import { CONFIG_FILE_NAMES, PROJECT_ROOT, setPluginsEnabledInMemory } from '../config.js';
import { tenantOrNull, tenancyEnabled } from '../tenancy/context.js';
import { TenantEditRefused, tenantEditRefusal, tenantWriteRefusal } from '../tenancy/edit.js';
import { ownOpenRead, ownWriteFileAtomic } from '../tenancy/own-files.js';

/** The config file now in use (the first of CONFIG_FILE_NAMES that exists), or null. */
export function findConfigFile(): string | null {
  // Tenant mode: the tenant's own tenant.yaml, never the process's sanctum.yaml.
  const tenant = tenantOrNull('findConfigFile');
  if (tenant) {
    const own = join(tenant.dir, 'tenant.yaml');
    return existsSync(own) ? own : null;
  }
  for (const name of CONFIG_FILE_NAMES) {
    const p = resolve(PROJECT_ROOT, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Write `ids` as plugins.enabled in the config file (creating sanctum.yaml when there is none) and into the
 *  running config. Throws when the file cannot be read, parsed or written. */
export function writePluginsEnabled(ids: string[], opts: { memory?: boolean } = {}): void {
  const found = findConfigFile();
  const tenant = tenantOrNull('writePluginsEnabled');
  // A tenant whose tenant.yaml (or data/, .env, ...) became a link is never written, and never followed to what it points at.
  const own = tenant ? tenantWriteRefusal(found ?? join(tenant.dir, 'tenant.yaml')) : null;
  if (own) throw new TenantEditRefused(own);
  let file = found ?? (tenant ? join(tenant.dir, 'tenant.yaml') : join(PROJECT_ROOT, CONFIG_FILE_NAMES[0]));
  let mode = 0o600; // a new file holds secrets too
  let previous: string | null = null;
  if (found) {
    file = realpathSync.native(found);
    const { fd, stat } = ownOpenRead(file, { kind: 'file' }); // (a tenant: one guarded open, a pipe at tenant.yaml is refused, never waited on; tenancy off: the plain open)
    try { mode = stat.mode & 0o777; previous = readFileSync(fd, 'utf-8'); } finally { closeSync(fd); }
  }
  const parsed = (previous !== null ? (yaml.load(previous) as Record<string, any> | null) : null) ?? {};
  // Single-tenant: the operator's file, a plain error (500). Tenant mode: a 400 that names no absolute path.
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw tenancyEnabled() ? new TenantEditRefused(`${basename(file)} is not a YAML map`) : new Error(`${file} is not a YAML map`);
  if (!parsed.plugins || typeof parsed.plugins !== 'object' || Array.isArray(parsed.plugins)) parsed.plugins = {};
  parsed.plugins.enabled = [...ids];
  // Tenant mode: the same refusal the config editor has (nothing outside the tenant folder, no process keys, still loadable).
  const refusal = tenantEditRefusal(parsed, previous ?? '');
  if (refusal) throw new TenantEditRefused(refusal);
  // Each file is written through its own temp file (random name, `wx`) and renamed, so a read-only .bak from an earlier write (the mode is
  // copied from the config) never refuses the next backup, a looser-mode .bak never holds secrets, and (in a tenant folder) neither the
  // config nor its .bak is ever written through a link that is already there.
  if (previous !== null) ownWriteFileAtomic(`${file}.bak`, previous, { mode, encoding: 'utf-8' });
  ownWriteFileAtomic(file, yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true }), { mode, encoding: 'utf-8' });
  if (opts.memory !== false) setPluginsEnabledInMemory(ids);
}
