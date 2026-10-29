// Which Sanctum thread the owner lane writes to.
//
//   owner   ONE stable thread for the owner channel: discord-owner-<sha256(channelId) first 12 hex>,
//           created by the server on first use. No per-mention or per-day split, and never the most
//           recent web thread (that routing, gap-audit D3, is removed). A thread from before the lanes
//           (discord-<channelId>, or the id the old module derived for the channel) is kept and used
//           rather than starting a second one; when the canonical thread exists too, it wins.
//   public  no thread at all. The public lane is one isolated run per message with a file transcript
//           (public-runtime.ts, public-transcript.ts). The first lanes build routed it to
//           discord-public-<guild>-<hash> threads; those are left in place, no longer written, and
//           isLegacyPublicThread() recognises them so start() can say so once.

import { createHash } from 'node:crypto';
import { getDiscordThreadId } from './utils.js';

export interface ThreadStore {
  exists(id: string): boolean;
  create(id: string, name: string): void;
}

const hash12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export const ownerThreadId = (channelId: string) => `discord-owner-${hash12(channelId)}`;

/** A thread the first lanes build made for a public channel (discord-public-<guild>-<12 hex>). */
export const isLegacyPublicThread = (id: string) => /^discord-public-\d+-[0-9a-f]{12}$/.test(id);

export interface ResolvedThread {
  id: string;
  created: boolean;
  /** An older thread from before the lanes is being kept. */
  legacy: boolean;
}

export function resolveOwnerThread(store: ThreadStore, channelId: string): ResolvedThread {
  const canonical = ownerThreadId(channelId);
  if (store.exists(canonical)) return { id: canonical, created: false, legacy: false };
  for (const older of [`discord-${channelId}`, getDiscordThreadId(channelId)]) {
    if (store.exists(older)) return { id: older, created: false, legacy: true };
  }
  store.create(canonical, 'Discord (owner)');
  return { id: canonical, created: true, legacy: false };
}
