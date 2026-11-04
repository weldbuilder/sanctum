// What happens to work that arrives while an in-app update is installing: a channel hears "Updating, back in a minute" once and is otherwise left alone,
// and a scheduler that skipped something runs it once when the pause ends (a failed update, or one that only installed).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UPDATING_REPLY, _resetUpdateBlock, createCatchUp, noticeOnce, onUpdateBlockCleared, setUpdateBlocking, updateBlocking,
} from './update-block.js';

beforeEach(() => { _resetUpdateBlock(); });
afterEach(() => { _resetUpdateBlock(); });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('the notice, once per channel', () => {
  it('says it the first time a channel is turned away during a pause, never again until the pause has ended', () => {
    setUpdateBlocking(true);
    expect(noticeOnce('discord:1')).toBe(true);
    expect(noticeOnce('discord:1')).toBe(false);
    expect(noticeOnce('discord:1')).toBe(false);
    expect(noticeOnce('discord:2')).toBe(true); // another channel has its own
    expect(noticeOnce('telegram:9')).toBe(true);
    setUpdateBlocking(false);
    setUpdateBlocking(true); // the next pause starts afresh
    expect(noticeOnce('discord:1')).toBe(true);
    expect(UPDATING_REPLY.split('\n')).toHaveLength(1);
  });
});

describe('catching up after the pause', () => {
  it('a scheduler that skipped something runs ONE catch-up pass when the pause ends, with each skipped item once', async () => {
    const run = vi.fn();
    const c = createCatchUp(run);
    setUpdateBlocking(true);
    c.skipped('morning'); c.skipped('morning'); c.skipped('evening');
    expect(c.skippedWhileBlocked).toBe(true);
    expect(run).not.toHaveBeenCalled(); // not while it is still paused
    setUpdateBlocking(false);
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['morning', 'evening']);
    expect(c.skippedWhileBlocked).toBe(false);
    setUpdateBlocking(true); setUpdateBlocking(false);
    await tick();
    expect(run).toHaveBeenCalledTimes(1); // nothing skipped in the second pause: nothing to catch up
    c.dispose();
  });

  it('a scheduler that skipped nothing does not run, and a disposed one does not either', async () => {
    const quiet = vi.fn(), gone = vi.fn();
    createCatchUp(quiet);
    const d = createCatchUp(gone);
    setUpdateBlocking(true);
    d.skipped('x'); d.dispose();
    setUpdateBlocking(false);
    await tick();
    expect(quiet).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  it('a throwing catch-up does not stop the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = createCatchUp(() => { throw new Error('boom'); });
    const ok = vi.fn();
    const good = createCatchUp(ok);
    setUpdateBlocking(true); bad.skipped(); good.skipped();
    setUpdateBlocking(false);
    await tick();
    expect(ok).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('hooks run each time the pause ends', () => {
    const fn = vi.fn();
    const off = onUpdateBlockCleared(fn);
    setUpdateBlocking(true); setUpdateBlocking(false);
    setUpdateBlocking(true); setUpdateBlocking(false);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    setUpdateBlocking(true); setUpdateBlocking(false);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(updateBlocking()).toBe(false);
  });
});

describe('the handoff schedule remembers a skipped midnight run', () => {
  it('a cron tick during the pause does not run the handoff; the end of the pause runs it once', async () => {
    vi.resetModules();
    let tickFn: (() => void) | null = null;
    vi.doMock('croner', () => ({ Cron: class { constructor(_e: string, _o: unknown, fn: () => void) { tickFn = fn; } stop() {} } }));
    vi.doMock('./db.js', async (orig) => ({ ...(await orig<typeof import('./db.js')>()), getConfig: () => 'true', setConfig: () => {} }));
    vi.doMock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), getSanctumConfig: () => ({ identity: { timezone: 'UTC' }, handoff: { enabled: true }, agent: { model: 'm' } }) }));
    vi.doMock('./agent.js', () => ({ isInteractiveAgentBusy: () => true })); // (so a run that does start says "deferred" and stops there)
    const mod = await import('./handoff.js');
    const blk = await import('./update-block.js');
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    mod.startHandoffSchedule();
    blk.setUpdateBlocking(true);
    tickFn!();
    expect(lines.join('\n')).toMatch(/\[handoff\] skipped — an update is installing/);
    expect(lines.join('\n')).not.toMatch(/deferred/); // not run while paused
    blk.setUpdateBlocking(false);
    await tick();
    expect(lines.join('\n')).toMatch(/\[handoff\] deferred — interactive turn in flight/); // the catch-up ran runHandoff, once
    expect(lines.filter((l) => /deferred/.test(l))).toHaveLength(1);
    blk.setUpdateBlocking(true); blk.setUpdateBlocking(false);
    await tick();
    expect(lines.filter((l) => /deferred/.test(l))).toHaveLength(1); // nothing skipped in a later pause
    mod.stopHandoffSchedule();
    log.mockRestore();
    vi.doUnmock('croner'); vi.doUnmock('./db.js'); vi.doUnmock('../config.js'); vi.doUnmock('./agent.js');
  });
});
