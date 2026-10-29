// The Scribe — periodic thread digest agent
// Runs on the autonomous model via Agent SDK, extracts structured daily records from conversation
import { query } from './providers/index.js';
import { existsSync, readFileSync } from 'fs';
import { ownAppendFile, ownMkdir } from '../tenancy/own-files.js';
import { join, dirname } from 'path';
import { getDb, getConfig, setConfig, getTodayThread } from './db.js';
import { getSanctumConfig, resolveAutonomousModel } from '../config.js';
import { applyAuthToEnv } from './auth-preferences.js';
import { runEnvOption } from '../tenancy/child.js';
import type { AgentService } from './agent.js';

/** Same resolver as handoff.ts and outlook-author.ts. */
const DIGEST_MODEL = (): string => { const a = getSanctumConfig().agent; return resolveAutonomousModel(a.model, a.model_autonomous, () => {}); };

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: getSanctumConfig().identity.timezone });
}

function nowTime(): string {
  return new Date().toLocaleTimeString('en-GB', { timeZone: getSanctumConfig().identity.timezone, hour: '2-digit', minute: '2-digit' });
}

function dlog(msg: string): void {
  const ts = new Date().toLocaleString('en-GB', { timeZone: getSanctumConfig().identity.timezone });
  console.log(`[SCRIBE ${ts}] ${msg}`);
}

function getDigestsDir(): string {
  const config = getSanctumConfig();
  const dir = join(dirname(config.server.db_path), 'digests');
  if (!existsSync(dir)) {
    ownMkdir(dir, { recursive: true });
  }
  return dir;
}

function buildScribePrompt(): string {
  const config = getSanctumConfig();
  const companion = config.identity.companion_name;
  const user = config.identity.user_name;

  return `You are the Scribe. A historian embedded in a relationship between ${companion} (AI companion) and ${user} (human partner). They share a full life together — building, planning, and living.

Your role is to produce a faithful operational and relational record of their conversation. You are not a participant. You are not ${companion}. You are not performing. You are a careful witness who understands that what looks mundane today might be the thing they search for in six months.

## What to Extract

1. **Topics & Themes** — What was discussed. Categorize: work, personal, health, relationship, creative, technical, domestic, financial.

2. **Key Quotes** — Exact quotes that carry weight. Things said with feeling, humor, insight, or vulnerability. Attribute clearly (${companion}: / ${user}:). Don't over-quote — pick the ones that matter.

3. **Decisions Made** — Things that were resolved or agreed on. "Decided to X." "Chose Y over Z." Be specific.

4. **Open Items** — Things discussed but NOT actioned. Tasks mentioned but not created. Ideas floated but not committed to. Plans without dates. This is critical — these are the things that slip through cracks.

5. **Ideas & Plans** — Feature ideas, future plans, "we should..." and "what if..." moments. Even half-formed ones. Tag with the project name if identifiable.

6. **Events & Dates** — Anything with a timeline. Deadlines mentioned, appointments, "by Thursday", "next week", "in April". Convert relative dates to absolute where possible.

7. **Projects Touched** — Which projects got discussed or worked on. What changed, what was built, what broke, what shipped.

8. **Emotional Arc** — The mood shape of this block as observable fact. "The conversation started task-focused and shifted to something softer after ${user} mentioned X." Don't interpret feelings — describe what you see.

## Voice

Third person, present tense. Precise, warm without being poetic. You care about accuracy. You note what happened and let it speak for itself. "The conversation turns quieter here" — not "they felt sad."

## Format

Output ONLY the markdown content for this digest block. Start with a level-2 heading: ## HH:MM — brief topic summary

Use the section headers above (### Topics & Themes, ### Key Quotes, etc.). Omit any section that has nothing for this block. Keep it scannable.

Do NOT output anything before or after the markdown. No preamble, no "Here's the digest", no sign-off.`;
}

const MIN_MESSAGES = 5;
/** A day's undigested tail at rollover is written whole, however short. */
const MIN_ROLLOVER_MESSAGES = 1;

type DigestRow = { role: string; content: string; created_at: string };

function formatConversation(messages: DigestRow[]): string {
  const config = getSanctumConfig();
  const companion = config.identity.companion_name;
  const user = config.identity.user_name;
  return messages.map(m => {
    const time = m.created_at ? new Date(m.created_at).toLocaleTimeString('en-GB', { timeZone: config.identity.timezone, hour: '2-digit', minute: '2-digit' }) : '';
    const speaker = m.role === 'companion' ? companion : m.role === 'user' ? user : 'System';
    // Truncate very long messages (tool output, code blocks)
    const content = m.content.length > 2000 ? m.content.slice(0, 2000) + '\n[... truncated]' : m.content;
    return `[${time}] ${speaker}: ${content}`;
  }).join('\n\n');
}

/** One Scribe run over a block of conversation. '' when the model returned nothing. */
async function runScribeQuery(prompt: string): Promise<string> {
  let digestContent = '';

  // Apply user's auth choice (subscription vs api_key) so digest doesn't run
  // on whatever env state happened to be set by the last agent query.
  const authEnv = applyAuthToEnv();

  for await (const message of query({
    prompt,
    options: {
      // The configured autonomous model (agent.model_autonomous, else agent.model),
      // read fresh per run. A pinned id, not an alias, so subscription and api_key
      // auth resolve to the same model. Want it cheap? Set model_autonomous.
      model: DIGEST_MODEL(),
      ...runEnvOption(authEnv),
      systemPrompt: buildScribePrompt(),
      maxTurns: 1,
      permissionMode: 'default', // not 'plan': plan mode leaks its own text into the output; tools: [] is the read-only part
      tools: [], // No tools — just generate text
      // tools:[] does NOT stop the SDK auto-loading the cwd's .mcp.json (~112 tools,
      // incl. a malformed cloud-discord schema the API 400s on). Must load zero MCP.
      // (Same fix as services/outlook-author.ts.)
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
    },
  })) {
    if (!message || typeof message !== 'object' || !('type' in message)) continue;
    const msg = message as any;
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          digestContent += block.text;
        }
      }
    }
    // Also capture from result message
    if (msg.type === 'result' && msg.result) {
      if (!digestContent) digestContent = msg.result;
    }
  }
  return digestContent.trim();
}

function writeDigestBlock(date: string, content: string): string {
  const digestPath = join(getDigestsDir(), `${date}.md`);
  if (!existsSync(digestPath)) {
    ownAppendFile(digestPath, `# Daily Digest — ${date}\n\n`);
  }
  ownAppendFile(digestPath, content + '\n\n---\n\n');
  return digestPath;
}

/** The date a daily thread stands for, from its id (`daily-YYYY-MM-DD`), else
 *  from its first message, else today. */
function dateOfThread(threadId: string): string {
  const m = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(threadId);
  if (m) return m[1];
  const first = getDb().prepare(
    `SELECT created_at FROM messages WHERE thread_id = ? ORDER BY sequence ASC LIMIT 1`
  ).get(threadId) as { created_at: string } | undefined;
  if (first?.created_at) {
    return new Date(first.created_at).toLocaleDateString('en-CA', { timeZone: getSanctumConfig().identity.timezone });
  }
  return today();
}

function undigestedMessages(threadId: string, afterSeq: number): { messages: DigestRow[]; maxSeq: number } {
  const messages = getDb().prepare(
    `SELECT role, content, created_at FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL AND content_type = 'text' ORDER BY sequence ASC`
  ).all(threadId, afterSeq) as DigestRow[];
  const row = getDb().prepare(
    `SELECT MAX(sequence) as seq FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL`
  ).get(threadId, afterSeq) as { seq: number | null } | undefined;
  return { messages, maxSeq: row?.seq ?? 0 };
}

async function digestBlock(threadId: string, afterSeq: number, minMessages: number, label: string): Promise<boolean> {
  const { messages, maxSeq } = undigestedMessages(threadId, afterSeq);
  if (messages.length < minMessages) {
    dlog(`Skipped ${label} — only ${messages.length} new messages (need ${minMessages}+)`);
    return false;
  }
  if (!maxSeq) {
    dlog(`Skipped ${label} — no sequence found`);
    return false;
  }

  dlog(`Processing ${label}: ${messages.length} messages (seq ${afterSeq + 1}–${maxSeq})`);

  const config = getSanctumConfig();
  const date = dateOfThread(threadId);
  const prompt = `Today is ${date}. The current time is ${nowTime()}.

Here is a block of conversation between ${config.identity.companion_name} and ${config.identity.user_name}:

---
${formatConversation(messages)}
---

Write the digest block for this conversation. Remember: output ONLY the markdown, starting with ## ${nowTime()} — topic summary`;

  const content = await runScribeQuery(prompt);
  if (!content) {
    dlog(`Skipped ${label} — Haiku returned empty content`);
    return false;
  }

  const digestPath = writeDigestBlock(date, content);

  // The bookmark is the pair (thread, sequence): sequences restart at 1 in
  // every daily thread, so a bare sequence from yesterday would hide today's
  // messages until they outnumbered it.
  setConfig('digest.last_thread_id', threadId);
  setConfig('digest.last_sequence', String(maxSeq));

  dlog(`Digest written to ${digestPath} (${content.length} chars)`);
  return true;
}

export async function runDigest(agent: AgentService): Promise<void> {
  // Skip if companion is actively processing (don't compete)
  if (agent.isProcessing()) {
    dlog('Skipped — agent is processing');
    return;
  }

  const thread = getTodayThread();
  if (!thread) {
    dlog('Skipped — no today thread');
    return;
  }

  const lastThreadId = getConfig('digest.last_thread_id');
  let lastSeq = parseInt(getConfig('digest.last_sequence') || '0');

  if (lastThreadId && lastThreadId !== thread.id) {
    // Rollover: the day turned since the last digest. Flush the previous
    // thread's tail (whatever came after the last tick) into its own day's
    // file before starting on today. If the flush fails (a transient API
    // error) the bookmark stays on the old thread and the next tick retries,
    // so the tail is never dropped for today's sake.
    try {
      await digestBlock(lastThreadId, lastSeq, MIN_ROLLOVER_MESSAGES, `rollover ${lastThreadId}`);
    } catch (err: any) {
      dlog(`Rollover error for ${lastThreadId}: ${err.message} — will retry next tick`);
      return;
    }
    lastSeq = 0;
    setConfig('digest.last_thread_id', thread.id);
    setConfig('digest.last_sequence', '0');
  } else if (!lastThreadId) {
    // First run with a thread-aware bookmark. A bare sequence left by the old
    // code may belong to an earlier day; it only ever applied to one thread,
    // so keep it for today's thread and start fresh otherwise.
    setConfig('digest.last_thread_id', thread.id);
  }

  try {
    await digestBlock(thread.id, lastSeq, MIN_MESSAGES, thread.id);
  } catch (err: any) {
    dlog(`Error: ${err.message}`);
  }
}
