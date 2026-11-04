// A stop while start() awaits getMe(): the start is abandoned (no polling, no health interval), and a later stop/start pair does not leave two clients.
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ release: (() => {}) as () => void, launches: 0, getMe: null as Promise<{ username: string }> | null }));
vi.mock('telegraf', () => ({
  Telegraf: class {
    telegram = { getMe: () => h.getMe ?? Promise.resolve({ username: 'bot' }) };
    on() {} use() {} catch() {} command() {} action() {}
    launch() { h.launches++; return new Promise(() => {}); }
    stop() {}
  },
}));
vi.mock('../bot-token.js', async (orig) => ({ ...(await orig<object>()), getBotToken: () => 'tok' }));

vi.mock('../../config.js', async (orig) => ({ ...(await orig<object>()), getSanctumConfig: () => ({ identity: { companion_name: 'Echo', user_name: 'Sam' }, telegram: {} }) }));

import { TelegramService } from './index.js';

describe('telegram stop fence', () => {
  it('stop() during getMe: the start abandons, no polling, no interval, logs once', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    h.getMe = new Promise((ok) => { h.release = () => ok({ username: 'bot' }); });
    const svc = new TelegramService({} as never, { broadcast() {} } as never, {} as never);
    const starting = svc.start();
    const stopping = svc.stop();
    h.release();
    await starting; await stopping;
    expect(h.launches).toBe(0);
    expect(svc.isConnected()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.mock.calls.filter((c) => String(c[0]).includes('start abandoned')).length).toBe(1);
    // a later start (the revive) launches exactly once
    h.getMe = null;
    await svc.start();
    expect(h.launches).toBe(1);
    await svc.stop();
    vi.useRealTimers();
  });
});
