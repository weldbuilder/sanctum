// The ratification state as the app and the companion see it: one record (IdentityStatus in @sanctum/shared),
// built from the ledger's check. Served by GET /api/identity/status and GET /api/internal/identity/status
// (`res identity status`), and pushed over the socket as `identity_status`.
import type { IdentityStatus } from './types.js';
import { join } from 'node:path';
import { getSanctumConfig } from '../../config.js';
import { ledgerClash } from '../plugins.js';
import { appContext, emitCheck, ledgerDirFor } from './guard.js';
import { checkIdentity, type IdentityCheck, type LedgerOpts } from './ledger.js';

/** A standing warning when the ledger folder is inside (or contains) a folder the companion can write: the plugin ledger refuses that spot, the identity
 *  ledger has no person-mode gate to refuse in, so it says so instead. null when it is somewhere the companion cannot write, or when nothing says. */
export function ledgerPlacementWarning(): string | null {
  try {
    const cfg = getSanctumConfig();
    const dir = ledgerDirFor(cfg);
    if (!dir) return null;
    const clash = ledgerClash(cfg, join(dir, 'ledger.json'));
    if (!clash) return null;
    return `The identity ledger folder (${dir}) is inside, or contains, ${clash.label} (${clash.path}), which the companion can write. Anything that can write identity/ there can also rewrite the ledger and ratify its own changes. Move identity.ledger_dir to a folder the companion cannot write (docs/PLUGINS.md, "Where to put the house").`;
  } catch { return null; }
}

export function toStatus(c: IdentityCheck, now: Date = new Date()): IdentityStatus {
  return {
    state: c.state,
    digest: c.digest,
    ratified: c.ratified_digest && c.ratified_at && c.ratified_by ? { digest: c.ratified_digest, at: c.ratified_at, by: c.ratified_by } : null,
    pending: c.state === 'pending' ? { changes: c.changes ?? [], author: c.author ?? null, authors: c.authors ?? (c.author ? [c.author] : []), since: c.since ?? null } : null,
    files: Object.keys(c.files ?? {}).sort(),
    skipped: c.skipped ?? [],
    detail: c.detail ?? null,
    canRatify: !!c.digest && (!c.blocked || !!c.damaged),
    warning: ledgerPlacementWarning(),
    checkedAt: now.toISOString(),
  };
}

/** The home and ledger options for the app's own checks (routes, boot). null when no ledger folder is configured. */
export function appLedger(): { home: string; opts: LedgerOpts } | null {
  const cfg = getSanctumConfig();
  const ledgerDir = ledgerDirFor(cfg);
  if (!ledgerDir) return null;
  return { home: cfg.agent.cwd, opts: { ledgerDir, context: appContext() } };
}

/** Check now, as the app (not as a harness). null when no ledger folder is configured. */
export function currentIdentity(): { check: IdentityCheck; status: IdentityStatus } | null {
  const l = appLedger();
  if (!l) return null;
  const check = emitCheck(checkIdentity(l.home, l.opts));
  return { check, status: toStatus(check) };
}
