import { describe, it, expect, vi } from 'vitest';

// No database here: the index starts empty and the lines are cached one by one, as they are after each message.
vi.mock('./db.js', () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));
vi.mock('./embeddings.js', () => ({ EMBEDDING_DIM: 4 }));

import { cacheEmbedding, loadVectorCache, searchVectors } from './vector-cache.js';

const v = (...xs: number[]) => Float32Array.from(xs);
const meta = (threadId: string) => ({ threadId, threadName: threadId, role: 'user', createdAt: '2026-10-24T22:30:00Z' });

describe('searchVectors', () => {
  it('leaves a conversation out before it ranks, so its own lines never take every place', () => {
    loadVectorCache();
    // Five lines of the open conversation, each closer to the question than the one older line about it.
    for (let i = 0; i < 5; i++) cacheEmbedding(`now-${i}`, v(1, 0, 0, 0), meta('now'));
    cacheEmbedding('older', v(0.8, 0.6, 0, 0), meta('then'));
    const q = v(1, 0, 0, 0);
    expect(searchVectors(q, 3).map((h) => h.messageId)).toEqual(['now-0', 'now-1', 'now-2']); // the open talk fills the top
    expect(searchVectors(q, 3, { excludeThreadId: 'now' }).map((h) => h.messageId)).toEqual(['older']);
    expect(searchVectors(q, 3, { threadId: 'then' }).map((h) => h.messageId)).toEqual(['older']); // the existing filter, unchanged
  });
});
