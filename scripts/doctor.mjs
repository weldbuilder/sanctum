// doctor.mjs: the health checks the soak runbook (docs/MULTI-TENANT.md, "A chaos and soak run, locally") does by hand, in one command.
//
//   npm run doctor [-- --tenant <id>] [--json] [--root <dir>]
//
// Three sections, each line OK / WARN / FAIL with one sentence: Config (sanctum.yaml, the paths it names, the Claude frame), Tenants (the boot scan,
// the clashes across tenants, the never-inherited table against the live merged config, file modes on secrets, each home), Process (node, the build
// stamp, the database path). Exit code 0 when no FAIL, 1 otherwise, 2 for a bad command line; `--json` prints the same report as JSON.
// WARN: the app runs, but something is not as recommended. FAIL: boot would skip or refuse it, or a secret is exposed.
//
// It reads, never writes, and never prints a secret: names, paths, modes and lengths only. It reuses the libraries the wizard and the backend share
// (scripts/setup-inherit.mjs, scripts/own-files-lib.mjs) rather than re-implementing their rules; the one thing it cannot import is the backend's
// TypeScript, so the few shipped default paths are a table here (a test keeps it equal to packages/backend/src/config.ts).
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownReadFile, tenantFilesProblem } from './own-files-lib.mjs';
import {
  INHERIT_TABLE, TENANT_ID_RE, authKeyMissingProblem, hostsOfFolderLoosely, inheritedBase, isSecretKeyName, overlay, processFilePath, processTimezoneOf,
  tenantFolderProblem, tenantPaths, tenantYamlProblems, tenantsBlockOf, tenantsDirProblem,
} from './setup-inherit.mjs';

const require = createRequire(import.meta.url);

/** The shipped default paths (packages/backend/src/config.ts DEFAULTS; a test keeps them equal), resolved from the app folder unless the file says otherwise. */
export const SHIPPED_PATHS = Object.freeze({
  'agent.cwd': '.',
  'agent.claude_md_path': './CLAUDE.md',
  'agent.system_prompt_file': './prompts/companion-claude.md',
  'agent.mcp_json_path': './.mcp.json',
  'agent.dsh.base_instructions_file': './prompts/dsh-base-prompt.md',
  'agent.codex.base_instructions_file': './prompts/codex-base-prompt.md',
  'agent.rolling.summarizer_instructions_file': './prompts/summarizer-own-voice.md',
  'orchestrator.wake_prompts_path': './prompts/wake.md',
  'orchestrator.wake_prompts_dir': './prompts/wakes',
  'server.db_path': './data/sanctum.db',
});

/** The three harness copies a companion home carries in config/ (companion-home/config/). */
const HOME_CONFIG_FILES = Object.freeze(['companion-claude.md', 'codex-base-prompt.md', 'dsh-base-prompt.md']);

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dig = (o, path) => path.split('.').reduce((v, k) => (isMap(v) ? v[k] : undefined), o);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const modeText = (st) => (st.mode & 0o777).toString(8).padStart(3, '0');
const oneLine = (e) => String(e?.message ?? e).split('\n')[0];
const statOrNull = (p) => { try { return statSync(p); } catch { return null; } };
const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };
/** `text` as a sentence: one final period, never two. */
const sentence = (text) => (/[.!?]$/.test(String(text)) ? String(text) : `${text}.`);

/** A report: sections of { status: 'OK' | 'INFO' | 'WARN' | 'FAIL', check, message } lines. INFO is neither good nor bad: a feature that is off, and where to read about it. */
function newReport() {
  const sections = [];
  const section = (name) => {
    const s = { name, checks: [] };
    sections.push(s);
    const add = (status) => (check, message) => { s.checks.push({ status, check, message }); };
    return { ok: add('OK'), info: add('INFO'), warn: add('WARN'), fail: add('FAIL') };
  };
  return { sections, section };
}

// ── small helpers ────────────────────────────────────────────────────────────

/** `range` (package.json engines.node, such as ">=20.0.0 <25.0.0") against `version`. null when the range is not one this can read. */
export function nodeInRange(range, version) {
  const num = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
  const have = num(version);
  for (const part of String(range).trim().split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(part);
    if (!m) return null;
    const d = cmp(have, num(m[2]));
    const op = m[1] || '=';
    if ((op === '>=' && d < 0) || (op === '>' && d <= 0) || (op === '<=' && d > 0) || (op === '<' && d >= 0) || (op === '=' && d !== 0)) return false;
  }
  return true;
}

/** Whether `path` can be written, or, when it does not exist, whether its nearest existing parent can (the app makes the rest). */
function writableOrCreatable(path) {
  let at = path;
  for (;;) {
    if (existsSync(at)) { try { accessSync(at, constants.W_OK); return { ok: true, at, exists: at === path }; } catch { return { ok: false, at, exists: at === path }; } }
    const up = dirname(at);
    if (up === at) return { ok: false, at, exists: false };
    at = up;
  }
}

/** The Claude frame as the app resolves it (packages/backend/src/services/frame-file.ts resolveFrameFile): the home's copy, then the configured file, then the preset. */
export function frameResolution(cwd, configured) {
  const home = join(cwd, 'config', 'companion-claude.md');
  if (existsSync(home)) return { path: home, source: 'home' };
  if (configured && existsSync(configured)) return { path: configured, source: 'configured' };
  return { path: '', source: 'none' };
}

/** The Claude frame line, shared by the process and each tenant. `provider` decides whether a missing frame is worth a WARN. */
function frameCheck(r, label, cwd, configured, provider) {
  const found = frameResolution(cwd, configured);
  if (found.source === 'home') r.ok(`${label}frame`, `the Claude frame is the home's own copy, ${found.path}.`);
  else if (found.source === 'configured') r.ok(`${label}frame`, `the Claude frame is the configured file, ${found.path} (no copy at ${join(cwd, 'config', 'companion-claude.md')}).`);
  else if (!configured) r.ok(`${label}frame`, 'agent.system_prompt_file is "": the claude_code preset is used on purpose (no frame, no [Runtime] model line).');
  else (provider === 'claude' ? r.warn : r.ok)(`${label}frame`, (join(cwd, 'config', 'companion-claude.md') === configured ? `no frame: ${configured} does not exist, so the claude_code preset is used (no frame, no [Runtime] model line).` : `no frame: neither ${join(cwd, 'config', 'companion-claude.md')} nor ${configured} exists, so the claude_code preset is used (no frame, no [Runtime] model line).`));
}

/** Yaml text parsed as a mapping: { cfg } or { error }. */
function parseYamlText(text) {
  try {
    const loaded = require('js-yaml').load(text);
    if (loaded === undefined || loaded === null) return { cfg: {} };
    return isMap(loaded) ? { cfg: loaded } : { error: 'the file is not a mapping of keys' };
  } catch (e) { return { error: yamlErrorText(e) }; }
}

/** A yaml parse error with no value in it: js-yaml puts the offending text in its message (an alias name, a quoted scalar, the snippet), and a value like
 *  `password: *hunter2` is a secret. Only the reason's own words are kept (anything quoted, or after a colon, is dropped), with the line and column. */
function yamlErrorText(e) {
  const reason = String(e?.reason ?? '').replace(/(["'`]).*?\1/g, '').split(':')[0].replace(/\s+/g, ' ').trim();
  const at = e?.mark && Number.isInteger(e.mark.line) ? ` at line ${e.mark.line + 1}, column ${(Number.isInteger(e.mark.column) ? e.mark.column : 0) + 1}` : '';
  return `the yaml is not valid${at}${reason ? ` (${reason})` : ''}`;
}

/** The modes of the secrets in one folder: a file that is group or world readable is a FAIL. `files`: [path, display name]. `refuseLinks` (a tenant
 *  folder): the boot scan refuses a link, pipe or device there, so no mode is read through it (its target's mode is not the tenant's). */
function checkModes(r, label, files, { refuseLinks = false } = {}) {
  if (process.platform === 'win32') { r.ok(`${label}file modes`, 'not checked on Windows (the folder\'s access list is the boundary).'); return; }
  for (const [path, name] of files) {
    const st = refuseLinks ? lstatOrNull(path) : statOrNull(path);
    if (!st) continue;
    if (refuseLinks && !st.isFile()) { r.warn(`${label}mode ${name}`, `not checked: ${path} is not a plain file (a link, for one), which the boot scan refuses; see the boot scan line.`); continue; }
    if (st.mode & 0o077) r.fail(`${label}mode ${name}`, `${path} is mode ${modeText(st)}: group or world can read it (chmod 600).`);
    else r.ok(`${label}mode ${name}`, `${path} is mode ${modeText(st)}.`);
  }
}

// ── section 1: Config ────────────────────────────────────────────────────────

/** sanctum.yaml, the paths it names, the frame. Returns what the later sections need. */
function checkConfig(r, root, env) {
  const out = { file: {}, env: { ...env }, cwd: root, provider: 'claude', tz: 'UTC' };
  const path = processFilePath(root);
  if (!path) r.warn('sanctum.yaml', `no sanctum.yaml in ${root}: the shipped defaults apply.`);
  else {
    let text = null;
    try { text = readFileSync(path, 'utf-8'); } catch (e) { r.fail('sanctum.yaml', `${path} cannot be read (${e?.code || 'error'}).`); }
    if (text !== null) {
      const parsed = parseYamlText(text);
      if (parsed.error) r.fail('sanctum.yaml', `${path} does not parse: ${sentence(parsed.error)}`);
      else { out.file = parsed.cfg; r.ok('sanctum.yaml', `${path} parses (${Object.keys(parsed.cfg).length} top-level keys).`); }
    }
  }
  // The environment wins over the file (applyEnvOverrides); the root .env feeds it, and dotenv never overrides what is already set.
  try { if (existsSync(join(root, '.env'))) out.env = { ...dotenv.parse(readFileSync(join(root, '.env'))), ...env }; } catch (e) { r.warn('.env', `${join(root, '.env')} cannot be read (${e?.code || 'error'}): its settings are not checked.`); }

  const file = out.file;
  const at = (key) => {
    const v = dig(file, key);
    return resolve(root, expandHome(typeof v === 'string' && v.trim() ? v.trim() : SHIPPED_PATHS[key]));
  };
  const fileCwd = dig(file, 'agent.cwd');
  const cwd = resolve(root, expandHome(String(out.env.AGENT_CWD || (typeof fileCwd === 'string' && fileCwd.trim()) || SHIPPED_PATHS['agent.cwd'])));
  out.cwd = cwd;
  out.provider = ['claude', 'codex', 'dsh'].includes(out.env.AGENT_PROVIDER) ? out.env.AGENT_PROVIDER : (dig(file, 'agent.provider') || 'claude');
  out.tz = processTimezoneOf(root, file, out.env);

  if (statOrNull(cwd)?.isDirectory()) r.ok('agent.cwd', `the companion home ${cwd} exists.`);
  else r.warn('agent.cwd', `the companion home ${cwd} does not exist${statOrNull(cwd) ? ' (it is not a folder)' : ''}.`);
  // Files that ship with the app: a named one that is missing is a broken path (a base prompt the home has its own copy of is fine).
  for (const [key, provider] of [['agent.dsh.base_instructions_file', 'dsh'], ['agent.codex.base_instructions_file', 'codex'], ['agent.rolling.summarizer_instructions_file', null], ['orchestrator.wake_prompts_path', null], ['orchestrator.wake_prompts_dir', null]]) {
    if (dig(file, key) === '') { r.ok(key, 'is "": the stock prompt is used.'); continue; }
    const p = at(key);
    const homeCopy = provider ? join(cwd, 'config', `${provider}-base-prompt.md`) : '';
    if (existsSync(p)) r.ok(key, `${p} exists.`);
    else if (homeCopy && existsSync(homeCopy)) r.ok(key, `${p} is missing, but the home's copy ${homeCopy} wins.`);
    else if (key === 'orchestrator.wake_prompts_dir' && dig(file, key) === undefined) r.warn(key, `${p} does not exist (optional: the shipped default folder holds your own wake prompts, and none is fine).`);
    else (provider && out.provider !== provider ? r.warn : r.fail)(key, `${p} does not exist.`);
  }
  // Files the companion's folder may not have yet.
  for (const key of ['agent.claude_md_path', 'agent.mcp_json_path']) {
    const p = at(key);
    if (existsSync(p)) r.ok(key, `${p} exists.`);
    else r.warn(key, `${p} does not exist (optional).`);
  }
  // The companion-home config files (the harness copies).
  for (const name of HOME_CONFIG_FILES) {
    const p = join(cwd, 'config', name);
    if (existsSync(p)) r.ok(`home config/${name}`, `${p} exists.`);
    else r.warn(`home config/${name}`, `${p} does not exist: the shipped copy under prompts/ is used.`);
  }
  frameCheck(r, '', cwd, dig(file, 'agent.system_prompt_file') === '' ? '' : at('agent.system_prompt_file'), out.provider);
  checkOptionalFeatures(r, file, out.env);
  return out;
}

/** The summarizer's small-tier test, copied from packages/backend/src/services/summarizer/config.ts (SMALL_TIER), which a script cannot import (it is
 *  TypeScript). A test keeps the two regexes equal. */
export const SMALL_TIER = /haiku|(?<![a-z])mini(?!max)|small|lite|nano|\b[1-8]b\b/i;
/** Which .env variable each image provider's key is read from (packages/backend/src/services/imagegen/index.ts KEY_ENV). */
export const IMAGEGEN_KEY_ENV = Object.freeze({ runware: 'RUNWARE_API_KEY', replicate: 'REPLICATE_API_TOKEN' });
const UPGRADE_PICTURES = 'UPGRADE.md, "Pictures and companion-voiced summaries"';

/** Image generation (imagegen.*) and the companion-voiced summarizer (agent.summarizer.*): configured, half configured, or off. The yaml and the
 *  environment (with the root .env) are read; a value saved in Settings (the database) is not, so a "off" here can be on in the app. */
function checkOptionalFeatures(r, file, env) {
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const provider = clean(dig(file, 'imagegen.provider')).toLowerCase();
  if (!provider || provider === 'none') r.info('imagegen', `image generation off; see ${UPGRADE_PICTURES}.`);
  else if (!Object.hasOwn(IMAGEGEN_KEY_ENV, provider)) r.warn('imagegen', `imagegen.provider is ${JSON.stringify(provider)}; use "none", "runware" or "replicate". Pictures are off.`);
  else {
    const keyVar = IMAGEGEN_KEY_ENV[provider];
    if (clean(env[keyVar])) r.ok('imagegen', `image generation is on (${provider}) and ${keyVar} is set.`);
    else r.warn('imagegen', `imagegen.provider is "${provider}" but ${keyVar} is not set in .env or the environment: pictures stay off, and the companion is not told it can make them (${UPGRADE_PICTURES}).`);
  }

  const sum = dig(file, 'agent.summarizer');
  // The backend's rule (summarizer/config.ts): the deprecated agent.rolling.model_provider is a provider only when it names a harness or openai-compat; anything else is a route of the chat harness.
  const oldP = clean(dig(file, 'agent.rolling.model_provider'));
  const oldIsProvider = ['claude', 'codex', 'dsh', 'openai-compat'].includes(oldP);
  let sp = clean(dig(sum, 'provider'));
  const route = !sp && oldP && !oldIsProvider ? oldP : '';
  if (!sp && oldIsProvider) sp = oldP;
  const model = clean(dig(sum, 'model')) || clean(dig(file, 'agent.rolling.model'));
  if (sp === 'openai-compat') {
    const keyVar = clean(dig(sum, 'api_key_env')) || 'SUMMARIZER_API_KEY';
    const missing = [];
    if (!model) missing.push('agent.summarizer.model');
    if (!clean(dig(sum, 'base_url'))) missing.push('agent.summarizer.base_url');
    if (!clean(env[keyVar])) missing.push(`${keyVar} (in .env or the environment)`);
    if (missing.length) r.warn('summarizer', `agent.summarizer.provider is "openai-compat" but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing: every summary fails until ${missing.length === 1 ? 'it is' : 'they are'} set (${UPGRADE_PICTURES}).`);
    else r.ok('summarizer', `the companion's summaries are written through ${clean(dig(sum, 'base_url'))} on ${model}; ${keyVar} is set.`);
  } else if (route) r.ok('summarizer', `the companion's summaries run on the chat harness's route "${route}"${model ? ` (${model})` : ''} (agent.rolling.model_provider, deprecated; see agent.summarizer.provider).`);
  else if (!sp) r.ok('summarizer', 'the chat model writes the companion\'s summaries (agent.summarizer.provider is ""); another model: see ' + UPGRADE_PICTURES + '.');
  else r.ok('summarizer', `the companion's summaries run on ${sp}${model ? ` (${model})` : ''}.`);
  if (model && SMALL_TIER.test(model)) r.warn('summarizer model', `${model} looks small-tier; the summarizer writes the companion's own memory and a small or fast model flattens its voice. Use a capable mid-tier model or better (docs/CONFIGURATION.md, summarizer).`);
}

// ── section 2: Tenants ───────────────────────────────────────────────────────

function checkTenants(r, root, ctx, only) {
  let block = null;
  try { block = tenantsBlockOf(root, ctx.file); } catch (e) { r.fail('tenants block', oneLine(e)); return; }
  if (!block) {
    if (only !== undefined) r.fail('tenants block', `--tenant ${only} was named, but sanctum.yaml has no tenants: block.`);
    return;
  }
  const dirBad = tenantsDirProblem(block.dir, root);
  if (dirBad) { r.fail('tenants.dir', dirBad); return; }
  if (!existsSync(block.dir)) { r.fail('tenants.dir', `${block.dir} does not exist.`); return; }
  r.ok('tenants.dir', `${block.dir} is a usable tenants folder.`);
  const authBad = authKeyMissingProblem(block.dir, block);
  if (authBad) r.fail('tenants.auth', authBad);
  else r.ok('tenants.auth', block.auth === 'per-tenant' ? 'per-tenant mode (a login and hostnames per tenant).' : 'household mode (one login, a /c/<id>/ prefix per companion).');
  const household = block.auth !== 'per-tenant';
  if (ctx.env.INTERNAL_TOKEN) r.fail('INTERNAL_TOKEN', `INTERNAL_TOKEN is set in the environment (${String(ctx.env.INTERNAL_TOKEN).length} characters): in tenant mode each tenant has its own token, so unset it.`);

  let ids = [];
  try { ids = readdirSync(block.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && TENANT_ID_RE.test(e.name)).map((e) => e.name).sort(); } catch (e) { r.fail('tenants.dir', `${block.dir} cannot be read (${e?.code || 'error'}).`); return; }
  if (ids.length === 0) { r.fail('tenant folders', `${block.dir} has no tenant folders (a folder named like a-z, 0-9, - up to 32 characters).`); return; }
  if (only !== undefined && !ids.includes(only)) { r.fail('tenant', `--tenant ${only}: there is no folder ${join(block.dir, only)}.`); return; }
  if (!household && block.default !== undefined && !ids.includes(block.default)) r.fail('tenants.default', `tenants.default is ${block.default}, but there is no tenant folder with that id.`);
  r.ok('tenant folders', `${ids.length} tenant folder${ids.length === 1 ? '' : 's'}: ${ids.join(', ')}.`);

  const base = block.inherit ? inheritedBase(ctx.file) : {};
  const info = new Map();
  for (const id of ids) info.set(id, checkOneTenant(r, { id, dir: join(block.dir, id), root, block, base, household, ctx, checked: only === undefined || only === id }));

  // Clashes across all tenants: boot parks or skips what two tenants share, so none of it is served.
  if (!household) {
    const claims = new Map();
    // One tenant listing a host twice (or in two cases) owns it once: boot reads the list as a set, so only distinct owners clash.
    for (const [id, t] of info) for (const h of t.hosts) if (!(claims.get(h) ?? []).includes(id)) claims.set(h, [...(claims.get(h) ?? []), id]);
    const dup = [...claims].filter(([, owners]) => owners.length > 1);
    if (dup.length) for (const [h, owners] of dup) r.fail('duplicate host', `host ${h} is claimed by tenants ${owners.join(' and ')}: neither serves it (it answers 503).`);
    else r.ok('duplicate hosts', 'no host is claimed by two tenants.');
    const reserved = [...info].filter(([, t]) => t.wouldSkip).flatMap(([id, t]) => t.hosts.map((h) => [h, id]));
    if (reserved.length) for (const [h, id] of reserved) r.warn('reserved host', `host ${h} belongs to tenant ${id}, which boot would skip: it answers 503 and no one else may take it.`);
    else r.ok('reserved hosts', 'no host is reserved by a tenant boot would skip.');
  }
  const tokens = new Map();
  for (const [id, t] of info) if (t.token) tokens.set(t.token, [...(tokens.get(t.token) ?? []), id]);
  const dupTokens = [...tokens.values()].filter((o) => o.length > 1);
  if (dupTokens.length) for (const owners of dupTokens) r.fail('duplicate internal token', `tenants ${owners.join(' and ')} have the same internal token (data/.internal-token): boot skips the later ones.`);
  else r.ok('duplicate internal tokens', 'no two tenants share an internal token.');
  for (const platform of ['discord', 'telegram']) {
    const bots = new Map();
    for (const [id, t] of info) if (t.bots[platform]) bots.set(t.bots[platform], [...(bots.get(t.bots[platform]) ?? []), id]);
    const dup = [...bots.values()].filter((o) => o.length > 1);
    if (dup.length) for (const owners of dup) r.fail(`duplicate ${platform} bot token`, `tenants ${owners.join(' and ')} hold the same ${platform} bot token in their .env: ${platform} is parked for all of them.`);
    else r.ok(`duplicate ${platform} bot tokens`, `no two tenants hold the same ${platform} bot token in their .env (a token saved in a tenant's database is not read here).`);
  }
}

/** Everything about one tenant folder. Returns { hosts, token, bots, wouldSkip } for the clash checks (read for every tenant, reported for `checked` ones). */
function checkOneTenant(r, { id, dir, root, block, base, household, ctx, checked }) {
  const label = `tenant ${id}: `;
  const note = (status, check, message) => { if (checked) r[status](`${label}${check}`, message); };
  const out = { hosts: [], token: '', bots: {}, wouldSkip: false };
  const fail = (check, message) => { out.wouldSkip = true; note('fail', check, message); };
  const loose = hostsOfFolderLoosely(dir);
  out.hosts = household ? [] : [...new Set(loose)];
  if (!household && out.hosts.length < loose.length) note('warn', 'hosts', 'tenant.yaml lists the same host more than once (case aside): boot reads it once, so it is not a clash, but the list can be tidied.');
  if (household && loose.length) note('warn', 'hosts', 'hosts in tenant.yaml are not read in household mode (the companion is served at /c/<id>/).');

  const folderBad = tenantFolderProblem(block.dir, dir, root);
  if (folderBad) { fail('folder', sentence(folderBad)); return out; }
  // The boot scan: every file of the tenant is a real file of its own (no link, pipe, or second hard link).
  const scanBad = tenantFilesProblem(dir, { log: () => {} });
  if (scanBad) fail('boot scan', sentence(scanBad)); else note('ok', 'boot scan', 'the folder\'s own files are all real files (no link, pipe or second hard link).');

  const p = tenantPaths(dir);
  const readOwn = (path) => { try { return ownReadFile(dir, path, { encoding: 'utf-8' }); } catch (e) { return { error: oneLine(e) }; } };
  let own = {};
  if (existsSync(p.yamlPath)) {
    const text = readOwn(p.yamlPath);
    const parsed = typeof text === 'string' ? parseYamlText(text) : { error: text.error };
    if (parsed.error) fail('tenant.yaml', `${p.yamlPath} cannot be used: ${sentence(parsed.error)}`);
    else { own = parsed.cfg; note('ok', 'tenant.yaml', `${p.yamlPath} parses (${Object.keys(own).length} top-level keys).`); }
  } else note('ok', 'tenant.yaml', 'there is no tenant.yaml: every setting is inherited or the default.');
  // .env: read for the checks, never printed.
  let envText = '';
  let envFile = {};
  let envUnread = false;
  if (existsSync(p.envPath)) {
    const t = readOwn(p.envPath);
    if (typeof t !== 'string') { envUnread = true; fail('.env', `${p.envPath} cannot be read: ${sentence(t.error)}`); }
    else { envText = t; envFile = dotenv.parse(t); }
  }
  for (const [platform, key] of [['discord', 'DISCORD_BOT_TOKEN'], ['telegram', 'TELEGRAM_BOT_TOKEN']]) if (envFile[key]) out.bots[platform] = sha(envFile[key]);
  // The internal token: compared by hash, reported by length.
  const tokenPath = join(dir, 'data', '.internal-token');
  if (existsSync(tokenPath)) {
    const t = readOwn(tokenPath);
    if (typeof t !== 'string') fail('internal token', `${tokenPath} cannot be read: ${sentence(t.error)}`);
    else if (t.trim()) {
      out.token = sha(t.trim());
      const short = t.trim().length < 32;
      note(short ? 'warn' : 'ok', 'internal token', `${tokenPath} holds a token of ${t.trim().length} characters${short ? ' (short: delete the file and a new one is made at boot)' : ''}.`);
    } else note('warn', 'internal token', `${tokenPath} is empty: a new one is made at boot.`);
  } else note('ok', 'internal token', `${tokenPath} does not exist yet: it is made at the first boot.`);

  // The yaml and .env against the rules boot enforces (the wizard's own list: paths inside the folder, process-only keys, timezone, hosts, Revien, background_runs).
  const revienUrl = dig(ctx.file, 'revien.url');
  const problems = tenantYamlProblems(own, dir, ctx.tz, { envText, processRevienUrl: typeof revienUrl === 'string' ? revienUrl : undefined });
  for (const why of problems) fail('config', sentence(why));
  if (!problems.length && !envUnread) note('ok', 'config', 'tenant.yaml and .env pass the checks boot makes (paths inside the folder, process-only keys, timezone, hosts, Revien, background_runs).');
  else if (!problems.length) note('warn', 'config', 'tenant.yaml passes the checks boot makes, but the .env could not be read, so its paths, timezone and settings were not checked.');

  // The never-inherited table against the live merged config: such a key may only hold what this tenant's own file says.
  const merged = overlay(base, own);
  const leaked = [];
  for (const row of INHERIT_TABLE.filter((x) => !x.inherit)) {
    for (const key of row.paths) if (!key.startsWith('(') && dig(merged, key) !== undefined && dig(own, key) === undefined) leaked.push(key);
  }
  const walkSecrets = (node, ownNode, path) => {
    if (!isMap(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const here = path ? `${path}.${k}` : k;
      if (isSecretKeyName(k) && !(isMap(ownNode) && k in ownNode)) leaked.push(here);
      else walkSecrets(v, isMap(ownNode) ? ownNode[k] : undefined, here);
    }
  };
  walkSecrets(merged, own, '');
  if (leaked.length) fail('never-inherited', `the merged config carries ${[...new Set(leaked)].join(', ')} that this tenant's own file does not set: the operator's value leaked in.`);
  else note('ok', 'never-inherited', 'every never-inherited key in the merged config is this tenant\'s own, and no secret-named key came from the operator\'s file.');

  if (checked) {
    checkModes(r, label, [[p.envPath, '.env'], [join(dir, 'app.env'), 'app.env'], [tokenPath, 'data/.internal-token'], [join(dir, 'data', '.google-key'), 'data/.google-key']], { refuseLinks: true });
    const dataStat = lstatOrNull(join(dir, 'data'));
    if (dataStat?.isDirectory() && process.platform !== 'win32') (dataStat.mode & 0o077 ? r.warn : r.ok)(`${label}mode data/`, `${join(dir, 'data')} is mode ${modeText(dataStat)}${dataStat.mode & 0o077 ? ': group or world can list it (chmod 700)' : ''}.`);
  }

  // Boot would not start this tenant: its home, identity, config copies and frame are never read, so probing them (they may sit outside the folder) says nothing true.
  if (out.wouldSkip) { note('warn', 'home', 'skipped: boot would not start this tenant.'); }
  else {
    // The home folder: present, with identity/ and config/ and the harness copies.
    const ownCwd = dig(merged, 'agent.cwd');
    const home = resolve(dir, expandHome(String(envFile.AGENT_CWD || (typeof ownCwd === 'string' && ownCwd.trim()) || 'home')));
    if (!statOrNull(home)?.isDirectory()) note('fail', 'home', `the home folder ${home} does not exist.`);
    else {
      note('ok', 'home', `the home folder ${home} exists.`);
      for (const sub of ['identity', 'config']) {
        const there = !!statOrNull(join(home, sub))?.isDirectory();
        note(there ? 'ok' : 'warn', `home ${sub}/`, `${join(home, sub)} ${there ? 'exists' : 'does not exist'}.`);
      }
      for (const name of HOME_CONFIG_FILES) if (!existsSync(join(home, 'config', name))) note('warn', `home config/${name}`, `${join(home, 'config', name)} does not exist: a harness that uses it falls back to the shipped copy.`);
    }
    // The frame as this tenant's app would see it: its own key, else the home's copy.
    const ownFrame = dig(own, 'agent.system_prompt_file');
    const configured = ownFrame === '' ? '' : typeof ownFrame === 'string' && ownFrame.trim() ? resolve(dir, expandHome(ownFrame.trim())) : join(home, 'config', 'companion-claude.md');
    if (checked) frameCheck(r, label, home, configured, dig(merged, 'agent.provider') || ctx.provider);
  }
  // The tenant's database is at a fixed place, and this user must be able to write it.
  if (checked) {
    const w = writableOrCreatable(p.dbPath);
    if (w.ok) r.ok(`${label}database`, w.exists ? `${p.dbPath} is writable.` : `${p.dbPath} does not exist yet and ${w.at} can be written.`);
    else r.fail(`${label}database`, `${p.dbPath} cannot be written (${w.at} is not writable).`);
  }
  return out;
}

// ── section 3: Process ───────────────────────────────────────────────────────

function checkProcess(r, root, ctx, nodeVersion) {
  let engines = '';
  try { engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))?.engines?.node || ''; } catch { /* below */ }
  if (!engines) r.warn('node', `node ${nodeVersion}; ${join(root, 'package.json')} names no engines.node to compare with.`);
  else {
    const inRange = nodeInRange(engines, nodeVersion);
    if (inRange === null) r.warn('node', `node ${nodeVersion}; engines.node ${JSON.stringify(engines)} is not a range this reads.`);
    else if (inRange) r.ok('node', `node ${nodeVersion} is within engines.node ${engines}.`);
    else r.fail('node', `node ${nodeVersion} is outside engines.node ${engines}.`);
  }
  // The build folder is what the app serves (server.ts frontendBuildPath); the id comes from its .build-id, else BUILD_ID in the environment, else "dev".
  const build = join(root, 'packages', 'frontend', 'build');
  const stamp = join(build, '.build-id');
  let stampText = '';
  try { stampText = readFileSync(stamp, 'utf-8').trim(); } catch { /* below */ }
  if (!statOrNull(build)?.isDirectory()) r.fail('build stamp', `${build} is missing: no UI is served (run npm run build).`);
  else if (stampText) r.ok('build stamp', `${stamp} holds a build id of ${stampText.length} characters.`);
  else if (ctx.env.BUILD_ID) r.ok('build stamp', `${stamp} is ${existsSync(stamp) ? 'empty' : 'missing'}; BUILD_ID in the environment is the build id (${String(ctx.env.BUILD_ID).length} characters).`);
  else r.warn('build stamp', `${stamp} is ${existsSync(stamp) ? 'empty' : 'missing'}: the app serves the UI but reports its build id as "dev", so a stale tab is never told to reload (npm run build writes it).`);
  // The process's database: server.db_path, DB_PATH wins; a legacy resonant.db is used when sanctum.db is absent and the path was not named.
  const named = ctx.env.DB_PATH || dig(ctx.file, 'server.db_path');
  let dbPath = resolve(root, expandHome(String(named || SHIPPED_PATHS['server.db_path'])));
  if (!named) { const legacy = dbPath.replace(/sanctum\.db$/, 'resonant.db'); if (legacy !== dbPath && !existsSync(dbPath) && existsSync(legacy)) dbPath = legacy; }
  const w = writableOrCreatable(dbPath);
  if (w.ok) r.ok('database', w.exists ? `${dbPath} is writable.` : `${dbPath} does not exist yet and ${w.at} can be written.`);
  else r.fail('database', `${dbPath} cannot be written (${w.at} is not writable).`);
  checkConsent(r, dbPath);
  // The process's own secrets.
  checkModes(r, '', [[join(root, '.env'), '.env'], [join(root, 'app.env'), 'app.env'], [join(dirname(dbPath), '.internal-token'), 'data/.internal-token'], [join(dirname(dbPath), '.google-key'), 'data/.google-key']]);
}

/** The consent gate's capabilities (packages/backend/src/services/consent/gate.ts CAPABILITIES; a test keeps the two lists equal). */
export const CONSENT_CAPABILITIES = Object.freeze(['app_write', 'shell', 'files_outside_home', 'web', 'outward_telegram', 'outward_discord', 'google_write', 'self_code_edit', 'voice_out']);

/** One INFO line: the consent gate's mode and anything off (Settings → Permissions; docs/CONFIGURATION.md, "Permissions and the consent gate").
 *  Read straight from the database, read-only; a database that does not exist yet, or cannot be read, is the default (Open, nothing off). */
export function consentSummary(dbPath) {
  let mode = 'open';
  let entries = [];
  try {
    if (existsSync(dbPath)) {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const get = (k) => db.prepare('SELECT value FROM config WHERE key = ?').get(k)?.value;
        mode = get('consent.mode') === 'guard' ? 'guard' : 'open';
        const parsed = JSON.parse(get('consent.grants') || '[]');
        if (Array.isArray(parsed)) entries = parsed;
      } finally { db.close(); }
    }
  } catch { /* the default */ }
  const now = Date.now();
  const off = CONSENT_CAPABILITIES.filter((cap) => {
    const e = entries.find((x) => x && x.capability === cap);
    if (!e) return mode === 'guard';
    if (e.effect === 'off') return true;
    return typeof e.expires_at === 'string' && Date.parse(e.expires_at) <= now;
  });
  return { mode, off };
}

function checkConsent(r, dbPath) {
  const { mode, off } = consentSummary(dbPath);
  const rails = 'These switches are code and hold for any model; a model run locally has no provider rails, so the rails are yours.';
  const what = mode === 'guard'
    ? `Guard mode is on: everything is off until granted${off.length < CONSENT_CAPABILITIES.length ? ` (off now: ${off.join(', ')})` : ''}.`
    : off.length ? `Open mode; off: ${off.join(', ')}.` : 'Open mode; nothing is off.';
  r.info('permissions', `${what} ${rails} See docs/CONFIGURATION.md, "Permissions and the consent gate".`);
}

// ── the command ──────────────────────────────────────────────────────────────

/** Run every check. `opts`: { root, tenant, env, nodeVersion }. Returns { ok, exitCode, counts, root, sections }. */
export function runDoctor(opts = {}) {
  const root = resolve(opts.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const report = newReport();
  const ctx = checkConfig(report.section('Config'), root, opts.env ?? process.env);
  const tenants = report.section('Tenants');
  checkTenants(tenants, root, ctx, opts.tenant);
  const tenantSection = report.sections.at(-1);
  if (tenantSection.checks.length === 0) tenants.ok('tenants', 'no tenants: block in sanctum.yaml: a single-tenant install.');
  checkProcess(report.section('Process'), root, ctx, opts.nodeVersion ?? process.versions.node);
  const counts = { OK: 0, INFO: 0, WARN: 0, FAIL: 0 };
  for (const s of report.sections) for (const c of s.checks) counts[c.status]++;
  return { ok: counts.FAIL === 0, exitCode: counts.FAIL === 0 ? 0 : 1, counts, root, sections: report.sections };
}

/** The report as the text the command prints. */
export function formatReport(report) {
  const lines = [];
  for (const s of report.sections) {
    lines.push(s.name);
    for (const c of s.checks) lines.push(`  ${c.status.padEnd(4)}  ${c.check}: ${c.message}`);
    lines.push('');
  }
  lines.push(`${report.counts.OK} OK, ${report.counts.WARN} WARN, ${report.counts.FAIL} FAIL${report.counts.INFO ? `, ${report.counts.INFO} INFO` : ''}`);
  return lines.join('\n');
}

const USAGE = 'Usage: npm run doctor [-- --tenant <id>] [--json]';

/** The command line: { tenant, json, root } or { error }. (`--root <folder>` checks another install; the tests use it.) */
export function parseArgs(args) {
  const out = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--tenant' && args[i + 1] !== undefined) out.tenant = args[++i];
    else if (a.startsWith('--tenant=')) out.tenant = a.slice('--tenant='.length);
    else if (a === '--root' && args[i + 1] !== undefined) out.root = args[++i];
    else return { error: `Unknown option ${a}. ${USAGE}` };
  }
  if (out.tenant !== undefined && !TENANT_ID_RE.test(out.tenant)) return { error: `--tenant ${JSON.stringify(out.tenant)} is not a tenant id (a-z, 0-9, - up to 32 characters). ${USAGE}` };
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(args.error); process.exit(2); }
  const report = runDoctor({ root: args.root, tenant: args.tenant });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exitCode = report.exitCode;
}
