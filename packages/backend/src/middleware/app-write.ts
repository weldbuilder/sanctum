// The companion's write access to the app's own features: reminders and
// timers, the meal and care log, cycle tracking, notes and canvases, presence,
// routines, reactions, shares, and the Command Center tools. One switch,
// agent.app_write, asked by the wizard and shown under Settings → permissions.
// Off, the companion can still read, ask (approvals), and talk; every write
// path answers 403 with a sentence that says where the switch is.
import type { Request, Response, NextFunction } from 'express';
import { getSanctumConfig } from '../config.js';

export function appWriteEnabled(): boolean {
  return getSanctumConfig().agent.app_write !== false;
}

export function appWriteGate(_req: Request, res: Response, next: NextFunction): void {
  if (appWriteEnabled()) { next(); return; }
  res.status(403).json({
    error: 'app_write_off',
    message: "The companion's write access to the app's features is off (Settings → permissions, or agent.app_write in sanctum.yaml).",
  });
}
