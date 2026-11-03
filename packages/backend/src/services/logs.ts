// Log tail reader — surfaces the PM2 process logs to the Settings Logs panel.
//
// PM2 (see ecosystem.config.cjs) writes stdout → data/logs/pm2-out.log and
// stderr → data/logs/pm2-err.log, each line prefixed with an ISO timestamp
// (`time: true`). This service reads a bounded tail of each file (never the whole
// thing — these grow unbounded), parses the timestamp, merges both streams in
// chronological order, and applies an optional case-insensitive filter.
//
// Read-only. The route that exposes this sits behind authMiddleware.

import { readSync, closeSync } from 'fs';
import { resolve } from 'path';
import { PROJECT_ROOT } from '../config.js';
import { tenantLocal, tenantOrNull } from '../tenancy/context.js';
import { ownOpenRead } from '../tenancy/own-files.js';

// Resolved when read, not at import: this module is imported by code that runs under a partial config.
// Tenant mode: the one file tenancy/console.ts writes that tenant's lines to, and no error file (outside a tenant it throws: never the process's log).
const OUT_LOG = () => { const rt = tenantOrNull('the log files'); return rt ? resolve(rt.dataDir, 'logs', 'tenant.log') : resolve(PROJECT_ROOT, 'data', 'logs', 'pm2-out.log'); };
const ERR_LOG = (): string | null => (tenantOrNull('the log files') ? null : resolve(PROJECT_ROOT, 'data', 'logs', 'pm2-err.log'));

// Read at most the last 512KB of each file — plenty for a few thousand lines,
// bounded so a multi-GB log can never blow out memory or response time.
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_LINES = 5000;
const DEFAULT_LINES = 500;

export type LogSource = 'out' | 'err';
export type LogSourceFilter = LogSource | 'all';

export interface LogLine {
  ts: string | null;
  source: LogSource;
  text: string;
}

export interface ReadLogsOptions {
  lines?: number;
  q?: string;
  source?: LogSourceFilter;
}

export interface ReadLogsResult {
  lines: LogLine[];
  truncated: boolean;
  /** Whether each underlying log file was found on disk. */
  present: { out: boolean; err: boolean };
}

/** Read at most `maxBytes` from the end of a file. Missing file → empty string. */
function tailBytes(path: string, maxBytes: number): { text: string; present: boolean } {
  try {
    // (a tenant's data/logs is not scanned: the file is opened through the read guard, never a link or a pipe, and sized from the open handle)
    const { fd, stat } = ownOpenRead(path, { kind: 'file' });
    try {
      const size = stat.size;
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      if (len <= 0) return { text: '', present: true };
      const buf = Buffer.allocUnsafe(len);
      const read = readSync(fd, buf, 0, len, start);
      return { text: buf.toString('utf8', 0, read), present: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: '', present: false };
  }
}

// PM2 `time: true` prepends e.g. "2026-06-30T12:34:56: message". Tolerate fractional
// seconds and an optional timezone offset; the trailing ": " is PM2's separator.
const TS_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?):\s?/;

function parseLines(raw: string, source: LogSource): LogLine[] {
  const out: LogLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const m = TS_RE.exec(line);
    if (m) out.push({ ts: m[1], source, text: line.slice(m[0].length) });
    else out.push({ ts: null, source, text: line });
  }
  return out;
}

/**
 * Read the tail of the PM2 logs, merged chronologically and optionally filtered.
 * When the first read chunk begins mid-line (because we sliced into the middle of
 * the file), that partial leading line is dropped by `parseLines` naturally only if
 * empty — otherwise it shows as an unprefixed line, which is acceptable for a tail.
 */
export function readLogs(opts: ReadLogsOptions = {}): ReadLogsResult {
  const limit = Math.min(Math.max(opts.lines ?? DEFAULT_LINES, 1), MAX_LINES);
  const want: LogSourceFilter = opts.source ?? 'all';

  let all: LogLine[] = [];
  const present = { out: false, err: false };

  if (want === 'out' || want === 'all') {
    const r = tailBytes(OUT_LOG(), MAX_TAIL_BYTES);
    present.out = r.present;
    all = all.concat(parseLines(r.text, 'out'));
  }
  if (want === 'err' || want === 'all') {
    const errLog = ERR_LOG();
    const r = errLog ? tailBytes(errLog, MAX_TAIL_BYTES) : { text: '', present: false };
    present.err = r.present;
    all = all.concat(parseLines(r.text, 'err'));
  }

  // ISO timestamps sort lexicographically == chronologically. Lines without a
  // timestamp compare equal (V8's sort is stable, so they keep file order).
  all.sort((a, b) => {
    if (a.ts && b.ts) return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
    return 0;
  });

  let filtered = all;
  if (opts.q && opts.q.trim()) {
    const q = opts.q.trim().toLowerCase();
    filtered = all.filter((l) => l.text.toLowerCase().includes(q));
  }

  const truncated = filtered.length > limit;
  return { lines: filtered.slice(-limit), truncated, present };
}

// ── structured events (D11) ──────────────────────────────────────────────────────
// A failure that must not be silent: one short line under a category, written to stderr (which the process manager puts
// in pm2-err.log, so the viewer above shows it and `q=[discord]` finds it), and counted here for a status summary.
// KINDS ONLY. A kind is a short snake_case word and a class is an error class name; anything else is reduced to
// "unknown" or dropped, so no message text, id, path or stack can ride through this function. The count is in memory:
// it starts over when the process does (the lines themselves stay in the process log).

const DAY_MS = 24 * 3_600_000;
const MAX_EVENTS = 500;
const SAFE_KIND = /^[a-z0-9_]{1,40}$/;
const SAFE_CLASS = /^[A-Za-z0-9_]{1,40}$/;

interface LoggedEvent { category: string; kind: string; at: number }
// Per tenant in tenant mode (one tenant's failures are not another's summary).
const eventsLocal = tenantLocal<LoggedEvent[]>(() => []);
const printedOnceLocal = tenantLocal(() => new Set<string>());

export interface LogEventOptions {
  /** An error class name (never a message). */
  class?: string;
  /** Print the line the first time this (category, kind) happens in the process; every occurrence is still counted. */
  once?: boolean;
  /** Test hook. */
  now?: number;
}

type EventListener = (category: string, kind: string) => void;
let eventListener: EventListener | null = null;
/** One listener for every recorded event (the Discord failure alert). It runs in the caller's tenant; it never throws into the caller. */
export function setEventListener(fn: EventListener | null): void { eventListener = fn; }

export function logEvent(category: string, kind: string, opts: LogEventOptions = {}): void {
  const cat = SAFE_KIND.test(category) ? category : 'unknown';
  const k = SAFE_KIND.test(kind) ? kind : 'unknown';
  let events = eventsLocal.get();
  events.push({ category: cat, kind: k, at: opts.now ?? Date.now() });
  if (events.length > MAX_EVENTS) { events = events.slice(-MAX_EVENTS); eventsLocal.set(events); }
  try { eventListener?.(cat, k); } catch { /* an alert must never break the failure path */ }
  if (opts.once) {
    const printedOnce = printedOnceLocal.get();
    const key = `${cat}:${k}`;
    if (printedOnce.has(key)) return;
    printedOnce.add(key);
  }
  const cls = opts.class && SAFE_CLASS.test(opts.class) ? ` class=${opts.class}` : '';
  console.error(`[${cat}] failure kind=${k}${cls}`);
}

export interface EventSummary { count24h: number; lastKind: string | null; lastAt: string | null }

/** The last 24 hours of one category: how many, and the newest kind and time (the newest ever recorded, even if older). */
export function eventSummary(category: string, now: number = Date.now()): EventSummary {
  const mine = eventsLocal.get().filter((e) => e.category === category);
  const last = mine[mine.length - 1];
  return {
    count24h: mine.filter((e) => now - e.at < DAY_MS && now - e.at >= 0).length,
    lastKind: last ? last.kind : null,
    lastAt: last ? new Date(last.at).toISOString() : null,
  };
}

/** Test hook. */
export function resetEvents(): void {
  eventsLocal.set([]);
  printedOnceLocal.get().clear();
}
