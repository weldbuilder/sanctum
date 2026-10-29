/**
 * In-memory vector cache for fast semantic search.
 *
 * Loads all embeddings into contiguous Float32Arrays at startup.
 * Updates incrementally as new messages are embedded.
 * Search is a tight dot-product loop — no SQLite per query.
 *
 * Memory: ~15 MB at 10K vectors (384 dims × 4 bytes × 10K).
 */

import { getDb } from './db.js';
import { EMBEDDING_DIM } from './embeddings.js';
import { tenantLocal } from '../tenancy/context.js';

interface CacheEntry {
  messageId: string;
  threadId: string;
  threadName: string;
  role: string;
  createdAt: string;
}

// Parallel arrays: metadata[i] corresponds to vectors at offset i * EMBEDDING_DIM.
// `metadata.length` is the LOGICAL count; `vectors` is an amortized-growth
// buffer whose capacity (vectors.length / EMBEDDING_DIM) may exceed it. Slots
// past metadata.length are dead space — never read, never searched.
// One set per database (per tenant in tenant mode): the vectors are that person's messages.
interface VectorState {
  metadata: CacheEntry[];
  vectors: Float32Array;
  messageIndex: Map<string, number>; // messageId → index
  loaded: boolean;
}
const stateLocal = tenantLocal<VectorState>(() => ({ metadata: [], vectors: new Float32Array(0), messageIndex: new Map(), loaded: false }));

// Amortized growth (audit win #2, 2026-07-03): the old code reallocated and
// memcpy'd the ENTIRE corpus (~42 MB at 27.6k vectors) on EVERY new message —
// ~84 MB of allocation churn per conversational turn, scaling linearly with
// the corpus. Growing capacity geometrically makes inserts amortized O(1):
// ~log₁.₅(n) total copies instead of one per message.
const GROWTH_FACTOR = 1.5;
const MIN_GROW_CAPACITY = 1024;

/** Grow `vectors` so it can hold at least `needed` entries. Copies only the
 *  LIVE region (metadata.length entries), at most ~log(n) times ever. */
function ensureCapacity(needed: number): void {
  const s = stateLocal.get();
  const capacity = s.vectors.length / EMBEDDING_DIM;
  if (needed <= capacity) return;
  const newCapacity = Math.max(needed, MIN_GROW_CAPACITY, Math.ceil(capacity * GROWTH_FACTOR));
  const grown = new Float32Array(newCapacity * EMBEDDING_DIM);
  grown.set(s.vectors.subarray(0, s.metadata.length * EMBEDDING_DIM));
  s.vectors = grown;
}

/** Load all embeddings from DB into memory. Call once at startup. */
export function loadVectorCache(): void {
  const s = stateLocal.get();
  const rows = getDb().prepare(`
    SELECT e.message_id, e.vector, m.thread_id, m.role, m.created_at, t.name as thread_name
    FROM message_embeddings e
    JOIN messages m ON m.id = e.message_id
    JOIN threads t ON t.id = m.thread_id
    WHERE m.deleted_at IS NULL
  `).all() as Array<{
    message_id: string; vector: Buffer; thread_id: string;
    role: string; created_at: string; thread_name: string;
  }>;

  const count = rows.length;
  s.vectors = new Float32Array(count * EMBEDDING_DIM);
  s.metadata = new Array(count);
  s.messageIndex = new Map();

  for (let i = 0; i < count; i++) {
    const row = rows[i];
    const buf = row.vector;
    const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    s.vectors.set(f32, i * EMBEDDING_DIM);

    s.metadata[i] = {
      messageId: row.message_id,
      threadId: row.thread_id,
      threadName: row.thread_name,
      role: row.role,
      createdAt: row.created_at,
    };
    s.messageIndex.set(row.message_id, i);
  }

  s.loaded = true;
  console.log(`[vector-cache] Loaded ${count} vectors (${(s.vectors.byteLength / 1024 / 1024).toFixed(1)} MB)`);
}

/** Add or update a single embedding in the cache. Called after embedMessageAsync. */
export function cacheEmbedding(messageId: string, vector: Float32Array, meta: {
  threadId: string; threadName: string; role: string; createdAt: string;
}): void {
  const s = stateLocal.get();
  if (!s.loaded) return;

  const existing = s.messageIndex.get(messageId);
  if (existing !== undefined) {
    s.vectors.set(vector, existing * EMBEDDING_DIM);
    s.metadata[existing] = { messageId, ...meta };
    return;
  }

  const oldLen = s.metadata.length;
  ensureCapacity(oldLen + 1);
  s.vectors.set(vector, oldLen * EMBEDDING_DIM);
  s.metadata.push({ messageId, ...meta });
  s.messageIndex.set(messageId, oldLen);
}

/**
 * Evict a single embedding from the cache (audit win #5, 2026-07-03). Called
 * from the delete paths (regenerate, thread delete, soft delete) so search
 * never surfaces a messageId whose message no longer exists, and orphan
 * vectors stop accumulating in RAM across a long uptime.
 *
 * Swap-remove: the last entry moves into the freed slot — O(1), no buffer
 * reallocation, and the live region stays contiguous for the search scan.
 * Unknown ids are a no-op.
 */
export function removeEmbedding(messageId: string): void {
  const s = stateLocal.get();
  if (!s.loaded) return;
  const idx = s.messageIndex.get(messageId);
  if (idx === undefined) return;

  const last = s.metadata.length - 1;
  if (idx !== last) {
    s.vectors.copyWithin(idx * EMBEDDING_DIM, last * EMBEDDING_DIM, (last + 1) * EMBEDDING_DIM);
    s.metadata[idx] = s.metadata[last];
    s.messageIndex.set(s.metadata[idx].messageId, idx);
  }
  s.metadata.pop();
  s.messageIndex.delete(messageId);
}

export interface SearchFilter {
  threadId?: string;
  /** Leave this conversation out (checked before ranking, so its lines never take the places of others). */
  excludeThreadId?: string;
  role?: string;
  after?: string;
  before?: string;
}

export interface SearchResult {
  messageId: string;
  threadId: string;
  threadName: string;
  role: string;
  createdAt: string;
  similarity: number;
}

/** Fast vector search with optional pre-filtering. Returns top N results sorted by similarity. */
export function searchVectors(queryVector: Float32Array, limit: number, filter?: SearchFilter): SearchResult[] {
  const s = stateLocal.get();
  if (!s.loaded || s.metadata.length === 0) return [];

  const count = s.metadata.length;
  const dim = EMBEDDING_DIM;
  const hasFilter = filter && (filter.threadId || filter.excludeThreadId || filter.role || filter.after || filter.before);

  const heap: SearchResult[] = [];
  let minScore = -Infinity;

  for (let i = 0; i < count; i++) {
    const m = s.metadata[i];

    if (hasFilter) {
      if (filter!.threadId && m.threadId !== filter!.threadId) continue;
      if (filter!.excludeThreadId && m.threadId === filter!.excludeThreadId) continue;
      if (filter!.role && m.role !== filter!.role) continue;
      if (filter!.after && m.createdAt < filter!.after) continue;
      if (filter!.before && m.createdAt > filter!.before) continue;
    }

    let dot = 0;
    const offset = i * dim;
    for (let d = 0; d < dim; d++) {
      dot += queryVector[d] * s.vectors[offset + d];
    }

    if (heap.length < limit) {
      heap.push({ messageId: m.messageId, threadId: m.threadId, threadName: m.threadName, role: m.role, createdAt: m.createdAt, similarity: dot });
      if (heap.length === limit) {
        heap.sort((a, b) => a.similarity - b.similarity);
        minScore = heap[0].similarity;
      }
    } else if (dot > minScore) {
      heap[0] = { messageId: m.messageId, threadId: m.threadId, threadName: m.threadName, role: m.role, createdAt: m.createdAt, similarity: dot };
      heap.sort((a, b) => a.similarity - b.similarity);
      minScore = heap[0].similarity;
    }
  }

  heap.sort((a, b) => b.similarity - a.similarity);
  return heap;
}

export function getCacheStats(): { loaded: boolean; count: number; memoryMb: number } {
  const s = stateLocal.get();
  return {
    loaded: s.loaded,
    count: s.metadata.length,
    memoryMb: Math.round(s.vectors.byteLength / 1024 / 1024 * 10) / 10,
  };
}
