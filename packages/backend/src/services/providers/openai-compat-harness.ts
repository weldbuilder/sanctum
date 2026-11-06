// The fourth harness: a plain OpenAI-compatible chat-completions endpoint (OpenRouter, DeepSeek, a local server) as the
// FALLBACK brain, with a function-calling loop over the `res` verbs.
//
// It re-emits a turn as the message shapes the Claude Agent SDK produces (system/init, stream_event deltas, assistant,
// user/tool_result, result), so agent.ts has one stream loop and does not branch. Mirrors dsh.ts; differences:
//   - The model has no shell, so each `res` verb is a function (openai-compat-tools.ts). A call goes to the same
//     /api/internal/* route `res` would hit, over loopback with the internal token, so the route's write gate, tenant check
//     and audit all answer as ever.
//   - tool_use / tool_result blocks are emitted AND drive the app's PreToolUse / PostToolUse hooks (tool pills, audit_log), as
//     on dsh. Because this adapter runs the tool itself, a PreToolUse deny is enforced here (the tool does not run).
//   - Streaming is round-wise: each round trip is non-streaming, so a round's text arrives as one delta.
//   - No images in v1: an attachment reaches the model only as the note that a file exists (no image_url parts).
//   - If the endpoint or model refuses `tools`, the turn degrades to no tools, with ONE warning, and `meta.degraded` is set so
//     the autonomous path (agent.ts) knows no action can have been taken.
import { AbortError, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSanctumConfig, internalBaseUrl, type FallbackConfig } from '../../config.js';
import { readOwnOrApp } from '../../tenancy/own-files.js';
import { childRunBase } from '../../tenancy/child.js';
import { getInternalToken } from '../../middleware/internal-token.js';
import { identityBlock } from '../identity/block.js';
import { assembleRollingHistory, conversationBlock, splitContextBlock } from '../rolling-history.js';
import { recallForPrompt, ingestTurn, MEMORY_HEADER } from '../revien.js';
import { mindRecallBlock } from '../mind-client.js';
import { chatTurn, rejectsTools, type ChatMessage, type ChatToolCall, type ChatTurnArgs } from './openai-compat.js';
import { offeredTools, toToolDef, toolUseName, type FallbackTool, type ToolCtx, type ToolGates } from './openai-compat-tools.js';

const SHIPPED_BASE = fileURLToPath(new URL('../../../../../prompts/fallback-base-prompt.md', import.meta.url));
/** The install's root (the same directory config.ts calls PROJECT_ROOT), without importing it: the tests mock config. */
const INSTALL_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/[\\/]+$/, '');
const TOOL_RESULT_CAP = 6000;

// ─── What this turn says about itself ─────────────────────────────────────────────────────────────────────────────────

export interface HarnessLineArgs { model: string; tools: string[]; noToolsWhy?: 'degraded' | 'read_only' | 'none_configured' }

/** The one line of the system prompt that states which harness is running and whether tools exist this turn. Never claims
 *  tools on a tool-less run. Exported so the tests and the docs quote the same words. */
export function harnessLine(a: HarnessLineArgs): string {
  const head = `[Harness] This turn runs on the fallback brain (openai-compat, model ${a.model || 'unset'}), not the primary harness.`;
  const noImages = ' You cannot see images: an attachment reaches you only as a note that a file exists.';
  if (a.tools.length > 0) {
    return `${head} Tools available this turn (${a.tools.length}): ${a.tools.join(', ')}. These functions are the only way to act on the app; if you did not call one, you did not do it, so never say you did.${noImages}`;
  }
  const why = a.noToolsWhy === 'degraded' ? ' (this model or endpoint does not support function calling)' : a.noToolsWhy === 'read_only' ? ' (this is a read-only run)' : '';
  return `${head} No tools are available this turn${why}: you cannot set timers, log meals, react, share files, change the app or read files. Say what you would have done instead of claiming you did it, and do not say you have tools.${noImages}`;
}

function readBase(): string {
  const cfg = getSanctumConfig();
  const home = join(cfg.agent.cwd, 'config', 'fallback-base-prompt.md');
  const f = existsSync(home) ? home : SHIPPED_BASE;
  try { return readOwnOrApp(f).trim(); } catch { return ''; }
}

// ─── Tool support (what the endpoint said, once) ──────────────────────────────────────────────────────────────────────

/** `base|model` pairs found not to support tools, so later turns do not keep asking. Process-wide, cleared by a restart. */
const noToolsFor = new Set<string>();
let warnedDegraded = false;
const supportsCache = new Map<string, { at: number; ok: boolean | null }>();
const SUPPORTS_TTL_MS = 6 * 3_600_000;

export function toolsDegraded(base?: string, model?: string): boolean {
  if (base === undefined) return noToolsFor.size > 0;
  return noToolsFor.has(`${base}|${model ?? ''}`);
}
/** Test hook. */
export function resetFallbackToolState(): void { noToolsFor.clear(); supportsCache.clear(); warnedDegraded = false; }

/** OpenRouter lists, per model, which request parameters it accepts (`supported_parameters`). null = unknown (not OpenRouter, or the
 *  list could not be read): then the harness simply tries `tools` and degrades if the endpoint refuses. */
async function listedAsToolCapable(base: string, model: string, key: string, headers: Record<string, string> | undefined, signal?: AbortSignal): Promise<boolean | null> {
  if (!/(^|\.)openrouter\.ai/i.test(new URL(base).host)) return null;
  const ck = `${base}|${model}`;
  const hit = supportsCache.get(ck);
  if (hit && Date.now() - hit.at < SUPPORTS_TTL_MS) return hit.ok;
  let ok: boolean | null = null;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${key}`, ...(headers ?? {}) }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    if (res.ok) {
      const j: any = await res.json();
      const m = Array.isArray(j?.data) ? j.data.find((x: any) => x?.id === model) : null;
      if (m && Array.isArray(m.supported_parameters)) ok = m.supported_parameters.includes('tools');
    }
  } catch { ok = null; }
  supportsCache.set(ck, { at: Date.now(), ok });
  return ok;
}

// ─── Running a tool ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ToolRun { content: string; isError: boolean }
export interface HarnessDeps {
  /** Run one tool call. Default: the same internal route `res` would call, over loopback with the internal token. */
  exec(tool: FallbackTool, args: Record<string, any>, ctx: ToolCtx, signal?: AbortSignal): Promise<ToolRun>;
}

const clip = (s: string): string => (s.length > TOOL_RESULT_CAP ? `${s.slice(0, TOOL_RESULT_CAP)}… [cut: ${s.length - TOOL_RESULT_CAP} more characters]` : s);

export async function execViaInternalRoute(tool: FallbackTool, args: Record<string, any>, ctx: ToolCtx, signal?: AbortSignal): Promise<ToolRun> {
  const req = tool.request(args, ctx);
  if ('error' in req) return { content: `Error: ${req.error}`, isError: true };
  const cfg = getSanctumConfig();
  const url = `${internalBaseUrl(cfg.server)}/api/internal/${req.route}`;
  const limit = AbortSignal.timeout(req.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'x-internal-token': getInternalToken() },
      ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? {}) } : {}),
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    const text = await res.text();
    let shown = text;
    try { shown = JSON.stringify(JSON.parse(text)); } catch { /* not JSON: as it came */ }
    if (!res.ok) return { content: clip(`Error: ${tool.name} → HTTP ${res.status} ${shown}`.trim()), isError: true };
    return { content: clip(shown || 'ok'), isError: false };
  } catch (e) {
    if (signal?.aborted) throw new AbortError('openai-compat turn aborted');
    return { content: (e as { name?: string })?.name === 'TimeoutError' ? `Error: ${tool.name} timed out` : `Error: ${tool.name} could not reach the app (${(e as Error)?.message ?? 'network'})`, isError: true };
  }
}

// ─── The Query ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the router and agent.ts read off a fallback run. */
export interface HarnessMeta { harness: 'openai-compat'; toolsOffered: number; toolsRun: number; degraded: boolean }

function systemText(sp: Options['systemPrompt']): string {
  if (!sp) return '';
  if (typeof sp === 'string') return sp;
  return (sp as any).append ?? '';
}

/** The orientation block is written for a harness that has Bash: its TOOLS list tells the model to run `node /abs/path/tools/res.mjs ...`
 *  and says tool activity shows in a sidebar. None of that is true on the fallback (the [Harness] line is the only tool statement
 *  there), and the path is the install's own. Drops every stanza of the [Context] block that mentions the res CLI (the short list
 *  and the full reference), the sidebar sentence and the "not set up" notes; keeps the rest (env, presence, EXPRESSION tags).
 *  Finally no absolute path of the install goes to a third-party endpoint. */
export function scrubFallbackContext(text: string): string {
  if (!text) return text;
  const stripCtx = (ctx: string): string => {
    const stanzas: string[][] = [];
    for (const line of ctx.split('\n')) {
      if (line === '' || /^\s/.test(line) || stanzas.length === 0) { if (stanzas.length) stanzas[stanzas.length - 1].push(line); else stanzas.push([line]); }
      else stanzas.push([line]);
    }
    const kept = stanzas.filter((st) => !(/^TOOLS \(run via Bash/.test(st[0]) || st.some((l) => /res\.mjs/.test(l)) || /^(Pictures|Voice): not set up/.test(st[0])));
    return kept.map((st) => st.join('\n')).join('\n').replace(/Tool activity \(tool_use\/tool_result\) shows live in the UI sidebar\.\s?/g, '');
  };
  let out = text.replace(/\[Context\][\s\S]*?\n\[\/Context\]/g, (m) => stripCtx(m));
  for (const root of new Set([INSTALL_ROOT, INSTALL_ROOT.replace(/\\/g, '/')])) if (root.length > 1) out = out.split(root).join('<app>');
  return out;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function openaiCompatQuery({ prompt, options }: { prompt: string | AsyncIterable<any>; options?: Options }, deps: Partial<HarnessDeps> = {}): Query {
  const opts = (options ?? {}) as Options;
  const exec = deps.exec ?? execViaInternalRoute;
  const signal = opts.abortController?.signal;
  const meta: HarnessMeta = { harness: 'openai-compat', toolsOffered: 0, toolsRun: 0, degraded: false };

  async function* run(): AsyncGenerator<any> {
    if (typeof prompt !== 'string') throw new Error('[openai-compat] streaming-input prompts are not supported');
    const cfg = getSanctumConfig();
    const fb: Partial<FallbackConfig> = cfg.agent.fallback ?? {};
    const baseUrl = (fb?.base_url ?? '').trim();
    const model = (fb?.model ?? '').trim();
    const keyVar = (fb?.api_key_env || 'FALLBACK_API_KEY').trim();
    const apiKey = childRunBase()[keyVar] ?? '';
    if (!baseUrl) throw new Error('agent.fallback.base_url is required for the fallback brain');
    if (!model) throw new Error('agent.fallback.model is required for the fallback brain');
    if (!apiKey) throw Object.assign(new Error(`the fallback key is not set: put ${keyVar} in .env`), { kind: 'api_key_missing' });

    const sanctum = (opts as any).sanctum as { threadId: string; userContent: string; autonomous?: boolean; noIngest?: boolean; /** agent.ts already put memory, history and [Current message] in the prompt (and ingests/compacts itself): use it as is. */ assembled?: boolean; memory?: 'none'; contextBlock?: string; disabledTools?: string[]; disabledServers?: string[] } | undefined;
    const threadId = sanctum?.threadId ?? '';
    const noMemory = sanctum?.memory === 'none';
    const readOnly = opts.permissionMode === 'plan' || (Array.isArray(opts.tools) && opts.tools.length === 0);
    const useMemory = !readOnly && !sanctum?.autonomous && !noMemory;
    const maxRounds = Math.max(1, Math.floor(num(fb.max_tool_turns) || 8));
    const maxTokens = Math.max(256, Math.floor(num(fb.max_output_tokens) || 4096));
    const sessionId = ''; // never the primary's session: agent.ts would overwrite the thread's resumable session with it

    // ── the tools this turn
    const disabledTools = new Set<string>([...((opts as any).disallowedTools ?? []), ...(sanctum?.disabledTools ?? [])]);
    const disabledServers = new Set<string>(sanctum?.disabledServers ?? []);
    const gates: ToolGates = { voice: !!cfg.voice?.enabled, image: !!cfg.imagegen && cfg.imagegen.provider !== 'none', cc: !!cfg.command_center?.enabled };
    const ctx: ToolCtx = { threadId, namespace: process.env.SANCTUM_NAMESPACE || process.env.RESONANT_NAMESPACE || 'companion' };
    let offered: FallbackTool[] = readOnly || !threadId ? [] : offeredTools(gates, disabledTools, disabledServers);
    let noToolsWhy: HarnessLineArgs['noToolsWhy'] = readOnly ? 'read_only' : offered.length === 0 ? 'none_configured' : undefined;
    if (offered.length > 0) {
      if (toolsDegraded(baseUrl, model)) { offered = []; noToolsWhy = 'degraded'; }
      else if (await listedAsToolCapable(baseUrl, model, apiKey, fb.headers, signal) === false) { offered = []; noToolsWhy = 'degraded'; noteDegraded('the model is not listed as supporting tools'); noToolsFor.add(`${baseUrl}|${model}`); }
    }
    meta.toolsOffered = offered.length;
    meta.degraded = noToolsWhy === 'degraded';

    // ── the system slot: the harness base, the identity, then this turn's one honest line about tools
    const system = (): string => {
      const parts = readOnly
        ? [systemText(opts.systemPrompt), harnessLine({ model, tools: [], noToolsWhy: 'read_only' })]
        : [readBase(), identityBlock('openai-compat'), harnessLine({ model, tools: offered.map((t) => t.name), noToolsWhy })];
      return parts.filter((x) => x && x.trim()).join('\n\n');
    };

    // ── the message: orientation, memory, summary, the thread's tail, the current message (the thread is the memory here)
    const assembled = !!sanctum?.assembled && !readOnly;
    const promptText = scrubFallbackContext(prompt);
    const contextText = sanctum?.contextBlock ? scrubFallbackContext(sanctum.contextBlock) : sanctum?.contextBlock;
    let memoryBlock = '';
    let mindBlock = '';
    if (useMemory && !assembled) {
      const [memory, mind] = await Promise.all([recallForPrompt(sanctum?.userContent ?? prompt, sanctum?.threadId), mindRecallBlock(sanctum?.userContent ?? prompt)]);
      if (memory) memoryBlock = `${MEMORY_HEADER}\n${memory}`;
      mindBlock = mind;
    }
    let input = promptText;
    let rolling: Awaited<ReturnType<typeof assembleRollingHistory>>['rolling'] | undefined;
    if (assembled) {
      // the prompt is the whole conversation already (context, memory, summary, history, one [Current message]): nothing to add
    } else if (!readOnly && !noMemory && sanctum?.threadId) {
      const history = await assembleRollingHistory(threadId, sanctum.userContent, !!sanctum.autonomous, { force: true, named: true });
      rolling = history.rolling;
      const { context, message } = splitContextBlock(promptText, contextText);
      input = [context, memoryBlock, mindBlock, history.summary, history.notice, conversationBlock(history.lines), `[Current message]\n${message}`].filter(Boolean).join('\n\n');
    } else if (readOnly) {
      const brief = systemText(opts.systemPrompt);
      input = brief ? `[System]\n${brief}\n[/System]\n\n${promptText}` : promptText;
    }

    const messages: ChatMessage[] = [{ role: 'system', content: system() }, { role: 'user', content: input }];
    const usage = { in: 0, out: 0 };
    let last = { in: 0, out: 0 };
    let lastText = '';
    let ended = false;

    yield { type: 'system', subtype: 'init', session_id: sessionId, model, tools: offered.map((t) => toolUseName(t.name)) };

    const turnArgs = (withTools: boolean): ChatTurnArgs => ({
      baseUrl, apiKey, model, messages, maxTokens, signal, headers: fb.headers,
      ...(withTools && offered.length ? { tools: offered.map(toToolDef) } : {}),
    });

    async function fireHooks(event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', input: Record<string, unknown>, id: string): Promise<string | null> {
      let denied: string | null = null;
      for (const matcher of (opts.hooks?.[event] ?? []) as any[]) {
        for (const cb of matcher.hooks ?? []) {
          try {
            const out: any = await cb({ hook_event_name: event, session_id: sessionId, cwd: opts.cwd ?? '', transcript_path: '', ...input }, id, { signal: new AbortController().signal });
            if (event === 'PreToolUse' && out?.hookSpecificOutput?.permissionDecision === 'deny') denied = String(out.hookSpecificOutput.permissionDecisionReason ?? 'denied by a guard');
          } catch (err) {
            console.warn(`[openai-compat] ${event} hook failed:`, err instanceof Error ? err.message : err);
          }
        }
      }
      return denied;
    }

    function* textBlock(text: string) {
      yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', content_block: { type: 'text' } } };
      yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
      yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_stop' } };
    }

    /** One round trip. A refusal of `tools` degrades the turn (once) and asks again without them. */
    async function round(withTools: boolean) {
      try {
        return await chatTurn(turnArgs(withTools));
      } catch (err) {
        if (signal?.aborted) throw new AbortError('openai-compat turn aborted');
        if (withTools && offered.length && rejectsTools(err)) {
          noteDegraded('the endpoint rejected the tools parameter');
          noToolsFor.add(`${baseUrl}|${model}`);
          offered = []; noToolsWhy = 'degraded'; meta.toolsOffered = 0; meta.degraded = true;
          messages[0] = { role: 'system', content: system() };
          return await chatTurn(turnArgs(false));
        }
        throw err;
      }
    }

    for (let r = 1; r <= maxRounds + 1; r++) {
      const wrapUp = r === maxRounds + 1; // the tool turns are spent: one last answer, no tools
      const out = await round(!wrapUp);
      usage.in += num(out.usage?.promptTokens); usage.out += num(out.usage?.completionTokens);
      last = { in: num(out.usage?.promptTokens), out: num(out.usage?.completionTokens) };
      const calls = wrapUp || !offered.length ? [] : out.toolCalls;
      if (out.text) {
        lastText = out.text;
        yield* textBlock(out.text);
      }
      const content: any[] = out.text ? [{ type: 'text', text: out.text }] : [];
      const parsed = calls.map((c) => ({ call: c, args: parseArgs(c) }));
      for (const p of parsed) content.push({ type: 'tool_use', id: p.call.id, name: toolUseName(p.call.function.name), input: p.args.value ?? {} });
      if (content.length) yield { type: 'assistant', session_id: sessionId, message: { role: 'assistant', content } };
      if (calls.length === 0) { ended = true; break; }

      messages.push({ role: 'assistant', content: out.text || null, tool_calls: calls });
      for (const { call, args } of parsed) {
        const tool = offered.find((t) => t.name === call.function.name);
        const useName = toolUseName(call.function.name);
        let result: ToolRun;
        if (!tool) {
          result = { content: `Error: ${call.function.name} is not an available tool this turn. Available: ${offered.map((t) => t.name).join(', ') || 'none'}.`, isError: true };
        } else if (args.error) {
          result = { content: `Error: ${args.error}`, isError: true };
        } else {
          const denied = await fireHooks('PreToolUse', { tool_name: useName, tool_input: args.value, tool_use_id: call.id }, call.id);
          result = denied !== null ? { content: `Error: not allowed: ${denied}`, isError: true } : await exec(tool, args.value ?? {}, ctx, signal);
          if (denied === null) meta.toolsRun++;
        }
        yield { type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: result.content, is_error: result.isError }] } };
        if (tool && !args.error) {
          if (result.isError) await fireHooks('PostToolUseFailure', { tool_name: useName, tool_input: args.value, tool_use_id: call.id, error: result.content }, call.id);
          else await fireHooks('PostToolUse', { tool_name: useName, tool_input: args.value, tool_use_id: call.id, tool_response: result.content }, call.id);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
      }
      if (signal?.aborted) throw new AbortError('openai-compat turn aborted');
    }

    const sealedText = lastText;
    yield {
      type: 'result', subtype: ended || sealedText ? 'success' : 'error_max_turns', session_id: sessionId, result: sealedText,
      usage: { input_tokens: last.in, output_tokens: last.out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(usage.in || usage.out ? {} : { unavailable: true }) },
      context_tokens: last.in + last.out,
      spend: { input_tokens: usage.in, output_tokens: usage.out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    if (ended || sealedText) {
      if (useMemory && !assembled && !sanctum?.noIngest && sealedText) void ingestTurn({ threadId: threadId, user: sanctum?.userContent ?? prompt, assistant: sealedText });
      if (rolling) { try { void Promise.resolve(rolling.maybeCompact(threadId)).catch(() => {}); } catch { /* ignore */ } }
    }
  }

  const gen = run();
  return Object.assign(gen, {
    meta,
    interrupt: async () => { opts.abortController?.abort(); },
    mcpServerStatus: async () => [],
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedCommands: async () => [],
    supportedModels: async () => [],
  }) as unknown as Query;
}

function parseArgs(c: ChatToolCall): { value: Record<string, any>; error?: undefined } | { value?: undefined; error: string } {
  const raw = c.function.arguments;
  if (!raw || !raw.trim()) return { value: {} };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v } : { error: 'arguments must be a JSON object' };
  } catch { return { error: 'arguments were not valid JSON' }; }
}

/** ONE warning per process, however many turns hit it. */
function noteDegraded(why: string): void {
  if (warnedDegraded) return;
  warnedDegraded = true;
  console.warn(`[openai-compat] the fallback brain runs WITHOUT tools: ${why}. It can talk but cannot act (no timers, meals, reactions, files); autonomous turns on it are skipped. Pick a model with function calling (agent.fallback.model).`);
}
