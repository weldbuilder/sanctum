import { describe, it, expect, vi } from 'vitest';
import { GateError, check, rulesFromText, type Rules } from './gate.js';
import { createSender, type SendRuntime } from './send.js';

const WORDS = rulesFromText('Maple Street\nJanie\nre:\\b\\d{3}-\\d{3}-\\d{4}\\b\n');
const NAMES = rulesFromText('Pat Placeholder\n');

function runtime(over: Partial<SendRuntime> = {}) {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const rt: SendRuntime = {
    isPaused: () => false,
    isPublicEnabled: () => true,
    words: () => WORDS,
    names: () => NAMES,
    log: (event, fields) => { logs.push({ event, fields }); },
    chunkDelayMs: 0,
    ...over,
  };
  return { rt, logs };
}

function fakeChannel() {
  return { send: vi.fn(async (p: unknown) => ({ id: 'sent', p })) };
}
function fakeMessage() {
  const channel = fakeChannel();
  return {
    channel,
    reply: vi.fn(async (p: unknown) => ({ id: 'replied', p })),
    edit: vi.fn(async (p: unknown) => ({ id: 'edited', p })),
  };
}

describe('sendGated: the order and the shape', () => {
  it('sends clear text to a channel with mentions switched off', async () => {
    const { rt } = runtime();
    const send = createSender(rt);
    const ch = fakeChannel();
    const r = await send({ kind: 'channel', channel: ch }, 'Hello there', 'owner');
    expect(r.sent).toBe(true);
    expect(ch.send).toHaveBeenCalledTimes(1);
    const payload = ch.send.mock.calls[0][0] as any;
    expect(payload.content).toBe('Hello there');
    expect(payload.allowedMentions.parse).toEqual([]);
  });

  it('reply goes through message.reply and edit through message.edit, both gated', async () => {
    const send = createSender(runtime().rt);
    const m = fakeMessage();
    expect((await send({ kind: 'reply', message: m }, 'fine', 'public')).sent).toBe(true);
    expect(m.reply).toHaveBeenCalledTimes(1);
    expect((await send({ kind: 'edit', message: m }, 'fine again', 'owner')).sent).toBe(true);
    expect(m.edit).toHaveBeenCalledTimes(1);
    const blocked = await send({ kind: 'edit', message: m }, 'Maple Street', 'owner');
    expect(blocked.sent).toBe(false);
    expect(m.edit).toHaveBeenCalledTimes(1);
  });

  it('overrides whatever allowedMentions the caller asked for, on both lanes', async () => {
    const send = createSender(runtime().rt);
    for (const lane of ['owner', 'public'] as const) {
      const ch = fakeChannel();
      await send({ kind: 'channel', channel: ch }, { content: 'hi @everyone', allowedMentions: { parse: ['everyone', 'users'] } } as any, lane);
      const payload = ch.send.mock.calls[0][0] as any;
      expect(payload.allowedMentions.parse).toEqual([]);
    }
  });

  it('a word-gate hit blocks, names the entry, sends nothing and edits nothing', async () => {
    const send = createSender(runtime().rt);
    const m = fakeMessage();
    const r = await send({ kind: 'reply', message: m }, 'I live on maple-street now', 'owner');
    expect(r).toMatchObject({ sent: false, reason: 'word', hits: ['Maple Street'], entries: ['Maple Street'] });
    expect(m.reply).not.toHaveBeenCalled();
    expect(m.edit).not.toHaveBeenCalled();
    expect(m.channel.send).not.toHaveBeenCalled();
  });

  it('a pattern hit reports what it caught to the caller but only the list line in entries', async () => {
    const send = createSender(runtime().rt);
    const r = await send({ kind: 'channel', channel: fakeChannel() }, 'call 555-010-0142', 'owner');
    expect(r.hits).toEqual(['555-010-0142']);
    expect(r.entries).toEqual(['re:\\b\\d{3}-\\d{3}-\\d{4}\\b']);
  });

  it('a real-name hit blocks with reason name', async () => {
    const send = createSender(runtime().rt);
    const ch = fakeChannel();
    const r = await send({ kind: 'channel', channel: ch }, 'ask pat   placeholder', 'public');
    expect(r).toMatchObject({ sent: false, reason: 'name', hits: ['Pat Placeholder'] });
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('no names list (guard off) lets clear text through', async () => {
    const send = createSender(runtime({ names: () => null }).rt);
    const ch = fakeChannel();
    expect((await send({ kind: 'channel', channel: ch }, 'Pat Placeholder is fine when the guard is off', 'owner')).sent).toBe(true);
  });

  it('paused closes the public lane before any list is read, and leaves the owner lane alone', async () => {
    const words = vi.fn(() => WORDS);
    const send = createSender(runtime({ isPaused: () => true, words }).rt);
    const pub = fakeChannel();
    const r = await send({ kind: 'channel', channel: pub }, 'hello', 'public');
    expect(r).toMatchObject({ sent: false, reason: 'paused', hits: [] });
    expect(pub.send).not.toHaveBeenCalled();
    expect(words).not.toHaveBeenCalled();
    const own = fakeChannel();
    expect((await send({ kind: 'channel', channel: own }, 'hello', 'owner')).sent).toBe(true);
  });

  it('a gate failure blocks and logs the error, on either list', async () => {
    for (const over of [
      { words: () => { throw new GateError('the word list at /x is empty'); } },
      { names: () => { throw new GateError('the name list at /y is empty'); } },
    ]) {
      const { rt, logs } = runtime(over as Partial<SendRuntime>);
      const ch = fakeChannel();
      const r = await createSender(rt)({ kind: 'channel', channel: ch }, 'hello', 'owner');
      expect(r).toMatchObject({ sent: false, reason: 'gate_error' });
      expect(r.error).toMatch(/list at/);
      expect(ch.send).not.toHaveBeenCalled();
      expect(JSON.stringify(logs)).toMatch(/list at/);
    }
  });

  it('a non-GateError thrown by a list is still a block, never a send', async () => {
    const ch = fakeChannel();
    const r = await createSender(runtime({ words: () => { throw new Error('boom'); } }).rt)({ kind: 'channel', channel: ch }, 'hello', 'owner');
    expect(r).toMatchObject({ sent: false, reason: 'gate_error' });
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('checks embed text as well as content', async () => {
    const send = createSender(runtime().rt);
    const ch = fakeChannel();
    const e = await send({ kind: 'channel', channel: ch }, { embeds: [{ title: 'ok', fields: [{ name: 'where', value: 'Maple Street' }] }] } as any, 'owner');
    expect(e.reason).toBe('word');
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('block logs carry lane, reason, entries and length, and never the text', async () => {
    const { rt, logs } = runtime();
    const text = 'zebra-unique-sentence about Maple Street and a quiet lake';
    await createSender(rt)({ kind: 'channel', channel: fakeChannel() }, text, 'public');
    expect(logs).toHaveLength(1);
    expect(logs[0].fields).toMatchObject({ lane: 'public', reason: 'word', entries: ['Maple Street'], length: text.length });
    const dump = JSON.stringify(logs);
    expect(dump).not.toMatch(/zebra-unique/);
    expect(dump).not.toMatch(/quiet lake/);
  });

  it('a pattern block logs the list line, not what it caught', async () => {
    const { rt, logs } = runtime();
    await createSender(rt)({ kind: 'channel', channel: fakeChannel() }, 'call 555-010-0142', 'owner');
    expect(JSON.stringify(logs)).not.toMatch(/555-010-0142/);
  });

  it('gates the whole reply before the first chunk goes out, then chunks it', async () => {
    const { rt } = runtime();
    const send = createSender(rt);
    const long = `${'word '.repeat(700)}\n\n${'more '.repeat(300)}`;
    const m = fakeMessage();
    const ok = await send({ kind: 'reply', message: m }, long, 'owner');
    expect(ok.sent).toBe(true);
    expect(m.reply).toHaveBeenCalledTimes(1);
    expect(m.channel.send.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const c of [m.reply.mock.calls[0][0], ...m.channel.send.mock.calls.map((x) => x[0])] as any[]) {
      expect(c.content.length).toBeLessThanOrEqual(1900);
      expect(c.allowedMentions.parse).toEqual([]);
    }
    // an entry only in the last chunk still stops the first one
    const m2 = fakeMessage();
    const bad = await send({ kind: 'reply', message: m2 }, `${long} Janie`, 'owner');
    expect(bad.sent).toBe(false);
    expect(m2.reply).not.toHaveBeenCalled();
    expect(m2.channel.send).not.toHaveBeenCalled();
  });

  it('lets a Discord error through to the caller', async () => {
    const ch = { send: vi.fn(async () => { throw new Error('Missing Permissions'); }) };
    await expect(createSender(runtime().rt)({ kind: 'channel', channel: ch }, 'hi', 'owner')).rejects.toThrow('Missing Permissions');
  });
});

describe('check stays usable on its own', () => {
  it('a Rules value from rulesFromText works with check', () => {
    const r: Rules = rulesFromText('Janie\n');
    expect(check('JANIE', r)).toHaveLength(1);
  });
});

describe('gatedAction: any other text-leaving call goes through the same gate', () => {
  it('runs the action when the text is clean, and returns what it returned', async () => {
    const send = createSender(runtime().rt);
    const run = vi.fn(async () => 'topic set');
    const r = await send.action({ lane: 'owner', text: 'a fine topic', run });
    expect(r).toMatchObject({ sent: true, value: 'topic set' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not run it when the word gate or the name guard hits, and names the entry', async () => {
    const send = createSender(runtime().rt);
    const run = vi.fn(async () => 1);
    expect(await send.action({ lane: 'public', text: 'meet at Maple Street', run })).toMatchObject({ sent: false, reason: 'word', entries: ['Maple Street'] });
    expect(await send.action({ lane: 'owner', text: 'Pat Placeholder', run })).toMatchObject({ sent: false, reason: 'name' });
    expect(run).not.toHaveBeenCalled();
  });

  it('is closed by pause and by public-off on the public lane, before any list is read', async () => {
    const words = vi.fn(() => WORDS);
    const run = vi.fn(async () => 1);
    expect(await createSender(runtime({ isPaused: () => true, words }).rt).action({ lane: 'public', text: 'x', run })).toMatchObject({ sent: false, reason: 'paused' });
    expect(await createSender(runtime({ isPublicEnabled: () => false, words }).rt).action({ lane: 'public', text: 'x', run })).toMatchObject({ sent: false, reason: 'public_off' });
    expect(words).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a gate that cannot run blocks the action (fail closed), and so does a text that is not a string', async () => {
    const run = vi.fn(async () => 1);
    const broken = createSender(runtime({ words: () => { throw new GateError('no list', 'missing'); } }).rt);
    expect(await broken.action({ lane: 'owner', text: 'x', run })).toMatchObject({ sent: false, reason: 'gate_error' });
    expect(await createSender(runtime().rt).action({ lane: 'owner', text: 42 as any, run })).toMatchObject({ sent: false, reason: 'payload' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a failing action rejects (the caller decides), after the gate passed', async () => {
    const send = createSender(runtime().rt);
    await expect(send.action({ lane: 'owner', text: 'fine', run: async () => { throw new Error('discord said no'); } })).rejects.toThrow('discord said no');
  });
});
