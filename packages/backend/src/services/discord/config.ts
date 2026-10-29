// Discord configuration — DB-backed with config.yaml fallback defaults
// Reads from config table (key-value store) with sensible defaults

import { getConfig, getConfigNumber } from '../db.js';
import { getSanctumConfig } from '../../config.js';

export interface DiscordConfigValues {
  ownerUserId: string;
  debounceMs: number;
  ownerActiveThresholdMin: number;
  deferPollIntervalMs: number;
  /** The legacy DB key `discord.deferMaxAgeMs`: null unless it is explicitly set (then it overrides `discord.deferral_hours`). */
  deferMaxAgeMs: number | null;
  /** Quiet time after a run, and between messages, before a queued follow-up runs. */
  followUpDebounceMs: number;
}

const DEFAULTS = {
  debounceMs: 1500,
  ownerActiveThresholdMin: 3,
  deferPollIntervalMs: 30000,
  followUpDebounceMs: 2500,
};

function legacyDeferMaxAgeMs(): number | null {
  const raw = getConfig('discord.deferMaxAgeMs');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getDiscordConfig(): DiscordConfigValues {
  const appConfig = getSanctumConfig();
  return {
    ownerUserId: getConfig('discord.ownerUserId') || appConfig.discord.owner.user_id || '',
    debounceMs: getConfigNumber('discord.debounceMs', DEFAULTS.debounceMs),
    ownerActiveThresholdMin: getConfigNumber('discord.ownerActiveThresholdMin', DEFAULTS.ownerActiveThresholdMin),
    deferPollIntervalMs: getConfigNumber('discord.deferPollIntervalMs', DEFAULTS.deferPollIntervalMs),
    deferMaxAgeMs: legacyDeferMaxAgeMs(),
    followUpDebounceMs: getConfigNumber('discord.followUpDebounceMs', DEFAULTS.followUpDebounceMs),
  };
}

// The debouncer's view of the config (read from the DB on each access).
export const DISCORD_CONFIG = {
  get debounceMs() { return getDiscordConfig().debounceMs; },
};
