import { describe, it, expect, vi } from 'vitest';

// The real index and model are not loaded here: everything localRecall reads comes in through its deps.
vi.mock('./embeddings.js', () => ({ embed: async () => new Float32Array(384) }));
vi.mock('./vector-cache.js', () => ({ searchVectors: () => [] }));
vi.mock('./db.js', () => ({ getMessage: () => null }));
vi.mock('../config.js', () => ({ getSanctumConfig: () => ({ identity: { user_name: 'Sam', timezone: 'America/New_York' } }) }));

import { localRecall, MIN_SIMILARITY, type LocalRecallDeps } from './local-recall.js';

type Hit = { messageId: string; threadId: string; threadName: string; role: string; createdAt: string; similarity: number };
const hit = (id: string, similarity: number, over: Partial<Hit> = {}): Hit => ({ messageId: id, threadId: 'old', threadName: 'Old', role: 'user', createdAt: '2026-10-24T22:30:00Z', similarity, ...over });

function deps(hits: Hit[], contents: Record<string, { content: string; role?: string; deleted_at?: string | null }>, over: Partial<LocalRecallDeps> = {}): LocalRecallDeps {
  return {
    embed: async () => new Float32Array(384),
    search: () => hits,
    message: (id) => (contents[id] ? { role: 'user', deleted_at: null, ...contents[id] } : null),
    userName: 'Sam',
    timezone: 'America/New_York',
    ...over,
  };
}

describe("Sanctum's own memory", () => {
  it('asks the search to leave the open conversation out (so a long talk about one thing cannot crowd out every older line)', async () => {
    const seen: unknown[] = [];
    const d = deps([hit('a', 0.7)], { a: { content: 'older line' } }, { search: (_v, _n, f) => { seen.push(f); return [hit('a', 0.7)]; } });
    expect(await localRecall('the lighthouse', { threadId: 'now' }, d)).toBe('- Oct 24, Sam: older line');
    expect(await localRecall('the lighthouse', {}, d)).toBe('- Oct 24, Sam: older line');
    expect(seen).toEqual([{ excludeThreadId: 'now' }, undefined]);
  });

  it('recalls the closest earlier lines, in the person\'s time zone, naming who said them', async () => {
    const d = deps([hit('a', 0.71), hit('b', 0.6, { role: 'companion', createdAt: '2026-10-25T01:00:00Z' })],
      { a: { content: 'I want to see the  lighthouse\nagain' }, b: { content: 'I kept the ticket from that day.', role: 'companion' } });
    expect(await localRecall('the lighthouse', {}, d)).toBe('- Oct 24, Sam: I want to see the lighthouse again\n- Oct 24, you: I kept the ticket from that day.');
  });

  it('leaves out the open conversation, system lines, deleted and missing messages, repeats, and the message itself', async () => {
    const d = deps([
      hit('same-thread', 0.9, { threadId: 'now' }), hit('sys', 0.85, { role: 'system' }), hit('gone', 0.8), hit('missing', 0.79),
      hit('echo', 0.78), hit('dup1', 0.7), hit('dup2', 0.69), hit('keep', 0.5),
    ], {
      'same-thread': { content: 'in context already' }, sys: { content: 'a system line' }, gone: { content: 'deleted', deleted_at: '2026-10-25' },
      echo: { content: 'the lighthouse' }, dup1: { content: 'twice said' }, dup2: { content: 'twice said' }, keep: { content: 'kept' },
    });
    const out = await localRecall('the lighthouse', { threadId: 'now' }, d);
    expect(out.split('\n')).toEqual(['- Oct 24, Sam: twice said', '- Oct 24, Sam: kept']);
  });

  it('stops at loosely related lines and at the limit, and shortens a long line', async () => {
    const long = 'x'.repeat(400);
    const d = deps([hit('a', 0.9), hit('b', 0.8), hit('c', MIN_SIMILARITY - 0.01)], { a: { content: long }, b: { content: 'second' }, c: { content: 'noise' } });
    expect(await localRecall('the lighthouse', { limit: 1 }, d)).toBe(`- Oct 24, Sam: ${'x'.repeat(300)}…`);
    expect(await localRecall('the lighthouse', {}, d)).not.toContain('noise');
  });

  it('never throws: a model or index failure, or a query too short to mean anything, is an empty recall', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await localRecall('the lighthouse', {}, deps([], {}, { embed: async () => { throw new Error('model missing'); } }))).toBe('');
    expect(await localRecall('hi', {}, deps([hit('a', 0.9)], { a: { content: 'x' } }))).toBe('');
  });
});
