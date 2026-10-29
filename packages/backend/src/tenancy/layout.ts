// Where tenants sit relative to each other and to the process, checked at boot. A tenant's writable roots (its home, the Codex extra
// directories, the hooks write-gate roots, its plugin root, the sandbox temp folders) must not equal, contain or sit inside another tenant's
// data/, private/, .env or tenant.yaml, nor the process's own sanctum.yaml, .env or data folder: a companion that can write there can
// read or rewrite someone else's state. A tenant that fails is skipped by the caller with one line (its hosts reserved).
import { dirname, join } from 'node:path';
import type { SanctumConfig } from '../config.js';
import { CONFIG_FILE_NAMES, PROJECT_ROOT } from '../config.js';
import { gateInside, realOrResolved } from '../services/plugin-paths.js';
import { shippedRootPath, writableRoots } from '../services/plugins.js';
import { runInTenant, tenantHomePaths, type TenantRuntime } from './context.js';

/** `root` equals or contains `p`, or (both: true) sits inside it too. */
const touches = (root: string, p: string, both: boolean): boolean => {
  const rr = realOrResolved(root);
  const rp = realOrResolved(p);
  return gateInside(rp, rr) || (both && gateInside(rr, rp));
};

/** tenant id -> why it fails, for every tenant whose writable roots touch another tenant's or the process's protected files. */
export function layoutClash(tenants: TenantRuntime[], processCfg: SanctumConfig): Map<string, string> {
  const out = new Map<string, string>();
  // For the process's own files a tenant living UNDER them is fine (tenants.dir may be <project>/data/tenants); only a root that equals or contains one is not.
  const processProtected: Array<[string, string]> = [
    ...CONFIG_FILE_NAMES.map((n): [string, string] => [`the process ${n}`, join(PROJECT_ROOT, n)]),
    ['the process .env', join(PROJECT_ROOT, '.env')],
    ['the process data folder', dirname(processCfg.server.db_path)],
    // Shipped plugin code runs in the shared process for every tenant: a tenant root that could write it is refused at boot.
    ['the shipped plugin root', shippedRootPath()],
  ];
  for (const t of tenants) {
    const roots = runInTenant(t, () => writableRoots(t.config, { pluginsDir: true, tmpRoot: tenantHomePaths(t).tmp }));
    const protectedPaths: Array<[string, string, boolean]> = processProtected.map(([l, p]) => [l, p, false]);
    for (const o of tenants) {
      if (o === t) continue;
      protectedPaths.push(
        [`tenant ${o.id}'s data/`, o.dataDir, true], [`tenant ${o.id}'s private/`, o.privateDir, true],
        [`tenant ${o.id}'s .env`, join(o.dir, '.env'), true], [`tenant ${o.id}'s tenant.yaml`, join(o.dir, 'tenant.yaml'), true],
      );
    }
    for (const r of roots) {
      const hit = protectedPaths.find(([, p, both]) => touches(r.path, p, both));
      if (hit) { out.set(t.id, `writable root ${r.label} (${r.path}) is inside, or contains, ${hit[0]} (${hit[1]})`); break; }
    }
  }
  return out;
}
