// D11, the reader: what the Discord channel card says about recent send failures. Pure, so it is testable without a DOM.
// Input is `recentFailures` from GET /api/discord/status: a count, the newest kind and its time. Kinds only, never text.

export interface RecentFailures { count24h: number; lastKind: string | null; lastAt: string | null }
export type FailureTone = 'none' | 'warning' | 'error';
export interface FailureView {
  tone: FailureTone;
  /** The plain line: with no failures it says so. */
  headline: string;
  /** The lane, the reason and the time of the newest one; null when there is none. */
  detail: string | null;
}

/** Which lane a kind belongs to, and the reason in plain words. A failure to send is an error; a missing setup piece is a warning. */
const KINDS: Record<string, { lane: string; reason: string; tone: FailureTone }> = {
  reply_failed: { lane: 'owner lane', reason: 'a reply failed', tone: 'error' },
  public_run_failed: { lane: 'public lane', reason: 'a public reply failed', tone: 'error' },
  gate_error: { lane: 'both lanes', reason: 'the send gate could not run', tone: 'error' },
  api_key_missing: { lane: 'public lane', reason: 'no API key for the public lane', tone: 'warning' },
  identity_missing: { lane: 'public lane', reason: 'no identity files for the public lane', tone: 'warning' },
  exclusions_failed: { lane: 'public lane', reason: 'the exclusions file could not be read', tone: 'warning' },
  queue_save_failed: { lane: 'owner lane', reason: 'the queue could not be saved', tone: 'warning' },
  queue_load_failed: { lane: 'owner lane', reason: 'the queue could not be loaded', tone: 'warning' },
};

/** Read the status body's recentFailures defensively: anything else is "none". */
export function parseRecentFailures(body: unknown): RecentFailures {
  const r = (body && typeof body === 'object' ? (body as { recentFailures?: unknown }).recentFailures : null) as Partial<RecentFailures> | null;
  const count = typeof r?.count24h === 'number' && Number.isFinite(r.count24h) && r.count24h > 0 ? Math.floor(r.count24h) : 0;
  const lastKind = typeof r?.lastKind === 'string' && /^[a-z0-9_]{1,40}$/.test(r.lastKind) ? r.lastKind : null;
  const lastAt = typeof r?.lastAt === 'string' && Number.isFinite(Date.parse(r.lastAt)) ? r.lastAt : null;
  return { count24h: count, lastKind, lastAt };
}

/** "3 min ago", "2 h ago", or the date for older. */
export function sinceText(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!(ms >= 0)) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ago` : new Date(iso).toISOString().slice(0, 10);
}

export function describeFailures(f: RecentFailures, now: number = Date.now()): FailureView {
  if (f.count24h === 0) return { tone: 'none', headline: 'No send failures in the last 24 hours.', detail: null };
  const known = f.lastKind ? KINDS[f.lastKind] : undefined;
  const tone: FailureTone = known?.tone ?? 'error';
  const headline = `${f.count24h} failure${f.count24h === 1 ? '' : 's'} in the last 24 hours.`;
  const parts = [
    f.lastAt ? `last ${sinceText(f.lastAt, now)}` : 'last time unknown',
    known ? `${known.lane}: ${known.reason}` : `reason: ${f.lastKind ?? 'unknown'}`,
  ];
  return { tone, headline, detail: parts.join(' · ') };
}

/** The log viewer's filter for Discord lines (the logs service writes `[discord] failure kind=...`). */
export const DISCORD_LOG_FILTER = '[discord]';
