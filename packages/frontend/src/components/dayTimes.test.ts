// The timeline's wakes: a cron fired in the house's zone, placed in the browser's day. These run with the process in UTC
// (vitest's default here), so a New York house shows its 08:00 wake at 12:00 (summer) or 13:00 (winter).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cronRunsToday, zonedInstant } from './dayTimes';

const utc = (iso: string) => new Date(iso);
let tz: string | undefined;
beforeAll(() => { tz = process.env.TZ; process.env.TZ = 'UTC'; });
afterAll(() => { process.env.TZ = tz; });

describe('zonedInstant', () => {
  it('reads a wall-clock time in the zone, either side of a daylight-saving change', () => {
    expect(zonedInstant(2026, 9, 29, 8, 0, 'America/New_York').toISOString()).toBe('2026-10-29T12:00:00.000Z'); // EDT
    expect(zonedInstant(2026, 10, 2, 8, 0, 'America/New_York').toISOString()).toBe('2026-11-02T13:00:00.000Z'); // EST
  });
});

describe('cronRunsToday', () => {
  it('places a house wake at its instant in the browser’s day, not at the cron’s bare hour', () => {
    expect(cronRunsToday('0 8 * * *', utc('2026-10-29T15:00:00Z'), 'America/New_York').map(d => d.toISOString())).toEqual(['2026-10-29T12:00:00.000Z']);
  });
  it('a late wake from the house’s previous day can land early in the browser’s day', () => {
    // 22:30 in New York on the 28th is 02:30 UTC on the 29th
    expect(cronRunsToday('30 22 * * *', utc('2026-10-29T15:00:00Z'), 'America/New_York').map(d => d.toISOString())).toEqual(['2026-10-29T02:30:00.000Z']);
  });
  it('a weekly wake keeps the house’s weekday', () => {
    // Sunday 21:00 in New York is Monday 02:00 UTC: it shows on the browser's Monday, not its Sunday
    expect(cronRunsToday('0 21 * * 0', utc('2026-11-01T15:00:00Z'), 'America/New_York')).toEqual([]);
    expect(cronRunsToday('0 21 * * 0', utc('2026-11-02T15:00:00Z'), 'America/New_York').map(d => d.toISOString())).toEqual(['2026-11-02T02:00:00.000Z']);
  });
  it('without a zone, or with an unknown one, reads the cron as local time', () => {
    expect(cronRunsToday('0 8 * * *', utc('2026-10-29T15:00:00Z'), null).map(d => d.toISOString())).toEqual(['2026-10-29T08:00:00.000Z']);
    expect(cronRunsToday('0 8 * * *', utc('2026-10-29T15:00:00Z'), 'Not/AZone').map(d => d.toISOString())).toEqual(['2026-10-29T08:00:00.000Z']);
  });
  it('a weekday wake does not run on a weekend, and a schedule that is not once a day gives nothing', () => {
    expect(cronRunsToday('0 9 * * 1-5', utc('2026-10-31T15:00:00Z'), 'UTC')).toEqual([]);
    expect(cronRunsToday('*/15 * * * *', utc('2026-10-29T15:00:00Z'), 'UTC')).toEqual([]);
  });
});
