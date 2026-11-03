import { describe, it, expect } from 'vitest';
import { parseRecentFailures, describeFailures, sinceText, DISCORD_LOG_FILTER } from './discordFailures';

const NOW = Date.parse('2026-11-03T12:00:00Z');

describe('parseRecentFailures', () => {
  it('reads the status body', () => {
    expect(parseRecentFailures({ recentFailures: { count24h: 4, lastKind: 'reply_failed', lastAt: '2026-11-03T11:57:00.000Z' } }))
      .toEqual({ count24h: 4, lastKind: 'reply_failed', lastAt: '2026-11-03T11:57:00.000Z' });
  });
  it('treats a missing or malformed field as none', () => {
    const none = { count24h: 0, lastKind: null, lastAt: null };
    expect(parseRecentFailures(null)).toEqual(none);
    expect(parseRecentFailures({})).toEqual(none);
    expect(parseRecentFailures({ recentFailures: { count24h: 'x', lastKind: 'Has Spaces', lastAt: 'nope' } })).toEqual(none);
  });
});

describe('describeFailures', () => {
  it('says so plainly when there are none', () => {
    expect(describeFailures({ count24h: 0, lastKind: null, lastAt: null }, NOW)).toEqual({ tone: 'none', headline: 'No send failures in the last 24 hours.', detail: null });
  });
  it('shows count, last time, reason and lane in the error tone for a failed send', () => {
    const v = describeFailures({ count24h: 3, lastKind: 'public_run_failed', lastAt: '2026-11-03T11:57:00.000Z' }, NOW);
    expect(v.tone).toBe('error');
    expect(v.headline).toBe('3 failures in the last 24 hours.');
    expect(v.detail).toBe('last 3 min ago · public lane: a public reply failed');
  });
  it('uses the warning tone for a setup kind and singular for one', () => {
    const v = describeFailures({ count24h: 1, lastKind: 'api_key_missing', lastAt: '2026-11-03T09:00:00.000Z' }, NOW);
    expect(v.tone).toBe('warning');
    expect(v.headline).toBe('1 failure in the last 24 hours.');
    expect(v.detail).toContain('3 h ago');
  });
  it('shows an unknown kind as given', () => {
    expect(describeFailures({ count24h: 2, lastKind: 'odd_kind', lastAt: null }, NOW).detail).toBe('last time unknown · reason: odd_kind');
  });
});

describe('sinceText and the log filter', () => {
  it('words short spans', () => {
    expect(sinceText('2026-11-03T11:59:50Z', NOW)).toBe('just now');
    expect(sinceText('2026-11-03T10:00:00Z', NOW)).toBe('2 h ago');
  });
  it('filters the viewer to the discord category', () => { expect(DISCORD_LOG_FILTER).toBe('[discord]'); });
});
