// The companion's write access to the app's own features: reminders and
// timers, the meal and care log, cycle tracking, notes and canvases, presence,
// routines, reactions, shares, and the Command Center tools. One switch,
// agent.app_write, asked by the wizard and shown under Settings → permissions.
// Off, the companion can still read, ask (approvals), and talk; every write
// path answers 403 with a sentence that says where the switch is.
import type { Request, Response, NextFunction } from 'express';
import { getSanctumConfig } from '../config.js';
import { check, denyMessage } from '../services/consent/gate.js';

export function appWriteEnabled(): boolean {
  return getSanctumConfig().agent.app_write !== false;
}

/** Two switches, either of which refuses: the old one (agent.app_write, the wizard's question) and the consent gate's `app_write`
 *  (Settings → Permissions; Guard mode turns it off until granted). The gate writes the receipt. */
export function appWriteGate(req: Request, res: Response, next: NextFunction): void {
  if (!appWriteEnabled()) {
    res.status(403).json({
      error: 'app_write_off',
      message: "The companion's write access to the app's features is off (Settings → permissions, or agent.app_write in sanctum.yaml).",
    });
    return;
  }
  const route = `${req.method ?? ''} ${String(req.originalUrl ?? req.path ?? '').split('?')[0]}`.trim();
  const g = check('app_write', { harness: 'server', tool: route, summary: route });
  if (g.allow) { next(); return; }
  res.status(403).json({ error: 'app_write_off', capability: 'app_write', message: denyMessage('app_write', g.reason) });
}
