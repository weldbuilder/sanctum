// One request, one tenant, decided once at the edge (docs/MULTI-TENANT.md, "Resolution"; decision D1).
import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { runInTenant, type TenantRuntime } from './context.js';
import { nonceExists, parseTenantState } from './google-state.js';
import { houseCompanionIds, householdMode } from './house.js';

declare module 'express-serve-static-core' {
  interface Request { tenant?: TenantRuntime }
}

interface Registry { tenants: Map<string, TenantRuntime>; byHost: Map<string, TenantRuntime>; defaultId?: string }
let registry: Registry = { tenants: new Map(), byHost: new Map() };
// Hosts that belong to a tenant that did not start, or that two tenants claimed: they answer 503, never another tenant or the default.
let reserved = new Set<string>();
export function setReservedHosts(hosts: Iterable<string>): void { reserved = new Set([...hosts].map((h) => h.toLowerCase())); }
export function isReservedHost(host: string): boolean { return reserved.has(host); }
/** The host belongs to a companion (running, or reserved for one that is not): per-tenant mode only, household mode serves no host. */
export function hostNamesTenant(host: string): boolean { return registry.byHost.has(host) || reserved.has(host); }

/** Set once at boot with every tenant. Hosts were checked unique before this. */
export function setTenantRegistry(tenants: Map<string, TenantRuntime>, defaultId?: string): void {
  const byHost = new Map<string, TenantRuntime>();
  // Household mode: companions are told apart by path prefix; hosts and `tenants.default` are not read (no fail-open: the hallway chooses).
  if (!householdMode()) for (const rt of tenants.values()) for (const h of rt.hosts) byHost.set(h.toLowerCase(), rt);
  registry = { tenants, byHost, defaultId: householdMode() ? undefined : defaultId };
}

/** Household mode: the companion `id` names. `rt` when it is running, `unavailable` when a folder of that name was found at boot but did not start
 *  (skipped, reserved, parked), null when there is no such folder. */
export type CompanionLookup = { rt: TenantRuntime } | { unavailable: true } | null;
export function householdCompanion(id: string): CompanionLookup {
  const rt = registry.tenants.get(id);
  if (rt) return { rt };
  return houseCompanionIds().includes(id) ? { unavailable: true } : null;
}

/** `/c/<id>` then nothing or `/...`: the one path prefix household mode reads. The id is a tenant id (isTenantId's pattern). */
const COMPANION_PREFIX_RE = /^\/c\/([a-z0-9][a-z0-9-]{0,31})(\/.*)?$/;
/** The companion id and the rest of the path (`/` when there is none) for a household path, or null when it has no prefix. */
export function splitCompanionPath(path: string): { id: string; rest: string } | null {
  const m = COMPANION_PREFIX_RE.exec(path);
  return m ? { id: m[1], rest: m[2] ?? '/' } : null;
}

/** The house routes: the only paths that resolve with no companion in household mode. Everything else under /api or /mcp needs a prefix (or the internal
 *  token). Not under /api or /mcp (static assets, the page, the service worker, the manifest) is not a route and passes through to the static layer. */
export function isHouseRoute(path: string): boolean {
  const p = path.toLowerCase().replace(/\/+$/, '');
  if (p === '/api' || p.startsWith('/api/')) {
    return p.startsWith('/api/auth/') || p === '/api/companions' || p === '/api/health' || p === '/api/version' || p === '/api/push/vapid-public' || p === '/api/setup' || p.startsWith('/api/setup/') || p.startsWith('/api/house/');
  }
  return !(p === '/mcp' || p.startsWith('/mcp/'));
}

/** The host a request was addressed to. The LAST X-Forwarded-Host entry (the one the single trusted proxy hop appended; earlier entries
 *  are whatever the client sent), else Host. Lower-cased, port stripped, IPv6 brackets kept. Never req.hostname: Express 4 takes the
 *  FIRST entry, which the client controls. */
export function requestHost(headers: IncomingHttpHeaders): string {
  const fwd = headers['x-forwarded-host'];
  const entries = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const raw = entries.length ? entries[entries.length - 1] : (headers.host ?? '').trim();
  const host = raw.toLowerCase().replace(/\.$/, '').replace(/\.(:\d*)$/, '$1'); // a trailing dot is the same host
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end < 0 ? host : host.slice(0, end + 1);
  }
  return host.replace(/:\d*$/, '');
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

/** The tenant for a request, or null (a 404). A token resolves by token; a Host that also names a tenant must be the same one.
 *  A browser request (no token) resolves by hostname; an unclaimed host gets tenants.default, or null. */
export function resolveTenant({ host, token }: { host: string; token?: string | null }): TenantRuntime | null {
  const named = registry.byHost.get(host) ?? null;
  if (token) {
    const given = sha(token);
    let found: TenantRuntime | null = null;
    for (const rt of registry.tenants.values()) {
      if (crypto.timingSafeEqual(given, sha(rt.token)) && !found) found = rt;
    }
    if (!found) return null;
    if (named && named !== found) return null;
    return found;
  }
  if (named) return named;
  return registry.defaultId ? registry.tenants.get(registry.defaultId) ?? null : null;
}

const isGoogleCallback = (rawPath: string): boolean => rawPath.replace(/\/+$/, '').toLowerCase() === '/api/google/auth/callback';

function resolveByGoogleState(host: string, state: unknown): TenantRuntime | null {
  const parsed = parseTenantState(state);
  if (!parsed) return null;
  const rt = registry.tenants.get(parsed.tenantId) ?? null;
  if (!rt) return null;
  const named = registry.byHost.get(host) ?? null;
  if (named && named !== rt) return null;
  return runInTenant(rt, () => nonceExists(parsed.nonce)) ? rt : null;
}

/** First middleware in the stack (before helmet and static): sets req.tenant or answers 404. */
export function tenantResolve(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-internal-token'];
  const token = Array.isArray(header) ? header[0] : header;
  // A path that spells itself oddly (//, /./, /../, backslashes, encoded slashes) is routed by the routers in ways a prefix check does not
  // see; no real client sends one, so tenant mode refuses it outright.
  const rawPath = String(req.originalUrl ?? req.url ?? '').split('?')[0];
  if (/\/\/|\/\.\.?(\/|$)|\\|%2f|%5c/i.test(rawPath)) { res.status(400).json({ error: 'bad_path' }); return; }
  if (householdMode()) { resolveHousehold(req, res, next, token ?? null, rawPath); return; }
  const host = requestHost(req.headers);
  if (isReservedHost(host)) { res.status(503).json({ error: 'tenant_unavailable' }); return; }
  // D6: Google's redirect returns on localhost with no tenant host and no token, so the tenant comes from the OAuth `state` (a tenant id and a
  // nonce that tenant's own database must know). A host that names a tenant must agree with the state; any mismatch, unknown tenant or unknown
  // nonce is a 404. google-auth.ts checks the state again inside the tenant and spends the nonce.
  const rt = !token && isGoogleCallback(rawPath) ? resolveByGoogleState(host, req.query.state) : resolveTenant({ host, token });
  if (!rt) { res.status(404).json({ error: 'Not found' }); return; }
  req.tenant = rt;
  next();
}

/** Household mode: the companion comes from the `/c/<id>` path prefix (never a host), which is stripped from req.url (req.originalUrl keeps it). An internal token
 *  still resolves its own companion with no prefix; with a prefix both must name the same one. Unprefixed, only the house routes (and the Google callback,
 *  whose `state` names the companion) get through with no companion. */
function resolveHousehold(req: Request, res: Response, next: NextFunction, token: string | null, rawPath: string): void {
  const split = splitCompanionPath(rawPath);
  if (split) {
    const found = householdCompanion(split.id);
    if (!found) { res.status(404).json({ error: 'Not found' }); return; }
    if ('unavailable' in found) { res.status(503).json({ error: 'tenant_unavailable' }); return; }
    if (token) {
      const byToken = resolveTenant({ host: '', token });
      if (byToken !== found.rt) { res.status(404).json({ error: 'Not found' }); return; }
    }
    const url = String(req.url ?? '');
    const q = url.indexOf('?');
    req.url = split.rest + (q < 0 ? '' : url.slice(q)); // (rest starts with a single slash: the bad_path check refused `//` before this)
    req.tenant = found.rt;
    next();
    return;
  }
  if (token) {
    const rt = resolveTenant({ host: '', token });
    if (!rt) { res.status(404).json({ error: 'Not found' }); return; }
    req.tenant = rt;
    next();
    return;
  }
  if (isGoogleCallback(rawPath)) {
    const rt = resolveByGoogleState('', req.query.state);
    if (!rt) { res.status(404).json({ error: 'Not found' }); return; }
    req.tenant = rt;
    next();
    return;
  }
  if (isHouseRoute(rawPath)) { next(); return; }
  res.status(404).json({ error: 'companion_required' });
}

/** Enter the request's tenant for everything after this. Installed again after any middleware that calls next() from a stream event
 *  (body parsers, multer), because those callbacks run outside the store the request started in. */
export function tenantEnter(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenant) { next(); return; }
  // Resolved before a park, entered after it (a slow body, a queue): no longer running, so 503 before anything reads its (closed) database.
  if (req.tenant.leaving || req.tenant.parked) { res.status(503).json({ error: 'tenant_unavailable' }); return; }
  const rt = req.tenant;
  // A handler that caught a "database is closed" error and answered 500 while this companion was parked answers 503, as a request that came later would.
  if (typeof res.status === 'function') {
    const status = res.status.bind(res);
    res.status = ((code: number) => status(code === 500 && rt.parked ? 503 : code)) as typeof res.status;
  }
  runInTenant(rt, next);
}
