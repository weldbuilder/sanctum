// Stage 1 makes the database, config, login, sessions and token per tenant, and nothing else. A service that is still one per process
// (the agent, the orchestrator, the channels, voice, push) must not answer for a tenant with another tenant's state, so in tenant mode
// its handle on app.locals throws this. The global error handler maps it to 503; a handler that catches errors itself calls
// handleUnavailable first, so a genuine failure stays a 500 and "not per tenant yet" is always a 503.
import type { Response } from 'express';
import { OwnFileRefused } from '../../../../scripts/own-files-lib.mjs';

export class TenantServiceUnavailable extends Error {
  readonly service: string;
  constructor(service: string) {
    super(`${service} is not available per tenant yet`);
    this.name = 'TenantServiceUnavailable';
    this.service = service;
    this.stack = `${this.name}: ${this.message}`; // one line, never a stack, wherever it is logged
  }
}

/** In a catch block: if `err` is "not available per tenant yet", answer 503 and return true (the handler then returns). Otherwise false.
 *  (Not a rethrow: an async express 4 handler that throws is an unhandled rejection and the request hangs.) */
export function handleUnavailable(err: unknown, res: Response): boolean {
  // The tenant file layer refused a write (a link, a second hard link): a 400 with the sentence (relative paths only), never a 500.
  if (err instanceof OwnFileRefused) { if (!res.headersSent) res.status(400).json({ error: err.message }); return true; }
  if (!(err instanceof TenantServiceUnavailable)) return false;
  if (!res.headersSent) res.status(503).json({ error: 'service_unavailable', service: err.service });
  return true;
}
