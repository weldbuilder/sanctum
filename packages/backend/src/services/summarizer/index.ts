// One runner for every condensed account the companion writes about its own life. Today the rolling fold, merge and rebuild
// (rolling-context.ts); the digest, handoff and outlook author join in a later phase.
//
//   runSummary({ kind, system, user, maxTokens, signal }) → text
//
// `system` is the kind's instruction. The runner puts the companion's short identity ("Who you are (short)", identity-short.ts)
// in front of it, so the system slot is who the companion is plus what this housekeeping asks. `user` is the transcript (fenced by
// the caller, budget rules before it) and is untrusted data. Nothing else from the home folder rides in, the run has no tools,
// and harness memory is off.
//
// Dispatch is on the resolved provider (config.ts → resolveSummarizer): claude → the SDK side-run (claude.ts), codex and dsh → their
// exec paths, openai-compat → the plain chat-completions client (providers/openai-compat.ts).
import { dirname, join } from 'node:path';
import { getSanctumConfig, activeProviderName } from '../../config.js';
import { ownMkdirAsync } from '../../tenancy/own-files.js';
import { childRunBase } from '../../tenancy/child.js';
import { runCodexExec, materializeBaseInstructions } from '../providers/codex-exec.js';
import { runDshSummarizer } from '../providers/dsh-exec.js';
import { chatCompletion } from '../providers/openai-compat.js';
import { runClaudeSummary } from './claude.js';
import { shortIdentity } from './identity-short.js';
import { resolveSummarizer, type ResolvedSummarizer } from './config.js';

export type SummaryKind = 'rolling' | 'digest' | 'handoff' | 'outlook';

export interface RunSummaryArgs {
  kind: SummaryKind;
  /** The kind's instruction. The short identity is added in front of it. */
  system: string;
  /** The material to condense, with its own fencing and budget rules. */
  user: string;
  /** The reply cap in tokens (openai-compat only; the harnesses have no such knob). Default: agent.summarizer.max_output_tokens. */
  maxTokens?: number;
  signal?: AbortSignal;
}

/** The pieces runSummary uses, replaceable in a test. */
export interface SummaryDeps {
  identity: () => Promise<string>;
  claude: typeof runClaudeSummary;
  codex: typeof runCodexExec;
  dsh: typeof runDshSummarizer;
  chat: typeof chatCompletion;
  materialize: (text: string) => string;
  env: () => NodeJS.ProcessEnv;
  resolve: () => ResolvedSummarizer;
  dir: () => string;
}

/** <db folder>/rolling: where the side-run works and what it can see. */
const summaryDir = (): string => join(dirname(getSanctumConfig().server.db_path), 'rolling');

const defaults: SummaryDeps = {
  identity: () => shortIdentity(),
  claude: runClaudeSummary,
  codex: runCodexExec,
  dsh: runDshSummarizer,
  chat: chatCompletion,
  materialize: materializeBaseInstructions,
  env: () => childRunBase(),
  resolve: () => resolveSummarizer(getSanctumConfig(), activeProviderName()),
  dir: summaryDir,
};

/** What a segment records as its engine: which client and model wrote it. */
export function summarizerEngine(r: ResolvedSummarizer = defaults.resolve()): string {
  return r.provider === 'claude' ? `claude:${r.model}` : r.provider === 'openai-compat' ? `openai-compat:${r.model}` : r.provider;
}

/** The system slot: the short identity, then the instruction. */
export function summarySystem(identity: string, instruction: string): string {
  return [identity.trim(), instruction.trim()].filter(Boolean).join('\n\n---\n\n');
}

export async function runSummary(args: RunSummaryArgs, deps: Partial<SummaryDeps> = {}): Promise<string> {
  const d = { ...defaults, ...deps };
  const r = d.resolve();
  const signal = args.signal ?? new AbortController().signal;
  const system = summarySystem(await d.identity(), args.system);
  const timedOut = () => new Error('summarizer was cancelled or timed out');
  if (r.provider === 'openai-compat') {
    if (!r.baseUrl) throw new Error('agent.summarizer.base_url is required when provider is openai-compat');
    if (!r.model) throw new Error('agent.summarizer.model is required when provider is openai-compat');
    const apiKey = d.env()[r.apiKeyEnv];
    if (!apiKey) throw new Error(`the summarizer key is not set: put ${r.apiKeyEnv} in .env`);
    const out = await d.chat({
      baseUrl: r.baseUrl, apiKey, model: r.model, system, user: args.user,
      maxTokens: args.maxTokens ?? r.maxOutputTokens, signal, headers: r.headers,
    });
    return out.text;
  }
  const dir = d.dir();
  await ownMkdirAsync(dir, { recursive: true });
  if (r.provider === 'claude') {
    const text = await d.claude({ system, user: args.user, cwd: dir, model: r.model, signal });
    if (signal.aborted) throw timedOut();
    return text;
  }
  if (r.provider === 'dsh') {
    const out = await d.dsh({ prompt: args.user, baseFile: '', basePrompt: system, dir, signal, model: r.model || undefined, route: r.route || undefined });
    if (signal.aborted) throw timedOut();
    if (out.error) throw new Error(out.error);
    return out.text;
  }
  // codex: the system slot is the base instructions file; read-only, offline, no AGENTS.md, no harness memory.
  let text = '';
  let failure = '';
  for await (const ev of d.codex({
    prompt: args.user, signal, sandboxMode: 'read-only', cwd: dir, networkAccess: false,
    model: r.model || undefined, modelProvider: r.route || undefined,
    harnessMemory: false, baseFile: d.materialize(system), noProjectDocs: true,
  })) {
    if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text;
    else if (ev?.type === 'turn.failed') failure = ev.error?.message || 'turn failed';
    else if (ev?.type === 'error') failure = ev.message || 'error';
  }
  if (signal.aborted) throw timedOut();
  if (failure && !text) throw new Error(failure);
  return text;
}
