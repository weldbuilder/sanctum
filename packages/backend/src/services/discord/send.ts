// The one send path. Every outbound Discord payload, on either lane, goes through sendGated().
// It is the only function in the app that calls a discord.js send / reply / edit; a test
// (send-guard.test.ts) reads the Discord folder and fails if any other file does.
//
// Order, fail-closed at every step:
//   1. paused (public lane only)        -> blocked, before any list is read
//   2. public lane while public.enabled is false -> blocked (the backstop: intake should never get here)
//   3. the payload allow-list: content, embeds (text fields only), allowedMentions, reply. Any other key
//      (components, poll, files, tts, stickers, ...) is rejected and logged; nothing carries text past the gate
//   4. the word gate AND the real-name guard, both run, their hits merged into one reason; any failure
//      to run either is a block
//   5. allowed mentions switched off, always (nothing a reply says can ping @everyone, a role or a user)
//   6. send
//
// A block returns {sent:false, reason, hits, entries} to the caller. The message is never edited
// and never partly sent: the whole reply is checked before the first chunk goes out. Block logs
// carry the lane, the reason, the matched list entries and the length, never the text.

import { check, GateError, RuleSource, type Rules } from './gate.js';
import { getDiscordPaths } from './paths.js';
import { splitResponse } from './utils.js';
import { getSanctumConfig } from '../../config.js';
import { tenantLocal } from '../../tenancy/context.js';
import { logEvent } from '../logs.js';

export type Lane = 'owner' | 'public';
export type BlockReason = 'paused' | 'public_off' | 'payload' | 'word' | 'name' | 'word_name' | 'gate_error';

/** Anything with discord.js's `send`: a text channel, a thread, a DM channel. */
export interface SendableChannel { send(payload: any): Promise<unknown> }
/** A message we can answer: `reply`, and the channel to carry later chunks. */
export interface ReplyableMessage { reply(payload: any): Promise<unknown>; channel: unknown }
/** Anything with discord.js's `sendTyping`: a text channel, a thread, a DM channel. */
export interface TypingChannel { sendTyping(): Promise<unknown> }
/** A message we can edit. */
export interface EditableMessage { edit(payload: any): Promise<unknown> }

export type SendTarget =
  | { kind: 'channel'; channel: SendableChannel }
  | { kind: 'reply'; message: ReplyableMessage }
  | { kind: 'edit'; message: EditableMessage };

/** A string, or message options. Only content, embeds, allowedMentions and reply are accepted. */
export type SendPayload = string | ({ content?: string; embeds?: unknown[]; allowedMentions?: unknown; reply?: unknown } & Record<string, unknown>);

export interface SendResult {
  sent: boolean;
  /** Set when sent is false. */
  reason?: BlockReason;
  /** What to tell the companion: a word entry, or what a `re:` pattern caught. */
  hits?: string[];
  /** The list lines that matched. Safe to log and to show the person. */
  entries?: string[];
  /** For gate_error and payload: why. Never contains an entry or any of the text. */
  error?: string;
  /** What Discord returned for each message sent. */
  messages?: unknown[];
}

export interface SendRuntime {
  isPaused(): boolean;
  /** discord.public.enabled. The public lane is closed whenever this is false. */
  isPublicEnabled(): boolean;
  /** The word list. Throws GateError when it cannot be had. */
  words(): Rules;
  /** The name list; null = guard off. Throws GateError when present but unusable. */
  names(): Rules | null;
  log(event: string, fields: Record<string, unknown>): void;
  /** Pause between chunks, to stay inside Discord's rate limits. */
  chunkDelayMs?: number;
}

const MAX_CHUNK = 1900;
/** A public reply never goes out as more than this many messages: a public reply is not a wall of them. */
const MAX_CHUNKS = 8;
/** The owner lane's own limit: it is the owner's channel, so a long answer goes out whole, but the count is still finite. */
const MAX_OWNER_CHUNKS = 40;
const TRUNCATED_NOTE = '\n\n[reply truncated: too long for Discord]';

const PAYLOAD_KEYS = new Set(['content', 'embeds', 'allowedMentions', 'reply']);
/** Embed keys that carry text (gated) or plain styling. Anything else (url, image, thumbnail, video,
 *  provider, icon urls) can hide text in a link or a picture and is refused. */
const EMBED_KEYS = new Set(['title', 'description', 'footer', 'author', 'fields', 'color', 'timestamp']);
const EMBED_FOOTER_KEYS = new Set(['text']);
const EMBED_AUTHOR_KEYS = new Set(['name']);
const EMBED_FIELD_KEYS = new Set(['name', 'value', 'inline']);

class PayloadError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: Set<string>, where: string) => {
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new PayloadError(`${where} key "${k}" is not allowed`);
};
const str = (v: unknown, where: string): string[] => {
  if (v === undefined || v === null) return [];
  if (typeof v !== 'string') throw new PayloadError(`${where} is not a string`);
  return [v];
};

/** The exact JSON discord.js will send for an embed: `toJSON()` when it has one (an EmbedBuilder does;
 *  discord.js calls it), else the object itself. A `.data`-shaped object with no toJSON is read as its
 *  `.data` only when `.data` is ALL it has: text or media beside `.data` is never read by anything that
 *  builds the real payload, so it is refused rather than guessed at. */
function embedJson(e: unknown): Record<string, unknown> {
  if (!isObj(e)) throw new PayloadError('an embed is not an object');
  if (typeof (e as { toJSON?: unknown }).toJSON === 'function') {
    const json = (e as { toJSON: () => unknown }).toJSON();
    if (!isObj(json)) throw new PayloadError("an embed's toJSON() did not return an object");
    return json;
  }
  if ('data' in e) {
    if (Object.keys(e).length !== 1 || !isObj(e.data)) throw new PayloadError('an embed carries fields beside its data');
    return e.data;
  }
  return e;
}

/** Check one embed's JSON against the allow-list and return the text in it. */
function embedText(d: Record<string, unknown>): string[] {
  onlyKeys(d, EMBED_KEYS, 'embed');
  const out: string[] = [...str(d.title, 'embed title'), ...str(d.description, 'embed description')];
  if (d.footer !== undefined) {
    if (!isObj(d.footer)) throw new PayloadError('embed footer is not an object');
    onlyKeys(d.footer, EMBED_FOOTER_KEYS, 'embed footer');
    out.push(...str(d.footer.text, 'embed footer text'));
  }
  if (d.author !== undefined) {
    if (!isObj(d.author)) throw new PayloadError('embed author is not an object');
    onlyKeys(d.author, EMBED_AUTHOR_KEYS, 'embed author');
    out.push(...str(d.author.name, 'embed author name'));
  }
  if (d.fields !== undefined) {
    if (!Array.isArray(d.fields)) throw new PayloadError('embed fields is not a list');
    for (const f of d.fields) {
      if (!isObj(f)) throw new PayloadError('an embed field is not an object');
      onlyKeys(f, EMBED_FIELD_KEYS, 'embed field');
      out.push(...str(f.name, 'embed field name'), ...str(f.value, 'embed field value'));
    }
  }
  if (d.timestamp !== undefined && typeof d.timestamp !== 'string' && typeof d.timestamp !== 'number' && !(d.timestamp instanceof Date)) throw new PayloadError('embed timestamp is not a date');
  if (d.color !== undefined && typeof d.color !== 'number') throw new PayloadError('embed color is not a number');
  return out;
}

/** Every string in a payload that a reader will see, and the embeds as the exact JSON that was checked
 *  (so what is sent is what was gated: a toJSON() is read once). Throws PayloadError for anything outside
 *  the allow-list. */
export function readPayload(payload: SendPayload): { text: string; embeds?: Array<Record<string, unknown>> } {
  if (typeof payload === 'string') return { text: payload };
  if (!isObj(payload)) throw new PayloadError('the payload is not a string or an object');
  onlyKeys(payload, PAYLOAD_KEYS, 'payload');
  const parts: string[] = [...str(payload.content, 'content')];
  let embeds: Array<Record<string, unknown>> | undefined;
  if (payload.embeds !== undefined) {
    if (!Array.isArray(payload.embeds)) throw new PayloadError('embeds is not a list');
    embeds = payload.embeds.map(embedJson);
    for (const d of embeds) parts.push(...embedText(d));
  }
  if (payload.reply !== undefined && !isObj(payload.reply) && typeof payload.reply !== 'string') throw new PayloadError('reply is not a reference');
  return { text: parts.join('\n'), ...(embeds ? { embeds } : {}) };
}

/** Every string in a payload that a reader will see. Throws PayloadError for anything outside the allow-list. */
export function payloadText(payload: SendPayload): string {
  return readPayload(payload).text;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Build a sender over a runtime. The app uses the default one through sendGated; tests inject their own. */
export function createSender(rt: SendRuntime) {
  async function sendGated(target: SendTarget, payload: SendPayload, lane: Lane): Promise<SendResult> {
    let length = 0;
    const block = (reason: BlockReason, hits: string[], entries: string[], error?: string): SendResult => {
      rt.log('blocked', { lane, reason, entries, length, ...(error ? { error } : {}) });
      return { sent: false, reason, hits, entries, ...(error ? { error } : {}) };
    };

    // 1. Paused: the public lane is closed. Nothing else is looked at.
    if (lane === 'public' && rt.isPaused()) return block('paused', [], []);
    // 2. The backstop. Intake decides lanes by channel; if a public send is ever asked for while the
    //    public lane is off, this is where it stops.
    if (lane === 'public' && !rt.isPublicEnabled()) return block('public_off', [], []);

    // 3. The payload: only what can be read and gated. It is JSON round-tripped FIRST, and the round-tripped copy is
    //    what is checked and what is sent: a getter, a stateful toJSON, a prototype property or an object that
    //    changes between reads cannot say one thing to the gate and another to Discord. (Only own enumerable data
    //    survives the copy, which is exactly what discord.js would serialise.)
    try { payload = JSON.parse(JSON.stringify(payload)) as SendPayload; }
    catch { return block('payload', [], [], 'the payload is not plain JSON'); }
    let text: string;
    let embeds: Array<Record<string, unknown>> | undefined;
    try { ({ text, embeds } = readPayload(payload)); length = text.length; }
    catch (e) {
      if (e instanceof PayloadError) return block('payload', [], [], e.message);
      return block('payload', [], [], 'the payload could not be read');
    }

    // 4. The gate. Both lists run, so one reason carries every hit. Any failure to run either is a block.
    let wordHits: ReturnType<typeof check> = [];
    let nameHits: ReturnType<typeof check> = [];
    try {
      wordHits = check(text, rt.words());
      const names = rt.names();
      if (names) nameHits = check(text, names);
    } catch (e) {
      const message = e instanceof GateError ? e.message : `the gate failed unexpectedly (${(e as Error)?.name || 'error'})`;
      return block('gate_error', [], [], message);
    }
    if (wordHits.length || nameHits.length) {
      const reason: BlockReason = wordHits.length && nameHits.length ? 'word_name' : wordHits.length ? 'word' : 'name';
      const all = [...wordHits, ...nameHits];
      return block(reason, all.map((h) => h.label), all.map((h) => h.entry));
    }

    // 5. Mentions off, whatever the caller asked for. Public replies also do not ping the person replied to.
    const base: Record<string, unknown> = typeof payload === 'string' ? { content: payload } : { ...payload };
    // The embeds that go out are the JSON that was checked, not the objects (a toJSON() could say something else next time).
    if (embeds) base.embeds = embeds;
    base.allowedMentions = lane === 'public' ? { parse: [], repliedUser: false } : { parse: [] };

    // 6. Send. The text was checked whole, so chunking cannot split an entry past the gate.
    const messages: unknown[] = [];
    const content = typeof base.content === 'string' ? base.content : undefined;
    // Blank text is nothing to say: no message goes out (Discord would refuse an empty one), and the log says so once.
    // (Embeds beside blank text still go out as they are.)
    if (target.kind !== 'edit' && content !== undefined && content.trim() === '' && !(Array.isArray(base.embeds) && base.embeds.length)) {
      rt.log('empty', { lane, length: content.length });
      return { sent: false, reason: 'payload', error: 'the text is blank: there is nothing to send' };
    }
    let chunks = target.kind !== 'edit' && content !== undefined ? splitResponse(content, MAX_CHUNK) : [content];
    if (chunks.length === 0) chunks = [content];
    const cap = lane === 'public' ? MAX_CHUNKS : MAX_OWNER_CHUNKS;
    if (chunks.length > cap) {
      rt.log('truncated', { lane, chunks: chunks.length, length: content?.length ?? 0 });
      chunks.length = cap;
      chunks[cap - 1] += TRUNCATED_NOTE; // chunks are at most 1900, the note is under 50: inside Discord's 2000
    }
    for (let i = 0; i < chunks.length; i++) {
      const out = i === 0 ? { ...base, ...(chunks[0] !== undefined ? { content: chunks[0] } : {}) } : { content: chunks[i], allowedMentions: base.allowedMentions };
      if (i > 0) await sleep(rt.chunkDelayMs ?? 200);
      if (target.kind === 'edit') messages.push(await target.message.edit(out));
      else if (target.kind === 'reply' && i === 0) messages.push(await target.message.reply(out));
      else if (target.kind === 'reply') messages.push(await (target.message.channel as SendableChannel).send(out));
      else messages.push(await target.channel.send(out));
    }
    return { sent: true, messages };
  }

  /**
   * Any other call that puts words in front of people (a channel topic, a thread name, a presence line, a webhook
   * name): the text goes through the same pause / public-off checks, word gate and name guard as a reply, and only
   * then does `run` do the call. A block returns the reason and `run` is never called. A failing `run` rejects.
   */
  async function gatedAction(a: { lane: Lane; text: string; run: () => Promise<unknown> }): Promise<SendResult & { value?: unknown }> {
    const { lane, text, run } = a;
    const length = typeof text === 'string' ? text.length : 0;
    const block = (reason: BlockReason, hits: string[], entries: string[], error?: string): SendResult => {
      rt.log('blocked', { lane, reason, entries, length, action: true, ...(error ? { error } : {}) });
      return { sent: false, reason, hits, entries, ...(error ? { error } : {}) };
    };
    if (lane === 'public' && rt.isPaused()) return block('paused', [], []);
    if (lane === 'public' && !rt.isPublicEnabled()) return block('public_off', [], []);
    if (typeof text !== 'string') return block('payload', [], [], 'the text is not a string');
    let wordHits: ReturnType<typeof check> = [];
    let nameHits: ReturnType<typeof check> = [];
    try {
      wordHits = check(text, rt.words());
      const names = rt.names();
      if (names) nameHits = check(text, names);
    } catch (e) {
      return block('gate_error', [], [], e instanceof GateError ? e.message : `the gate failed unexpectedly (${(e as Error)?.name || 'error'})`);
    }
    if (wordHits.length || nameHits.length) {
      const reason: BlockReason = wordHits.length && nameHits.length ? 'word_name' : wordHits.length ? 'word' : 'name';
      const all = [...wordHits, ...nameHits];
      return block(reason, all.map((h) => h.label), all.map((h) => h.entry));
    }
    return { sent: true, value: await run() };
  }

  /**
   * The typing indicator. It carries no words, but it is a call that reaches a channel, so it goes out through here like
   * the rest: on the public lane not while the lane is paused or off. A failing channel rejects, as discord.js does.
   */
  async function typing(channel: TypingChannel, lane: Lane): Promise<void> {
    if (lane === 'public' && (rt.isPaused() || !rt.isPublicEnabled())) return;
    await channel.sendTyping();
  }

  return Object.assign(sendGated, { action: gatedAction, typing });
}

// ── the app's runtime ─────────────────────────────────────────────────────────
const wordSource = new RuleSource({ path: () => getDiscordPaths().wordsFile, what: 'word list' });
const nameSource = new RuleSource({ path: () => getDiscordPaths().namesFile, what: 'name list', optional: true });

export function wordGateStatus() { return wordSource.status(); }
/** The word list's status plus the full message (it names the path: server log only, never the API). */
export function wordGateInspect() { return wordSource.inspect(); }
export function nameGuardStatus() { return nameSource.status(); }

const appRuntime: SendRuntime = {
  isPaused: () => getSanctumConfig().discord.paused,
  isPublicEnabled: () => getSanctumConfig().discord.public.enabled === true,
  words: () => wordSource.get()!,
  names: () => nameSource.get(),
  log: (event, fields) => {
    console.warn(`[Discord] ${event} ${JSON.stringify(fields)}`);
    // A gate that could not run blocks everything: that is a failure the person has to be able to see.
    if (event === 'blocked' && fields.reason === 'gate_error') logEvent('discord', 'gate_error', typeof fields.lane === 'string' ? { lane: fields.lane } : {});
  },
};

const bootLoggedLocal = tenantLocal(() => false); // (per tenant: each tenant's gate says how it stands once)
/** Say, once, how the gate stands: loaded, failed (and so blocking everything), and whether the optional name guard is off. */
export function logGateAtBoot(log: (msg: string) => void = (m) => console.log(m), warn: (msg: string) => void = (m) => console.warn(m)): void {
  if (bootLoggedLocal.get()) return;
  bootLoggedLocal.set(true);
  const w = wordSource.inspect();
  if (w.status.state === 'loaded') log(`[Discord] word gate loaded (${w.status.entries} entries)`);
  else if (w.status.state === 'failed') warn(`[Discord] word gate NOT READY: ${w.message}. Every outgoing Discord message is blocked until the list is fixed.`);
  const n = nameSource.inspect();
  if (n.status.state === 'off') log('[Discord] real-name guard is OFF: no names list found, or it has no entries (it is optional; the word gate still runs). Add entries to names.txt in the private folder to turn it on.');
  else if (n.status.state === 'loaded') log(`[Discord] real-name guard loaded (${n.status.entries} entries)`);
  else if (n.status.state === 'failed') warn(`[Discord] real-name guard NOT READY: ${n.message}. Every outgoing Discord message is blocked until the list is fixed.`);
}

/** The only way out. Gate, then send. */
export const sendGated = createSender(appRuntime);
/** The only way out for the calls that are not a message (a topic, a thread name, a presence line, a webhook name). */
export const gatedAction = sendGated.action;
/** The only way to show "is typing..." (the same pause and public-off checks as a reply). */
export const sendTyping = sendGated.typing;
