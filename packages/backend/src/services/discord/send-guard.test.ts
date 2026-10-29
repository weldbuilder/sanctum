// The one-send-path rule, enforced by reading the source: nothing in the Discord module (or any
// file that imports discord.js, in .ts, .js, .mjs or .cjs) touches send / reply / edit / rest
// except send.ts. It flags property ACCESS, not just calls, so an alias (`const s = channel.send`),
// a bound or applied function, an optional call, a bracket or computed key, and the raw REST route
// (`client.rest.post(Routes.channelMessages(...))`) are all caught.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSendAccess, touchesDiscord } from './send-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..');
const REPO = join(SRC, '..', '..', '..');


function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.(ts|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('findSendAccess (the matcher itself)', () => {
  it('flags discord.js calls', () => {
    expect(findSendAccess('await lastMessage.reply(x)')).toHaveLength(1);
    expect(findSendAccess('await channel.send({ content })')).toHaveLength(1);
    expect(findSendAccess('await (lastMessage.channel as TextChannel).send(chunks[i])')).toHaveLength(1);
    expect(findSendAccess('msg\n  .edit(\n  x)')).toHaveLength(1);
    expect(findSendAccess('client.users.cache.get(id)?.send(x)')).toHaveLength(1);
    expect(findSendAccess('interaction.editReply(x); interaction.followUp(y)')).toHaveLength(2);
  });

  it('flags the aliasing shapes the first matcher was blind to', () => {
    expect(findSendAccess('const s = channel.send; s("x")')).toHaveLength(1);
    expect(findSendAccess("channel['send']('x')")).toHaveLength(1);
    expect(findSendAccess('channel["reply"]("x")')).toHaveLength(1);
    expect(findSendAccess('channel[`send`]("x")')).toHaveLength(1);
    expect(findSendAccess('const f = channel.send.bind(channel)')).toHaveLength(1);
    expect(findSendAccess("channel.send.call(channel, 'x')")).toHaveLength(1);
    expect(findSendAccess("Reflect.apply(channel.send, channel, ['x'])").length).toBeGreaterThanOrEqual(1);
    expect(findSendAccess("Reflect.get(channel, 'send')")).toHaveLength(1);
    expect(findSendAccess("channel?.send?.('x')")).toHaveLength(1);
    expect(findSendAccess("channel?.['send']?.('x')")).toHaveLength(1);
    expect(findSendAccess("channel['se' + 'nd']('x')")).toHaveLength(1);
    expect(findSendAccess('channel[`${a}end`]("x")')).toHaveLength(1);
    expect(findSendAccess("const k = 'send'; channel[k]('x')")).toHaveLength(1);
    expect(findSendAccess('const { send } = channel; send("x")')).toHaveLength(1);
    expect(findSendAccess('const { reply: r } = message')).toHaveLength(1);
    expect(findSendAccess('await client.rest.post(Routes.channelMessages(id), { body })').length).toBeGreaterThanOrEqual(2);
    expect(findSendAccess('const rest = new REST({ version: "10" })')).toHaveLength(1);
    expect(findSendAccess("const w = new WebhookClient({ url })")).toHaveLength(1);
    expect(findSendAccess('this.client.rest')).toHaveLength(1);
  });

  it('does not trip on Express, WebSocket, reactions, prose, strings or ordinary brackets', () => {
    expect(findSendAccess('res.send(html)')).toEqual([]);
    expect(findSendAccess('ws.send(JSON.stringify(m))')).toEqual([]);
    expect(findSendAccess("res.status(500).json({ error: 'x' })")).toEqual([]);
    expect(findSendAccess("if ('send' in lastMessage.channel) {}")).toEqual([]);
    expect(findSendAccess('await m.react("x")')).toEqual([]);
    expect(findSendAccess('// call message.reply( here\nconst a = 1;')).toEqual([]);
    expect(findSendAccess('/* channel.send( */ const a = 1;')).toEqual([]);
    expect(findSendAccess('const s = "x.send(y)"; const t = `a.reply(${b})`;')).toEqual([]);
    expect(findSendAccess("const xs = ['a', 'b']; const y = xs[0]; const z = map['key']; return ['send'];")).toEqual([]);
    expect(findSendAccess('const sendLater = 1; const replyTo = 2; x.sendLater(); y.editor')).toEqual([]);
  });

  it('reads code inside a template expression', () => {
    expect(findSendAccess('const s = `${channel.send("x")}`')).toHaveLength(1);
  });
});

describe('findSendAccess: the other text-leaving calls (D-guard)', () => {
  it('flags a topic, a thread, a forward, an activity, a presence and a webhook', () => {
    expect(findSendAccess('await channel.setTopic("x")')).toHaveLength(1);
    expect(findSendAccess('await channel.threads.create({ name: "x" })')).toHaveLength(1);
    expect(findSendAccess('await message.channel?.threads?.create({ name: "x" })')).toHaveLength(1);
    expect(findSendAccess('await message.forward(other)')).toHaveLength(1);
    expect(findSendAccess('client.user.setActivity("hello")')).toHaveLength(1);
    expect(findSendAccess('client.user?.setPresence({ activities: [] })')).toHaveLength(1);
    expect(findSendAccess('await channel.createWebhook({ name: "x" })')).toHaveLength(1);
    expect(findSendAccess("channel['setTopic']('x')")).toHaveLength(1);
    expect(findSendAccess('const { createWebhook } = channel')).toHaveLength(1);
  });

  it('does not trip on prose, other creates or longer names', () => {
    expect(findSendAccess('// channel.setTopic(x)\nconst a = 1;')).toEqual([]);
    expect(findSendAccess('const t = db.threads.createdAt; await createThread(x); x.forwardTo(y); const setActivityLog = 1;')).toEqual([]);
    expect(findSendAccess('await fs.promises.create(x)')).toEqual([]);
  });
});

describe('findSendAccess: names, nicknames, threads, channels, events, roles, emojis, pins (B3c)', () => {
  const flagged: Record<string, string> = {
    'channel.setName': 'await channel.setName("x")',
    'guild.setName': 'guild.setName("x")',
    'member.setNickname': 'await guild.members.me.setNickname("x")',
    'message.startThread': 'await message.startThread({ name: "x" })',
    'guild.channels.create': 'await guild.channels.create({ name: "x", topic: "y" })',
    'optional channels.create': 'await guild?.channels?.create({ name: "x" })',
    'scheduledEvents.create': 'await guild.scheduledEvents.create({ name: "x", description: "y" })',
    'stageInstances.create': 'await guild.stageInstances.create(ch, { topic: "x" })',
    'roles.create': 'await guild.roles.create({ name: "x" })',
    'emojis.create': 'await guild.emojis.create({ attachment: a, name: "x" })',
    'setUsername': 'await client.user.setUsername("x")',
    'message.pin': 'await message.pin()',
    'messages.pin': 'await channel.messages.pin(id)',
    'crosspost': 'await message.crosspost()',
    'bulkDelete': 'await channel.bulkDelete(50)',
    'react, custom emoji <:name:id>': 'await message.react("<:wave:123456789012345678>")',
    'react, animated custom emoji': "await message.react('<a:wave:123456789012345678>')",
    'react, name:id': 'await message.react("wave:123456789012345678")',
    'react, a bare snowflake': 'await message.react("123456789012345678")',
    'react, a template string': 'await message.react(`<:wave:${id}>`)',
    'react, an emoji that is not a literal': 'await message.react(emoji)',
    'bracket key': "channel['setName']('x')",
    'destructured': 'const { setNickname } = me',
  };
  for (const [name, src] of Object.entries(flagged)) {
    it(`flags ${name}`, () => { expect(findSendAccess(src).length).toBeGreaterThanOrEqual(1); });
  }

  it('does not trip on prose, longer names, other creates or a unicode reaction', () => {
    expect(findSendAccess('// channel.setName(x) and guild.roles.create()\nconst a = 1;')).toEqual([]);
    expect(findSendAccess('const t = "message.pin()"; const u = `x.setNickname(${y})`;')).toEqual([]);
    expect(findSendAccess('x.pinned; x.pinThread(id); x.setNameLater(); x.crossposted; x.bulkDeleted')).toEqual([]);
    expect(findSendAccess('const when = fs.channels.createdAt; await fs.promises.create(x); roles.createdTotal++')).toEqual([]);
    expect(findSendAccess("await m.react('\\u23F3'); await m.react('⏳'); await m.react('x')")).toEqual([]);
  });
});

describe('touchesDiscord: which files the guard reads', () => {
  it('static import, require, a dynamic import and a DiscordService construction all count', () => {
    expect(touchesDiscord("import { Client } from 'discord.js';")).toBe(true);
    expect(touchesDiscord("const d = require('discord.js');")).toBe(true);
    expect(touchesDiscord("const { Client } = await import('discord.js');")).toBe(true);
    expect(touchesDiscord('const m = await import( "discord.js" )')).toBe(true);
    expect(touchesDiscord("import { REST } from '@discordjs/rest';")).toBe(true);
    expect(touchesDiscord('const service = new DiscordService(agent, registry);')).toBe(true);
  });

  it('a comment, a string that mentions it, or the class name alone do not', () => {
    expect(touchesDiscord('const a = 1; // import(\'discord.js\') is how it loads')).toBe(false);
    expect(touchesDiscord('const DiscordServiceName = "DiscordService";')).toBe(false);
    expect(touchesDiscord("import type { DiscordService } from './index.js';")).toBe(false);
  });
});

describe('only send.ts talks to Discord', () => {
  const discordDir = join(SRC, 'services', 'discord');
  const candidates = new Set<string>(walk(discordDir));
  for (const root of [SRC, join(REPO, 'scripts'), join(REPO, 'tools'), join(REPO, 'packages', 'shared', 'src')]) {
    for (const f of walk(root)) if (touchesDiscord(readFileSync(f, 'utf-8'))) candidates.add(f);
  }

  it('reads the files that build a DiscordService, and the routes and server that start it', () => {
    const names = [...candidates].map((f) => relative(REPO, f).replace(/\\/g, '/'));
    expect(names).toContain('packages/backend/src/server.ts');
    expect(names).toContain('packages/backend/src/routes/discord.ts');
  });

  it('looks at the whole Discord folder', () => {
    expect(candidates.size).toBeGreaterThan(5);
    expect([...candidates].some((f) => f.endsWith('send.ts'))).toBe(true);
  });

  it('scans .js and .mjs as well as .ts', () => {
    expect(walk(join(REPO, 'scripts')).some((f) => f.endsWith('.mjs'))).toBe(true);
  });

  for (const f of candidates) {
    const rel = relative(REPO, f);
    if (f.endsWith(join('discord', 'send.ts'))) continue;
    if (f.endsWith(join('discord', 'send-scan.ts'))) continue; // the scanner itself: its patterns spell the names out
    it(`${rel} never touches send / reply / edit / rest`, () => {
      expect(findSendAccess(readFileSync(f, 'utf-8'))).toEqual([]);
    });
  }

  it('send.ts does make them (the guard is not vacuous)', () => {
    expect(findSendAccess(readFileSync(join(discordDir, 'send.ts'), 'utf-8')).length).toBeGreaterThan(0);
  });
});

describe('findSendAccess: B3d, the rest of the calls that reach people, and the two reaction bypasses', () => {
  const flagged: Record<string, string> = {
    'interaction.update': 'await interaction.update({ content: "x" })',
    'a button interaction update': 'await buttonInteraction.update({ content: "x" })',
    'optional interaction update': 'await interaction?.update?.({ content: "x" })',
    'webhook.editMessage': 'await webhook.editMessage(id, "x")',
    'editReply': 'await interaction.editReply("x")',
    'followUp': 'await interaction.followUp("x")',
    'message.delete()': 'await message.delete()',
    'delete with a reason': 'await channel.delete("why")',
    'a fetched message deleted': 'await (await ch.messages.fetch(id)).delete()',
    'messages.delete(id)': 'await channel.messages.delete(id)',
    'roles.delete(id)': 'await guild.roles.delete(id)',
    'bracket delete': "await message['delete']()",
    'voice setStatus': 'await voice.setStatus("x")',
    'sendTyping': 'await channel.sendTyping()',
    'a cast sendTyping': '(lastMessage.channel as TextChannel).sendTyping().catch(() => {})',
    'createInvite': 'await channel.createInvite({ maxAge: 0 })',
    'setAvatar': 'await client.user.setAvatar(buf)',
    'setBanner': 'await client.user.setBanner(buf)',
    'suppressEmbeds': 'await message.suppressEmbeds(true)',
    'setArchived': 'await thread.setArchived(true)',
    'commands.create': 'await client.application.commands.create({ name: "x", description: "y" })',
    'commands.set': 'await guild.commands.set([])',
    'optional commands.set': 'await guild?.commands?.set([])',
  };
  for (const [name, src] of Object.entries(flagged)) {
    it(`flags ${name}`, () => { expect(findSendAccess(src).length).toBeGreaterThanOrEqual(1); });
  }

  const reactBypasses: Record<string, string> = {
    'an escaped quote in the literal': "await m.react('\\'<:x:1>')",
    'an escaped quote in a double-quoted literal': 'await m.react("\\"<:x:1>")',
    'a unicode-escaped custom emoji': "await m.react('\\u003C:x:1>')",
    'a hex-escaped custom emoji': "await m.react('\\x3C:x:1>')",
    'a concatenated custom emoji': "await m.react('<:x:' + '1>')",
    'a literal followed by something': "await m.react('<:x:' + id)",
    'bracket access, custom emoji': 'await message["react"]("<:x:1>")',
    'bracket access, a variable': 'await message["react"](emoji)',
    'optional bracket access': "await message?.['react']?.(e)",
    'bracket access, never called': "const r = message['react']",
    'a key bound to react': "const k = 'react'; await message[k]('<:x:1>')",
    'destructured react': 'const { react } = message',
  };
  for (const [name, src] of Object.entries(reactBypasses)) {
    it(`flags ${name}`, () => { expect(findSendAccess(src).length).toBeGreaterThanOrEqual(1); });
  }

  it('does not trip on Map and Set deletes, other updates or a unicode reaction in any spelling', () => {
    expect(findSendAccess('this.running.delete(key); timers.delete(k); this.followUps.delete(key); seen.delete(id)')).toEqual([]);
    expect(findSendAccess('store.update(row); db.update(x); this.state.update(y)')).toEqual([]);
    expect(findSendAccess('x.setStatusText(1); x.commandsList.set(a, b); const commandsCreated = 1; x.deleted; x.deleteLater()')).toEqual([]);
    expect(findSendAccess("await m.react('\\u23F3'); await m.react('⏳'); await m.react(\"👍\"); await m['react']('⏳')")).toEqual([]);
    expect(findSendAccess('// message.delete() and interaction.update(x)\nconst a = 1;')).toEqual([]);
  });
});
