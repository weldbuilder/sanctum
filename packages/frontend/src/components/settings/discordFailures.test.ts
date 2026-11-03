import { describe, it, expect } from 'vitest';
import { parseRecentFailures, describeFailures, sinceText, DISCORD_LOG_FILTER } from './discordFailures';

const NOW = Date.parse('2026-11-03T12:00:00Z');

describe('parseRecentFailures', () => {
  it('reads the status body', () => {
    expect(parseRecentFailures({ recentFailures: { count24h: 4, lastKind: 'reply_failed', lastAt: '2026-11-03T11:57:00.000Z', byKind: { reply_failed: 4, bad: 'x' } } }))
      .toEqual({ count24h: 4, lastKind: 'reply_failed', lastAt: '2026-11-03T11:57:00.000Z', byKind: { reply_failed: 4 } });
  });
  it('treats a missing or malformed field as none', () => {
    const none = { count24h: 0, lastKind: null, lastAt: null, byKind: {} };
    expect(parseRecentFailures(null)).toEqual(none);
    expect(parseRecentFailures({})).toEqual(none);
    expect(parseRecentFailures({ recentFailures: { count24h: 'x', lastKind: 'Has Spaces', lastAt: 'nope' } })).toEqual(none);
  });
});

describe('describeFailures', () => {
  it('says so plainly when there are none', () => {
    expect(describeFailures({ count24h: 0, lastKind: null, lastAt: null, byKind: {} }, NOW)).toEqual({ tone: 'none', headline: 'No send failures in the last 24 hours.', detail: null, note: null });
  });
  it('shows count, last time, reason and lane in the error tone for a failed send', () => {
    const v = describeFailures({ count24h: 3, lastKind: 'public_run_failed', lastAt: '2026-11-03T11:57:00.000Z', byKind: { public_run_failed: 3 } }, NOW);
    expect(v.tone).toBe('error');
    expect(v.headline).toBe('3 send failures in the last 24 hours.');
    expect(v.detail).toBe('last 3 min ago · public lane: a public reply failed');
  });
  it('a setup kind alone is a warning with no send failures counted, and a one-line note', () => {
    const v = describeFailures({ count24h: 1, lastKind: 'api_key_missing', lastAt: '2026-11-03T09:00:00.000Z', byKind: { api_key_missing: 1 } }, NOW);
    expect(v.tone).toBe('warning');
    expect(v.headline).toBe('No send failures in the last 24 hours.');
    expect(v.note).toBe('1 setup or queue problem also logged.');
    expect(v.detail).toContain('3 h ago');
  });
  it('counts only send failures in the headline and takes the tone from the worst kind, not the newest', () => {
    const v = describeFailures({ count24h: 6, lastKind: 'queue_save_failed', lastAt: '2026-11-03T11:57:00.000Z', byKind: { reply_failed: 2, gate_error: 1, queue_save_failed: 2, exclusions_failed: 1 } }, NOW);
    expect(v.tone).toBe('error');
    expect(v.headline).toBe('3 send failures in the last 24 hours.');
    expect(v.note).toBe('3 setup or queue problems also logged.');
  });
  it('shows an unknown kind as given', () => {
    expect(describeFailures({ count24h: 2, lastKind: 'odd_kind', lastAt: null, byKind: {} }, NOW).detail).toBe('last time unknown · reason: odd_kind');
  });
});

describe('sinceText and the log filter', () => {
  it('words short spans', () => {
    expect(sinceText('2026-11-03T11:59:50Z', NOW)).toBe('just now');
    expect(sinceText('2026-11-03T10:00:00Z', NOW)).toBe('2 h ago');
  });
  it('filters the viewer to the discord category', () => { expect(DISCORD_LOG_FILTER).toBe('[discord]'); });
});
