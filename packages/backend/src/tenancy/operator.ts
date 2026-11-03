// The operator's routes: park and revive one tenant (docs/MULTI-TENANT.md, "Parking a companion"). Tenant mode only.
//
// The gate is the OPERATOR token, never a tenant's: a tenant's internal token (the one its harness children carry) must not be able to switch another
// companion off, so these routes are mounted before tenant resolution and compare the header against a token that belongs to the process, kept in
// `<process data dir>/.operator-token` (next to house.db, created owner-only at boot). Missing header: 401. Wrong one: 403. Tenancy off: the router is not
// mounted, and if it were it stands aside (next()), so the paths are as unknown as ever.
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { tenancyEnabled } from './context.js';
import { ParkRefusal, parkTenant, reviveTenant, tenantStatuses, type TenantState, type TenantStatus } from './park.js';

const HEADER = 'x-internal-token';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The operator token in `dataDir`, created (owner-only) on first use. */
export function loadOperatorToken(dataDir: string): string {
  const path = join(dataDir, '.operator-token');
  try {
    if (existsSync(path)) { const t = readFileSync(path, 'utf8').trim(); if (t) return t; }
  } catch { /* fall through and make a new one */ }
  const secret = crypto.randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, secret, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* advisory on some platforms */ }
  return secret;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

/** The router for `/api/internal/tenants`, gated by `token`. */
export function operatorRouter(token: string): Router {
  const router = Router();
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!tenancyEnabled()) { next('router'); return; } // (leave this router: the path is as unknown as it ever was)
    const given = req.headers[HEADER];
    const value = Array.isArray(given) ? given[0] : given;
    if (!value) { res.status(401).json({ error: 'operator_token_required' }); return; }
    if (!crypto.timingSafeEqual(sha(value), sha(token))) { res.status(403).json({ error: 'forbidden' }); return; }
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
