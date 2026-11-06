// A stop fences the Outlook author loop: a pass in flight when stop() is called schedules no new timer and does not start (or store) a model call.
import { describe, it, expect, vi, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ calls: 0, gate: null as Promise<void> | null }));
vi.mock('./summarizer/index.js', () => ({
  summarizerEngine: () => 'claude:test',
  runSummary: async () => {
    h.calls++;
    if (h.gate) await h.gate;
    return '{}';
  },
}));

vi.mock('../config.js', async (orig) => ({ ...(await orig<object>()), getSanctumConfig: () => ({ agent: { model: 'm', model_autonomous: 'm' }, identity: { companion_name: 'Echo', user_name: 'Sam' } }) }));
vi.mock('./db.js', async (orig) => ({ ...(await orig<object>()), getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }) }));

import { startOutlookAuthor, stopOutlookAuthor, isOutlookAuthorRunning, authorOutlookNow, authorOutlook } from './outlook-author.js';

afterEach(() => { stopOutlookAuthor(); vi.useRealTimers(); h.gate = null; h.calls = 0; });

describe('outlook author stop fence', () => {
  it('a pass in flight when stop() is called leaves no new timer, and isRunning reports it until it ends', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let release!: () => void;
    h.gate = new Promise<void>((ok) => { release = ok; });
    startOutlookAuthor();
    await vi.advanceTimersByTimeAsync(60_000); // the first pass starts and waits in the model call
    expect(h.calls).toBe(1);
    expect(isOutlookAuthorRunning()).toBe(true);
    stopOutlookAuthor();
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(isOutlookAuthorRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // no timer recreated by the finished pass
  });

  it('after stop() no model call starts', async () => {
    startOutlookAuthor();
    stopOutlookAuthor();
    expect(await authorOutlook()).toBe(false);
    expect(await authorOutlookNow()).toBe(false);
    expect(h.calls).toBe(0);
  });
});
