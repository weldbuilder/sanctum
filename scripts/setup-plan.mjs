// setup-plan.mjs — the setup wizard's questions, as data.
//
// `setupPlan(existingConfig, env)` returns the ordered steps. Two things walk it: `npm run setup` (scripts/setup-walk.mjs,
// which prints the words below) and the in-app wizard (the routes in packages/backend/src/routes/setup.ts, which send
// the steps to the browser). A step only describes a question and what follows from the answer; nothing here writes a
// file. Every write is in `applySetup` (scripts/setup-apply.mjs), so the two cannot drift.
//
// A step is { id, kind, question, help?, default, options?, when?(answers), validate?(value, answers) } where
//   kind      'text' | 'yesno' | 'choice' | 'multichoice' | 'secret'
//   question  a string, or (answers) => string
//   appQuestion  the same, for the in-app wizard only, when the terminal's words do not hold there (the recordings pin the terminal's)
//   help      lines shown with the question (a function of the answers when it depends on them)
//   default   the answer Enter keeps; a function of the answers when an earlier answer changes it
//   options   for 'choice' ([{ value, label, detail? }]) and 'multichoice' ([{ value, label, on? }])
//   when      the step is asked only when this holds for the answers so far (all answers are by step id)
//   validate  '' when the value is fine, else the sentence to show; the in-app wizard shows it inline
// and, for the words of the terminal wizard:
//   label     a short name for the question, where `question` alone says too little ("Which one?"): used by the "Kept:" lines
//   section   the title of the screen group (also the terminal's `— heading —` unless `intro` names another)
//   intro     (answers) => null | { heading?, lines? }: said before the step's slot, asked or not
//   cli       lines only the terminal prints (the numbered lists; the app draws the options instead)
//   after     (value, answers, { generated }) => lines said after the answer
//   otherwise (answers) => lines said in the step's place when it is not asked
//   outro     (answers) => lines said after the step's slot, asked or not
//   coerce    (raw, answers) => value, or { value, say?, set? }: what the answer becomes (paths resolved, ids trimmed)
//   parse     (raw, answers) => value, for a choice typed in the terminal that is not a number
//   style     'bracket' for a yes/no shown as [Y/n]
//   retry     asked again while validate has something to say (the ledger folder)
//   generate  () => value, made up when the answer is empty (the password)
//
// Phases. Every step belongs to phase one (the tier-zero questions of a first run: names, timezone, home folder, provider and its
// model and key, the app-write switch, the orchestrator switch, the password, the memory choice) or phase two (everything else:
// Codex provider edits, write roots, long-conversation memory, plugins, pictures and summaries, Discord, the browser, the phone).
// `env.phase` says which are asked: 'one' (phase one only), 'more' (phase two, and any phase-one question not answered yet), 'all'
// (everything, in the original order; the default for the plan itself, and the only mode a tenant has). A phase-one question whose
// answer is already in the config is not asked again ("Kept: ..." says so); a phase-two question left for later takes its default,
// which is what pressing Enter did, except the `leave` steps (plugins, the browser entry, Discord's ids and folder), which are
// left alone so a run that did not ask about them cannot write them. Each step carries `phase` and, when not asked, `skip`
// ('later' | 'set').
//
// The plan reads files (the shipped plugins, the ratification ledger, .mcp.json, which folders exist) to compute its
// text and defaults, and writes none. `env` is what gatherSetupEnv (setup-apply.mjs) collects, or a test's own.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  applyAnswers, defaultPrivateDir, discordEnabled, envQuote, formatChanges, generatePassword, ledgerChoicePath, ledgerClash, ledgerClashLines, leftOutLine, listShippedPlugins,
  envRawOf, envValueOf, mergeBrowserMcp, parseCodexConfig, parsePluginSelection, parsePluginTrust, planPluginRatification, privateDirProblem, resolveLedger, rollingDefaults, tomlFeatures,
} from './setup-lib.mjs';
import { namedPathInsideTenant } from './own-files-lib.mjs';
import { hostProblem, normaliseRevienAddress, tenantHostClaims, tenantPaths } from './setup-inherit.mjs';

export const STEP_KINDS = Object.freeze(['text', 'yesno', 'choice', 'multichoice', 'secret']);

/** Providers the wizard knows the address and model of. */
export const CODEX_PRESETS = Object.freeze({
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
});
const presetOf = (id) => (Object.hasOwn(CODEX_PRESETS, id) ? CODEX_PRESETS[id] : {});
const DISCORD_ID = /^\d{15,25}$/;
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

/** Why a value cannot be kept in .env (envQuote refuses it), or ''. */
function envProblem(value) {
  try { envQuote(value); return ''; } catch (e) { return e.message; }
}

/** `x` as a value, or called with `args` when it is a function. */
const val = (x, ...args) => (typeof x === 'function' ? x(...args) : x);

/** The tier-zero questions (phase one), in the order they are asked. The rest is phase two. */
export const PHASE_ONE = Object.freeze([
  'companionName', 'userName', 'timezone', 'home', 'homeCreate', 'provider', 'codexModel', 'claudeModel', 'dshModel', 'anthropicKey', 'dshKey',
  'appWrite', 'orchestrator', 'password', 'memory', 'revienUrl', 'codexMemoriesOff', 'codexMemoriesOn',
]);
/** Steps that write something outside the config answers (a folder, a ratification, .mcp.json): never answered on the person's behalf. */
const LEAVE = Object.freeze(['pluginsTrust', 'plugins', 'ledgerDir', 'browserEntry', 'discordOwnerUserId', 'discordOwnerChannelId', 'discordPrivateDir']);

export function setupPlan(existingConfig, env = {}) {
  const ex = existingConfig && typeof existingConfig === 'object' ? existingConfig : {};
  const root = env.root;
  // Tenant mode (npm run setup -- --tenant <id>, or the first-run page of a tenant): the same plan against a tenant's folder. `root` is still the
  // app (shipped plugins, examples); `tenantDir` is where the answers' paths and the defaults live, and `ex` is the tenant's effective config.
  const tenantDir = env.tenantDir || '';
  const base = tenantDir || root;
  const tp = tenantDir ? tenantPaths(tenantDir) : null;
  const outside = (p) => (tenantDir && p && !namedPathInsideTenant(tenantDir, String(p)) ? `${p} is outside the tenant folder (${tenantDir}). A tenant's files stay in its folder.` : '');
  const loginHelp = (cmd) => (tenantDir ? [`This tenant's login lives in ${tp.harness.CLAUDE_CONFIG_DIR}, ${tp.harness.CODEX_HOME} and ${tp.harness.DSH_HOME}: run ${cmd} with CLAUDE_CONFIG_DIR / CODEX_HOME / DSH_HOME set to them (never copy credential files between tenants).`] : []);
  const homeDir = env.homeDir || homedir();
  const expand = (p) => (p.startsWith('~') ? join(homeDir, p.slice(1)) : p);
  // A path typed in an answer, made absolute: `~` is the home folder and a relative one is the app folder (`root`), the folder the
  // terminal wizard runs from, not whatever folder the server happens to have been started in (packages/backend).
  const abs = (p) => resolve(base || process.cwd(), expand(String(p)));
  // What a saved .env value is: what the server reads (dotenv's parse), not the line with its quotes. A value is shown as its line is written.
  const envVal = (k) => envValueOf(env.envText, k);
  const envShown = (k) => (value) => (value && value === envVal(k) ? envRawOf(env.envText, k) || value : value);
  const tomlText = env.tomlText || '';
  const tomlPath = env.tomlPath || '';
  const cx = parseCodexConfig(tomlText);
  const memoriesOn = tomlFeatures(tomlText).memories === true;
  const shipped = root ? listShippedPlugins(root) : [];
  const onPlugins = new Set(Array.isArray(ex.plugins?.enabled) ? ex.plugins.enabled : []);
  const d = ex.discord || {};
  const discordOnAlready = discordEnabled(ex, env.discordToggle);
  const browserUrl = !!ex.integrations?.browser_url;
  const mcpJsonPath = root ? resolve(base, ex.agent?.mcp_json_path || (tenantDir ? tp.mcpJsonPath : './.mcp.json')) : '';
  const browserOutDir = root ? resolve(base, 'data', 'browser-out') : '';
  // A tenant's harness children have a TMPDIR of their own (tenancy/child.ts), so /tmp is not one of its writable roots.
  const rootsOpts = tenantDir ? { tmpRoot: tp.tmp } : {};
  const isCodex = (v) => v.provider === 'codex';
  const isClaude = (v) => v.provider === 'claude';
  // DeepSeek Harness (dsh), the third harness (alpha; docs/DSH.md): its route's key lives in .env under api_key_env, else DEEPSEEK_API_KEY.
  const isDsh = (v) => v.provider === 'dsh';
  const HARNESS_NAME = { codex: 'Codex', claude: 'Claude', dsh: 'DeepSeek Harness' };
  const dshKeyVar = ex.agent?.dsh?.api_key_env || 'DEEPSEEK_API_KEY';

  // Short-lived memo for the reads that ratification needs (the folder is hashed); cleared at every step, so the
  // text shown for a step and the check made for it see the same code, and a later step sees the code as it is then.
  let memo = new Map();
  const memoized = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };

  const steps = [];
  // Which phase is walked. A tenant's wizard is never split (the operator's terminal sets one up in one go).
  const mode = tenantDir ? 'all' : ['one', 'more', 'all'].includes(env.phase) ? env.phase : 'all';
  const configured = !!env.hasConfigFile;
  const providerSet = () => !!ex.agent?.provider;
  // Phase-one questions already answered in the config (a yes/no with a runtime default counts once the file exists).
  const SET = {
    companionName: () => !!ex.identity?.companion_name, userName: () => !!ex.identity?.user_name, timezone: () => !!ex.identity?.timezone,
    home: () => !!ex.agent?.cwd && ex.agent.cwd !== '.',
    provider: providerSet, codexModel: providerSet, claudeModel: providerSet, dshModel: providerSet,
    // A key counts as answered only when one is saved: a DeepSeek Harness install without one cannot run, so phase one asks. (Claude may use its login, which the config cannot show, so its key question stays kept once a provider is set.)
    anthropicKey: providerSet, dshKey: () => providerSet() && !!envVal(dshKeyVar),
    appWrite: () => configured, orchestrator: () => configured, memory: () => configured, codexMemoriesOff: () => configured, codexMemoriesOn: () => configured,
    password: () => !!savedPassword,
  };
  const add = (s) => {
    const phase = PHASE_ONE.includes(s.id) ? 1 : 2;
    const skip = mode === 'all' ? '' : phase === 2 ? (mode === 'one' ? 'later' : '') : SET[s.id]?.() ? 'set' : '';
    steps.push({ default: '', ...s, phase, ...(skip ? { skip, ...(mode === 'more' ? { quiet: true } : {}) } : {}), ...(LEAVE.includes(s.id) ? { leave: true } : {}) });
  };

  // ── this tenant (the operator's terminal only: a tenant cannot change its own hosts from inside) ─────────
  if (tenantDir && env.operator) {
    const own = Array.isArray(ex.hosts) ? ex.hosts : typeof ex.hosts === 'string' ? [ex.hosts] : [];
    add({
      id: 'tenantHost', kind: 'text', section: 'This tenant', when: () => !env.household,
      otherwise: () => ['Hostname: none to ask. In household mode this companion is served at /c/' + env.tenantId + '/ on the house address.'], intro: () => ({ heading: `This tenant (${env.tenantId})`, lines: [`Its folder is ${tenantDir}; what it sets is written to tenant.yaml and .env there.`] }),
      question: 'Hostname this tenant is served at (empty = none yet)', default: own[0] || '', coerce: (raw) => raw.trim().toLowerCase(),
      // A host another tenant folder already claims is refused here (boot would take it from both); the same check runs again before anything is written.
      validate: (value) => hostProblem(value) || (value && tenantHostClaims(dirname(tenantDir), env.tenantId).has(value) ? `${value} is already claimed by tenant ${tenantHostClaims(dirname(tenantDir), env.tenantId).get(value)}: two tenants cannot share a host.` : ''),
      retry: true, outro: () => [''],
    });
  }
  // ── who ─────────────────────────────────────────────────────────────────────
  add({
    id: 'companionName', kind: 'text', section: 'Who lives here', intro: () => ({ heading: 'Who lives here' }),
    question: "Your companion's name", default: ex.identity?.companion_name || 'Echo',
  });
  add({ id: 'userName', kind: 'text', section: 'Who lives here', question: 'Your name', default: ex.identity?.user_name || '' });
  add({
    id: 'timezone', kind: 'text', section: 'Who lives here', question: 'Your timezone (IANA name)',
    default: ex.identity?.timezone || env.timezoneDefault || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    validate: (value) => {
      try { new Intl.DateTimeFormat('en', { timeZone: String(value) }); } catch { return 'That is not a timezone name the computer knows. Names look like Europe/Berlin or America/New_York.'; }
      // One process runs on one clock: a tenant on another timezone would be skipped at boot.
      if (tenantDir && env.processTimezone && String(value) !== env.processTimezone) return `The app runs on ${env.processTimezone}, and a tenant cannot use another timezone yet. Use ${env.processTimezone}.`;
      return '';
    },
    ...(tenantDir ? { retry: true } : {}),
    outro: () => [''],
  });

  // ── home folder ─────────────────────────────────────────────────────────────
  add({
    id: 'home', kind: 'text', section: "The companion's home folder",
    intro: () => ({ heading: "The companion's home folder", lines: ['The folder with AGENTS.md, identity/ and config/. Part one of the README makes it.'] }),
    question: 'Home folder',
    default: tenantDir ? (ex.agent?.cwd || tp.home) : ex.agent?.cwd && ex.agent.cwd !== '.' ? ex.agent.cwd : join(homeDir, 'Documents', 'companion-home'),
    coerce: (raw) => abs(raw),
    ...(tenantDir ? { validate: (value) => outside(abs(value)), retry: true } : {}),
  });
  add({
    id: 'homeCreate', kind: 'yesno', section: "The companion's home folder", default: true,
    when: (v) => !existsSync(join(v.home, 'identity', 'profile.md')) && !existsSync(v.home),
    question: (v) => `${v.home} does not exist. Create it from the starter template?`,
    after: (value, v) => (value ? [`Created ${v.home}. Open identity/profile.md and identity/companion.md there and fill in the << >> blanks.`, ''] : ['']),
    // (A run that keeps the home folder it already has says nothing in the place of the question.)
    otherwise: (v) => (existsSync(v.home) && !existsSync(join(v.home, 'identity', 'profile.md'))
      ? [`Note: ${v.home} has no identity/profile.md yet. The app runs, but your companion will have no identity until it does.`, ''] : mode !== 'all' && SET.home() ? [] : ['']),
  });

  // ── harness and models ──────────────────────────────────────────────────────
  add({
    id: 'provider', kind: 'choice', label: 'Provider', section: 'The model', intro: () => ({ heading: 'The model' }),
    question: 'Which one?', default: ex.agent?.provider === 'claude' ? 'claude' : ex.agent?.provider === 'dsh' ? 'dsh' : 'codex',
    options: [
      { value: 'codex', label: 'Codex', detail: 'Any model Codex can reach. DeepSeek on an API key, a ChatGPT plan, or any provider you add to ~/.codex/config.toml (OpenAI-compatible APIs, local servers).' },
      { value: 'claude', label: 'Claude', detail: 'The Claude Agent SDK, with a Claude login or an Anthropic API key.' },
      { value: 'dsh', label: 'DeepSeek Harness', detail: 'DeepSeek\'s own agent (alpha), on a DeepSeek API key or another route it knows.' },
    ],
    cli: [
      '1) Codex: any model Codex can reach. DeepSeek on an API key, a ChatGPT plan, or any',
      '   provider you add to ~/.codex/config.toml (OpenAI-compatible APIs, local servers).',
      '2) Claude: the Claude Agent SDK, with a Claude login or an Anthropic API key.',
      '3) DeepSeek Harness: DeepSeek\'s own agent (alpha), on a DeepSeek API key or another',
      '   route it knows (docs/DSH.md).',
    ],
    fallback: 'codex',
  });
  // Codex: the provider list. The addition itself is written by applySetup.
  const addedProvider = (v) => !!(v.addProvider && v.providerId && v.providerBaseUrl);
  add({
    id: 'addProvider', kind: 'yesno', section: 'The model', when: isCodex,
    question: 'Add a model provider to Codex (an API key or a local server)?', default: !cx.providers.length && !cx.model,
    help: () => {
      const installed = memoized('codex', () => (typeof env.codexInstalled === 'boolean' ? env.codexInstalled : !!(typeof env.isCodexInstalled === 'function' && env.isCodexInstalled())));
      const lines = [installed
        ? 'Codex is installed.'
        : 'Codex was not found on this computer. The README, Step 1, installs it; the app will not answer until it is there.'];
      if (cx.model || cx.modelProvider || cx.providers.length) {
        lines.push(`Codex's own default: ${cx.model || '(its built-in model)'}${cx.modelProvider ? ` via ${cx.modelProvider}` : ''}.`);
        if (cx.providers.length) lines.push(`Providers in ${tomlPath}: ${cx.providers.map((p) => `${p.key}${p.baseUrl ? ` (${p.baseUrl})` : ''}`).join(', ')}.`);
      } else {
        lines.push(`No model settings in ${tomlPath}: Codex uses its own default (a ChatGPT login, once you run \`codex login\`).`);
      }
      return [...lines, ...loginHelp('`codex login`')];
    },
  });
  add({
    id: 'providerId', kind: 'text', section: 'The model', when: (v) => isCodex(v) && v.addProvider === true,
    help: ['Any service that speaks the OpenAI Responses API works: DeepSeek, OpenAI, or a local server.'],
    question: 'Short name for it (letters, digits, dashes), e.g. deepseek', default: '',
    coerce: (raw) => raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
  });
  const providerAsked = (v) => isCodex(v) && v.addProvider === true && !!v.providerId;
  add({ id: 'providerName', kind: 'text', section: 'The model', when: providerAsked, question: 'Display name', default: (v) => presetOf(v.providerId).name || v.providerId });
  add({ id: 'providerBaseUrl', kind: 'text', section: 'The model', when: providerAsked, question: 'API base URL', default: (v) => presetOf(v.providerId).baseUrl || '' });
  add({ id: 'providerKey', kind: 'secret', section: 'The model', when: providerAsked, question: 'API key (empty = none; the service must accept requests without one)', default: '' });
  add({
    id: 'providerModel', kind: 'text', section: 'The model', when: providerAsked, question: 'Model id to use there', default: (v) => presetOf(v.providerId).model || '',
    after: (_value, v) => (v.providerBaseUrl ? [] : ['No base URL, so nothing was added.']),
  });
  add({
    id: 'providerDefault', kind: 'yesno', section: 'The model', when: (v) => providerAsked(v) && !!v.providerBaseUrl, default: true,
    question: (v) => `Make ${v.providerId}${v.providerModel ? ` with ${v.providerModel}` : ''} Codex's default, for the Terminal too?`,
    after: (_value, v) => [`Added [model_providers.${v.providerId}] to ${tomlPath}.${v.providerKey ? ' The key is stored there in plain text; never paste that file anywhere public.' : ''}`],
  });
  add({
    id: 'codexModel', kind: 'text', section: 'The model', when: isCodex, help: mode === 'all' ? ["Leave the next four empty to use Codex's default everywhere."] : ["Leave it empty to use Codex's default."],
    question: 'Chat model id', default: (v) => (addedProvider(v) ? (v.providerModel || ex.agent?.codex?.model || '') : (ex.agent?.codex?.model || '')),
  });
  add({
    id: 'codexProvider', kind: 'text', section: 'The model', when: isCodex,
    question: 'Chat provider name', default: (v) => (addedProvider(v) ? v.providerId : (ex.agent?.codex?.model_provider || '')),
  });
  // Claude
  add({ id: 'claudeModel', kind: 'text', section: 'The model', when: isClaude, question: 'Claude model id', default: ex.agent?.model || 'claude-sonnet-5-5' });
  add({
    id: 'anthropicKey', kind: 'secret', section: 'The model', when: isClaude, help: ['Sign in with `claude login` (a Claude plan), or paste an Anthropic API key here.', ...loginHelp('`claude login`')],
    question: 'Anthropic API key (empty = use the login)', default: envVal('ANTHROPIC_API_KEY'), display: envShown('ANTHROPIC_API_KEY'), outro: () => [''],
    validate: (value) => (value ? envProblem(value) : ''),
  });
  // DeepSeek Harness: the model on its route, and the route's key (kept in .env, never in sanctum.yaml). The route itself is changed in Settings.
  add({
    id: 'dshModel', kind: 'text', section: 'The model', when: isDsh,
    help: [
      'DeepSeek Harness is new (alpha). Install it once, pinned: npm i -g @deepseek-ai/dsh@0.2.1-alpha.2',
      ...(ex.agent?.dsh?.model_provider ? [`It runs on the "${ex.agent.dsh.model_provider}" route; Settings > Preferences > Model changes the route.`] : []),
    ],
    question: 'DeepSeek Harness model id (empty = its own default)', default: ex.agent?.dsh?.model || '',
  });
  add({
    id: 'dshKey', kind: 'secret', section: 'The model', when: isDsh,
    question: `${dshKeyVar === 'DEEPSEEK_API_KEY' ? 'DeepSeek API key' : `API key (${dshKeyVar})`} (empty = keep the saved one, or dsh's own credentials)`,
    default: envVal(dshKeyVar), display: envShown(dshKeyVar), // (the blank line after the model section is the Claude key step's outro, said whichever harness)
    validate: (value) => (value ? envProblem(value) : ''),
  });

  // ── permissions (Codex) ─────────────────────────────────────────────────────
  const sbDefault = SANDBOXES.includes(ex.agent?.codex?.sandbox_mode) ? ex.agent.codex.sandbox_mode : 'workspace-write';
  add({
    id: 'sandbox', kind: 'choice', section: 'What they may touch', when: isCodex,
    intro: (v) => (isCodex(v) ? { heading: 'What they may touch' } : null),
    question: 'Which one?', default: sbDefault, fallback: 'workspace-write',
    options: [
      { value: 'read-only', label: 'Read only', detail: 'Can read the home folder, writes nothing.' },
      { value: 'workspace-write', label: 'The home folder', detail: 'Writes inside it (journal, HANDOFF.md), plus any extra folders you name.' },
      { value: 'danger-full-access', label: 'Full access', detail: 'Writes anywhere on this computer. Nothing stops a bad edit.' },
    ],
    cli: ['1) Read only: can read the home folder, writes nothing.', '2) The home folder: writes inside it (journal, HANDOFF.md), plus any extra folders you name.', '3) Full access: writes anywhere on this computer. Nothing stops a bad edit.'],
    after: (value) => (value === 'danger-full-access' ? ['Full access it is. The app will not second-guess a write anywhere.'] : []),
  });
  add({
    id: 'extraDirs', kind: 'text', section: 'What they may touch', when: isCodex,
    question: 'Extra folders they may write to (comma-separated, full paths; empty = none)',
    default: Array.isArray(ex.agent?.codex?.additional_directories) ? ex.agent.codex.additional_directories.join(', ') : '',
    coerce: (raw) => raw.split(',').map((x) => x.trim()).filter(Boolean).map(abs),
    ...(tenantDir ? { validate: (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map((x) => x.trim()).filter(Boolean) : []).map((x) => outside(abs(x))).find(Boolean) || '', retry: true } : {}),
    after: () => ['All of this can be changed later in the app under Settings → permissions.'],
    outro: (v) => (isCodex(v) ? [''] : []),
  });

  // ── the app's features ──────────────────────────────────────────────────────
  add({
    id: 'appWrite', kind: 'yesno', section: "The app's features", intro: () => ({ heading: "The app's features" }),
    help: [
      'Reminders and timers, a meal and care log, cycle tracking, notes and canvases, routines,',
      'and the presence orb all live in the app. With this on, your companion can write to them',
      'when you ask: "ate at 10:30" gets logged, "remind me at 3" sets a timer, "log my meds"',
      'ticks the box. Nothing is written without your say-so, and the app sets up all of the',
      'access itself; there is nothing to configure outside it. Off, they can read and talk, but',
      'every write is refused.',
    ],
    question: "Let your companion write to the app's features?", default: ex.agent?.app_write !== false,
    after: (value) => (value ? ['On. The Command Center pages (care, cycle, routines) are switched on with it.'] : []),
    outro: () => [''],
  });
  add({
    id: 'orchestrator', kind: 'yesno', section: "The app's features",
    help: [
      'The orchestrator is the clock behind your companion: timers and reminders, scheduled check-ins, and the',
      'gentle "you have gone quiet" nudges. Off, none of those fire (the background helpers keep running).',
    ],
    question: 'Let your companion keep time (timers, reminders, check-ins)?', default: ex.orchestrator?.enabled !== false,
    after: (value) => (value ? [] : ['Off. Nothing is scheduled until you turn it back on (orchestrator.enabled in sanctum.yaml, or Settings).']),
    outro: () => [''],
  });

  // ── long-conversation memory (rolling context) ──────────────────────────────
  const roll = rollingDefaults(ex, !!env.hasConfigFile, !!env.hasDatabase);
  const exr = ex.agent?.rolling || ex.agent?.codex?.rolling || {};
  add({
    id: 'rolling', kind: 'yesno', section: 'Long-conversation memory', intro: () => ({ heading: 'Long-conversation memory (recommended: on)' }),
    help: (v) => {
      const def = roll.upgrade || roll.saved[v.provider] ? roll.effective[v.provider] : true;
      const lines = [
        'Models can only hold so much of a conversation at once. Without this, the oldest',
        'messages quietly fall off the end and your companion loses the thread. With it on,',
        'Sanctum folds older messages into a short summary your companion keeps reading, so',
        "the shape of what happened stays even when the words don't. You can turn it off any",
        'time; the summaries are kept, not deleted, and the next message in each thread carries',
        'them into a fresh session once, so your companion keeps the thread.',
      ];
      if (roll.upgrade) {
        lines.push(`You already have conversations here. Keeping the answer below as it is (${def ? 'on' : 'off'})`);
        lines.push('leaves them exactly as they are today. Changing it applies from now forward.');
      }
      return lines;
    },
    question: (v) => `Long-conversation memory on ${HARNESS_NAME[v.provider] || 'Claude'}?`,
    default: (v) => (roll.upgrade || roll.saved[v.provider] ? roll.effective[v.provider] : true),
    outro: () => [''],
  });

  // ── plugins ─────────────────────────────────────────────────────────────────
  add({
    id: 'pluginsTrust', kind: 'choice', section: 'Plugins', intro: () => ({ heading: 'Plugins' }),
    help: ['Who manages plugins?'],
    question: 'Which one?', default: ex.plugins?.trust === 'person' ? 'person' : 'companion',
    options: [
      { value: 'companion', label: 'Your companion', detail: 'It can turn plugins on and off and edit them, and you see what changed in Settings.' },
      { value: 'person', label: 'You', detail: 'Nothing runs until you have read and ratified its exact code, and a change stops it until you ratify again.' },
    ],
    cli: ['1) your companion: it can turn plugins on and off and edit them, and you see what changed in Settings.', '2) you: nothing runs until you have read and ratified its exact code, and a change stops it until you ratify again.'],
    parse: (raw) => parsePluginTrust(raw, ex.plugins?.trust),
    after: (value) => [value === 'companion' ? 'Your companion manages plugins. Settings > Plugins shows what changed since you last looked.' : 'You manage plugins. Each one is shown to you before it is turned on.'],
  });
  add({
    id: 'plugins', kind: 'multichoice', section: 'Plugins', when: () => shipped.length > 0,
    help: ['Plugins add tools and routes. A plugin on disk does nothing until it is named here, and', 'the default is none. These ship with the app:'],
    cli: shipped.map((p, i) => `${i + 1}) ${p.name} (${p.id})${onPlugins.has(p.id) ? '  [on]' : ''}`),
    question: 'Which to turn on? Numbers or ids, comma-separated, "none" for none',
    options: shipped.map((p) => ({ value: p.id, label: p.name, on: onPlugins.has(p.id) })),
    default: shipped.filter((p) => onPlugins.has(p.id)).map((p) => p.id),
    after: (value, v) => [value.length
      ? (v.pluginsTrust === 'person' ? `Chosen: ${value.join(', ')}. You will be shown each one's code before it is turned on.` : `Turned on: ${value.join(', ')}.`)
      : 'None turned on.'],
    outro: () => [''],
  });

  // ── optional: pictures and summaries ────────────────────────────────────────
  // Two blocks that shipped after the first wizard: image generation (imagegen.*) and the companion-voiced summarizer (agent.summarizer.*).
  // Asked only while the block is absent or off (provider none / empty), so re-running setup on a configured install says nothing about them.
  // Five prompts at most: provider, key, who writes summaries, endpoint + model, key. UPGRADE.md ("Pictures and companion-voiced summaries") has the same text.
  const imageOff = !['runware', 'replicate'].includes(ex.imagegen?.provider);
  const imageChosen = (v) => imageOff && (v.imageProvider === 'runware' || v.imageProvider === 'replicate');
  const IMAGE_KEY = { runware: 'RUNWARE_API_KEY', replicate: 'REPLICATE_API_TOKEN' };
  const summaryOff = !ex.agent?.summarizer?.provider;
  // A deprecated agent.rolling.model still names the summarizer when agent.summarizer is not set; the wizard no longer asks for it (summaryWho is the one summarizer prompt).
  const legacyModel = typeof exr.model === 'string' ? exr.model.trim() : '';
  const summaryOwn = (v) => summaryOff && v.summaryWho === 'other';
  const summaryKeyVar = ex.agent?.summarizer?.api_key_env || 'SUMMARIZER_API_KEY';
  add({
    id: 'imageProvider', kind: 'choice', section: 'Optional: pictures and summaries', when: () => imageOff,
    intro: () => (imageOff || summaryOff ? { heading: 'Optional: pictures and summaries' } : null),
    help: [
      'Your companion can make pictures (FLUX, through Runware or Replicate) and post them in the chat. It is off',
      'until you pick a provider and give its key. Skip it now and add it later: UPGRADE.md, "Pictures and',
      'companion-voiced summaries".',
    ],
    question: 'Make pictures with', default: 'none',
    options: [
      { value: 'none', label: 'Nothing', detail: 'No pictures (you can turn this on later).' },
      { value: 'runware', label: 'Runware', detail: 'Key in .env as RUNWARE_API_KEY.' },
      { value: 'replicate', label: 'Replicate', detail: 'Key in .env as REPLICATE_API_TOKEN.' },
    ],
    cli: ['1) nothing', '2) Runware (RUNWARE_API_KEY)', '3) Replicate (REPLICATE_API_TOKEN)'],
    after: (value) => (value === 'none' || !value ? [] : [`Pictures: ${value}. The key goes in .env; pictures stay off until it is there.`]),
  });
  add({
    id: 'imageKey', kind: 'secret', section: 'Optional: pictures and summaries', when: imageChosen,
    question: (v) => `${v.imageProvider === 'runware' ? 'Runware API key' : 'Replicate API token'} (${IMAGE_KEY[v.imageProvider]}; empty = add it to .env yourself)`,
    default: (v) => envVal(IMAGE_KEY[v.imageProvider] || ''),
    validate: (value) => (value ? envProblem(value) : ''),
  });
  add({
    id: 'summaryWho', kind: 'choice', section: 'Optional: pictures and summaries', when: () => summaryOff,
    help: [
      "The summaries your companion keeps of long conversations are its own memory of itself, written in its own voice.",
      'A capable mid-tier model or better keeps that voice; a small or fast one flattens it.',
    ],
    question: "Write your companion's own summaries with", default: 'chat',
    options: [
      { value: 'chat', label: 'The chat model (default)' },
      { value: 'other', label: 'Another model through an OpenAI-compatible endpoint', detail: 'For example OpenRouter. The key goes in .env as SUMMARIZER_API_KEY.' },
    ],
    cli: ['1) the chat model (default)', '2) another model through an OpenAI-compatible endpoint'],
    after: (value) => (value === 'other' ? [] : [legacyModel ? `${legacyModel} writes them (agent.rolling.model, deprecated; move it to agent.summarizer.model).` : 'The chat model writes them.']),
  });
  add({
    id: 'summaryEndpoint', kind: 'text', section: 'Optional: pictures and summaries', when: summaryOwn,
    question: 'Endpoint and model, as: <base URL> <model id>   (e.g. https://openrouter.ai/api/v1 and the id from the provider\'s model list)', default: '',
    coerce: (raw) => raw.trim().replace(/\s+/g, ' '),
    validate: (value) => (/^https?:\/\/\S+ \S+$/.test(String(value).trim().replace(/\s+/g, ' ')) ? '' : 'Write the base URL (https://...), a space, then the model id.'),
    retry: true,
  });
  add({
    id: 'summaryKey', kind: 'secret', section: 'Optional: pictures and summaries', when: summaryOwn,
    question: `API key for that endpoint (${summaryKeyVar}; empty = add it to .env yourself)`, default: envVal(summaryKeyVar),
    validate: (value) => (value ? envProblem(value) : ''),
    outro: () => [''],
  });

  // ── Discord (docs/DISCORD-PLAN.md) ──────────────────────────────────────────
  const discordOn = (v) => discordOnAlready || v.discordEnable === true;
  const discordRoots = (v) => [v.home, ...(v.extraDirs || []), ex.agent?.dsh?.home, ex.hooks?.workspace_root, ex.hooks?.vault_path, ...(ex.hooks?.extra_write_paths || [])]
    .filter(Boolean).map((p) => abs(p));
  add({
    id: 'discordEnable', kind: 'yesno', section: 'Discord', when: () => !discordOnAlready,
    intro: () => ({
      heading: 'Discord',
      lines: [
        'Two lanes that never touch, decided by CHANNEL: your own channel (the owner lane: only your',
        'account, only that channel), and, later and only if you',
        'choose, public servers. Everything she says on Discord passes a word gate first, against',
        'private lists you write. This step makes those lists. The public lane stays OFF, and bots',
        'never get answered; both are changed later in sanctum.yaml, one stage at a time.',
        'Note: public Discord needs dsh or Claude as the harness. On Codex the public lane is refused (it cannot',
        'run without its shell tool); the owner lane works on any harness.',
      ],
    }),
    question: 'Set up Discord?', default: false,
    otherwise: () => (discordOnAlready ? ['Discord is already on (in sanctum.yaml, or by the Settings toggle). The word gate needs its private lists, so they are made now.'] : []),
  });
  const idStep = (id, question, dflt, help) => ({
    id, kind: 'text', section: 'Discord', when: discordOn, ...(help ? { help } : {}), question, default: dflt,
    validate: (value) => (value && !DISCORD_ID.test(value) ? 'That does not look like a Discord id (digits only).' : ''),
    coerce: (raw) => (raw && !DISCORD_ID.test(raw)
      ? { value: '', say: ['That does not look like a Discord id (digits only), so it was left empty. Set it in sanctum.yaml.'] }
      : raw),
  });
  add(idStep('discordOwnerUserId', 'Your Discord user id (the one account she answers)', d.owner?.user_id || d.owner_user_id || '',
    ['Turn on Developer Mode in Discord (Settings > Advanced), then right-click to Copy ID.']));
  add(idStep('discordOwnerChannelId', 'Your owner channel id (the one channel, in a server only you are in)', d.owner?.channel_id || ''));
  add({
    id: 'discordPrivateDir', kind: 'text', section: 'Discord', when: discordOn,
    help: ['The private folder holds words.txt, names.txt and exclusions.txt. It must sit OUTSIDE everything', 'she can write, so she can never read or edit the gate that guards her.'],
    question: 'Private folder', default: (v) => d.private_dir || (tenantDir ? tp.privateDir : defaultPrivateDir(v.home)),
    validate: (value, v) => outside(abs(value)) || privateDirProblem(abs(value), discordRoots(v)),
    coerce: (raw, v) => {
      const lines = [];
      let dir = abs(raw);
      const roots = discordRoots(v);
      let problem = outside(dir) || privateDirProblem(dir, roots);
      let abandoned = false;
      if (problem) {
        lines.push(problem);
        dir = tenantDir ? tp.privateDir : defaultPrivateDir(v.home);
        problem = privateDirProblem(dir, roots);
        if (problem) { lines.push(`${problem}\nDiscord was not set up. Pick a home folder whose parent folder is not one she can write, then run this again.`); abandoned = true; }
        else lines.push(`Using ${dir} instead.`);
      }
      return { value: dir, say: lines, set: { discordAbandoned: abandoned } };
    },
    after: (_value, v) => (v.discordAbandoned ? [] : [
      'In the Discord developer portal: turn Public Bot OFF, and toggle the MessageContent intent ON',
      '(it is privileged). Give the bot access to your owner channel only. The token goes in .env as',
      'DISCORD_BOT_TOKEN, or in Settings.',
    ]),
    outro: () => [''],
  });

  // ── the app: password ───────────────────────────────────────────────────────
  const savedPassword = envVal('APP_PASSWORD') || env.savedPassword || '';
  add({
    id: 'password', kind: 'secret', section: 'The app', intro: () => ({ heading: 'The app' }),
    // Household mode (a companion's own wizard): no password to ask. The house has one login, set once for every companion.
    when: () => !env.household,
    otherwise: () => ['Password: none to ask. The house has one login (household mode), set once for every companion.'],
    question: 'App password (empty = make one up for you)', appQuestion: 'App password', default: envVal('APP_PASSWORD') || env.savedPassword || '', display: envShown('APP_PASSWORD'), generate: generatePassword,
    // The app (never the terminal) checks it: it cannot make one up, since it would have to send it back.
    validate: (value) => {
      if (!value) return savedPassword ? '' : 'Choose a password. It is what you sign in with.';
      if (value === savedPassword) return '';
      return value.length < 8 ? 'Use at least 8 characters.' : envProblem(value);
    },
    after: (value, _v, meta) => (meta?.generated ? [`Your password is: ${value}   (write it down; it is also in .env)`] : []),
    outro: () => [''],
  });

  // ── memory ──────────────────────────────────────────────────────────────────
  add({
    id: 'memory', kind: 'choice', label: 'Memory', section: 'Memory', intro: () => ({ heading: 'Memory' }),
    help: ['One memory system at a time, or they fight over what to remember. Pick where memory lives:',
      ...(tenantDir ? ['A tenant needs its own Revien daemon and address: the process\'s daemon is never shared, so Revien is not the default here.'] : [])],
    // DeepSeek Harness has no built-in memory (only Claude's auto-memory and Codex "memories" read agent.harness_memory), so it is not offered there.
    cli: (v) => [
      'Revien (the README, Step 4): a local graph the companion searches and writes to.',
      'My own memory system: an MCP server or files I set up myself.',
      ...(isDsh(v) ? [] : [`The harness's built-in memory: ${v.provider === 'codex' ? 'Codex "memories"' : "Claude's auto-memory"}.`]),
      'None. The journal and HANDOFF.md in the home folder are all that lasts.',
      "Sanctum's own memory: built in, nothing to install. It recalls the closest lines from earlier conversations on this\n   computer, and stands in for Revien whenever Revien is not running.",
    ].map((line, i) => `${i + 1}) ${line}`),
    question: 'Which one?',
    // (A tenant's Revien is off until its own tenant.yaml turns it on: the one daemon has no tenant scope, so nothing is shared by default.)
    default: (v) => ex.agent?.local_recall === true && ex.revien?.enabled === false ? 'sanctum' : ex.agent?.harness_memory && !isDsh(v) ? 'harness' : tenantDir ? (ex.revien?.enabled === true ? 'revien' : 'none') : ex.revien?.enabled === false ? 'none' : 'revien', fallback: tenantDir ? 'none' : 'revien',
    options: (v) => [
      { value: 'revien', label: 'Revien', detail: "A local graph the companion searches and writes to (the README, Step 4). Until it is running, Sanctum's own memory stands in." },
      { value: 'own', label: 'My own memory system', detail: 'An MCP server or files I set up myself.' },
      ...(isDsh(v) ? [] : [{ value: 'harness', label: 'The harness\'s built-in memory', detail: v.provider === 'codex' ? 'Codex "memories".' : "Claude's auto-memory." }]),
      { value: 'none', label: 'None', detail: 'The journal and HANDOFF.md in the home folder are all that lasts.' },
      { value: 'sanctum', label: "Sanctum's own memory", detail: 'Built in, nothing to install: it recalls the closest lines from earlier conversations on this computer.' },
    ],
    after: (value) => (value === 'own'
      ? ["Add your server to .mcp.json in this folder and name it in AGENTS.md, in the home folder. The harness's own memory stays off."]
      : value === 'harness' ? ['The app turns the harness memory on for every turn. Revien stays off.'] : []),
  });
  if (tenantDir) {
    add({
      id: 'revienUrl', kind: 'text', section: 'Memory', when: (v) => v.memory === 'revien',
      question: 'Address of this tenant\'s own Revien daemon (http://host:port)', default: ex.revien?.url || '', coerce: (raw) => raw.trim(),
      validate: (value) => (!/^https?:\/\/[^\s/]+/i.test(String(value || '')) ? 'Give the address of a Revien daemon that only this tenant uses, like http://127.0.0.1:7438. Two tenants on one daemon would share memories.'
        : env.processRevienUrl && normaliseRevienAddress(value) === normaliseRevienAddress(env.processRevienUrl) ? 'That is the address of the app\'s own Revien daemon (localhost and 127.0.0.1 are the same place). A tenant needs a daemon of its own, on its own address.' : ''),
      retry: true,
    });
  }
  add({
    id: 'codexMemoriesOff', kind: 'yesno', section: 'Memory', when: (v) => isCodex(v) && v.memory !== 'harness' && memoriesOn, default: true,
    question: `${tomlPath} has Codex memories switched on, which would also run in the Terminal. Switch it off there too?`,
  });
  add({
    id: 'codexMemoriesOn', kind: 'yesno', section: 'Memory', when: (v) => isCodex(v) && v.memory === 'harness' && !memoriesOn, default: true,
    question: `Switch Codex memories on in ${tomlPath} as well, so the Terminal remembers too?`,
  });

  // ── browser tools ───────────────────────────────────────────────────────────
  // With the neko seat running, one .mcp.json entry gives the companion browser tools in the same browser the person
  // watches in the Browser tab. Merged, never overwritten.
  const merged = () => memoized('merge', () => mergeBrowserMcp(env.mcpJsonText || '', resolve(root, 'examples', 'browser-seat-neko', 'mcp-filter.mjs'), browserOutDir));
  // (A tenant has browser tools only from a seat its own config names: integrations.browser_url is never inherited, and the process's seat is never offered.)
  const browserOn = (v) => browserUrl || (!tenantDir && v.browserSeat === true);
  const browserPre = () => {
    const m = merged();
    if (m.action === 'exists') return [`${mcpJsonPath} already has a filtered "browser" entry; left as it is.`];
    if (m.action === 'refused') return [`${mcpJsonPath} was not changed: ${m.reason}. Fix it, or add the entry from examples/browser-seat-neko/mcp.example.json by hand.`];
    if (m.action === 'upgrade') {
      return [
        m.reason === 'unfiltered'
          ? `Warning: your "browser" entry in ${mcpJsonPath} has no filter; the companion can run arbitrary code (browser_run_code_unsafe runs in the Playwright server process, outside the sandbox).`
          : `Warning: your "browser" entry in ${mcpJsonPath} calls the filter the old way; the filter now refuses to start without --workdir, so the companion would have no browser tools.`,
        `The replacement runs Playwright MCP behind the filter (no browser_evaluate or browser_run_code_unsafe), with page-registered WebMCP tools off and the server's files kept in ${browserOutDir}.`,
      ];
    }
    return [
      'The companion can drive the seat\'s browser (navigate, click, type, snapshot, screenshot) through one .mcp.json entry, behind a filter that removes browser_evaluate and browser_run_code_unsafe (they run code outside the sandbox).',
      'Warning: it then controls every account logged in inside that browser. AGENTS.md tells it to ask before anything that sends, posts or buys.',
    ];
  };
  const browserTail = () => (browserUrl ? [] : ['The Browser tab itself needs integrations.browser_url: set it in Settings or sanctum.yaml (the seat README says which address). Without it there is no viewer tab, so you cannot watch or take over.']);
  add({
    id: 'browserSeat', kind: 'yesno', section: 'Browser', when: () => !browserUrl && !tenantDir,
    question: 'Is the browser seat running (examples/browser-seat-neko)?', default: false,
  });
  add({
    id: 'browserEntry', kind: 'yesno', section: 'Browser', default: true,
    when: (v) => browserOn(v) && ['upgrade', 'added'].includes(merged().action),
    help: () => browserPre(),
    question: () => (merged().action === 'upgrade' ? `Replace the "browser" entry in ${mcpJsonPath}? The file is backed up first.` : `Add the "browser" entry to ${mcpJsonPath}?`),
    after: () => browserTail(),
    otherwise: (v) => (browserOn(v) ? [...browserPre(), ...browserTail()] : tenantDir ? ['Browser: a tenant has browser tools only from a seat of its own. Set integrations.browser_url in this tenant\'s tenant.yaml to use one; the process\'s seat is never shared.'] : []),
  });

  // ── the phone ───────────────────────────────────────────────────────────────
  const existingOrigin = Array.isArray(ex.cors?.origins) ? ex.cors.origins.find((o) => /ts\.net/.test(String(o))) || ex.cors.origins[0] : '';
  // (A tenant has no say in where the process listens: cors is the process's.)
  if (!tenantDir) add({
    id: 'phoneOrigin', kind: 'text', section: 'The phone', question: 'Phone address, if you set up Tailscale (https://... .ts.net), else empty', default: existingOrigin || '',
    coerce: (raw) => raw.trim(),
    validate: (value) => (value && !/^https?:\/\/[^\s/]+/i.test(String(value)) ? 'A phone address starts with https:// (for example https://my-computer.tail1234.ts.net).' : ''),
    outro: () => [''],
  });

  // ── plugins: ratify BEFORE anything is written (only when you manage them) ──
  // plugins.enabled ends up holding only ids that are ratified NOW. A step per picked plugin, in the order picked.
  const person = (v) => v.pluginsTrust === 'person' && Array.isArray(v.plugins) && v.plugins.length > 0;
  const baseCfg = (v) => applyAnswers(ex, buildAnswers(v, steps, { skipLedger: true }));
  const ledgerOf = (v) => memoized(`ledger:${v.ledgerDir ?? ''}`, () => resolveLedger(base, baseCfg(v), v.ledgerDir, rootsOpts));
  const clashLines = (cfg, clash) => ledgerClashLines(base, cfg, clash);
  const leftOut = leftOutLine;
  add({
    id: 'ledgerDir', kind: 'text', section: 'Plugins: ratifying the code', retry: true,
    intro: (v) => (person(v) ? {
      heading: 'Plugins: ratifying the code',
      lines: ["Plugins run with the app's own access. Ratifying records the exact code you were shown; if it", 'changes later, the plugin stops until you ratify it again.'],
    } : null),
    when: (v) => person(v) && !!ledgerClash(base, baseCfg(v), rootsOpts),
    help: (v) => clashLines(baseCfg(v), ledgerClash(base, baseCfg(v), rootsOpts)),
    question: 'Folder for the ratification ledger (outside every folder the companion can write; empty = leave plugins off)', default: '',
    coerce: (raw) => raw.trim(),
    validate: (value, v) => {
      if (!value) return '';
      const chosen = ledgerChoicePath(base, value);
      if (outside(chosen)) return outside(chosen);
      const cfg = baseCfg(v);
      const withLedger = { ...cfg, plugins: { ...(cfg.plugins || {}), ledger_dir: chosen } };
      const clash = ledgerClash(base, withLedger, rootsOpts);
      return clash ? clashLines(withLedger, clash).join('\n') : '';
    },
  });
  const slotPlan = (v, i) => {
    const id = person(v) ? v.plugins[i] : undefined;
    if (!id) return null;
    const led = ledgerOf(v);
    if (!led.ok) return { id, state: 'unresolved' };
    const plan = memoized(`plan:${id}:${led.ledgerDir}`, () => planPluginRatification(root, id, led.ledgerDir, led.scan));
    return { id, state: plan.kind, plan };
  };
  for (let i = 0; i < shipped.length; i++) {
    add({
      id: `ratify_${i}`, kind: 'yesno', section: 'Plugins: ratifying the code', style: 'bracket', default: false,
      when: (v) => { const s = slotPlan(v, i); return !!s && (s.state === 'new' || s.state === 'changed'); },
      help: (v) => {
        const { id, plan } = slotPlan(v, i);
        return plan.kind === 'new'
          ? [`${id}: the code you are about to ratify (${plan.files.length} files):`, ...plan.files.map((f) => `  ${f}`), `digest ${plan.digest}`]
          : [`${id}: the code CHANGED since you ratified it. Changed files:`, ...formatChanges(plan.changes, 10), `digest ${plan.digest}`];
      },
      question: (v) => (slotPlan(v, i).plan.kind === 'new' ? 'Ratify this code?' : 'Ratify this changed code?'),
      meta: (v) => { const s = slotPlan(v, i); return { pluginId: s.id, digest: s.plan.digest, files: s.plan.files, changes: s.plan.changes, kind: s.plan.kind }; },
      after: (value, v) => (value ? [] : [leftOut(slotPlan(v, i).id)]),
      otherwise: (v) => {
        const s = slotPlan(v, i);
        if (!s) return [];
        if (s.state === 'unresolved') return [leftOut(s.id)];
        if (s.state === 'error') return [`${s.id}: cannot be ratified: ${s.plan.reason}`, leftOut(s.id)];
        return [];
      },
    });
  }

  Object.defineProperties(steps, {
    env: { value: env },
    existing: { value: ex },
    shipped: { value: shipped },
    reset: { value: () => { memo = new Map(); } },
    mode: { value: mode },
  });
  return steps;
}

// ── walking a plan ────────────────────────────────────────────────────────────

/** Is this step asked, given the answers so far? */
export const isActive = (step, v) => (!step.skip && (step.when ? !!step.when(v) : true));

/**
 * A step this run does not ask ('later' = phase two on a phase-one run, 'set' = answered already) still has a value, the one Enter would
 * have taken, unless it is a `leave` step or would not be asked anyway. { value, set, line } or null. `line` says what was kept.
 */
export function skipFill(step, v) {
  if (!step.skip || step.leave || (step.when && !step.when(v))) return null;
  const r = evalStep(step, v);
  const s = settle(step, r.kind === 'secret' ? '' : r.default, v);
  let line = '';
  if (step.skip === 'set' && !step.quiet) {
    const q = String(step.label || r.question).replace(/\s*\(.*\)\s*$/, '').replace(/\?$/, '');
    const shown = r.kind === 'secret' ? (r.default ? '(saved)' : '(none)')
      : r.kind === 'yesno' ? (s.value ? 'yes' : 'no')
        : r.kind === 'choice' ? ((r.options || []).find((o) => o.value === s.value)?.label ?? s.value)
          : String(s.value ?? '');
    line = `Kept: ${q} = ${shown || '(empty)'}`;
  }
  return { value: s.value, set: s.set, line };
}

/** The step with its dynamic parts worked out for the answers so far. */
export function evalStep(step, v) {
  const options = step.options === undefined ? undefined : val(step.options, v);
  return {
    id: step.id, kind: step.kind, section: step.section, style: step.style, retry: !!step.retry,
    question: val(step.question, v),
    ...(step.appQuestion !== undefined ? { appQuestion: val(step.appQuestion, v) } : {}),
    help: val(step.help, v) || [],
    cli: val(step.cli, v) || [],
    default: val(step.default, v),
    ...(options ? { options } : {}),
    ...(step.meta ? { meta: step.meta(v) } : {}),
  };
}

/** What the terminal shows as the default in brackets, and the answer taken when Enter is pressed. */
export function defaultText(r) {
  if (r.kind === 'yesno') return '';
  if (r.kind === 'choice') {
    const i = (r.options || []).findIndex((o) => o.value === r.default);
    return String(i >= 0 ? i + 1 : 1);
  }
  if (r.kind === 'multichoice') return (r.default || []).join(', ') || 'none';
  return String(r.default ?? '');
}

/** An answer typed in the terminal, as the value of the step. `text` is trimmed and may be empty (= the default). */
export function parseAnswer(step, r, text, v) {
  if (r.kind === 'yesno') {
    const a = text.toLowerCase();
    return a ? a.startsWith('y') : !!r.default;
  }
  const raw = text || defaultText(r);
  if (r.kind === 'choice') {
    if (step.parse) return step.parse(raw, v);
    const byNum = /^\d+$/.test(raw) ? r.options[Number(raw) - 1] : undefined;
    return byNum ? byNum.value : step.fallback ?? r.default;
  }
  if (r.kind === 'multichoice') return parsePluginSelection(raw, r.options.map((o) => ({ id: o.value })));
  return raw;
}

/** What an answer becomes: { value, lines, set }. `lines` are what the terminal says about it; `set` extra answers to keep. */
export function settle(step, raw, v) {
  if (!step.coerce) return { value: raw, lines: [], set: undefined };
  const r = step.coerce(raw, v);
  if (r && typeof r === 'object' && !Array.isArray(r) && 'value' in r) return { value: r.value, lines: r.say || [], set: r.set };
  return { value: r, lines: [], set: undefined };
}

// ── answers, in the shape applyAnswers and applySetup take ────────────────────

// The optional group is asked only while the block is absent or off: the same test the steps use, from the config the plan was built on.
const imageChosenOf = (v, plan) => !['runware', 'replicate'].includes(plan.existing?.imagegen?.provider) && (v.imageProvider === 'runware' || v.imageProvider === 'replicate');
const summaryOwnOf = (v, plan) => !plan.existing?.agent?.summarizer?.provider && v.summaryWho === 'other';

/** The plan's answers by step id, as the flat object the apply helpers read. Safe on a partial set of answers. */
export function buildAnswers(v, plan, opts = {}) {
  const shipped = plan.shipped || [];
  const a = { companionName: v.companionName, userName: v.userName, timezone: v.timezone, home: v.home, provider: v.provider };
  if (v.provider === 'codex') {
    a.codexModel = v.codexModel;
    a.codexProvider = v.codexProvider;
    a.sandbox = v.sandbox;
    a.extraDirs = v.extraDirs;
    if (v.addProvider === true && v.providerId) {
      a.addProvider = { id: v.providerId, name: v.providerName, baseUrl: v.providerBaseUrl, key: v.providerKey, model: v.providerModel, makeDefault: v.providerDefault === true };
    }
  } else if (v.provider === 'dsh') {
    a.dshModel = v.dshModel;
    a.dshKey = v.dshKey;
  } else {
    a.claudeModel = v.claudeModel;
    a.anthropicKey = v.anthropicKey;
  }
  a.appWrite = v.appWrite;
  a.orchestrator = v.orchestrator;
  a.rolling = v.rolling;
  if (imageChosenOf(v, plan)) { a.imageProvider = v.imageProvider; if (v.imageKey) a.imageKey = v.imageKey; }
  if (summaryOwnOf(v, plan) && /^https?:\/\/\S+ \S+$/.test(String(v.summaryEndpoint || ''))) {
    const [baseUrl, model] = v.summaryEndpoint.split(' ');
    a.summaryOwn = { baseUrl, model, ...(v.summaryKey ? { key: v.summaryKey } : {}) };
  }
  // (Plugins are left alone by a run that did not ask: no trust answer, nothing to write.)
  if (v.pluginsTrust !== undefined) a.pluginsTrust = v.pluginsTrust;
  if (shipped.length && v.pluginsTrust !== undefined) {
    if (v.pluginsTrust === 'person') a.pluginsToRatify = v.plugins || [];
    else a.pluginsPicked = v.plugins || [];
  }
  const discordOn = (plan.existing && discordEnabled(plan.existing, plan.env?.discordToggle)) || v.discordEnable === true;
  a.discord = discordOn && !v.discordAbandoned && v.discordPrivateDir !== undefined
    ? { ownerUserId: v.discordOwnerUserId, ownerChannelId: v.discordOwnerChannelId, privateDir: v.discordPrivateDir }
    : null;
  a.password = v.password;
  a.memory = v.memory;
  if (v.memory === 'revien' && v.revienUrl) a.revienUrl = v.revienUrl;
  if (v.codexMemoriesOff === true) a.codexMemories = 'off';
  else if (v.codexMemoriesOn === true) a.codexMemories = 'on';
  if (v.browserEntry === true) a.browserEntry = true;
  a.phoneOrigin = v.phoneOrigin;
  if (v.tenantHost !== undefined) a.tenantHost = v.tenantHost;
  a.homeCreate = v.homeCreate === true;
  if (!opts.skipLedger && v.ledgerDir) a.ledgerChoice = v.ledgerDir;
  // The confirmations of the ratification steps, by plugin id, and the digests the person was shown.
  const picked = v.pluginsTrust === 'person' ? (v.plugins || []) : [];
  a.ratify = {};
  picked.forEach((id, i) => { if (v[`ratify_${i}`] !== undefined) a.ratify[id] = { confirmed: v[`ratify_${i}`] === true, digest: v[`ratify_${i}#digest`] }; });
  return a;
}

// ── walking a plan without a terminal (the app) ───────────────────────────────

const NO_BREAKS = /[\r\n]/;
const asBool = (x) => (typeof x === 'boolean' ? x : x === 'true' ? true : x === 'false' ? false : undefined);

/** A value sent for a step, as that step's value or a sentence saying why not: { value } | { error }. */
export function checkKind(step, r, raw) {
  switch (r.kind) {
    case 'yesno': {
      const b = asBool(raw);
      return b === undefined ? { error: 'Answer yes or no.' } : { value: b };
    }
    case 'choice': {
      const hit = (r.options || []).find((o) => o.value === raw);
      return hit ? { value: hit.value } : { error: 'Pick one of the choices.' };
    }
    case 'multichoice': {
      if (!Array.isArray(raw)) return { error: 'Pick from the list, or none.' };
      const known = new Set((r.options || []).map((o) => o.value));
      const out = [];
      for (const x of raw) { if (!known.has(x)) return { error: 'Pick from the list, or none.' }; if (!out.includes(x)) out.push(x); }
      return { value: out };
    }
    default: {
      if (typeof raw !== 'string') return { error: 'This answer has to be text.' };
      if (NO_BREAKS.test(raw)) return { error: 'This answer has to be on one line.' };
      return { value: raw.trim() };
    }
  }
}

/**
 * Walk the plan with answers sent in one go (by step id), the way the terminal walks it with typed ones: a step that is not asked
 * is skipped, an unanswered step takes its default, and each answer is checked and settled in order. Returns
 * { values, rows, problems }: the values by step id, one row per step in order ({ step, active, resolved?, value?, lines?, otherwise?,
 * problem? }), and every { id, message } that stops the plan from being applied. Reads, and writes nothing.
 */
export function walkValues(plan, sent = {}) {
  const v = {};
  const rows = [];
  const problems = [];
  const skippedSent = [];
  for (const step of plan) {
    plan.reset();
    if (step.skip && Object.hasOwn(sent, step.id)) skippedSent.push(step.id);
    const intro = step.skip ? null : step.intro?.(v) || null;
    if (!isActive(step, v)) {
      const f = skipFill(step, v);
      if (f) { v[step.id] = f.value; if (f.set) Object.assign(v, f.set); }
      rows.push({ step, active: false, intro, otherwise: step.skip ? (f?.line ? [f.line] : []) : step.otherwise?.(v) || [] });
      continue;
    }
    const r = evalStep(step, v);
    // A secret that was not sent is not re-sent from the saved one: empty means "keep what is saved".
    let value = r.kind === 'secret' ? '' : r.default;
    let problem = '';
    if (Object.hasOwn(sent, step.id)) {
      const c = checkKind(step, r, sent[step.id]);
      if (c.error) problem = c.error; else value = c.value;
    }
    // Checked as typed, before the terminal's leniency (an id that is not digits is emptied, a private folder in reach is swapped for the default).
    if (!problem && step.validate) problem = step.validate(value, v) || '';
    const s = settle(step, value, v);
    value = s.value;
    if (s.set) Object.assign(v, s.set);
    v[step.id] = value;
    if (r.meta?.digest) v[`${step.id}#digest`] = Object.hasOwn(sent, `${step.id}#digest`) ? sent[`${step.id}#digest`] : r.meta.digest;
    if (problem) problems.push({ id: step.id, message: problem });
    rows.push({ step, active: true, intro, resolved: r, value, lines: [...s.lines, ...(step.after?.(value, v, { generated: false }) || [])], problem });
  }
  return { values: v, rows, problems, skippedSent };
}

/** One step as the browser gets it: no secret is ever in it (a saved one is only marked `saved`). */
export function publicStep(row, introLines = []) {
  const r = row.resolved;
  const secret = r.kind === 'secret';
  return {
    id: r.id, kind: r.kind, section: r.section, phase: row.step.phase, question: r.appQuestion ?? r.question,
    help: [...introLines, ...r.help].filter((l, i, all) => l !== '' || (i > 0 && i < all.length - 1)),
    ...(secret ? { saved: !!r.default } : { default: r.default }),
    ...(r.options ? { options: r.options } : {}),
    ...(r.meta ? { meta: r.meta } : {}),
    ...(r.retry ? { retry: true } : {}),
  };
}

/** The steps the app shows for these answers, in order: only the ones asked, each with its words, defaults, options, and (for a secret) only
 *  whether one is saved. `notes` are what the terminal says in place of a step that is not asked or after an answer, for the review screen. */
export function describePlan(plan, sent = {}) {
  const { rows, problems } = walkValues(plan, sent);
  const steps = [];
  const notes = [];
  let carry = [];
  for (const row of rows) {
    const introLines = row.intro?.lines || [];
    if (!row.active) { carry = [...carry, ...introLines]; notes.push(...row.otherwise.filter(Boolean)); continue; }
    steps.push(publicStep(row, [...carry, ...introLines]));
    carry = [];
    notes.push(...row.lines.filter(Boolean));
  }
  return { steps, notes, problems };
}
