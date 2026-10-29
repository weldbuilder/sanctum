// Discord utility functions

import crypto from 'crypto';
import type { Message as DiscordMessage } from 'discord.js';

/** An open code fence: its marker (three to MAX_MARKER backticks) and the language tag it was opened with. */
interface Fence { marker: string; lang: string }

// A fence marker is a run of 3 to 16 backticks at the START of a line (CommonMark allows an info string after it). A longer
// run is text: it is never a marker, so a cut inside a run of backticks cannot make the reopen prefix the size of the run.
const MAX_MARKER = 16;
const FENCE_LINE = new RegExp(`^ {0,3}(\`{3,${MAX_MARKER}})([^\`]*)$`);
const CLOSING_LINE = new RegExp(`^\\r?\\n( {0,3}\`{3,${MAX_MARKER}}[ \\t]*)(?=\\r?\\n|$)`);
/** The longest closing line a chunk can need: a newline and the longest marker. */
const WORST_CLOSER = 1 + MAX_MARKER;
const MAX_LANG = 20;
/** A break is looked for in the last this-many characters of a chunk's budget (at most half of it, for a small limit). */
const BREAK_WINDOW = 900;
/** A run of non-whitespace this long that holds "://" is a URL, and is not cut through while it can be cut before. */
const LONG_URL = 200;
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** The fence that is open after `text`, given the one open before it. A line of three or more backticks opens a fence
 *  (its first word is the language tag); inside one, only a bare line of at least as many backticks closes it. */
function fenceAfter(text: string, open: Fence | null): Fence | null {
  let cur = open;
  for (const line of text.split('\n')) {
    const m = FENCE_LINE.exec(line);
    if (!m) continue;
    if (!cur) cur = { marker: m[1], lang: (m[2].trim().split(/\s+/)[0] ?? '').slice(0, MAX_LANG) };
    else if (!m[2].trim() && m[1].length >= cur.marker.length) cur = null;
  }
  return cur;
}

/**
 * Split a response into Discord-safe chunks (soft limit 1900; Discord's own limit is 2000), fence-aware (hole D13):
 * a chunk that ends inside a ``` fence is closed there, and the next chunk reopens it with the same language tag, so
 * every chunk renders on its own (a 4+ backtick fence closes with a closer of its own length). Breaks go at a paragraph,
 * then a line, then a space, anywhere in the last 900 characters of a chunk's budget; a word is cut when that stretch has
 * no break at all, and then not through a surrogate pair (a pair is never split) and, where there is something before it,
 * not through a long URL (the cut goes before it). That floor bounds the output: at most ceil(length / 900) + 1 chunks for
 * any input. The closing and reopening lines are inside the limit. Blank text gives no chunks.
 */
export function splitResponse(text: string, maxLength = 1900): string[] {
  if (text.trim() === '') return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let open: Fence | null = null; // the fence open at the start of `remaining`

  while (remaining.length > 0) {
    const prefix = open ? `${open.marker}${open.lang}\n` : '';
    // The chunk may need a closing fence at its end; leave room for the longest one, so nothing goes over the limit.
    const budget = maxLength - prefix.length - (open ? 1 + open.marker.length : WORST_CLOSER);
    if (prefix.length + remaining.length <= maxLength) {
      chunks.push(prefix + remaining);
      break;
    }

    // A chunk is cut no earlier than minFill, so every chunk but the last takes in all but the last 900 characters of its
    // budget (at least 946 for the default limit) and the count of chunks is bounded by the length whatever the text holds.
    // Within that window the break is a paragraph, then a line, then a space; with none, the cut is hard.
    const minFill = Math.max(1, budget - Math.min(BREAK_WINDOW, Math.floor(budget / 2)));
    // Inside a fence a blank line is no better a break than any other line: code is cut at line ends.
    let splitAt = open ? -1 : remaining.lastIndexOf('\n\n', budget);
    if (splitAt < minFill) splitAt = remaining.lastIndexOf('\n', budget);
    if (splitAt < minFill) {
      splitAt = remaining.lastIndexOf(' ', budget);
      // Not before a backtick: a cut there would put a run of backticks at the start of the next chunk, where it reads as a fence.
      while (splitAt >= minFill && remaining[splitAt + 1] === '`') splitAt = remaining.lastIndexOf(' ', splitAt - 1);
    }
    if (splitAt < minFill) splitAt = hardCut(remaining, Math.max(1, budget)); // hard cut: no break in the window

    const piece = remaining.substring(0, splitAt);
    const stillOpen = fenceAfter(piece, open);
    // The closing line is the fence's own marker, as long as it was opened with (CommonMark).
    const closer = stillOpen ? `\n${stillOpen.marker}` : '';
    // The cut fell right before the fence's own closing line: that line ends this chunk, no empty block is reopened.
    const closing = stillOpen ? CLOSING_LINE.exec(remaining.substring(splitAt)) : null;
    if (stillOpen && closing && closing[1].trim().length >= stillOpen.marker.length && prefix.length + piece.length + 1 + closing[1].length <= maxLength) {
      chunks.push(`${prefix}${piece}\n${closing[1]}`);
      remaining = remaining.substring(splitAt + closing[0].length).trimStart();
      open = null;
      continue;
    }
    chunks.push(prefix + piece + closer);

    remaining = remaining.substring(splitAt);
    // Prose loses the break it was cut at; code keeps its indentation and only loses the line break itself.
    remaining = stillOpen ? remaining.replace(/^\r?\n/, '') : remaining.trimStart();
    open = stillOpen;
    // A fence that is open with nothing after it is not worth another chunk.
    if (open && remaining.trim() === '') break;
  }

  return chunks;
}

/** Where a hard cut at `at` really goes: not between the halves of a surrogate pair (one unit earlier), and, when the
 *  cut falls inside a long URL that has something before it, before the URL. */
function hardCut(text: string, at: number): number {
  // A long URL (a run of non-whitespace of at least LONG_URL characters holding "://"): cut before it, not through it.
  if (!isSpace(text[at - 1]) && !isSpace(text[at])) {
    let start = at;
    while (start > 0 && !isSpace(text[start - 1])) start--;
    if (start > 0) {
      let end = at;
      const reach = Math.min(text.length, at + 4 * LONG_URL * 10);
      while (end < reach && !isSpace(text[end])) end++;
      if (end - start >= LONG_URL && text.slice(start, end).includes('://')) {
        let before = start;
        while (before > 0 && isSpace(text[before - 1])) before--;
        if (before >= 1) return before;
      }
    }
  }
  // Never between the halves of a pair.
  if (at > 1 && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at))) return at - 1;
  if (at === 1 && isHigh(text.charCodeAt(0)) && isLow(text.charCodeAt(1))) return 2;
  return at;
}

/**
 * Format Discord message history for agent context
 */
export function formatChannelHistory(messages: DiscordMessage[]): string {
  return messages.map(msg => {
    const time = msg.createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const author = msg.author.bot ? `[BOT] ${msg.author.username}` : msg.author.username;
    const content = msg.content || (msg.attachments.size > 0 ? '[attachment]' : '[embed]');
    return `[${time}] ${author}: ${content}`;
  }).join('\n');
}

/**
 * Generate a deterministic UUID v4 from a Discord channel ID.
 * This maps each Discord channel to a stable Sanctum thread.
 */
export function getDiscordThreadId(channelId: string): string {
  const hash = crypto.createHash('sha256').update(`discord:${channelId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
