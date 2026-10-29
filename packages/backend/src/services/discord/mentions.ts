// Mention tokens in inbound text (hole D9): `<@id>` / `<@!id>` become @name, `<@&id>` becomes @role, `<#id>` becomes
// #channel, for the frame the model reads. Names come from the message's own `mentions` collections: nothing is
// fetched, so an unknown id gets a neutral name, never the raw token. The bot's own mention is stripped (she knows she
// was addressed). `@everyone` and `@here` are plain text and are left as they are: they never address her (intake).
// Names are chosen by strangers, so each is flattened to one capped line.

import { oneLine } from './speaker.js';

const NAME_CAP = 32;
const BOT_MARK = '\u0000';
const TOKEN = /<@!?(\d{1,25})>|<@&(\d{1,25})>|<#(\d{1,25})>/g;

/** The part of discord.js's `message.mentions` this reads: id lookups only. */
export interface MentionCollections {
  users?: { get(id: string): { username?: string; globalName?: string | null } | undefined } | null;
  members?: { get(id: string): { displayName?: string } | undefined } | null;
  roles?: { get(id: string): { name?: string } | undefined } | null;
  channels?: { get(id: string): { name?: string } | undefined } | null;
}

export function resolveMentions(text: string, mentions: MentionCollections | undefined | null, botId: string): string {
  if (!text || !text.includes('<')) return text;
  let strippedBot = false;
  const flat = (s: unknown, fallback: string) => oneLine(typeof s === 'string' ? s : '', NAME_CAP) || fallback;

  const replaced = text.replace(/\u0000/g, '').replace(TOKEN, (_all, user: string | undefined, role: string | undefined, channel: string | undefined) => {
    if (user !== undefined) {
      if (botId && user === botId) { strippedBot = true; return BOT_MARK; }
      const member = mentions?.members?.get(user);
      const u = mentions?.users?.get(user);
      return `@${flat(member?.displayName ?? u?.globalName ?? u?.username, 'unknown-user')}`;
    }
    if (role !== undefined) return `@${flat(mentions?.roles?.get(role)?.name, 'unknown-role')}`;
    return `#${flat(mentions?.channels?.get(channel as string)?.name, 'unknown-channel')}`;
  });

  // Where her own mention was, the spaces around it close up; text with no mention of her is not touched.
  return strippedBot ? replaced.replace(/[ \t]*\u0000[ \t]*/g, ' ').trim() : replaced;
}
