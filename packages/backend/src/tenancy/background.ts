// The operator's switch for background model runs is a CEILING (docs/CONFIGURATION.md, tenants.background_runs): a tenant can turn background runs off for
// itself, never on when the operator has them off. effective = the process value AND the tenant's own value (each default true).
import type { SanctumConfig } from '../config.js';

// A switch is `true` or `false`: boot and the config writers refuse anything else (`no`, `off`, "false", 0), and a value that gets past them reads as OFF here.
const flag = (v: unknown): boolean | undefined => (v === undefined || v === null ? undefined : v === true);
/** tenants.background_runs in the process config (default true; a non-boolean is refused at boot and reads as off). */
export function operatorAllowsBackground(processCfg: SanctumConfig): boolean {
  return flag(((processCfg as unknown as Record<string, unknown>).tenants as Record<string, unknown> | undefined)?.background_runs) ?? true;
}
/** The tenant's own `background_runs` (its tenant.yaml, as merged into its config), or undefined when it does not say. */
export function tenantBackgroundFlag(tenantCfg: unknown): boolean | undefined {
  return tenantCfg && typeof tenantCfg === 'object' ? flag((tenantCfg as Record<string, unknown>).background_runs) : undefined;
}
/** Whether a tenant's background model runs may run: the operator allows them AND the tenant has not turned them off. */
export function effectiveBackgroundRuns(processCfg: SanctumConfig, tenantCfg: unknown): boolean {
  return operatorAllowsBackground(processCfg) && tenantBackgroundFlag(tenantCfg) !== false;
}

const told = new Set<string>();
/** Test seam: forget which tenants have been told. */
export function resetBackgroundCeilingNotes(): void { told.clear(); }
/** A tenant that asks for `background_runs: true` under an operator `false` is accepted (the file stays as written) and told, once per process and tenant, on the
 *  first of boot, reload or config edit that sees it. Returns true when the line was printed. */
export function noteBackgroundCeiling(id: string, processCfg: SanctumConfig, tenantCfg: unknown): boolean {
  if (operatorAllowsBackground(processCfg) || tenantBackgroundFlag(tenantCfg) !== true || told.has(id)) return false;
  told.add(id);
  console.log(`[tenancy] tenant ${id}: background runs stay off: the operator has them off`);
  return true;
}
