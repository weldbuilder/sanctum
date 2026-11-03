// Reading the tenants block and one tenant's folder (docs/MULTI-TENANT.md, "What a tenant is, in the code").
//
//   <tenants.dir>/<id>/tenant.yaml   hosts and the tenant's sanctum.yaml subset
//   <tenants.dir>/<id>/.env          the tenant's keys, parsed here, never put into process.env
//
// Nothing a tenant says can reach the process: its env is a parsed object, the process-level keys (server, cors, tenants, updates) are
// refused, and the process environment is not an input (AGENT_MODEL exported in the shell does not become a tenant's model).
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { parse as parseDotenv } from 'dotenv';
import { SHIPPED_SCALARS, isInsideDir, pathProblems } from './confine.js';
import { PROJECT_ROOT, applyEnvOverrides, mergeConfigDefaults, resolveConfigPaths, type SanctumConfig } from '../config.js';
import { getProcessFile } from './context.js';
import { TenantEditRefused, readOwnIn, readOwnTextIn } from './own-files.js';
import { backgroundRunsProblems, INHERIT_TABLE, inheritedBase, inheritTableMarkdown, overlay, revienProblems } from '../../../../scripts/setup-inherit.mjs';

/** D11: what a tenant inherits from the operator's sanctum.yaml and what it never does. ONE table (scripts/setup-inherit.mjs, plain .mjs so
 *  `npm run setup` can read it too); the merge below, the wizard and the docs list all come from it. */
export { INHERIT_TABLE, inheritedBase, inheritTableMarkdown };

export const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function isTenantId(id: unknown): id is string { return typeof id === 'string' && TENANT_ID_RE.test(id); }

/** Keys that belong to the process, not to a tenant. Said in tenant.yaml they are ignored, with one warning. */
export const PROCESS_ONLY_KEYS = ['server', 'cors', 'tenants', 'updates'] as const;
/** Environment keys that only the process may set (where it listens, where its own database is). */
const PROCESS_ONLY_ENV = ['PORT', 'HOST', 'DB_PATH'];

/** A tenant's own files (docs/MULTI-TENANT.md, "A tenant's own files"). The write site is the wall (own-files.ts); this is the scan at boot and at rt.reload():
 *  tenant.yaml, .env, .mcp.json, all of data/ and private/ and the top level of home/ must be real files and folders (no link, no second hard link),
 *  never refused on count (one log line above SCAN_LOG_ABOVE). ONE implementation shared with the wizard (scripts/own-files-lib.mjs), so there is nothing to keep in step. */
export { tenantFilesProblem, tenantsDirProblem, tenantHoldsAppProblem } from './own-files.js';
import { tenantFilesProblem } from './own-files.js';

export interface TenantsBlock {
  dir: string; default?: string;
  /** tenants.inherit: false turns D11 inheritance off (default on). */ inherit?: boolean;
  /** tenants.auth: `household` (one login, a path prefix per companion) or `per-tenant` (a hostname and a login per tenant). Present only when the file says it;
   *  an absent key is household (see `isHousehold`). Process-only, never inherited. */
  auth?: TenantsAuth;
}
export type TenantsAuth = 'household' | 'per-tenant';
/** The auth mode of a parsed tenants block: household unless the file says per-tenant. */
export function isHousehold(block: Pick<TenantsBlock, 'auth'> | null | undefined): boolean { return !!block && block.auth !== 'per-tenant'; }

/** The `tenants:` block of the process config (as loaded, still holding it), or null when there is none. A malformed block throws. */
export function parseTenantsBlock(cfg: unknown, base: string = PROJECT_ROOT): TenantsBlock | null {
  const raw = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).tenants : undefined;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tenants: must be a mapping with a `dir:`');
  const t = raw as Record<string, unknown>;
  if (typeof t.dir !== 'string' || !t.dir.trim()) throw new Error('tenants.dir: is required (the folder that holds one folder per tenant)');
  const d = t.dir.trim();
  const out: TenantsBlock = { dir: resolve(base, d === '~' ? homedir() : d.startsWith('~/') || d.startsWith('~\\') ? join(homedir(), d.slice(2)) : d) };
  if (t.default !== undefined && t.default !== null && t.default !== '') {
    if (!isTenantId(t.default)) throw new Error(`tenants.default: ${JSON.stringify(t.default)} is not a tenant id (${TENANT_ID_RE.source})`);
    out.default = t.default;
  }
  if (t.inherit !== undefined && t.inherit !== null) {
    if (typeof t.inherit !== 'boolean') throw new Error('tenants.inherit: must be true or false');
    out.inherit = t.inherit;
  }
  if (t.auth !== undefined && t.auth !== null) {
    if (t.auth !== 'household' && t.auth !== 'per-tenant') throw new Error(`tenants.auth: must be household or per-tenant (got ${JSON.stringify(t.auth)})`);
    out.auth = t.auth;
  }
  if (t.background_runs !== undefined && t.background_runs !== null && typeof t.background_runs !== 'boolean') throw new Error('tenants.background_runs: must be true or false');
  return out;
}

/** The tenant ids found in `dir`: sub-folders whose name is a valid id, sorted (readdir order differs between platforms). */
export function listTenants(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`tenants.dir ${dir} does not exist`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isTenantId(e.name))
    .map((e) => e.name)
    .sort();
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$/;

function parseHosts(id: string, raw: unknown, quiet = false): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') { if (!quiet) console.warn(`[tenancy] tenant ${id}: hosts: is one hostname, not a list; read as a list of one`); raw = [raw]; }
  if (!Array.isArray(raw)) throw new Error(`tenant ${id}: hosts: must be a list of hostnames`);
  const out: string[] = [];
  for (const h of raw) {
    const host = typeof h === 'string' ? h.trim().toLowerCase() : '';
    if (!HOST_RE.test(host)) throw new Error(`tenant ${id}: hosts: ${JSON.stringify(h)} is not a bare hostname (no scheme, port or path)`);
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/** Two tenants must not claim one host; `default` must name a tenant that exists. Boot errors, both. */
export function checkHostClaims(tenants: { id: string; hosts: string[] }[], defaultId?: string): void {
  const owner = new Map<string, string>();
  for (const t of tenants) {
    for (const h of t.hosts) {
      const prior = owner.get(h);
      if (prior !== undefined) throw new Error(`host ${h} is claimed by both tenant ${prior} and tenant ${t.id}`);
      owner.set(h, t.id);
    }
  }
  if (defaultId !== undefined && !tenants.some((t) => t.id === defaultId)) {
    throw new Error(`tenants.default is ${defaultId}, but there is no tenant folder with that id`);
  }
}

export interface LoadedTenantConfig {
  config: SanctumConfig;
  /** The tenant's .env, parsed, without APP_PASSWORD (that is in config.auth.password and goes no further). */
  env: Record<string, string>;
  hosts: string[];
}

const warnedRevienSwitch = new Set<string>();
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One of the tenant's own files (tenant.yaml, .env), read through the guarded open (the same one every tenant read uses: no link followed, a pipe that was swapped
 *  in after the folder check is refused instead of waited on). A refusal is a boot/reload error naming the tenant. */
function readTenantFile(tenantDir: string, path: string, label: string, text: true): string;
function readTenantFile(tenantDir: string, path: string, label: string, text: false): Buffer;
function readTenantFile(tenantDir: string, path: string, label: string, text: boolean): string | Buffer {
  try { return text ? readOwnTextIn(tenantDir, path) : readOwnIn(tenantDir, path); }
  catch (e) { if (e instanceof TenantEditRefused) throw new Error(`tenant ${label}: ${e.message}`); throw e; }
}

/** Load <tenantDir>/tenant.yaml and <tenantDir>/.env over the shipped defaults. `processCfg` is the already loaded process config: it
 *  supplies what a tenant may not set (server, cors, updates) and the shipped prompt files. Paths default into the tenant folder. */
export function loadTenantConfig(processCfg: SanctumConfig, tenantDir: string, id: string = '', opts: { fileCfg?: unknown; quiet?: boolean; processFile?: Record<string, unknown> | null } = {}): LoadedTenantConfig {
  const label = id || tenantDir;
  // A tenant's own files are its own (a link or a second hard link would hand the process's or another tenant's files to it): refused before anything is read.
  const filesBad = tenantFilesProblem(tenantDir);
  if (filesBad) throw new Error(`tenant ${label}: ${filesBad}`);
  const yamlPath = join(tenantDir, 'tenant.yaml');
  let fileCfg: Record<string, unknown> = {};
  if (opts.fileCfg !== undefined) {
    // A candidate tenant.yaml (a dry run before it is saved): same checks, nothing read from disk.
    if (opts.fileCfg === null || typeof opts.fileCfg !== 'object' || Array.isArray(opts.fileCfg)) throw new Error(`tenant ${label}: tenant.yaml must be a mapping`);
    fileCfg = opts.fileCfg as Record<string, unknown>;
  } else if (existsSync(yamlPath)) {
    const loaded = yaml.load(readTenantFile(tenantDir, yamlPath, label, true));
    if (loaded !== undefined && loaded !== null && (typeof loaded !== 'object' || Array.isArray(loaded))) throw new Error(`tenant ${label}: tenant.yaml must be a mapping`);
    fileCfg = (loaded as Record<string, unknown>) || {};
  }
  const envPath = join(tenantDir, '.env');
  const dotenv: Record<string, string> = existsSync(envPath) ? parseDotenv(readTenantFile(tenantDir, envPath, label, false)) : {};

  const refused = PROCESS_ONLY_KEYS.filter((k) => k in fileCfg);
  if (refused.length && !opts.quiet) console.warn(`[tenancy] tenant ${label}: tenant.yaml sets ${refused.join(', ')}, which belong to the process; ignored`);
  const hosts = parseHosts(label, fileCfg.hosts, opts.quiet);
  const own: Record<string, unknown> = { ...fileCfg };
  for (const k of [...PROCESS_ONLY_KEYS, 'hosts']) delete own[k];

  // A list key written as one string is a list of one.
  const listOf = (obj: Record<string, unknown>, k: string) => { if (typeof obj[k] === 'string') obj[k] = [obj[k]]; };
  for (const [group, key] of [['hooks', 'extra_write_paths'], ['hooks', 'safe_write_prefixes']] as const) {
    if (own[group] && typeof own[group] === 'object') { own[group] = { ...(own[group] as Record<string, unknown>) }; listOf(own[group] as Record<string, unknown>, key); }
  }
  const rawBad = pathProblems(own, tenantDir, { shipped: true });
  if (rawBad.length) throw new Error(`tenant ${label}: ${rawBad.join(', ')} must be inside the tenant folder`);
  // D11: the base is the shipped defaults plus the operator's FILE values minus the never-inherited keys (the process environment is no input
  // here, and neither is the operator's .env: the file as read is). tenant.yaml goes on top. tenants.inherit: false leaves just the defaults.
  const inheriting = (processCfg as unknown as { tenants?: { inherit?: unknown } }).tenants?.inherit !== false;
  const base = inheriting ? inheritedBase(opts.processFile !== undefined ? opts.processFile : getProcessFile()) : {};
  const combined = overlay<Record<string, unknown>>(base, own);
  const bgBad = backgroundRunsProblems(combined)[0];
  if (bgBad) throw new Error(`tenant ${label}: ${bgBad}`);
  const merged = mergeConfigDefaults(combined);
  const has = (...p: string[]): boolean => {
    let v: unknown = own;
    for (const k of p) { v = obj(v)[k]; if (v === undefined || v === null) return false; } // (~ means "not set by the tenant": the default applies)
    return typeof v !== 'string' || v.trim() !== '';
  };

  // Revien is one daemon with no tenant scope: in tenant mode it is off unless this tenant's own tenant.yaml turns it on (revien.url is never
  // inherited either), and two tenants on one address are both parked at boot (tenancy/revien.ts). A switch is a boolean: only `true` is on; `yes`,
  // "true", 1 and "false" are off, with one line (and refused by the dry run, the config editor and the wizard, which say the same words).
  const ownEnabled = obj(own.revien).enabled;
  const nonBoolean = ownEnabled !== undefined && ownEnabled !== null && typeof ownEnabled !== 'boolean';
  if (nonBoolean && opts.fileCfg !== undefined) throw new Error(`tenant ${label}: revien.enabled must be true or false`);
  if (nonBoolean) {
    merged.revien.enabled = false;
    if (!opts.quiet && !warnedRevienSwitch.has(`${label}`)) { warnedRevienSwitch.add(`${label}`); console.warn(`[tenancy] tenant ${label}: revien.enabled must be true or false; Revien stays off`); }
  } else if (ownEnabled !== true) merged.revien.enabled = false;
  // A tenant that turns Revien on names its own address, and never the process's (the operator's url or the shipped default, in any spelling of
  // localhost): parked with one line (the tenant still loads). The same words are the wizard's refusal (tenantYamlProblems).
  else {
    const rp = revienProblems({ revien: { enabled: true, url: has('revien', 'url') ? merged.revien.url : '' } }, processCfg.revien?.url)[0];
    if (rp) {
      merged.revien.enabled = false;
      if (!opts.quiet) console.warn(`[tenancy] tenant ${label}: Revien parked, ${rp}`);
    } else merged.revien.enabled = true;
  }

  // The tenant folder is the default home of everything the tenant owns.
  if (!has('agent', 'cwd')) merged.agent.cwd = 'home';
  if (!has('discord', 'private_dir')) merged.discord.private_dir = 'private';
  if (!has('identity', 'ledger_dir')) merged.identity.ledger_dir = 'data/identity';
  if (!has('plugins', 'ledger_dir')) merged.plugins.ledger_dir = 'data/plugins';

  // What the process env would have said never reaches the tenant: only the tenant's own .env is an input here.
  const tenantEnv: Record<string, string | undefined> = { ...dotenv };
  for (const k of PROCESS_ONLY_ENV) delete tenantEnv[k];
  applyEnvOverrides(merged, tenantEnv);

  resolveConfigPaths(merged, tenantDir, combined, tenantEnv);
  // resolveConfigPaths leaves the write roots as written; here a relative one is the tenant folder's, never the process's working folder.
  const h = merged.hooks;
  const here = (p: string) => (p && typeof p === 'string' ? resolve(tenantDir, p) : p);
  h.workspace_root = here(h.workspace_root);
  h.vault_path = here(h.vault_path);
  h.extra_write_paths = (h.extra_write_paths || []).map(here);
  h.safe_write_prefixes = (h.safe_write_prefixes || []).map(here);

  // The database is the tenant's, at a fixed place; the process's listen address and the update settings are the process's.
  merged.server = { ...processCfg.server, db_path: resolve(tenantDir, 'data', 'sanctum.db') };
  (merged as unknown as Record<string, unknown>).cors = JSON.parse(JSON.stringify(processCfg.cors ?? {}));
  merged.updates = JSON.parse(JSON.stringify(processCfg.updates ?? merged.updates));

  // Files that ship with the app resolve from the app, not from the tenant folder, unless the tenant named its own.
  for (const path of SHIPPED_SCALARS.map((k) => k.split('.'))) {
    if (has(...path)) continue;
    let from: unknown = processCfg;
    let to: Record<string, unknown> = merged as unknown as Record<string, unknown>;
    for (const k of path.slice(0, -1)) { from = obj(from)[k]; to = obj(to[k]); }
    const leaf = path[path.length - 1];
    if (typeof obj(from)[leaf] === 'string') to[leaf] = obj(from)[leaf];
  }
  // The app's own working files default beside the tenant's home, never to the process's.
  if (!has('agent', 'claude_md_path')) merged.agent.claude_md_path = join(merged.agent.cwd, 'CLAUDE.md');
  if (!has('agent', 'mcp_json_path')) merged.agent.mcp_json_path = join(tenantDir, '.mcp.json');
  // The Claude frame is the tenant's own copy in its home (shipped with every new home, editable from Settings). A key the tenant never wrote gets that
  // path; an explicit "" stays "" (the claude_code preset). A raw check, not has(): has() reads "" as unset.
  const ownFrame = obj(own.agent).system_prompt_file;
  if (ownFrame === undefined || ownFrame === null) merged.agent.system_prompt_file = join(merged.agent.cwd, 'config', 'companion-claude.md');

  // D4: one process, one timezone. A tenant that names a different one is refused until the local-time sites are audited.
  const processTz = processCfg.identity?.timezone;
  if (!has('identity', 'timezone') && !tenantEnv.TZ) merged.identity.timezone = processTz;
  else if (processTz && merged.identity.timezone !== processTz) {
    throw new Error(`tenant ${label}: identity.timezone ${JSON.stringify(merged.identity.timezone)} differs from the process timezone ${JSON.stringify(processTz)}; one process runs on one clock (see docs/MULTI-TENANT.md)`);
  }

  // Whatever the .env or the defaults added: every path the tenant owns must now be inside its folder.
  const bad = pathProblems(merged, tenantDir, { shipped: false });
  if (bad.length) throw new Error(`tenant ${label}: ${bad.join(', ')} resolve outside the tenant folder`);
  // The wake prompts folder, when it is the tenant's own and lives outside data/ and private/, is walked like them (no link, no pipe, no second hard link).
  const wakeDir = merged.orchestrator?.wake_prompts_dir;
  if (wakeDir && isInsideDir(tenantDir, wakeDir)) {
    const wakeBad = tenantFilesProblem(tenantDir, { only: true, extra: [wakeDir] });
    if (wakeBad) throw new Error(`tenant ${label}: ${wakeBad}`);
  }

  // The login password: this tenant's, from its own .env (else its tenant.yaml). Held in config only, never in an environment.
  const password = dotenv.APP_PASSWORD;
  if (password) merged.auth.password = password;
  const env = { ...dotenv };
  delete env.APP_PASSWORD;

  return { config: merged, env, hosts };
}

/** The hosts a tenant.yaml names, read as loosely as possible (a tenant that failed to load still owns its hosts). Never throws. */
export function readHostsLoosely(tenantDir: string): string[] {
  const clean = (list: string[]) => list.map((h) => h.trim().replace(/^["']|["']$/g, '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  let text = '';
  try { text = readOwnTextIn(tenantDir, join(tenantDir, 'tenant.yaml')); } catch { return []; }
  try {
    const raw = yaml.load(text);
    const hosts = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).hosts : undefined;
    if (Array.isArray(hosts)) return clean(hosts.filter((h): h is string => typeof h === 'string'));
    if (typeof hosts === 'string') return clean([hosts]);
    if (hosts !== undefined) return [];
  } catch { /* malformed: scan the text for the hosts: key */ }
  const inline = /^hosts:\s*\[([^\]]*)\]/m.exec(text);
  if (inline) return clean(inline[1].split(','));
  const block = /^hosts:\s*\r?\n((?:[ \t]*-[^\n]*\n?)*)/m.exec(text);
  return block ? clean(block[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-\s*/, '')).filter((l) => /^[\w.\-"'\[\]:]+$/.test(l.trim()))) : [];
}

/** The folders a tenant.yaml declares the companion may write, read as loosely as possible, for a tenant that failed to load: a half-loaded
 *  tenant's home must still be off limits to the others. Relative paths resolve against the tenant folder; the defaults are home/ and private/.
 *  Returns a partial config (enough for writableRoots). Never throws. */
export function readRootsLoosely(tenantDir: string): SanctumConfig {
  let raw: Record<string, any> = {};
  try {
    const loaded = yaml.load(readOwnTextIn(tenantDir, join(tenantDir, 'tenant.yaml')));
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) raw = loaded as Record<string, any>;
  } catch { /* unreadable: the defaults below still protect home/ and private/ */ }
  // Only roots that really resolve (links followed) inside this tenant's own folder count: a skipped tenant's yaml may point anywhere, and a
  // root that lands in another tenant's data/ would make the union refuse that tenant's own ledger.
  const inside = (p: string) => isInsideDir(tenantDir, p);
  const at = (v: unknown, dflt: string): string => { const p = resolve(tenantDir, typeof v === 'string' && v.trim() ? v.trim() : dflt); return inside(p) ? p : ''; };
  const list = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []).map((x) => resolve(tenantDir, x)).filter(inside);
  return {
    agent: { cwd: at(raw.agent?.cwd, 'home'), provider: raw.agent?.provider, codex: { additional_directories: list(raw.agent?.codex?.additional_directories) } },
    hooks: { workspace_root: raw.hooks?.workspace_root ? at(raw.hooks.workspace_root, '') : undefined, vault_path: raw.hooks?.vault_path ? at(raw.hooks.vault_path, '') : undefined, extra_write_paths: list(raw.hooks?.extra_write_paths), safe_write_prefixes: list(raw.hooks?.safe_write_prefixes) },
    discord: { private_dir: at(raw.discord?.private_dir, 'private') },
    plugins: { dir: raw.plugins?.dir ? at(raw.plugins.dir, '') : undefined },
  } as unknown as SanctumConfig;
}
