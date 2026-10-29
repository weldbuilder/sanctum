/** Pure helpers for the one read-only line Settings shows in tenant mode: GET /api/tenant answers { hosts, dir } for the tenant asking, and
 *  404 on a single-user install (the route is not mounted there), where the line is not drawn. */

export interface TenantInfo { hosts: string[]; dir: string }

/** The answer of GET /api/tenant, or null for anything that is not one. */
export function parseTenant(v: unknown): TenantInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.dir !== 'string' || !o.dir || !Array.isArray(o.hosts) || !o.hosts.every((h) => typeof h === 'string')) return null;
  return { hosts: o.hosts as string[], dir: o.dir };
}

/** "Served at <host>; data in <dir>", or null (no line) when there is no tenant information. A tenant with no hostname says only where its data is. */
export function tenantLine(info: TenantInfo | null): string | null {
  if (!info) return null;
  return info.hosts.length ? `Served at ${info.hosts.join(', ')}; data in ${info.dir}` : `Data in ${info.dir}`;
}

/** Read it: null on a 404 (not tenant mode), a failed request or a malformed answer. Never throws. */
export async function loadTenantInfo(base: string, fetcher: typeof fetch = fetch): Promise<TenantInfo | null> {
  try {
    const res = await fetcher(`${base}/api/tenant`);
    if (!res.ok) return null;
    return parseTenant(await res.json());
  } catch { return null; }
}
