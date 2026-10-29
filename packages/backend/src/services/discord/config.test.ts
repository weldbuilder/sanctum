import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ kv: new Map<string, string>() }));

vi.mock('../db.js', () => ({
  getConfig: (k: string) => h.kv.get(k) ?? null,
  getConfigBool: (k: string, d: boolean) => (h.kv.has(k) ? h.kv.get(k) === 'true' : d),
  getConfigNumber: (k: string, d: number) => (h.kv.has(k) ? Number(h.kv.get(k)) : d),
}));
vi.mock('../../config.js', () => ({ getSanctumConfig: () => ({ discord: { owner: { user_id: '1' } } }) }));

import { getDiscordConfig } from './config.js';

beforeEach(() => h.kv.clear());

describe('getDiscordConfig', () => {
  it('the follow-up debounce is 2.5 s by default (the plan: the buffer is flushed with a 2.5 s debounce after the turn)', () => {
    expect(getDiscordConfig().followUpDebounceMs).toBe(2500);
    h.kv.set('discord.followUpDebounceMs', '4000');
    expect(getDiscordConfig().followUpDebounceMs).toBe(4000);
  });

  it('the legacy deferMaxAgeMs is null unless the DB key is explicitly set (no 10 minute default any more)', () => {
    expect(getDiscordConfig().deferMaxAgeMs).toBeNull();
    h.kv.set('discord.deferMaxAgeMs', '900000');
    expect(getDiscordConfig().deferMaxAgeMs).toBe(900000);
  });

  it('an unusable legacy value (not a positive number) counts as not set', () => {
    h.kv.set('discord.deferMaxAgeMs', 'soon');
    expect(getDiscordConfig().deferMaxAgeMs).toBeNull();
    h.kv.set('discord.deferMaxAgeMs', '0');
    expect(getDiscordConfig().deferMaxAgeMs).toBeNull();
  });
});
