// One short system line in a thread, shown in the app, and never part of what the model is told. The Discord
// service used to carry its own copy; the identity gate posts through the same function.
//
// `kind` rides in the message metadata. rolling-context.ts (isSpokenTurn) lists the kinds that stay out of the
// model's history: a system line is the app talking, never the person's words.
import { randomUUID } from 'node:crypto';
import { createMessage } from './db.js';
import { tenantLocal } from '../tenancy/context.js';

/** The slice of the socket registry this needs. */
export interface LineBroadcaster { broadcast(message: any): void }

// Per tenant in tenant mode (each tenant registers its own at boot); one for the process otherwise.
const registryLocal = tenantLocal<LineBroadcaster | null>(() => null);
/** server.ts registers the socket registry once; Discord passes its own. */
export function setSystemLineRegistry(r: LineBroadcaster | null): void { registryLocal.set(r); }

/** The kinds the app posts as system lines (metadata.kind). */
export const SYSTEM_LINE_KINDS = ['withheld', 'discord_notice', 'identity_pending', 'brain_notice'] as const;
export type SystemLineKind = typeof SYSTEM_LINE_KINDS[number];

/** Save a role-'system' message in `threadId` and push it to the open apps. Never throws; returns whether it was posted. */
export function postSystemLine(
  threadId: string,
  text: string,
  kind: SystemLineKind,
  metadata: Record<string, unknown> = {},
  opts: { platform?: 'web' | 'discord' | 'telegram' | 'api'; registry?: LineBroadcaster } = {},
): boolean {
  try {
    const msg = createMessage({
      id: randomUUID(),
      threadId,
      role: 'system',
      content: text,
      contentType: 'text',
      platform: opts.platform ?? 'web',
      metadata: { ...metadata, kind },
      createdAt: new Date().toISOString(),
    });
    (opts.registry ?? registryLocal.get())?.broadcast({ type: 'message', message: msg });
    return true;
  } catch (err) {
    console.error('[system-line] Could not post a system line:', err instanceof Error ? err.message : err);
    return false;
  }
}
