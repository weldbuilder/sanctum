// B3c item 1: a public reply is never a wall of messages. sendGated sends at most 8 chunks on the public lane; a longer
// reply is cut at 8 with a last line saying so (and the sender logs it). B3d item 6: the cap is the public lane's. The owner
// lane's is 40 (still finite), with the same line.
import { describe, it, expect, vi } from 'vitest';
import { rulesFromText } from './gate.js';
import { createSender, type SendRuntime } from './send.js';

function setup() {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const rt: SendRuntime = {
    isPaused: () => false, isPublicEnabled: () => true,
    words: () => rulesFromText('Maple Street\n'), names: () => null,
    log: (event, fields) => { logs.push({ event, fields }); },
    chunkDelayMs: 0,
  };
  const channel = { send: vi.fn(async (p: unknown) => ({ id: 'sent', p })) };
  return { send: createSender(rt), channel, logs };
}

describe('sendGated: the chunk cap', () => {
  it('a reply of 8 chunks or fewer goes out whole, with no note', async () => {
    const { send, channel } = setup();
    const text = 'word '.repeat(2500).trim(); // ~12,500 chars: 7 chunks
    const r = await send({ kind: 'channel', channel }, text, 'public');
    expect(r.sent).toBe(true);
    expect(channel.send.mock.calls.length).toBeGreaterThan(1);
    expect(channel.send.mock.calls.length).toBeLessThanOrEqual(8);
    expect(channel.send.mock.calls.some((c) => /truncated/i.test((c[0] as any).content))).toBe(false);
  });

  it('a reply that would need more than 8 chunks is cut at 8, the last saying it was truncated, every chunk under 2000', async () => {
    const { send, channel, logs } = setup();
    const text = 'word '.repeat(10_000).trim(); // ~50,000 chars: ~27 chunks
    const r = await send({ kind: 'channel', channel }, text, 'public');
    expect(r.sent).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(8);
    const contents = channel.send.mock.calls.map((c) => (c[0] as any).content as string);
    for (const c of contents) expect(c.length).toBeLessThanOrEqual(2000);
    expect(contents[7]).toMatch(/truncated/i);
    expect(contents.slice(0, 7).some((c) => /truncated/i.test(c))).toBe(false);
    expect(logs.some((l) => l.event === 'truncated' && l.fields.lane === 'public')).toBe(true);
  });

  it('the cap also holds when the cut falls inside a code fence: the last chunk is closed before the note', async () => {
    const { send, channel } = setup();
    const text = '```js\n' + 'const value = compute(1, 2, 3);\n'.repeat(2000) + '```';
    await send({ kind: 'channel', channel }, text, 'public');
    expect(channel.send).toHaveBeenCalledTimes(8);
    const last = (channel.send.mock.calls[7][0] as any).content as string;
    expect(last.length).toBeLessThanOrEqual(2000);
    expect(last).toMatch(/\n```\n[^`]*truncated/i);
  });

  it('a reply is still gated whole before the cut: a word past the 8th chunk blocks it', async () => {
    const { send, channel } = setup();
    const text = 'word '.repeat(10_000) + 'Maple Street';
    const r = await send({ kind: 'channel', channel }, text, 'public');
    expect(r.sent).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('sendGated: the owner lane is capped at 40, not 8', () => {
  it('a 27-chunk reply goes out whole on the owner lane (and is cut at 8 on the public lane)', async () => {
    const text = 'word '.repeat(10_000).trim();
    const owner = setup();
    expect((await owner.send({ kind: 'channel', channel: owner.channel }, text, 'owner')).sent).toBe(true);
    const calls = owner.channel.send.mock.calls.map((c) => (c[0] as any).content as string);
    expect(calls.length).toBeGreaterThan(8);
    expect(calls.length).toBeLessThan(40);
    expect(calls.some((c) => /truncated/i.test(c))).toBe(false);
    expect(owner.logs.some((l) => l.event === 'truncated')).toBe(false);
    expect(calls.join(' ').split(/\s+/).filter(Boolean)).toHaveLength(10_000);

    const pub = setup();
    await pub.send({ kind: 'channel', channel: pub.channel }, text, 'public');
    expect(pub.channel.send).toHaveBeenCalledTimes(8);
  });

  it('an owner reply over 40 chunks is cut at 40, the last saying it was truncated, every chunk under 2000', async () => {
    const { send, channel, logs } = setup();
    const text = 'word '.repeat(40_000).trim(); // ~200,000 chars: ~106 chunks
    const r = await send({ kind: 'channel', channel }, text, 'owner');
    expect(r.sent).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(40);
    const contents = channel.send.mock.calls.map((c) => (c[0] as any).content as string);
    for (const c of contents) expect(c.length).toBeLessThanOrEqual(2000);
    expect(contents[39]).toMatch(/\[reply truncated: too long for Discord\]$/);
    expect(contents.slice(0, 39).some((c) => /truncated/i.test(c))).toBe(false);
    expect(logs.some((l) => l.event === 'truncated' && l.fields.lane === 'owner' && Number(l.fields.chunks) > 40)).toBe(true);
  });

  it('the owner lane is still gated whole: a word past the 40th chunk blocks the reply', async () => {
    const { send, channel } = setup();
    const r = await send({ kind: 'channel', channel }, 'word '.repeat(40_000) + 'Maple Street', 'owner');
    expect(r.sent).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('the typing indicator goes through the send path', () => {
  const typer = (over: Partial<SendRuntime> = {}) => {
    const rt: SendRuntime = {
      isPaused: () => false, isPublicEnabled: () => true, words: () => rulesFromText('Maple Street\n'), names: () => null,
      log: () => {}, chunkDelayMs: 0, ...over,
    };
    return createSender(rt).typing;
  };

  it('shows typing on either lane, and passes a failure on', async () => {
    const ch = { sendTyping: vi.fn(async () => undefined) };
    await typer()(ch, 'owner');
    await typer()(ch, 'public');
    expect(ch.sendTyping).toHaveBeenCalledTimes(2);
    await expect(typer()({ sendTyping: async () => { throw new Error('down'); } }, 'owner')).rejects.toThrow('down');
  });

  it('shows nothing on the public lane while it is paused or off, and still shows it on the owner lane', async () => {
    const ch = { sendTyping: vi.fn(async () => undefined) };
    await typer({ isPaused: () => true })(ch, 'public');
    await typer({ isPublicEnabled: () => false })(ch, 'public');
    expect(ch.sendTyping).not.toHaveBeenCalled();
    await typer({ isPaused: () => true })(ch, 'owner');
    expect(ch.sendTyping).toHaveBeenCalledTimes(1);
  });
});
