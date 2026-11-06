// The summarizer as a Claude run: one isolated, tool-less, unsaved SDK query, the same shape digest.ts uses. Moved here from
// rolling-context.ts with its guards unchanged: cwd <db>/rolling, tools [], maxTurns 1, no setting sources, auto-compact and
// the harness's memory off. Nothing of the person's settings or memory rides in; the system slot is the caller's.
import { childEnv } from '../providers/child-env.js';
import { childRunBase } from '../../tenancy/child.js';

export async function runClaudeSummary(o: { system: string; user: string; cwd: string; model: string; signal: AbortSignal }): Promise<string> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let text = '';
  const ac = new AbortController();
  o.signal.addEventListener('abort', () => ac.abort(), { once: true });
  if (o.signal.aborted) ac.abort();
  for await (const message of query({
    prompt: o.user,
    options: {
      // 'default', not 'plan': plan mode injects its own system text ("Plan mode is
      // active with the plan file at …") and the real run showed it ending up in
      // every summary. tools: [] already means there is nothing to permit.
      model: o.model, systemPrompt: o.system, cwd: o.cwd, maxTurns: 1, permissionMode: 'default', tools: [],
      strictMcpConfig: true, mcpServers: {}, persistSession: false, settingSources: [], env: childEnv(childRunBase()),
      settings: { autoCompactEnabled: false, autoMemoryEnabled: false },
      abortController: ac,
    },
  })) {
    const msg = message as any;
    if (msg?.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) if (block.type === 'text' && block.text) text += block.text;
    }
    if (msg?.type === 'result' && msg.result && !text) text = msg.result;
  }
  return text;
}
