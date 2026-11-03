// D11: structured events in the logs service. A failure is one short line under a category (so the Settings log
// viewer, which tails the process logs, shows it and its filter finds it), and is counted for a status summary.
// Kinds only: no text, no id, no path ever goes through here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logEvent, eventSummary, resetEvents } from './logs.js';

const H = 3_600_000;

beforeEach(() => { resetEvents(); });

describe('logEvent', () => {
  it('writes one structured line under the category, to the error stream the viewer tails', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    logEvent('discord', 'reply_failed', { class: 'provider_error' });
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toBe('[discord] failure kind=reply_failed class=provider_error');
    err.mockRestore();
  });

  it('keeps only a safe kind and a safe class: anything else is reduced, never printed as given', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    logEvent('discord', 'reply failed: /home/x/secret.txt', { class: 'ENOENT /home/x/secret.txt\nat foo' });
    const line = String(err.mock.calls[0][0]);
    expect(line).not.toMatch(/secret|home|\n|ENOENT/);
    expect(line).toMatch(/^\[discord\] failure kind=[a-z0-9_]+$/);
    err.mockRestore();
  });

  it('once: the line is printed the first time only, but every occurrence is counted', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) logEvent('discord', 'api_key_missing', { once: true });
    expect(err).toHaveBeenCalledTimes(1);
    expect(eventSummary('discord').count24h).toBe(3);
    err.mockRestore();
  });
});

describe('eventSummary', () => {
  it('is empty before anything happened', () => {
    expect(eventSummary('discord')).toEqual({ count24h: 0, lastKind: null, lastAt: null, byKind: {} });
  });

  it('counts the last 24 hours of one category, newest kind and time', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.parse('2026-10-19T00:00:00Z');
    logEvent('discord', 'gate_error', { now: t0 });
    logEvent('discord', 'reply_failed', { now: t0 + 2 * H });
    logEvent('other', 'noise', { now: t0 + 3 * H });
    expect(eventSummary('discord', t0 + 4 * H)).toEqual({ count24h: 2, byKind: { gate_error: 1, reply_failed: 1 }, lastKind: 'reply_failed', lastAt: new Date(t0 + 2 * H).toISOString() });
    // 25 hours later the first has aged out, the second has not yet
    expect(eventSummary('discord', t0 + 25 * H).count24h).toBe(1);
    // and later still, none are counted, but the last kind is still known
    expect(eventSummary('discord', t0 + 30 * H)).toEqual({ count24h: 0, byKind: {}, lastKind: 'reply_failed', lastAt: new Date(t0 + 2 * H).toISOString() });
    vi.restoreAllMocks();
  });
});
