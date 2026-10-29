// The matcher behind send-guard.test.ts: everything in a source file that reaches for Discord's
// send / reply / edit / rest by any road, and the other calls that put text on Discord (a channel topic, a thread, a
// forward, a presence or activity line, a webhook). It flags property ACCESS (not only calls), so aliases,
// bound or applied functions, optional calls, bracket and computed keys, destructuring and the raw
// REST route are all caught. Express (`res.send`) and a WebSocket (`ws.send`) are exempt by name.
// Anything that puts words in front of other people goes through send.ts: sendGated, or gatedAction for the rest.

const BLOCKED = [
  'send', 'reply', 'edit', 'editReply', 'followUp', 'rest', 'setTopic', 'forward', 'setActivity', 'setPresence', 'createWebhook',
  // Names, nicknames, threads, pins and the like: words (or a picture) other people read, set from the bot.
  'setName', 'setNickname', 'setUsername', 'startThread', 'pin', 'crosspost', 'bulkDelete',
  // The rest of what reaches people or changes what they see: a webhook edit, a voice status, an invite, the bot's picture
  // and banner, an embed taken off a message, a thread archived, and the typing indicator (it goes through send.ts too).
  'editMessage', 'setStatus', 'createInvite', 'setAvatar', 'setBanner', 'suppressEmbeds', 'setArchived', 'sendTyping',
];
/** Receivers of `.delete(` that are Discord objects or their managers (a message, a channel, a role, `messages`, ...). A Map or
 *  a Set deleting a key is not one; `.delete()` with no argument is always flagged (only a Discord object deletes itself). */
const DELETE_RECEIVERS = new Set([
  'message', 'msg', 'channel', 'thread', 'role', 'emoji', 'sticker', 'webhook', 'interaction', 'invite', 'event', 'guild', 'reaction', 'reply', 'ref', 'sound', 'forum',
  'messages', 'channels', 'threads', 'roles', 'emojis', 'stickers', 'scheduledEvents', 'stageInstances', 'webhooks', 'invites', 'reactions', 'commands',
]);
/** `<receiver>.create(...)` on these makes something with a name or a topic in front of people. */
const CREATORS = ['threads', 'channels', 'scheduledEvents', 'stageInstances', 'roles', 'emojis', 'stickers'];
/** A custom emoji reaction, read the way discord.js reads it (unanchored, and percent-decoded): anything with a colon or a % in it,
 *  `<:name:id>`, `<a:name:id>`, `name:id`, `'<:x:1>`, or a long run of digits (a snowflake). A unicode emoji has none of them. */
const CUSTOM_EMOJI = /[:%]|\d{15,}/;
/** Receivers that are not Discord: an Express response and a WebSocket. */
const EXEMPT = new Set(['res', 'response', 'ws', 'socket']);
const KEYWORDS = new Set(['return', 'typeof', 'in', 'of', 'case', 'yield', 'await', 'else', 'new', 'void', 'delete', 'throw', 'do', 'instanceof']);
const FILL = '\u0001';

/** A string literal's text as the engine reads it: `\\'`, `\\n`, `\\xHH`, `\\uHHHH` and `\\u{H...}` decoded. */
function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g, (_m, _all, brace, u4, x2, ch) => {
    const hex = brace ?? u4 ?? x2;
    if (hex !== undefined) { const cp = parseInt(hex, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[ch] ?? ch;
  });
}

/** Comments become spaces; string and template bodies become FILL (quotes stay), so positions line
 *  up with the source and prose that mentions `.send(` is not code. `${...}` inside a template is code. */
function scrub(src: string, keepStrings = false): string {
  let out = '';
  let i = 0;
  const stack: Array<'tpl' | 'brace'> = [];
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    const inTpl = stack[stack.length - 1] === 'tpl';
    if (inTpl) {
      if (c === '\\') { out += FILL + (n === undefined ? '' : FILL); i += 2; continue; }
      if (c === '`') { out += '`'; stack.pop(); i++; continue; }
      if (c === '$' && n === '{') { out += '${'; stack.push('brace'); i += 2; continue; }
      out += c === '\n' ? '\n' : FILL; i++; continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue;
    }
    if (keepStrings && (c === "'" || c === '"' || c === '`')) {
      // Comments are blanked and strings are kept as they are.
      const q = c;
      out += c; i++;
      while (i < src.length && src[i] !== q && !(q !== '`' && src[i] === '\n')) { if (src[i] === '\\') { out += src[i]; i++; } out += src[i] ?? ''; i++; }
      if (src[i] === q) { out += q; i++; }
      continue;
    }
    if (c === "'" || c === '"') {
      out += c; i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') { out += FILL; i++; } out += FILL; i++; }
      if (src[i] === c) { out += c; i++; }
      continue;
    }
    if (c === '`') { out += '`'; stack.push('tpl'); i++; continue; }
    if (stack.length && c === '{') { stack.push('brace'); out += c; i++; continue; }
    if (stack.length && c === '}') { stack.pop(); out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/** Everything in `source` that reaches for Discord's send / reply / edit / rest by any road. */
export function findSendAccess(source: string): string[] {
  const code = scrub(source);
  const hits: string[] = [];
  const names = BLOCKED.join('|');

  // 1. Property access by dot or optional chain: a call or not.
  const dot = new RegExp(`([A-Za-z_$][\\w$]*|[\\])])\\s*(?:\\?\\.|\\.)\\s*(${names})(?![\\w$])`, 'g');
  for (let m; (m = dot.exec(code)); ) if (!EXEMPT.has(m[1])) hits.push(`${m[1]}.${m[2]}`);

  // 1b. Making a thread, channel, event, stage, role, emoji or sticker: `.<kind>.create(`, however it is chained.
  const create = new RegExp(`(?<![\\w$])(${CREATORS.join('|')})\\s*(?:\\?\\.|\\.)\\s*create(?![\\w$])`, 'g');
  for (let m; (m = create.exec(code)); ) hits.push(`${m[1]}.create`);

  // 1c. A reaction is a picture: unicode emoji only. A custom emoji, a template, a variable, a literal that is built up
  // (`'<:x:' + id`) or an alias is flagged. The literal is read as the JavaScript engine reads it, escapes decoded.
  const checkReactArgument = (from: number) => {
    let i = from;
    while (/\s/.test(code[i] ?? '')) i++;
    const q = code[i];
    if (q !== '"' && q !== "'") { hits.push('react (emoji is not a plain literal)'); return; }
    const end = code.indexOf(q, i + 1);
    if (end === -1) { hits.push('react (custom emoji)'); return; }
    if (CUSTOM_EMOJI.test(unescapeLiteral(source.slice(i + 1, end)))) { hits.push('react (custom emoji)'); return; }
    let j = end + 1;
    while (/\s/.test(code[j] ?? '')) j++;
    if (code[j] !== ')' && code[j] !== ',') hits.push('react (emoji is not a plain literal)');
  };
  const react = /(?:\?\.|\.)\s*react(?![\w$])\s*(\?\.)?\s*(\()?/g;
  for (let m; (m = react.exec(code)); ) {
    if (!m[2]) { hits.push('react (not called here)'); continue; }
    checkReactArgument(m.index + m[0].length);
  }

  // 1d. A Discord object deleting itself (a message, a channel, a role): `.delete()` with no argument, or on a receiver
  // that is one. (A Map's `.delete(key)` is not.)
  const del = /([A-Za-z_$][\w$]*|[\])])\s*(?:\?\.|\.)\s*delete(?![\w$])\s*(\?\.)?\s*\(\s*(\))?/g;
  for (let m; (m = del.exec(code)); ) if (m[3] || DELETE_RECEIVERS.has(m[1])) hits.push(`${m[1]}.delete`);

  // 1e. Slash commands registered with the application or a guild: `.commands.create(` and `.commands.set(`.
  const commands = /(?<![\w$])commands\s*(?:\?\.|\.)\s*(create|set)(?![\w$])/g;
  for (let m; (m = commands.exec(code)); ) hits.push(`commands.${m[1]}`);

  // 1f. An interaction answering by updating the message it came from.
  const update = /(?<![\w$])((?:[A-Za-z_$][\w$]*[Ii]nteraction)|interaction|ix|inter)\s*(?:\?\.|\.)\s*update(?![\w$])/g;
  for (let m; (m = update.exec(code)); ) hits.push(`${m[1]}.update`);

  // 2. Bracket access: a plain literal key, a computed string key, or a variable bound to one.
  const bound = new Set<string>();
  const bind = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*(['"\`])(${names}|react|delete)\\2`, 'g');
  for (let m; (m = bind.exec(source)); ) bound.add(m[1]);
  const br = /([\w$]+|[\])])\s*(?:\?\.)?\s*\[([^\]\n]*)\]/g;
  for (let m; (m = br.exec(code)); ) {
    if (KEYWORDS.has(m[1])) continue;
    const inner = m[2];
    const start = m.index + m[0].indexOf('[') + 1;
    const plain = /^\s*(['"`])\u0001*\1\s*$/.exec(inner);
    if (plain) {
      const value = source.slice(start + inner.indexOf(plain[1]) + 1, start + inner.lastIndexOf(plain[1]));
      if (BLOCKED.includes(value) || value === 'delete') hits.push(`${m[1]}['${value}']`);
      else if (value === 'react') {
        // The same reading as `.react(`: the key is plain, so the call's argument decides.
        let k = m.index + m[0].length;
        while (/\s/.test(code[k] ?? '')) k++;
        if (code.startsWith('?.', k)) k += 2;
        while (/\s/.test(code[k] ?? '')) k++;
        if (code[k] === '(') checkReactArgument(k + 1); else hits.push("react (not called here)");
      }
    } else if (/['"`]/.test(inner)) {
      hits.push(`${m[1]}[computed string key]`);
    } else if (bound.has(inner.trim())) {
      hits.push(`${m[1]}[${inner.trim()}] (bound to a send name)`);
    }
  }

  // 3. Destructuring them out of an object.
  const destructure = new RegExp(`\\{[^{}]*(?<![\\w$.])(?:${names}|react)(?![\\w$])[^{}]*\\}\\s*=(?![=>])`, 'g');
  for (let m; (m = destructure.exec(code)); ) hits.push('destructured send name');

  // 4. The roads around the method: Reflect, the REST route, a bare REST or webhook client, eval.
  if (/\bReflect\s*\./.test(code)) hits.push('Reflect');
  if (/\bRoutes\b/.test(code)) hits.push('Routes');
  if (/\bnew\s+(REST|WebhookClient)\b/.test(code)) hits.push('REST or WebhookClient');
  if (/\beval\s*\(|\bnew\s+Function\b/.test(code)) hits.push('eval');
  return hits;
}

/** True for a source file that the one-send-path guard must read: it imports discord.js (statically, by require, or by
 *  `await import('discord.js')`), uses a discord.js sub-package, or builds a DiscordService (so what it does with
 *  the service's reach is read too). Comments do not count; a type-only mention of the class does not. */
export function touchesDiscord(source: string): boolean {
  const code = scrub(source, true);
  return /from\s+['"]discord\.js['"]|require\(\s*['"]discord\.js['"]|\bimport\(\s*['"]discord\.js['"]\s*\)|@discordjs\/|\bnew\s+DiscordService\b/.test(code);
}
