// What GET /api/discord/status reports about the lanes and the gate. Read-only, and never an
// entry from a list, a guild id, a user id or a filesystem path: counts, states and error KINDS only.

import type { DiscordConfig } from '../../config.js';
import type { GateStatus } from './gate.js';
import type { DiscordPaths } from './paths.js';
import type { ExclusionsStatus } from './lanes.js';
import type { EventSummary } from '../logs.js';

export type OwnerLaneState = 'off' | 'unconfigured' | 'blocked' | 'on';
export type PublicLaneState = 'off' | 'paused' | 'blocked' | 'unsupported_harness' | 'on';

export interface DiscordGateStatus {
  words: GateStatus;
  names: GateStatus;
}

export interface DiscordStatus {
  lanes: {
    owner: { state: OwnerLaneState; userIdSet: boolean; channelIdSet: boolean };
    public: { state: PublicLaneState; enabled: boolean; guilds: number; bots: 'never' | 'capped' };
  };
  gate: DiscordGateStatus;
  /** The public lane's exclusions file: loaded, or failed with a kind. Failed means the public lane is silent. */
  exclusions: ExclusionsStatus;
  paused: boolean;
  /** The private folder, as a state: never its path. `clash` is the config key of the writable root it hit. */
  privateDir: { configured: boolean; refused: boolean; clash?: string };
  /** Settings the app refused because the companion could write there: the key and the root's key, no paths. */
  refused: Array<{ key: string; clash: string }>;
  /** Failures of the last 24 hours (a reply that failed, a gate that could not run, an exclusions file or API key or identity that was missing): kinds and times, never text. */
  recentFailures: EventSummary;
}

export interface StatusOptions {
  /** The DB override `discord.ownerUserId` (Settings), which wins over yaml in the running app. */
  ownerUserIdOverride?: string;
  /** The exclusions file's state; omitted means loaded. */
  exclusions?: ExclusionsStatus;
  /** Whether the active harness can run the public lane (false on Codex); omitted means yes. */
  publicHarnessSupported?: boolean;
  /** The logs service's summary for the discord category; omitted means none. */
  recentFailures?: EventSummary;
}

export function buildDiscordStatus(cfg: DiscordConfig, paths: DiscordPaths, gate: DiscordGateStatus, opts: StatusOptions = {}): DiscordStatus {
  // A gate that cannot run blocks every send, on both lanes, so both lanes say so.
  const gateFailed = gate.words.state !== 'loaded' || gate.names.state === 'failed';
  const userIdSet = !!(opts.ownerUserIdOverride?.trim() || cfg.owner.user_id);
  const channelIdSet = !!cfg.owner.channel_id;
  const exclusions: ExclusionsStatus = opts.exclusions ?? { state: 'loaded' };

  let owner: OwnerLaneState = 'on';
  if (!cfg.enabled) owner = 'off';
  else if (!userIdSet || !channelIdSet) owner = 'unconfigured';
  else if (gateFailed) owner = 'blocked';

  let pub: PublicLaneState = 'on';
  if (!cfg.enabled || !cfg.public.enabled) pub = 'off';
  else if (opts.publicHarnessSupported === false) pub = 'unsupported_harness'; // it cannot run at all: that outranks pause and the gate
  else if (cfg.paused) pub = 'paused';
  else if (gateFailed || exclusions.state === 'failed') pub = 'blocked';

  const dirRefusal = paths.refused.find((r) => r.key === 'discord.private_dir');
  const dirState: DiscordStatus['privateDir'] = dirRefusal
    ? { configured: false, refused: true, clash: dirRefusal.clash }
    : { configured: !!paths.privateDir, refused: false };

  return {
    lanes: {
      owner: { state: owner, userIdSet, channelIdSet },
      public: { state: pub, enabled: cfg.public.enabled, guilds: cfg.public.guild_ids.length, bots: cfg.public.bots },
    },
    gate,
    exclusions,
    paused: cfg.paused,
    privateDir: dirState,
    refused: paths.refused.map((r) => ({ key: r.key, clash: r.clash })),
    recentFailures: opts.recentFailures ?? { count24h: 0, lastKind: null, lastAt: null, byKind: {} },
  };
}
