// GET /api/tenant (tenant mode only): which hosts and which folder serve the tenant the request resolved to. Read-only, behind the tenant's own
// sign-in; the Settings page shows it as one line. Not mounted without a `tenants:` block, so a single-user install answers 404 like any unknown route.
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { currentTenant } from './context.js';

export const tenantInfoRouter = Router();

tenantInfoRouter.get('/', authMiddleware, (_req, res) => {
  const rt = currentTenant();
  if (!rt) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({ hosts: [...rt.hosts], dir: rt.dir });
});
