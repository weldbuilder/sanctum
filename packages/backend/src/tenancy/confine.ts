// A tenant's files stay in the tenant's folder. Every path a tenant's config names (home, ledgers, private lists, write roots, MCP
// file) must resolve, symlinks included, inside <tenants.dir>/<id>; an absolute path outside it is refused, full stop. Checked when the
// tenant loads (a failing tenant is skipped at boot), when its yaml is edited through the API, and at request time where a path is used.
import { tenantOrNull } from './context.js';
import * as lib from '../../../../scripts/own-files-lib.mjs';

// The lists of path keys live in scripts/own-files-lib.mjs (one list for the backend and the wizard).
const OWNED_SCALARS = lib.OWNED_PATH_SCALARS;
/** Files that ship with the app: fine as the app's defaults, but a tenant naming its own must name one in its folder (config.ts defaults them to the app's). */
export const SHIPPED_SCALARS: readonly string[] = lib.SHIPPED_PATH_SCALARS;
const OWNED_LISTS = lib.OWNED_PATH_LISTS;

const dig = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

/** `p` (absolute, or relative to `dir`) is inside `dir`: really (symlinks followed, as far as the path exists, from the real path of its deepest existing
 *  ancestor) AND spelled as inside it. A path that reaches the folder by another spelling (/proc/self/root<real>/..., a case-only spelling, a path through a
 *  second link) is refused, not accepted; so is a `..` in the part that does not exist yet. */
export function isInsideDir(dir: string, p: string): boolean { return lib.namedPathInsideTenant(dir, p); }

/** The keys in `cfg` (a resolved config or a raw tenant.yaml object) that name a path outside `tenantDir`. */
export function pathProblems(cfg: unknown, tenantDir: string, opts: { shipped: boolean }): string[] {
  const bad: string[] = [];
  for (const k of [...OWNED_SCALARS, ...(opts.shipped ? SHIPPED_SCALARS : [])]) {
    const v = dig(cfg, k);
    if (typeof v === 'string' && v.trim() && !isInsideDir(tenantDir, v.trim())) bad.push(k);
  }
  for (const k of OWNED_LISTS) {
    const raw = dig(cfg, k);
    const v = typeof raw === 'string' ? [raw] : raw; // the string form is one entry
    if (Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim() && !isInsideDir(tenantDir, x.trim()))) bad.push(k);
  }
  return bad;
}

/** Request-time check: with a tenant current, `p` must be inside its folder. Without tenancy, always true. */
export function insideCurrentTenant(p: string): boolean {
  const rt = tenantOrNull('a tenant path');
  return rt ? isInsideDir(rt.dir, p) : true;
}

const PROCESS_ONLY = ['server', 'cors', 'tenants', 'updates'];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Why a tenant may not save `incoming` over `current` (both parsed tenant.yaml objects), or null. The tenant API refuses what would stop the
 *  process booting or reach outside the tenant: process-only keys, its hosts, its timezone, a path outside its folder. */
export function tenantYamlEditProblem(incoming: unknown, current: unknown, tenantDir: string): string | null {
  for (const k of PROCESS_ONLY) {
    if (dig(incoming, k) !== undefined && !same(dig(incoming, k), dig(current, k))) return `${k} belongs to the process and cannot be set from a tenant`;
  }
  if (!same(dig(incoming, 'hosts'), dig(current, 'hosts'))) return 'hosts cannot be changed from inside a tenant';
  if (!same(dig(incoming, 'identity.timezone'), dig(current, 'identity.timezone'))) return 'identity.timezone cannot be changed from inside a tenant (one process runs on one clock)';
  const bad = pathProblems(incoming, tenantDir, { shipped: true });
  if (bad.length) return `${bad.join(', ')} must be inside the tenant folder`;
  return null;
}
