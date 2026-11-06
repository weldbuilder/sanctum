// DeepSeek Harness (dsh) runner. Spawns `dsh headless --json` and yields its
// NDJSON run events (session, status, thinking, text, tool_call, tool_result,
// final). The CLI surface and the patch-overlay syntax below were checked
// against @deepseek-ai/dsh 0.2.1-alpha.2 (`--dump-config`); the model call
// itself needs a provider key and has not been exercised. See docs/DSH.md.
//
// Per-run configuration is a YAML patch overlay (`--patch <file>`) plus env.
// A patch entry that matches an existing id REPLACES that entry's whole config,
// so each overlay row below states everything it needs.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { ownAssertReal, ownMkdirAsync, ownRmAsync, ownWriteFileAsync } from '../../tenancy/own-files.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DSH_BASE_ROW_IDS, pluginRows, type PluginRunKind } from '../plugins.js';
import { routeKeyVar } from './dsh-key.js';
import { ENV_ALLOW, childRunBase } from '../../tenancy/child.js';
import { tenancyEnabled, tenantTmpRoot } from '../../tenancy/context.js';

export interface DshExecParams {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  cwd: string;
  /** The dsh executable; '' / undefined = `dsh` on PATH. */
  command?: string;
  /** DSH_HOME for this companion; '' / undefined = dsh's own default. NEVER used by a sealed run: dsh applies the
   *  home's cordis.patch.yml (and the headless profile's) before the overlay, and loads its .env, so a sealed run gets a
   *  pristine empty home of its own inside the run's temp root. */
  home?: string;
  model?: string;
  /** A dsh llm route name; undefined = dsh's default route (deepseek-official). */
  modelProvider?: string;
  /** Env var holding the route's API key (only used with modelProvider). */
  apiKeyEnv?: string;
  /** Endpoint for an OpenAI-compatible gateway route (only used with modelProvider). */
  baseUrl?: string;
  effort?: string;
  /** Base prompt TEXT (the persona). '' / undefined = dsh's stock headless persona. */
  basePrompt?: string;
  /** Claude-format MCP servers: stdio { command, args, env } or http { url, headers }. */
  mcp?: Record<string, any>;
  /** Resume this dsh session (`--session-id`). Omit for a fresh run. */
  sessionId?: string;
  /** Do not leave a session behind: the overlay points session persistence at a
   *  throwaway directory that is removed after the run. dsh has no --ephemeral. */
  ephemeral?: boolean;
  /** Skip AGENTS.md discovery (dsh-agent-instructions off). The summarizer wants no law and no identity. */
  noProjectDocs?: boolean;
  /** Which kind of run this is, for plugin rows: a conversation turn, an autonomous wake,
   *  a read-only helper (digest, handoff, outlook) or the rolling summarizer. Unset = no plugin rows. */
  runKind?: PluginRunKind;
  /** The thread this run belongs to, passed to plugins ('' when there is none). */
  threadId?: string;
  /** Whether the person behind this run is the owner. Unset = the loader's default: true for
   *  wake/helper/summarizer runs, false for a turn (resolveSenderIsOwner). Passed to plugins as
   *  `sanctum.senderIsOwner`. */
  senderIsOwner?: boolean;
  /** The public lane's run: NO tool, no MCP server, no plugin, no AGENTS.md, no skills or commands, read-only whatever
   *  sandboxMode says (buildOverlay's `sealed` block). `tools: []` and `maxTurns` are Claude options that dsh ignores, and
   *  its read-only mode only blocks writes: a run that is merely read-only still has bash, read and web_fetch. */
  sealed?: boolean;
  /** Stop the run, killing the child, when a model step beyond this many begins (dsh ignores maxTurns). A model that
   *  calls a tool that does not exist gets a tool error and would otherwise go round again. Unset = no limit. */
  maxSteps?: number;
  /** Overall wall-clock limit for the run; default 30 minutes. */
  timeoutMs?: number;
  /** After SIGTERM, how long before SIGKILL; default 1000. */
  killGraceMs?: number;
  /** How long a child may linger after printing `final` before it is killed; default 3000. */
  exitGraceMs?: number;
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const warnedMcp = new Set<string>();

/** dsh interpolates `{{name}}` in persona text and fails assembly on an unknown
 *  one. A base prompt is prose, not a template, so break up every `{{`: each `{`
 *  that is followed by another `{` gets a space after it (`{{{x}}}` -> `{ { {x}}}`). */
export function defangTemplate(text: string): string {
  return text.replace(/\{(?=\{)/g, '{ ');
}

/** The rows of dsh's base composition (DSH_BASE_ROW_IDS, services/plugins.ts) a sealed run turns off: everything that
 *  provides a tool or reaches outside the run. Matched against the committed list, so a row a dsh upgrade adds to the
 *  list under one of these names is off from the first run, and the test that walks the list fails if one is missed.
 *  Against dsh 0.2.1-alpha.2 (`--dump-config`, a fake model logging the tool list) this leaves the model ZERO tools. */
const SEALED_OFF: RegExp[] = [
  /^tool-/, // tool-bash, -pwsh, -jobs, -fs, -fs-search, -skill, -subagent*, -workflow, -web, -todo, -goal, -working-directory, ...
  /^web$/, /^web-search-deepseek$/, /^web-fetch-http$/, /^mcp-resources$/,
  /^subagent/, /^workflow-ptc$/, /^ptc-runtime$/, /^plan-mode$/,
  /^skill$/, /^skill-filesystem$/,
  /^agent-instructions$/, // no AGENTS.md in public
  /^commands$/, /^command-/,
];
export const sealedOffRows = (): string[] => [...DSH_BASE_ROW_IDS].filter((id) => SEALED_OFF.some((re) => re.test(id))).sort();

/** The overlay as a patch list. JSON is valid YAML, so it is written as JSON. */
export function buildOverlay(p: DshExecParams, ephemeralRoot?: string): any[] {
  const rows: any[] = [];
  // A sealed run is read-only whatever was asked for.
  if (p.sealed) p = { ...p, sandboxMode: 'read-only', mcp: undefined, runKind: undefined };
  // Approvals are off by default (contract): policy `never` rejects anything that
  // would have asked, deterministically, instead of failing closed on a missing
  // answerer. Wakes and conversation turns alike.
  rows.push({ id: 'approval', config: { policy: 'never' } });
  // The shipped presets pair read-only and workspace-write with `ask`; with the
  // policy above they match no preset and the permission plugin fails to load
  // (a warning on stderr every run). Pair every sandbox mode with `never`.
  rows.push({
    id: 'permission',
    config: {
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'never' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'never' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
      defaultPreset: p.sandboxMode,
    },
  });
  // dsh makes a second, hidden model call per run to title the session. Nothing reads the title.
  rows.push({ id: 'session-title-llm', disabled: true });
  if (p.sealed) for (const id of sealedOffRows()) rows.push({ id, disabled: true });
  else if (p.noProjectDocs) rows.push({ id: 'agent-instructions', disabled: true });
  if (p.basePrompt && p.basePrompt.trim()) {
    rows.push({ id: 'system-prompt', config: { includeHarnessIdentity: false, personaPrefix: defangTemplate(p.basePrompt.trim()) } });
  }
  if (p.model || p.modelProvider) {
    const cfg: Record<string, any> = { provider: p.modelProvider || 'deepseek-official', model: p.model || 'deepseek-flash' };
    if (p.effort) cfg.reasoningEffort = p.effort;
    rows.push({ id: 'agent-default-model', config: cfg });
  }
  if (p.modelProvider && p.modelProvider !== 'deepseek-official') {
    const route: Record<string, any> = {};
    if (p.apiKeyEnv) route.apiKeyEnv = p.apiKeyEnv;
    // pi-ai applies baseURL to a route it already knows (openai, anthropic, openrouter, ...).
    // A gateway pi-ai has never heard of also needs `api` and `models`, which this does not write.
    if (p.baseUrl) route.baseURL = p.baseUrl;
    rows.push({ id: 'llm-pi-ai', config: { providers: { [p.modelProvider]: route } } });
  }
  if (ephemeralRoot) {
    // Everything dsh persists for a session: the log, and the projection cache
    // under storages/ (which holds the first prompt, i.e. recalled memory and the conversation).
    rows.push({ id: 'session-persistence-jsonl', config: { root: join(ephemeralRoot, 'sessions') } });
    rows.push({ id: 'storage-json', config: { root: join(ephemeralRoot, 'storages') } });
  }
  const mcpRows: any[] = [];
  for (const [name, s] of Object.entries(p.mcp ?? {})) {
    if (!SERVER_NAME.test(name)) {
      if (!warnedMcp.has(name)) {
        warnedMcp.add(name);
        console.warn(`[dsh] MCP server "${name}" skipped: dsh only accepts names of 1-32 letters, digits, _ and -. Rename it in .mcp.json to use it.`);
      }
      continue;
    }
    const srv = s as any;
    if (srv.command) {
      mcpRows.push({
        id: `mcp-${name}`, name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: name, transport: 'stdio', command: srv.command, args: srv.args ?? [], ...(srv.env && { env: srv.env }) },
      });
    } else if (srv.url) {
      mcpRows.push({
        id: `mcp-${name}`, name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: name, transport: 'streamable-http', url: srv.url, ...(srv.headers && { headers: srv.headers }) },
      });
    } // in-process SDK servers have no dsh equivalent: skipped
  }
  if (mcpRows.length) rows.push({ insert: mcpRows });
  // Plugin rows go last, after the MCP rows. With no plugin installed for this run
  // kind nothing is appended, so the overlay is exactly what it was before plugins.
  if (p.runKind) {
    const plugin = pluginRows({ harness: 'dsh', runKind: p.runKind, threadId: p.threadId ?? '', senderIsOwner: p.senderIsOwner });
    if (plugin.length) rows.push({ insert: plugin });
  }
  return rows;
}

export function buildExecArgs(p: DshExecParams, patchFile: string): string[] {
  const args = ['--profile', 'headless', '--patch', patchFile];
  if (p.sessionId && !p.sealed) args.push('--session-id', p.sessionId);
  args.push('--json', '-'); // task from stdin
  return args;
}


/** The child's environment is an allowlist, not a copy of ours: the backend's own
 *  secrets (app password, other providers' keys) never reach dsh or its tools.
 *  Inherited DSH_* is dropped; the adapter sets the ones it means. */
export function buildExecEnv(p: DshExecParams, base: NodeJS.ProcessEnv = process.env, tmpdir?: string, sealedHome?: string, sealedCwd?: string): NodeJS.ProcessEnv {
  if (p.sealed && !sealedHome) throw new Error('dsh: a sealed run needs a DSH_HOME of its own (it never uses the person\'s)');
  const env: NodeJS.ProcessEnv = {};
  const keyVar = routeKeyVar(p);
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (ENV_ALLOW.has(k) || k.startsWith('LC_') || (keyVar && k === keyVar)) env[k] = v;
  }
  if (tmpdir) env.TMPDIR = tmpdir; // dsh spills large tool output here; the run's temp root is deleted afterwards
  env.DSH_TELEMETRY_MODE = 'DISABLED'; // every run: removes the upload path entirely
  env.DSH_PERMISSION_MODE = p.sealed ? 'read-only' : p.sandboxMode;
  if (p.sealed) {
    env.DSH_HOME = sealedHome; // pristine and empty: dsh makes the headless profile there; no user patch, no .env, no credentials
    if (sealedCwd) { env.HOME = sealedCwd; if (env.USERPROFILE !== undefined) env.USERPROFILE = sealedCwd; } // not the person's home folder
  } else if (p.home) env.DSH_HOME = p.home;
  return env;
}

/** buildExecEnv drops inherited DSH_*; in tenant mode the tenant's DSH_HOME (child.ts, D2) is the home when the config names none. */
function tenantHome(p: DshExecParams, base: NodeJS.ProcessEnv): DshExecParams {
  return tenancyEnabled() && !p.sealed && !p.home && base.DSH_HOME ? { ...p, home: base.DSH_HOME } : p;
}

export async function* runDshExec(p: DshExecParams & { prompt: string; signal?: AbortSignal }): AsyncGenerator<any> {
  // A sealed run works in a folder of its own inside the run root (below), so p.cwd is never read, entered or named to the model.
  if (!p.sealed && (!existsSync(p.cwd) || !statSync(p.cwd).isDirectory())) {
    throw new Error(`dsh: working directory does not exist: ${p.cwd}`);
  }
  // The temp root holds the overlay (which carries MCP headers), the run's TMPDIR,
  // and, for throwaway runs, the session log and storage. It is always removed.
  const tmpRoot = tenantTmpRoot();
  if (tmpRoot) ownAssertReal(tmpRoot); // (a tenant's temp root that became a link is refused, never written into)
  const dir = await mkdtemp(join(tmpRoot ?? tmpdir(), 'sanctum-dsh-')); // (tenant mode: the tenant's own TMPDIR, D7)
  let child: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const kill = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (!killTimer) {
      killTimer = setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, p.killGraceMs ?? 1000);
      killTimer.unref?.();
    }
  };
  const onAbort = () => kill();
  try {
    const tmp = join(dir, 'tmp');
    await ownMkdirAsync(tmp, { recursive: true });
    // Sealed: DSH_HOME is NOT created (dsh makes the profile there itself) and the cwd is an empty folder, both in the root
    // that is removed below. dsh puts its cwd in the prompt ("Current working directory: ..."), so it must not be the data folder.
    const sealedHome = p.sealed ? join(dir, 'dsh-home') : undefined;
    const runCwd = p.sealed ? join(dir, 'public') : p.cwd;
    if (p.sealed) await ownMkdirAsync(runCwd, { recursive: true, mode: 0o700 });
    const patchFile = join(dir, 'overlay.yml');
    // A sealed run always leaves nothing behind.
    await ownWriteFileAsync(patchFile, JSON.stringify(buildOverlay(p, p.ephemeral || p.sealed ? dir : undefined)), { mode: 0o600 });

    const base = childRunBase();
    child = spawn(p.command || 'dsh', buildExecArgs(p, patchFile), {
      cwd: runCwd, env: buildExecEnv(tenantHome(p, base), base, tmp, sealedHome, p.sealed ? runCwd : undefined), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    const exited = new Promise<number | null>((resolve) => {
      child!.once('exit', (code) => resolve(code));
      child!.once('error', (err) => { stderr += `\n${err.message}`; resolve(-1); });
    });
    p.signal?.addEventListener('abort', onAbort, { once: true });
    if (p.signal?.aborted) kill();
    let timedOut = false;
    const limit = p.timeoutMs ?? 30 * 60_000;
    timer = setTimeout(() => { timedOut = true; kill(); }, limit);

    child.stdin!.on('error', () => { /* child died early; exit code reports it */ });
    child.stdin!.end(p.prompt);

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let reported = false; // the run said how it ended (turn_end / final / error event)
    let steps = 0;
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let ev: any;
      try { ev = JSON.parse(t); } catch { continue; } // stray non-JSON stdout line
      // dsh ignores maxTurns. A model step beyond the limit never gets to run: the child is killed the moment it
      // begins one (nothing it would say or do is read), and the stream ends saying why.
      if (p.maxSteps !== undefined && ev?.type === 'status' && ev.phase === 'step_start' && ++steps > p.maxSteps) {
        reported = true;
        kill();
        yield { type: 'status', phase: 'turn_end', turn: ev.turn, reason: { kind: 'max_turns' } };
        break;
      }
      if ((ev?.type === 'status' && ev.phase === 'turn_end') || ev?.type === 'final' || ev?.type === 'error') reported = true;
      // A child that has said `final` but never exits is killed after a short grace.
      if (ev?.type === 'final' && !graceTimer) graceTimer = setTimeout(kill, p.exitGraceMs ?? 3000);
      yield ev;
    }
    const code = await exited;
    if (timedOut && !p.signal?.aborted) throw new Error(`dsh timed out after ${limit}ms`);
    // dsh exits 1 after a turn_end carrying an error: that failure already came
    // through as an event, so only a run that never said how it ended throws.
    if (code !== 0 && !p.signal?.aborted && !reported) {
      throw new Error(`dsh exited with code ${code}: ${stderr.slice(-400)}`);
    }
  } finally {
    p.signal?.removeEventListener('abort', onAbort);
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    kill();
    // Give a SIGTERM-ignoring child its SIGKILL before the temp root goes.
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, (p.killGraceMs ?? 1000) + 500);
        child!.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    if (killTimer) clearTimeout(killTimer);
    await ownRmAsync(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The rolling-context summarizer on dsh: one ephemeral, read-only run with AGENTS.md
 *  discovery off (no law, no identity), as `noProjectDocs` does on Codex. */
export async function runDshSummarizer(o: {
  prompt: string; baseFile: string; dir: string; signal: AbortSignal; model?: string;
  /** The base prompt TEXT (the summarizer's system slot); wins over baseFile. */
  basePrompt?: string;
  /** A dsh llm route name; '' / undefined = the configured agent.dsh.model_provider. */
  route?: string;
}): Promise<{ text: string; error?: string; engine?: string }> {
  const { getSanctumConfig } = await import('../../config.js');
  const { existsSync } = await import('node:fs');
  const { readOwnOrApp } = await import('../../tenancy/own-files.js');
  const dx = getSanctumConfig().agent.dsh;
  let text = '';
  let failure = '';
  for await (const ev of runDshExec({
    prompt: o.prompt, signal: o.signal, sandboxMode: 'read-only', cwd: o.dir, ephemeral: true, noProjectDocs: true, runKind: 'summarizer',
    command: dx.command, home: dx.home, model: o.model, modelProvider: o.route || dx.model_provider || undefined,
    apiKeyEnv: dx.api_key_env || undefined, baseUrl: dx.base_url || undefined,
    basePrompt: o.basePrompt ?? (o.baseFile && existsSync(o.baseFile) ? readOwnOrApp(o.baseFile) : ''),
  })) {
    if (ev?.type === 'text' && typeof ev.text === 'string') text += (text ? '\n\n' : '') + ev.text;
    else if (ev?.type === 'final' && typeof ev.text === 'string' && ev.text) text = ev.text;
    else if (ev?.type === 'status' && ev.phase === 'turn_end' && ev.reason?.kind === 'error') failure = ev.reason.error?.message || 'turn failed';
  }
  if (failure && !text) return { text: '', error: failure };
  return { text, engine: 'dsh' };
}
