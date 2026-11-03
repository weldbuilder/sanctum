// setup-inherit.mjs — what a tenant inherits from the operator's sanctum.yaml (docs/MULTI-TENANT.md, "What a tenant inherits").
//
// ONE table. The backend reads it (packages/backend/src/tenancy/config.ts re-exports it and merges by it), the setup wizard reads it to
// write only what differs from the inherited base, and the docs list is generated from it (a test asserts the doc and the table agree).
// It is plain .mjs because `npm run setup` runs under plain node and cannot import the backend's TypeScript.
//
// The base a tenant starts from is: the shipped defaults, plus the values the operator's sanctum.yaml FILE holds (never the environment, never
// the .env), minus every `never` row below; the tenant's own tenant.yaml goes on top. A mapping merges key by key, a list the tenant names
// replaces the operator's list. A key the table does not name is inherited (the table lists what is NOT).
import dotenv from 'dotenv';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { OWNED_PATH_LISTS, OWNED_PATH_SCALARS, SHIPPED_PATH_SCALARS, namedPathInsideTenant, nativeReal, ownReadFile } from './own-files-lib.mjs';

const require = createRequire(import.meta.url);

/** @typedef {{ paths: string[], inherit: boolean, why: string }} InheritRow */

/** @type {readonly InheritRow[]} */
export const INHERIT_TABLE = Object.freeze([
  // ── inherited ──────────────────────────────────────────────────────────────
  { inherit: true, paths: ['agent.provider', 'agent.model', 'agent.model_autonomous'], why: 'model and provider' },
  { inherit: true, paths: ['agent.auto_compact', 'agent.harness_memory', 'agent.app_write', 'agent.dsh.*', 'agent.codex.*', 'agent.rolling.*'], why: 'agent settings that are not paths (sandbox mode, rolling context, per-harness models)' },
  { inherit: true, paths: ['tools'], why: 'tool settings' },
  { inherit: true, paths: ['orchestrator.enabled', 'orchestrator.schedules', 'orchestrator.failsafe'], why: 'orchestrator cadence and schedules' },
  { inherit: true, paths: ['voice.*'], why: 'voice flags' },
  { inherit: true, paths: ['skins', 'appearance'], why: 'skins and appearance' },
  { inherit: true, paths: ['plugins.enabled', 'plugins.trust'], why: 'which plugins are on and who manages them' },
  { inherit: true, paths: ['command_center.*', 'handoff.*', 'outlook.*'], why: 'Command Center, handoff and outlook settings' },
  { inherit: true, paths: ['discord.*', 'telegram.*', 'google.enabled'], why: 'channel switches and limits (the bots and their tokens are the tenant\'s own)' },
  { inherit: true, paths: ['(any other key)'], why: 'a key this table does not name is inherited, unless its name looks like a secret (the last row below)' },
  // ── never inherited ────────────────────────────────────────────────────────
  { inherit: false, paths: ['agent.cwd', 'agent.claude_md_path', 'agent.mcp_json_path', 'agent.system_prompt_file', 'agent.dsh.home', 'agent.dsh.command', 'agent.dsh.base_instructions_file', 'agent.codex.base_instructions_file', 'agent.codex.additional_directories', 'agent.rolling.summarizer_instructions_file'], why: 'a path: every tenant has its own folder' },
  { inherit: false, paths: ['hooks'], why: 'the write-gate roots are paths' },
  { inherit: false, paths: ['plugins.dir', 'plugins.ledger_dir', 'plugins_dir'], why: 'a path: the plugin root and ledger' },
  { inherit: false, paths: ['discord.private_dir', 'discord.public.exclusions_file', 'discord.gate.words_file', 'discord.gate.names_file'], why: 'a path: the private lists' },
  { inherit: false, paths: ['orchestrator.wake_prompts_path', 'orchestrator.wake_prompts_dir'], why: 'a path: the wake prompts folder' },
  { inherit: false, paths: ['identity'], why: 'who the tenant and the companion are, and where their identity ledger lives' },
  { inherit: false, paths: ['hosts'], why: 'the hostnames a tenant answers to' },
  { inherit: false, paths: ['auth', 'google.client_id', 'google.client_secret'], why: 'a secret: the login and the Google client belong to one tenant' },
  { inherit: false, paths: ['discord.owner_user_id', 'discord.owner', 'discord.public.guild_ids', 'discord.public.role_ids', 'telegram.owner_chat_id'], why: 'names one person or server: inheriting it would hand the operator (or another tenant) this tenant\'s companion' },
  { inherit: false, paths: ['integrations', 'revien'], why: 'names a person or server: the operator\'s life status address, browser seat and Mind, and the one Revien daemon, are not a tenant\'s; a tenant names its own, and Revien is off for a tenant until its own tenant.yaml turns it on' },
  { inherit: false, paths: ['server', 'cors', 'tenants', 'updates'], why: 'process-only: the listen address, CORS, the tenants block (tenants.inherit: false turns inheritance off) and update checks' },
  { inherit: false, paths: ['(a key named like a secret, in any section)'], why: 'a key whose name (any case) has as its last word (split on _, - or a camelCase boundary) key, keys, secret, secrets, token, tokens, password, passwords, passwd, passphrase, credential, credentials or pem, or contains api_key, apikey, private_key or privatekey, is stripped from the inherited base at every depth, whatever its section. A secret under any other name (auth_header, webhook_url, bearer, session_cookie) IS inherited: keep such values out of the operator file or name them so the rule catches them' },
]);

/** The last words that make a key name a secret (the last `never` row). */
const SECRET_LAST_WORDS = new Set(['key', 'keys', 'secret', 'secrets', 'token', 'tokens', 'password', 'passwords', 'passwd', 'passphrase', 'credential', 'credentials', 'pem']);

/** True when a config key's NAME looks like a secret (the last `never` row): its LAST word (split on `_`, `-` or a camelCase boundary) is one of
 *  SECRET_LAST_WORDS, or it contains api_key, apikey, private_key or privatekey. `monkey` is not `key`, `keyboard` is not `key`. Applied at every depth. */
export function isSecretKeyName(name) {
  const raw = String(name);
  const snake = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
  const lower = raw.toLowerCase();
  for (const n of [snake, lower]) if (n.includes('api_key') || n.includes('apikey') || n.includes('private_key') || n.includes('privatekey')) return true;
  const last = snake.split(/[_\s]+/).filter(Boolean).pop();
  return last !== undefined && SECRET_LAST_WORDS.has(last);
}

/** A copy of `node` without any mapping key whose name looks like a secret, at every depth (lists of mappings included). */
function stripSecretNames(node) {
  if (Array.isArray(node)) return node.map(stripSecretNames);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) if (!isSecretKeyName(k)) out[k] = stripSecretNames(v);
  return out;
}

/** The paths of every `never` row. */
export const NEVER_INHERITED = Object.freeze(INHERIT_TABLE.filter((r) => !r.inherit).flatMap((r) => r.paths));

/** A copy of `obj` without the value at the dotted `path` (a missing path is fine). */
function without(obj, path) {
  const keys = path.split('.');
  let at = obj;
  for (const k of keys.slice(0, -1)) {
    if (!at || typeof at !== 'object' || Array.isArray(at) || !Object.hasOwn(at, k)) return;
    at = at[k];
  }
  if (at && typeof at === 'object' && !Array.isArray(at)) delete at[keys[keys.length - 1]];
}

/** `inherit` is the reserved key a tenant.yaml uses (`inherit: false`); in the operator's file it means nothing and must never reach a tenant's config,
 *  so it is removed at every depth of the base (the tenant side is handled by overlay). */
function stripReservedKey(node) {
  if (Array.isArray(node)) { for (const v of node) stripReservedKey(v); return node; }
  if (!node || typeof node !== 'object') return node;
  delete node.inherit;
  for (const v of Object.values(node)) stripReservedKey(v);
  return node;
}

/** What a tenant inherits from `processFile` (the parsed sanctum.yaml, as read, no environment): a deep copy without any `never` path. */
export function inheritedBase(processFile) {
  if (!processFile || typeof processFile !== 'object' || Array.isArray(processFile)) return {};
  const copy = structuredClone(processFile);
  for (const p of NEVER_INHERITED) without(copy, p);
  return stripReservedKey(stripSecretNames(copy));
}

/** The table as the Markdown the docs carry between their `inherit-table` markers (a test keeps the page and this in step). */
export function inheritTableMarkdown() {
  const cell = (r) => r.paths.map((p) => `\`${p}\``).join(', ');
  const rows = (inherit) => INHERIT_TABLE.filter((r) => r.inherit === inherit).map((r) => `| ${cell(r)} | ${r.why} |`);
  return [
    '**Inherited** from the operator\'s `sanctum.yaml` (its file values only):', '', '| Keys | What |', '|---|---|', ...rows(true), '',
    '**Never inherited** (a tenant gets the default, or what its own `tenant.yaml` says):', '', '| Keys | Why |', '|---|---|', ...rows(false),
  ].join('\n');
}

// ── the wizard's side ────────────────────────────────────────────────────────

/** The tenant-id rule (packages/backend/src/tenancy/config.ts TENANT_ID_RE; a test keeps the two equal). */
export const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** What the wizard writes into a config that the shipped defaults already say (packages/backend/src/config.ts DEFAULTS; a test keeps them equal).
 *  A value the wizard answers with that equals the inherited base, or this default when the base is silent, is left out of tenant.yaml. */
export const WIZARD_DEFAULTS = Object.freeze({
  'agent.provider': 'claude', 'agent.model': 'claude-sonnet-5-5', 'agent.app_write': true, 'agent.harness_memory': false,
  'agent.codex.model': '', 'agent.codex.model_provider': '', 'agent.codex.sandbox_mode': 'workspace-write', 'agent.codex.additional_directories': [],
  'agent.rolling.claude': true, 'agent.rolling.codex': true, 'agent.rolling.dsh': true, 'agent.rolling.model': '', 'agent.rolling.model_provider': '',
  'command_center.enabled': false, 'plugins.trust': 'companion', 'plugins.enabled': [], 'revien.enabled': true,
});

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dig = (o, path) => path.split('.').reduce((v, k) => (isMap(v) ? v[k] : undefined), o);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `cfg` (a whole config the wizard built) reduced to what differs from `base` (the inherited values) and WIZARD_DEFAULTS. Kept always: the
 *  identity group and hosts (the tenant's own), and whatever neither the base nor the defaults say. `drop` lists dotted paths whose value
 *  is the tenant folder's own default and is left out (agent.cwd = <tenant>/home). `defaults` is what an unset key means (WIZARD_DEFAULTS; a tenant's
 *  differ for revien.enabled). Empty mappings are removed. */
export function pruneToDifferences(cfg, base, drop = [], defaults = WIZARD_DEFAULTS) {
  const walk = (node, path) => {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (p === 'identity' || p === 'hosts') { out[k] = v; continue; }
      if (isMap(v)) { const child = walk(v, p); if (Object.keys(child).length) out[k] = child; continue; }
      if (drop.includes(p)) continue;
      const inherited = dig(base, p);
      const fallback = inherited !== undefined ? inherited : defaults[p];
      if (fallback !== undefined && same(fallback, v)) continue;
      out[k] = v;
    }
    return out;
  };
  return walk(cfg, '');
}

/** `over` (a tenant.yaml) laid on `base` (the inherited values): mappings merge key by key, anything else (a list included) replaces.
 *  Three ways to take something away. A key set to null (`~`), at any depth, means "this key is not set by the tenant and not inherited": the
 *  default applies (the key is removed whether or not the base had it). A mapping set to an empty mapping `{}` replaces the inherited mapping with
 *  an empty one. A mapping holding the reserved key `inherit: false` replaces the inherited mapping with the rest of its keys (the same as `{}`
 *  plus them); the key itself is never in the result, at any depth, and at the top it turns the whole inherited base off. Neither argument is changed. */
export function overlay(base, over) {
  if (!isMap(over)) return structuredClone(over === undefined ? base : over);
  let from = isMap(base) ? base : {};
  let rest = over;
  if (over.inherit === false) { from = {}; rest = { ...over }; delete rest.inherit; }
  const out = structuredClone(from);
  for (const [k, v] of Object.entries(rest)) {
    if (v === null) delete out[k];
    else if (isMap(v) && Object.keys(v).length === 0) out[k] = {};
    else if (isMap(v)) out[k] = overlay(out[k], v);
    else out[k] = structuredClone(v);
  }
  return out;
}

/** The markers a tenant.yaml holds that take inherited values away, as { path, value } rows (parents before children), so a rewrite keeps them:
 *  a key set to null (`~`), a mapping set to {}, and a mapping holding `inherit: false` (value `{ inherit: false }`; an `inherit: false` at the top
 *  has the path []). */
export function removalMarkers(tenantYaml) {
  const rows = [];
  const walk = (node, path) => {
    if (node.inherit === false) rows.push({ path, value: { inherit: false } });
    for (const [k, v] of Object.entries(node)) {
      const p = [...path, k];
      if (v === null) rows.push({ path: p, value: null });
      else if (isMap(v) && Object.keys(v).length === 0) rows.push({ path: p, value: {} });
      else if (isMap(v)) walk(v, p);
    }
  };
  if (isMap(tenantYaml)) walk(tenantYaml, []);
  return rows;
}

/** A copy of `base` without what the markers took away (a null key, a replaced mapping, or everything for a top-level `inherit: false`): the base the
 *  tenant's own values are to be compared with when a rewrite decides what to keep. */
export function withoutMarked(base, rows) {
  if (rows.some((r) => r.path.length === 0)) return {};
  const out = structuredClone(isMap(base) ? base : {});
  for (const { path } of rows) without(out, path.join('.'));
  return out;
}

/** `own` with the markers `rows` (removalMarkers) put back where a rewrite pruned them (a value the answers set meanwhile wins). A marker over a
 *  mapping the rewrite writes into stays meaningful: the mapping gets `inherit: false` (so `agent: ~` plus written values never turns into a mapping that
 *  inherits again). With `base` (the inherited values), a null marker over a key the base does not hold is dropped: it says nothing. */
export function withRemovalMarkers(own, rows, base) {
  let out = structuredClone(own);
  for (const { path, value } of rows) {
    if (path.length === 0) { out = { inherit: false, ...out }; continue; }
    const held = base === undefined ? true : dig(base, path.join('.')) !== undefined;
    if (value === null && !held) continue;
    let at = out;
    for (const k of path.slice(0, -1)) { if (!isMap(at[k])) at[k] = {}; at = at[k]; }
    const leaf = path[path.length - 1];
    const cur = at[leaf];
    if (cur === undefined) at[leaf] = structuredClone(value);
    else if (isMap(cur) && Object.keys(cur).length === 0) at[leaf] = structuredClone(value);
    else if (isMap(cur) && cur.inherit !== false && (held || value !== null)) at[leaf] = { inherit: false, ...cur };
  }
  return out;
}

// ── a tenant's folder, as the wizard sees it ─────────────────────────────────

/** Where the operator's config may live (packages/backend/src/config.ts CONFIG_FILE_NAMES). */
const PROCESS_FILES = ['sanctum.yaml', 'sanctum.yml', 'config/sanctum.yaml', 'resonant.yaml', 'resonant.yml', 'config/resonant.yaml'];

/** The path of the operator's config file in `root` (the first of PROCESS_FILES that exists), or '' when there is none. */
export function processFilePath(root) {
  return PROCESS_FILES.map((n) => join(root, n)).find((p) => existsSync(p)) || '';
}

/** The operator's sanctum.yaml in `root`, parsed ({} when there is none). */
export function readProcessFile(root) {
  const found = processFilePath(root);
  if (!found) return {};
  const loaded = require('js-yaml').load(readFileSync(found, 'utf-8'));
  return loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
}

const expandHome = (p, home = homedir()) => (p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p);

/** The tenants block of the process file: { dir, inherit } with `dir` absolute, or null when there is none. Throws on a block without a dir. */
export function tenantsBlockOf(root, processFile, homeDir = homedir()) {
  const t = processFile?.tenants;
  if (t === undefined || t === null) return null;
  if (!isMap(t) || typeof t.dir !== 'string' || !t.dir.trim()) throw new Error('tenants.dir: is required in sanctum.yaml (the folder that holds one folder per tenant)');
  // The same constraints as parseTenantsBlock (packages/backend/src/tenancy/config.ts); a test keeps the accepted values equal.
  const own = (k) => t[k] !== undefined && t[k] !== null;
  if (own('default') && t.default !== '' && !(typeof t.default === 'string' && TENANT_ID_RE.test(t.default))) throw new Error(`tenants.default: ${JSON.stringify(t.default)} is not a tenant id (${TENANT_ID_RE.source})`);
  if (own('inherit') && typeof t.inherit !== 'boolean') throw new Error('tenants.inherit: must be true or false');
  if (own('auth') && t.auth !== 'household' && t.auth !== 'per-tenant') throw new Error(`tenants.auth: must be household or per-tenant (got ${JSON.stringify(t.auth)})`);
  if (own('background_runs') && typeof t.background_runs !== 'boolean') throw new Error('tenants.background_runs: must be true or false');
  return { dir: resolve(root, expandHome(t.dir.trim(), homeDir)), inherit: t.inherit !== false, auth: t.auth ?? undefined, default: typeof t.default === 'string' && t.default !== '' ? t.default : undefined };
}

/** An install whose `tenants:` block has NO `auth` key is household by default, which drops hostnames, ignores tenants' own passwords and `tenants.default`, and
 *  opens every tenant with the process password. An install that shows signs of the per-tenant shape (a `default`, a tenant.yaml with `hosts:`, a tenant .env with
 *  APP_PASSWORD) must say which it wants: this returns the sentence that refuses the boot (and the wizard), or '' (the key is set, or there are no such signs). */
export function authKeyMissingProblem(tenantsDir, block) {
  if (block?.auth !== undefined && block?.auth !== null) return '';
  const signs = [];
  if (block?.default) signs.push('tenants.default is set');
  let entries = [];
  try { entries = readdirSync(tenantsDir, { withFileTypes: true }); } catch { /* no folder: nothing to look at */ }
  for (const e of entries.filter((x) => x.isDirectory() && TENANT_ID_RE.test(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (hostsOfFolderLoosely(join(tenantsDir, e.name)).length) signs.push(`tenant ${e.name} has hosts: in its tenant.yaml`);
    // Both files are read through the guarded open (no link, no pipe, no hard link: one tenant's folder never holds the boot); anything refused is "no sign" here,
    // and the own-files scan refuses that tenant on its own later.
    try { if (dotenv.parse(ownReadFile(join(tenantsDir, e.name), join(tenantsDir, e.name, '.env'), { encoding: 'utf-8' })).APP_PASSWORD) signs.push(`tenant ${e.name} has APP_PASSWORD in its .env`); } catch { /* no .env, or not the tenant's own */ }
  }
  if (!signs.length) return '';
  return `tenants.auth is not set, and this install looks per-tenant (${signs.slice(0, 3).join('; ')}${signs.length > 3 ? '; ...' : ''}). The default is household (one login, a /c/<id>/ path prefix per companion), which would drop those hostnames and passwords. Set tenants.auth to per-tenant (keep hostnames and a login per tenant) or household (one login for the house) in sanctum.yaml.`;
}

/** The harness homes a tenant's logins live in (packages/backend/src/tenancy/child.ts harnessHomes; a test keeps the two equal). */
export function harnessHomesFor(tenantDir) {
  const h = join(tenantDir, 'data', 'harness');
  return { CLAUDE_CONFIG_DIR: join(h, 'claude'), CODEX_HOME: join(h, 'codex'), DSH_HOME: join(h, 'dsh') };
}

/** Everything the wizard reads and writes for one tenant, by the tenant folder's fixed layout. */
export function tenantPaths(tenantDir) {
  return {
    yamlPath: join(tenantDir, 'tenant.yaml'), envPath: join(tenantDir, '.env'), dbPath: join(tenantDir, 'data', 'sanctum.db'),
    home: join(tenantDir, 'home'), privateDir: join(tenantDir, 'private'), mcpJsonPath: join(tenantDir, '.mcp.json'),
    tmp: join(tenantDir, 'data', 'harness', 'tmp'), harness: harnessHomesFor(tenantDir),
  };
}

// (The rule for a path a tenant's config names, and the lists of path keys, are the backend's own: scripts/own-files-lib.mjs, namedPathInsideTenant and OWNED_PATH_*.)
/** Why the backend would skip a tenant that had this tenant.yaml (`cfg`), as sentences, or [] (a copy of the checks in tenancy/confine.ts
 *  tenantYamlEditProblem and tenancy/config.ts; tests run the real loader and boot checks over the same cases). `ctx` adds what the file alone
 *  does not say: { tenantsDir, tenantId } (a host another tenant folder already claims), { envText } (the tenant's .env: a path key that lands
 *  outside the folder, a TZ other than the process's). */
export function tenantYamlProblems(cfg, tenantDir, processTimezone, ctx = {}) {
  const out = [];
  for (const k of ['server', 'cors', 'tenants', 'updates']) if (dig(cfg, k) !== undefined) out.push(`${k}: belongs to the process and cannot be set in a tenant.yaml`);
  for (const k of [...OWNED_PATH_SCALARS, ...SHIPPED_PATH_SCALARS]) { const v = dig(cfg, k); if (typeof v === 'string' && v.trim() && !namedPathInsideTenant(tenantDir, v.trim())) out.push(`${k} must be inside the tenant folder`); }
  for (const k of OWNED_PATH_LISTS) { const v = dig(cfg, k); const l = typeof v === 'string' ? [v] : v; if (Array.isArray(l) && l.some((x) => typeof x === 'string' && x.trim() && !namedPathInsideTenant(tenantDir, x.trim()))) out.push(`${k} must be inside the tenant folder`); }
  const tz = dig(cfg, 'identity.timezone');
  if (processTimezone && typeof tz === 'string' && tz && tz !== processTimezone) out.push(`identity.timezone ${JSON.stringify(tz)} differs from the process timezone ${JSON.stringify(processTimezone)}; one process runs on one clock`);
  out.push(...hostsProblems(cfg?.hosts));
  if (ctx.tenantsDir && ctx.tenantId) {
    const claimed = tenantHostClaims(ctx.tenantsDir, ctx.tenantId);
    for (const h of hostList(cfg?.hosts)) if (claimed.has(h)) out.push(`host ${h} is already claimed by tenant ${claimed.get(h)}: two tenants cannot share a host`);
  }
  if (typeof ctx.envText === 'string') out.push(...tenantEnvProblems(ctx.envText, tenantDir, processTimezone));
  out.push(...revienProblems(cfg, ctx.processRevienUrl));
  out.push(...backgroundRunsProblems(cfg));
  return out;
}

/** The shipped Revien address (packages/backend/src/config.ts DEFAULTS.revien.url; a test keeps them equal). */
export const DEFAULT_REVIEN_URL = 'http://127.0.0.1:7437';

/** A Revien address reduced to what decides whether two of them reach one daemon: scheme, host, port. Hostname lower-cased without a trailing dot,
 *  userinfo, path and query dropped, the scheme's default port filled in, and every loopback form (localhost, 127.0.0.0/8 in any dotted or short form,
 *  [::1], [::ffff:127.x.x.x], 0.0.0.0, [::]) one token. Text that is not a URL is compared as lower-cased text. */
export function normaliseRevienAddress(url) {
  const text = String(url ?? '').trim();
  if (!text) return '';
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`); } catch { return text.toLowerCase(); }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '[::]' || (v4 && (v4[1] === '127' || /^0+$/.test(v4.slice(1).join('')))) || (mapped && (parseInt(mapped[1], 16) >> 8 === 127 || (parseInt(mapped[1], 16) === 0 && parseInt(mapped[2], 16) === 0)))) host = 'loopback';
  const port = u.port || (scheme === 'https' ? '443' : scheme === 'http' ? '80' : '');
  return `${scheme}://${host}:${port}`;
}

/** `background_runs` is a switch: only the booleans `true` and `false` (`no`, `off`, "false" and 0 are refused, never read as on). */
export function backgroundRunsProblems(cfg) {
  const v = cfg?.background_runs;
  return v === undefined || v === null || typeof v === 'boolean' ? [] : ['background_runs must be true or false'];
}

/** What a tenant's own `revien:` block must be (docs/MULTI-TENANT.md): a tenant that turns Revien on names its own address, and never the process's
 *  (the operator's configured url, else the shipped default). The loader parks Revien for such a tenant with one line; the wizard refuses to write it. */
export function revienProblems(cfg, processRevienUrl = DEFAULT_REVIEN_URL) {
  const r = cfg?.revien;
  // A switch is a boolean: `yes`, "true", 1 and "false" are all refused (they would be read as on by a plain truthiness test).
  if (isMap(r) && r.enabled !== undefined && r.enabled !== null && typeof r.enabled !== 'boolean') return ['revien.enabled must be true or false'];
  if (!isMap(r) || r.enabled !== true) return [];
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url) return ['revien.enabled needs the tenant\'s own revien.url: one Revien daemon has no tenant scope, so a tenant cannot use the process\'s'];
  if (normaliseRevienAddress(url) === normaliseRevienAddress(processRevienUrl || DEFAULT_REVIEN_URL)) return ['revien.url is the process\'s own Revien address: a tenant needs a daemon of its own'];
  return [];
}

/** What a tenant's own .env says that boot would refuse: an outside path in AGENT_CWD, WORKSPACE_ROOT, VAULT_PATH or EXTRA_WRITE_PATHS (they
 *  override the yaml), or a TZ that differs from the process's (D4). `envText` is the file as it is (or will be). */
export function tenantEnvProblems(envText, tenantDir, processTimezone) {
  const out = [];
  const e = dotenv.parse(String(envText || ''));
  for (const k of ['AGENT_CWD', 'WORKSPACE_ROOT', 'VAULT_PATH']) if (e[k] && !namedPathInsideTenant(tenantDir, e[k])) out.push(`${k} in the tenant .env must be inside the tenant folder`);
  if (e.EXTRA_WRITE_PATHS && e.EXTRA_WRITE_PATHS.split(',').map((s) => s.trim()).filter(Boolean).some((p) => !namedPathInsideTenant(tenantDir, p))) out.push('EXTRA_WRITE_PATHS in the tenant .env must be inside the tenant folder');
  if (e.TZ && processTimezone && e.TZ !== processTimezone) out.push(`TZ ${JSON.stringify(e.TZ)} in the tenant .env differs from the process timezone ${JSON.stringify(processTimezone)}; one process runs on one clock`);
  return out;
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$/;
/** '' when `host` is a bare hostname as tenant.yaml `hosts:` takes it, else the sentence. */
export function hostProblem(host) {
  const h = String(host || '').trim().toLowerCase();
  return !h || HOST_RE.test(h) ? '' : 'A host is a bare name like ada.example.net: no https://, port or path.';
}

/** The hosts a `hosts:` value names, the way the backend reads them (one string is a list of one; lower-cased and trimmed; no duplicates). */
function hostList(raw) {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  return [...new Set(list.filter((h) => typeof h === 'string').map((h) => h.trim().toLowerCase()).filter((h) => HOST_RE.test(h)))];
}

/** What boot's parseHosts would throw on, as sentences: a `hosts:` that is not a string or a list, and every entry that is not a bare hostname. */
export function hostsProblems(raw) {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list)) return ['hosts: must be a list of hostnames'];
  return list.filter((h) => !HOST_RE.test(typeof h === 'string' ? h.trim().toLowerCase() : '')).map((h) => `hosts: ${JSON.stringify(h)} is not a bare hostname (no scheme, port or path)`);
}

/** host -> tenant id for every other tenant folder under `tenantsDir` that names it in its tenant.yaml (a folder boot would skip still holds its hosts,
 *  so the file is read as loosely as the backend does: packages/backend/src/tenancy/config.ts readHostsLoosely). Real folders only, as listTenants. */
export function tenantHostClaims(tenantsDir, selfId) {
  const claims = new Map();
  let entries = [];
  try { entries = readdirSync(tenantsDir, { withFileTypes: true }); } catch { return claims; }
  for (const e of entries.filter((x) => x.isDirectory() && TENANT_ID_RE.test(x.name) && x.name !== selfId).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    for (const h of hostsOfFolderLoosely(join(tenantsDir, e.name))) if (!claims.has(h)) claims.set(h, e.name);
  }
  return claims;
}

/** The hosts one tenant folder's tenant.yaml names, read loosely (see tenantHostClaims). */
export function hostsOfFolderLoosely(dir) {
  const clean = (list) => list.map((h) => h.trim().replace(/^["']|["']$/g, '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  let text = '';
  try { text = ownReadFile(dir, join(dir, 'tenant.yaml'), { encoding: 'utf-8' }); } catch { return []; } // (guarded: a link or a pipe reads as no file)
  try {
    const raw = require('js-yaml').load(text);
    const hosts = raw && typeof raw === 'object' ? raw.hosts : undefined;
    if (Array.isArray(hosts)) return clean(hosts.filter((h) => typeof h === 'string'));
    if (typeof hosts === 'string') return clean([hosts]);
    if (hosts !== undefined) return [];
  } catch { /* malformed: scan the text for the hosts: key */ }
  const inline = /^hosts:\s*\[([^\]]*)\]/m.exec(text);
  if (inline) return clean(inline[1].split(','));
  const block = /^hosts:\s*\r?\n((?:[ \t]*-[^\n]*\n?)*)/m.exec(text);
  return block ? clean(block[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-\s*/, '')).filter((l) => /^[\w.\-"'[\]:]+$/.test(l.trim()))) : [];
}

/** Why `tenantDir` may not be written to as a tenant folder, or ''. It must be a real folder (not a link: boot's listTenants skips links), its real
 *  path must stay inside the real `tenantsDir`, and it must not be the app folder or hold it (the process's own .env and sanctum.yaml live there).
 *  A folder that does not exist yet passes (`--create` makes it). The app folder may itself hold tenants.dir (the default layout). */
export function tenantFolderProblem(tenantsDir, tenantDir, appRoot) {
  let st;
  try { st = lstatSync(tenantDir); } catch (e) { return e?.code === 'ENOENT' ? '' : `${tenantDir} cannot be read (${e?.code || 'error'}).`; }
  if (st.isSymbolicLink()) return `${tenantDir} is a link. A tenant folder must be a real folder inside the tenants folder (links are skipped at boot and could point at the app's own files).`;
  if (!st.isDirectory()) return `${tenantDir} is not a folder.`;
  const real = (p) => { try { return nativeReal(p); } catch { return resolve(p); } };
  const inside = (parent, child) => { const r = relative(parent, child); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };
  if (!inside(real(tenantsDir), real(tenantDir))) return `${tenantDir} resolves outside the tenants folder ${tenantsDir}. A tenant folder stays inside it.`;
  const toRoot = relative(real(tenantDir), real(appRoot));
  if (toRoot === '' || (!toRoot.startsWith('..') && !isAbsolute(toRoot))) return `${tenantDir} is, or holds, the app folder. A tenant folder never contains the process's own files.`;
  return '';
}

// A tenant's own files and the tenants.dir rule: ONE implementation in own-files-lib.mjs (the backend re-exports the same functions).
export { tenantFilesProblem, tenantsDirProblem, tenantHoldsAppProblem } from './own-files-lib.mjs';

/** The process timezone, in the order the backend resolves it: the parent environment's TZ, then the process .env's TZ, then identity.timezone
 *  in the file, then UTC. `root` is the app folder, `processFile` the parsed sanctum.yaml, `processEnv` the environment the wizard runs in. */
export function processTimezoneOf(root, processFile, processEnv = process.env) {
  if (processEnv?.TZ) return String(processEnv.TZ);
  let fromDotenv = '';
  try { if (existsSync(join(root, '.env'))) fromDotenv = dotenv.parse(readFileSync(join(root, '.env')))?.TZ || ''; } catch { /* unreadable: the next source answers */ }
  return fromDotenv || (typeof processFile?.identity?.timezone === 'string' && processFile.identity.timezone) || 'UTC';
}
