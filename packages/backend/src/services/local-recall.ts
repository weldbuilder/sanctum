// Sanctum's own memory: the bridge for when no memory system is installed.
//
// Every text message from the person and the companion is already embedded on this computer (embeddings.ts, a local model, no API
// call) and kept in the in-memory vector index (vector-cache.ts). Before a message, this finds the few earlier lines closest in
// meaning and hands them to the prompt in the same slot Revien's recall fills (revien.ts recallForPrompt). It needs nothing installed,
// works the same on every harness, and never throws: any failure is an empty recall.
//
// It recalls; it does not summarise or decide. Lines from the conversation already open are left out (they are in the context), as
// are system lines (never embedded), deleted messages, and anything only loosely related.

import { embed } from './embeddings.js';
import { searchVectors, type SearchFilter, type SearchResult } from './vector-cache.js';
import { getMessage } from './db.js';
import { getSanctumConfig } from '../config.js';

/** The bar a line must clear. Measured with the real model (all-MiniLM-L6-v2): a question and the line it is about ("how did my kid
 *  do at his class?" / "my son starts karate…") score about 0.35, unrelated pairs about 0.16 at most. 0.28 keeps clear of the noise. A
 *  link that needs inference (dinner plans / "I hate cilantro", 0.19) is below it: this recalls what was said, not what follows from it. */
export const MIN_SIMILARITY = 0.28;
/** One recalled line at most this long. */
const MAX_LINE = 300;

export interface LocalRecallDeps {
  embed: (text: string) => Promise<Float32Array>;
  search: (vector: Float32Array, limit: number, filter?: SearchFilter) => SearchResult[];
  message: (id: string) => { content: string; role: string; deleted_at: string | null } | null;
  userName: string;
  timezone: string;
}

function liveDeps(): LocalRecallDeps {
  const cfg = getSanctumConfig();
  return {
    embed,
    search: (v, n, f) => searchVectors(v, n, f),
    message: (id) => getMessage(id),
    userName: cfg.identity?.user_name || '',
    timezone: cfg.identity?.timezone || 'UTC',
  };
}

/** "Oct 24", in the person's time zone. */
function dayOf(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timezone }); } catch { return d.toISOString().slice(0, 10); }
}

/**
 * The recalled lines for one message, one per line ("- Oct 24, Sam: …" / "- Oct 24, you: …", read by the companion), or '' when
 * nothing earlier is close enough or anything fails.
 */
export async function localRecall(query: string, opts: { threadId?: string; limit?: number } = {}, deps: LocalRecallDeps = liveDeps()): Promise<string> {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (q.length < 4) return '';
  const limit = Math.max(1, Math.min(opts.limit ?? 6, 12));
  try {
    const vector = await deps.embed(q);
    // The open conversation is left out inside the search, not after it: in a long talk about one thing its own lines would otherwise fill every place.
    const hits = deps.search(vector, 40, opts.threadId ? { excludeThreadId: opts.threadId } : undefined);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const h of hits) {
      if (lines.length >= limit) break;
      if (h.similarity < MIN_SIMILARITY) break; // sorted, best first
      if (opts.threadId && h.threadId === opts.threadId) continue;
      if (h.role !== 'user' && h.role !== 'companion') continue;
      const m = deps.message(h.messageId);
      if (!m || m.deleted_at) continue;
      const text = m.content.replace(/\s+/g, ' ').trim();
      if (!text || text === q || seen.has(text)) continue;
      seen.add(text);
      const who = h.role === 'user' ? (deps.userName || 'they') : 'you';
      const day = dayOf(h.createdAt, deps.timezone);
      lines.push(`- ${day ? `${day}, ` : ''}${who}: ${text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text}`);
    }
    return lines.join('\n');
  } catch (err) {
    console.warn(`[memory] Sanctum's own memory could not recall this time (${err instanceof Error ? err.message : String(err)})`);
    return '';
  }
}
