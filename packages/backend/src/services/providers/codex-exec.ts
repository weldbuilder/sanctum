// Unlogged Codex runner. Spawns `codex exec --ephemeral` directly so a turn
// leaves no Codex session behind: in rolling-context mode the app owns the
// history, and Codex is handed a fresh prompt every time. Emits the same JSONL
// event objects the SDK does (thread.started, item.*, turn.*, error).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { childEnv } from './child-env.js';
import { childRunBase } from '../../tenancy/child.js';
import { tenancyEnabled, tenantTmpRoot } from '../../tenancy/context.js';
import { getSanctumConfig } from '../../config.js';
import { ownAssertReal, ownUnlink, ownWriteFileAtomic } from '../../tenancy/own-files.js';

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
  /** developer_instructions: text Codex prepends to its developer message while KEEPING its stock prompt. Used for the identity when
   *  there is no base file; with a base file the identity is inside that file instead. */
  developerInstructions?: string;
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
  if (p.developerInstructions) cfg(`developer_instructions=${toml(p.developerInstructions)}`);
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

/** Codex only takes base instructions as a file (model_instructions_file). Write the combined text (the harness base, then the
 *  identity) once under a content-hash name and return the path; the same text reuses the same file, and an edit makes a new path.
 *  The folder is <dataDir>/harness/codex-base in every mode (dataDir: the tenant's, else the folder of server.db_path), never a temp
 *  folder: the sandboxed child can write its TMPDIR and Codex's default workspace-write roots, and must not be able to rewrite its own
 *  identity file. In tenant mode it is a SIBLING of the tenant's TMPDIR (harness/tmp). It stays readable by the child (no read roots
 *  are configured in buildExecArgs; workspace-write reads are unrestricted).
 *  The folder is made 0700 and an existing one is refused unless it is a real folder (not a link) owned by this user with no group or
 *  world bits. An existing file is never trusted on its name: it is lstat'ed first (anything but a regular file with one link is refused:
 *  a link, a FIFO, a socket, a folder), opened with O_NOFOLLOW|O_NONBLOCK, checked again on the open handle, then read back and rewritten
 *  when it differs. It is never read by path with readFileSync (a FIFO planted there would hang the event loop). Written to a temp name in
 *  the same folder then renamed, so a partial file never sits at the final path. A new hash also prunes the folder's other *.md older
 *  than an hour. */
const PRUNE_AFTER_MS = 60 * 60 * 1000;
const isWin = process.platform === 'win32';

export function codexBaseDir(): string {
  const root = tenantTmpRoot();
  return root ? join(dirname(root), 'codex-base') : join(dirname(getSanctumConfig().server.db_path), 'harness', 'codex-base');
}

function refuse(what: string): never { throw new Error(`[codex] the identity folder is not safe to use: ${what}`); }

/** The folder must be a real folder, ours, owner-only. (Windows has no uid or mode bits to check.) */
function assertOwnFolder(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) refuse(`${basename(dir)} is not a folder (or is a link)`);
  if (isWin) return;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) refuse(`${basename(dir)} belongs to another user`);
  if (st.mode & 0o077) refuse(`${basename(dir)} is open to the group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 700 it`);
}

/** The text of the file at `f`, null when there is none; throws on anything that is not a plain regular file with one link. */
function readRegular(f: string): string | null {
  let st;
  try { st = lstatSync(f); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  if (!st.isFile() || st.nlink !== 1) refuse(`${basename(f)} is not a plain file (a link, pipe, socket or folder), or has a second hard link`);
  const fd = openSync(f, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const h = fstatSync(fd);
    if (!h.isFile() || h.nlink !== 1 || h.dev !== st.dev || h.ino !== st.ino) refuse(`${basename(f)} changed while it was being read`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function prune(dir: string, keep: string, ownUnlinkOpts: { process: boolean }): void {
  try {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!name.endsWith('.md') || p === keep) continue;
      try { if (lstatSync(p).mtimeMs < cutoff) ownUnlink(p, ownUnlinkOpts); } catch { /* gone, or not ours to remove: leave it */ }
    }
  } catch { /* a folder that cannot be listed is not worth a failed turn */ }
}

export function materializeBaseInstructions(text: string): string {
  const root = tenantTmpRoot();
  const dir = codexBaseDir();
  if (root) ownAssertReal(dir); // (a linked path component is refused BEFORE anything is made)
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (root) ownAssertReal(dir);
  assertOwnFolder(dir);
  const f = join(dir, `${createHash('sha256').update(text).digest('hex').slice(0, 24)}.md`);
  if (root) ownAssertReal(f);
  if (readRegular(f) === text) return f;
  try { ownWriteFileAtomic(f, text, { mode: 0o600, process: !root }); }
  catch (e) { let now: string | null = null; try { now = readRegular(f); } catch { /* the first error is the news */ } if (now === text) return f; throw e; } // (Windows: rename onto an identical file; outside a tenant it is the process-level write)
  prune(dir, f, { process: !root });
  return f;
}
