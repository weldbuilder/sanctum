import { describe, it, expect, vi } from 'vitest';
import { retryPrompt, replyWithRetry, withheldNotice } from './retry.js';
import type { SendResult } from './send.js';

const ok: SendResult = { sent: true };
const word = (hits: string[], entries = hits): SendResult => ({ sent: false, reason: 'word', hits, entries });

describe('retryPrompt', () => {
  it('names what the reply contained and asks for it again without it', () => {
    expect(retryPrompt(['Maple Street', 'Janie'])).toBe(
      'Your reply was not sent because it contained: Maple Street, Janie. Answer again without it.',
    );
  });
});

describe('replyWithRetry', () => {
  it('sends a clean first answer and never reruns the turn', async () => {
    const produce = vi.fn(async () => 'fine');
    const send = vi.fn(async () => ok);
    const out = await replyWithRetry({ produce, deliver: send, onBlock: vi.fn() });
    expect(out).toMatchObject({ sent: true, attempts: 1 });
    expect(produce).toHaveBeenCalledTimes(1);
    expect(produce.mock.calls[0]).toEqual([undefined]);
  });

  it('on a block reruns the turn once with the reason appended, and sends the second answer', async () => {
    const produce = vi.fn(async (note?: string) => (note ? 'rewritten' : 'first'));
    const send = vi.fn(async (t: string) => (t === 'first' ? word(['Maple Street']) : ok));
    const onBlock = vi.fn();
    const out = await replyWithRetry({ produce, deliver: send, onBlock });
    expect(out).toMatchObject({ sent: true, attempts: 2 });
    expect(produce).toHaveBeenCalledTimes(2);
    expect(produce.mock.calls[1][0]).toBe('Your reply was not sent because it contained: Maple Street. Answer again without it.');
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onBlock.mock.calls[0][0]).toMatchObject({ attempt: 1, willRetry: true });
  });

  it('a second block is silence: no third turn, one more notice', async () => {
    const produce = vi.fn(async () => 'still has Janie');
    const send = vi.fn(async () => word(['Janie']));
    const onBlock = vi.fn();
    const out = await replyWithRetry({ produce, deliver: send, onBlock });
    expect(out).toMatchObject({ sent: false, attempts: 2 });
    expect(produce).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onBlock.mock.calls.map((c) => [c[0].attempt, c[0].willRetry])).toEqual([[1, true], [2, false]]);
  });

  it('a name-guard block retries the same way', async () => {
    const produce = vi.fn(async () => 'x');
    const send = vi.fn()
      .mockResolvedValueOnce({ sent: false, reason: 'name', hits: ['Pat Placeholder'], entries: ['Pat Placeholder'] })
      .mockResolvedValueOnce(ok);
    expect((await replyWithRetry({ produce, deliver: send, onBlock: vi.fn() })).sent).toBe(true);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('paused and gate failures do not retry: a rewrite cannot help', async () => {
    for (const blocked of [
      { sent: false, reason: 'paused', hits: [], entries: [] } as SendResult,
      { sent: false, reason: 'gate_error', hits: [], entries: [], error: 'the word list at /x is empty' } as SendResult,
    ]) {
      const produce = vi.fn(async () => 'x');
      const onBlock = vi.fn();
      const out = await replyWithRetry({ produce, deliver: async () => blocked, onBlock });
      expect(out).toMatchObject({ sent: false, attempts: 1 });
      expect(produce).toHaveBeenCalledTimes(1);
      expect(onBlock.mock.calls[0][0]).toMatchObject({ attempt: 1, willRetry: false });
    }
  });

  it('an empty answer sends nothing and does not retry', async () => {
    const send = vi.fn(async () => ok);
    for (const empty of ['', '   ', '[No response]']) {
      const out = await replyWithRetry({ produce: async () => empty, deliver: send, onBlock: vi.fn() });
      expect(out).toMatchObject({ sent: false, attempts: 1, empty: true });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('an empty second answer is silence', async () => {
    const produce = vi.fn(async (note?: string) => (note ? '' : 'first'));
    const send = vi.fn(async () => word(['Janie']));
    const out = await replyWithRetry({ produce, deliver: send, onBlock: vi.fn() });
    expect(out).toMatchObject({ sent: false, attempts: 2 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('withheldNotice: the owner thread line, entry names only', () => {
  it('first block, retrying', () => {
    const t = withheldNotice({ attempt: 1, willRetry: true, result: word(['555-010-0142'], ['re:\\d{3}']) });
    expect(t).toMatch(/withheld/i);
    expect(t).toContain('re:\\d{3}');
    expect(t).not.toContain('555-010-0142');
    expect(t.length).toBeLessThan(220);
  });
  it('second block, nothing sent', () => {
    const t = withheldNotice({ attempt: 2, willRetry: false, result: word(['Janie']) });
    expect(t).toMatch(/again/i);
    expect(t).toMatch(/nothing was sent/i);
    expect(t).toContain('Janie');
  });
  it('a gate failure says the gate could not run, and why', () => {
    const t = withheldNotice({ attempt: 1, willRetry: false, result: { sent: false, reason: 'gate_error', hits: [], entries: [], error: 'the word list at /x is empty' } });
    expect(t).toMatch(/could not run/i);
    expect(t).toContain('the word list at /x is empty');
  });
});

describe('reasons added in pass B1', () => {
  it('a merged word and name block retries once, naming everything', async () => {
    const produce = vi.fn(async (note?: string) => (note ? 'clean' : 'dirty'));
    const send = vi.fn(async (t: string) => (t === 'dirty' ? ({ sent: false, reason: 'word_name', hits: ['Janie', 'Pat Placeholder'], entries: ['Janie', 'Pat Placeholder'] } as SendResult) : ok));
    const out = await replyWithRetry({ produce, deliver: send, onBlock: vi.fn() });
    expect(out).toMatchObject({ sent: true, attempts: 2 });
    expect(produce.mock.calls[1][0]).toBe('Your reply was not sent because it contained: Janie, Pat Placeholder. Answer again without it.');
  });
  it('payload and public_off blocks are not retried', async () => {
    for (const reason of ['payload', 'public_off'] as const) {
      const produce = vi.fn(async () => 'x');
      const out = await replyWithRetry({ produce, deliver: async () => ({ sent: false, reason, hits: [], entries: [] }), onBlock: vi.fn() });
      expect(out).toMatchObject({ sent: false, attempts: 1 });
      expect(produce).toHaveBeenCalledTimes(1);
    }
  });
  it('the notice for a merged block names both kinds, entries only', () => {
    const t = withheldNotice({ attempt: 1, willRetry: true, result: { sent: false, reason: 'word_name', hits: ['a'], entries: ['Janie', 'Pat Placeholder'] } });
    expect(t).toMatch(/word/);
    expect(t).toMatch(/name/);
    expect(t).toContain('Janie, Pat Placeholder');
  });
  it('notices for public_off and payload say why nothing was sent', () => {
    expect(withheldNotice({ attempt: 1, willRetry: false, result: { sent: false, reason: 'public_off', hits: [], entries: [] } })).toMatch(/public lane is off/i);
    expect(withheldNotice({ attempt: 1, willRetry: false, result: { sent: false, reason: 'payload', hits: [], entries: [], error: 'key components is not allowed' } })).toMatch(/components/);
  });
});
