import type { NextFunction, Request, Response } from 'express';
import { TenantServiceUnavailable } from '../tenancy/errors.js';
import { OwnFileRefused } from '../../../../scripts/own-files-lib.mjs';

/**
 * The global error handler. A body-parser failure (malformed JSON, a body that is too large, a charset it
 * cannot read) is the caller's mistake: it answers 400 { error: 'bad_json' } and logs the route and the
 * error type only. body-parser's error carries the raw body (`err.body`), which can hold a key the person
 * was typing into a form, so that error object is never logged. Anything else is a 500 as before.
 */
export function globalErrorHandler(err: Error & { type?: string }, req: Request, res: Response, _next: NextFunction): void {
  // Tenant mode: a service that is still one per process answers 503 rather than with another tenant's state.
  if (err instanceof TenantServiceUnavailable) {
    res.status(503).json({ error: 'service_unavailable', service: err.service });
    return;
  }
  // The tenant file layer refused a write (only thrown in tenant mode): the caller's folder is the problem, not the server.
  if (err instanceof OwnFileRefused) { res.status(400).json({ error: err.message }); return; }
  if (typeof err?.type === 'string' && err.type.startsWith('entity.')) {
    console.warn(`[http] ${req.method} ${req.path}: request body rejected (${err.type})`);
    res.status(400).json({ error: 'bad_json' });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
