// Provider switch. Every file that used to import `query` straight from
// '@anthropic-ai/claude-agent-sdk' now imports it from here instead, so the
// rest of Sanctum never needs to know which harness is underneath.
//
// Claude path: untouched pass-through to the Agent SDK.
// Codex path:  ./codex.ts translates Codex thread events into Claude-shaped
//              SDK messages so agent.ts / digest / handoff / outlook-author
//              keep working with zero changes to their stream loops.
// dsh path:    ./dsh.ts does the same for DeepSeek Harness (`dsh headless --json`).
import {
  query as claudeQuery,
  AbortError,
  listSessions,
  type Options,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';
import { getSanctumConfig, activeProviderName } from '../../config.js';
import { codexQuery } from './codex.js';
import { dshQuery } from './dsh.js';
import { childEnv } from './child-env.js';
import { childRunBase } from '../../tenancy/child.js';

export { AbortError, listSessions };
export type { Options, Query, McpServerConfig, ListSessionsOptions } from '@anthropic-ai/claude-agent-sdk';

export type ProviderName = 'claude' | 'codex' | 'dsh';

export function activeProvider(): ProviderName {
  getSanctumConfig(); // throws before load, as before
  return activeProviderName();
}

export function query(params: { prompt: string | AsyncIterable<any>; options?: Options }): Query {
  const p = activeProvider();
  return p === 'codex' ? codexQuery(params)
    : p === 'dsh' ? dshQuery(params)
    // The Claude Code child inherits our environment unless told otherwise; hand it one without the Mind's key.
    : claudeQuery({ ...params, options: { ...params.options, env: childEnv(params.options?.env ?? childRunBase()) } } as Parameters<typeof claudeQuery>[0]);
}
