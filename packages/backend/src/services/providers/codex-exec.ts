// Unlogged Codex runner. Spawns `codex exec --ephemeral` directly so a turn
// leaves no Codex session behind: in rolling-context mode the app owns the
// history, and Codex is handed a fresh prompt every time. Emits the same JSONL
// event objects the SDK does (thread.started, item.*, turn.*, error).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { childEnv } from './child-env.js';
import { childRunBase } from '../../tenancy/child.js';
import { tenancyEnabled } from '../../tenancy/context.js';

export interface ExecParams {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  cwd: string;
  additionalDirectories?: string[];
  model?: string;
  /** A [model_providers.*] key from ~/.codex/config.toml; undefined = Codex's default provider. */
  modelProvider?: string;
  /** Codex's own "memories" feature. Set explicitly every run (false unless the
   *  person chose it as THE memory) so a config.toml setting never leaks into a
   *  run that has its own memory riding in the prompt. */
  harnessMemory?: boolean;
  networkAccess: boolean;
  /** model_instructions_file (base prompt) path; '' / undefined = stock Codex. */
  baseFile?: string;
  effort?: string;
  /** Codex-format MCP table: name → { command, args, env } | { url }. */
  mcp?: Record<string, any>;
  /** Skip AGENTS.md discovery in the working folder (the summarizer wants no
   *  law and no identity). Note: a global ~/.codex/AGENTS.md is still loaded
   *  by Codex regardless; there is no per-run switch for it. */
  noProjectDocs?: boolean;
}

// JSON.stringify output is a valid TOML basic string / array of basic strings.
const toml = (v: string) => JSON.stringify(v);
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

export function buildExecArgs(p: ExecParams): string[] {
  const args = ['exec', '--experimental-json', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', p.sandboxMode, '--cd', p.cwd];
  for (const d of p.additionalDirectories ?? []) args.push('--add-dir', d);
  if (p.model) args.push('--model', p.model);
  const cfg = (kv: string) => args.push('--config', kv);
  if (p.modelProvider) cfg(`model_provider=${toml(p.modelProvider)}`);
  cfg(`features.memories=${p.harnessMemory ? 'true' : 'false'}`);
  cfg('approval_policy="never"');
  cfg(`sandbox_workspace_write.network_access=${p.networkAccess ? 'true' : 'false'}`);
  if (tenancyEnabled()) cfg('sandbox_workspace_write.exclude_slash_tmp=true'); // D7: the tenant's TMPDIR (writable) is its temp root, /tmp is no one's
  if (p.baseFile) cfg(`model_instructions_file=${toml(p.baseFile)}`);
  if (p.effort) cfg(`model_reasoning_effort=${toml(p.effort)}`);
  if (p.noProjectDocs) cfg('project_doc_max_bytes=0');
  for (const [name, s] of Object.entries(p.mcp ?? {})) {
    const key = `mcp_servers.${tomlKey(name)}`;
    if (s.command) {
      cfg(`${key}.command=${toml(s.command)}`);
      cfg(`${key}.args=[${(s.args ?? []).map((a: unknown) => toml(String(a))).join(', ')}]`);
      const env = Object.entries(s.env ?? {});
      if (env.length) cfg(`${key}.env={ ${env.map(([k, v]) => `${tomlKey(k)} = ${toml(String(v))}`).join(', ')} }`);
    } else if (s.url) {
      cfg(`${key}.url=${toml(s.url)}`);
    }
  }
  args.push('-'); // prompt from stdin
  return args;
}

/** The environment the codex child gets: ours, minus the backend's own secrets. */
export const codexChildEnv = (base: NodeJS.ProcessEnv = childRunBase()): NodeJS.ProcessEnv => childEnv(base);

export async function* runCodexExec(p: ExecParams & { prompt: string; signal?: AbortSignal }): AsyncGenerator<any> {
  const codexBinJs = join(dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json')), 'bin', 'codex.js');
  const base = childRunBase();
  const env: NodeJS.ProcessEnv = childEnv(base);
  if (base.OPENAI_API_KEY) env.CODEX_API_KEY = base.OPENAI_API_KEY;

  const child = spawn(process.execPath, [codexBinJs, ...buildExecArgs(p)], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', (err) => { stderr += `\n${err.message}`; resolve(-1); });
  });
  const kill = () => { if (child.exitCode === null && !child.killed) child.kill(); };
  p.signal?.addEventListener('abort', kill, { once: true });
  if (p.signal?.aborted) kill();

  child.stdin.on('error', () => { /* child died early; exit code reports it */ });
  child.stdin.end(p.prompt);

  try {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let turnCompleted = false;
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let ev: any;
      try { ev = JSON.parse(t); } catch { continue; } // stray non-JSON stdout line
      if (ev?.type === 'turn.completed') turnCompleted = true;
      yield ev;
    }
    const code = await exited;
    // A stop is reported by the caller (it holds the signal). A bad exit code
    // after the turn already completed is noise: the reply is whole, keep it.
    if (code !== 0 && !p.signal?.aborted) {
      if (turnCompleted) console.warn(`[codex-exec] exited with code ${code} after a completed turn; keeping the reply`);
      else throw new Error(`codex exec exited with code ${code}: ${stderr.slice(-400)}`);
    }
  } finally {
    p.signal?.removeEventListener('abort', kill);
    kill();
  }
}
