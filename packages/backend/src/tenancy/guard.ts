// Routes that start a model run, read the process's credentials or logs, or hold one shared instance answer 503 in tenant mode until the
// stage that makes them per tenant. Mounted by server.ts only in tenant mode, after tenantEnter, before the routers.
//
// Mounted as ordinary express routes, not tested against a pattern of our own: express matches /api/Outlook and /api/outlook the same
// way for the routers behind these, so the refusal must match exactly as they do.
import type { Express, NextFunction, Request, Response } from 'express';
import { TenantServiceUnavailable } from './errors.js';
import { parse as parseCookie } from 'cookie';
import { tenancyEnabled, currentTenant } from './context.js';
import { tenantWriteRefusal } from './own-files.js';
import { getCookieName, lookupSession } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';

// Stage 3c made Discord, Telegram, the channels routes and internal/telegram-send per tenant (a service per tenant that has a bot token, built
// inside the tenant; the routes read the current tenant's own service from app.locals, and a bot token two tenants share parks both), so the list
// is empty. The machinery stays: a future service that is not per tenant yet adds its prefix here and is refused until it is.
// Stage 3a made the websocket turn, voice, system, sessions and google per tenant. Stage 3b made the scheduler per tenant and took off outlook,
// handoff, mind, home, orchestrator and internal/orchestrator (a scheduler, outlook state, handoff croner, Mind watchdog and push service for each
// tenant, built inside that tenant at boot; every route reads the tenant's own database and config). What is left waits for 3c.
export const REFUSED_PREFIXES: string[] = [];

function refuse(service: string) {
  return (_req: Request, res: Response, _next: NextFunction): void => {
    const err = new TenantServiceUnavailable(service);
    res.status(503).json({ error: 'service_unavailable', service: err.service });
  };
}

const toRegex = (prefix: string) => new RegExp(`^/${prefix.toLowerCase().replace(/:id/g, '[^/]+')}(/|$)`);
// (Read on each call, so the list is the list as it stands, empty or not.)
const refusedRes = () => REFUSED_PREFIXES.map((p) => ({ re: toRegex(p), service: p.split('/')[0] === 'internal' ? p.split('/')[1] : p.split('/')[0] }));

/** The same refusal, inside a router, on the path as that router sees it: repeated slashes collapsed, lower-cased, no trailing slash.
 *  Belt and braces behind the app-level mounts (which cannot see how a router strips and re-reads its mount path). */
export function refuseInTenantMode(req: Request, res: Response, next: NextFunction): void {
  if (!tenancyEnabled()) { next(); return; }
  let path = req.path;
  try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
  path = path.replace(/[\\/]+/g, '/').toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const hit = refusedRes().find((r) => r.re.test(path));
  if (!hit) { next(); return; }
  refuse(hit.service)(req, res, next);
}

/** For a whole router that is off in tenant mode (discord). */
export function refuseAllInTenantMode(_req: Request, res: Response, next: NextFunction): void {
  if (!tenancyEnabled()) { next(); return; }
  res.status(503).json({ error: 'service_unavailable', service: 'discord' });
}

export function mountTenantRefusals(app: Express): void {
  for (const prefix of REFUSED_PREFIXES) app.use(`/api/${prefix}`, refuse(prefix.split('/')[0] === 'internal' ? prefix.split('/')[1] : prefix.split('/')[0]));
}

/** The caller holds this tenant's own login (a live session cookie) or its internal token: the only callers who get a sentence about the tenant's files. */
function holdsTenantAuth(req: Request): boolean {
  const rt = currentTenant();
  if (!rt) return false;
  const cookie = req.headers.cookie;
  if (cookie && rt.config.auth.password) {
    const token = parseCookie(cookie)[getCookieName()];
    const session = token ? lookupSession(token) : undefined;
    if (session && new Date(session.expires_at) >= new Date()) return true;
  }
  let allowed = false;
  internalOnly(req, { status: () => ({ json: () => undefined }) } as unknown as Response, () => { allowed = true; });
  return allowed;
}

/** Tenant mode, every POST/PUT/PATCH/DELETE under /api and /mcp: a tenant whose own files became links (or hard-linked) after boot takes no mutating request,
 *  whichever router it reaches (plugins, identity, setup, google, the MCP endpoints, internal routes). Mounted at app level in server.ts after tenantEnter, so
 *  it sees the tenant, and answers only a caller who passed that tenant's own auth (an anonymous caller is left to the router's own 401/404 and learns nothing
 *  about the folder). This is the SECOND net: the write layer (own-files.ts) is the wall, and a quick check (tenant.yaml, .env, .mcp.json, home/ private/ data/
 *  and the first level of data/ and private/) is all this runs. Tenancy off: a pass-through. */
export function tenantMutationScan(req: Request, res: Response, next: NextFunction): void {
  if (!tenancyEnabled() || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { next(); return; }
  if (!currentTenant() || !holdsTenantAuth(req)) { next(); return; }
  const own = tenantWriteRefusal();
  if (own) { res.status(400).json({ error: own }); return; }
  next();
}
