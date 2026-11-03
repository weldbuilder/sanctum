// D11, the reader: what the Discord channel card says about recent send failures. Pure, so it is testable without a DOM.
// Input is `recentFailures` from GET /api/discord/status: a count, the newest kind and its time. Kinds only, never text.

export interface RecentFailures { count24h: number; lastKind: string | null; lastAt: string | null; /** The last 24 hours by kind (empty from an older server). */ byKind: Record<string, number> }
export type FailureTone = 'none' | 'warning' | 'error';
export interface FailureView {
  tone: FailureTone;
  /** The plain line: with no failures it says so. */
  headline: string;
  /** The lane, the reason and the time of the newest one; null when there is none. */
  detail: string | null;
  /** One line for setup and queue kinds, which are not send failures; null when there are none. */
  note: string | null;
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
  const byKind: Record<string, number> = {};
  const raw = r?.byKind;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^[a-z0-9_]{1,40}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) byKind[k] = Math.floor(v);
    }
  }
  return { count24h: count, lastKind, lastAt, byKind };
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
  if (f.count24h === 0) return { tone: 'none', headline: 'No send failures in the last 24 hours.', detail: null, note: null };
  // Send failures are counted on their own; setup and queue kinds ("warning") are one note. An older server sends no
  // per-kind counts: then the total is all there is, judged by the newest kind.
  const kinds = Object.entries(f.byKind);
  let sends: number;
  let setups: number;
  if (kinds.length) {
    sends = kinds.filter(([k]) => (KINDS[k]?.tone ?? 'error') === 'error').reduce((n, [, c]) => n + c, 0);
    setups = kinds.filter(([k]) => KINDS[k]?.tone === 'warning').reduce((n, [, c]) => n + c, 0);
  } else if (f.lastKind && KINDS[f.lastKind]?.tone === 'warning') { sends = 0; setups = f.count24h; } else { sends = f.count24h; setups = 0; }
  // The tone is the worst recent kind, not the newest: a setup line after a failed send does not soften it.
  const tone: FailureTone = sends > 0 ? 'error' : 'warning';
  const known = f.lastKind ? KINDS[f.lastKind] : undefined;
  const headline = sends > 0 ? `${sends} send failure${sends === 1 ? '' : 's'} in the last 24 hours.` : 'No send failures in the last 24 hours.';
  const note = setups > 0 ? `${setups} setup or queue problem${setups === 1 ? '' : 's'} also logged.` : null;
  const parts = [
    f.lastAt ? `last ${sinceText(f.lastAt, now)}` : 'last time unknown',
    known ? `${known.lane}: ${known.reason}` : `reason: ${f.lastKind ?? 'unknown'}`,
  ];
  return { tone, headline, detail: parts.join(' · '), note };
}

/** The log viewer's filter for Discord lines (the logs service writes `[discord] failure kind=...`). */
export const DISCORD_LOG_FILTER = '[discord]';
