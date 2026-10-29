// D9: raw mention tokens in inbound text become names in the frame. Resolved from the message's own `mentions`
// collections (no fetches); the bot's own mention is stripped; @everyone / @here stay literal text.
import { describe, it, expect } from 'vitest';
import { resolveMentions } from './mentions.js';

const col = <T>(o: Record<string, T>) => ({ get: (id: string) => o[id] });
const BOT = '900';
const mentions = {
  users: col({ '111': { username: 'moss', globalName: 'Moss G' }, '222': { username: 'fern' }, '900': { username: 'her' } }),
  members: col({ '111': { displayName: 'Mossy' } }),
  roles: col({ '700': { name: 'Gardeners' } }),
  channels: col({ '800': { name: 'greenhouse' } }),
};

describe('resolveMentions', () => {
  it('replaces <@id> and <@!id> with @name: the server nickname, else the global name, else the username', () => {
    expect(resolveMentions('hi <@111> and <@!222>', mentions, BOT)).toBe('hi @Mossy and @fern');
    expect(resolveMentions('hi <@222>', { ...mentions, members: col({}) }, BOT)).toBe('hi @fern');
    expect(resolveMentions('hi <@111>', { ...mentions, members: col({}) }, BOT)).toBe('hi @Moss G');
  });

  it('replaces <@&roleId> with @role and <#channelId> with #channel', () => {
    expect(resolveMentions('ping <@&700> in <#800>', mentions, BOT)).toBe('ping @Gardeners in #greenhouse');
  });

  it('strips the bot\'s own mention, in either form, wherever it is, and tidies the spaces around it', () => {
    expect(resolveMentions('<@900> hello', mentions, BOT)).toBe('hello');
    expect(resolveMentions('<@!900> hello', mentions, BOT)).toBe('hello');
    expect(resolveMentions('hello <@900>', mentions, BOT)).toBe('hello');
    expect(resolveMentions('hey <@900> you there <@111>', mentions, BOT)).toBe('hey you there @Mossy');
    expect(resolveMentions('<@900>', mentions, BOT)).toBe('');
  });

  it('leaves @everyone and @here as literal text', () => {
    expect(resolveMentions('@everyone and @here look', mentions, BOT)).toBe('@everyone and @here look');
    expect(resolveMentions('<@900> @everyone', mentions, BOT)).toBe('@everyone');
  });

  it('a token that is not in the collections gets a neutral name, never a fetch and never the raw id', () => {
    expect(resolveMentions('<@555> <@&556> <#557>', mentions, BOT)).toBe('@unknown-user @unknown-role #unknown-channel');
    expect(resolveMentions('<@555>', undefined, BOT)).toBe('@unknown-user');
  });

  it('flattens and caps a name (it is chosen by a stranger), so it cannot carry a line break or a long message', () => {
    const m = { ...mentions, users: col({ '111': { username: 'x' } }), members: col({ '111': { displayName: `Line1\nLine2 ${'z'.repeat(80)}` } }) };
    const out = resolveMentions('<@111>', m, BOT);
    expect(out).not.toMatch(/\n/);
    expect(out.length).toBeLessThanOrEqual(1 + 32 + 1);
  });

  it('leaves text with no mention exactly as it was', () => {
    const t = 'plain text, an email a@b.com, <not a mention>, <@abc>, and\n\ntwo paragraphs  with  spacing';
    expect(resolveMentions(t, mentions, BOT)).toBe(t);
  });
});
