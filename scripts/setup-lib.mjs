// setup-lib.mjs — the pure parts of `npm run setup`, kept separate so they can be tested.
import { createHash, randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { ambientTenantDir, ownChmod, ownMkdir, ownRename, ownRm, ownWriteFile, ownWriteFileAtomic } from './own-files-lib.mjs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { entryHasFilter, browserEntryProblem } from '../examples/browser-seat-neko/entry-check.mjs';
// The Discord step's pure parts live in their own file; setup.mjs and the tests import them from here.
export * from './setup-discord.mjs';

/** What ~/.codex/config.toml says: its default model and provider, and every
 *  [model_providers.*] table (key, display name, base_url). A line-level read,
 *  enough for the handful of keys the wizard shows; never writes anything. */
export function parseCodexConfig(toml) {
  const out = { model: '', modelProvider: '', providers: [] };
  let section = '';
  let current = null;
  for (const raw of String(toml || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      const m = /^model_providers\.("?)([^"\]]+)\1$/.exec(section);
      current = m ? { key: m[2], name: '', baseUrl: '' } : null;
      if (current) out.providers.push(current);
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!section) {
      if (key === 'model') out.model = val;
      if (key === 'model_provider') out.modelProvider = val;
    } else if (current) {
      if (key === 'name') current.name = val;
      if (key === 'base_url') current.baseUrl = val;
    }
  }
  return out;
}

/** The [features] table of a config.toml as an object of booleans (line-level). */
export function tomlFeatures(text) {
  const out = {};
  let inFeatures = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (/^\[/.test(line)) { inFeatures = line === '[features]'; continue; }
    const m = inFeatures && /^([A-Za-z0-9_]+)\s*=\s*(true|false)$/.exec(line);
    if (m) out[m[1]] = m[2] === 'true';
  }
  return out;
}

/** A value as it goes after `KEY=` in a .env file. Left as it is unless dotenv would read it differently: a `#` (it starts a comment
 *  even with no space before it), space at either end (trimmed), or a leading quote (taken as the start of a quoted value). Those are
 *  wrapped in the first quote character the value does not itself hold, because dotenv has no escape for one: ' (read exactly), then "
 *  (which turns a written \n into a line break, so not for a value holding one), then `. A line break cannot be kept at all, and a
 *  value holding all three quotes cannot be kept either: both throw. */
export function envQuote(value) {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error('A line break cannot go in .env: put the value on one line.');
  if (!(v.includes('#') || /^\s|\s$/.test(v) || /^['"`]/.test(v))) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !/\\[nr]/.test(v)) return `"${v}"`;
  if (!v.includes('`')) return `\`${v}\``;
  throw new Error('That value holds all three kinds of quote, so it cannot be kept in .env. Use one without them.');
}

/** What the server reads for `key` from a .env text: dotenv's parse (quotes stripped, `#` comments cut), or ''. */
export function envValueOf(text, key) {
  return dotenv.parse(String(text || ''))[key] || '';
}

/** The text after `KEY=` on the first line that sets it, as written (quotes and all), or ''. For showing the line as it is. */
export function envRawOf(text, key) {
  return (new RegExp(`^${key}=(.*)$`, 'm').exec(String(text || ''))?.[1] || '').trim();
}

/** Set KEY=value lines in a .env text, replacing existing ones (commented or
 *  not, first match wins) and appending the rest. Everything else is kept.
 *  Values dotenv would misread are quoted (envQuote). */
export function upsertEnv(text, values) {
  const lines = String(text || '').split(/\r?\n/);
  const done = new Set();
  const out = lines.map((line) => {
    const m = /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !(m[1] in values) || done.has(m[1])) return line;
    done.add(m[1]);
    // A line that already reads back as this value (dotenv's way) stays exactly as it is: no re-quoting on a re-run.
    if (dotenv.parse(line)[m[1]] === String(values[m[1]])) return line;
    return `${m[1]}=${envQuote(values[m[1]])}`;
  });
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const [k, v] of Object.entries(values)) {
    if (!done.has(k)) out.push(`${k}=${envQuote(v)}`);
  }
  let joined = out.join('\n');
  if (!joined.endsWith('\n')) joined += '\n';
  return joined;
}

/** A password a person can read back: groups of letters and digits, no look-alikes. */
export function generatePassword(bytes = randomBytes(16)) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 16; i++) {
    if (i && i % 4 === 0) s += '-';
    s += alphabet[bytes[i] % alphabet.length];
  }
  return s;
}

/** Apply the wizard's answers to a config object (the parsed sanctum.yaml, or {}). */
export function applyAnswers(cfg, a) {
  const c = structuredClone(cfg || {});
  c.identity = { ...(c.identity || {}), companion_name: a.companionName, user_name: a.userName, timezone: a.timezone };
  c.agent = { ...(c.agent || {}), cwd: a.home, provider: a.provider };
  if (a.provider === 'codex') {
    c.agent.codex = { ...(c.agent.codex || {}), model: a.codexModel || '', model_provider: a.codexProvider || '' };
    if (a.sandbox) c.agent.codex.sandbox_mode = a.sandbox;
    if (Array.isArray(a.extraDirs)) c.agent.codex.additional_directories = a.extraDirs;

  } else if (a.provider === 'dsh') {
    c.agent.dsh = { ...(c.agent.dsh || {}), model: a.dshModel || '' };
  } else {
    c.agent.model = a.claudeModel || 'claude-sonnet-5-5';
  }
  // Rolling context: one block for both harnesses; the answered switch is the
  // provider's own, the other keeps whatever it had. Legacy codex.rolling folds in.
  c.agent.rolling = migrateLegacyRolling(c).agent.rolling;
  if (c.agent.codex) delete c.agent.codex.rolling;
  if (typeof a.rolling === 'boolean') c.agent.rolling[a.provider] = a.rolling;
  if (a.summarizerModel !== undefined) c.agent.rolling.model = a.summarizerModel || '';
  if (a.summarizerProvider !== undefined) c.agent.rolling.model_provider = a.summarizerProvider || '';
  // Optional group (pictures and summaries): written only when the person chose something; "nothing" and "the chat model" leave the file as it was.
  if (a.imageProvider === 'runware' || a.imageProvider === 'replicate') c.imagegen = { ...(c.imagegen || {}), provider: a.imageProvider };
  if (a.summaryOwn?.baseUrl && a.summaryOwn?.model) {
    c.agent.summarizer = {
      ...(c.agent.summarizer || {}), provider: 'openai-compat', base_url: a.summaryOwn.baseUrl, model: a.summaryOwn.model,
      api_key_env: c.agent.summarizer?.api_key_env || 'SUMMARIZER_API_KEY',
    };
  }
  if (typeof a.appWrite === 'boolean') {
    c.agent.app_write = a.appWrite;
    if (a.appWrite) c.command_center = { ...(c.command_center || {}), enabled: true };
  }
  // Plugins: who manages them ('companion' or 'person'), then which ones may load. Only written when the wizard asked;
  // plugins.dir is never touched here.
  if (a.pluginsTrust === 'companion' || a.pluginsTrust === 'person') c.plugins = { ...(c.plugins || {}), trust: a.pluginsTrust };
  if (Array.isArray(a.pluginsEnabled)) c.plugins = { ...(c.plugins || {}), enabled: [...a.pluginsEnabled] };
  // Where the ratification ledger lives, only when the wizard had to move it out of the companion's reach.
  if (typeof a.pluginsLedgerDir === 'string' && a.pluginsLedgerDir) c.plugins = { ...(c.plugins || {}), ledger_dir: a.pluginsLedgerDir };
  if (a.memory) Object.assign(c, applyMemoryChoice(c, a.memory));
  if (a.memory === 'revien' && typeof a.revienUrl === 'string' && a.revienUrl) c.revien = { ...(c.revien || {}), url: a.revienUrl };
  if (!a.memory) c.revien = { ...(c.revien || {}), enabled: !!a.revien };
  if (a.phoneOrigin) {
    const origins = Array.isArray(c.cors?.origins) ? c.cors.origins.filter((o) => o !== a.phoneOrigin) : [];
    c.cors = { ...(c.cors || {}), origins: [...origins, a.phoneOrigin] };
  }
  // A tenant's hostname (the operator's terminal asked for it): the first of its hosts, the rest kept as they were.
  if (typeof a.tenantHost === 'string') {
    const hosts = Array.isArray(c.hosts) ? c.hosts : typeof c.hosts === 'string' ? [c.hosts] : [];
    if (!a.tenantHost) delete c.hosts;
    else if (hosts[0] !== a.tenantHost) c.hosts = [a.tenantHost, ...hosts.slice(1).filter((h) => h !== a.tenantHost)];
  }
  const bound = boundOrigin(c);
  if (bound) {
    const origins = Array.isArray(c.cors?.origins) ? c.cors.origins.filter((o) => o !== bound) : [];
    c.cors = { ...(c.cors || {}), origins: [...origins, bound] };
  }
  return c;
}

/** The browser origin of a server bound straight to a Tailscale or LAN address
 *  (`server.host` not loopback), '' otherwise. The app allows it at runtime too;
 *  writing it into cors.origins makes the rule visible in the file. */
export function boundOrigin(cfg) {
  const host = String(cfg?.server?.host || '').trim().toLowerCase();
  if (!host || ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) return '';
  const port = Number(cfg?.server?.port) || 3099;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

// ── ~/.codex/config.toml editing ──────────────────────────────────────────────
// Line-level, on purpose: a full TOML round-trip would drop the person's
// comments. These touch only the lines they are about and keep the rest.

/** `[model_providers.deepseek]` or `[model_providers."my-router"]`. */
export function tomlSectionHeader(path) {
  return `[${path.split('.').map((p) => (/^[A-Za-z0-9_-]+$/.test(p) ? p : JSON.stringify(p))).join('.')}]`;
}
const tomlValue = (v) => (typeof v === 'boolean' ? String(v) : typeof v === 'number' ? String(v) : JSON.stringify(String(v)));
const sectionMatches = (line, path) => {
  const m = /^\s*\[([^\]]+)\]\s*$/.exec(line);
  if (!m) return false;
  const norm = m[1].split('.').map((p) => p.trim().replace(/^"(.*)"$/, '$1')).join('.');
  return norm === path;
};

/** Replace (or append) a `[section]` with exactly these keys. Other sections untouched. */
export function upsertTomlSection(text, path, kv) {
  const lines = String(text || '').split(/\r?\n/);
  const body = [tomlSectionHeader(path), ...Object.entries(kv).map(([k, v]) => `${k} = ${tomlValue(v)}`)];
  const start = lines.findIndex((l) => sectionMatches(l, path));
  if (start < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return [...lines, ...(lines.length ? [''] : []), ...body, ''].join('\n');
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const out = [...lines.slice(0, start), ...body, '', ...lines.slice(end)];
  let joined = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!joined.endsWith('\n')) joined += '\n';
  return joined;
}

/** Set top-level keys (before the first `[section]`), replacing existing lines. */
export function setTomlTopLevel(text, kv) {
  const lines = String(text || '').split(/\r?\n/);
  const firstSection = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = firstSection < 0 ? lines : lines.slice(0, firstSection);
  const rest = firstSection < 0 ? [] : lines.slice(firstSection);
  const pending = { ...kv };
  const edited = top.map((l) => {
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(l);
    if (!m || !(m[1] in pending)) return l;
    const v = pending[m[1]];
    delete pending[m[1]];
    return `${m[1]} = ${tomlValue(v)}`;
  });
  while (edited.length && !edited[edited.length - 1].trim()) edited.pop();
  for (const [k, v] of Object.entries(pending)) edited.push(`${k} = ${tomlValue(v)}`);
  const out = rest.length ? [...edited, '', ...rest] : edited;
  let joined = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!joined.endsWith('\n')) joined += '\n';
  return joined;
}

/** The memory choice, as app config. 'revien' | 'own' | 'harness' | 'none' | 'sanctum' (Sanctum's own memory, agent.local_recall).
 *  Only 'sanctum' writes agent.local_recall; every other choice clears it, so it is unset again: Sanctum's own memory then stands in
 *  only for a Revien that cannot be reached (packages/backend/src/services/revien.ts). */
export function applyMemoryChoice(cfg, memory) {
  const c = structuredClone(cfg || {});
  c.revien = { ...(c.revien || {}), enabled: memory === 'revien' };
  c.agent = { ...(c.agent || {}), harness_memory: memory === 'harness' };
  if (memory === 'sanctum') c.agent.local_recall = true; else delete c.agent.local_recall;
  return c;
}

/** Fold a legacy `agent.codex.rolling` block into `agent.rolling` (explicit new keys win). */
export function migrateLegacyRolling(cfg) {
  const c = structuredClone(cfg || {});
  c.agent = c.agent || {};
  const rolling = { ...(c.agent.rolling || {}) };
  const legacy = c.agent.codex?.rolling;
  if (legacy && typeof legacy === 'object') {
    if (typeof legacy.enabled === 'boolean' && rolling.codex === undefined) rolling.codex = legacy.enabled;
    for (const [k, v] of Object.entries(legacy)) if (k !== 'enabled' && rolling[k] === undefined) rolling[k] = v;
    delete c.agent.codex.rolling;
  }
  c.agent.rolling = rolling;
  return c;
}

/**
 * Fresh install or upgrade, and what rolling is doing today. An upgrade is an
 * existing config AND an existing database AND no rolling switch anywhere
 * (neither agent.rolling nor the legacy agent.codex.rolling). On an upgrade the
 * default answer is "whatever is in effect today", so an Enter changes nothing:
 * Codex has had rolling on by default since the fork; Claude never had it.
 */
export function rollingDefaults(existingCfg, hasConfigFile, hasDatabase) {
  const c = existingCfg || {};
  const hasSwitch = typeof c.agent?.rolling?.claude === 'boolean' || typeof c.agent?.rolling?.codex === 'boolean'
    || typeof c.agent?.rolling?.dsh === 'boolean' || typeof c.agent?.codex?.rolling?.enabled === 'boolean';
  const upgrade = !!hasConfigFile && !!hasDatabase && !hasSwitch;
  // A switch already saved for a harness: re-running setup offers it back as
  // the default, so Enter keeps what the person chose last time.
  const saved = {
    codex: typeof c.agent?.rolling?.codex === 'boolean' || typeof c.agent?.codex?.rolling?.enabled === 'boolean',
    claude: typeof c.agent?.rolling?.claude === 'boolean',
    dsh: typeof c.agent?.rolling?.dsh === 'boolean',
  };
  const effective = {
    codex: typeof c.agent?.rolling?.codex === 'boolean' ? c.agent.rolling.codex
      : typeof c.agent?.codex?.rolling?.enabled === 'boolean' ? c.agent.codex.rolling.enabled : true,
    claude: typeof c.agent?.rolling?.claude === 'boolean' ? c.agent.rolling.claude : (hasConfigFile && hasDatabase ? false : true),
    dsh: typeof c.agent?.rolling?.dsh === 'boolean' ? c.agent.rolling.dsh : true, // the app's own default (config.ts agent.rolling.dsh)
  };
  return { upgrade, effective, saved };
}

// ── Plugins ───────────────────────────────────────────────────────────────────

/** The plugins that ship with the app: `<root>/plugins/<dir>/sanctum.plugin.json`, as [{ id, name }]
 *  sorted by id. A folder with no readable manifest is skipped. */
export function listShippedPlugins(root) {
  const dir = join(root, 'plugins');
  let names = [];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = join(dir, n, 'sanctum.plugin.json');
    if (!existsSync(file)) continue;
    try {
      const m = JSON.parse(readFileSync(file, 'utf-8'));
      const id = typeof m.id === 'string' && m.id ? m.id : n;
      out.push({ id, name: typeof m.name === 'string' && m.name ? m.name : id });
    } catch { /* not valid JSON: the app lists it as broken; the wizard skips it */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The wizard answer to "who manages plugins?": 1 or "companion" -> 'companion', 2 or "person"/"you" -> 'person';
 *  nothing (or anything else) -> `def`. */
export function parsePluginTrust(answer, def = 'companion') {
  const a = String(answer || '').trim().toLowerCase();
  if (a === '1' || a === 'companion' || a === 'your companion') return 'companion';
  if (a === '2' || a === 'person' || a === 'you') return 'person';
  return def === 'person' ? 'person' : 'companion';
}

/** The new plugins.enabled when the companion manages plugins: no ratification, so the chosen shipped ids are
 *  enabled as they are, and the ids the person enabled themselves (not shipped) stay. */
export function chooseCompanionPlugins(existingEnabled, shipped, picked) {
  const shippedIds = new Set(shipped.map((p) => p.id));
  const kept = [];
  for (const id of Array.isArray(existingEnabled) ? existingEnabled : []) {
    if (typeof id === 'string' && id && !shippedIds.has(id) && !kept.includes(id)) kept.push(id);
  }
  return [...kept, ...picked.filter((id) => !kept.includes(id))];
}

/** The wizard answer to "which plugins?": numbers from the list, ids, "all", or nothing / "none". */
export function parsePluginSelection(answer, shipped) {
  const a = String(answer || '').trim().toLowerCase();
  if (!a || a === 'none' || a === 'n') return [];
  if (a === 'all') return shipped.map((p) => p.id);
  const out = [];
  for (const tok of a.split(/[\s,]+/).filter(Boolean)) {
    const byNum = /^\d+$/.test(tok) ? shipped[Number(tok) - 1] : undefined;
    const p = byNum || shipped.find((x) => x.id === tok);
    if (p && !out.includes(p.id)) out.push(p.id);
  }
  return out;
}

/** The new plugins.enabled: only ids that are ratified now. The shipped ones are exactly `ratified` (the ids
 *  that ratified in this run). An id the person enabled themselves (not shipped) stays only when the ledger in
 *  `opts.ledgerDir` holds its ratification with an intact copy, and, when its folder is under `opts.personDir`
 *  (plugins.dir), that folder still hashes to the ratified digest; otherwise it is left out, and `opts.say` is
 *  told so, naming the Settings page where it is ratified. */
export function chooseEnabledPlugins(existingEnabled, shipped, ratified, opts = {}) {
  const shippedIds = new Set(shipped.map((p) => p.id));
  const kept = [];
  for (const id of Array.isArray(existingEnabled) ? existingEnabled : []) {
    if (typeof id !== 'string' || shippedIds.has(id) || kept.includes(id)) continue;
    if (ownPluginRatified(opts.ledgerDir, opts.personDir, id)) kept.push(id);
    else opts.say?.(`${id} was left out of plugins.enabled: it is not ratified (or its code changed since). Ratify it in the app under Settings > Plugins, then add it back to plugins.enabled.`);
  }
  return [...kept, ...ratified.filter((id) => !kept.includes(id))];
}

/** The folder under `root` whose manifest names `id` (the ledger is keyed by manifest id, and a folder need not be named
 *  after it), or null. Folders are read in name order and a later one wins, as the app's loader does. */
function findPluginFolderById(root, id) {
  let names = [];
  try { names = readdirSync(root).sort(); } catch { return null; }
  let found = null;
  for (const n of names) {
    const dir = join(root, n);
    try { if (JSON.parse(readFileSync(join(dir, 'sanctum.plugin.json'), 'utf-8')).id === id) found = dir; } catch { /* no manifest, or not JSON */ }
  }
  return found;
}

/** Whether the ledger in `ledgerDir` holds a ratification of `id` whose copy is intact and, when the plugin's folder is found under <personDir> (by its manifest id, not its folder name), still matches it. */
function ownPluginRatified(ledgerDir, personDir, id) {
  if (!ledgerDir || !ID_OK.test(id)) return false;
  const entry = readLedgerFile(join(ledgerDir, 'ratified.json')).plugins[id];
  if (!entry || typeof entry.digest !== 'string' || !DIGEST_OK.test(entry.digest)) return false;
  try {
    if (readPluginFolder(join(ledgerDir, 'snapshots', id, entry.digest)).digest !== entry.digest) return false;
    if (personDir) {
      const live = findPluginFolderById(personDir, id);
      if (live && readPluginFolder(live).digest !== entry.digest) return false;
    }
  } catch { return false; }
  return true;
}

// ── Plugin ratification ───────────────────────────────────────────────────────
// The wizard runs before anything is built, so it cannot import the backend's TypeScript. This is
// a plain-JS copy of packages/backend/src/services/plugin-ratify.ts (digest, caps, ledger shape,
// the ratified copy under <ledger folder>/snapshots, the import scan) and of the containment rule in
// plugins.ts (ledgerClash); setup-lib.test.mjs checks the two agree. Change them together.

const RATIFY_MAX_FILES = 2000;
const RATIFY_MAX_BYTES = 25 * 1024 * 1024;
const DEPS_HINT = 'keep dependencies outside the plugin folder (the folder is hashed whole, and a plugin that ships node_modules is too big to review)';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const errText = (e) => (e instanceof Error ? e.message : String(e));
const TMP_PREFIX = '.tmp-';
const ID_OK = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DIGEST_OK = /^[0-9a-f]{64}$/;

// The import scan: a plain-JS copy of the one in plugin-ratify.ts (read its comment for what it
// refuses and what it cannot see; setup-lib.test.mjs checks the two agree on a table of forms).
const DATA_URL = /(?<![\w$.-])data:(?:[a-z0-9.+-]+\/[a-z0-9.+-]+|;|,)/i;
const BUILD_STEP_FILE = /\.(?:ts|mts|cts|tsx|jsx)$/i;
const PATH_TOKEN = /[^\s'"`()[\]{},;<>|&*^!+]+/g;
const LINE_CONTINUATION = new RegExp('\\\\(?:\\r\\n|[\\n\\r\\u2028\\u2029])', 'g');
const OTHER_SCHEME = /^(?:https?|wss?|ftp|node|data|npm|blob|mailto):/i;
const SCAN_HINT = 'the hash covers only the folder, so keep the code a plugin runs inside it (this scan reads comments and strings as text too: reword or remove a comment that merely mentions such a path)';
const DYNAMIC_TEMPLATES = [
  /\b(?:import|require)\s*\(\s*`[^`]*\$\{/g,
  /\bimport\.meta\.resolve\s*\(\s*`[^`]*\$\{/g,
  /\bnew\s+Worker\s*\(\s*`[^`]*\$\{/g,
  /\)\s*\(\s*`[^`]*\$\{/g,
];
/** A path the way the write gate compares it (hooks.ts): resolve, backslashes to '/', lower case, on every OS. */
export const gateCanon = (p) => resolve(p).replace(/\\/g, '/').toLowerCase();
const gateInside = (child, parent) => {
  const c = gateCanon(child);
  const r = gateCanon(parent);
  return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
};

function scanContext(opts) {
  const roots = new Set();
  for (const r of opts?.writableRoots ?? []) { if (r) { roots.add(gateCanon(r)); roots.add(gateCanon(realDeep(r))); } }
  return { roots: [...roots], real: new Map() };
}
const inRoots = (ctx, canon) => ctx.roots.some((r) => canon === r || canon.startsWith(r.endsWith('/') ? r : `${r}/`));
function jsUnescape(s) {
  const code = (n) => { try { return String.fromCodePoint(n); } catch { return ''; } };
  const out = s.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|([tnrbfv])|([\s\S]))/g,
    (_m, ub, u4, x2, oct, ctl, any) => {
      if (ub !== undefined) return code(parseInt(ub, 16));
      if (u4 !== undefined) return code(parseInt(u4, 16));
      if (x2 !== undefined) return code(parseInt(x2, 16));
      if (oct !== undefined) return code(parseInt(oct, 8));
      if (ctl !== undefined) return { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v' }[ctl];
      return any;
    });
  return out.replace(/[\t\n\r]/g, '');
}
function percentDecode(s) {
  try { return { text: decodeURIComponent(s.replace(/%(?![0-9a-fA-F]{2})/g, '%25')), ok: true }; } catch {
    return { text: s.replace(/%([0-7][0-9a-fA-F])/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), ok: false };
  }
}
function climbs(fileRel, s) {
  let depth = fileRel.split('/').length - 1;
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (--depth < 0) return true; } else depth++;
  }
  return false;
}
function absoluteCandidates(variant) {
  const v = variant.replace(/\\/g, '/');
  if (/^file:/i.test(v)) {
    const out = [];
    try { out.push(fileURLToPath(v)); } catch { /* a host the OS cannot map: use the path alone */ }
    try { out.push(decodeURIComponent(new URL(v).pathname)); } catch { /* not a URL */ }
    return out;
  }
  const d = percentDecode(v).text;
  return posix.isAbsolute(d) || /^[a-zA-Z]:\//.test(d) ? [d] : [];
}
function scanText(fileRel, rawText, ctx) {
  // NUL is legal inside a JS comment or string, so no file is skipped as binary; a NUL ends a token like a space does.
  const text = rawText.replace(/\0/g, ' ');
  const out = [];
  const seen = new Set();
  if (DATA_URL.test(text) || DATA_URL.test(jsUnescape(text))) out.push(`${fileRel} holds a data: URL (a specifier that carries code inline): data: URLs cannot be ratified, because the hash cannot see what they load; put the code in a file inside the plugin folder`);
  for (const re of DYNAMIC_TEMPLATES) {
    re.lastIndex = 0;
    if (re.test(text)) { out.push(`${fileRel} builds a module specifier from a template literal with a \${...} substitution (a dynamic specifier): the hash cannot see where it points, so use a literal specifier inside the plugin folder`); break; }
  }
  const flat = text
    .replace(LINE_CONTINUATION, '')
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h) => (parseInt(h, 16) <= 0xffff ? `\\u${h.padStart(4, '0')}` : '\\uFFFD'));
  for (const m of flat.matchAll(PATH_TOKEN)) {
    const tok = m[0];
    if (seen.has(tok)) continue;
    if (!(tok.includes('..') || tok.includes('%') || tok.includes('\\') || tok.charCodeAt(0) === 47 || /^(?:file:|[a-zA-Z]:[\\/])/i.test(tok))) continue;
    if (OTHER_SCHEME.test(tok)) continue;
    seen.add(tok);
    const variants = new Set([tok, jsUnescape(tok)]);
    let refuse = false;
    for (const v of variants) {
      const dec = percentDecode(v);
      dec.text = dec.text.replace(/\\/g, '/');
      if (!dec.ok && (/^(?:\.|\/|file:)/i.test(v) || /%(?:2e|2f|5c)/i.test(v))) {
        out.push(`${fileRel} refers to "${tok}", which holds a percent escape that cannot be decoded in something that looks like a path; ${SCAN_HINT}`);
        refuse = true;
        break;
      }
      if (climbs(fileRel, dec.text)) { refuse = true; break; }
      for (const c of absoluteCandidates(v)) {
        const abs = resolve(c);
        let real = ctx.real.get(abs);
        if (real === undefined) { real = realDeep(abs); ctx.real.set(abs, real); }
        if (inRoots(ctx, gateCanon(abs)) || inRoots(ctx, gateCanon(real))) { refuse = true; break; }
      }
      if (refuse) break;
    }
    if (refuse && !out.some((o) => o.includes(`"${tok}"`))) out.push(`${fileRel} refers to "${tok}", which is outside the plugin folder; ${SCAN_HINT}`);
  }
  return out;
}
/** One message per path in `text` (the file at posix relpath `fileRel`) that reaches outside the plugin folder,
 *  plus one for a dynamic template specifier. `opts.writableRoots` are the folders the companion can write. */
export function escapingImportsJs(fileRel, text, opts) {
  return scanText(fileRel, text, scanContext(opts));
}
/** One message per TypeScript or JSX file in `paths` (relpaths): plugins ship JavaScript. */
export function buildStepFilesJs(paths) {
  return paths.filter((p) => BUILD_STEP_FILE.test(p)).map((p) => `${p} is TypeScript or JSX; plugins ship JavaScript (Node can strip the types and run it, and the import scan does not read it): compile it to a .js or .mjs file first`);
}
/** Every refusal for a folder read by readPluginFolder: build-step files, then the text scan of each code file. */
function folderRefusals(list, opts) {
  const out = buildStepFilesJs(list.map((f) => f.rel));
  const ctx = scanContext(opts);
  for (const f of list) out.push(...scanText(f.rel, f.bytes.toString('utf-8'), ctx));
  return out;
}

/** Read every file of a plugin folder once: { list: [{ rel, bytes }], files: { rel: sha }, digest }. */
function readPluginFolder(dir) {
  const top = realpathSync(dir);
  const found = [];
  let bytes = 0;
  const stack = [{ abs: top, rel: '' }];
  while (stack.length) {
    const { abs, rel } = stack.pop();
    for (const it of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${it.name}` : it.name;
      const a = join(abs, it.name);
      if (it.isSymbolicLink()) throw new Error(`plugin folders may not contain links (${r})`);
      if (it.isDirectory()) { stack.push({ abs: a, rel: r }); continue; }
      if (!it.isFile()) throw new Error(`${r} is not a regular file`);
      bytes += lstatSync(a).size;
      if (found.length + 1 > RATIFY_MAX_FILES) throw new Error(`plugin folder has more than ${RATIFY_MAX_FILES} files; ${DEPS_HINT}`);
      if (bytes > RATIFY_MAX_BYTES) throw new Error(`plugin folder is larger than ${RATIFY_MAX_BYTES / 1024 / 1024} MiB; ${DEPS_HINT}`);
      found.push({ rel: r, abs: a });
    }
  }
  found.sort((x, y) => byPath(x.rel, y.rel));
  const files = {};
  const list = [];
  for (const f of found) { const b = readFileSync(f.abs); files[f.rel] = sha256(b); list.push({ rel: f.rel, bytes: b }); }
  return { list, files, digest: sha256(found.map((f) => `${f.rel}\0${files[f.rel]}\n`).join('')) };
}

/** Every shipped plugin folder by id: { id -> dir }. */
function shippedDirs(root) {
  const dirs = new Map();
  const base = join(root, 'plugins');
  let names = [];
  try { names = readdirSync(base).sort(); } catch { /* no plugins folder */ }
  for (const n of names) {
    try {
      const m = JSON.parse(readFileSync(join(base, n, 'sanctum.plugin.json'), 'utf-8'));
      dirs.set(typeof m.id === 'string' && m.id ? m.id : n, join(base, n));
    } catch { /* not a plugin folder */ }
  }
  return dirs;
}

function readLedgerFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    if (raw && raw.version === 1 && raw.plugins && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins)) return raw;
  } catch { /* missing or unreadable: start empty; the backend warns about a malformed one */ }
  return { version: 1, plugins: {} };
}

// (Every write below goes through the tenant file layer, guarding the tenant folder applySetup named: plain fs calls for the single-tenant wizard.)
const mkdirPrivate = (d) => { ownMkdir(ambientTenantDir(), d, { recursive: true, mode: 0o700 }); try { ownChmod(ambientTenantDir(), d, 0o700); } catch { /* the OS does not honour modes */ } };
const rmTree = (p) => { try { ownRm(ambientTenantDir(), p, { recursive: true, force: true }); } catch { /* best effort */ } };

/** Where the ledger lives: plugins.ledger_dir from `cfg`, else <root>/data/plugins. */
export function ledgerDirOf(root, cfg) {
  const raw = typeof cfg?.plugins?.ledger_dir === 'string' ? cfg.plugins.ledger_dir.trim() : '';
  if (!raw) return join(root, 'data', 'plugins');
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return resolve(root, expanded);
}

/** The person's own plugin root from `cfg` (plugins.dir), or '' for none. */
export function pluginsDirOf(root, cfg) {
  const raw = typeof cfg?.plugins?.dir === 'string' ? cfg.plugins.dir.trim() : '';
  if (!raw) return '';
  return resolve(root, raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw);
}

// The containment rule of plugins.ts (ledgerClash / writableRoots), by real path.
function realDeep(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try { const r = realpathSync.native(cur); return rest.length ? join(r, ...[...rest].reverse()) : r; } catch { /* not there yet */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.push(basename(cur));
    cur = up;
  }
}
/** The harness that runs, as the backend's activeProviderName() chooses it: AGENT_PROVIDER wins over yaml. */
export function activeProvider(cfg, env = process.env) {
  return String(env.AGENT_PROVIDER || cfg?.agent?.provider || 'claude').trim().toLowerCase();
}
/** The folders the companion can write, as [{ label, path }]: a copy of writableRoots in plugins.ts (same
 *  labels, same list, /tmp and $TMPDIR while Codex or dsh is the active provider). */
export function writableRootsJs(root, cfg, opts = {}) {
  const out = [];
  const add = (label, p) => { if (typeof p === 'string' && p.trim()) out.push({ label, path: resolve(root, p.trim() === '~' ? homedir() : p.trim().startsWith('~/') ? join(homedir(), p.trim().slice(2)) : p.trim()) }); };
  const provider = activeProvider(cfg);
  if (provider === 'codex' || provider === 'dsh') {
    const who = provider === 'codex' ? 'the Codex' : 'the dsh';
    // A tenant's harness children run with TMPDIR of their own (tenancy/child.ts): its temp folder, not the process's /tmp.
    if (opts.tmpRoot) add(`${who} sandbox's temp folder`, opts.tmpRoot);
    else {
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
  if (opts.pluginsDir) add('plugins.dir', cfg?.plugins?.dir);
  return out;
}
/** The first folder the companion can write that contains, or sits inside, the ledger folder of `cfg`
 *  (compared by real path, case folded like the write gate), or null. */
export function ledgerClash(root, cfg, opts = {}) {
  const real = realDeep(ledgerDirOf(root, cfg));
  for (const w of writableRootsJs(root, cfg, { pluginsDir: true, ...opts })) {
    const wr = realDeep(w.path);
    if (gateInside(real, wr) || gateInside(wr, real)) return w;
  }
  return null;
}

function diffFilesJs(ratified, now) {
  const out = [];
  for (const p of Object.keys(now)) {
    if (!Object.hasOwn(ratified, p)) out.push({ path: p, kind: 'added' });
    else if (ratified[p] !== now[p]) out.push({ path: p, kind: 'modified' });
  }
  for (const p of Object.keys(ratified)) if (!Object.hasOwn(now, p)) out.push({ path: p, kind: 'removed' });
  return out.sort((a, b) => byPath(a.path, b.path));
}

/** What the wizard would be ratifying for shipped plugin `id` against the ledger in `ledgerDir`:
 *  { id, kind: 'new' | 'changed' | 'unchanged' | 'error', digest, files, changes?, reason? }.
 *  'unchanged' is code already ratified whose copy is in place. */
export function planPluginRatification(root, id, ledgerDir = join(root, 'data', 'plugins'), scan) {
  const dir = shippedDirs(root).get(id);
  if (!dir) return { id, kind: 'error', reason: 'no shipped plugin with that id' };
  let r;
  try { r = readPluginFolder(dir); } catch (e) { return { id, kind: 'error', reason: errText(e) }; }
  const outside = folderRefusals(r.list, scan);
  if (outside.length) return { id, kind: 'error', reason: outside.slice(0, 3).join('; ') };
  const entry = readLedgerFile(join(ledgerDir, 'ratified.json')).plugins[id];
  const base = { id, digest: r.digest, files: Object.keys(r.files) };
  if (!entry || typeof entry.digest !== 'string') return { ...base, kind: 'new' };
  if (entry.digest === r.digest) {
    // 'unchanged' only when the copy is there AND holds the ratified bytes (the backend recomputes it the same way).
    let copy = false;
    try { copy = readPluginFolder(join(ledgerDir, 'snapshots', id, r.digest)).digest === r.digest; } catch { /* missing or damaged */ }
    return { ...base, kind: copy ? 'unchanged' : 'new' };
  }
  return { ...base, kind: 'changed', changes: diffFilesJs(entry.files && typeof entry.files === 'object' ? entry.files : {}, r.files) };
}

/** Lines for a change list: `kind  path`, at most `max`, then "and N more". */
export function formatChanges(changes, max = 10) {
  const lines = changes.slice(0, max).map((c) => `${c.kind}  ${c.path}`);
  if (changes.length > max) lines.push(`and ${changes.length - max} more`);
  return lines;
}

/** Ratify the shipped plugins the person agreed to: copy each one's code to
 *  <ledger folder>/snapshots/<id>/<digest>/ and record it in <ledger folder>/ratified.json (default
 *  <root>/data/plugins), the ledger the backend checks. Entries for other plugins are kept; copies the
 *  ledger no longer points at are deleted. `opts.expected` maps id -> the digest the person was shown:
 *  a folder that differs from it is skipped. A plugin that cannot be found, hashed or copied is
 *  reported in `skipped`. Never throws: a ledger or folder that cannot be written comes back as
 *  { ok: false, error } with nothing ratified. */
export function ratifyShippedPlugins(root, ids, opts = {}) {
  const ledgerDir = opts.ledgerDir || join(root, 'data', 'plugins');
  const file = join(ledgerDir, 'ratified.json');
  const snapRoot = join(ledgerDir, 'snapshots');
  const ratified = [];
  const skipped = [];
  const created = [];
  try {
    const ledger = readLedgerFile(file);
    const dirs = shippedDirs(root);
    mkdirPrivate(snapRoot);
    for (const id of ids) {
      const dir = dirs.get(id);
      if (!dir) { skipped.push({ id, reason: 'no shipped plugin with that id' }); continue; }
      let r;
      try { r = readPluginFolder(dir); } catch (e) { skipped.push({ id, reason: errText(e) }); continue; }
      const want = opts.expected?.[id];
      if (want !== undefined && want !== r.digest) { skipped.push({ id, reason: 'the code changed since you were shown it; run setup again' }); continue; }
      const outside = folderRefusals(r.list, { writableRoots: opts.writableRoots });
      if (outside.length) { skipped.push({ id, reason: outside.slice(0, 3).join('; ') }); continue; }
      if (!ID_OK.test(id)) { skipped.push({ id, reason: 'not a plugin id' }); continue; }
      const final = join(snapRoot, id, r.digest);
      // A copy that is already there is trusted only after its bytes are hashed again (as the backend does): a damaged one is replaced.
      let intact = false;
      if (existsSync(final)) { try { intact = readPluginFolder(final).digest === r.digest; } catch { /* damaged: replace it */ } }
      if (!intact) {
        const tmp = join(snapRoot, `${TMP_PREFIX}${id}-${process.pid}-${Date.now()}`);
        try {
          mkdirPrivate(tmp);
          for (const f of r.list) {
            const out = join(tmp, ...f.rel.split('/'));
            mkdirPrivate(dirname(out));
            ownWriteFile(ambientTenantDir(), out, f.bytes, { mode: 0o600 });
            try { ownChmod(ambientTenantDir(), out, 0o600); } catch { /* the OS does not honour modes */ }
          }
          mkdirPrivate(dirname(final));
          if (existsSync(final)) rmTree(final);
          ownRename(ambientTenantDir(), tmp, final);
          created.push(final);
        } catch (e) { rmTree(tmp); throw e; }
      }
      const old = ledger.plugins[id];
      // The copy before this one stays for a request still using it (the backend prunes it at its next start).
      const previous = old && typeof old.digest === 'string' && old.digest !== r.digest ? old.digest : typeof old?.previous === 'string' && old.previous !== r.digest ? old.previous : undefined;
      ledger.plugins[id] = { digest: r.digest, files: r.files, ratified_at: new Date().toISOString(), root: dir, ...(previous && { previous }) };
      ratified.push(id);
    }
    if (ratified.length) {
      ownMkdir(ambientTenantDir(), dirname(file), { recursive: true });
      ownWriteFileAtomic(ambientTenantDir(), file, JSON.stringify(ledger, null, 2) + '\n');
      // Only now that the ledger points at the new copies: drop the ones it no longer does.
      try {
        for (const name of readdirSync(snapRoot)) {
          if (name.startsWith(TMP_PREFIX)) continue;
          const entry = Object.hasOwn(ledger.plugins, name) ? ledger.plugins[name] : undefined;
          if (!entry) { rmTree(join(snapRoot, name)); continue; }
          const keep = new Set([entry.digest]);
          if (typeof entry.previous === 'string' && DIGEST_OK.test(entry.previous)) keep.add(entry.previous);
          for (const k of readdirSync(join(snapRoot, name))) if (!keep.has(k)) rmTree(join(snapRoot, name, k));
        }
      } catch { /* old copies linger until the app next starts */ }
    }
    return { ok: true, ratified, skipped };
  } catch (e) {
    for (const c of created) rmTree(c);
    return { ok: false, error: `could not write ${ledgerDir}: ${errText(e)}`, ratified: [], skipped };
  }
}

// ── Identity ratification at setup ────────────────────────────────────────────
// A plain-JS copy of what packages/backend/src/services/identity/ledger.ts writes for a fresh home: the baseline
// journal line, the ratified copy under <ledger folder>/snapshots/<digest>/ and ledger.json (ratified by `setup`).
// The identity file set and the digest are the backend's (services/identity/source.ts: every regular file directly in
// identity/ except dot files and avatar images; plugin-ratify.ts digestOfFiles). setup-lib.test.mjs checks the two agree,
// and that the backend reads what this writes as `ok`. Change them together.
const IDENTITY_IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|heic)$/i;
const isIdentityName = (n) => !!n && n.length <= 120 && !n.startsWith('.') && !/[\\/\0]/.test(n) && !IDENTITY_IMAGE_EXT.test(n);

/** The identity ledger folder from `cfg` (identity.ledger_dir), or <root>/data/identity. */
export function identityLedgerDirOf(root, cfg) {
  const raw = typeof cfg?.identity?.ledger_dir === 'string' ? cfg.identity.ledger_dir.trim() : '';
  if (!raw) return join(root, 'data', 'identity');
  return resolve(root, raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw);
}

/** The identity files directly in `dir`: { list: [{ rel, bytes }], files: { rel: sha }, digest }. Links and non-files are left out. */
function readIdentityFolder(dir) {
  const top = realpathSync(dir);
  const found = [];
  let bytes = 0;
  for (const it of readdirSync(top, { withFileTypes: true })) {
    if (!isIdentityName(it.name) || it.isSymbolicLink() || !it.isFile()) continue;
    const st = lstatSync(join(top, it.name));
    if (!st.isFile()) continue;
    bytes += st.size;
    if (found.length + 1 > RATIFY_MAX_FILES) throw new Error(`identity folder has more than ${RATIFY_MAX_FILES} files`);
    if (bytes > RATIFY_MAX_BYTES) throw new Error(`identity folder is larger than ${RATIFY_MAX_BYTES / 1024 / 1024} MiB`);
    found.push({ rel: it.name, abs: join(top, it.name) });
  }
  found.sort((x, y) => byPath(x.rel, y.rel));
  const files = {};
  const list = [];
  for (const f of found) { const b = readFileSync(f.abs); files[f.rel] = sha256(b); list.push({ rel: f.rel, bytes: b }); }
  return { list, files, digest: sha256(found.map((f) => `${f.rel}\0${files[f.rel]}\n`).join('')) };
}

/** Write the baseline for a fresh home: the first journal line (author baseline), the ratified copy and ledger.json (ratified by `setup`).
 *  Does nothing when the ledger folder already has a ledger.json or a journal. Refuses a ledger folder inside identity/. Never throws:
 *  { ok: true, digest, files } or { ok: false, reason }. */
export function writeIdentityBaseline(root, home, opts = {}) {
  const ledgerDir = opts.ledgerDir || join(root, 'data', 'identity');
  const idDir = join(home, 'identity');
  try {
    if (!existsSync(idDir)) return { ok: false, reason: `there is no identity folder in ${home}` };
    const realId = realDeep(idDir);
    const realLedger = realDeep(ledgerDir);
    if (gateInside(realLedger, realId) || gateInside(ledgerDir, idDir)) return { ok: false, reason: `the identity ledger folder (${ledgerDir}) is inside the identity folder` };
    if (existsSync(join(ledgerDir, 'ledger.json')) || existsSync(join(ledgerDir, 'journal.jsonl'))) return { ok: false, reason: 'the identity folder already has a ledger' };
    const r = readIdentityFolder(idDir);
    const at = (opts.now || (() => new Date().toISOString()))();
    const snapRoot = join(ledgerDir, 'snapshots');
    mkdirPrivate(snapRoot);
    const tmp = join(snapRoot, `${TMP_PREFIX}identity-${process.pid}-${Date.now()}`);
    const final = join(snapRoot, r.digest);
    try {
      mkdirPrivate(tmp);
      for (const f of r.list) {
        const out = join(tmp, f.rel);
        ownWriteFile(ambientTenantDir(), out, f.bytes, { mode: 0o600 });
        try { ownChmod(ambientTenantDir(), out, 0o600); } catch { /* the OS does not honour modes */ }
      }
      if (existsSync(final)) rmTree(final);
      ownRename(ambientTenantDir(), tmp, final);
    } catch (e) { rmTree(tmp); throw e; }
    const names = Object.keys(r.files);
    const entry = {
      at, digest_before: '', digest_after: r.digest, files: { added: names, removed: [], modified: [] }, author: 'baseline',
      detail: 'First sight of the identity folder: this is what was on disk then, and nothing has been ratified yet.',
    };
    const journal = join(ledgerDir, 'journal.jsonl');
    ownWriteFile(ambientTenantDir(), journal, JSON.stringify(entry) + '\n', { mode: 0o600 });
    try { ownChmod(ambientTenantDir(), journal, 0o600); } catch { /* the OS does not honour modes */ }
    const ledger = { version: 1, ratified: { digest: r.digest, files: r.files, ratified_at: at, by: 'setup' }, observed: { digest: r.digest, files: r.files, at, author: 'baseline', authors: [] } };
    const file = join(ledgerDir, 'ledger.json');
    ownWriteFileAtomic(ambientTenantDir(), file, JSON.stringify(ledger, null, 2) + '\n');
    return { ok: true, digest: r.digest, files: names };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/** What a person typed for the ledger folder, as an absolute path (`~` is the home folder). */
export function ledgerChoicePath(root, answer) {
  const a = String(answer || '').trim();
  return resolve(root, a === '~' ? homedir() : a.startsWith('~/') ? join(homedir(), a.slice(2)) : a);
}

/** The one line said for a plugin that was not turned on. */
export const leftOutLine = (id) => `${id} was left out of plugins.enabled. Ratify it later in Settings > Plugins, then add it to plugins.enabled.`;

/** The two lines said when the ledger would sit where the companion can write. */
export function ledgerClashLines(root, cfg, clash) {
  return [
    `The ratification ledger would live in ${ledgerDirOf(root, cfg)}, which is inside (or contains) ${clash.label} ${clash.path}.`,
    'The companion can write there, so it could ratify its own changes. Plugins stay off while that is so.',
  ];
}

/** Where the ledger will live for `cfg` and the folder the person chose when the default is in the companion's reach:
 *  { ok, ledgerDir, chosen, clash, scan, cfg }. `ok` is false while the ledger would still be somewhere the companion can write. */
export function resolveLedger(root, cfg, choice, opts = {}) {
  const clash0 = ledgerClash(root, cfg, opts);
  const scanFor = (c) => ({ writableRoots: writableRootsJs(root, c, { pluginsDir: true, ...opts }).map((w) => w.path) });
  if (!clash0) return { ok: true, ledgerDir: ledgerDirOf(root, cfg), chosen: '', clash: null, scan: scanFor(cfg), cfg };
  const chosen = choice ? ledgerChoicePath(root, choice) : '';
  if (!chosen) return { ok: false, ledgerDir: ledgerDirOf(root, cfg), chosen: '', clash: clash0, scan: null, cfg };
  const withLedger = { ...cfg, plugins: { ...(cfg?.plugins || {}), ledger_dir: chosen } };
  const clash = ledgerClash(root, withLedger, opts);
  return { ok: !clash, ledgerDir: ledgerDirOf(root, withLedger), chosen: clash ? '' : chosen, clash, scan: clash ? null : scanFor(withLedger), cfg: withLedger };
}

/** Ratify what the person accepted, and say what happened. `accepted` are the ids to write to the ledger, `expected` the
 *  digests the person was shown. Adds to `out.ratified` and `out.leftOut`. Never throws. */
function ratifyAccepted(root, accepted, ledgerDir, expected, scan, io, out) {
  if (!accepted.length) return;
  const r = ratifyShippedPlugins(root, accepted, { ledgerDir, expected, writableRoots: scan.writableRoots });
  if (!r.ok) {
    io.say(`Could not write the ratification ledger: ${r.error}`);
    for (const id of accepted) { io.say(leftOutLine(id)); out.leftOut.push(id); }
    return;
  }
  out.ratified.push(...r.ratified);
  out.written?.push(...r.ratified); // the ledger file was written for these
  for (const s of r.skipped) { io.say(`${s.id}: could not be ratified: ${s.reason}`); io.say(leftOutLine(s.id)); out.leftOut.push(s.id); }
  if (r.ratified.length) io.say(`Ratified: ${r.ratified.join(', ')} (${join(ledgerDir, 'ratified.json')}).`);
}

/** The ratification step with the person's answers already in hand (the terminal asked them one at a time, the app took them
 *  in one request): the same decisions runPluginRatification makes, without asking. `decisions` is { ledgerChoice, confirmed:
 *  { id: { confirmed, digest } } }. Says only what the ratification writes (the prompts said the rest). Returns
 *  { ratified, leftOut, ledgerDir? } like runPluginRatification. Never throws. */
export function commitPluginRatification(root, picked, cfg, decisions, io, where = {}) {
  const out = { ratified: [], leftOut: [], written: [] }; // `written`: the ids newly put in the ledger (the others were already in it)
  // `where` is for a tenant: { base } is the folder relative paths and the default ledger resolve against (root otherwise), { tmpRoot } its temp folder.
  const led = resolveLedger(where.base || root, cfg, decisions?.ledgerChoice, where.tmpRoot ? { tmpRoot: where.tmpRoot } : {});
  if (!led.ok) { out.leftOut.push(...picked); return out; }
  if (led.chosen) out.ledgerDir = led.chosen;
  const accepted = [];
  const expected = {};
  for (const id of picked) {
    const plan = planPluginRatification(root, id, led.ledgerDir, led.scan);
    if (plan.kind === 'error') { out.leftOut.push(id); continue; }
    if (plan.kind === 'unchanged') { out.ratified.push(id); continue; }
    const d = decisions?.confirmed?.[id];
    if (!d?.confirmed) { out.leftOut.push(id); continue; }
    accepted.push(id);
    expected[id] = d.digest || plan.digest;
  }
  ratifyAccepted(root, accepted, led.ledgerDir, expected, led.scan, io, out);
  return out;
}

/** The wizard's ratification step, run after every question and BEFORE sanctum.yaml is written.
 *  `io` is { say, ask, confirm }. For each chosen shipped plugin it shows what is about to be ratified
 *  (the file list for a plugin never ratified, default NO, like every ratification: you type y after reading it; the changed paths and the digest for one
 *  whose code differs from the ledger, default NO) and ratifies only what the person agrees to.
 *  Returns { ratified, leftOut, ledgerDir? }: the ids to write into plugins.enabled, the ids left out
 *  (each with a message already said), and a ledger folder the person chose when the default sat
 *  where the companion can write. Never throws.
 *  (`npm run setup` and the app now ask through the plan in setup-plan.mjs and commit with commitPluginRatification; this
 *  is the same step with the prompts inside, kept for callers that want both in one call.) */
export async function runPluginRatification(root, picked, cfg, io) {
  const out = { ratified: [], leftOut: [] };
  const left = leftOutLine;

  // The ledger must be somewhere the companion cannot write, or it could ratify its own edits.
  let ledgerCfg = cfg;
  let chosen;
  let clash = ledgerClash(root, ledgerCfg);
  while (clash) {
    for (const line of ledgerClashLines(root, ledgerCfg, clash)) io.say(line);
    const a = (await io.ask('Folder for the ratification ledger (outside every folder the companion can write; empty = leave plugins off)', '')).trim();
    if (!a) { for (const id of picked) io.say(left(id)); out.leftOut.push(...picked); return out; }
    chosen = ledgerChoicePath(root, a);
    ledgerCfg = { ...cfg, plugins: { ...(cfg?.plugins || {}), ledger_dir: chosen } };
    clash = ledgerClash(root, ledgerCfg);
  }
  const ledgerDir = ledgerDirOf(root, ledgerCfg);
  const scan = { writableRoots: writableRootsJs(root, ledgerCfg, { pluginsDir: true }).map((w) => w.path) }; // code that names a file there is refused
  if (chosen) out.ledgerDir = chosen;

  const accepted = [];
  const expected = {};
  for (const id of picked) {
    const plan = planPluginRatification(root, id, ledgerDir, scan);
    if (plan.kind === 'error') { io.say(`${id}: cannot be ratified: ${plan.reason}`); io.say(left(id)); out.leftOut.push(id); continue; }
    if (plan.kind === 'unchanged') { out.ratified.push(id); continue; }
    let ok;
    if (plan.kind === 'new') {
      io.say(`${id}: the code you are about to ratify (${plan.files.length} files):`);
      for (const f of plan.files) io.say(`  ${f}`);
      io.say(`digest ${plan.digest}`);
      ok = await io.confirm('Ratify this code?', false);
    } else {
      io.say(`${id}: the code CHANGED since you ratified it. Changed files:`);
      for (const l of formatChanges(plan.changes, 10)) io.say(l);
      io.say(`digest ${plan.digest}`);
      ok = await io.confirm('Ratify this changed code?', false);
    }
    if (!ok) { io.say(left(id)); out.leftOut.push(id); continue; }
    accepted.push(id);
    expected[id] = plan.digest;
  }
  ratifyAccepted(root, accepted, ledgerDir, expected, scan, io, out);
  return out;
}

// ── The browser tool (.mcp.json) ──────────────────────────────────────────────

/** Tools the browser entry must not expose. @playwright/mcp 0.0.83 documents both: run_code_unsafe is
 *  arbitrary JavaScript in the Playwright server process (outside dsh's sandbox, so RCE-equivalent),
 *  evaluate is arbitrary JavaScript in the page (cookies and DOM of every logged-in site). */
export const BROWSER_BLOCKED_TOOLS = Object.freeze(['browser_run_code_unsafe', 'browser_evaluate']);

/** True when a `.mcp.json` server entry runs through examples/browser-seat-neko/mcp-filter.mjs. */
export function browserEntryHasFilter(entry) {
  return entryHasFilter(entry);
}

/** The `.mcp.json` entry that gives the companion tools in the neko seat's browser. `filterPath` is the
 *  absolute path of examples/browser-seat-neko/mcp-filter.mjs; `workdir` the absolute path of a dedicated
 *  directory (the wizard passes <PROJECT_ROOT>/data/browser-out): the filter makes it the server's cwd and
 *  the server writes its output there (--output-dir), so `filename`/`paths` arguments cannot reach the
 *  companion's own folder. Playwright MCP 0.0.83 has no flag to leave a tool out (--caps only adds; both
 *  tools are "core"), so it runs behind the filter, which drops the blocked tools from tools/list and refuses
 *  calls. --no-webmcp stops it from exposing tools a page registers (the filter also strips webmcp_*).
 *  Mirrors examples/browser-seat-neko/mcp.example.json (a test keeps the two equal). `browser` is a valid
 *  server name on all three harnesses (dsh: letters, digits, _ and -; Codex: no dots). Throws on a missing path. */
export function browserMcpEntry(filterPath, workdir) {
  for (const [name, v] of [['filterPath', filterPath], ['workdir', workdir]]) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`browserMcpEntry: ${name} must be a non-empty string`);
  }
  return {
    command: 'node',
    args: [filterPath, '--block', BROWSER_BLOCKED_TOOLS.join(','), '--workdir', workdir, '--', 'npx', '-y', '@playwright/mcp@0.0.83', '--cdp-endpoint', 'http://127.0.0.1:9232', '--no-webmcp', '--output-dir', workdir],
  };
}

/** Merge the `browser` server into the text of a `.mcp.json` (`filterPath`, `workdir`: see browserMcpEntry). Never touches another server.
 *  Returns { action: 'added' | 'exists' | 'upgrade' | 'refused', text, reason?, entry?, previous? }. `text` is what to write
 *  ('' or undefined input = no file yet); it is the input unchanged unless action is 'added' or 'upgrade'.
 *  'upgrade': a `browser` entry already exists but runs without the filter (reason 'unfiltered': the companion
 *  can run arbitrary code) or with a filter call whose arguments the filter would refuse at startup (reason 'outdated': a
 *  required --block name missing, --workdir missing, relative or after `--`). `text` has it replaced by `entry`; `previous` is what was there. The caller asks before writing.
 *  'refused' means the file is not a JSON object (or `mcpServers` is not one): say so, write nothing. */
export function mergeBrowserMcp(text, filterPath, workdir) {
  const entry = browserMcpEntry(filterPath, workdir);
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return { action: 'added', text: JSON.stringify({ mcpServers: { browser: entry } }, null, 2) + '\n' };
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return { action: 'refused', text: raw, reason: `not valid JSON (${e.message})` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { action: 'refused', text: raw, reason: 'the top level is not an object' };
  if (doc.mcpServers === undefined) doc.mcpServers = {};
  else if (!doc.mcpServers || typeof doc.mcpServers !== 'object' || Array.isArray(doc.mcpServers)) return { action: 'refused', text: raw, reason: '"mcpServers" is not an object' };
  if (Object.prototype.hasOwnProperty.call(doc.mcpServers, 'browser')) {
    const previous = doc.mcpServers.browser;
    const reason = browserEntryProblem(previous); // the same check the filter applies to its own argv at startup
    if (!reason) return { action: 'exists', text: raw };
    doc.mcpServers.browser = entry;
    return { action: 'upgrade', reason, entry, previous, text: JSON.stringify(doc, null, 2) + '\n' };
  }
  doc.mcpServers.browser = entry;
  return { action: 'added', text: JSON.stringify(doc, null, 2) + '\n' };
}
