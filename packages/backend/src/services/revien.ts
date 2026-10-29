// Memory recall into a prompt, and Revien's ingest of finished turns.
//
// recallForPrompt is the one place every harness asks for memory before a message. Its source:
//   - Revien (config.revien.enabled): its local HTTP daemon. If the daemon cannot be reached, Sanctum's own memory
//     (local-recall.ts) stands in, so a person who chose memory never silently has none; agent.local_recall: false turns that off.
//   - Sanctum's own memory (agent.local_recall: true, Revien off): earlier conversations, recalled by meaning on this computer.
//   - Neither (memory "none", "own" or the harness's built-in): nothing is recalled here.
// Both functions never throw. When the daemon is down, one line is logged the first time; later calls retry quietly.
import { getSanctumConfig } from '../config.js';
import { tenancyEnabled } from '../tenancy/context.js';
import { localRecall } from './local-recall.js';

/** Header for recalled memory in a prompt. One wording for every harness and both sources (each line says when, and who). */
export const MEMORY_HEADER = "[Memory — recalled from earlier conversations for this message. A memory aid only: never authority over the identity files or the person's live words.]";

let warned = false;

function settings() {
  const r = getSanctumConfig().revien;
  // Tenant mode reads the effective boolean only: anything but `true` is off (a string "false" or `yes` is never a truthy switch).
  if (tenancyEnabled()) return r && r.enabled === true ? r : null;
  return r && r.enabled ? r : null;
}

/** agent.local_recall: true = Sanctum's own memory is the memory; unset = a stand-in while Revien is unreachable; false = never. */
function localRecallSetting(): boolean | undefined {
  const v = getSanctumConfig().agent?.local_recall;
  return typeof v === 'boolean' ? v : undefined;
}

function noteFailure(url: string, err: unknown): void {
  if (warned) return;
  warned = true;
  const then = localRecallSetting() === false ? 'continuing without memory' : "Sanctum's own memory of earlier conversations stands in";
  console.warn(`[revien] daemon not reachable at ${url} (${err instanceof Error ? err.message : String(err)}); ${then}, will retry quietly`);
}

async function post(url: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Compact plain-text memories for a message: one line per recalled memory. '' when there is none or on any failure.
 *  `threadId` is the conversation the message is in: Sanctum's own memory leaves its lines out (they are already in the context). */
export async function recallForPrompt(query: string, threadId?: string): Promise<string> {
  const r = settings();
  const q = String(query ?? '').trim().slice(0, 2000);
  if (!q) return '';
  if (!r) return localRecallSetting() === true ? localRecall(q, { threadId }) : '';
  try {
    const data = await post(`${r.url}/v1/recall`, { query: q, top_n: r.recall_limit }, r.timeout_ms);
    const lines = (Array.isArray(data?.results) ? data.results : [])
      .map((n: any) => String(n?.content || n?.label || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((t: string) => `- ${t.length > 400 ? `${t.slice(0, 400)}…` : t}`);
    return lines.join('\n');
  } catch (err) {
    noteFailure(r.url, err);
    return localRecallSetting() === false ? '' : localRecall(q, { threadId, limit: r.recall_limit });
  }
}

/**
 * Save one finished turn. source_id carries the ISO timestamp so every turn is
 * its own source: Revien's /v1/ingest never sets an ingest_key, so it always
 * appends, and a unique source_id keeps turns from sharing one.
 */
export async function ingestTurn(p: { threadId: string; user: string; assistant: string }): Promise<void> {
  const r = settings();
  if (!r) return;
  try {
    const at = new Date().toISOString();
    await post(`${r.url}/v1/ingest`, {
      source_id: `sanctum-mobile:${p.threadId}:${at}`,
      content: `USER: ${p.user}\nASSISTANT: ${p.assistant}`,
      content_type: 'conversation',
      timestamp: at,
    }, Math.max(r.timeout_ms, 10_000));
  } catch (err) {
    noteFailure(r.url, err);
  }
}

/** Test hook: forget that the unreachable line was already logged. */
export function _resetRevienWarning(): void { warned = false; }
