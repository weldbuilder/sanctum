// runGatedTurn: the Discord module's use of the agent's held reply. A reply is committed (saved and,
// on the owner lane, handed to memory) only after the gated send succeeded; a blocked or failed one is
// discarded; the retry note rides the rewrite prompt and never memory.
import { describe, it, expect, vi } from 'vitest';
import { runGatedTurn } from './turn.js';
import type { SendResult } from './send.js';

const ok: SendResult = { sent: true };
const word = (hits: string[]): SendResult => ({ sent: false, reason: 'word', hits, entries: hits });

function stubAgent(replies: string[]) {
  const held: Array<{ text: string; commit: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> }> = [];
  const calls: any[][] = [];
  let i = 0;
  const processMessage = vi.fn(async (...args: any[]) => {
    calls.push(args);
    const text = replies[Math.min(i++, replies.length - 1)];
    const r = { text, commit: vi.fn(), discard: vi.fn() };
    held.push(r);
    args[3]?.hold?.onHeld(r);
    return text;
  });
  return { agent: { processMessage } as any, held, calls, processMessage };
}

const base = { threadId: 't', content: 'hello', threadMeta: { name: 'N', type: 'named' as const }, platformContext: 'ctx' };

describe('runGatedTurn', () => {
  it('a clean first answer is sent, then committed, and memory sees the original text on the owner lane', async () => {
    const s = stubAgent(['fine']);
    const out = await runGatedTurn({ ...base, agent: s.agent, lane: 'owner', deliver: async () => ok, onBlock: vi.fn() });
    expect(out).toMatchObject({ sent: true, attempts: 1 });
    expect(s.held[0].commit).toHaveBeenCalledTimes(1);
    expect(s.held[0].discard).not.toHaveBeenCalled();
    const [threadId, content, meta, opts] = s.calls[0];
    expect([threadId, content, meta]).toEqual(['t', 'hello', { name: 'N', type: 'named' }]);
    expect(opts).toMatchObject({ platform: 'discord', platformContext: 'ctx', senderIsOwner: true, hold: { userText: 'hello', ingest: true } });
  });

  it('promptContent (mentions resolved, D9) is what the model is asked; memory is still told the original words', async () => {
    const s = stubAgent(['fine']);
    await runGatedTurn({ ...base, content: 'tell <@444>', promptContent: 'tell @Sage', agent: s.agent, lane: 'owner', deliver: async () => ok, onBlock: vi.fn() });
    expect(s.calls[0][1]).toBe('tell @Sage');
    expect(s.calls[0][3]).toMatchObject({ hold: { userText: 'tell <@444>' } });
  });

  it('images (owner attachments, D4) ride the first and the rewrite attempt through processMessage', async () => {
    const s = stubAgent(['has Janie', 'clean now']);
    const images = [{ fileId: 'f1', filename: 'pic.png', contentType: 'image' as const }];
    await runGatedTurn({ ...base, images, agent: s.agent, lane: 'owner', deliver: async (t) => (t === 'has Janie' ? word(['Janie']) : ok), onBlock: vi.fn() });
    expect(s.calls.map((c) => c[3].images)).toEqual([images, images]);
  });

  it('lane public: nothing enters memory (ingest false), and the run is not the owner', async () => {
    const s = stubAgent(['fine']);
    await runGatedTurn({ ...base, agent: s.agent, lane: 'public', deliver: async () => ok, onBlock: vi.fn() });
    expect(s.calls[0][3]).toMatchObject({ senderIsOwner: false, hold: { userText: 'hello', ingest: false } });
    expect(s.held[0].commit).toHaveBeenCalledTimes(1);
  });

  it('a blocked reply is discarded, the rewrite carries the note, and only the sent reply is committed', async () => {
    const s = stubAgent(['has Janie', 'clean now']);
    const deliver = vi.fn(async (t: string) => (t === 'has Janie' ? word(['Janie']) : ok));
    const out = await runGatedTurn({ ...base, agent: s.agent, lane: 'owner', deliver, onBlock: vi.fn() });
    expect(out).toMatchObject({ sent: true, attempts: 2 });
    expect(s.held[0].discard).toHaveBeenCalledTimes(1);
    expect(s.held[0].commit).not.toHaveBeenCalled();
    expect(s.held[1].commit).toHaveBeenCalledTimes(1);
    expect(s.calls[1][1]).toBe('hello\n\nYour reply was not sent because it contained: Janie. Answer again without it.');
    // memory is told the original words, never the note
    expect(s.calls[1][3].hold.userText).toBe('hello');
    expect(s.calls[0][1]).toBe('hello');
  });

  it('two blocks: both discarded, nothing committed', async () => {
    const s = stubAgent(['a Janie', 'b Janie']);
    const out = await runGatedTurn({ ...base, agent: s.agent, lane: 'owner', deliver: async () => word(['Janie']), onBlock: vi.fn() });
    expect(out).toMatchObject({ sent: false, attempts: 2 });
    expect(s.held.map((h) => h.commit.mock.calls.length)).toEqual([0, 0]);
    expect(s.held.map((h) => h.discard.mock.calls.length)).toEqual([1, 1]);
  });

  it('a block a rewrite cannot fix (paused, gate error) discards and does not rerun', async () => {
    const s = stubAgent(['x']);
    const out = await runGatedTurn({ ...base, agent: s.agent, lane: 'public', deliver: async () => ({ sent: false, reason: 'paused', hits: [], entries: [] }), onBlock: vi.fn() });
    expect(out.sent).toBe(false);
    expect(s.processMessage).toHaveBeenCalledTimes(1);
    expect(s.held[0].discard).toHaveBeenCalledTimes(1);
    expect(s.held[0].commit).not.toHaveBeenCalled();
  });

  it('an empty answer sends nothing and is discarded', async () => {
    for (const empty of ['', '   ', '[No response]']) {
      const s = stubAgent([empty]);
      const deliver = vi.fn(async () => ok);
      const out = await runGatedTurn({ ...base, agent: s.agent, lane: 'owner', deliver, onBlock: vi.fn() });
      expect(out).toMatchObject({ sent: false, empty: true });
      expect(deliver).not.toHaveBeenCalled();
      expect(s.held[0].commit).not.toHaveBeenCalled();
    }
  });

  it('a Discord error while sending discards the reply and lets the error through', async () => {
    const s = stubAgent(['fine']);
    await expect(runGatedTurn({ ...base, agent: s.agent, lane: 'owner', deliver: async () => { throw new Error('Missing Permissions'); }, onBlock: vi.fn() })).rejects.toThrow('Missing Permissions');
    expect(s.held[0].commit).not.toHaveBeenCalled();
    expect(s.held[0].discard).toHaveBeenCalledTimes(1);
  });

  it('tells onBlock about every block, as replyWithRetry does', async () => {
    const s = stubAgent(['a', 'b']);
    const onBlock = vi.fn();
    await runGatedTurn({ ...base, agent: s.agent, lane: 'owner', deliver: async () => word(['Janie']), onBlock });
    expect(onBlock.mock.calls.map((c) => [c[0].attempt, c[0].willRetry])).toEqual([[1, true], [2, false]]);
  });
});
