// Verifier pass-A findings against the send path: the payload allow-list, both lists in one
// reason, and the public-lane backstop.
import { describe, it, expect, vi } from 'vitest';
import { rulesFromText } from './gate.js';
import { createSender, type SendRuntime } from './send.js';

const WORDS = rulesFromText('Maple Street\nJanie\n');
const NAMES = rulesFromText('Pat Placeholder\n');

function setup(over: Partial<SendRuntime> = {}) {
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
  const channel = { send: vi.fn(async (p: unknown) => ({ id: 's', p })) };
  return { send: createSender(rt), channel, logs };
}

describe('payload allow-list: content, embeds, allowedMentions, reply', () => {
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['components', { content: 'hi', components: [{ type: 1, components: [{ type: 2, label: 'Maple Street', style: 1, custom_id: 'x' }] }] }],
    ['poll', { content: 'hi', poll: { question: { text: 'Janie?' }, answers: [{ text: 'a' }] } }],
    ['files', { content: 'hi', files: [{ name: 'a.txt', description: 'Janie', attachment: Buffer.from('Maple Street') }] }],
    ['tts', { content: 'hi', tts: true }],
    ['attachments', { content: 'hi', attachments: [] }],
    ['stickers', { content: 'hi', stickers: ['1'] }],
    ['flags', { content: 'hi', flags: 4 }],
    ['snake-case allowed_mentions', { content: 'hi', allowed_mentions: { parse: ['everyone'] } }],
  ];
  for (const [name, payload] of rejected) {
    it(`rejects ${name}: never sent, logged with the key and never the text`, async () => {
      const { send, channel, logs } = setup();
      const r = await send({ kind: 'channel', channel }, payload as any, 'owner');
      expect(r).toMatchObject({ sent: false, reason: 'payload' });
      expect(channel.send).not.toHaveBeenCalled();
      expect(logs).toHaveLength(1);
      expect(logs[0].fields.reason).toBe('payload');
      expect(JSON.stringify(logs)).not.toMatch(/Maple Street|Janie/);
    });
  }

  it('accepts content, embeds, allowedMentions and reply, and still gates the embed text', async () => {
    const { send, channel } = setup();
    const ok = await send({ kind: 'channel', channel }, { content: 'hi', embeds: [{ title: 'ok', description: 'fine', fields: [{ name: 'a', value: 'b' }], footer: { text: 'f' }, author: { name: 'n' } }], allowedMentions: { parse: ['users'] }, reply: { messageReference: '1' } } as any, 'owner');
    expect(ok.sent).toBe(true);
    expect((channel.send.mock.calls[0][0] as any).allowedMentions).toEqual({ parse: [] });
    const bad = await send({ kind: 'channel', channel }, { embeds: [{ footer: { text: 'Maple Street' } }] } as any, 'owner');
    expect(bad).toMatchObject({ sent: false, reason: 'word' });
  });

  it('rejects an embed that carries urls or media (text hiding in a link)', async () => {
    const { send, channel } = setup();
    for (const embed of [{ title: 'x', url: 'https://example.test/Janie' }, { image: { url: 'https://example.test/a.png' } }, { thumbnail: { url: 'https://example.test/a.png' } }, { footer: { text: 'x', icon_url: 'https://example.test/i.png' } }]) {
      const r = await send({ kind: 'channel', channel }, { embeds: [embed] } as any, 'owner');
      expect(r).toMatchObject({ sent: false, reason: 'payload' });
    }
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('an embed built by discord.js (data) is read the same way', async () => {
    const { send, channel } = setup();
    const r = await send({ kind: 'channel', channel }, { embeds: [{ data: { description: 'Janie' } }] } as any, 'owner');
    expect(r.reason).toBe('word');
  });

  describe('embeds are gated on the exact JSON discord.js will send (the three bypass shapes)', () => {
    it('{ data: { title }, description } is rejected: text beside .data was never read', async () => {
      const { send, channel } = setup();
      const r = await send({ kind: 'channel', channel }, { embeds: [{ data: { title: 'fine' }, description: 'Janie' }] } as any, 'owner');
      expect(r).toMatchObject({ sent: false, reason: 'payload' });
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('{ data, image } is rejected: a picture rides beside .data', async () => {
      const { send, channel } = setup();
      const r = await send({ kind: 'channel', channel }, { embeds: [{ data: { title: 'fine' }, image: { url: 'https://example.test/Janie.png' } }] } as any, 'owner');
      expect(r).toMatchObject({ sent: false, reason: 'payload' });
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('toJSON() is what is gated: a builder whose data is clean but whose toJSON says a listed word is blocked', async () => {
      const { send, channel } = setup();
      const embed = { data: { title: 'fine' }, toJSON: () => ({ description: 'Janie' }) };
      const r = await send({ kind: 'channel', channel }, { embeds: [embed] } as any, 'owner');
      expect(r).toMatchObject({ sent: false, reason: 'word' });
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('toJSON() output with a url or image is rejected the same way', async () => {
      const { send, channel } = setup();
      const r = await send({ kind: 'channel', channel }, { embeds: [{ toJSON: () => ({ title: 'x', image: { url: 'https://example.test/a.png' } }) }] } as any, 'owner');
      expect(r).toMatchObject({ sent: false, reason: 'payload' });
    });

    it('what was gated is what is sent: toJSON is read once, and a changing toJSON cannot swap the text after the check', async () => {
      const { send, channel } = setup();
      let calls = 0;
      const embed = { toJSON: () => (++calls === 1 ? { title: 'fine', description: 'all clear' } : { description: 'Janie' }) };
      const r = await send({ kind: 'channel', channel }, { embeds: [embed] } as any, 'owner');
      expect(r.sent).toBe(true);
      expect(calls).toBe(1);
      const sent = channel.send.mock.calls[0][0] as any;
      expect(JSON.stringify(sent.embeds)).toBe(JSON.stringify([{ title: 'fine', description: 'all clear' }]));
    });

    it('an embed built the way discord.js builds one (data plus toJSON that returns it) still sends', async () => {
      const { send, channel } = setup();
      const data = { title: 'ok', description: 'fine', color: 5 };
      class Builder { data = data; toJSON() { return this.data; } }
      const r = await send({ kind: 'channel', channel }, { embeds: [new Builder()] } as any, 'owner');
      expect(r.sent).toBe(true);
      expect((channel.send.mock.calls[0][0] as any).embeds).toEqual([data]);
    });
  });

  it('content that is not a string is rejected', async () => {
    const { send, channel } = setup();
    const r = await send({ kind: 'channel', channel }, { content: { toString: () => 'Janie' } } as any, 'owner');
    expect(r).toMatchObject({ sent: false, reason: 'payload' });
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('both lists run and the reasons merge', () => {
  it('a word hit and a name hit in one reply come back as one block naming both', async () => {
    const { send, channel, logs } = setup();
    const r = await send({ kind: 'channel', channel }, 'Janie met Pat Placeholder', 'owner');
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('word_name');
    expect(r.hits).toEqual(['Janie', 'Pat Placeholder']);
    expect(r.entries).toEqual(['Janie', 'Pat Placeholder']);
    expect(logs[0].fields.entries).toEqual(['Janie', 'Pat Placeholder']);
  });
  it('the name guard runs even when the word gate hit', async () => {
    const names = vi.fn(() => NAMES);
    const { send, channel } = setup({ names });
    await send({ kind: 'channel', channel }, 'Janie', 'owner');
    expect(names).toHaveBeenCalled();
  });
  it('a name list that cannot run is a gate_error even when the word gate hit', async () => {
    const { send, channel } = setup({ names: () => { throw new Error('boom'); } });
    const r = await send({ kind: 'channel', channel }, 'Janie', 'owner');
    expect(r.reason).toBe('gate_error');
    expect(channel.send).not.toHaveBeenCalled();
  });
});

// SHOULD-FIX 4: the payload is JSON round-tripped BEFORE it is gated, and the round-tripped object is what goes out.
// A getter, a stateful toJSON or a prototype trick can then not say one thing to the gate and another to Discord.
describe('what is sent is what was gated: the payload is a JSON round-trip taken before the check', () => {
  /** Clean the first time it is read, the secret every time after. */
  const flip = (clean: string, secret: string) => { let n = 0; return () => (++n === 1 ? clean : secret); };

  it('a content getter that changes after the first read cannot change what is sent', async () => {
    const { send, channel } = setup();
    const read = flip('hello there', 'Maple Street');
    const payload = { get content() { return read(); } };
    const r = await send({ kind: 'channel', channel }, payload as any, 'owner');
    expect(r.sent).toBe(true);
    expect(JSON.stringify(channel.send.mock.calls)).not.toMatch(/Maple Street/);
    expect((channel.send.mock.calls[0][0] as any).content).toBe('hello there');
  });

  it('an embed field getter that changes after the first read cannot change what is sent', async () => {
    const { send, channel } = setup();
    const read = flip('fine', 'Janie');
    const payload = { embeds: [{ fields: [{ name: 'a', get value() { return read(); } }] }] };
    const r = await send({ kind: 'channel', channel }, payload as any, 'owner');
    expect(r.sent).toBe(true);
    expect(JSON.stringify(channel.send.mock.calls)).not.toMatch(/Janie/);
    expect((channel.send.mock.calls[0][0] as any).embeds[0].fields[0].value).toBe('fine');
  });

  it('a stateful toJSON is read once, before the check', async () => {
    const { send, channel } = setup();
    let n = 0;
    const embed = { toJSON: () => ({ description: ++n === 1 ? 'fine' : 'Janie' }) };
    const r = await send({ kind: 'channel', channel }, { embeds: [embed] } as any, 'owner');
    expect(r.sent).toBe(true);
    expect(n).toBe(1);
    expect(JSON.stringify(channel.send.mock.calls)).not.toMatch(/Janie/);
  });

  it('a getter that reads the secret on the first look is gated on what it said', async () => {
    const { send, channel } = setup();
    const r = await send({ kind: 'channel', channel }, { get content() { return 'Maple Street'; } } as any, 'owner');
    expect(r).toMatchObject({ sent: false, reason: 'word' });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('inherited properties are not part of the payload: a prototype cannot add text the gate did not see', async () => {
    const { send, channel } = setup();
    const proto = { get content() { return 'Maple Street'; }, embeds: [{ description: 'Janie' }] };
    const payload = Object.create(proto);
    payload.allowedMentions = { parse: ['everyone'] };
    const r = await send({ kind: 'channel', channel }, payload, 'owner');
    expect(JSON.stringify(channel.send.mock.calls)).not.toMatch(/Maple Street|Janie/);
    expect(r.sent === false || (channel.send.mock.calls[0][0] as any).content === undefined).toBe(true);
  });

  it('what goes to discord.js is a plain object, not the caller\'s', async () => {
    const { send, channel } = setup();
    const payload = { content: 'hi', embeds: [{ title: 't' }] };
    await send({ kind: 'channel', channel }, payload, 'owner');
    const out = channel.send.mock.calls[0][0] as any;
    expect(out).not.toBe(payload);
    expect(out.embeds[0]).not.toBe(payload.embeds[0]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('a payload JSON cannot carry (a cycle, a BigInt) is a payload block, not a throw', async () => {
    const { send, channel } = setup();
    const cyc: any = { content: 'hi' }; cyc.self = cyc;
    expect(await send({ kind: 'channel', channel }, cyc, 'owner')).toMatchObject({ sent: false, reason: 'payload' });
    expect(await send({ kind: 'channel', channel }, { content: 'hi', reply: 10n } as any, 'owner')).toMatchObject({ sent: false, reason: 'payload' });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('a plain string and a plain object still send as before, chunked', async () => {
    const { send, channel } = setup();
    expect((await send({ kind: 'channel', channel }, 'hello', 'owner')).sent).toBe(true);
    expect((await send({ kind: 'channel', channel }, { content: 'a'.repeat(4000) }, 'owner')).sent).toBe(true);
    expect(channel.send.mock.calls.length).toBeGreaterThan(2);
  });
});

describe('the fail-closed backstop: the public lane is closed unless public.enabled', () => {
  it('blocks lane public when public is not enabled, before any list is read', async () => {
    const words = vi.fn(() => WORDS);
    const { send, channel } = setup({ isPublicEnabled: () => false, words });
    const r = await send({ kind: 'channel', channel }, 'hello', 'public');
    expect(r).toMatchObject({ sent: false, reason: 'public_off' });
    expect(channel.send).not.toHaveBeenCalled();
    expect(words).not.toHaveBeenCalled();
  });
  it('leaves the owner lane alone', async () => {
    const { send, channel } = setup({ isPublicEnabled: () => false });
    expect((await send({ kind: 'channel', channel }, 'hello', 'owner')).sent).toBe(true);
  });
});
