// Receipts: what the consent gate looked at and what the person changed. Always on, in either mode.
// Nothing is written for things the gate does not cover (chat replies, writes inside the companion's home).
import { getDb } from '../db.js';
import { runInTenant, type TenantRuntime } from '../../tenancy/context.js';

export type ReceiptOutcome = 'allowed' | 'denied' | 'expired' | 'granted' | 'revoked' | 'mode_changed' | 'error';
export const RECEIPT_OUTCOMES: readonly ReceiptOutcome[] = ['allowed', 'denied', 'expired', 'granted', 'revoked', 'mode_changed', 'error'];
export const RECEIPT_KEEP_DAYS = 90;
export const SUMMARY_MAX = 200;
/** Consecutive `allowed` receipts for the same capability, harness, thread and tool within this long are one row with a count. */
export const COALESCE_MS = 60_000;
/** How often the prune runs while the process is up (it also runs at boot). */
export const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

export interface Receipt {
  id: number;
  ts: string;
  capability: string;
  grant_id: string | null;
  harness: string;
  thread_id: string | null;
  tool_or_route: string;
  summary: string;
  outcome: ReceiptOutcome;
  /** How many identical `allowed` calls this row stands for (1 unless they were coalesced). */
  count: number;
}

/** There is no general secret scrubber in the app, so this one covers what a command line or a message can carry: URL logins,
 *  Bearer/Basic values, `name=value` where the name says key/token/secret/password, `--password x` flags, well-known token shapes,
 *  and long hex runs. Whitespace is collapsed and the result is cut to 200 characters. */
export function scrubSummary(input: unknown): string {
  let t = typeof input === 'string' ? input : input == null ? '' : String(input);
  t = t.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@');
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  t = t.replace(/(x-internal-token\s*[:=]\s*)\S+/gi, '$1[redacted]');
  t = t.replace(/(--?[A-Za-z-]*(?:password|passwd|token|secret|api-?key|key)\s+)(?!-)\S+/gi, '$1[redacted]');
  t = t.replace(/\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi, '$1$2[redacted]');
  t = t.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted]');
  t = t.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted]');
  t = t.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > SUMMARY_MAX ? t.slice(0, SUMMARY_MAX - 1) + '…' : t;
}

export interface ReceiptInput {
  capability: string;
  outcome: ReceiptOutcome;
  grantId?: string | null;
  harness?: string;
  threadId?: string | null;
  toolOrRoute?: string;
  summary?: string;
}

/** Write one receipt. A receipt that cannot be written never blocks or fails the action it describes.
 *  An `allowed` call that repeats the latest row for the same (capability, harness, thread, tool) within a minute is counted on that row instead of
 *  adding one (a Bash-heavy turn is one row, not thirty); the first call's summary stays. Denied, expired and every change are always their own row. */
export function writeReceipt(r: ReceiptInput): void {
  try {
    const db = getDb();
    const now = Date.now();
    const tool = String(r.toolOrRoute ?? '').slice(0, 120);
    if (r.outcome === 'allowed') {
      const last = db.prepare(
        'SELECT id, ts, harness, thread_id, outcome FROM consent_receipts WHERE capability = ? AND tool_or_route = ? ORDER BY id DESC LIMIT 1',
      ).get(r.capability, tool) as { id: number; ts: string; harness: string; thread_id: string | null; outcome: string } | undefined;
      if (last && last.outcome === 'allowed' && last.harness === (r.harness ?? '') && last.thread_id === (r.threadId ?? null) && now - Date.parse(last.ts) < COALESCE_MS) {
        db.prepare('UPDATE consent_receipts SET count = COALESCE(count, 1) + 1 WHERE id = ?').run(last.id);
        return;
      }
    }
    db.prepare(
      'INSERT INTO consent_receipts (ts, capability, grant_id, harness, thread_id, tool_or_route, summary, outcome, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
    ).run(new Date(now).toISOString(), r.capability, r.grantId ?? null, r.harness ?? '', r.threadId ?? null, tool, scrubSummary(r.summary), r.outcome);
  } catch (e) {
    console.warn(`[Consent] receipt not written: ${(e as Error)?.message ?? e}`);
  }
}

export interface ReceiptQuery { capability?: string; outcome?: string; limit?: number; before?: number }

/** Newest first. `before` is a receipt id: the page after it. */
export function listReceipts(q: ReceiptQuery = {}): { receipts: Receipt[]; next_before: number | null } {
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit)) || 50));
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.capability) { where.push('capability = ?'); args.push(q.capability); }
  if (q.outcome) { where.push('outcome = ?'); args.push(q.outcome); }
  if (q.before !== undefined && Number.isFinite(q.before)) { where.push('id < ?'); args.push(q.before); }
  const sql = `SELECT * FROM consent_receipts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  const rows = getDb().prepare(sql).all(...args, limit + 1) as Receipt[];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return { receipts: page, next_before: more ? page[page.length - 1].id : null };
}

/** Remove receipts older than the retention window. Returns how many went. */
export function pruneReceipts(days = RECEIPT_KEEP_DAYS, now = Date.now()): number {
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  return Number(getDb().prepare('DELETE FROM consent_receipts WHERE ts < ?').run(cutoff).changes);
}

/** Prune the process's database, or every tenant's (each inside its own tenant context). One database failing does not stop the others. */
export function pruneAllReceipts(tenants?: Iterable<TenantRuntime> | null): number {
  let total = 0;
  const one = (label: string, fn: () => number) => {
    try { const n = fn(); total += n; if (n) console.log(`[Consent] ${label}pruned ${n} receipt(s) older than ${RECEIPT_KEEP_DAYS} days`); }
    catch (e) { console.warn(`[Consent] ${label}receipt prune failed: ${(e as Error)?.message}`); }
  };
  if (tenants) for (const rt of tenants) one(`tenant ${rt.id}: `, () => runInTenant(rt, () => pruneReceipts()));
  else one('', () => pruneReceipts());
  return total;
}

/** Prune now, then every 6 hours for as long as the process is up. Returns the stop function. `tenants` is read at each run. */
export function startReceiptPruning(tenants?: () => Iterable<TenantRuntime> | null, everyMs = PRUNE_EVERY_MS): () => void {
  pruneAllReceipts(tenants?.());
  const timer = setInterval(() => pruneAllReceipts(tenants?.()), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
