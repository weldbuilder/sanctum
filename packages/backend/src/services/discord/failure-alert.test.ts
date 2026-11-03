// D11, the alert half: the threshold, the hourly rate limit, the clear, tenant isolation, and the logs-service wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ cfg: {} as Record<string, number>, posted: [] as string[] }));
vi.mock('../db.js', () => ({
  getConfigNumber: (k: string, d: number) => (k in h.cfg ? h.cfg[k] : d),
  ensureDailyThread: () => ({ thread: { id: 'thread-1' } }),
}));
vi.mock('../system-line.js', () => ({
  postSystemLine: (_thread: string, text: string) => { h.posted.push(text); return true; },
}));

import {
  noteDiscordFailure, noteDiscordSendOk, discordAlertActive, resetFailureAlert, ALERT_MIN_GAP_MS,
} from './failure-alert.js';
import { logEvent, resetEvents } from '../logs.js';
import { enableTenancy, runInTenant } from '../../tenancy/context.js';
import { fakeRuntime } from '../../tenancy/test-runtime.js';

const T0 = Date.parse('2026-11-03T12:00:00Z');
const MIN = 60_000;
const lines: string[] = [];
const post = (t: string) => { lines.push(t); };

beforeEach(() => {
  h.cfg = {}; h.posted = []; lines.length = 0;
  resetFailureAlert(); resetEvents();
});
afterEach(() => enableTenancy(false));

describe('threshold', () => {
  it('raises one alert on the third failure inside ten minutes, not before', () => {
    expect(noteDiscordFailure('reply_failed', { now: T0, post })).toBe(false);
    expect(noteDiscordFailure('public_run_failed', { now: T0 + MIN, post })).toBe(false);
    expect(lines).toEqual([]);
    expect(noteDiscordFailure('gate_error', { now: T0 + 2 * MIN, post })).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('3 sends failed in the last 10 minutes');
    expect(discordAlertActive()).toBe(true);
  });

  it('does not count failures that fell out of the window', () => {
    noteDiscordFailure('reply_failed', { now: T0, post });
    noteDiscordFailure('reply_failed', { now: T0 + MIN, post });
    expect(noteDiscordFailure('reply_failed', { now: T0 + 11 * MIN, post })).toBe(false);
    expect(lines).toEqual([]);
  });

  it('does not count setup kinds', () => {
    for (let i = 0; i < 5; i++) noteDiscordFailure('api_key_missing', { now: T0 + i, post });
    noteDiscordFailure('exclusions_failed', { now: T0 + 6, post });
    expect(lines).toEqual([]);
  });

  it('reads the threshold and window from the config keys', () => {
    h.cfg['discord.failureAlertCount'] = 2;
    h.cfg['discord.failureAlertWindowMin'] = 5;
    noteDiscordFailure('reply_failed', { now: T0, post });
    expect(noteDiscordFailure('reply_failed', { now: T0 + 4 * MIN, post })).toBe(true);
    expect(lines[0]).toContain('last 5 minutes');
  });

  it('falls back to the defaults for a nonsense value', () => {
    h.cfg['discord.failureAlertCount'] = Number.NaN;
    noteDiscordFailure('reply_failed', { now: T0, post });
    noteDiscordFailure('reply_failed', { now: T0 + 1, post });
    expect(lines).toEqual([]);
    noteDiscordFailure('reply_failed', { now: T0 + 2, post });
    expect(lines).toHaveLength(1);
  });
});

describe('rate limit', () => {
  it('raises at most one alert an hour while failures continue, then again after the hour', () => {
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + i, post });
    expect(lines).toHaveLength(1);
    for (let i = 0; i < 10; i++) noteDiscordFailure('reply_failed', { now: T0 + 30 * MIN + i, post });
    expect(lines).toHaveLength(1);
    const later = T0 + ALERT_MIN_GAP_MS + MIN;
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: later + i, post });
    expect(lines).toHaveLength(2);
  });

  it('a clear does not reset the limit: a new burst inside the hour stays quiet', () => {
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + i, post });
    noteDiscordSendOk({ post });
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + 5 * MIN + i, post });
    expect(lines.filter((l) => l.includes('sends failed'))).toHaveLength(1);
  });
});

describe('clear', () => {
  it('says so once when a send goes out after an alert, and forgets the failures', () => {
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + i, post });
    expect(noteDiscordSendOk({ post })).toBe(true);
    expect(lines[1]).toBe('Discord: sends are going out again.');
    expect(discordAlertActive()).toBe(false);
    expect(noteDiscordSendOk({ post })).toBe(false);
    expect(lines).toHaveLength(2);
  });

  it('a send with no alert up is silent, and it resets the count', () => {
    noteDiscordFailure('reply_failed', { now: T0, post });
    noteDiscordFailure('reply_failed', { now: T0 + 1, post });
    expect(noteDiscordSendOk({ post })).toBe(false);
    expect(noteDiscordFailure('reply_failed', { now: T0 + 2, post })).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe('the logs service feeds it', () => {
  it('three logged discord failures post one line into the app thread; other categories and kinds never do', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    logEvent('telegram', 'reply_failed'); logEvent('telegram', 'reply_failed'); logEvent('telegram', 'reply_failed');
    logEvent('discord', 'api_key_missing'); logEvent('discord', 'api_key_missing'); logEvent('discord', 'api_key_missing');
    expect(h.posted).toEqual([]);
    logEvent('discord', 'reply_failed'); logEvent('discord', 'reply_failed'); logEvent('discord', 'reply_failed');
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatch(/^Discord: 3 sends failed/);
  });
});

describe('tenant isolation', () => {
  it("tenant A's failures never alert tenant B, and A's clear leaves B's alert up", () => {
    enableTenancy(true);
    const a = fakeRuntime('a');
    const b = fakeRuntime('b');
    const aLines: string[] = [];
    const bLines: string[] = [];
    runInTenant(a, () => { for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + i, post: (t) => aLines.push(t) }); });
    runInTenant(b, () => { noteDiscordFailure('reply_failed', { now: T0 + 3, post: (t) => bLines.push(t) }); });
    expect(aLines).toHaveLength(1);
    expect(bLines).toEqual([]);
    expect(runInTenant(a, () => discordAlertActive())).toBe(true);
    expect(runInTenant(b, () => discordAlertActive())).toBe(false);
    // B's two more failures reach B's own threshold: three in B alone, not five across both.
    runInTenant(b, () => { for (let i = 4; i < 6; i++) noteDiscordFailure('reply_failed', { now: T0 + i, post: (t) => bLines.push(t) }); });
    expect(bLines).toHaveLength(1);
    runInTenant(a, () => noteDiscordSendOk({ post: (t) => aLines.push(t) }));
    expect(runInTenant(a, () => discordAlertActive())).toBe(false);
    expect(runInTenant(b, () => discordAlertActive())).toBe(true);
  });
});
