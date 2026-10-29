// The house first-run (household mode): `/api/setup/status|plan|apply` with NO companion prefix, restricted to the one thing the house owns, its password.
// Everything else about a companion's setup stays at /c/<id>/api/setup/* (routes/setup.ts). The gate is the existing one: the setup code printed at boot
// until a password exists, the house session after.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseCookie } from 'cookie';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { PROJECT_ROOT, getAppPasswordSource, reloadConfig, setAppPassword } from '../config.js';
import { authMiddleware, getCookieName } from '../middleware/auth.js';
import { checkSetupCode, ensureSetupCode, noteWrongGuess, setupGuessBlocked } from '../services/setup-code.js';
import { upsertEnv } from '../../../../scripts/setup-lib.mjs';
import { announceSetupCode } from '../services/setup-code.js';
import { currentTenant, runInTenant } from './context.js';
import { houseScope, housePassword, houseSessions, syncHousePassword } from './house.js';

const MESSAGES = {
  missing: 'Enter the setup code printed in the window where `npm start` runs.',
  wrong: 'That is not the setup code. It is printed in the window where `npm start` runs.',
  rotated: 'That is not the setup code, and after this many wrong tries it was replaced. The new one is printed in the window where `npm start` runs.',
  locked: 'Too many wrong setup codes from this address. Wait 15 minutes, then try again with the code printed in the window where `npm start` runs.',
  expired: 'That setup code has expired. A new one was printed in the window where `npm start` runs.',
} as const;

let envPathOverride: string | null = null;
/** Where the house password is written: the process's own .env. A test points it at a temp file (never the checkout's). */
export function setHouseEnvPathForTest(path: string | null): void { envPathOverride = path; }

/** The setup code state is tenantLocal; the house keeps its own in its own scope (houseScope), apart from every companion's. */
const inHouse = <T>(fn: () => T): T => runInTenant(houseScope(), fn);

/** Print the house's setup code (once, at boot, when the house has no password). Never a password. */
export function announceHouseSetupCode(): void { if (!housePassword()) inHouse(() => { announceSetupCode(); }); }

function houseGate(req: Request, res: Response, next: NextFunction): void {
  if (housePassword()) { authMiddleware(req, res, next); return; }
  const ip = req.ip || 'unknown';
  if (inHouse(() => setupGuessBlocked(ip))) { res.status(429).json({ error: 'setup_code_locked', message: MESSAGES.locked }); return; }
  const verdict = inHouse(() => checkSetupCode(req.get('x-setup-code')));
  if (verdict === 'ok') { next(); return; }
  if (verdict === 'wrong' || verdict === 'rotated') inHouse(() => noteWrongGuess(ip));
  res.status(401).json({ error: verdict === 'expired' ? 'setup_code_expired' : 'setup_code', message: MESSAGES[verdict] });
}

/** The one step the house asks: its password. The same wording and rule as a single install's password step. */
function passwordStep() {
  return {
    id: 'password', kind: 'secret', section: 'The house', question: 'House password',
    help: ['One password signs you in to the house and every companion in it.'],
    saved: !!housePassword(),
  };
}

function passwordProblem(value: unknown): string {
  if (typeof value !== 'string' || !value) return housePassword() ? '' : 'Choose a password. It is what you sign in with.';
  if (/[\r\n]/.test(value)) return 'This answer has to be on one line.';
  if (value === housePassword()) return '';
  return value.length < 8 ? 'Use at least 8 characters.' : '';
}

export const houseSetupRouter = Router();
// Inside a companion's prefix this router stands aside: routes/setup.ts is that companion's wizard.
houseSetupRouter.use((_req, _res, next) => { if (currentTenant()) next('router'); else next(); });

houseSetupRouter.get('/status', (_req, res) => {
  const passwordSet = !!housePassword();
  if (!passwordSet) inHouse(() => ensureSetupCode()); // a page opened after the code expired finds a new one in the terminal
  res.json({ password_set: passwordSet, needs_code: !passwordSet });
});

function sendPlan(req: Request, res: Response): void {
  const sent = (req.body as { answers?: { password?: unknown } } | undefined)?.answers;
  const problem = sent && Object.hasOwn(sent, 'password') ? passwordProblem(sent.password) : '';
  res.json({
    steps: [passwordStep()], notes: [], problems: problem ? [{ id: 'password', message: problem }] : [],
    passwordSource: getAppPasswordSource(), mode: housePassword() ? 'rerun' : 'first_run',
  });
}
houseSetupRouter.get('/plan', houseGate, sendPlan);
houseSetupRouter.post('/plan', houseGate, sendPlan);

// The first-run page checks the password as it is typed, as the companion wizard does (same answer shape): the house has one step.
houseSetupRouter.post('/validate', houseGate, (req, res) => {
  const body = (req.body ?? {}) as { id?: unknown; value?: unknown };
  if (typeof body.id !== 'string' || !body.id) { res.status(400).json({ error: 'id must be the id of a step' }); return; }
  if (body.id !== 'password') { res.status(404).json({ error: `no step called ${body.id}` }); return; }
  const problem = passwordProblem(body.value);
  res.json({ ok: !problem, active: true, message: problem });
});

houseSetupRouter.post('/apply', houseGate, (req, res) => {
  const answers = (req.body as { answers?: { password?: unknown } } | undefined)?.answers;
  const password = answers?.password;
  const problem = passwordProblem(password);
  if (problem || typeof password !== 'string' || !password) { res.status(400).json({ error: 'Some answers need another look.', problems: [{ id: 'password', message: problem || 'Choose a password. It is what you sign in with.' }] }); return; }
  const before = housePassword();
  const sourceBefore = getAppPasswordSource();
  const notes: string[] = [];
  try {
    // The password goes to the process's own .env and to the config's holder (never process.env: provider children copy that), then the config is read again.
    const envPath = envPathOverride ?? join(PROJECT_ROOT, '.env');
    const text = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
    writeFileSync(envPath, upsertEnv(text, { APP_PASSWORD: password }), { encoding: 'utf-8', mode: 0o600 });
    setAppPassword(password);
    try { reloadConfig(); } catch (err) { notes.push(`The password was saved but could not be loaded until a restart: ${(err as Error).message}`); }
    syncHousePassword();
    if (password !== before) {
      const keep = before ? (parseCookie(req.headers.cookie || '')[getCookieName()] || null) : null;
      const gone = houseSessions().deleteExcept(keep);
      if (gone) notes.push(`The password ${before ? 'changed' : 'was set'}, so ${gone} ${before ? 'other ' : ''}signed-in browser${gone === 1 ? ' was' : 's were'} signed out.`);
    }
  } catch (err) {
    console.error('[setup] house apply failed:', (err as Error).message);
    res.status(500).json({ error: `Could not apply the setup: ${(err as Error).message}` });
    return;
  }
  // The parent's APP_PASSWORD beats .env at every start (dotenv never overrides it): the new one works until the next restart only.
  const parentKeepsOld = password !== before && sourceBefore === 'parent_env';
  if (parentKeepsOld) notes.unshift('APP_PASSWORD is set by whatever starts this app (pm2, systemd, a shell), not by .env. The new password works now, but you must change it there too, or the old password comes back at the next restart.');
  console.log('[setup] applied: the house password');
  res.json({ ok: true, restartNeeded: false, passwordSource: getAppPasswordSource(), passwordKeptByParent: parentKeepsOld, changed: [{ what: 'the house password (.env)' }], notes });
});

// Nothing else is the house's to set up: a companion's own steps are at /c/<id>/api/setup/*.
houseSetupRouter.use((_req, res) => { res.status(404).json({ error: 'companion_required' }); });
