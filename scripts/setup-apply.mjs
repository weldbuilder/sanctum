// setup-apply.mjs — what the setup wizard reads (gatherSetupEnv) and everything it writes (applySetup).
//
// The plan in setup-plan.mjs only asks. This file is the other half, shared by `npm run setup` and the app's
// /api/setup/apply: it backs up and writes sanctum.yaml, .env, Codex's config.toml and .mcp.json, makes the home folder
// and the Discord lists, and ratifies plugins. It never puts a secret into a line it says or a value it returns.
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { ownChmod, ownCopyFile, ownCp, ownMkdir, ownReadFile, ownReadProblem, ownWriteFile, withAmbientTenant, withScanMemo } from './own-files-lib.mjs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyAnswers, applyDiscordAnswers, boundOrigin, chooseCompanionPlugins, chooseEnabledPlugins, commitPluginRatification, createPrivateLists,
  envValueOf, identityLedgerDirOf, ledgerDirOf, mergeBrowserMcp, pluginsDirOf, readDbConfig, setTomlTopLevel, tomlFeatures, upsertEnv, upsertTomlSection, wizardDbPath, writeIdentityBaseline,
} from './setup-lib.mjs';
import { buildAnswers } from './setup-plan.mjs';
import { DEFAULT_REVIEN_URL, WIZARD_DEFAULTS, inheritedBase, overlay, processTimezoneOf, pruneToDifferences, readProcessFile, removalMarkers, tenantFilesProblem, tenantPaths, tenantYamlProblems, withRemovalMarkers, withoutMarked } from './setup-inherit.mjs';

const require = createRequire(import.meta.url);
const YAML_NAMES = ['sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml'];

/** The sanctum.yaml in `root`; a file from before the rename is kept and edited in place. */
export function configPathIn(root) {
  return YAML_NAMES.map((n) => join(root, n)).find((p) => existsSync(p)) || join(root, 'sanctum.yaml');
}

/** Everything the plan reads from this computer: the config, .env, Codex's config.toml, .mcp.json, the Discord toggle.
 *  `opts.processEnv` (default process.env) and `opts.homeDir` are for tests; `opts.codexInstalled` skips the probe, `opts.timezoneDefault` fixes the zone, `opts.discordToggle` and `opts.savedPassword`
 *  are what a running server already knows. */
export function gatherSetupEnv(root, opts = {}) {
  if (opts.tenantDir) return gatherTenantEnv(root, opts);
  const processEnv = opts.processEnv || process.env;
  const homeDir = opts.homeDir || homedir();
  const yamlPath = configPathIn(root);
  const hasConfigFile = existsSync(yamlPath);
  const yaml = require('js-yaml');
  let existing = {};
  if (hasConfigFile) existing = yaml.load(readFileSync(yamlPath, 'utf-8')) || {};
  const envPath = join(root, '.env');
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : (existsSync(join(root, '.env.example')) ? readFileSync(join(root, '.env.example'), 'utf-8') : '');
  const codexHome = processEnv.CODEX_HOME || join(homeDir, '.codex');
  const tomlPath = join(codexHome, 'config.toml');
  const mcpJsonPath = resolve(root, existing.agent?.mcp_json_path || './.mcp.json');
  let codexProbe;
  return {
    root, homeDir, existing, yamlPath, hasConfigFile, envPath, envText, codexHome, tomlPath,
    tomlText: existsSync(tomlPath) ? readFileSync(tomlPath, 'utf-8') : '',
    hasDatabase: existsSync(join(root, 'data', 'sanctum.db')) || existsSync(join(root, 'data', 'resonant.db')) || existsSync(resolve(root, String(existing.server?.db_path || 'data/sanctum.db'))),
    // Discord is on when the yaml says so OR the Settings toggle (a row in the app's database) does: read from the file the server opens.
    // (A running server passes the toggle it already has, `opts.discordToggle`.)
    discordToggle: Object.hasOwn(opts, 'discordToggle') ? opts.discordToggle : readDbConfig(wizardDbPath(root, existing, processEnv.DB_PATH), 'discord.enabled'),
    // A password that is set somewhere other than .env (the environment, sanctum.yaml); the app keeps it when no new one is typed.
    savedPassword: typeof opts.savedPassword === 'string' ? opts.savedPassword : '',
    mcpJsonPath,
    mcpJsonText: existsSync(mcpJsonPath) ? readFileSync(mcpJsonPath, 'utf-8') : '',
    timezoneDefault: opts.timezoneDefault || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    // Asked only when the Codex branch is reached, and once.
    isCodexInstalled: () => {
      if (typeof opts.codexInstalled === 'boolean') return opts.codexInstalled;
      if (codexProbe === undefined) codexProbe = spawnSync('codex', ['--version'], { stdio: 'pipe', shell: process.platform === 'win32', timeout: 5000 }).status === 0;
      return codexProbe;
    },
  };
}

/** The same reads for one tenant (`opts.tenantDir`, `opts.tenantId`): its tenant.yaml, its .env, its database, its harness homes. `root` stays the
 *  app folder (shipped plugins, examples, the operator's sanctum.yaml that the tenant inherits from). The plan sees the tenant's effective config
 *  (the inherited base under tenant.yaml); applySetup writes back only what differs from the base. */
function gatherTenantEnv(root, opts) {
  const homeDir = opts.homeDir || homedir();
  const tenantDir = resolve(opts.tenantDir);
  const t = tenantPaths(tenantDir);
  // Every read of a tenant file here is a guarded open (no link, no pipe, no hard link: a pipe at tenant.yaml would otherwise hold the event loop
  // for every tenant through GET /api/setup/plan). A missing file reads as ''; a refusal throws with code tenant_refused (the route answers 400).
  const readTenantText = (path) => {
    try { return ownReadFile(tenantDir, path, { encoding: 'utf-8' }); } catch (err) { if (err?.code === 'ENOENT') return ''; throw err; }
  };
  const processFile = readProcessFile(root);
  const inherit = processFile.tenants?.inherit !== false;
  const yaml = require('js-yaml');
  const hasConfigFile = existsSync(t.yamlPath);
  let tenantYaml = {};
  if (hasConfigFile) tenantYaml = yaml.load(readTenantText(t.yamlPath)) || {};
  const inherited = inherit ? inheritedBase(processFile) : {};
  // The process timezone, in the order the backend resolves it (parent environment, process .env, the file, UTC).
  const processTimezone = processTimezoneOf(root, processFile, opts.processEnv || process.env);
  const tomlPath = join(t.harness.CODEX_HOME, 'config.toml');
  const mcpJsonPath = resolve(tenantDir, tenantYaml.agent?.mcp_json_path || t.mcpJsonPath);
  let codexProbe;
  const effective = overlay(inherited, tenantYaml);
  return {
    // Household mode (tenants.auth, default household): the house has the one password, so a companion's wizard asks none and its hosts are not read.
    household: typeof opts.household === 'boolean' ? opts.household : processFile.tenants?.auth !== 'per-tenant',
    root, homeDir, tenantDir, tenantsDir: dirname(tenantDir), tenantId: opts.tenantId || '', operator: !!opts.operator, inherited, tenantYaml, processTimezone, harness: t.harness, tmpRoot: t.tmp,
    // The process's own Revien address (the operator's file, else the shipped default): a tenant never names it.
    processRevienUrl: (typeof processFile.revien?.url === 'string' && processFile.revien.url.trim()) || DEFAULT_REVIEN_URL,
    existing: effective, yamlPath: t.yamlPath, hasConfigFile, envPath: t.envPath,
    envText: readTenantText(t.envPath), // (no .env.example: a tenant's .env holds only what it sets)
    codexHome: t.harness.CODEX_HOME, tomlPath, tomlText: readTenantText(tomlPath),
    hasDatabase: existsSync(t.dbPath),
    // SQLite opens the database, not us: the same check first, so a pipe or a link at sanctum.db reads as "no database".
    discordToggle: Object.hasOwn(opts, 'discordToggle') ? opts.discordToggle : (ownReadProblem(tenantDir, t.dbPath, { kind: 'file' }) ? null : readDbConfig(t.dbPath, 'discord.enabled')),
    savedPassword: typeof opts.savedPassword === 'string' ? opts.savedPassword : '',
    mcpJsonPath, mcpJsonText: readTenantText(mcpJsonPath),
    timezoneDefault: processTimezone,
    isCodexInstalled: () => {
      if (typeof opts.codexInstalled === 'boolean') return opts.codexInstalled;
      if (codexProbe === undefined) codexProbe = spawnSync('codex', ['--version'], { stdio: 'pipe', shell: process.platform === 'win32', timeout: 5000 }).status === 0;
      return codexProbe;
    },
  };
}

const stamp = () => new Date().toISOString();
/** A time as the tail of a file name: Windows refuses `:` and the other reserved characters, so keep letters, digits and `-` (still sorts by time). */
const fileSafe = (t) => String(t).replace(/[^0-9A-Za-z_-]/g, '-');
/** Copy `path` to `path.bak-<time>` when it exists; returns the backup's path or ''. A backup never replaces
 * an earlier one: a name already taken (the CLI and the app saving in the same millisecond) gets -1, -2, ... */
export function backupFile(path, now = stamp, mode, tenantDir = '') {
  if (!existsSync(path)) return '';
  const base = `${path}.bak-${fileSafe(now())}`;
  let bak = base;
  for (let n = 1; ; n++) {
    try { ownCopyFile(tenantDir, path, bak, fsConstants.COPYFILE_EXCL); break; } catch (err) {
      if (err?.code !== 'EEXIST' || n > 1000) throw err;
      bak = `${base}-${n}`;
    }
  }
  if (mode !== undefined) { try { ownChmod(tenantDir, bak, mode); } catch { /* the OS does not honour modes */ } }
  return bak;
}

/** What needs a restart to take effect: whatever the running process captured at boot. */
export function restartNeeded(before, after) {
  const pick = (c) => JSON.stringify({ agent: c.agent, cors: c.cors, revien: c.revien, command_center: c.command_center, server: c.server, discord: c.discord, plugins: c.plugins, integrations: c.integrations });
  return pick(before || {}) !== pick(after || {});
}

/** Say the Discord lists' outcome, as the terminal always has. */
function discordWrite(a, say) {
  const { created, kept } = createPrivateLists(a.privateDir);
  say(`Discord lists in ${a.privateDir}:`);
  if (created.length) say(`  created ${created.join(', ')}. The entries in them are MADE UP: open each file and replace them with your own.`);
  if (kept.length) say(`  kept ${kept.join(', ')} exactly as it was.`);
  say('  Keep that folder private: never commit it, post it, or paste it into a chat.');
  return { created, kept };
}

/**
 * Write everything the answers call for, in the order the terminal wizard always has: the home folder, the plugin ratification,
 * Codex's config.toml, .mcp.json, the Discord lists, sanctum.yaml, .env. `answers` is buildAnswers(...) of the plan's values;
 * `plan` is what setupPlan returned (it carries the inputs it was built from). `io.say` gets the lines the terminal prints
 * (collected as notes by the app); `opts.writer` names who wrote the yaml in its first comment. A secret is never said or returned
 * except a password made up here, once, in `generatedPassword`.
 * Returns { wrote, changed, notes, restartNeeded, generatedPassword, config, leftOut, ratified }.
 */
export function applySetup(answers, plan, io = {}, opts = {}) {
  // Every write below is guarded by the tenant file layer for this tenant's folder (the plain fs call for the single-tenant wizard).
  // One scan of the tenant folder per apply: the pre-write check and the dry run of the candidate tenant.yaml share it.
  return withAmbientTenant(plan?.env?.tenantDir || '', () => withScanMemo(() => applySetupIn(answers, plan, io, opts)));
}

function applySetupIn(answers, plan, io, opts) {
  const say = io.say || (() => {});
  const env = plan.env;
  const root = env.root;
  const tenantDir = env.tenantDir || '';
  // Where relative paths and the defaults resolve from: the app folder, or a tenant's folder. Shipped plugins and examples stay under `root`.
  const base = tenantDir || root;
  const where = tenantDir ? { base, tmpRoot: env.tmpRoot } : {};
  const ex = plan.existing;
  const shipped = plan.shipped || [];
  const a = { ...answers };
  const wrote = [];
  const changed = [];
  const now = opts.now || stamp;
  const result = { wrote, changed, notes: [], leftOut: [], ratified: [] };

  // A tenant's own files and folders are its own: a link or a second hard link at tenant.yaml, .env, home/, private/ or data/ would make the writes
  // below land in the app's files or another tenant's. Said before the first write, in the sentence boot uses.
  if (tenantDir) { const files = tenantFilesProblem(tenantDir); if (files) throw refused(files); }
  // A tenant.yaml the backend would skip at boot is never written (nor is anything else): said before the first write.
  if (tenantDir) tenantCandidate(a, env, ex, opts, base);

  // A password has to come from somewhere before anything is written: typed now, or already saved (in .env, the environment or
  // sanctum.yaml). The terminal makes one up and shows it; the app never does, since it would have to send it back.
  const savedPassword = envValueOf(env.envText, 'APP_PASSWORD') || env.savedPassword || '';
  if (!a.password && !savedPassword && !env.household) throw new Error('A password is needed: choose one.');

  // The home folder, from the starter template, when it is not there yet and the person said to.
  const home = a.home || '';
  if (home && a.homeCreate && !existsSync(join(home, 'identity', 'profile.md')) && !existsSync(home)) {
    ownMkdir(tenantDir, dirname(home), { recursive: true });
    ownCp(tenantDir, join(root, 'companion-home'), home, { recursive: true });
    changed.push({ path: home, what: 'the home folder, from the starter template' });
    // The starter identity is the baseline: the first line of the identity journal, and the ratified copy (by `setup`), so the
    // companion's first run is on a version the person chose by running setup. An existing home gets its baseline at the first
    // server boot instead, and stays unratified until the person ratifies it in Settings > Identity.
    const ledgerDir = identityLedgerDirOf(base, ex);
    const baseline = writeIdentityBaseline(root, home, { ledgerDir });
    if (baseline.ok) {
      changed.push({ path: ledgerDir, what: 'the identity ledger: the starter identity is recorded as ratified at setup' });
      say(`Identity: the starter files in ${join(home, 'identity')} are recorded as ratified (${baseline.digest.slice(0, 12)}). Changes after this wait for you in Settings > Identity.`);
    } else {
      result.notes.push(`The identity ledger was not written (${baseline.reason}). The app will take a first look at the identity folder when it starts; ratify it in Settings > Identity.`);
      say(`Identity: no ledger written (${baseline.reason}).`);
    }
  }

  // Plugins: ratified BEFORE anything is written (only when you manage them). plugins.enabled holds only ids that are
  // ratified NOW: the shipped ones that ratified in this run, and the person's own that already have a ratification (an
  // unratified one is left out, with a message naming the Settings page). Declined, failed or unratifiable ones are left
  // out. When the companion manages plugins there is nothing to ratify: the chosen ones are turned on as they are.
  if (a.pluginsTrust === 'companion') {
    if (shipped.length || (Array.isArray(ex.plugins?.enabled) && ex.plugins.enabled.length)) {
      a.pluginsEnabled = chooseCompanionPlugins(ex.plugins?.enabled, shipped, a.pluginsPicked || []);
    }
  } else {
    let ratifiedNow = [];
    if (a.pluginsToRatify?.length) {
      const r = commitPluginRatification(root, a.pluginsToRatify, applyAnswers(ex, a), { ledgerChoice: a.ledgerChoice, confirmed: a.ratify }, { say }, where);
      ratifiedNow = r.ratified;
      result.ratified = r.ratified;
      result.leftOut = r.leftOut;
      if (r.ledgerDir) a.pluginsLedgerDir = r.ledgerDir;
      // Listed only when the ledger file was written: nothing confirmed, or code already in the ledger, writes nothing.
      if (r.written.length) changed.push({ path: join(r.ledgerDir || ledgerDirOf(base, applyAnswers(ex, a)), 'ratified.json'), what: 'the plugin ratification ledger' });
      say(r.ratified.length ? `Turned on: ${r.ratified.join(', ')}.` : 'No plugin was turned on.');
      say();
    }
    if (shipped.length || (Array.isArray(ex.plugins?.enabled) && ex.plugins.enabled.length)) {
      const cfgNow = applyAnswers(ex, a);
      a.pluginsEnabled = chooseEnabledPlugins(ex.plugins?.enabled, shipped, ratifiedNow, { ledgerDir: ledgerDirOf(base, cfgNow), personDir: pluginsDirOf(base, cfgNow), say });
    }
  }

  // Codex's config.toml: a provider block, its default model, the memories flag. Backed up first.
  let tomlText = env.tomlText || '';
  let tomlDirty = false;
  if (a.addProvider) {
    const p = a.addProvider;
    if (p.baseUrl) {
      const block = { name: p.name, base_url: p.baseUrl, wire_api: 'responses' };
      if (p.key) block.experimental_bearer_token = p.key;
      tomlText = upsertTomlSection(tomlText, `model_providers.${p.id}`, block);
      tomlDirty = true;
      if (p.makeDefault) tomlText = setTomlTopLevel(tomlText, { ...(p.model ? { model: p.model } : {}), model_provider: p.id });
    }
  }
  if (a.codexMemories === 'off') { tomlText = upsertTomlSection(tomlText, 'features', { ...tomlFeatures(tomlText), memories: false }); tomlDirty = true; }
  else if (a.codexMemories === 'on') { tomlText = upsertTomlSection(tomlText, 'features', { ...tomlFeatures(tomlText), memories: true }); tomlDirty = true; }
  if (tomlDirty) {
    ownMkdir(tenantDir, env.codexHome, tenantDir && process.platform !== 'win32' ? { recursive: true, mode: 0o700 } : { recursive: true });
    const bak = backupFile(env.tomlPath, now, undefined, tenantDir);
    if (bak) say(`Backed up ${env.tomlPath} to ${bak}`);
    ownWriteFile(tenantDir, env.tomlPath, tomlText, 'utf-8');
    say(`Wrote ${env.tomlPath}`);
    wrote.push(env.tomlPath);
    changed.push({ path: env.tomlPath, what: 'Codex config.toml' });
  }

  // The browser entry in .mcp.json, merged with whatever is there, backed up first.
  // (A tenant gets the entry only when its own config names a browser seat: the process's seat is never handed to a tenant.)
  if (a.browserEntry && (!tenantDir || ex.integrations?.browser_url)) {
    const browserOutDir = resolve(base, 'data', 'browser-out');
    const m = mergeBrowserMcp(env.mcpJsonText || '', resolve(root, 'examples', 'browser-seat-neko', 'mcp-filter.mjs'), browserOutDir);
    if (m.action === 'added' || m.action === 'upgrade') {
      const bak = backupFile(env.mcpJsonPath, now, undefined, tenantDir);
      if (bak) say(`Backed up ${env.mcpJsonPath} to ${bak}`);
      ownWriteFile(tenantDir, env.mcpJsonPath, m.text, 'utf-8');
      ownMkdir(tenantDir, browserOutDir, { recursive: true, mode: 0o700 });
      ownChmod(tenantDir, browserOutDir, 0o700);
      say(`${m.action === 'upgrade' ? 'Replaced' : 'Added'} the "browser" tool in ${env.mcpJsonPath}; its files go to ${browserOutDir}`);
      wrote.push(env.mcpJsonPath);
      changed.push({ path: env.mcpJsonPath, what: 'the browser tool in .mcp.json' });
    }
  }

  // sanctum.yaml (and the Discord lists that go with it).
  const cfg = applyAnswers(ex, a);
  if (a.discord) {
    cfg.discord = applyDiscordAnswers(cfg.discord, a.discord);
    const r = discordWrite(a.discord, say);
    changed.push({ path: a.discord.privateDir, what: `the Discord private lists (${[...r.created, ...r.kept].join(', ')})` });
  }
  const yaml = require('js-yaml');
  const header = tenantDir
    ? `# tenant.yaml — written by ${opts.writer || 'npm run setup'}. Only what differs from the operator's sanctum.yaml and the defaults; see
# docs/MULTI-TENANT.md ("What a tenant inherits").
`
    : `# sanctum.yaml — written by ${opts.writer || 'npm run setup'}. Every key has a default; see
# sanctum.example.yaml for the whole surface and what each one means.
`;
  const out = tenantDir ? tenantYaml(cfg, env, base) : cfg;
  if (tenantDir) {
    const problem = opts.check?.(out) || tenantYamlProblems(out, tenantDir, env.processTimezone, problemContext(env, opts))[0];
    if (problem) throw refused(`${problem}: this tenant.yaml would not start, so nothing more was written`);
  }
  // The terminal wizard has always overwritten sanctum.yaml in place; the app keeps a copy first (opts.backupConfig).
  if (opts.backupConfig) {
    const bak = backupFile(env.yamlPath, now, undefined, tenantDir);
    if (bak) { say(`Backed up ${env.yamlPath} to ${bak}`); changed.push({ path: bak, what: 'a copy of the old sanctum.yaml' }); }
  }
  const yamlText = header + yaml.dump(out, { lineWidth: -1, quotingType: '"', forceQuotes: true });
  ownWriteFile(tenantDir, env.yamlPath, yamlText, 'utf-8');
  wrote.push(env.yamlPath);
  changed.push({ path: env.yamlPath, what: 'sanctum.yaml' });

  // .env: the password (only when one was typed: an empty answer keeps the saved one, wherever it lives), the Anthropic key, and
  // DeepSeek Harness's route key under the variable the config names (agent.dsh.api_key_env, else DEEPSEEK_API_KEY).
  const envValues = {};
  if (a.password) envValues.APP_PASSWORD = a.password;
  if (a.provider === 'claude' && a.anthropicKey) envValues.ANTHROPIC_API_KEY = a.anthropicKey;
  if (a.provider === 'dsh' && a.dshKey) envValues[ex?.agent?.dsh?.api_key_env || 'DEEPSEEK_API_KEY'] = a.dshKey;
  if (Object.keys(envValues).length) {
    if (opts.backupConfig) {
      const bak = backupFile(env.envPath, now, 0o600, tenantDir); // a copy of secrets: owner-only
      if (bak) { say(`Backed up ${env.envPath} to ${bak}`); changed.push({ path: bak, what: 'a copy of the old .env (owner-only)' }); }
    }
    // A new .env holds secrets: owner-only from the start (the mode applies only when the file is created; a file that is there keeps its own).
    // (A tenant's .env is written to a temp file in its folder, made owner-only, and renamed over the old one: never through an entry that is already there.)
    ownWriteFile(tenantDir, env.envPath, upsertEnv(env.envText, envValues), { encoding: 'utf-8', mode: 0o600 });
    wrote.push(env.envPath);
    changed.push({ path: env.envPath, what: '.env (the password and keys, never shown)' });
  }
  say(`Wrote ${env.yamlPath}`);
  if (Object.keys(envValues).length) say(`Wrote ${env.envPath}`);
  const bound = tenantDir ? '' : boundOrigin(cfg);
  if (bound) say(`Your server listens on ${cfg.server.host}, so ${bound} was added to cors.origins: the address you open in the browser has to be in that list or the page says "Disconnected".`);
  result.config = cfg;
  result.restartNeeded = tenantDir ? true : restartNeeded(ex, cfg);
  return result;
}

/** An error the app answers with 400: the answers are the problem, not the server. */
const refused = (message) => Object.assign(new Error(message), { code: 'tenant_refused' });

/** What the terminal wizard checks besides the yaml itself: the other tenants' hosts and the tenant's own .env. The first-run page (opts.check, the
 *  backend's own dry run) keeps its own checks as they were. */
const problemContext = (env, opts) => (opts.check ? { processRevienUrl: env.processRevienUrl } : { tenantsDir: env.tenantsDir, tenantId: env.tenantId, envText: env.envText, processRevienUrl: env.processRevienUrl });

/** The tenant.yaml for `cfg` (the whole effective config the answers made): only what differs from the inherited base and the shipped defaults,
 *  the tenant's own identity and hosts kept, and the folder defaults (home/, private/) left out. */
function tenantYaml(cfg, env, base) {
  const t = tenantPaths(base);
  const drop = [];
  if (cfg.agent?.cwd && resolve(cfg.agent.cwd) === resolve(t.home)) drop.push('agent.cwd');
  if (cfg.discord?.private_dir && resolve(cfg.discord.private_dir) === resolve(t.privateDir)) drop.push('discord.private_dir');
  // A tenant's unset revien.enabled means off (the process's daemon is never shared by default), so only an `enabled: true` is written.
  // What the tenant took away from the operator's file (a key set to ~, a mapping set to {} or holding `inherit: false`) stays taken away: the answers are
  // compared with what is still inherited, and a mapping the wizard writes into gets `inherit: false`, so it never starts inheriting again.
  const markers = removalMarkers(env.tenantYaml);
  let own = pruneToDifferences(cfg, withoutMarked(env.inherited || {}, markers), drop, { ...WIZARD_DEFAULTS, 'revien.enabled': false });
  own = withRemovalMarkers(own, markers, env.inherited || {});
  // The process's timezone is every tenant's default, and a tenant cannot change it from inside: it is written only when the tenant already named it.
  if (own.identity && own.identity.timezone === env.processTimezone && env.tenantYaml?.identity?.timezone == null) delete own.identity.timezone;
  // hosts and the keys the tenant already had that the base does not name stay as they were (applyAnswers kept them in cfg).
  return own;
}

/** The candidate tenant.yaml, checked before any write (the plan's own answers, so what ratification may still add is only the plugin list). */
function tenantCandidate(a, env, ex, opts, base) {
  const withLedger = a.ledgerChoice ? { ...a, pluginsLedgerDir: resolve(base, a.ledgerChoice) } : a;
  let cfg = applyAnswers(ex, withLedger);
  if (a.discord) cfg.discord = applyDiscordAnswers(cfg.discord, a.discord);
  const out = tenantYaml(cfg, env, base);
  const problem = opts.check?.(out) || tenantYamlProblems(out, env.tenantDir, env.processTimezone, problemContext(env, opts))[0];
  if (problem) throw refused(`${problem}: this tenant.yaml would not start, so nothing was written`);
}

/** The answers of a finished plan, flat, ready for applySetup. */
export const answersOf = (values, plan) => buildAnswers(values, plan);
