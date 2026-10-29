// Revien per tenant (docs/MULTI-TENANT.md, "What is shared"). Revien is one daemon with no tenant scope: a request carries no tenant id, so two
// tenants pointed at one daemon would recall each other's memories. In tenant mode revien.enabled is off unless the tenant's own tenant.yaml
// turns it on (tenancy/config.ts), revien.url is never inherited, and a tenant must name its own address, never the process's (the loader parks
// Revien for one that does not). Here, two tenants that are both enabled on the same address are parked (enabled forced off) with one line each
// naming the other tenant ids, the same pattern as a duplicate bot token (channels.ts).
//
// The clash is decided from what each tenant's FILES say (`revienConfigured`, captured when its config loads), never from the effective config,
// which parking itself changes: otherwise a reload would see the other tenant's forced `enabled: false` and revive a tenant that still clashes.
import type { SanctumConfig } from '../config.js';
import { normaliseRevienAddress } from '../../../../scripts/setup-inherit.mjs';

/** What a tenant's files say about Revien (the loader's result, before any clash parking). */
export interface RevienConfigured { enabled: boolean; url: string }

/** What the park logic reads and writes of a tenant (a TenantRuntime has all of it). */
export interface RevienTenant { id: string; config: SanctumConfig; revienConfigured?: RevienConfigured; revienParkedBy?: string[] }

/** The configured Revien settings of a freshly loaded config. */
export const configuredRevien = (cfg: SanctumConfig): RevienConfigured => ({ enabled: cfg.revien?.enabled === true, url: String(cfg.revien?.url ?? '') });

const configuredOf = (t: RevienTenant): RevienConfigured => t.revienConfigured ?? (t.revienConfigured = configuredRevien(t.config));
const addressOf = (c: RevienConfigured): string => normaliseRevienAddress(c.url);

/** For one tenant, the other tenants (ids) whose configured Revien is on at the same address; [] when its own is off or nothing clashes. */
export function revienClashesOf(id: string, tenants: RevienTenant[]): string[] {
  const me = tenants.find((t) => t.id === id);
  if (!me) return [];
  const mine = configuredOf(me);
  if (!mine.enabled || !addressOf(mine)) return [];
  return tenants.filter((o) => o.id !== id && configuredOf(o).enabled && addressOf(configuredOf(o)) === addressOf(mine)).map((o) => o.id).sort();
}

/** For each tenant that has Revien configured on, the other tenants with it on at the same address. Tenants with no clash are absent. */
export function revienClashes(tenants: RevienTenant[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of tenants) { const others = revienClashesOf(t.id, tenants); if (others.length) out.set(t.id, others); }
  return out;
}

const parkedLine = (id: string, others: string[]) => `[tenancy] tenant ${id}: Revien parked, its daemon address is also used by tenant ${others.join(', ')} (one daemon has no tenant scope, so memories would mix; give each tenant its own daemon)`;
const revivedLine = (id: string) => `[tenancy] tenant ${id}: Revien is back on, no other tenant uses its daemon address any more`;

/** Set the effective `revien.enabled` of `subjects` (default: every tenant) from the CONFIGURED values of all `tenants`: parked iff configured on and
 *  another tenant's configured address clashes. Only a subject's own config is written (never another tenant's, and never replaced), one line per
 *  change naming the other tenant ids, never the address. */
export function reconcileRevien(tenants: RevienTenant[], subjects: RevienTenant[] = tenants, log: (m: string) => void = (m) => console.warn(m)): void {
  for (const t of subjects) {
    const others = revienClashesOf(t.id, tenants);
    const before = t.revienParkedBy ?? [];
    t.config.revien.enabled = configuredOf(t).enabled && others.length === 0;
    t.revienParkedBy = others;
    if (JSON.stringify(before) === JSON.stringify(others)) continue;
    log(others.length ? parkedLine(t.id, others) : revivedLine(t.id));
  }
}

/** Boot: park every tenant whose Revien address another configured-on tenant also uses (both sides), one line each. */
export function parkDuplicateRevien(tenants: RevienTenant[], log: (m: string) => void = (m) => console.warn(m)): void {
  reconcileRevien(tenants, tenants, log);
}

/** A reload of one tenant (`mine`: its freshly loaded config, its configured values, the park state it had): its parking is recomputed from every tenant's
 *  configured values. A park lifts only when the clash is gone. The other tenants are read, never written. */
export function reconcileRevienOnReload(mine: RevienTenant, others: RevienTenant[], log: (m: string) => void = (m) => console.warn(m)): void {
  reconcileRevien([...others, mine], [mine], log);
}
