// The setup wizard's transcript scenarios. Each one is a starting state (files, a database, a fake codex)
// and a script of [text the prompt must contain, answer] pairs, in order. Plain data: the pty proof
// (scripts/setup-proof.mjs) drives the real CLI with it, and scripts/setup-walk.test.mjs replays it in-process.
// `<SBX>` stands for the sandbox folder: the app is in <SBX>/app and HOME is <SBX>/home.

const HOME_Q = 'Home folder';
const PROVIDER_Q = 'Which one?';
const same = (s) => [s, ''];

/** The answers every scenario shares at the start: who, the home folder (kept), the provider. */
const who = (name = 'Ada', user = 'Sam', tz = '') => [["Your companion's name", name], ['Your name', user], ['Your timezone', tz]];
const home = (answer = '') => [[HOME_Q, answer]];

/** Everything after the model block, taking the default unless told otherwise. Options: appWrite, rolling, trust, pick, ratify (pairs), discord (null = not asked), discordAnswers, password, memory,
 *  memoryFlip, browser (null = not asked), browserAnswers, phone, claude. */
const restDefaults = (x = {}) => {
  return [
    ['Let your companion write', x.appWrite ?? ''],
    ['Long-conversation memory on', x.rolling ?? ''],
    ['Which one?', x.trust ?? ''], // who manages plugins
    ['Which to turn on?', x.pick ?? ''],
    ...(x.discord === null ? [] : [['Set up Discord?', x.discord ?? '']]),
    ...(x.discordAnswers || []),
    ['App password', x.password ?? 'hunter2-pass'],
    ['Which one?', x.memory ?? ''],
    ...(x.memoryFlip || []),
    ...(x.browser === null ? [] : [['Is the browser seat running', x.browser ?? '']]),
    ...(x.browserAnswers || []),
    ['Phone address', x.phone ?? ''],
    ...(x.ratify || []),
  ];
};

const EXISTING_YAML = (extra = '') => `# sanctum.yaml
identity:
  companion_name: "Ada"
  user_name: "Sam"
  timezone: "Europe/Berlin"
agent:
  cwd: "<SBX>/home/Documents/companion-home"
  provider: "codex"
  codex:
    model: "deepseek-chat"
    model_provider: "deepseek"
    sandbox_mode: "workspace-write"
    additional_directories: []
  rolling:
    codex: true
    claude: false
  app_write: true
  harness_memory: false
revien:
  enabled: true
${extra}`;

const TOML_DEEPSEEK = `model = "deepseek-chat"
model_provider = "deepseek"

# my own comment, kept
[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
`;

const homeWithProfile = { 'home/Documents/companion-home/identity/profile.md': 'profile\n' };

export const scenarios = [
  {
    name: 'fresh-codex-provider',
    note: 'a fresh install: no config, no .env, the home folder is made, a Codex provider is added and made the default, a password is made up',
    codex: true,
    answers: [...who(), ...home(), ['does not exist. Create it', 'y'], [PROVIDER_Q, '1'],
      ['Add a model provider', 'y'], ['Short name', 'DeepSeek'], ['Display name', ''], ['API base URL', ''], ['API key', 'sk-test-123'], ['Model id to use there', ''], ['Make deepseek', ''],
      ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ password: '' })],
  },
  {
    name: 'fresh-claude',
    note: 'a fresh install on Claude with an API key, the home folder declined',
    answers: [...who('Echo', ''), ...home(''), ['does not exist. Create it', 'n'], [PROVIDER_Q, '2'],
      ['Claude model id', ''], ['Anthropic API key', 'sk-ant-xyz'],
      ...restDefaults({ claude: true, rolling: 'n', password: 'pw one', memory: '4', phone: 'https://phone.tail1234.ts.net' })],
  },
  {
    name: 'fresh-claude-defaults',
    note: 'a fresh install on Claude taking every default, a made-up password',
    answers: [...who('', ''), ...home(''), ['does not exist. Create it', ''], [PROVIDER_Q, '2'], ['Claude model id', ''], ['Anthropic API key', ''],
      ...restDefaults({ claude: true, password: '' })],
  },
  {
    name: 'upgrade',
    note: 'an install from before rolling context: a config, a database, no rolling switch anywhere; every default is kept',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML().replace(/  rolling:\n    codex: true\n    claude: false\n/, ''), 'app/.env': 'APP_PASSWORD=old-password\nPORT=3099\n', ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    db: { 'app/data/sanctum.db': {} },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ password: '' })],
  },
  {
    name: 'rerun',
    note: 'a re-run of a finished setup: Enter on every question keeps everything',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), 'app/.env': 'APP_PASSWORD=kept-password\n', ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ password: '' })],
  },
  {
    name: 'codex-missing-no-toml',
    note: 'Codex is not installed and has no config: the missing notice, a provider added with no base URL (nothing added), full access and extra folders',
    answers: [...who(), ...home(''), ['does not exist. Create it', ''], [PROVIDER_Q, ''],
      ['Add a model provider', 'y'], ['Short name', 'local'], ['Display name', ''], ['API base URL', ''], ['API key', ''], ['Model id to use there', ''],
      ['Chat model id', 'some-model'], ['Chat provider name', ''], [PROVIDER_Q, '3'], ['Extra folders', '~/extra, <SBX>/other'],
      ...restDefaults({ appWrite: 'n', rolling: 'y' })],
  },
  {
    name: 'memory-flip-off',
    note: 'Codex memories are on in config.toml and the memory choice is Revien: asked to switch it off there, yes',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': `${TOML_DEEPSEEK}\n[features]\nmemories = true\nother_flag = false\n` },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ memoryFlip: [['Switch it off there too?', '']] })],
  },
  {
    name: 'memory-harness-flip-on',
    note: 'memory is the harness memory and Codex memories are off in config.toml: asked to switch it on, yes',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ memory: '3', memoryFlip: [['Switch Codex memories on', 'y']] })],
  },
  {
    name: 'memory-own-and-decline-flip',
    note: 'my own memory system, and the offer to switch Codex memories off is declined',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': `${TOML_DEEPSEEK}\n[features]\nmemories = true\n` },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ memory: '2', memoryFlip: [['Switch it off there too?', 'n']] })],
  },
  {
    name: 'permissions-readonly',
    note: 'permissions: read only, no extra folders, and app writes off',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', 'gpt-5'], ['Chat provider name', 'openai'], [PROVIDER_Q, '1'], ['Extra folders', ''],
      ...restDefaults({ appWrite: 'no' })],
  },
  {
    name: 'permissions-full-with-dirs',
    note: 'permissions: full access and two extra folders',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, '3'], ['Extra folders', '<SBX>/scratch,  ~/notes ,'],
      ...restDefaults({})],
  },
  {
    name: 'plugins-companion',
    note: 'the companion manages plugins: two shipped plugins picked by number and id, nothing ratified',
    codex: true,
    extraPlugin: 'other',
    files: { 'app/sanctum.yaml': EXISTING_YAML('plugins:\n  enabled:\n    - "mine"\n'), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ trust: '1', pick: '2, hello' })],
  },
  {
    name: 'plugins-person',
    note: 'you manage plugins: one ratified, one declined, one of your own enabled plugins left out as unratified',
    codex: true,
    extraPlugin: 'other',
    files: { 'app/sanctum.yaml': EXISTING_YAML('plugins:\n  trust: "companion"\n  enabled:\n    - "mine"\n'), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ trust: '2', pick: 'all', ratify: [['Ratify this code?', 'y'], ['Ratify this code?', 'n']] })],
  },
  {
    name: 'plugins-person-reorder-and-rerun',
    note: 'you manage plugins: picked in a different order than they ship, both ratified; then the same again (already ratified, so no prompt)',
    codex: true,
    extraPlugin: 'other',
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ trust: '2', pick: 'other, 1', ratify: [['Ratify this code?', 'y'], ['Ratify this code?', 'yes']] })],
  },
  {
    name: 'plugins-person-ledger-clash',
    note: 'you manage plugins and the companion can write the app folder, so the ledger would be in reach: a bad folder, then a good one',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', '<SBX>/app'],
      ...restDefaults({ trust: '2', pick: 'hello', ratify: [['Folder for the ratification ledger', '<SBX>/app/data'], ['Folder for the ratification ledger', '<SBX>/ledger'], ['Ratify this code?', 'y']] })],
  },
  {
    name: 'plugins-person-ledger-left-off',
    note: 'you manage plugins, the ledger would be in reach, and the folder is left empty: plugins stay off',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', '<SBX>/app'],
      ...restDefaults({ trust: '2', pick: 'hello', ratify: [['Folder for the ratification ledger', '']] })],
  },
  {
    name: 'discord-on',
    note: 'Discord set up: ids typed (one wrong), the private folder beside the home, the lists made',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ discord: 'y', discordAnswers: [['Your Discord user id', '123456789012345678'], ['Your owner channel id', 'not-an-id'], ['Private folder', '']] })],
  },
  {
    name: 'discord-private-inside-home',
    note: 'Discord: the private folder typed inside the home (refused, the default beside it is used)',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ discord: 'y', discordAnswers: [['Your Discord user id', '123456789012345678'], ['Your owner channel id', '223456789012345678'], ['Private folder', '<SBX>/home/Documents/companion-home/private']] })],
  },
  {
    name: 'discord-unusable',
    note: 'Discord: the companion can write the folder above the default private folder too, so Discord is not set up',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', '<SBX>/home/Documents'],
      ...restDefaults({ discord: 'y', discordAnswers: [['Your Discord user id', ''], ['Your owner channel id', ''], ['Private folder', '']] })],
  },
  {
    name: 'discord-already-on-by-toggle',
    note: 'Discord is on by the Settings toggle (a database row), so the lists are made without asking again; the lists that exist are kept',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML('discord:\n  owner:\n    user_id: "123456789012345678"\n    channel_id: "223456789012345678"\n  private_dir: "<SBX>/home/sanctum-private"\n'), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK, 'home/sanctum-private/words.txt': 'mine\n' },
    db: { 'app/data/sanctum.db': { 'discord.enabled': 'true' } },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ discord: null, discordAnswers: [['Your Discord user id', ''], ['Your owner channel id', ''], ['Private folder', '']] })],
  },
  {
    name: 'browser-add',
    note: 'the browser seat is running, and the entry is added to a new .mcp.json',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ browser: 'y', browserAnswers: [['Add the "browser" entry', '']] })],
  },
  {
    name: 'browser-replace-unfiltered',
    note: 'an unfiltered browser entry is already in .mcp.json: warned, and replaced (the file is backed up)',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML('integrations:\n  browser_url: "http://127.0.0.1:8080"\n'), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK, 'app/.mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' }, browser: { command: 'npx', args: ['@playwright/mcp'] } } }, null, 2) },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ browser: null, browserAnswers: [['Replace the "browser" entry', 'y']] })],
  },
  {
    name: 'browser-declined-and-refused',
    note: 'the browser seat is running but the .mcp.json is not JSON: left alone with a message',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK, 'app/.mcp.json': 'not json {' },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ browser: 'y' })],
  },
];


const CODEX_TOP = [['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', '']];
const keepAll = [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ...CODEX_TOP];
const BASE_FILES = { 'app/sanctum.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK };

scenarios.push(
  {
    name: 'odd-answers',
    note: 'answers the old wizard took leniently: "claude" typed for the provider (only 2 meant Claude), a sandbox that is no number, "Yes please", "maybe", "you", "none"',
    codex: true,
    files: BASE_FILES,
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, 'claude'], ['Add a model provider', 'n'], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, 'x'], ['Extra folders', ''],
      ...restDefaults({ appWrite: 'maybe', rolling: 'Yes please', trust: 'you', pick: 'none', memory: '9' })],
  },
  {
    name: 'odd-codex-answers',
    note: 'a sandbox number that does not exist and a memory number that does not exist, on Codex',
    codex: true,
    files: BASE_FILES,
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, '9'], ['Add a model provider', 'N'], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, '9'], ['Extra folders', ' , ,'],
      ...restDefaults({ trust: 'person', pick: '9, nothing', memory: '7' })],
  },
  {
    name: 'openai-preset-not-default',
    note: 'the OpenAI preset taken as it is, no key, not made the Terminal default',
    codex: true,
    files: { ...BASE_FILES, 'home/.codex/config.toml': '# nothing yet\n' },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Short name', 'OpenAI'], ['Display name', ''], ['API base URL', ''], ['API key', ''], ['Model id to use there', ''], ['Make openai', 'n'],
      ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''], ...restDefaults({})],
  },
  {
    name: 'rerun-claude',
    note: 'a re-run of a Claude install with an API key saved in .env: Enter on everything',
    files: { 'app/sanctum.yaml': EXISTING_YAML().replace('provider: "codex"', 'provider: "claude"').replace(/  codex:\n(    .*\n)+/, '').replace(/  rolling:\n    codex: true\n    claude: false\n/, '  rolling:\n    codex: true\n    claude: true\n  model: "claude-opus-test"\n'), 'app/.env': 'APP_PASSWORD=kept\nANTHROPIC_API_KEY=sk-ant-saved\n', ...homeWithProfile },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Claude model id', ''], ['Anthropic API key', ''], ...restDefaults({ claude: true, password: '' })],
  },
  {
    name: 'rerun-quoted-start',
    note: 'a .env from the original CLI whose password starts with a quote (dotenv reads it literally): two re-runs on Enter leave the line as it was',
    codex: true,
    files: { 'app/sanctum.yaml': EXISTING_YAML(), 'app/.env': "APP_PASSWORD='quoted-start\n", ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ password: '' })],
    again: { answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', ''], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...restDefaults({ password: '' })] },
  },
  {
    name: 'rerun-quoted-password',
    note: 'a Claude install whose .env holds a quoted password and a quoted API key: two re-runs on Enter keep both values and leave the file as it was',
    files: { 'app/sanctum.yaml': EXISTING_YAML().replace('provider: "codex"', 'provider: "claude"').replace(/  codex:\n(    .*\n)+/, '').replace(/  rolling:\n    codex: true\n    claude: false\n/, '  rolling:\n    codex: true\n    claude: true\n  model: "claude-opus-test"\n'), 'app/.env': "APP_PASSWORD='pa#ssword1'\nANTHROPIC_API_KEY=\"sk-ant #1\"\n", ...homeWithProfile },
    answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Claude model id', ''], ['Anthropic API key', ''], ...restDefaults({ claude: true, password: '' })],
    again: { answers: [...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Claude model id', ''], ['Anthropic API key', ''], ...restDefaults({ claude: true, password: '' })] },
  },
  {
    name: 'bound-host-and-origin',
    note: 'the server is bound to a Tailscale address: its origin is added to cors.origins; a phone address typed too',
    codex: true,
    files: { ...BASE_FILES, 'app/sanctum.yaml': EXISTING_YAML('server:\n  host: "100.64.0.7"\n  port: 3200\ncors:\n  origins:\n    - "https://old.tail9.ts.net"\n') },
    answers: [...keepAll, ...restDefaults({ phone: 'https://new.tail9.ts.net' })],
  },
  {
    name: 'legacy-resonant-yaml',
    note: 'a config from before the rename (resonant.yaml) is kept and edited in place',
    codex: true,
    files: { 'app/resonant.yaml': EXISTING_YAML(), ...homeWithProfile, 'home/.codex/config.toml': TOML_DEEPSEEK },
    answers: [...keepAll, ...restDefaults({})],
  },
  {
    name: 'plugins-person-twice',
    note: 'you manage plugins: ratified once, then the same setup run again (already ratified, so there is no prompt)',
    codex: true,
    files: BASE_FILES,
    answers: [...keepAll, ...restDefaults({ trust: '2', pick: 'hello', ratify: [['Ratify this code?', 'y']] })],
    again: { answers: [...keepAll, ...restDefaults({ trust: '', pick: '', password: '' })] },
  },
  {
    name: 'plugins-person-code-changed',
    note: 'you manage plugins: ratified once, the plugin then changes, and the next run shows the changed files and asks again',
    codex: true,
    extraPlugin: 'other',
    files: BASE_FILES,
    answers: [...keepAll, ...restDefaults({ trust: '2', pick: 'other', ratify: [['Ratify this code?', 'y']] })],
    again: { files: { 'app/plugins/other/dsh/index.mjs': "export default 'other, changed';\n", 'app/plugins/other/dsh/extra.mjs': 'export const x = 1;\n' }, answers: [...keepAll, ...restDefaults({ trust: '', pick: '', password: '', ratify: [['Ratify this changed code?', 'n']] })] },
  },
  {
    name: 'plugins-person-error-scan',
    note: 'you manage plugins and one plugin names a file outside its folder: it cannot be ratified',
    codex: true,
    extraPlugin: 'other',
    files: BASE_FILES,
    answers: [...keepAll, ...restDefaults({ trust: '2', pick: 'other', ratify: [] })],
    beforeRun: { 'app/plugins/other/dsh/index.mjs': "import x from '../../../outside.mjs';\nexport default x;\n" },
  },
);

// ── tenant mode: npm run setup -- --tenant <id> (docs/MULTI-TENANT.md). Recorded with the same recorder; the process sanctum.yaml names the
// tenants folder and what every tenant inherits. No port or phone question: a tenant does not decide where the process listens. ──────────
const TENANT_PROCESS_YAML = `# sanctum.yaml (the operator's)
identity:
  companion_name: "Operator"
  timezone: "UTC"
agent:
  provider: "codex"
  codex:
    model: "deepseek-chat"
    model_provider: "deepseek"
    sandbox_mode: "read-only"
tenants:
  dir: "<SBX>/app/tenants"
  auth: per-tenant
`;
const tenantRest = (x = {}) => restDefaults({ browser: null, ...x }).filter(([q]) => q !== 'Phone address');
const tenantHomeFile = { 'app/tenants/ada/home/identity/profile.md': 'profile\n' };

scenarios.push(
  {
    name: 'tenant-fresh-claude-created',
    note: 'tenant mode: --create, a host, the home from the template, Claude with a key, a password; memory is Revien, which asks for the tenant\'s own daemon address (an address that is not http(s) is asked again); no port, phone or browser-seat question',
    tenant: 'ada', create: true,
    files: { 'app/sanctum.yaml': TENANT_PROCESS_YAML.replace('provider: "codex"', 'provider: "claude"') },
    answers: [['Hostname this tenant', 'ada.example.net'], ...who('Ada', 'Sam', ''), ...home(''), ['does not exist. Create it', 'y'], [PROVIDER_Q, '2'],
      ['Claude model id', ''], ['Anthropic API key', 'sk-ant-xyz'],
      ...tenantRest({ claude: true, rolling: 'n', password: 'pw one', memory: '1', memoryFlip: [['Address of this tenant', 'ada.example.net:7438'], ['Address of this tenant', 'http://127.0.0.1:7438']] })],
  },
  {
    name: 'tenant-rerun-inherits',
    note: 'tenant mode: a tenant that already has a small tenant.yaml and .env; Enter on everything keeps it, memory defaults to none, and the operator\'s values are the defaults shown, never written into tenant.yaml',
    codex: true, tenant: 'ada',
    files: { 'app/sanctum.yaml': TENANT_PROCESS_YAML, 'app/tenants/ada/tenant.yaml': 'hosts:\n  - ada.example.net\nidentity:\n  companion_name: Ada\n  user_name: Sam\n  timezone: UTC\n', 'app/tenants/ada/.env': 'APP_PASSWORD=kept-password\n', ...tenantHomeFile },
    answers: [['Hostname this tenant', ''], ...who('', '', ''), ...home(''), [PROVIDER_Q, ''], ['Add a model provider', 'n'], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''], ['Extra folders', ''],
      ...tenantRest({ password: '' })],
  },
  {
    name: 'tenant-outside-paths-asked-again',
    note: 'tenant mode: a home folder outside the tenant folder, a timezone other than the process\'s, and an extra folder outside are each refused with a sentence and asked again',
    codex: true, tenant: 'ada',
    files: { 'app/sanctum.yaml': TENANT_PROCESS_YAML, ...tenantHomeFile },
    answers: [['Hostname this tenant', 'https://ada.example.net'], ['Hostname this tenant', 'ada.example.net'], ["Your companion's name", 'Ada'], ['Your name', 'Sam'], ['Your timezone', 'Europe/Berlin'], ['Your timezone', ''],
      [HOME_Q, '<SBX>/elsewhere'], [HOME_Q, ''], [PROVIDER_Q, ''], ['Add a model provider', 'n'], ['Chat model id', ''], ['Chat provider name', ''], [PROVIDER_Q, ''],
      ['Extra folders', '<SBX>/elsewhere/extra'], ['Extra folders', 'scratch'], ...tenantRest({ password: 'tenant-pass-1' })],
  },
);

/** The parts of an app folder the wizard reads, made from fixed text so a recorded transcript does not move when the real
 *  starter template or the shipped plugin changes: the home-folder template, a shipped plugin, .env.example. `fs` is node:fs. */
export function appFixture(fs, path, app) {
  const put = (rel, text) => {
    const p = path.join(app, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  put('companion-home/AGENTS.md', '# How I work\n\nFill in the << >> blanks.\n');
  put('companion-home/identity/profile.md', '# Profile\n\n<< your name >>\n');
  put('companion-home/identity/companion.md', '# Companion\n\n<< their name >>\n');
  put('companion-home/config/README.md', 'Settings live here.\n');
  put('plugins/hello/sanctum.plugin.json', JSON.stringify({ id: 'hello', name: 'Hello (example plugin)' }));
  put('plugins/hello/dsh/index.mjs', "export default 'hello';\n");
  put('plugins/hello/help.md', 'Says hello.\n');
  put('.env.example', '# Environment\n# Login password for the app.\nAPP_PASSWORD=\nANTHROPIC_API_KEY=\nPORT=\n');
}

/** A transcript or a file's text with what varies run to run taken out: the terminal's cursor codes and carriage returns, the sandbox
 *  folder, backup and ratification times. */
export const normalize = (text, sbx) => String(text)
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replaceAll('\r', '')
  .replaceAll(sbx, '<SBX>')
  .replace(/\.bak-\d{4}-\d\d-\d\dT[\d-]+Z/g, '.bak-TS')
  .replace(/"ratified_at": "[^"]+"/g, '"ratified_at": "TS"');

/** The text of a scenario's answers with the sandbox folder filled in. */
export const answersFor = (scenario, sbx) => scenario.answers.map(([q, a]) => [q, String(a).replaceAll('<SBX>', sbx)]);
export const fileText = (text, sbx) => text.replaceAll('<SBX>', sbx);
export { same };
