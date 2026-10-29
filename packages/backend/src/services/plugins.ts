// Plugin loader (docs/PLUGINS.md). A plugin is a folder with a sanctum.plugin.json
// manifest that contributes some of: dsh rows (agent side), Express routes (app
// side), a `res help` topic, and a ui tab.
//
// Nothing here executes plugin code on load. loadPlugins() reads and validates
// manifests (JSON) only. A plugin's routes.mjs is imported on the first request
// to its routes; a plugin's dsh entry is only ever named by absolute path in a
// run's overlay, and dsh (a separate process) loads it.
//
// Two trust modes (plugins.trust, docs/PLUGINS.md):
//  - 'companion' (the default): the companion manages plugins. Enabled plugins run from their LIVE
//    folder; nothing is ratified, no containment or full-access refusal applies. What the app still
//    protects is its own correctness: a manifest path that resolves outside its plugin folder is a scan
//    error, a plugin folder that is a link out of its root is refused. The ledger folder holds an audit
//    record (plugin-audit.ts), not a gate: every change to a plugin's files is recorded for the person.
//  - 'person': everything below. The person ratifies a plugin's exact code; the rest of this comment
//    and the checks it describes are that mode.
//
// Trust (person mode). Plugin code runs unsandboxed in the backend (routes.mjs) or in dsh (entry),
// so where it is loaded from matters:
//  - nothing loads unless its id is in `plugins.enabled`;
//  - the person's own root (`plugins.dir`, default "" = none) AND the shipped root
//    (<repo>/plugins) are refused when inside, or containing, any path the companion can
//    write (agent.cwd, the Codex additional directories, the dsh home, the write-gate roots);
//  - every file a plugin names (entry, routes, help) must resolve, through symlinks,
//    to a path inside the plugin's real folder, which must itself be inside its real root;
//  - the person ratifies a plugin's exact code by hash (plugin-ratify.ts). Code that differs
//    from the ratified digest contributes nothing, checked on every run and every request.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { PROJECT_ROOT, getSanctumConfig, internalBaseUrl, type PluginTrust } from '../config.js';
import { getInternalToken } from '../middleware/internal-token.js';
import { TenantEditRefused } from '../tenancy/edit.js';
import { readOwn, readOwnOrApp, registerShippedReadRoots } from '../tenancy/own-files.js';
import { currentTenant, envFor, runInTenant, tenancyEnabled, tenantLocal, tenantTmpRoot, mapAllTenants } from '../tenancy/context.js';
import { TOOL_TOPICS } from './tool-topics.js';
import { containedRel, expandTildeWith, gateInside, isInside, isSame, realDeep, realOrResolved, realPath } from './plugin-paths.js';
import { auditPath, auditSummary, markSeen, noteDigest, type AuditSummary } from './plugin-audit.js';
import {
  currentDigest, DigestMismatch, RatifyScanError, scanImports, checkRatification, diffFiles, hashEntries, ledgerPath, pruneSnapshots, ratificationError, ratifyDirectory, readLedger, resetRatifyWarnings, scanTree, snapshotDir,
  type Ratification,
} from './plugin-ratify.js';
export type { Ratification } from './plugin-ratify.js';

// The discord private-list gate (discord/paths.ts) uses the same containment helpers.
export { isInside, realOrResolved };

export type { PluginTrust };
export type PluginHarness = 'claude' | 'codex' | 'dsh';
export type PluginRunKind = 'turn' | 'wake' | 'helper' | 'summarizer';

const HARNESSES: readonly string[] = ['claude', 'codex', 'dsh'];
const RUN_KINDS: readonly string[] = ['turn', 'wake', 'helper', 'summarizer'];
const DEFAULT_RUNS: PluginRunKind[] = ['turn', 'wake'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** What `name` on a row may be when it is not a resolved `entry`: a package name dsh resolves itself. */
const PKG_NAME_RE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
/** The id of the one dsh row a plugin may ask for by id rather than own: the ask_user_question tool.
 *  It is an INSERT row (dsh has no such row in its base) and the loader forces its `name`; the
 *  plugin supplies `config` only, and only on a conversation turn. */
const ASK_USER_ID = 'tool-ask-user';
const ASK_USER_NAME = '@deepseek-ai/dsh-tool-ask-user';
/** Every row id in dsh's real headless composition: the ids in dsh-base/cordis.patch.yml and
 *  dsh-headless/cordis.patch.yml, as shipped in @deepseek-ai/dsh 0.2.1-alpha.2 (extracted with
 *  `grep -E "^\s*(- )?id: "` over both files, 96 unique ids). dsh addresses a row by id, so an
 *  inserted row that reuses one is either a duplicate dsh refuses (exit 1) or, written without a
 *  `name`, a nameless entry dsh disables, which takes `approval` and `permission` down with it.
 *  A plugin row with one of these ids is rejected. Re-extract when dsh is upgraded. `mcp-*` ids
 *  belong to buildOverlay's own MCP rows and are reserved by prefix. */
export const DSH_BASE_ROW_IDS: ReadonlySet<string> = new Set([
  'agent', 'agent-default-model', 'agent-instructions', 'agent-loop', 'approval', 'attachment-local', 'authorization',
  'bash-sandbox', 'command-compact', 'command-feedback', 'command-goal', 'commands', 'compaction-basic', 'config-editor',
  'credentials', 'deepseek-account', 'deepseek-llm-api-extensions', 'fs-observation-policy', 'fs-sandbox', 'goal',
  'goal-round-driver', 'headless-runner', 'headless-startup', 'hmr', 'image-offload', 'jobs', 'llm', 'llm-deepseek',
  'llm-deepseek-account', 'llm-pi-ai', 'llm-retry', 'mcp-resources', 'otel', 'permission', 'plan-mode', 'plugin-manager',
  'plugin-package-inventory-deepseek', 'ptc-runtime', 'pwsh-sandbox', 'repeat-tool-reminder', 'sandbox', 'sandbox-policy',
  'session', 'session-checkpoint-policy', 'session-log-deepseek', 'session-persistence-jsonl', 'session-projection',
  'session-projection-cache', 'session-query-sqlite', 'session-telemetry-otel', 'session-title', 'session-title-llm', 'settings',
  'shell-env', 'skill', 'skill-filesystem', 'spill-local', 'spill-policy', 'storage', 'storage-domain', 'storage-json',
  'subagent', 'subagent-fork-in-process', 'subagent-spawn-in-process', 'subprocess', 'system-prompt', 'timeout-policy', 'timer',
  'token-meter', 'tool-bash', 'tool-fs', 'tool-fs-search', 'tool-goal', 'tool-jobs', 'tool-plugin-manager', 'tool-pwsh',
  'tool-result-pruner', 'tool-skill', 'tool-subagent', 'tool-subagent-control', 'tool-subagent-fork',
  'tool-subagent-list-agents', 'tool-todo', 'tool-web', 'tool-workflow', 'tool-working-directory', 'tools', 'typert',
  'typert-gateway', 'typert-loader', 'user-questions', 'web', 'web-fetch-http', 'web-search-deepseek', 'workflow-ptc',
  'working-directory',
]);
const isReservedRowId = (id: string) => DSH_BASE_ROW_IDS.has(id) || id.startsWith('mcp-');
const HELP_MAX = 4000;

export interface PluginRow {
  id: string;
  /** Package name dsh can resolve, passed as is. */
  name?: string;
  /** Path relative to the plugin folder; becomes an absolute `name`. */
  entry?: string;
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  harness: PluginHarness[];
  dsh: { rows: PluginRow[]; runs: PluginRunKind[] };
  routes?: string;
  help?: string;
  /** Accepted, not yet implemented (logged once at load). */
  ui?: { tab?: string; icon?: string };
  /** Accepted, not yet implemented (logged once at load). */
  mcp?: Record<string, unknown>;
  tenant_aware: boolean;
}

export interface LoadedPlugin {
  /** The manifest id, or the folder name when the manifest is unusable. */
  id: string;
  /** null when the manifest is invalid or the folder is not trusted; `error` says why. */
  manifest: PluginManifest | null;
  /** Plugin folder, as scanned (not realpath'd). */
  dir: string;
  /** The root folder it was scanned from, as given. */
  rootDir: string;
  /** Which root it came from: 0 = shipped, 1 = the person's plugins.dir. */
  root: number;
  /** What is wrong with it, found at scan time; null when nothing is. */
  error: string | null;
  /** Whether the code on disk is the code the person ratified. Set at scan time and refreshed by
   *  every check since; anything but 'ok' means the plugin contributes nothing. */
  ratification: Ratification;
  /** Companion mode: things found at scan time that do not stop the plugin (the import scan's findings). */
  warnings?: string[];
}

export interface ManifestResult { manifest?: PluginManifest; errors: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether a row `name` may be passed to dsh as is: a package name, never a path. */
export function isPackageName(name: string): boolean {
  return PKG_NAME_RE.test(name) && !name.includes('..');
}

/** Validate a parsed manifest. Never throws; returns every problem found. */
export function validateManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { errors: ['manifest must be a JSON object'] };
  if (!nonEmpty(raw.id)) errors.push('id is required');
  else if (!ID_RE.test(raw.id)) errors.push('id must be 1-32 lowercase letters, digits, - or _');
  // `res help <id>` answers a built-in topic first, so a plugin with one of these ids could never be shown.
  else if ((TOOL_TOPICS as readonly string[]).includes(raw.id)) errors.push(`id collides with a built-in help topic (${raw.id}); built-in topics: ${TOOL_TOPICS.join(', ')}`);
  if (!nonEmpty(raw.name)) errors.push('name is required');
  if (!nonEmpty(raw.version)) errors.push('version is required');

  let harness: PluginHarness[] = [];
  if (raw.harness !== undefined) {
    if (!Array.isArray(raw.harness) || raw.harness.some((h) => typeof h !== 'string' || !HARNESSES.includes(h))) {
      errors.push(`harness must be an array of ${HARNESSES.join(', ')}`);
    } else harness = raw.harness as PluginHarness[];
  }

  const rows: PluginRow[] = [];
  let runs: PluginRunKind[] = [...DEFAULT_RUNS];
  if (raw.dsh !== undefined) {
    if (!isObj(raw.dsh)) errors.push('dsh must be an object');
    else {
      if (raw.dsh.rows !== undefined) {
        if (!Array.isArray(raw.dsh.rows)) errors.push('dsh.rows must be an array');
        else {
          const firstSeen = new Map<string, number>();
          raw.dsh.rows.forEach((r, i) => {
            if (!isObj(r) || !nonEmpty(r.id)) { errors.push(`dsh.rows[${i}] needs a string id`); return; }
            // dsh addresses a row by id: two rows with one id collide there, after this manifest passed.
            const first = firstSeen.get(r.id);
            if (first !== undefined) errors.push(`dsh.rows[${i}]: duplicate dsh row id "${r.id}" (already used by dsh.rows[${first}])`);
            else firstSeen.set(r.id, i);
            if (r.entry !== undefined && (!nonEmpty(r.entry) || !containedRel(r.entry))) errors.push(`dsh.rows[${i}].entry must be a relative path inside the plugin folder`);
            if (r.name !== undefined && !nonEmpty(r.name)) errors.push(`dsh.rows[${i}].name must be a string`);
            if (r.entry !== undefined && r.name !== undefined) errors.push(`dsh.rows[${i}] has both entry and name`);
            // dsh treats an inserted row without a `name` as a nameless entry and disables it. The ask-user row is the exception: the loader supplies its name.
            if (r.entry === undefined && r.name === undefined && r.id !== ASK_USER_ID) errors.push(`dsh.rows[${i}] (${String(r.id)}) needs an entry or a name`);
            if (r.config !== undefined && !isObj(r.config)) errors.push(`dsh.rows[${i}].config must be an object`);
            rows.push(r as PluginRow);
          });
        }
      }
      if (raw.dsh.runs !== undefined) {
        if (!Array.isArray(raw.dsh.runs) || raw.dsh.runs.some((k) => typeof k !== 'string' || !RUN_KINDS.includes(k))) {
          errors.push(`dsh.runs must be an array of ${RUN_KINDS.join(', ')}`);
        } else runs = raw.dsh.runs as PluginRunKind[];
      }
    }
  }
  for (const k of ['routes', 'help'] as const) {
    if (raw[k] !== undefined && (!nonEmpty(raw[k]) || !containedRel(raw[k] as string))) errors.push(`${k} must be a relative path inside the plugin folder`);
  }
  if (raw.tenant_aware !== undefined && typeof raw.tenant_aware !== 'boolean') errors.push('tenant_aware must be a boolean');
  if (raw.ui !== undefined) {
    if (!isObj(raw.ui)) errors.push('ui must be an object');
    else {
      if (raw.ui.tab !== undefined && typeof raw.ui.tab !== 'string') errors.push('ui.tab must be a string');
      if (raw.ui.icon !== undefined && typeof raw.ui.icon !== 'string') errors.push('ui.icon must be a string');
    }
  }
  if (raw.mcp !== undefined && !isObj(raw.mcp)) errors.push('mcp must be an object');
  if (errors.length) return { errors };
  return {
    errors,
    manifest: {
      id: raw.id as string,
      name: raw.name as string,
      version: raw.version as string,
      harness,
      dsh: { rows, runs },
      ...(raw.routes !== undefined && { routes: raw.routes as string }),
      ...(raw.help !== undefined && { help: raw.help as string }),
      ...(raw.ui !== undefined && { ui: raw.ui as { tab?: string; icon?: string } }),
      ...(raw.mcp !== undefined && { mcp: raw.mcp as Record<string, unknown> }),
      tenant_aware: raw.tenant_aware === true,
    },
  };
}

// ── Warn-once ────────────────────────────────────────────────────────────────
// Per tenant in tenant mode (one tenant's warning never silences another's); one set for the process otherwise.
const warnedLocal = tenantLocal(() => new Set<string>());
function warnOnce(msg: string): void {
  const warned = warnedLocal.get();
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

// ── Real-path containment ────────────────────────────────────────────────────
type Safe = { path: string; error: null } | { path: null; error: string };

/** Resolve `rel` inside a plugin through symlinks. The plugin folder must be inside its
 *  real root, and the file inside the real plugin folder; anything else is an error. */
function safeFile(pluginDir: string, rootDir: string, rel: string, label: string): Safe {
  let realDir: string;
  try {
    realDir = realPath(pluginDir);
    const realRoot = realPath(rootDir);
    if (isSame(realDir, realRoot) || !isInside(realDir, realRoot)) return { path: null, error: 'plugin folder resolves outside its root' };
  } catch { return { path: null, error: 'plugin folder not found' }; }
  let real: string;
  try { real = realPath(resolve(realDir, rel)); } catch { return { path: null, error: `${label} ${rel} not found` }; }
  if (isSame(real, realDir) || !isInside(real, realDir)) return { path: null, error: `${label} ${rel} resolves outside the plugin folder` };
  return { path: real, error: null };
}

/** `rel` inside the plugin: in the ratified copy when there is one (what runs), else in the live folder. */
function locate(p: LoadedPlugin, snapshot: string | undefined, rel: string, label: string): Safe {
  return snapshot ? safeFile(snapshot, path.dirname(snapshot), rel, label) : safeFile(p.dir, p.rootDir, rel, label);
}

// ── Roots ────────────────────────────────────────────────────────────────────
/** `~` and `~/x` to the home directory. Config values reach here raw (hooks.vault_path, the Codex
 *  extra directories) or already resolved, and a literal `~` is never a real folder name here. */
export function expandTilde(p: string): string {
  return expandTildeWith(path, homedir(), p);
}

/** Who manages plugins, from `cfg` (default: the loaded config): 'person' only when plugins.trust says so;
 *  anything else, and a config that is not loaded, is 'companion'. */
export function pluginTrust(cfg?: any): PluginTrust {
  let c = cfg;
  if (c === undefined) { try { c = getSanctumConfig(); } catch { return 'companion'; } }
  return c?.plugins?.trust === 'person' ? 'person' : 'companion';
}

/** The environment provider and sandbox settings are read from: the current tenant's own .env in tenant mode, process.env otherwise. */
const tenantEnv = (): NodeJS.ProcessEnv => (tenancyEnabled() ? (envFor('the plugin provider check') as NodeJS.ProcessEnv) : process.env);

/** The harness that runs, as activeProviderName() chooses it: AGENT_PROVIDER wins over yaml, lower-cased. */
export function activeProvider(cfg: any, env: NodeJS.ProcessEnv = tenantEnv()): string {
  return String(env.AGENT_PROVIDER || cfg?.agent?.provider || 'claude').trim().toLowerCase();
}

/** Paths the companion can write: its home, the Codex extra directories, the dsh home, the write-gate roots,
 *  and, while Codex or dsh is the active provider, the temp folders their workspace-write sandboxes include.
 *
 *  Why /tmp and $TMPDIR: Codex's `workspace-write` sandbox makes `/tmp` and `$TMPDIR` writable unless
 *  `sandbox_workspace_write.exclude_slash_tmp` / `exclude_tmpdir_env_var` are set to true, and this app sets
 *  neither (codex-exec.ts passes only `network_access`). Confirmed: both keys exist in the bundled codex binary
 *  (node_modules/@openai/codex-linux-x64, `strings` shows `writable_roots`, `exclude_tmpdir_env_var`,
 *  `exclude_slash_tmp` under `sandbox_workspace_write`); the "writable by default" half is Codex's documented
 *  behaviour, which no file in node_modules states. dsh is not installed here and docs/DSH.md says nothing about
 *  its temp folders (the backend gives each dsh run a TMPDIR under os.tmpdir()), so they are included on the
 *  same footing. Over-inclusion only moves the ledger; leaving one out would let the companion write the ledger. */
export function writableRoots(cfg: any, opts: { pluginsDir?: boolean; tmpRoot?: string } = {}): Array<{ label: string; path: string }> {
  const out: Array<{ label: string; path: string }> = [];
  const add = (label: string, p: unknown) => { if (typeof p === 'string' && p.trim()) out.push({ label, path: expandTilde(p.trim()) }); };
  const provider = activeProvider(cfg);
  if (provider === 'codex' || provider === 'dsh') {
    const who = provider === 'codex' ? 'the Codex' : 'the dsh';
    if (tenancyEnabled() || opts.tmpRoot !== undefined) {
      // Tenant mode (D7): the sandbox's temp root is the tenant's own TMPDIR, and Codex is told to leave /tmp out (codex-exec.ts, codex.ts), so
      // neither /tmp nor the process temp folder is every Codex tenant's root. Outside a tenant (a skipped tenant's loose config) there is none to
      // add; that tenant's temp folder sits under its data/, which is protected anyway.
      const tmp = opts.tmpRoot ?? tenantTmpRoot(); // (boot's layout check runs before tenancy is switched on, so it names the tenant's root itself)
      if (tmp) add(`${who} sandbox's $TMPDIR`, tmp);
      // dsh has NO verified flag that removes /tmp from its sandbox (it is not installed here and docs/DSH.md is silent), so a dsh tenant keeps
      // /tmp and the process temp folders too and the clash checks still count them. A dsh `exclude /tmp` setting would let us drop these three.
      if (provider === 'dsh') {
        if (process.platform !== 'win32') add(`${who} sandbox's /tmp`, '/tmp');
        add(`${who} sandbox's $TMPDIR (process)`, process.env.TMPDIR);
        add(`${who} sandbox's temp folder`, tmpdir());
      }
    } else {
      if (process.platform !== 'win32') add(`${who} sandbox's /tmp`, '/tmp');
      add(`${who} sandbox's $TMPDIR`, process.env.TMPDIR);
      add(`${who} sandbox's temp folder`, tmpdir());
    }
  }
  add('agent.cwd', cfg?.agent?.cwd);
  for (const d of Array.isArray(cfg?.agent?.codex?.additional_directories) ? cfg.agent.codex.additional_directories : []) add('agent.codex.additional_directories', d);
  add('agent.dsh.home', cfg?.agent?.dsh?.home);
  add('hooks.workspace_root', cfg?.hooks?.workspace_root);
  add('hooks.vault_path', cfg?.hooks?.vault_path);
  for (const d of Array.isArray(cfg?.hooks?.extra_write_paths) ? cfg.hooks.extra_write_paths : []) add('hooks.extra_write_paths', d);
  for (const d of Array.isArray(cfg?.hooks?.safe_write_prefixes) ? cfg.hooks.safe_write_prefixes : []) add('hooks.safe_write_prefixes', d);
  if (opts.pluginsDir) add('plugins.dir', cfg?.plugins?.dir); // the person's plugin root is no place for the ledger either
  return out;
}

/** Every folder any companion in this process can write. One config (tenancy off: exactly writableRoots(cfg)); in tenant mode the union over every
 *  booted tenant and every skipped tenant's declared roots, plus `cfg`'s own (it may be a candidate not yet booted), so one tenant's ledger,
 *  plugin root or private lists cannot sit inside another's home. */
export function allWritableRoots(cfg: any, opts: { pluginsDir?: boolean } = {}): Array<{ label: string; path: string }> {
  if (!tenancyEnabled()) return writableRoots(cfg, opts);
  return [...writableRoots(cfg, opts), ...mapAllTenants((c) => writableRoots(c, opts)).flat()];
}

/** The ledger folder: `plugins.ledger_dir` from config, else <project>/data/plugins. */
export function ledgerDirFor(cfg: any): string {
  const raw = typeof cfg?.plugins?.ledger_dir === 'string' ? cfg.plugins.ledger_dir.trim() : '';
  return raw ? path.resolve(PROJECT_ROOT, expandTilde(raw)) : join(PROJECT_ROOT, 'data', 'plugins');
}

/** The ledger file now (read live from config, so the person's `plugins.ledger_dir` applies). */
export function currentLedgerFile(cfg?: any): string {
  let c = cfg;
  if (c === undefined) { try { c = getSanctumConfig(); } catch { c = {}; } }
  return ledgerPath(PROJECT_ROOT, ledgerDirFor(c));
}

/** The first companion-writable root that contains, or is inside, the ledger folder (by real
 *  path), or null. A ledger the companion can write is a ledger it can ratify its own edits in. */
export function ledgerClash(cfg: any, ledgerFile?: string): { label: string; path: string } | null {
  const real = realDeep(ledgerFile ? path.dirname(ledgerFile) : ledgerDirFor(cfg));
  for (const w of allWritableRoots(cfg, { pluginsDir: true })) {
    const wr = realDeep(w.path);
    if (gateInside(real, wr) || gateInside(wr, real)) return w;
  }
  return null;
}

/** The first writable root that contains, or is inside, `dir` (compared by real path), or null. */
export function writableClash(dir: string, cfg: any): { label: string; path: string } | null {
  const real = realOrResolved(dir);
  for (const w of allWritableRoots(cfg)) {
    const wr = realOrResolved(w.path);
    if (gateInside(real, wr) || gateInside(wr, real)) return w;
  }
  return null;
}

/** The person's own plugin root from config, or '' for none. Refuses (loudly) a dir that is
 *  inside, or contains, anything the companion can write: plugin code loaded from there would
 *  be code the companion wrote, run without a sandbox. */
export function personRoot(cfg: any): string {
  const raw = typeof cfg?.plugins?.dir === 'string' ? cfg.plugins.dir.trim() : '';
  if (!raw) return '';
  const dir = expandTilde(raw);
  // Companion mode accepts a plugin root the companion can write: it may write plugins. Tenant mode never does, whatever the trust: a plugin
  // is operator-trusted code in a process every tenant shares, so its root is operator-placed (<tenant>/plugins, beside home/, not inside
  // anything the union of tenants' companions can write).
  const clash = pluginTrust(cfg) === 'person' || tenancyEnabled() ? writableClash(dir, cfg) : null;
  if (clash) {
    (tenancyEnabled() ? warnOnce : console.warn)(`[plugins] plugins.dir ${raw} refused: it is inside (or contains) ${clash.label} ${clash.path}, which the companion can write, and plugin code loaded from there would run without a sandbox. The root is ignored. Put it outside the companion's folders.`);
    return '';
  }
  if (!existsSync(dir)) warnOnce(`[plugins] plugins.dir ${raw} does not exist; no plugins load from it. Create the folder or fix the path.`);
  return dir;
}

/** The shipped root (<repo>/plugins), held to the same check as the person's: with the default
 *  `agent.cwd` of `.` the companion's home IS the app folder, and everything it can write there
 *  would be loaded as shipped code. Refused (loudly) when a writable root contains or equals it. */
let shippedOverride: string | null = null;
/** Tests only: read the shipped plugins from `dir` instead of <repo>/plugins (null puts it back). Not an environment variable, so no deployment can
 *  point the server at another folder with one. */
export function setShippedRootForTests(dir: string | null): void { shippedOverride = dir; }

/** Where the shipped plugins are read from (the test seam honoured). */
export function shippedRootPath(): string { return shippedOverride ?? join(PROJECT_ROOT, 'plugins'); }
registerShippedReadRoots(() => [shippedRootPath()]);

export function shippedRoot(cfg: any): string {
  const dir = shippedRootPath();
  // Tenant mode: the check runs whatever the trust mode, over every tenant's writable roots (shipped code runs for every tenant).
  const clash = pluginTrust(cfg) === 'person' || tenancyEnabled() ? writableClash(dir, cfg) : null;
  if (clash) {
    console.warn(`[plugins] the shipped plugin root ${dir} refused: it is inside (or contains) ${clash.label} ${clash.path}, which the companion can write, so code it wrote could be loaded as a shipped plugin without a sandbox. No shipped plugin loads until no companion-writable root (agent.cwd, the Codex additional directories, the dsh home, the hooks write-gate roots) equals, contains or sits inside ${dir}. A home elsewhere in the app folder, such as ${join(PROJECT_ROOT, 'companion-home')}, is fine: set agent.cwd to a folder that does not contain ${dir}.`);
    return '';
  }
  return dir;
}

// ── Full access ──────────────────────────────────────────────────────────────
/** The config key that puts the ACTIVE harness at `danger-full-access`, or null. Under it the
 *  companion can write anywhere the OS user can, so no plugin root is out of its reach and the
 *  roots check above proves nothing. Only the active provider counts: a dsh setting does not
 *  matter while Codex runs the turns. Claude has no sandbox mode; see PLUGINS.md. */
export function fullAccessSetting(cfg: any, env: NodeJS.ProcessEnv = tenantEnv()): string | null {
  // The harness that runs is activeProviderName()'s choice: AGENT_PROVIDER wins over yaml and the
  // name is lower-cased. Mirror that exactly, or `provider: Codex` / AGENT_PROVIDER=CODEX runs Codex
  // under danger-full-access while this check sees a stranger and lets plugins load.
  const provider = activeProvider(cfg, env);
  if (provider === 'codex' && cfg?.agent?.codex?.sandbox_mode === 'danger-full-access') return 'agent.codex.sandbox_mode';
  if (provider === 'dsh' && cfg?.agent?.dsh?.sandbox_mode === 'danger-full-access') return 'agent.dsh.sandbox_mode';
  return null;
}

export type DisabledReason = 'full_access' | 'ledger_writable';
export interface DisabledInfo { reason: DisabledReason; /** Which setting or root (ledger_writable only). */ detail?: string }

/** Why plugins are switched off, or null. Read live from config (or from `cfg`). Warns loudly, once,
 *  when that stops plugins the person had enabled.
 *   full_access      the active harness has no sandbox (see fullAccessSetting)
 *   ledger_writable  the ratification ledger folder is inside, or contains, something the companion
 *                    can write, so it could ratify its own edits (`ledgerFile` overrides the config's folder) */
export function pluginsDisabledInfo(cfg?: any, ledgerFile?: string): DisabledInfo | null {
  let c = cfg;
  if (c === undefined) { try { c = getSanctumConfig(); } catch { return null; } }
  if (pluginTrust(c) === 'companion') return null; // no full-access refusal and no ledger check: the companion manages plugins
  const named = Array.isArray(c?.plugins?.enabled) ? c.plugins.enabled.filter((x: unknown) => typeof x === 'string') : [];
  const setting = fullAccessSetting(c);
  if (setting) {
    if (named.length) warnOnce(`[plugins] DISABLED: ${setting} is "danger-full-access", so the companion can write anywhere on this machine, including any plugin folder, and plugin code runs without a sandbox. No plugins load (no dsh rows, no routes, no help topics; GET /api/plugins reports disabled: "full_access") until ${setting} is "workspace-write" or "read-only" and the app is restarted. Enabled but not loaded: ${named.join(', ')}.`);
    return { reason: 'full_access' };
  }
  const clash = ledgerClash(c, ledgerFile);
  if (clash) {
    const dir = ledgerFile ? path.dirname(ledgerFile) : ledgerDirFor(c);
    const detail = `${clash.label} ${clash.path}`;
    warnOnce(`[plugins] DISABLED: the ratification ledger folder ${dir} is inside (or contains) ${detail}, which the companion can write, so the companion could rewrite the ledger and ratify its own edits. No plugins load (no dsh rows, no routes, no help topics; GET /api/plugins reports disabled: "ledger_writable"). Fix: set plugins.ledger_dir in sanctum.yaml to a folder that no companion-writable root (agent.cwd, hooks.workspace_root, hooks.vault_path, hooks.safe_write_prefixes, hooks.extra_write_paths, agent.codex.additional_directories, the dsh home, plugins.dir) contains or sits inside, then restart.${named.length ? ` Enabled but not loaded: ${named.join(', ')}.` : ''}`);
    return { reason: 'ledger_writable', detail };
  }
  return null;
}

/** The reason alone; see pluginsDisabledInfo. */
export function pluginsDisabled(cfg?: any): DisabledReason | null {
  return pluginsDisabledInfo(cfg)?.reason ?? null;
}

export interface LoadOptions {
  /** Plugin roots, earliest first; a later root wins on a duplicate id. Default: shipped, then plugins.dir. */
  roots?: string[];
  /** When true, plugins without tenant_aware are refused. The app has no multi-tenant mode yet. */
  multiTenant?: boolean;
}

function defaultRoots(): string[] {
  const roots: string[] = [];
  let cfg: any;
  try { cfg = getSanctumConfig(); } catch { /* config not loaded: shipped plugins only, and nothing is enabled without config */ }
  try {
    const shipped = cfg ? shippedRoot(cfg) : join(PROJECT_ROOT, 'plugins');
    if (shipped) roots.push(shipped);
  } catch { /* no project root known */ }
  if (cfg) {
    const dir = personRoot(cfg);
    if (dir) roots.push(dir);
  }
  return roots;
}

/** The ids named in plugins.enabled, read live so a change applies on the next run. */
export function enabledIds(): Set<string> {
  try {
    const list = getSanctumConfig().plugins?.enabled;
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

// The scan cache and its rescan clock: one per tenant in tenant mode (a rescan in one never resets another's), one for the process otherwise.
const cacheLocal = tenantLocal<LoadedPlugin[] | null>(() => null);
const rescanLocal = tenantLocal(() => ({ at: 0 }));
const RESCAN_MS = 2000;
/** Forget the cached scan, so the next loadPlugins() reads the roots again (a plugin was added, a list is wanted). */
export function rescanPlugins(): void { cacheLocal.set(null); }
/** Runtime routes import failures by plugin id, shown as `error` in the list until a retry succeeds. */
const routeErrorsLocal = tenantLocal(() => new Map<string, string>());

/** Drop the cached scan and per-process memory (tests, and a future "reload plugins"). */
export function resetPlugins(): void { cacheLocal.set(null); rescanLocal.set({ at: 0 }); routeErrorsLocal.get().clear(); warnedLocal.set(new Set()); lastRatStateLocal.get().clear(); resetRatifyWarnings(); }

// ── Ratification ─────────────────────────────────────────────────────────────
const lastRatStateLocal = tenantLocal(() => new Map<string, string>());
/** One warning per plugin per state change (boot, or a per-run/per-request check that flips). */
function noteRatification(id: string, r: Ratification): void {
  const lastRatState = lastRatStateLocal.get();
  const prev = lastRatState.get(id);
  if (prev === r.state) return;
  lastRatState.set(id, r.state);
  if (r.state === 'ok') { if (prev !== undefined) console.log(`[plugins] ${id}: the code on disk matches the ratified digest again`); return; }
  console.warn(`[plugins] ${id}: ${ratificationError(id, r)}`);
}
/** Recompute a plugin's status from disk now (a full hash, not the load-time answer) and keep it on the plugin. */
function freshRatification(p: LoadedPlugin, ledgerFile: string = currentLedgerFile()): Ratification {
  const r = checkRatification(p.id, p.dir, ledgerFile);
  p.ratification = r;
  noteRatification(p.id, r);
  return r;
}

/** Problems with a valid manifest's paths and rows that would break the app itself (a path out of the plugin
 *  folder, a row that collides with dsh's own). Both modes refuse a plugin for these. */
function pathProblems(m: PluginManifest, dir: string, rootDir: string): string[] {
  const out: string[] = [];
  for (const r of m.dsh.rows) {
    if (r.id === ASK_USER_ID) continue; // name and entry are the loader's, whatever the manifest says
    if (r.entry !== undefined) { const f = safeFile(dir, rootDir, r.entry, `row ${r.id} entry`); if (f.error !== null) out.push(f.error); }
    else if (r.name !== undefined && !isPackageName(r.name)) out.push(`row ${r.id} name "${r.name}" is not a package name`);
    if (isReservedRowId(r.id)) out.push(`row ${r.id} collides with a dsh base row`);
  }
  if (m.help) { const f = safeFile(dir, rootDir, m.help, 'help'); if (f.error !== null) out.push(f.error); }
  if (m.routes) { const f = safeFile(dir, rootDir, m.routes, 'routes'); if (f.error !== null) out.push(f.error); }
  return out;
}

/** Static problems with a valid manifest's files and rows, found at scan time (person mode: the import scan
 *  refuses too). In companion mode the import scan's findings come back as `warnings`, not `errors`. */
function scanProblems(m: PluginManifest, dir: string, rootDir: string, roots: string[], trust: PluginTrust = 'person'): { errors: string[]; warnings: string[] } {
  const errors = pathProblems(m, dir, rootDir);
  const imports = scanImports(dir, { writableRoots: roots, hint: trust }); // code that reaches outside the folder is code the digest never saw
  return trust === 'person' ? { errors: [...errors, ...imports], warnings: [] } : { errors, warnings: imports };
}

/** The companion-writable roots as plain paths, from the live config: what the import scan holds
 *  absolute paths and file: URLs against. */
function scanRoots(cfg?: any): string[] {
  let c = cfg;
  if (c === undefined) { try { c = getSanctumConfig(); } catch { c = {}; } }
  return allWritableRoots(c, { pluginsDir: true }).map((w) => w.path);
}

/** Read the plugin folder's manifest from disk now, validate it and scan the folder: the manifest
 *  (null when it is unusable) and the scan `error` (null when nothing is wrong). Used at boot and by
 *  the ratify route, which must judge the code it is about to ratify, not the answer from boot. Reads
 *  JSON and text only, never plugin code. */
function liveScan(dir: string, rootDir: string, cfg?: any): { manifest: PluginManifest | null; error: string | null; warnings: string[] } {
  const file = join(dir, 'sanctum.plugin.json');
  const manifestFile = safeFile(dir, rootDir, 'sanctum.plugin.json', 'manifest');
  if (manifestFile.error !== null) {
    console.warn(`[plugins] ${dir}: ${manifestFile.error}; not loaded`);
    return { manifest: null, error: manifestFile.error, warnings: [] };
  }
  let raw: unknown;
  try { raw = JSON.parse(readOwnOrApp(manifestFile.path)); } catch (e) {
    const error = `not valid JSON (${errMsg(e)})`;
    console.warn(`[plugins] ${file}: ${error}; skipped`);
    return { manifest: null, error, warnings: [] };
  }
  const { manifest, errors } = validateManifest(raw);
  if (!manifest) {
    console.warn(`[plugins] ${file}: ${errors.join('; ')}; skipped`);
    return { manifest: null, error: errors.join('; '), warnings: [] };
  }
  const problems = scanProblems(manifest, dir, rootDir, scanRoots(cfg), pluginTrust(cfg));
  return { manifest, error: problems.errors.length ? problems.errors.join('; ') : null, warnings: problems.warnings };
}

// ── Companion mode: the live folder, and the audit record ────────────────────
const liveOk = (): Ratification => ({ state: 'ok', digest: '' });

/** The manifest in the live folder now, validated, with the path checks (no import scan: that is for the
 *  list). Companion mode reads this for every run, request and reload, so an edit applies at once and a fix
 *  clears an old error. Never throws. */
function liveManifest(p: { id: string; dir: string; rootDir: string }): { manifest: PluginManifest } | { error: string } {
  const f = safeFile(p.dir, p.rootDir, 'sanctum.plugin.json', 'manifest');
  if (f.error !== null) return { error: f.error };
  let raw: unknown;
  try { raw = JSON.parse(readOwnOrApp(f.path)); } catch (e) { return { error: `not valid JSON (${errMsg(e)})` }; }
  const { manifest, errors } = validateManifest(raw);
  if (!manifest) return { error: errors.join('; ') };
  if (manifest.id !== p.id) return { error: `the manifest id is now "${manifest.id}", not "${p.id}"; reload the plugin list so it is listed under its new id` };
  const problems = pathProblems(manifest, p.dir, p.rootDir);
  if (problems.length) return { error: problems.join('; ') };
  return { manifest };
}

/** liveManifest, kept on the plugin: the fields the list and the route dispatch read. */
function refreshLive(p: LoadedPlugin): { manifest: PluginManifest } | { error: string } {
  const r = liveManifest(p);
  if ('error' in r) { p.manifest = null; p.error = r.error; } else { p.manifest = r.manifest; p.error = null; }
  return r;
}

/** The audit file now (read live from config, so plugins.ledger_dir applies): <ledger folder>/audit.json. */
export function currentAuditFile(cfg?: any): string {
  let c = cfg;
  if (c === undefined) { try { c = getSanctumConfig(); } catch { c = {}; } }
  return auditPath(ledgerDirFor(c));
}

/** Compute the plugin's digest now and record it when it differs from the last one recorded. Gates nothing.
 *  Returns the digest, or null when the folder cannot be hashed (a link inside it, the size caps). */
function auditPlugin(p: { id: string; dir: string }, file: string = currentAuditFile()): string | null {
  try {
    const now = currentDigest(p.dir);
    const r = noteDigest(file, p.id, now, () => readLedger(currentLedgerFile()).plugins[p.id]);
    if (r.changed && r.record.changes.length) {
      const named = r.record.changes.slice(0, 5).map((c) => c.path).join(', ');
      console.log(`[plugins] ${p.id}: code changed (${r.record.changes.length} files: ${named}${r.record.changes.length > 5 ? ', ...' : ''}); recorded in the audit file`);
    }
    return now.digest;
  } catch (e) {
    warnOnce(`[plugins] ${p.id}: could not record the plugin's code in the audit file (${errMsg(e)})`);
    return null;
  }
}

/** The manifest inside the ratified copy at `snapshot`: the one that runs. The live manifest is read
 *  once at boot for discovery and the list, and is never what rows, help or routes are built from;
 *  the copy's is read and validated again for every check that says ok. A copy whose manifest is
 *  missing, invalid or names another id contributes nothing (one warning), until it is ratified again. */
function snapshotManifest(p: { id: string; dir: string; rootDir: string }, snapshot: string): { manifest: PluginManifest } | { error: string } {
  const f = safeFile(snapshot, path.dirname(snapshot), 'sanctum.plugin.json', 'manifest');
  const fail = (why: string) => {
    const error = `the manifest in the ratified copy ${why}; nothing loads until it is fixed and ratified again`;
    warnOnce(`[plugins] ${p.id}: ${error} (${snapshot})`);
    return { error };
  };
  if (f.error !== null) return fail(`cannot be read (${f.error})`);
  let raw: unknown;
  try { raw = JSON.parse(readOwnOrApp(f.path)); } catch (e) { return fail(`is not valid JSON (${errMsg(e)})`); }
  const { manifest, errors } = validateManifest(raw);
  if (!manifest) return fail(`is invalid (${errors.join('; ')})`);
  if (manifest.id !== p.id) return fail(`names the id "${manifest.id}", not "${p.id}"`);
  return { manifest };
}

/** Scan the roots and validate manifests. Reads JSON only, never plugin code. Returns every
 *  folder that has a manifest file, usable or not (`manifest: null` + `error`); callers that
 *  need a working plugin skip those. Cached for the process after the first call unless
 *  `roots` is given. */
export function loadPlugins(opts: LoadOptions = {}): LoadedPlugin[] {
  if (!opts.roots && pluginsDisabled()) return [];
  const trust = pluginTrust();
  // Multi-tenant (the option, or tenant mode): refused plugins are skipped, and the scan is kept per tenant rather than redone on every call.
  // With tenancy off, an explicit multiTenant: true still bypasses the cache, as it always did.
  const multiTenant = opts.multiTenant ?? tenancyEnabled();
  const useCache = !opts.roots && (!multiTenant || tenancyEnabled());
  let cache = cacheLocal.get();
  if (cache && useCache) {
    // Companion mode: a plugin the companion created (or enabled) after the scan is picked up by looking again,
    // at most every couple of seconds while an enabled id is still missing.
    const rescan = rescanLocal.get();
    if (trust === 'companion' && Date.now() - rescan.at > RESCAN_MS) {
      const have = new Set(cache.map((c) => c.id));
      if ([...enabledIds()].some((id) => !have.has(id))) { rescan.at = Date.now(); cacheLocal.set(null); cache = null; }
    }
    if (cache) return cache;
  }
  const byId = new Map<string, LoadedPlugin>();
  (opts.roots ?? defaultRoots()).forEach((rootDir, rootIdx) => {
    let names: string[] = [];
    try { names = readdirSync(rootDir).sort(); } catch { return; } // a missing root is normal
    for (const dirName of names) {
      const dir = join(rootDir, dirName);
      const file = join(dir, 'sanctum.plugin.json');
      try { if (!statSync(dir).isDirectory() || !statSync(file).isFile()) continue; } catch { continue; }
      const ratification = trust === 'person' ? checkRatification(dirName, dir, currentLedgerFile()) : liveOk();
      const scan = liveScan(dir, rootDir);
      if (!scan.manifest) {
        byId.set(dirName, { id: dirName, manifest: null, dir, rootDir, root: rootIdx, error: scan.error, ratification });
        continue;
      }
      const manifest = scan.manifest;
      if (multiTenant && !manifest.tenant_aware) {
        warnOnce(`[plugins] ${manifest.id}: not tenant_aware and the app is multi-tenant; skipped`);
        continue;
      }
      for (const field of ['mcp', 'ui'] as const) {
        if (manifest[field] !== undefined) warnOnce(`[plugins] ${manifest.id}: "${field}" is accepted but not yet implemented; ignored`);
      }
      const own = trust === 'companion' || manifest.id === dirName ? ratification : checkRatification(manifest.id, dir, currentLedgerFile());
      byId.set(manifest.id, { id: manifest.id, manifest, dir, rootDir, root: rootIdx, error: scan.error, ratification: own, ...(trust === 'companion' && { warnings: scan.warnings }) }); // later root replaces an earlier one
    }
  });
  const list = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (trust === 'companion') { const on = enabledIds(); for (const p of list) if (p.manifest && on.has(p.id)) auditPlugin(p); } // the audit record (enabled plugins only): compare with the last digest, record a difference
  if (useCache) cacheLocal.set(list);
  return list;
}

export interface PluginRowCtx {
  harness: PluginHarness;
  runKind: PluginRunKind;
  threadId: string;
  tenant?: string;
  /** Whether the person behind this run is the owner. Unset: see resolveSenderIsOwner. */
  senderIsOwner?: boolean;
}

/** The only place the owner default lives. An explicit answer always wins. Unset, it is true for
 *  wake, helper and summarizer runs (no one is speaking: the companion's own time, or a read-only
 *  one-shot) and FALSE for a conversation turn, where a caller that cannot say who is talking is
 *  not assumed to be the owner. */
export function resolveSenderIsOwner(runKind: PluginRunKind, explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return runKind !== 'turn';
}

const OWNER_PLATFORMS = new Set(['web', 'api', 'ws', 'telegram']);
/** Whether the sender of a message is the owner, from what the caller knows. Web, API, WebSocket
 *  and Telegram are owner-only surfaces. Discord says so explicitly and fails closed. An unknown
 *  or missing platform is not assumed to be the owner. */
export function senderIsOwnerFor(platform: string | undefined, discordOwner?: boolean): boolean {
  if (platform === 'discord') return discordOwner === true;
  return platform !== undefined && OWNER_PLATFORMS.has(platform);
}

/** The dsh rows plugins contribute to one run, ready to go in the overlay's `insert` list.
 *  Only enabled plugins contribute. Every row has a `name` (dsh disables a nameless entry).
 *  Empty when no plugin matches the harness and run kind. */
export function pluginRows(ctx: PluginRowCtx, plugins: LoadedPlugin[] = loadPlugins(), enabled: ReadonlySet<string> = enabledIds()): any[] {
  const out: any[] = [];
  if (pluginsDisabled()) return out;
  let sanctum: Record<string, unknown> | undefined;
  let askUser = false;
  const companion = pluginTrust() === 'companion';
  for (const p of plugins) {
    if (!enabled.has(p.id)) continue;
    let m: PluginManifest;
    let snapshot: string | undefined;
    if (companion) {
      // The live folder, read again for every run: an edit applies on the next run and a fix clears an old error.
      auditPlugin(p);
      const lm = refreshLive(p);
      if ('error' in lm) { warnOnce(`[plugins] ${p.id}: ${lm.error}; contributes nothing until it is fixed`); continue; }
      m = lm.manifest;
    } else {
      if (!p.manifest || p.error !== null) continue; // a plugin with a scan error contributes nothing
      // Every run, from disk, not from the scan: a plugin edited after boot stops contributing on the next run.
      const rat = freshRatification(p);
      if (rat.state !== 'ok' || !rat.snapshot) continue;
      // What runs is the ratified copy's manifest, read again now; the boot-time one is only for discovery and the list.
      const sm = snapshotManifest(p, rat.snapshot);
      if ('error' in sm) continue;
      m = sm.manifest;
      snapshot = rat.snapshot;
    }
    if (!m.harness.includes(ctx.harness) || !m.dsh.runs.includes(ctx.runKind)) continue;
    for (const r of m.dsh.rows) {
      const { entry, id, config, name, ...rest } = r;
      if (id === ASK_USER_ID) {
        // Inserted by name (forced), config from the plugin, once per run, conversation turns only.
        if (ctx.runKind !== 'turn') { warnOnce(`[plugins] ${m.id}: row ${id} is only allowed on a turn run (this is a ${ctx.runKind} run); dropped`); continue; }
        if (askUser) { warnOnce(`[plugins] ${m.id}: row ${id} is already added for this run by an earlier plugin; this one is ignored`); continue; }
        askUser = true;
        out.push({ id: ASK_USER_ID, name: ASK_USER_NAME, ...(config !== undefined && { config }) });
        continue;
      }
      if (isReservedRowId(id)) { warnOnce(`[plugins] ${m.id}: row ${id} collides with a dsh base row; rejected`); continue; }
      const row: Record<string, unknown> = { id: `plugin:${m.id}:${id}`, ...rest };
      if (entry !== undefined) {
        const f = locate(p, snapshot, entry, 'entry');
        if (f.error !== null) { warnOnce(`[plugins] ${m.id}: row ${id}: ${f.error}; skipped`); continue; }
        row.name = f.path; // person mode: inside the ratified copy, so dsh loads the bytes that were hashed. Companion mode: the live file.
      } else if (name !== undefined) {
        if (typeof name !== 'string' || !isPackageName(name)) { warnOnce(`[plugins] ${m.id}: row ${id} name "${String(name)}" is not a package name; rejected`); continue; }
        row.name = name;
      } else { warnOnce(`[plugins] ${m.id}: row ${id} has neither entry nor name; skipped`); continue; }
      // The token travels in row config, never in the child's environment (dsh-exec's env is an allowlist).
      sanctum ??= {
        baseUrl: internalBaseUrl(getSanctumConfig().server),
        token: getInternalToken(),
        threadId: ctx.threadId,
        tenant: currentTenant()?.id ?? ctx.tenant ?? 'default',
        runKind: ctx.runKind,
        senderIsOwner: resolveSenderIsOwner(ctx.runKind, ctx.senderIsOwner),
      };
      // Merge into config; sibling keys survive, and the plugin cannot override what the loader injects.
      const own = isObj(config?.sanctum) ? config!.sanctum : {};
      row.config = { ...(config ?? {}), sanctum: { ...own, ...sanctum } };
      out.push(row);
    }
  }
  return out;
}

export interface PluginInfo {
  id: string; name: string; version: string; harness: PluginHarness[];
  routes: boolean; help: boolean; ui?: { tab?: string; icon?: string }; tenant_aware: boolean;
  enabled: boolean;
  error: string | null;
  /** Person mode only. */
  ratification?: Ratification;
  /** Companion mode only: the audit record's summary (null when the code could not be recorded). */
  audit?: AuditSummary | null;
  /** Companion mode only: what the import scan found. Not a refusal. */
  warnings?: string[];
}

/** For GET /api/plugins: everything discovered, enabled or not, broken or not. */
export function pluginList(plugins: LoadedPlugin[] = loadPlugins(), enabled: ReadonlySet<string> = enabledIds(), ledgerFile: string = currentLedgerFile()): PluginInfo[] {
  if (pluginTrust() === 'companion') return companionList(plugins, enabled, path.join(path.dirname(ledgerFile), 'audit.json'));
  const found = new Set(plugins.map((p) => p.id));
  // An id named in plugins.enabled with nothing on disk: a typo or a removed plugin. Show it.
  const missing: PluginInfo[] = [...enabled].filter((id) => !found.has(id)).map((id) => (
    { id, name: id, version: '', harness: [], routes: false, help: false, tenant_aware: false, enabled: true, error: 'not found on disk', ratification: { state: 'unavailable' as const, digest: '', detail: 'not found on disk' } }));
  const listed = plugins.map((p) => {
    let m = p.manifest;
    const on = enabled.has(p.id);
    // From disk now, so the UI always shows the digest the person would be ratifying.
    let ratification = freshRatification(p, ledgerFile);
    // When ratified, what the list shows (name, version, routes) is the copy's manifest, the one that runs; the
    // live one only stands in while the plugin is not ratified. A copy with no usable manifest is not ok.
    if (m && ratification.state === 'ok' && ratification.snapshot) {
      const sm = snapshotManifest(p, ratification.snapshot);
      if ('error' in sm) { ratification = { state: 'unavailable', digest: ratification.digest, detail: sm.error }; p.ratification = ratification; }
      else m = sm.manifest;
    }
    // A scan error comes first; a plugin that is not ratified never imports, so it has no route error to show.
    const error = p.error ?? ratificationError(p.id, ratification) ?? routeErrorsLocal.get().get(p.id) ?? null;
    if (!m) return { id: p.id, name: p.id, version: '', harness: [], routes: false, help: false, tenant_aware: false, enabled: on, error, ratification };
    return {
      id: m.id, name: m.name, version: m.version, harness: m.harness,
      routes: !!m.routes, help: !!m.help, ...(m.ui && { ui: m.ui }), tenant_aware: m.tenant_aware,
      enabled: on, error, ratification,
    };
  });
  return [...listed, ...missing].sort((a, b) => a.id.localeCompare(b.id));
}

/** pluginList in companion mode: the live manifest, the import scan's findings as warnings, the audit summary. */
function companionList(plugins: LoadedPlugin[], enabled: ReadonlySet<string>, auditFile: string): PluginInfo[] {
  const found = new Set(plugins.map((p) => p.id));
  const missing: PluginInfo[] = [...enabled].filter((id) => !found.has(id)).map((id) => (
    { id, name: id, version: '', harness: [], routes: false, help: false, tenant_aware: false, enabled: true, error: 'not found on disk' }));
  const listed = plugins.map((p): PluginInfo => {
    const live = liveScan(p.dir, p.rootDir); // the manifest, the path checks and the import scan, from disk now
    p.manifest = live.manifest; p.error = live.error; p.warnings = live.warnings;
    const on = enabled.has(p.id);
    const digest = on && (live.manifest || live.error) ? auditPlugin(p, auditFile) : null; // a plugin that is not enabled is not audited
    const audit = digest === null ? null : auditSummary(auditFile, p.id);
    const error = p.error ?? routeErrorsLocal.get().get(p.id) ?? null;
    const m = live.manifest;
    if (!m) return { id: p.id, name: p.id, version: '', harness: [], routes: false, help: false, tenant_aware: false, enabled: on, error, warnings: live.warnings, audit };
    return {
      id: m.id, name: m.name, version: m.version, harness: m.harness,
      routes: !!m.routes, help: !!m.help, ...(m.ui && { ui: m.ui }), tenant_aware: m.tenant_aware,
      enabled: on, error, warnings: live.warnings, audit,
    };
  });
  return [...listed, ...missing].sort((a, b) => a.id.localeCompare(b.id));
}

/** One line per discovered plugin, at boot: id, enabled, error. */
export function logPluginInventory(plugins: LoadedPlugin[], enabled: ReadonlySet<string> = enabledIds()): void {
  for (const p of plugins) {
    console.log(`[plugins] ${p.id}: enabled=${enabled.has(p.id)} error=${p.error ?? 'none'}`);
    if (enabled.has(p.id) && pluginTrust() === 'person') noteRatification(p.id, p.ratification);
  }
  const found = new Set(plugins.map((p) => p.id));
  for (const id of enabled) if (!found.has(id)) console.warn(`[plugins] plugins.enabled names "${id}" but no plugin with that id is on disk (checked the shipped root and plugins.dir); nothing loads for it. Check the spelling.`);
}

/** plugin id -> help.md text (trimmed, capped). Enabled plugins only. */
export function pluginHelp(plugins: LoadedPlugin[] = loadPlugins(), enabled: ReadonlySet<string> = enabledIds()): Record<string, string> {
  const out: Record<string, string> = {};
  if (pluginsDisabled()) return out;
  const companion = pluginTrust() === 'companion';
  for (const p of plugins) {
    if (!enabled.has(p.id)) continue;
    let manifest: PluginManifest;
    let snapshot: string | undefined;
    if (companion) {
      auditPlugin(p);
      const lm = refreshLive(p);
      if ('error' in lm) continue;
      manifest = lm.manifest;
    } else {
      if (!p.manifest || p.error !== null) continue;
      const rat = freshRatification(p);
      if (rat.state !== 'ok' || !rat.snapshot) continue;
      const sm = snapshotManifest(p, rat.snapshot);
      if ('error' in sm) continue;
      manifest = sm.manifest;
      snapshot = rat.snapshot;
    }
    if (!manifest.help) continue;
    const f = locate(p, snapshot, manifest.help, 'help');
    if (f.error !== null) continue; // missing or escaping help.md: no topic; the list carries the error
    try {
      const text = readOwnOrApp(f.path).replace(/\r\n?/g, '\n').trim(); // a CRLF checkout must not leak \r into the topic
      if (text) out[p.id] = text.slice(0, HELP_MAX);
    } catch { /* unreadable: no topic */ }
  }
  return out;
}

/** What `api` gives a plugin's routes.mjs. */
export interface PluginApiBase {
  config: ReturnType<typeof getSanctumConfig>;
  log: (...a: unknown[]) => void;
  [k: string]: unknown;
}
/** What routes.mjs receives: the server's base api plus `express` and `Router`. A plugin in the
 *  person's own root sits outside the app's node_modules and cannot `import express`; it uses
 *  `api.Router()` (or `api.express`) instead, which is the same express the app mounts it with. */
export interface PluginApi extends PluginApiBase {
  express: typeof express;
  Router: typeof express.Router;
}

export interface PluginRouters { public?: Router; internal?: Router }

/** What a plugin's routes.mjs may return: an express.Router, or { public, internal } of them. */
const isSubApp = (x: any) => typeof x === 'function' && (typeof x.set === 'function' || typeof x.listen === 'function' || '_router' in x);
const isRouter = (x: any) => typeof x === 'function' && !isSubApp(x) && Array.isArray(x.stack) && typeof x.route === 'function' && typeof x.param === 'function' && typeof x.use === 'function';

function assertRouter(x: unknown, what: string): void {
  if (isRouter(x)) return;
  if (isSubApp(x)) throw new Error(`${what} is an express() app, not an express.Router(); sub-apps are not supported, return express.Router()`);
  throw new Error(`${what} must be an express.Router()`);
}

// ── Crash-proofing ───────────────────────────────────────────────────────────
// Express 4 does not look at the promise an async handler returns, so a rejection would be an
// unhandled rejection, which ends the process. Two layers keep a plugin from doing that:
//  1. guardRouter wraps every handler, error middleware and router.param callback so a
//     rejection reaches next(err). It runs on every dispatch, so routes a plugin registers after
//     import are wrapped too, and it is idempotent.
//  2. a process-level net for what layer 1 cannot see (a floating promise, a timer): each
//     plugin dispatch runs inside an AsyncLocalStorage context naming the plugin and the
//     response, and ONE unhandledRejection handler answers for rejections born inside one.
//     Rejections outside a plugin context are rethrown, as Node does by default.
interface PluginCtx { pluginId: string; res: Response }
const pluginCtx = new AsyncLocalStorage<PluginCtx>();
const failedResponses = new WeakSet<Response>();

/** Answer a failed plugin request once: log, then JSON 500, or end a response that already started. */
function failResponse(pluginId: string, res: Response, err: unknown): void {
  if (failedResponses.has(res)) return;
  failedResponses.add(res);
  try {
    console.error(`[plugins] ${pluginId}: handler failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: 'plugin_failed', plugin: pluginId });
    else res.end();
  } catch { /* the connection is gone */ }
}

/** The one unhandledRejection handler (named, so it can be found and counted). */
function sanctumPluginRejectionNet(reason: unknown): void {
  const store = pluginCtx.getStore();
  if (store) { failResponse(store.pluginId, store.res, reason); return; }
  // Not a plugin's: keep Node's default (raise it as an uncaught exception). Another listener
  // already suppresses that default for the whole process, so leave it to them.
  if (process.listenerCount('unhandledRejection') > 1) return;
  throw reason;
}
let netInstalled = false;
function installRejectionNet(): void {
  if (netInstalled) return;
  netInstalled = true;
  process.on('unhandledRejection', sanctumPluginRejectionNet);
}

const settle = (out: unknown, next: NextFunction) => {
  if (out && typeof (out as any).then === 'function') (out as Promise<unknown>).then(undefined, (e) => next(e));
};
/** A guarded copy of a handler, same arity so Express still tells them apart. */
function guardFn(fn: any, kind: 'handler' | 'error' | 'param'): any {
  if (fn.__sanctumGuarded) return fn;
  let g: any;
  if (kind === 'error') {
    g = function (this: unknown, err: unknown, req: Request, res: Response, next: NextFunction) {
      try { settle(fn.call(this, err, req, res, next), next); } catch (e) { next(e); }
    };
  } else if (kind === 'param') {
    g = function (this: unknown, req: Request, res: Response, next: NextFunction, val: unknown, name: string) {
      try { settle(fn.call(this, req, res, next, val, name), next); } catch (e) { next(e); }
    };
  } else {
    g = function (this: unknown, req: Request, res: Response, next: NextFunction) {
      try { settle(fn.call(this, req, res, next), next); } catch (e) { next(e); }
    };
  }
  g.__sanctumGuarded = true;
  return g;
}

function guardRouter(r: any, seen = new Set<unknown>()): void {
  if (!r || !Array.isArray(r.stack) || seen.has(r)) return;
  seen.add(r);
  const wrap = (layer: any) => {
    const fn = layer?.handle;
    if (typeof fn !== 'function') return;
    if (Array.isArray(fn.stack)) { guardRouter(fn, seen); return; } // a nested router: its own layers
    if (fn.__sanctumGuarded) return;
    layer.handle = guardFn(fn, fn.length === 4 ? 'error' : 'handler');
  };
  for (const layer of r.stack) {
    if (layer.route && Array.isArray(layer.route.stack)) layer.route.stack.forEach(wrap);
    else wrap(layer);
  }
  // router.param callbacks: { name: [fn, ...] }
  if (isObj(r.params)) {
    for (const [name, fns] of Object.entries(r.params)) {
      if (Array.isArray(fns)) (r.params as Record<string, unknown>)[name] = fns.map((f) => (typeof f === 'function' ? guardFn(f, 'param') : f));
    }
  }
}

/** A routes.mjs default export may return a Router (public), or `{ public, internal }`,
 *  or a Router with `internal: true` (the whole thing is internal). Shape only; importPluginRouters
 *  checks that what it finds really is an express.Router. */
export function normalizeRouters(result: unknown): PluginRouters {
  const r = result as any;
  if (typeof r === 'function') return r.internal === true ? { internal: r } : { public: r };
  if (isObj(r)) {
    const out: PluginRouters = {};
    if (typeof r.public === 'function') out.public = r.public as Router;
    if (typeof r.internal === 'function') out.internal = r.internal as Router;
    return out;
  }
  return {};
}

/** Import one plugin's routes.mjs and build its routers. This is the only place plugin code is
 *  imported in the backend process. `bust` (a reload) is appended as a query so Node evaluates
 *  the file again; the old instance stays in memory (ESM cannot evict it), and so does any
 *  dependency the file imports: a fixed dependency file needs a restart. */
export async function importPluginRouters(p: LoadedPlugin, baseApi: PluginApiBase, bust?: string, snapshot?: string): Promise<PluginRouters> {
  // The routes file named by the ratified copy's manifest when there is a copy (the live one is only for the list).
  let manifest = p.manifest;
  if (snapshot) {
    const sm = snapshotManifest(p, snapshot);
    if ('error' in sm) throw new Error(sm.error);
    manifest = sm.manifest;
  }
  if (!manifest?.routes) return {};
  // From the ratified copy when there is one: the bytes imported are the bytes that were hashed.
  const f = locate(p, snapshot, manifest.routes, 'routes');
  if (f.error !== null) throw new Error(f.error);
  const mod = await import(pathToFileURL(f.path).href + (bust ? `?reload=${encodeURIComponent(bust)}` : ''));
  if (typeof mod.default !== 'function') throw new Error(`${f.path}: default export must be (api) => express.Router()`);
  // Copied with its descriptors, not spread: in tenant mode `config` is a getter that answers for whichever tenant is asking, and a spread would freeze
  // the first caller's. (One module instance for every tenant; what differs per request is what the getter and req.tenant say.)
  const api = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(baseApi), express: { value: express, enumerable: true, writable: true, configurable: true }, Router: { value: express.Router, enumerable: true, writable: true, configurable: true } }) as PluginApi;
  const routers = normalizeRouters(await mod.default(api));
  if (!routers.public && !routers.internal) throw new Error(`${f.path}: the default export must return an express.Router() or { public, internal } routers`);
  if (routers.public) assertRouter(routers.public, 'the public router');
  if (routers.internal) assertRouter(routers.internal, 'the internal router');
  return routers;
}

export interface MountDeps {
  /** Session auth for the public side. */
  auth: RequestHandler;
  /** Internal-token gate for the internal side. */
  internalOnly: RequestHandler;
  /** The companion's write switch (agent.app_write). Applied to the internal side only. */
  writeGate: RequestHandler;
  api: PluginApiBase;
  plugins?: LoadedPlugin[];
  /** Ids allowed to mount routes. Default: plugins.enabled from config (companion mode reads it for every request). */
  enabled?: ReadonlySet<string>;
  /** Default: pluginsDisabledInfo(). When set, nothing mounts and GET / says so. */
  disabled?: DisabledReason | null;
  /** Which root, for `ledger_writable`; shown as `detail` by GET /. */
  disabledDetail?: string;
  /** The ratification ledger. Default: <plugins.ledger_dir>/ratified.json (<project>/data/plugins). The audit
   *  file (companion mode) is audit.json in the same folder. */
  ledger?: string;
  /** Default: pluginTrust(). */
  trust?: PluginTrust;
  /** Writes plugins.enabled to sanctum.yaml (PUT /enabled), and into the running config unless `memory` is false
   *  (person mode: the list is fixed at mount, a change applies on restart). Without it that route answers 501.
   *  The server passes writePluginsEnabled from plugin-config.ts. */
  setEnabled?: (ids: string[], opts?: { memory?: boolean }) => void;
}

/** A route check or reload refused because the code on disk is not the ratified code. */
class NotRatified extends Error {
  constructor(readonly plugin: string, readonly ratification: Ratification) { super(`plugin ${plugin} is ${ratification.state}`); }
}
/** A reload of a plugin whose ratified manifest names no routes: a 404, like an unknown plugin. */
class NoRoutes extends Error {}
const notRatifiedBody =(plugin: string, r: Ratification) =>
  ({ error: 'plugin_not_ratified', plugin, state: r.state, changes: r.changes ?? [], ...(r.detail && { detail: r.detail }) });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The largest file GET /:id/file returns as text. */
const FILE_VIEW_MAX = 256 * 1024;
const MAX_ENABLED = 100;

interface RouteState { dir: string; reload: () => Promise<PluginRouters>; dispatch: (side: 'public' | 'internal') => RequestHandler }

/** The import state and request dispatch of one plugin's routes. `companion` swaps the ratification check for the
 *  live folder: the manifest is read again from disk, nothing is gated, and a changed digest does not drop the router
 *  (only a reload does). */
function makeRouteState(p: LoadedPlugin, deps: MountDeps, ledgerFile: () => string, companion: boolean): RouteState {
  const id = p.id;
  // One import attempt, kept for good, success or failure. Only a reload replaces it, and a
  // reload that fails does not replace a router that is already working: `good` keeps serving.
  let loaded: Promise<PluginRouters> | undefined;
  let good: PluginRouters | undefined;
  let reloading: Promise<PluginRouters> | undefined;
  let latest = 0; // monotonically increasing id of the newest import attempt
  let servedDigest: string | undefined; // the ratified digest the newest import attempt was started under
  /** The same check the runs, the list and help use. Person mode: a full rehash of the live folder against the
   *  ledger. Companion mode: record the digest in the audit file, read the live manifest; 'unavailable' when it is unusable. */
  const verify = (): Ratification => {
    if (!companion) return freshRatification(p, ledgerFile());
    auditPlugin(p, path.join(dirname(ledgerFile()), 'audit.json'));
    const lm = refreshLive(p);
    return 'error' in lm ? { state: 'unavailable', digest: '', detail: lm.error } : { state: 'ok', digest: 'live' };
  };
  const attempt = (bust: string | undefined, snapshot: string | undefined): Promise<PluginRouters> => {
    const mine = ++latest;
    // Only the newest attempt may change state: a slow older import that finishes after a
    // reload must not put its router (or its error) over the newer one.
    const isLatest = () => mine === latest;
    const pr = importPluginRouters(p, deps.api, bust, snapshot).then(
      (r) => {
        if (isLatest()) { good = r; routeErrorsLocal.get().delete(id); }
        else console.debug(`[plugins] ${id}: discarded the result of stale import attempt #${mine} (attempt #${latest} is newer)`);
        return r;
      },
      (e) => {
        if (isLatest()) {
          routeErrorsLocal.get().set(id, `routes failed to load: ${errMsg(e)}${good ? ' (the previous version is still serving)' : ''} (fix it, then POST /api/plugins/${id}/reload; a fixed dependency file needs a restart)`);
          console.warn(`[plugins] ${id}: routes failed to load: ${errMsg(e)}${good ? '; the previous version is still serving' : ''}`);
        } else console.debug(`[plugins] ${id}: discarded the failure of stale import attempt #${mine} (attempt #${latest} is newer): ${errMsg(e)}`);
        throw e;
      },
    );
    pr.catch(() => { /* kept for the next request; nobody may be waiting on it yet */ });
    return pr;
  };
  const get = (digest: string, snapshot: string | undefined): Promise<PluginRouters> => {
    // The code was ratified again since this router was imported: the router in memory is the old
    // code, so drop it and import the new files (ESM keeps the old module; the query string busts it).
    if (servedDigest !== undefined && servedDigest !== digest) { good = undefined; loaded = undefined; }
    if (good) return Promise.resolve(good);
    if (!loaded) { servedDigest = digest; loaded = attempt(latest > 0 ? `${Date.now()}-${latest + 1}` : undefined, snapshot); }
    return loaded;
  };
  const reload = (): Promise<PluginRouters> => {
    let r: Ratification;
    let manifest: PluginManifest;
    if (companion) {
      r = verify();
      if (r.state !== 'ok' || !p.manifest) return Promise.reject(new Error(r.detail ?? 'manifest is unusable'));
      manifest = p.manifest;
    } else {
      if (p.error !== null || !p.manifest) return Promise.reject(new Error(p.error ?? 'manifest is unusable'));
      r = verify();
      if (r.state !== 'ok') return Promise.reject(new NotRatified(id, r));
      const sm = snapshotManifest(p, r.snapshot!);
      if ('error' in sm) return Promise.reject(new Error(sm.error));
      manifest = sm.manifest;
    }
    if (!manifest.routes) return Promise.reject(new NoRoutes()); // the manifest names no routes: nothing to reload
    if (reloading) return reloading; // a reload already under way answers for this one too
    servedDigest = r.digest;
    const pr = (reloading = attempt(`${Date.now()}-${latest + 1}`, r.snapshot));
    if (!good) loaded = pr; // nothing working yet: the outcome of this attempt is the state
    const clear = () => { if (reloading === pr) reloading = undefined; };
    pr.then(clear, clear);
    return pr;
  };
  const dispatch = (side: 'public' | 'internal'): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
    let ratified: Ratification;
    if (companion) {
      // After the auth gates and before any import: the live manifest, read now. An unusable one answers 503 with the reason.
      ratified = verify();
      if (ratified.state !== 'ok') { res.status(503).json({ error: 'plugin_unavailable', plugin: id, detail: ratified.detail }); return; }
    } else {
      // A plugin with a scan error serves nothing (the ratify route clears the error when the code is fixed).
      if (p.error !== null || !p.manifest) { if (side === 'internal') res.status(404).json({ error: 'Not found' }); else next(); return; }
      // After the auth gates (an unauthenticated request never costs a hash) and before any import.
      ratified = verify();
      if (ratified.state !== 'ok') { res.status(503).json(notRatifiedBody(id, ratified)); return; }
    }
    get(ratified.digest, ratified.snapshot).then((routers) => {
      const r = routers[side];
      // An internal path the plugin does not handle ends here (404), rather than falling
      // through to the public mount and answering as a session-auth failure.
      // Tenant mode: the plugin sees req.tenant = { id } and nothing else (never the runtime, its env, its token or its database). The runtime goes
      // back on the request when the plugin hands it on (miss) and when the response is over, for the code that reads it after.
      const owner = tenancyEnabled() ? req.tenant : undefined;
      if (owner) {
        req.tenant = Object.freeze({ id: owner.id }) as never;
        res.once('close', () => { req.tenant = owner; });
      }
      const miss: NextFunction = (err?: unknown) => {
        if (owner) req.tenant = owner;
        if (err) failResponse(id, res, err);
        else if (side === 'internal') res.status(404).json({ error: 'Not found' });
        else next();
      };
      if (!r) { miss(); return; }
      guardRouter(r); // every time: routes registered after import are wrapped too
      const enter = <T,>(fn: () => T): T => (owner ? runInTenant(owner, fn) : fn());
      enter(() => pluginCtx.run({ pluginId: id, res }, () => {
        try {
          settle((r as unknown as (q: Request, s: Response, n: NextFunction) => unknown)(req, res, miss), miss);
        } catch (e) { failResponse(id, res, e); }
      }));
    }, () => {
      if (!res.headersSent) res.status(503).json({ error: 'plugin_unavailable', plugin: id });
    });
  };
  return { dir: p.dir, reload, dispatch };
}

/** The router for `/api/plugins`. Must be mounted BEFORE the main api router, whose
 *  blanket session auth would otherwise answer the internal routes first.
 *   GET  /                  behind session auth: { trust, plugins } every discovered plugin, with enabled and error.
 *                           Person mode: each carries `ratification`. Companion mode: each carries `audit`
 *                           { digest, last_change_at, changed_since_last_view, changes } and `warnings`.
 *   PUT  /enabled           body { enabled: string[] }. Session auth (the person), or the internal token (the
 *                           companion; companion mode only, person mode answers 403 { error: 'trust_person' }).
 *                           Writes plugins.enabled to sanctum.yaml and applies it at once.
 *   POST /<id>/reload       session auth, or (companion mode) the internal token: import that plugin's routes.mjs once more
 *   POST /<id>/ratify       person mode. Behind session auth ONLY (never the internal token): body { digest };
 *                           records the plugin's current code as ratified when the digest still matches.
 *                           Companion mode answers 409 { error: 'trust_companion' }.
 *   POST /<id>/seen         companion mode, session auth: the person has looked at the code last recorded
 *                           (optional body { digest } must still be that digest). Person mode: 409 { error: 'trust_person' }.
 *   GET  /<id>/files        behind session auth: the plugin's files with sha256 and size, as on disk now
 *   GET  /<id>/file?path=   behind session auth: one of those files, { path, sha256, size, text }, or
 *                           { path, sha256, size, binary: true } (over 256 KiB, or not UTF-8)
 *   ALL  /<id>/internal/*   internalOnly, then the write gate on writes, then the plugin's internal router
 *   ALL  /<id>/*            session auth, then the plugin's public router (no write gate: the
 *                           gate limits what the companion does through the token, not the person)
 *  Person mode: only plugins in plugins.enabled at startup mount routes. The gates run before the plugin's
 *  code is imported, so an unauthenticated request never causes an import. routes.mjs is
 *  imported on the first request that passes them. A failed first import answers 503 and STAYS failed
 *  (no import per request, since each would leave a module instance behind) until the person
 *  POSTs /<id>/reload or the app restarts. A reload that fails keeps the previous working
 *  router serving; the failure is the reload's 503 and the list's `error`. A handler that throws or rejects answers a JSON 500.
 *  Before every first import, reload and request the plugin's code is checked against the ratified
 *  digest; a mismatch answers 503 plugin_not_ratified and imports nothing. A router imported from
 *  code that has since been re-ratified is dropped and imported again, never reused.
 *  Companion mode: plugins are dispatched by id on each request, from the live folder, when the id is in plugins.enabled
 *  NOW (404 otherwise), so a plugin enabled through PUT /enabled serves without a restart. The first import happens on
 *  the first request; after an edit, POST /<id>/reload imports the new code. */
export function createPluginMount(deps: MountDeps): Router {
  const router = express.Router();
  const trust: PluginTrust = deps.trust ?? pluginTrust();
  const companion = trust === 'companion';
  const info: DisabledInfo | null = deps.disabled !== undefined ? (deps.disabled ? { reason: deps.disabled, detail: deps.disabledDetail } : null) : (companion ? null : pluginsDisabledInfo(undefined, deps.ledger));
  const disabled = info?.reason ?? null;
  const hasInternalToken = (req: Request) => req.headers['x-internal-token'] !== undefined;
  const jsonBody: RequestHandler = (req, res, next) => {
    express.json({ limit: '4kb' })(req, res, (err?: unknown) => {
      if (err) { res.status(400).json({ error: 'bad_json', detail: 'send a JSON body, e.g. {"digest": "<sha256 from GET /api/plugins>"}' }); return; }
      next();
    });
  };
  const enabledNow = (): ReadonlySet<string> => (companion ? (deps.enabled ?? enabledIds()) : (enabledAtMount ?? enabledIds()));
  let enabledAtMount: ReadonlySet<string> | undefined;
  const plugins0 = (): LoadedPlugin[] => deps.plugins ?? loadPlugins();

  // PUT /enabled. Registered before everything else: it answers in both modes, and the plugin mounts below must not shadow it.
  // The person (session auth) may always set the list. The internal token may only in companion mode, and then through the write gate.
  router.put('/enabled', (req, res, next) => {
    if (!hasInternalToken(req)) { deps.auth(req, res, next); return; }
    deps.internalOnly(req, res, () => {
      if (!companion) { res.status(403).json({ error: 'trust_person' }); return; }
      deps.writeGate(req, res, next);
    });
  }, jsonBody, (req, res) => {
    const given = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (!Array.isArray(given) || given.length > MAX_ENABLED || given.some((x) => typeof x !== 'string' || !ID_RE.test(x))) {
      res.status(400).json({ error: 'enabled_required', detail: 'send {"enabled": ["<plugin id>", ...]}: plugin ids, each 1-32 lowercase letters, digits, - or _' });
      return;
    }
    if (!deps.setEnabled) { res.status(501).json({ error: 'not_supported' }); return; }
    const ids = [...new Set(given as string[])];
    try { deps.setEnabled(ids, { memory: companion }); } catch (e) {
      if (e instanceof TenantEditRefused) {
        // The tenant's own config would not survive this edit: the person's mistake, not the server's. One line, no stack, no absolute path.
        console.warn(`[plugins] plugins.enabled not written: ${e.message}`);
        res.status(400).json({ error: 'config_refused', detail: e.message });
        return;
      }
      console.error('[plugins] could not write plugins.enabled:', e);
      res.status(500).json({ error: 'config_write_failed', detail: errMsg(e) });
      return;
    }
    if (!companion) {
      // Person mode: the running list (rows, help, routes, GET flags) stays as mounted; the file applies on restart.
      console.log(`[plugins] plugins.enabled written as [${ids.join(', ')}]; applies on restart`);
      res.json({ ok: true, enabled: ids, applies: 'restart' });
      return;
    }
    if (!deps.plugins) rescanPlugins(); // the next run reads the new list; a plugin added meanwhile is found too
    const onDisk = new Set(plugins0().map((p) => p.id));
    console.log(`[plugins] plugins.enabled is now [${ids.join(', ')}]`);
    res.json({ ok: true, enabled: ids, unknown: ids.filter((id) => !onDisk.has(id)) });
  });

  if (info) {
    router.get('/', deps.auth, (_req, res) => { res.json({ trust, disabled, ...(info.detail && { detail: info.detail }), plugins: [] }); });
    return router; // nothing imports, nothing mounts, no net to install
  }
  installRejectionNet();
  if (!companion) {
    try { pruneSnapshots(deps.ledger ?? currentLedgerFile()); } catch (e) { console.warn(`[plugins] could not prune old ratified copies: ${errMsg(e)}`); }
  }
  const plugins = plugins0();
  enabledAtMount = deps.enabled ?? enabledIds();
  logPluginInventory(plugins, enabledNow());
  const gate: RequestHandler = (req, res, next) => (SAFE_METHODS.has(req.method) ? next() : deps.writeGate(req, res, next));
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const ledgerFile = () => deps.ledger ?? currentLedgerFile();
  const auditFile = () => path.join(dirname(ledgerFile()), 'audit.json');
  /** The plugin with this id. Companion mode looks again on disk when it is not in the scan (a plugin the companion just made). */
  const findPlugin = (id: string): LoadedPlugin | undefined => {
    if (!companion) return byId.get(id);
    let p = plugins0().find((x) => x.id === id);
    if (!p && !deps.plugins) { rescanPlugins(); p = loadPlugins().find((x) => x.id === id); }
    return p;
  };

  router.get('/', deps.auth, (_req, res) => {
    if (companion) {
      if (!deps.plugins) rescanPlugins(); // Settings was opened: look at the roots again, so a plugin the companion made is listed
      res.json({ trust, plugins: pluginList(plugins0(), enabledNow(), ledgerFile()) });
    } else res.json({ trust, plugins: pluginList(plugins, enabledNow(), ledgerFile()) });
  });

  const reloaders = new Map<string, () => Promise<PluginRouters>>();
  const states = new Map<string, RouteState>();
  /** Companion mode: the route state of a plugin that is enabled now, made on first use. */
  const stateFor = (id: string): RouteState | undefined => {
    if (!enabledNow().has(id)) return undefined;
    const p = findPlugin(id);
    if (!p) return undefined;
    let st = states.get(id);
    if (!st || st.dir !== p.dir) { st = makeRouteState(p, deps, ledgerFile, true); states.set(id, st); }
    return st;
  };
  // Registered before the per-plugin mounts below, so a plugin cannot shadow it. Session auth; in companion mode the
  // internal token too (through the write gate), so the companion can reload a plugin it just edited.
  const reloadAuth: RequestHandler = (req, res, next) => {
    if (!companion || !hasInternalToken(req)) { deps.auth(req, res, next); return; }
    deps.internalOnly(req, res, () => deps.writeGate(req, res, next));
  };
  router.post('/:id/reload', reloadAuth, (req, res) => {
    const id = String(req.params.id);
    const reload = companion ? stateFor(id)?.reload : reloaders.get(id);
    if (!reload) { res.status(404).json({ error: 'Not found' }); return; }
    reload().then(
      () => { res.json({ ok: true, plugin: id }); },
      (e) => {
        if (e instanceof NoRoutes) res.status(404).json({ error: 'Not found' });
        else if (e instanceof NotRatified) res.status(503).json(notRatifiedBody(id, e.ratification));
        else res.status(503).json({ error: 'plugin_unavailable', plugin: id, detail: errMsg(e) });
      },
    );
  });

  // Session auth only: the internal token must never be able to ratify, or the companion could bless its own edits.
  router.post('/:id/ratify', deps.auth, jsonBody, (req, res) => {
    const id = String(req.params.id);
    if (companion) { res.status(409).json({ error: 'trust_companion', detail: 'plugins.trust is "companion": there is nothing to ratify. Use "Mark as seen" (POST /api/plugins/:id/seen).' }); return; }
    const p = byId.get(id);
    if (!p) { res.status(404).json({ error: 'Not found' }); return; }
    // Judge the code on disk now, not the answer from boot: the manifest and the folder are read and scanned again.
    // The result also replaces the boot-time one, so a plugin that was fixed (or broken) since the start shows it.
    const live = liveScan(p.dir, p.rootDir);
    p.manifest = live.manifest;
    p.error = live.error;
    if (!live.manifest || live.error !== null) { res.status(409).json({ error: 'plugin_invalid', detail: live.error ?? 'manifest is unusable' }); return; }
    if (live.manifest.id !== id) { res.status(409).json({ error: 'plugin_invalid', detail: `the manifest id is now "${live.manifest.id}", not "${id}"; restart the app so it is listed under its new id` }); return; }
    const given = (req.body as { digest?: unknown } | undefined)?.digest;
    if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) {
      res.status(400).json({ error: 'digest_required', detail: 'send {"digest": "<sha256>"}: the ratification.digest GET /api/plugins showed you' });
      return;
    }
    let now;
    try { now = ratifyDirectory(ledgerFile(), id, p.dir, given, { writableRoots: scanRoots() }); } catch (e) {
      if (e instanceof DigestMismatch) {
        // A file changed between the person looking and tapping: never ratify blind. Say what differs from the ratified code.
        res.status(409).json({ error: 'digest_mismatch', expected: e.result.digest, changes: diffFiles(readLedger(ledgerFile()).plugins[id]?.files ?? {}, e.result.files) });
      } else if (e instanceof RatifyScanError) {
        res.status(409).json({ error: 'plugin_invalid', detail: e.message });
      } else {
        console.error(`[plugins] ${id}: could not ratify into ${dirname(ledgerFile())}:`, e);
        res.status(500).json({ error: 'ledger_write_failed', detail: errMsg(e) });
      }
      return;
    }
    const ok: Ratification = { state: 'ok', digest: now.digest, snapshot: snapshotDir(ledgerFile(), id, now.digest) };
    p.ratification = ok;
    noteRatification(id, ok);
    res.json({ ok: true, plugin: id, digest: now.digest, files: Object.keys(now.files).length });
  });

  // Companion mode: the person has looked at the code last recorded. Session auth only; the digest, when sent, must still be the
  // last recorded one, so what is marked as seen is what was on the screen.
  router.post('/:id/seen', deps.auth, jsonBody, (req, res) => {
    const id = String(req.params.id);
    if (!companion) { res.status(409).json({ error: 'trust_person', detail: 'plugins.trust is "person": ratify the plugin instead (POST /api/plugins/:id/ratify).' }); return; }
    const p = findPlugin(id);
    if (!p) { res.status(404).json({ error: 'Not found' }); return; }
    const given = (req.body as { digest?: unknown } | undefined)?.digest;
    if (given !== undefined && (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given))) {
      res.status(400).json({ error: 'digest_invalid', detail: 'send {"digest": "<audit.digest from GET /api/plugins>"} or no digest' });
      return;
    }
    if (!enabledNow().has(id)) { res.status(409).json({ error: 'plugin_not_enabled', detail: 'a plugin that is not enabled is not audited; enable it first' }); return; }
    const now = auditPlugin(p, auditFile()); // record what is on disk now first, so "seen" can never be older than the disk
    if (now === null) { res.status(409).json({ error: 'plugin_invalid', detail: 'the plugin folder cannot be hashed (a link inside it, or it is too big)' }); return; }
    if (!markSeen(auditFile(), id, given as string | undefined)) { res.status(409).json({ error: 'digest_mismatch', expected: now }); return; }
    res.json({ ok: true, plugin: id, digest: now });
  });

  router.get('/:id/files', deps.auth, (req, res) => {
    const p = findPlugin(String(req.params.id));
    if (!p) { res.status(404).json({ error: 'Not found' }); return; }
    try {
      const entries = scanTree(p.dir);
      const hashes = hashEntries(entries).files;
      res.json({ files: entries.map((e) => ({ path: e.path, sha256: hashes[e.path], size: e.size })) });
    } catch (e) { res.status(409).json({ error: 'plugin_invalid', detail: errMsg(e) }); }
  });

  // One file's text, so the person can read what they are about to ratify. The path must be one of the
  // tree's own relative paths (compared as strings against the listing, never resolved), so nothing
  // outside the folder is reachable however the path is spelled.
  router.get('/:id/file', deps.auth, (req, res) => {
    const p = findPlugin(String(req.params.id));
    if (!p) { res.status(404).json({ error: 'Not found' }); return; }
    const want = req.query.path;
    if (typeof want !== 'string' || want === '') { res.status(400).json({ error: 'path_required', detail: 'send ?path=<a path from GET /api/plugins/:id/files>' }); return; }
    let entry;
    try { entry = scanTree(p.dir).find((e) => e.path === want); } catch (e) { res.status(409).json({ error: 'plugin_invalid', detail: errMsg(e) }); return; }
    if (!entry) { res.status(404).json({ error: 'Not found' }); return; }
    let bytes: Buffer;
    try { bytes = readOwn(entry.abs, { shipped: true }); } catch (e) { res.status(409).json({ error: 'plugin_invalid', detail: errMsg(e) }); return; }
    const out = { path: entry.path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    if (bytes.length <= FILE_VIEW_MAX) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        res.json({ ...out, text }); return; // valid UTF-8 is text, a U+FFFD character in it or not
      } catch { /* not UTF-8 */ }
    }
    res.json({ ...out, binary: true });
  });

  if (companion) {
    // By id on each request: whatever is enabled now serves, whatever is not answers 404.
    const byIdSide = (side: 'public' | 'internal'): RequestHandler => (req, res, next) => {
      const st = stateFor(String(req.params.id));
      if (!st) { res.status(404).json({ error: 'Not found' }); return; }
      st.dispatch(side)(req, res, next);
    };
    router.use('/:id/internal', deps.internalOnly, gate, byIdSide('internal'));
    router.use('/:id', deps.auth, byIdSide('public'));
    return router;
  }

  for (const p of plugins) {
    if (!enabledNow().has(p.id)) continue; // routes mount for every enabled plugin; what a request does comes from the ratified copy's manifest
    const st = makeRouteState(p, deps, ledgerFile, false);
    reloaders.set(p.id, st.reload);
    const base = `/${p.id}`;
    router.use(`${base}/internal`, deps.internalOnly, gate, st.dispatch('internal'));
    router.use(base, deps.auth, st.dispatch('public'));
  }
  return router;
}
