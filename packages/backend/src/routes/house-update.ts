// The house's update routes: /api/house/update (status), /start and /rollback. A house route, not a companion route: it is mounted unprefixed beside
// /api/companions, answers 404 under a companion's prefix or to the internal token (so no companion tool can reach it), needs a signed-in session
// AND the house password typed again in the body (no password set, the local dev-open setup: `no_password`, and the page shows the terminal command instead) of the two that change anything. One update restarts every companion in the house.
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware, passwordConfigured, verifyPassword } from '../middleware/auth.js';
import { householdMode } from '../tenancy/house.js';
import { tenancyEnabled } from '../tenancy/context.js';
import { UpdaterError, getSnapshot, startRollback, startUpdate } from '../services/updater.js';

const router = Router();

export const NO_PASSWORD_MESSAGE = 'Set a password, or run npm run update';

/** Only the unprefixed path, only a browser: no companion prefix (the router stripped it from req.url, req.originalUrl keeps it), no internal token,
 *  no companion resolved. Hostname-per-tenant mode has no house, so there the routes do not exist (use `npm run update`). */
function houseOnly(req: Request, res: Response, next: NextFunction): void {
  const direct = /^\/api\/house\/update(\/|\?|$)/i.test(String(req.originalUrl ?? ''));
  if (!direct || req.tenant || req.headers['x-internal-token'] || (tenancyEnabled() && !householdMode())) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

// A wrong password is a failed attempt: a small budget per address, apart from the login's.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  validate: { trustProxy: false },
  message: { error: 'Too many tries, please wait a few minutes.' },
});

function passwordGate(req: Request, res: Response, next: NextFunction): void {
  // Dev-open (no password set): there is nothing to type again, and an install with no password is not one to restart from a browser.
  if (!passwordConfigured()) { res.status(403).json({ error: 'no_password', message: NO_PASSWORD_MESSAGE }); return; }
  const given = (req.body as { password?: unknown } | undefined)?.password;
  if (typeof given !== 'string' || !given) { res.status(401).json({ error: 'password_required', message: 'Enter the password to continue.' }); return; }
  if (!verifyPassword(given)) { res.status(401).json({ error: 'wrong_password', message: 'That is not the password.' }); return; }
  next();
}

function refuse(res: Response, err: unknown): void {
  if (err instanceof UpdaterError) { res.status(err.status).json({ error: err.code, message: err.message }); return; }
  console.error('Update route error:', err);
  res.status(500).json({ error: 'Update failed to start' });
}

router.use(houseOnly, authMiddleware);

router.get('/', async (req, res) => {
  try { res.json({ ...(await getSnapshot({ force: req.query.force === '1' })), password_set: passwordConfigured() }); } catch (err) { refuse(res, err); }
});

router.post('/start', passwordLimiter, passwordGate, (_req, res) => {
  try { res.status(202).json({ job: startUpdate() }); } catch (err) { refuse(res, err); }
});

router.post('/rollback', passwordLimiter, passwordGate, (_req, res) => {
  try { res.status(202).json({ job: startRollback() }); } catch (err) { refuse(res, err); }
});

export default router;
