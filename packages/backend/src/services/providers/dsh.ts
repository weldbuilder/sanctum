// DeepSeek Harness (dsh) adapter: the third provider, beside Claude and Codex.
//
// Runs a turn through `dsh headless --json` (see dsh-exec.ts) and re-emits it as
// the message shapes the Claude Agent SDK produces (system/init, stream_event
// deltas, assistant, user/tool_result, result). The existing stream loops
// consume it unchanged. Mirrors codex.ts; differences are called out.
//
// WHAT WORKS (against the contract; model call unverified without a key)
//   - committed text and thinking per step, resume via dsh session ids, stop,
//     usage -> context meter, MCP servers from .mcp.json (stdio and HTTP with
//     headers), read-only mode for subagents (digest/handoff/outlook).
//   - tool_call / tool_result become tool_use / tool_result blocks AND drive the
//     app's PreToolUse / PostToolUse hooks (under Claude names), which is what
//     paints the tool-timeline pills and writes the audit log; Codex has neither.
//     The hooks run after dsh has already acted, so their deny decisions (the
//     destructive-bash and write-prefix guards) are logged, not enforced:
//     dsh's own sandbox is the containment boundary.
// THREE LAYERS (joined here, as on Codex)
//   1. Base prompt = the persona. <agent.cwd>/config/dsh-base-prompt.md, else
//      agent.dsh.base_instructions_file; sent as the system-prompt personaPrefix
//      with dsh's own "You are an AI agent powered by DeepSeek Harness" opener off.
//   2. Identity = the self, prepended to the main conversation's message.
//   3. AGENTS.md = workspace law. dsh-agent-instructions loads it by itself.
//   Rolling mode (agent.rolling.dsh, main conversation only): every turn is a
//   fresh ephemeral run; session id is the stable `rolling:<threadId>`.
//   Streaming is block-wise: dsh commits text once per step, never live tokens.
import { AbortError, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { readOwnOrApp } from '../../tenancy/own-files.js';
import { identityBlock } from '../identity/block.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSanctumConfig } from '../../config.js';
import { runDshExec } from './dsh-exec.js';
import { routeKeyVar } from './dsh-key.js';
import { assembleRollingHistory } from '../rolling-history.js';
import { recallForPrompt, ingestTurn, MEMORY_HEADER } from '../revien.js';
import { mindRecallBlock } from '../mind-client.js';
import { childRunBase } from '../../tenancy/child.js';

function resolveBaseFile(): string {
  const agentCfg = getSanctumConfig().agent;
  const homeBase = join(agentCfg.cwd, 'config', 'dsh-base-prompt.md');
  const baseCfg = agentCfg.dsh.base_instructions_file;
  return existsSync(homeBase) ? homeBase : (baseCfg && existsSync(baseCfg) ? baseCfg : '');
}

function readBasePrompt(): string {
  const f = resolveBaseFile();
  return f ? readOwnOrApp(f) : '';
}

/** The public lane's persona frame, shipped with the app: who she is comes from the identity, and this file only
 *  holds the public rules. A sealed run never reads the companion's own config/dsh-base-prompt.md (it describes tools
 *  and a workspace the public run does not have). A missing file throws: the run fails closed, it does not fall back. */
const PUBLIC_BASE_FILE = fileURLToPath(new URL('../../../../../prompts/discord-public-base.md', import.meta.url));
function readPublicBasePrompt(): string {
  const text = readFileSync(PUBLIC_BASE_FILE, 'utf-8').trim();
  if (!text) throw new Error('the public base prompt is empty');
  return text;
}

function resolveModel(requested: string | undefined, autonomous: boolean): string | undefined {
  const dx = getSanctumConfig().agent.dsh;
  if (requested && !requested.startsWith('claude')) return requested; // already a dsh model id
  return (autonomous ? (dx.model_autonomous || dx.model) : dx.model) || undefined;
}

// Layer 2: the companion's identity, read fresh each turn so edits apply live.
// (services/identity/block.ts: the one reader of the home's identity folder, shared with dsh and the other harnesses)

function systemText(sp: Options['systemPrompt']): string {
  if (!sp) return '';
  if (typeof sp === 'string') return sp;
  return (sp as any).append ?? '';
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** dsh step_end usage -> Claude-shaped usage. Field names are not pinned by the
 *  contract, so both camelCase and snake_case spellings are read. */
export function readUsage(u: any): { in: number; out: number; cacheRead: number; cacheWrite: number } | null {
  if (!u || typeof u !== 'object') return null;
  return {
    in: num(u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens),
    out: num(u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens),
    cacheRead: num(u.cacheReadTokens ?? u.cache_read_input_tokens ?? u.cachedInputTokens ?? u.cached_input_tokens),
    cacheWrite: num(u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? u.cacheWriteInputTokens),
  };
}

/** dsh-native tool names -> the Claude names the app's hooks and pill renderer key on. */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read', write: 'Write', edit: 'Edit', str_replace_editor: 'Edit', glob: 'Glob', grep: 'Grep',
  bash: 'Bash', pwsh: 'Bash', web_fetch: 'WebFetch', web_search: 'WebSearch', todo_write: 'TodoWrite',
};
export const claudeToolName = (dshName: string): string => TOOL_NAMES[dshName] ?? dshName; // mcp__srv__tool is already the same shape

/** A shell command that exited non-zero still comes back `completed`, with the code in the text. */
export const hasFailedExit = (result: string): boolean => /\[exit code: (?!0\])-?\d+\]/.test(result);

/** Text arrives as bare "\n\n" before a tool call and with leading newlines on real replies. */
export const cleanText = (t: string): string => t.replace(/^\n+/, '').trimEnd();

interface TranslateState { lastText: string; completed: boolean; sessionId: string }

// dsh run events -> Claude-shaped messages. fixedSession: keep state.sessionId
// (rolling mode) instead of dsh's session id.
async function* translate(
  events: AsyncIterable<any>,
  o: { fixedSession: boolean; model: string | undefined; showThinking: boolean; state: TranslateState; hooks?: Options['hooks']; cwd?: string },
): AsyncGenerator<any> {
  const { state } = o;
  const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }; // summed over steps: spend
  let last: { in: number; out: number; cacheRead: number } | null = null; // the last step: context size
  let sawUsage = false;
  let ended: { ok: boolean; error?: string } | null = null;
  let streamError = '';
  let resultSent = false;
  let maxTurns = false;
  const calls = new Map<string, { name: string; input: any }>();

  async function fireHooks(event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', input: Record<string, unknown>, id: string) {
    for (const matcher of (o.hooks?.[event] ?? []) as any[]) {
      for (const cb of matcher.hooks ?? []) {
        try {
          const out: any = await cb({ hook_event_name: event, session_id: state.sessionId, cwd: o.cwd ?? '', transcript_path: '', ...input }, id, { signal: new AbortController().signal });
          if (event === 'PreToolUse' && out?.hookSpecificOutput?.permissionDecision === 'deny') {
            console.warn(`[dsh] a PreToolUse guard would have denied ${input.tool_name} (${out.hookSpecificOutput.permissionDecisionReason ?? ''}) but dsh had already run it`);
          }
        } catch (err) {
          console.warn(`[dsh] ${event} hook failed:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  function* block(kind: 'text' | 'thinking', text: string) {
    yield { type: 'stream_event', session_id: state.sessionId, event: { type: 'content_block_start', content_block: { type: kind } } };
    yield {
      type: 'stream_event', session_id: state.sessionId,
      event: { type: 'content_block_delta', delta: kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } },
    };
    yield { type: 'stream_event', session_id: state.sessionId, event: { type: 'content_block_stop' } };
  }

  function* result(finalText: string | undefined) {
    if (resultSent) return;
    if (!ended && !streamError) return; // stopped before a turn ended: the caller reports the stop
    resultSent = true;
    if (ended?.ok && !streamError) {
      state.completed = true;
      const text = finalText ? cleanText(finalText) || state.lastText : state.lastText;
      state.lastText = text;
      // usage drives the context meter (input + output of the LAST step; dsh reports
      // cache reads apart from inputTokens). `spend` is the sum over steps.
      const ctx = last ? { in: last.in + last.cacheRead, out: last.out } : { in: 0, out: 0 };
      yield {
        type: 'result', subtype: 'success', session_id: state.sessionId, result: text,
        usage: {
          input_tokens: ctx.in, output_tokens: ctx.out,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          ...(sawUsage ? {} : { unavailable: true }),
        },
        context_tokens: ctx.in + ctx.out,
        spend: {
          input_tokens: usage.in, output_tokens: usage.out,
          cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite,
        },
      };
    } else {
      yield { type: 'result', subtype: maxTurns ? 'error_max_turns' : 'error_during_execution', session_id: state.sessionId, errors: [ended && !ended.ok ? ended.error! : streamError || 'dsh turn failed'] };
    }
  }

  for await (const ev of events) {
    switch (ev?.type) {
      case 'session':
        if (!o.fixedSession && typeof ev.sessionId === 'string') state.sessionId = ev.sessionId;
        yield { type: 'system', subtype: 'init', session_id: state.sessionId, model: o.model ?? 'dsh-default' };
        break;
      case 'thinking':
        if (o.showThinking && ev.text) yield* block('thinking', String(ev.text));
        break;
      case 'text':
        if (typeof ev.text === 'string' && ev.text.trim()) {
          const text = cleanText(ev.text);
          yield* block('text', text);
          state.lastText = text;
          yield { type: 'assistant', session_id: state.sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } };
        }
        break;
      case 'tool_call': {
        const name = claudeToolName(String(ev.tool));
        const input = ev.input ?? {};
        calls.set(String(ev.callId), { name, input });
        yield {
          type: 'assistant', session_id: state.sessionId,
          message: { role: 'assistant', content: [{ type: 'tool_use', id: String(ev.callId), name, input }] },
        };
        await fireHooks('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: String(ev.callId) }, String(ev.callId));
        break;
      }
      case 'tool_result': {
        const id = String(ev.callId);
        const content = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
        const isError = ev.status === 'error' || hasFailedExit(content);
        yield {
          type: 'user', session_id: state.sessionId,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
        };
        const call = calls.get(id) ?? { name: 'unknown', input: {} };
        if (isError) await fireHooks('PostToolUseFailure', { tool_name: call.name, tool_input: call.input, tool_use_id: id, error: content }, id);
        else await fireHooks('PostToolUse', { tool_name: call.name, tool_input: call.input, tool_use_id: id, tool_response: content }, id);
        break;
      }
      case 'error':
        // A stdout error event: keep the first message; it fails the turn unless turn_end says otherwise.
        if (!streamError) streamError = String(ev.error?.message ?? ev.message ?? (typeof ev.error === 'string' ? ev.error : JSON.stringify(ev)));
        break;
      case 'status':
        if (ev.phase === 'step_end') {
          // dsh omits usage when it is incomplete rather than under-reporting.
          const u = readUsage(ev.usage);
          if (u) { sawUsage = true; last = u; usage.in += u.in; usage.out += u.out; usage.cacheRead += u.cacheRead; usage.cacheWrite += u.cacheWrite; }
        } else if (ev.phase === 'turn_end') {
          const r = ev.reason;
          // Only `completed` is success; aborted, blocked, max-tokens and anything new are not.
          if (r?.kind === 'max_turns') maxTurns = true; // the runner cut a sealed run short at its step limit
          ended = r?.kind === 'completed' ? { ok: true }
            : r?.kind === 'error'
              ? { ok: false, error: [r.error?.code, r.error?.message].filter(Boolean).join(': ') || 'dsh turn failed' }
              : { ok: false, error: `dsh turn ended without completing: ${r?.kind ?? 'unknown reason'}` };
        }
        // turn_start / step_start: nothing
        break;
      case 'final':
        yield* result(typeof ev.text === 'string' ? ev.text : undefined);
        break;
    }
  }
  yield* result(undefined); // a stream that ended without `final`
}

export function dshQuery({ prompt, options }: { prompt: string | AsyncIterable<any>; options?: Options }): Query {
  const opts = (options ?? {}) as Options;
  const cfg = getSanctumConfig();
  const dx = cfg.agent.dsh;
  const signal = opts.abortController?.signal;
  // The public lane's run (sanctum.sealed) is sealed: see dsh-exec.ts. Everything below that would reach a tool, an
  // MCP server, a plugin, a saved session, the companion's own base prompt or a second model step is switched off.
  const sealed = ((opts as any).sanctum as { sealed?: boolean } | undefined)?.sealed === true;
  const readOnly = sealed || opts.permissionMode === 'plan' || (Array.isArray(opts.tools) && opts.tools.length === 0);
  const showThinking = (opts as any).thinking?.display === 'summarized';

  async function* run(): AsyncGenerator<any> {
    if (typeof prompt !== 'string') throw new Error('[dsh] streaming-input prompts are not supported');

    // A sealed run has a pristine, empty DSH_HOME, so it has no dsh account sign-in: the route's API key must be in the
    // environment (it passes the runner's allowlist). Without one the lane is silent: one log line per process, no run.
    if (sealed) {
      const keyVar = routeKeyVar({ apiKeyEnv: dx.api_key_env || undefined, modelProvider: dx.model_provider || undefined });
      if (keyVar && !childRunBase()[keyVar]) {
        if (!warnedSealedKey.has(keyVar)) {
          warnedSealedKey.add(keyVar); // once per process per variable: a different missing name is news
          console.warn(`[dsh] public runs need an API key in the environment: ${keyVar} is not set. A public run uses its own empty dsh home, so a DeepSeek account sign-in in your dsh home does not apply to it. Set ${keyVar} (in .env) to answer in public Discord; until then public replies are skipped.`);
        }
        throw Object.assign(new Error('the public run has no API key'), { kind: 'api_key_missing' });
      }
    }

    const sanctum = (opts as any).sanctum as { threadId: string; userContent: string; autonomous?: boolean; senderIsOwner?: boolean; noIngest?: boolean; memory?: 'none'; sealed?: boolean } | undefined;
    // memory: 'none' (the public lane): no recall, no ingest, no thread history, no fold.
    const noMemory = sanctum?.memory === 'none';
    const rollingOn = !readOnly && !noMemory && cfg.agent.rolling?.dsh !== false && !!sanctum?.threadId;
    const resumeId = !sealed && opts.resume && !opts.resume.startsWith('rolling:') ? opts.resume : undefined;
    const workingDirectory = opts.cwd ?? cfg.agent.cwd;
    const effort = (opts as any).effort ? String((opts as any).effort) : undefined;
    // Autonomous = read-only subagents (digest/handoff/outlook) AND the main agent's
    // wakes (sanctum.autonomous). Both run on agent.dsh.model_autonomous, '' = follow chat.
    const model = resolveModel(opts.model, readOnly || !!sanctum?.autonomous);
    const sandboxMode = readOnly ? 'read-only' as const : dx.sandbox_mode;

    const useMemory = !readOnly && !sanctum?.autonomous && !noMemory;
    let memoryBlock = '';
    // Per-message Mind recall. The SDK's UserPromptSubmit hook does not fire on
    // this path, so the adapter asks itself; same gate as Revien.
    let mindBlock = '';
    if (useMemory) {
      const [memory, mind] = await Promise.all([
        recallForPrompt(sanctum?.userContent ?? prompt, sanctum?.threadId),
        mindRecallBlock(sanctum?.userContent ?? prompt),
      ]);
      if (memory) memoryBlock = `${MEMORY_HEADER}\n${memory}`;
      mindBlock = mind;
    }
    const state: TranslateState = { lastText: '', completed: false, sessionId: resumeId ?? '' };
    const finish = () => {
      // `noIngest`: a held Discord turn. The agent hands the exchange to memory itself, after the gated send.
      if (!useMemory || sanctum?.noIngest || !state.completed || !state.lastText) return;
      void ingestTurn({ threadId: sanctum?.threadId ?? state.sessionId, user: sanctum?.userContent ?? prompt, assistant: state.lastText });
    };

    // Run kind for plugin rows. Read-only runs are the one-shot helpers (digest, handoff,
    // outlook: tools: []); they carry no `sanctum` option, so they cannot be told apart
    // from each other here and are all 'helper'. The rolling summarizer is its own
    // runner (runDshSummarizer) and passes 'summarizer' itself.
    const runKind = sealed ? undefined : readOnly ? 'helper' as const : sanctum?.autonomous ? 'wake' as const : 'turn' as const;
    const execBase = {
      runKind, threadId: sanctum?.threadId, senderIsOwner: sanctum?.senderIsOwner,
      sandboxMode, cwd: workingDirectory, command: dx.command, home: sealed ? undefined : dx.home || undefined, // a sealed run gets a pristine home of its own (dsh-exec.ts)
      model, modelProvider: dx.model_provider || undefined, apiKeyEnv: dx.api_key_env || undefined,
      baseUrl: dx.base_url || undefined, effort,
      basePrompt: sealed ? readPublicBasePrompt() : readBasePrompt(),
      mcp: sealed ? undefined : opts.mcpServers as Record<string, any> | undefined,
      ...(sealed ? { sealed: true, noProjectDocs: true, maxSteps: typeof opts.maxTurns === 'number' && opts.maxTurns > 0 ? opts.maxTurns : 1 } : {}),
    };

    let input = prompt;
    let fixedSession = false;
    let ephemeral = false;
    let sessionId: string | undefined;
    let rolling: Awaited<ReturnType<typeof assembleRollingHistory>>['rolling'] | undefined;
    const threadId = sanctum?.threadId ?? '';

    if (rollingOn) {
      state.sessionId = `rolling:${threadId}`;
      fixedSession = true; ephemeral = true;
      // Fail-soft history assembly (see rolling-history.ts).
      const history = await assembleRollingHistory(threadId, sanctum!.userContent, !!sanctum!.autonomous);
      rolling = history.rolling;
      const { summary, notice, lines } = history;
      input = [
        identityBlock('dsh'),
        memoryBlock,
        mindBlock,
        summary,
        notice,
        lines.length ? `[Conversation so far]\n${lines.join('\n')}` : '',
        `[Current message]\n${prompt}`,
      ].filter(Boolean).join('\n\n');
    } else if (readOnly) {
      const taskBrief = !resumeId ? systemText(opts.systemPrompt) : '';
      if (taskBrief) input = `[System]\n${taskBrief}\n[/System]\n\n${prompt}`;
      // A one-shot helper leaves no dsh session behind; one that resumes a real session cannot be ephemeral.
      ephemeral = !resumeId;
      sessionId = resumeId;
    } else {
      const head = [
        !resumeId || dx.identity_every_turn ? identityBlock('dsh') : '',
        memoryBlock,
        mindBlock,
      ].filter(Boolean);
      if (head.length) input = `${head.join('\n\n')}\n\n[Current message]\n\n${prompt}`;
      sessionId = resumeId;
    }

    try {
      const events = runDshExec({ ...execBase, prompt: input, signal, sessionId, ephemeral });
      yield* translate(events, { fixedSession, model, showThinking, state, hooks: opts.hooks, cwd: workingDirectory });
      // The runner ends quietly when stopped; the app needs to hear it as a stop.
      if (signal?.aborted) throw new AbortError('dsh turn aborted');
      finish();
      if (rolling) {
        try { void Promise.resolve(rolling.maybeCompact(threadId)).catch(() => {}); } catch { /* ignore */ }
      }
    } catch (err) {
      if (signal?.aborted) throw new AbortError('dsh turn aborted');
      throw err;
    }
  }

  const gen = run();
  return Object.assign(gen, {
    interrupt: async () => { opts.abortController?.abort(); },
    mcpServerStatus: async () => [], // TODO: surface dsh MCP status in Settings
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedCommands: async () => [],
    supportedModels: async () => [],
  }) as unknown as Query;
}

const warnedSealedKey = new Set<string>();
/** Test hook. */
export function resetSealedKeyWarning(): void { warnedSealedKey.clear(); }
