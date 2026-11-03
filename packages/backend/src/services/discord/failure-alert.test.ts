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
  noteDiscordFailure, noteDiscordSendOk, discordAlertActive, resetFailureAlert,
} from './failure-alert.js';
import { logEvent, resetEvents, setEventListener, eventSummary } from '../logs.js';
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
    expect(noteDiscordFailure('gate_error', { now: T0 + MIN, lane: 'owner', post })).toBe(false);
    expect(lines).toEqual([]);
    expect(noteDiscordFailure('gate_error', { now: T0 + 2 * MIN, lane: 'owner', post })).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('3 sends failed on the owner lane in the last 10 minutes');
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

describe('window edge', () => {
  it('a failure exactly one window old is out; one a millisecond younger is still in', () => {
    const W = 10 * MIN;
    noteDiscordFailure('reply_failed', { now: T0, post });
    noteDiscordFailure('reply_failed', { now: T0 + 1, post });
    expect(noteDiscordFailure('reply_failed', { now: T0 + W, post })).toBe(false);
    resetFailureAlert();
    noteDiscordFailure('reply_failed', { now: T0, post });
    noteDiscordFailure('reply_failed', { now: T0 + 1, post });
    expect(noteDiscordFailure('reply_failed', { now: T0 + W - 1, post })).toBe(true);
  });

  it('the hourly gap is exact: one millisecond short is quiet, exactly an hour raises', () => {
    const HOUR = 3_600_000;
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0, post });
    expect(lines).toHaveLength(1);
    h.cfg['discord.failureAlertWindowMin'] = 1440;
    expect(noteDiscordFailure('reply_failed', { now: T0 + HOUR - 1, post })).toBe(false);
    expect(noteDiscordFailure('reply_failed', { now: T0 + HOUR, post })).toBe(true);
  });
});

describe('per lane', () => {
  it('failures on one lane never count toward another, and a success clears its own lane only', () => {
    noteDiscordFailure('reply_failed', { now: T0, post });
    noteDiscordFailure('public_run_failed', { now: T0 + 1, post });
    noteDiscordFailure('reply_failed', { now: T0 + 2, post });
    expect(lines).toEqual([]);
    noteDiscordFailure('public_run_failed', { now: T0 + 3, post });
    expect(noteDiscordFailure('public_run_failed', { now: T0 + 4, post })).toBe(true);
    expect(lines[0]).toContain('on the public lane');
    noteDiscordFailure('reply_failed', { now: T0 + 5, post });
    expect(discordAlertActive('owner')).toBe(true);
    expect(noteDiscordSendOk('owner', { post })).toBe(true);
    expect(lines[2]).toBe('Discord: sends are going out again on the owner lane.');
    expect(discordAlertActive('owner')).toBe(false);
    expect(discordAlertActive('public')).toBe(true);
    expect(noteDiscordSendOk('public', { post })).toBe(true);
    expect(lines[3]).toBe('Discord: sends are going out again on the public lane.');
  });

  it('a gate_error is attributed to the lane it fired on, else it is its own bucket', () => {
    for (let i = 0; i < 3; i++) noteDiscordFailure('gate_error', { now: T0 + i, lane: 'public', post });
    expect(lines[0]).toContain('on the public lane');
    expect(discordAlertActive('public')).toBe(true);
    expect(discordAlertActive('owner')).toBe(false);
    resetFailureAlert(); lines.length = 0;
    for (let i = 0; i < 3; i++) noteDiscordFailure('gate_error', { now: T0 + i, post });
    expect(lines[0]).toContain('on the send gate');
    expect(discordAlertActive('owner')).toBe(false);
    expect(discordAlertActive('gate')).toBe(true);
  });
});

describe('rate limit', () => {
  it('raises at most one alert an hour while failures continue, then again after the hour', () => {
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + i, post });
    expect(lines).toHaveLength(1);
    for (let i = 0; i < 10; i++) noteDiscordFailure('reply_failed', { now: T0 + 30 * MIN + i, post });
    expect(lines).toHaveLength(1);
    const HOUR = 3_600_000;
    const later = T0 + HOUR + MIN;
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: later + i, post });
    expect(lines).toHaveLength(2);
  });

  it('a clear does not reset the limit: a new burst inside the hour stays quiet', () => {
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + i, post });
    noteDiscordSendOk('owner', { post });
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + 5 * MIN + i, post });
    expect(lines.filter((l) => l.includes('sends failed'))).toHaveLength(1);
  });
});

describe('clear', () => {
  it('says so once when a send goes out after an alert, and forgets the failures', () => {
    for (let i = 0; i < 3; i++) noteDiscordFailure('reply_failed', { now: T0 + i, post });
    expect(noteDiscordSendOk('owner', { post })).toBe(true);
    expect(lines[1]).toBe('Discord: sends are going out again on the owner lane.');
    expect(discordAlertActive()).toBe(false);
    expect(noteDiscordSendOk('owner', { post })).toBe(false);
    expect(lines).toHaveLength(2);
  });

  it('a send with no alert up is silent, and it resets the count', () => {
    noteDiscordFailure('reply_failed', { now: T0, post });
    noteDiscordFailure('reply_failed', { now: T0 + 1, post });
    expect(noteDiscordSendOk('owner', { post })).toBe(false);
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
    for (let i = 0; i < 3; i++) logEvent('discord', 'reply_failed');
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatch(/^Discord: 3 sends failed on the owner lane/);
  });
});

describe('the listener', () => {
  it('honours the now the event was logged with', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    logEvent('discord', 'reply_failed', { now: T0 });
    logEvent('discord', 'reply_failed', { now: T0 + 1 });
    // The third is 11 minutes later by its own clock: the first two have left the window, so no alert.
    logEvent('discord', 'reply_failed', { now: T0 + 11 * MIN });
    expect(h.posted).toEqual([]);
    logEvent('discord', 'reply_failed', { now: T0 + 11 * MIN + 1 });
    logEvent('discord', 'reply_failed', { now: T0 + 11 * MIN + 2 });
    expect(h.posted).toHaveLength(1);
  });

  it('a throwing listener never breaks logging: the event is still counted and printed', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setEventListener(() => { throw new Error('listener broke'); });
    try {
      expect(() => logEvent('discord', 'reply_failed')).not.toThrow();
      expect(eventSummary('discord')).toMatchObject({ count24h: 1, lastKind: 'reply_failed' });
      expect(err.mock.calls.flat().join('\n')).toContain('[discord] failure kind=reply_failed');
    } finally {
      setEventListener((c, k, o) => { if (c === 'discord') noteDiscordFailure(k, { now: o?.now, lane: o?.lane }); });
    }
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
    runInTenant(a, () => noteDiscordSendOk('owner', { post: (t) => aLines.push(t) }));
    expect(runInTenant(a, () => discordAlertActive())).toBe(false);
    expect(runInTenant(b, () => discordAlertActive())).toBe(true);
  });
});
