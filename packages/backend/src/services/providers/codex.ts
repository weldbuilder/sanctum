// Codex harness adapter.
//
// Runs a turn through @openai/codex-sdk and re-emits it as the message shapes
// the Claude Agent SDK produces (system/init, stream_event deltas, assistant,
// result). The existing stream loops consume it unchanged.
//
// WHAT WORKS
//   - streaming text, reasoning → thinking pill, resume via Codex thread ids,
//     stop-generation, per-thread effort, usage → context meter, MCP servers
//     from .mcp.json, read-only mode for subagents (digest/handoff/outlook).
// KNOWN GAPS (stubbed, see TODOs)
//   - Claude SDK hooks do not fire: no tool timeline pills, no audit log, no
//     per-tool write-gate. Codex's sandbox (workspace-write + extra dirs) is
//     the containment boundary instead.
// THREE LAYERS (joined here, deliberately)
//   1. Base prompt = the harness. <agent.cwd>/config/codex-base-prompt.md if it
//      exists, else agent.codex.base_instructions_file. Replaces Codex's stock
//      "You are Codex..." prompt for the run; ~/.codex/config.toml is untouched.
//   2. Identity = the self. <agent.cwd>/identity/profile.md + companion.md,
//      written after the base prompt into the same model_instructions_file (the system slot),
//      so it rides every run of the main conversation and is re-read on each one.
//   3. AGENTS.md = workspace law. Codex discovers and injects it on its own.
//   Sanctum's CLAUDE.md / system-prompt frame are not used on this path.
//   Read-only subagents (digest/handoff/outlook) get their task brief instead of
//   the identity block: those are jobs, not the self.
//   Rolling mode (agent.codex.rolling, main conversation only): the app owns the
//   history. Each turn is a fresh unlogged `codex exec --ephemeral` run whose
//   prompt is Revien memory + rolling summary + the context block + verbatim tail + the
//   current message (the identity is in the system slot, not here). Session id is the stable `rolling:<threadId>`.
//   - Attachments ride as file paths in the prompt (same as Claude path);
//     native local_image input is a TODO.
import {
  Codex,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type ModelReasoningEffort,
  type CodexOptions,
} from '@openai/codex-sdk';
import { AbortError, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { identityBlock } from '../identity/block.js';
import { join } from 'node:path';
import { getSanctumConfig } from '../../config.js';
import { runCodexExec, materializeBaseInstructions } from './codex-exec.js';
import { readOwnOrApp } from '../../tenancy/own-files.js';
import { childEnv } from './child-env.js';
import { childRunBase } from '../../tenancy/child.js';
import { currentTenant, tenancyEnabled } from '../../tenancy/context.js';
import { assembleRollingHistory, conversationBlock, splitContextBlock } from '../rolling-history.js';
import { recallForPrompt, ingestTurn, MEMORY_HEADER } from '../revien.js';
import { mindRecallBlock } from '../mind-client.js';

const clients = new Map<string, Codex>();

function resolveBaseFile(): string {
  const agentCfg = getSanctumConfig().agent;
  const homeBase = join(agentCfg.cwd, 'config', 'codex-base-prompt.md');
  const baseCfg = agentCfg.codex.base_instructions_file;
  return existsSync(homeBase) ? homeBase : (baseCfg && existsSync(baseCfg) ? baseCfg : '');
}

/** The model_instructions_file for a MAIN run: the harness base first, then the identity, as one content-addressed file (the same order
 *  as Claude's system prompt: mechanics, then who I am). An edit to either makes a new path. '' when there is neither: stock Codex.
 *  Read-only helper runs never come through here; they get resolveBaseFile() as it is. */
function identityBaseFile(): string {
  const f = resolveBaseFile();
  const base = f ? readOwnOrApp(f) : '';
  const text = [base, identityBlock('codex')].filter((x) => x && x.trim()).join('\n\n');
  return text ? materializeBaseInstructions(text) : '';
}

/** `baseFile` is the model_instructions_file path: the identity file on a main run (see identityBaseFile), so it is in the cache key,
 *  and an identity edit (a new path) gets a new client. */
function getClient(mcpServers: Options['mcpServers'], baseFile: string): Codex {
  const mcp = toCodexMcp(mcpServers);
  // Swap Codex's stock "You are Codex..." base prompt (17k chars, its own
  // personality and formatting rules) for the lean companion one, so AGENTS.md
  // is not arguing with a coding-assistant persona on every turn. Passed as a
  // per-run override: ~/.codex/config.toml is never touched.
  const provider = getSanctumConfig().agent.codex.model_provider || '';
  const harnessMemory = !!getSanctumConfig().agent.harness_memory;
  // The tenant id is in the key: two tenants never share a client (each carries its own env, key and CODEX_HOME).
  const key = JSON.stringify([mcp, baseFile, provider, harnessMemory, currentTenant()?.id ?? null]);
  let c = clients.get(key);
  if (!c) {
    // Passing env stops the SDK inheriting ours wholesale; it is ours minus the Mind's key.
    const base = childRunBase();
    const opts: CodexOptions = { env: Object.fromEntries(Object.entries(childEnv(base)).filter(([, v]) => v !== undefined)) as Record<string, string> };
    if (base.OPENAI_API_KEY) opts.apiKey = base.OPENAI_API_KEY; // else: `codex login` session
    const config: Record<string, any> = {};
    if (Object.keys(mcp).length) config.mcp_servers = mcp;
    if (baseFile) config.model_instructions_file = baseFile;
    if (provider) config.model_provider = provider;
    config.features = { memories: harnessMemory }; // explicit both ways; see codex-exec.ts
    if (tenancyEnabled()) config.sandbox_workspace_write = { exclude_slash_tmp: true }; // D7: see codex-exec.ts
    if (Object.keys(config).length) opts.config = config;
    c = new Codex(opts);
    clients.set(key, c);
  }
  return c;
}

// .mcp.json (Claude format) → Codex config.toml mcp_servers table.
// Codex splits config keys on dots even inside quotes, so a server name with
// anything but letters, digits, _ or - makes Codex refuse to start at all.
// Skip such a server (once, loudly) rather than lose every turn to it.
const warnedMcpNames = new Set<string>();
function toCodexMcp(servers: Options['mcpServers']): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, s] of Object.entries(servers ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      if (!warnedMcpNames.has(name)) {
        warnedMcpNames.add(name);
        console.warn(`[codex] MCP server "${name}" skipped: Codex only accepts names made of letters, digits, _ and -. Rename it in .mcp.json to use it.`);
      }
      continue;
    }
    const srv = s as any;
    if (srv.command) {
      out[name] = { command: srv.command, args: srv.args ?? [], ...(srv.env && { env: srv.env }) };
    } else if (srv.url) {
      out[name] = { url: srv.url };
    } // in-process SDK servers have no Codex equivalent — skipped
  }
  return out;
}

function resolveModel(requested: string | undefined, autonomous: boolean): string | undefined {
  const cx = getSanctumConfig().agent.codex;
  if (requested && !requested.startsWith('claude')) return requested; // already a Codex model id
  // Subagents follow codex.model unless given their own; '' on both → Codex default.
  return (autonomous ? (cx.model_autonomous || cx.model) : cx.model) || undefined;
}

const EFFORT: Record<string, ModelReasoningEffort> = {
  low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};

// Layer 2: the companion's identity, read fresh each turn so edits apply live.
// Structured profile first, then the first-person narrative.
// (services/identity/block.ts: the one reader of the home's identity folder, shared with dsh and the other harnesses)

function systemText(sp: Options['systemPrompt']): string {
  if (!sp) return '';
  if (typeof sp === 'string') return sp;
  return (sp as any).append ?? '';
}


interface TranslateState { lastText: string; completed: boolean; sessionId: string }

// Codex event stream (SDK or `codex exec --experimental-json`) → Claude-shaped
// messages. fixedSession: keep state.sessionId (rolling mode) instead of Codex's thread id.
async function* translate(
  events: AsyncIterable<ThreadEvent>,
  o: { fixedSession: boolean; model: string | undefined; showThinking: boolean; state: TranslateState },
): AsyncGenerator<any> {
  const { state } = o;
  const seen = new Map<string, string>(); // item id → text emitted so far

  function* diff(item: ThreadItem & { text: string }, kind: 'text' | 'thinking', done: boolean) {
    const prev = seen.get(item.id);
    if (prev === undefined) {
      yield { type: 'stream_event', session_id: state.sessionId, event: { type: 'content_block_start', content_block: { type: kind } } };
    }
    const delta = item.text.slice((prev ?? '').length);
    if (delta) {
      yield {
        type: 'stream_event', session_id: state.sessionId,
        event: { type: 'content_block_delta', delta: kind === 'text' ? { type: 'text_delta', text: delta } : { type: 'thinking_delta', thinking: delta } },
      };
    }
    seen.set(item.id, item.text);
    if (done) yield { type: 'stream_event', session_id: state.sessionId, event: { type: 'content_block_stop' } };
  }

  for await (const ev of events) {
    switch (ev.type) {
      case 'thread.started':
        if (!o.fixedSession) state.sessionId = ev.thread_id;
        yield { type: 'system', subtype: 'init', session_id: state.sessionId, model: o.model ?? 'codex-default' };
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = ev.item;
        const done = ev.type === 'item.completed';
        if (item.type === 'agent_message') {
          yield* diff(item, 'text', done);
          if (done) {
            state.lastText = item.text;
            yield { type: 'assistant', session_id: state.sessionId, message: { role: 'assistant', content: [{ type: 'text', text: item.text }] } };
          }
        } else if (item.type === 'reasoning' && o.showThinking) {
          yield* diff(item, 'thinking', done);
        } else if (done && (item.type === 'command_execution' || item.type === 'mcp_tool_call' || item.type === 'file_change' || item.type === 'web_search')) {
          // TODO(tool-timeline): broadcast a tool pill via registry here to
          // replace what the Claude PostToolUse hook does.
          console.log(`[codex] ${item.type}`, item.type === 'command_execution' ? item.command : item.type === 'mcp_tool_call' ? `${item.server}.${item.tool}` : '');
        } else if (done && item.type === 'error') {
          console.warn('[codex] item error:', item.message);
        }
        break;
      }
      case 'turn.completed':
        state.completed = true;
        yield {
          type: 'result', subtype: 'success', session_id: state.sessionId, result: state.lastText,
          usage: {
            input_tokens: ev.usage.input_tokens,
            output_tokens: ev.usage.output_tokens,
            cache_read_input_tokens: ev.usage.cached_input_tokens,
            cache_creation_input_tokens: ev.usage.cache_write_input_tokens ?? 0,
          },
        };
        break;
      case 'turn.failed':
        yield { type: 'result', subtype: 'error_during_execution', session_id: state.sessionId, errors: [ev.error.message] };
        break;
      case 'error':
        yield { type: 'result', subtype: 'error_during_execution', session_id: state.sessionId, errors: [ev.message] };
        break;
    }
  }
}

export function codexQuery({ prompt, options }: { prompt: string | AsyncIterable<any>; options?: Options }): Query {
  const opts = (options ?? {}) as Options;
  const cfg = getSanctumConfig();
  const cx = cfg.agent.codex;
  const signal = opts.abortController?.signal;
  const readOnly = opts.permissionMode === 'plan' || (Array.isArray(opts.tools) && opts.tools.length === 0);
  const showThinking = (opts as any).thinking?.display === 'summarized';

  async function* run(): AsyncGenerator<any> {
    if (typeof prompt !== 'string') throw new Error('[codex] streaming-input prompts are not supported');

    const sanctum = (opts as any).sanctum as { threadId: string; userContent: string; autonomous?: boolean; noIngest?: boolean; memory?: 'none'; contextBlock?: string } | undefined;
    // memory: 'none' (the public lane): no recall, no ingest, no thread history, no fold, no harness memory.
    const noMemory = sanctum?.memory === 'none';
    const rollingOn = !readOnly && !noMemory && !!cfg.agent.rolling?.codex && !!sanctum?.threadId;
    // A `rolling:<thread>` id is ours, not a Codex session. If rolling was used
    // and then switched off, never hand it to Codex as something to resume.
    const resumeId = opts.resume && !opts.resume.startsWith('rolling:') ? opts.resume : undefined;
    const workingDirectory = opts.cwd ?? cfg.agent.cwd;
    const effort = (opts as any).effort && EFFORT[(opts as any).effort] ? EFFORT[(opts as any).effort] : undefined;
    // Autonomous = read-only subagents (digest/handoff/outlook) AND the main agent's
    // wakes (sanctum.autonomous). Both run on agent.codex.model_autonomous, '' = follow chat.
    const model = resolveModel(opts.model, readOnly || !!sanctum?.autonomous);
    const sandboxMode = readOnly ? 'read-only' as const : cx.sandbox_mode;

    // Recalled memory (Revien) rides in the message (the identity is in the system slot). It is for the
    // person's own messages: not subagents, and not autonomous wakes, whose
    // canned wake prompt would otherwise be searched for and saved as if said.
    const useMemory = !readOnly && !sanctum?.autonomous && !noMemory;
    let memoryBlock = '';
    // Per-message Mind recall (search, surface, active threads). On the Claude
    // path this rides in through the UserPromptSubmit hook; SDK hooks do not
    // fire here, so the adapter asks for it itself. '' when no mind is set.
    // Same gate as Revien: never for subagents, wakes or the public lane.
    let mindBlock = '';
    if (useMemory) {
      const [memory, mind] = await Promise.all([
        recallForPrompt(sanctum?.userContent ?? prompt, sanctum?.threadId),
        mindRecallBlock(sanctum?.userContent ?? prompt),
      ]);
      if (memory) memoryBlock = `${MEMORY_HEADER}\n${memory}`;
      mindBlock = mind;
    }
    const state = { lastText: '', completed: false, sessionId: resumeId ?? '' };
    const finish = () => {
      // `noIngest`: a held Discord turn. The agent hands the exchange to memory itself, after the gated send.
      if (!useMemory || sanctum?.noIngest || !state.completed || !state.lastText) return;
      void ingestTurn({ threadId: sanctum?.threadId ?? state.sessionId, user: sanctum?.userContent ?? prompt, assistant: state.lastText });
    };

    if (rollingOn) {
      const threadId = sanctum!.threadId;
      state.sessionId = `rolling:${threadId}`;
      // History assembly is fail-soft (see rolling-history.ts): a broken history
      // source degrades the context for this one message and says so in the
      // prompt; it never fails or blocks the turn.
      const history = await assembleRollingHistory(threadId, sanctum!.userContent, !!sanctum!.autonomous, { named: true });
      const rolling = history.rolling;
      const { summary, notice, lines } = history;
      // The orientation block comes out of the message and sits above the conversation.
      const { context, message } = splitContextBlock(prompt, sanctum?.contextBlock);
      const sections = [
        memoryBlock,
        mindBlock,
        summary,
        notice,
        context,
        conversationBlock(lines),
        `[Current message]\n${message}`,
      ].filter(Boolean);
      const input = sections.join('\n\n');

      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) ctl.abort();
      try {
        const events = runCodexExec({
          prompt: input, signal: ctl.signal, sandboxMode, cwd: workingDirectory,
          additionalDirectories: cx.additional_directories, model, modelProvider: cx.model_provider || undefined, harnessMemory: !noMemory && !!cfg.agent.harness_memory, networkAccess: cx.network_access,
          baseFile: identityBaseFile(), effort, mcp: toCodexMcp(opts.mcpServers),
        });
        yield* translate(events, { fixedSession: true, model, showThinking, state });
        // The runner ends quietly when stopped; the app needs to hear it as a stop.
        if (signal?.aborted) throw new AbortError('Codex turn aborted');
        finish();
        // Fold older history in the background once the turn is done, so the
        // fold note lands after the reply. Never blocks or fails anything.
        if (rolling) {
          try { void Promise.resolve(rolling.maybeCompact(threadId)).catch(() => {}); } catch { /* ignore */ }
        }
      } catch (err) {
        if (signal?.aborted) throw new AbortError('Codex turn aborted');
        throw err;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      return;
    }

    const threadOpts: ThreadOptions = {
      model,
      workingDirectory,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      sandboxMode,
      networkAccessEnabled: cx.network_access, // res CLI talks to the loopback backend
      additionalDirectories: cx.additional_directories,
      ...(effort && { modelReasoningEffort: effort }),
    };

    // Subagents: their task brief. Main conversation: recalled memory, then the message last. AGENTS.md is added by Codex itself.
    let input = prompt;
    if (readOnly) {
      const taskBrief = !resumeId ? systemText(opts.systemPrompt) : '';
      if (taskBrief) input = `[System]\n${taskBrief}\n[/System]\n\n${prompt}`;
      // A one-shot helper (digest, handoff, outlook) leaves no Codex session
      // behind either: same unlogged runner as rolling mode. Only a helper that
      // resumes a real Codex session still needs the SDK.
      if (!resumeId) {
        try {
          const events = runCodexExec({
            prompt: input, signal, sandboxMode: 'read-only', cwd: workingDirectory,
            additionalDirectories: cx.additional_directories, model, modelProvider: cx.model_provider || undefined, harnessMemory: !noMemory && !!cfg.agent.harness_memory, networkAccess: cx.network_access,
            baseFile: resolveBaseFile(), effort, mcp: toCodexMcp(opts.mcpServers),
          });
          yield* translate(events, { fixedSession: false, model, showThinking, state });
          if (signal?.aborted) throw new AbortError('Codex turn aborted');
        } catch (err) {
          if (signal?.aborted) throw new AbortError('Codex turn aborted');
          throw err;
        }
        return;
      }
    } else {
      const head = [memoryBlock, mindBlock].filter(Boolean);
      if (head.length) input = `${head.join('\n\n')}\n\n[Current message]\n\n${prompt}`;
    }

    // The base-instructions file is a per-spawn `--config` the SDK passes on `exec resume` too, and Codex applies it over the resumed
    // thread's stored one, so an identity edit reaches a resumed thread on its next turn (checked against codex-cli 0.159.3).
    const client = getClient(opts.mcpServers, readOnly ? resolveBaseFile() : identityBaseFile());
    const thread = resumeId ? client.resumeThread(resumeId, threadOpts) : client.startThread(threadOpts);

    try {
      const { events } = await thread.runStreamed(input, { signal });
      yield* translate(events, { fixedSession: false, model: threadOpts.model, showThinking, state });
      finish();
    } catch (err) {
      if (signal?.aborted) throw new AbortError('Codex turn aborted');
      throw err;
    }
  }

  const gen = run();
  return Object.assign(gen, {
    interrupt: async () => { opts.abortController?.abort(); },
    mcpServerStatus: async () => [], // TODO: surface Codex MCP status in Settings
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedCommands: async () => [],
    supportedModels: async () => [],
  }) as unknown as Query;
}
