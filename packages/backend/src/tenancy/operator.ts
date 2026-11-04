// The operator's routes: park and revive one tenant (docs/MULTI-TENANT.md, "Parking a companion"). Tenant mode only.
//
// The gate is the OPERATOR token, never a tenant's: a tenant's internal token (the one its harness children carry) must not be able to switch another
// companion off. The token belongs to the process and lives in `<process data dir>/.operator-token`, which must be a regular file with no group or world
// bits; anything else disables the routes (logged once). The file is read on every request, so deleting it revokes the token at once.
//
// The router sits inside the standard middleware chain (helmet, security headers, rate limiter, cors, body parsers), after tenant resolution has stood aside for
// exactly these paths on a host no tenant owns (`operatorBypassesResolve`). It answers 404, like `internalOnly`, for everything that is not the operator: a
// missing or wrong token, a peer that is not loopback (unless `tenants.operator_routes_remote: true`), a request a tunnel or proxy forwarded, a request that
// resolved to a companion (its host, or its `/c/<id>` prefix), tenancy off.
import crypto from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { tenancyEnabled } from './context.js';
import { hostNamesTenant, requestHost } from './resolve.js';
import { ParkRefusal, parkTenant, reviveTenant, tenantStatuses, type TenantState, type TenantStatus } from './park.js';

const HEADER = 'x-internal-token';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOKEN_FILE = '.operator-token';
/** The paths the operator router owns (spelled exactly so: anything odd goes through tenant resolution and its 400/404). */
const OPERATOR_PATH_RE = /^\/api\/internal\/tenants(\/[a-z0-9][a-z0-9-]{0,31}\/(park|revive)|\/)?$/;

const warned = new Set<string>();
function warnOnce(msg: string): void { if (!warned.has(msg)) { warned.add(msg); console.warn(`[tenancy] ${msg}`); } }

/** The token in `path`, or null (and one log line) when the file is not a regular file, has group or world bits, or is empty. */
function readTokenFile(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) { warnOnce(`${path} is not a regular file; the operator routes are off`); return null; }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      warnOnce(`${path} has group or world permissions (mode ${(st.mode & 0o777).toString(8)}); the operator routes are off until it is chmod 600`);
      return null;
    }
    const t = readFileSync(path, 'utf8').trim();
    return t || null;
  } catch { return null; }
}

/** Make sure the operator token file exists in `dataDir` (created owner-only on first use). An existing file that is not a regular file or is open to group or
 *  world is left alone and refused: the routes are off, and the return is null. */
export function loadOperatorToken(dataDir: string): string | null {
  const path = join(dataDir, TOKEN_FILE);
  let present = false;
  try { lstatSync(path); present = true; } catch { /* absent */ }
  if (present) return readTokenFile(path);
  const secret = crypto.randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, secret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { chmodSync(path, 0o600); } catch { /* advisory on some platforms */ }
  return secret;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** The TCP peer is this machine. Never X-Forwarded-For: a header is whatever the caller sent. */
export function isLoopbackPeer(req: Request): boolean { return LOOPBACK.has(String(req.socket?.remoteAddress ?? '')); }
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cf-connecting-ip', 'x-real-ip'];

/** Tenant resolution stands aside for the operator's own paths on a host that is no companion's (a companion's host, or a `/c/<id>` prefix, is not an operator path). */
export function operatorBypassesResolve(req: Request): boolean {
  const rawPath = String(req.originalUrl ?? req.url ?? '').split('?')[0];
  if (!OPERATOR_PATH_RE.test(rawPath)) return false;
  return !hostNamesTenant(requestHost(req.headers));
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

export interface OperatorRouterOptions {
  /** The process's data folder: where `.operator-token` is. */
  dataDir: string;
  /** `tenants.operator_routes_remote: true`: peers that are not loopback may use the routes (with the token). */
  remote?: boolean;
}

/** The router for `/api/internal/tenants`, gated by the token file in `opts.dataDir`. */
export function operatorRouter(opts: OperatorRouterOptions): Router {
  const router = Router();
  const tokenPath = join(opts.dataDir, TOKEN_FILE);
  const notFound = (res: Response) => { res.status(404).json({ error: 'Not found' }); };
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!tenancyEnabled()) { next('router'); return; } // (leave this router: the path is as unknown as it ever was)
    // Only the operator's own paths, spelled exactly, on no companion's host; a companion's request (req.tenant) is never the operator.
    const rawPath = String(req.originalUrl ?? '').split('?')[0];
    if (req.tenant || !OPERATOR_PATH_RE.test(rawPath)) { notFound(res); return; }
    if (!opts.remote && (!isLoopbackPeer(req) || FORWARDED.some((h) => req.headers[h] !== undefined))) { notFound(res); return; }
    const token = readTokenFile(tokenPath); // (per request: deleting the file revokes at once)
    const given = req.headers[HEADER];
    const value = Array.isArray(given) ? given[0] : given;
    if (!token || !value || !crypto.timingSafeEqual(sha(value), sha(token))) { notFound(res); return; }
    next();
  });
  router.get('/', (_req, res) => { res.json(tenantStatuses()); });
  // `ok` is the state a success ends in; a revive that did not get the tenant up ends in another, which is a 500 with the same body (the line says why).
  const handle = (act: (id: string) => Promise<TenantStatus> | TenantStatus, ok: TenantState) => async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id ?? '');
    if (!ID_RE.test(id)) { res.status(404).json({ error: 'not_found' }); return; }
    try {
      const status = await act(id);
      res.status(status.state === ok ? 200 : 500).json(status);
    } catch (e) {
      if (e instanceof ParkRefusal) { res.status(e.status).json({ error: e.code, message: e.message }); return; }
      next(e);
    }
  };
  router.post('/:id/park', handle(parkTenant, 'parked'));
  router.post('/:id/revive', handle(reviveTenant, 'running'));
  return router;
}
