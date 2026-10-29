import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodexConfig, upsertEnv, generatePassword, applyAnswers, upsertTomlSection, setTomlTopLevel, tomlSectionHeader, applyMemoryChoice, rollingDefaults, migrateLegacyRolling, boundOrigin, listShippedPlugins, parsePluginSelection, chooseEnabledPlugins, ratifyShippedPlugins, writeIdentityBaseline, identityLedgerDirOf, runPluginRatification, ledgerClash, escapingImportsJs, buildStepFilesJs, writableRootsJs, planPluginRatification, mergeBrowserMcp, browserEntryHasFilter, browserMcpEntry, BROWSER_BLOCKED_TOOLS, parsePluginTrust, chooseCompanionPlugins } from './setup-lib.mjs';
import { createRequire } from 'node:module';
import { setupPlan, walkValues, buildAnswers } from './setup-plan.mjs';
import { applySetup, gatherSetupEnv } from './setup-apply.mjs';
import { pluginDigest, readLedger, ledgerPath, checkRatification, snapshotDir, escapingImports, buildStepFiles, ratifyDirectory, pruneSnapshots } from '../packages/backend/src/services/plugin-ratify.ts';
import { checkIdentity, ratifyIdentity, readIdentityLedger, readJournal } from '../packages/backend/src/services/identity/ledger.ts';
import { ledgerClash as tsLedgerClash, writableRoots as tsWritableRoots } from '../packages/backend/src/services/plugins.ts';

// plugins.ts reads the project root and the config; the parity tests below point both at a fixture.
const cfgHolder = vi.hoisted(() => ({ root: '' }));
vi.mock('../packages/backend/src/config.js', () => ({
  get PROJECT_ROOT() { return cfgHolder.root; },
  getSanctumConfig: () => ({}),
  internalBaseUrl: () => 'http://127.0.0.1:3099',
}));
vi.mock('../packages/backend/src/middleware/internal-token.js', () => ({ getInternalToken: () => 'token' }));

const FILTER = '/opt/sanctum/examples/browser-seat-neko/mcp-filter.mjs';
const WORKDIR = '/opt/sanctum/data/browser-out';
const BROWSER_MCP_ENTRY = browserMcpEntry(FILTER, WORKDIR);

describe('parseCodexConfig', () => {
  it('reads the default model and provider and every provider table', () => {
    const toml = `
model = "deepseek-chat"   # from the DeepSeek script
model_provider = "deepseek"
model_reasoning_effort = "medium"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
env_key = "DEEPSEEK_API_KEY"

[model_providers."my-router"]
name = 'Local router'
base_url = "http://127.0.0.1:4000/v1"

[mcp_servers.revien]
command = "revien"
`;
    expect(parseCodexConfig(toml)).toEqual({
      model: 'deepseek-chat', modelProvider: 'deepseek',
      providers: [
        { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
        { key: 'my-router', name: 'Local router', baseUrl: 'http://127.0.0.1:4000/v1' },
      ],
    });
  });
  it('is empty for a missing or plain ChatGPT-login config', () => {
    expect(parseCodexConfig('')).toEqual({ model: '', modelProvider: '', providers: [] });
    expect(parseCodexConfig('[projects."/x"]\ntrust_level = "trusted"\n').providers).toEqual([]);
  });
});

describe('upsertEnv', () => {
  it('replaces existing keys, uncomments a commented one, appends new ones, keeps the rest', () => {
    const text = '# header\nAPP_PASSWORD=\nTZ=\n# ANTHROPIC_API_KEY=\nOTHER=keep\n';
    const out = upsertEnv(text, { APP_PASSWORD: 'pw', ANTHROPIC_API_KEY: 'sk-1', NEW_KEY: 'v' });
    expect(out).toBe('# header\nAPP_PASSWORD=pw\nTZ=\nANTHROPIC_API_KEY=sk-1\nOTHER=keep\nNEW_KEY=v\n');
  });
});

describe('upsertEnv quotes what dotenv would misread', () => {
  const { parse } = createRequire(import.meta.url)('dotenv');
  const roundTrip = (v) => parse(upsertEnv('', { K: v })).K;

  it('leaves an ordinary value exactly as it was (no quotes)', () => {
    expect(upsertEnv('', { APP_PASSWORD: 'abcd-efgh-2345' })).toBe('APP_PASSWORD=abcd-efgh-2345\n');
    expect(upsertEnv('A=1\n', { B: 'sk-ant-api03_x.y/z+w=' })).toBe('A=1\nB=sk-ant-api03_x.y/z+w=\n');
  });

  it.each([
    ['a hash', 'pass#word'], ['a hash after a space', 'pass #word'], ['leading space', ' pass'], ['trailing space', 'pass '], ['inner spaces', 'my pass phrase'],
    ['a single quote', "it's"], ['a double quote', 'say "hi"'], ['both quotes', `it's "x"`], ['all three quotes', 'a\'b"c`d#'], ['a backtick', 'a`b'],
    ['a leading quote', '"quoted"'], ['a backslash', 'a\\b'], ['backslash n as two characters', 'a\\nb'], ['a dollar', 'a$b${c}'], ['an equals', 'a=b=c'], ['unicode', 'pässwörd-é-日本'],
  ])('%s: what dotenv reads back is what was written', (name, v) => {
    if (name === 'all three quotes') { expect(() => upsertEnv('', { K: v })).toThrow(/cannot be kept in \.env/); return; }
    expect(roundTrip(v)).toBe(v);
  });

  it('refuses a line break in any value, so one value cannot start another line', () => {
    expect(() => upsertEnv('', { K: 'a\nB=injected' })).toThrow(/line break/);
    expect(() => upsertEnv('', { K: 'a\rb' })).toThrow(/line break/);
  });

  it('keeps replacing an existing line (commented or not) and every other line', () => {
    expect(upsertEnv('# c\nK=old # note\nOTHER=1\n', { K: 'new #value' })).toBe("# c\nK='new #value'\nOTHER=1\n");
  });
});

describe('generatePassword', () => {
  it('is readable and long enough', () => {
    const p = generatePassword();
    expect(p).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(p).not.toMatch(/[01lio]/);
  });
});

describe('who manages plugins (plugins.trust)', () => {
  const base = { companionName: 'E', userName: 'L', timezone: 'UTC', home: '/h', provider: 'claude', claudeModel: 'm' };
  it('parsePluginTrust: 1 and companion, 2 and person/you; empty or junk keeps the default', () => {
    expect(['1', 'companion', 'Your Companion', ' 1 '].map((a) => parsePluginTrust(a, 'person'))).toEqual(['companion', 'companion', 'companion', 'companion']);
    expect(['2', 'person', 'YOU'].map((a) => parsePluginTrust(a))).toEqual(['person', 'person', 'person']);
    expect(parsePluginTrust('', 'person')).toBe('person');
    expect(parsePluginTrust('', undefined)).toBe('companion');
    expect(parsePluginTrust('banana', 'person')).toBe('person');
    expect(parsePluginTrust('banana')).toBe('companion');
  });
  it('chooseCompanionPlugins: the chosen shipped ones as they are, the person\'s own ones kept, nothing ratified or checked', () => {
    const shipped = [{ id: 'hello', name: 'Hello' }, { id: 'other', name: 'O' }];
    expect(chooseCompanionPlugins(['mine', 'hello', 3, 'mine'], shipped, ['other'])).toEqual(['mine', 'other']);
    expect(chooseCompanionPlugins(undefined, shipped, ['hello', 'other'])).toEqual(['hello', 'other']);
    expect(chooseCompanionPlugins(['hello'], shipped, [])).toEqual([]);
  });
  it('applyAnswers writes plugins.trust, next to the rest of the plugins block, only when asked', () => {
    expect(applyAnswers({}, { ...base, pluginsTrust: 'companion', pluginsEnabled: ['hello'] }).plugins).toEqual({ trust: 'companion', enabled: ['hello'] });
    expect(applyAnswers({ plugins: { dir: '/mine', trust: 'companion' } }, { ...base, pluginsTrust: 'person', pluginsEnabled: [] }).plugins).toEqual({ dir: '/mine', trust: 'person', enabled: [] });
    expect(applyAnswers({ plugins: { trust: 'person' } }, base).plugins).toEqual({ trust: 'person' });
    expect(applyAnswers({}, base).plugins).toBeUndefined();
    expect(applyAnswers({}, { ...base, pluginsTrust: 'everyone' }).plugins).toBeUndefined();
  });
  it('the plan asks the question before the plugin pick, defaults to 1 (the companion), and asks nothing to ratify under it', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-trust-')));
    try {
      for (const id of ['hello', 'other']) {
        mkdirSync(join(root, 'plugins', id), { recursive: true });
        writeFileSync(join(root, 'plugins', id, 'sanctum.plugin.json'), JSON.stringify({ id, name: id }));
      }
      const plan = setupPlan({}, { root });
      const ids = plan.map((s) => s.id);
      const trust = plan.find((s) => s.id === 'pluginsTrust');
      expect(ids.indexOf('pluginsTrust')).toBeGreaterThan(0);
      expect(ids.indexOf('plugins')).toBeGreaterThan(ids.indexOf('pluginsTrust'));
      expect(plan.find((s) => s.id === 'plugins').question).toContain('Which to turn on?');
      expect(trust.help).toEqual(['Who manages plugins?']);
      expect(trust.cli).toContain('1) your companion: it can turn plugins on and off and edit them, and you see what changed in Settings.');
      expect(trust.cli).toContain('2) you: nothing runs until you have read and ratified its exact code, and a change stops it until you ratify again.');
      expect(trust.default).toBe('companion');
      expect(setupPlan({ plugins: { trust: 'person' } }, { root }).find((s) => s.id === 'pluginsTrust').default).toBe('person');
      // the ratification steps are only asked on the person branch
      const ratifyAsked = (sent) => walkValues(plan, { provider: 'claude', ...sent }).rows.filter((r) => r.active && r.step.id.startsWith('ratify_')).map((r) => r.step.id);
      expect(ratifyAsked({ pluginsTrust: 'companion', plugins: ['hello'] })).toEqual([]);
      expect(ratifyAsked({ pluginsTrust: 'person', plugins: ['hello'] })).toEqual(['ratify_0']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('applyAnswers', () => {
  const base = { companionName: 'Nox', userName: 'Alex', timezone: 'America/New_York', home: '/Users/alex/Documents/companion-home', revien: true };
  it('writes a Codex setup with chat and summarizer models, keeping unrelated keys', () => {
    const cfg = applyAnswers({ server: { port: 3099 }, agent: { codex: { sandbox_mode: 'workspace-write', rolling: { tail_chars: 14000 } } } },
      { ...base, provider: 'codex', codexModel: 'deepseek-chat', codexProvider: 'deepseek', rolling: true, summarizerModel: 'gpt-5-mini', summarizerProvider: 'openai', phoneOrigin: 'https://host.example.ts.net', sandbox: 'workspace-write', extraDirs: ['/Users/alex/Notes'], appWrite: true });
    expect(cfg.agent.app_write).toBe(true);
    expect(cfg.command_center).toEqual({ enabled: true });
    expect(cfg.server.port).toBe(3099);
    expect(cfg.identity).toEqual({ companion_name: 'Nox', user_name: 'Alex', timezone: 'America/New_York' });
    expect(cfg.agent.provider).toBe('codex');
    expect(cfg.agent.cwd).toBe('/Users/alex/Documents/companion-home');
    expect(cfg.agent.codex).toMatchObject({ sandbox_mode: 'workspace-write', model: 'deepseek-chat', model_provider: 'deepseek', additional_directories: ['/Users/alex/Notes'] });
    expect(cfg.agent.codex.rolling).toBeUndefined();
    expect(cfg.agent.rolling).toEqual({ tail_chars: 14000, codex: true, model: 'gpt-5-mini', model_provider: 'openai' });
    expect(cfg.revien.enabled).toBe(true);
    expect(cfg.cors.origins).toEqual(['https://host.example.ts.net']);
  });
  it('writes a Claude setup', () => {
    const cfg = applyAnswers({ command_center: { enabled: false } }, { ...base, provider: 'claude', claudeModel: 'claude-opus-4-8', revien: false, rolling: false, appWrite: false });
    expect(cfg.agent).toEqual({ cwd: base.home, provider: 'claude', model: 'claude-opus-4-8', rolling: { claude: false }, app_write: false });
    expect(cfg.command_center).toEqual({ enabled: false }); // left as it was
    expect(cfg.revien.enabled).toBe(false);
    expect(cfg.cors).toBeUndefined();
  });
});

describe('codex config.toml editing', () => {
  const toml = `# my config
model = "gpt-5"
model_reasoning_effort = "medium"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
wire_api = "responses"

[mcp_servers.revien]
command = "revien"
`;
  it('quotes section ids that need it', () => {
    expect(tomlSectionHeader('model_providers.deepseek')).toBe('[model_providers.deepseek]');
    expect(tomlSectionHeader('model_providers.my router')).toBe('[model_providers."my router"]');
  });
  it('appends a new provider section and keeps everything else byte-identical', () => {
    const out = upsertTomlSection(toml, 'model_providers.router', { name: 'Router', base_url: 'http://127.0.0.1:4000/v1', wire_api: 'responses', experimental_bearer_token: 'sk-1' });
    expect(out.startsWith(toml.trimEnd())).toBe(true);
    expect(out).toContain('\n[model_providers.router]\nname = "Router"\nbase_url = "http://127.0.0.1:4000/v1"\nwire_api = "responses"\nexperimental_bearer_token = "sk-1"\n');
  });
  it('replaces an existing section in place, leaving neighbours alone', () => {
    const out = upsertTomlSection(toml, 'model_providers.deepseek', { name: 'DeepSeek', base_url: 'https://api.deepseek.com', wire_api: 'responses', experimental_bearer_token: 'sk-2' });
    expect(out).toContain('# my config\nmodel = "gpt-5"\nmodel_reasoning_effort = "medium"\n\n[model_providers.deepseek]\nname = "DeepSeek"\nbase_url = "https://api.deepseek.com"\nwire_api = "responses"\nexperimental_bearer_token = "sk-2"\n\n[mcp_servers.revien]\ncommand = "revien"\n');
    expect(out.match(/\[model_providers\.deepseek\]/g).length).toBe(1);
  });
  it('sets top-level keys before the first section, replacing or adding', () => {
    const out = setTomlTopLevel(toml, { model: 'deepseek-chat', model_provider: 'deepseek' });
    expect(out.startsWith('# my config\nmodel = "deepseek-chat"\nmodel_reasoning_effort = "medium"\nmodel_provider = "deepseek"\n\n[model_providers.deepseek]')).toBe(true);
  });
  it('works on an empty file', () => {
    expect(setTomlTopLevel('', { model: 'm' })).toBe('model = "m"\n');
    expect(upsertTomlSection('', 'features', { memories: false })).toBe('[features]\nmemories = false\n');
  });
});

describe('applyMemoryChoice', () => {
  it('turns exactly one memory on', () => {
    expect(applyMemoryChoice({}, 'revien')).toEqual({ revien: { enabled: true }, agent: { harness_memory: false } });
    expect(applyMemoryChoice({}, 'own')).toEqual({ revien: { enabled: false }, agent: { harness_memory: false } });
    expect(applyMemoryChoice({ agent: { cwd: '/h' } }, 'harness')).toEqual({ revien: { enabled: false }, agent: { cwd: '/h', harness_memory: true } });
    expect(applyMemoryChoice({}, 'none')).toEqual({ revien: { enabled: false }, agent: { harness_memory: false } });
  });
});

describe('rollingDefaults', () => {
  it('fresh install: on for both', () => {
    expect(rollingDefaults({}, false, false)).toEqual({ upgrade: false, effective: { codex: true, claude: true, dsh: true }, saved: { codex: false, claude: false, dsh: false } });
  });
  it('upgrade with no switch anywhere: keeps what is in effect today (Codex on, Claude off)', () => {
    expect(rollingDefaults({ identity: {} }, true, true)).toEqual({ upgrade: true, effective: { codex: true, claude: false, dsh: true }, saved: { codex: false, claude: false, dsh: false } });
  });
  it('a legacy codex.rolling.enabled counts as a switch and is honoured', () => {
    const r = rollingDefaults({ agent: { codex: { rolling: { enabled: false } } } }, true, true);
    expect(r.upgrade).toBe(false);
    expect(r.effective.codex).toBe(false);
  });
  it('a config without a database is not an upgrade', () => {
    expect(rollingDefaults({ identity: {} }, true, false).upgrade).toBe(false);
  });
  it('DeepSeek Harness: on by default (the app\'s own default), a saved switch is offered back, and it alone counts as a switch', () => {
    expect(rollingDefaults({ agent: { rolling: { dsh: false } } }, true, true)).toMatchObject({ upgrade: false, effective: { dsh: false }, saved: { dsh: true } });
  });

  it('re-running setup offers a saved "off" back as the default (issue #1, item 1)', () => {
    const r = rollingDefaults({ agent: { rolling: { claude: false } } }, true, true);
    expect(r.upgrade).toBe(false);
    expect(r.saved).toEqual({ claude: true, codex: false, dsh: false });
    expect(r.effective.claude).toBe(false);
    // The wizard's rule: upgrade or saved → effective, else on.
    const def = (p) => (r.upgrade || r.saved[p] ? r.effective[p] : true);
    expect(def('claude')).toBe(false);
    expect(def('codex')).toBe(true);
    const legacy = rollingDefaults({ agent: { codex: { rolling: { enabled: false } } } }, true, true);
    expect(legacy.saved.codex).toBe(true);
    expect(legacy.effective.codex).toBe(false);
  });
});

describe('boundOrigin', () => {
  it('is the browser origin of a server bound to a Tailscale or LAN address, and empty on loopback', () => {
    expect(boundOrigin({ server: { host: '100.64.0.1', port: 3099 } })).toBe('http://100.64.0.1:3099');
    expect(boundOrigin({ server: { host: '100.64.0.1' } })).toBe('http://100.64.0.1:3099');
    expect(boundOrigin({ server: { host: '127.0.0.1', port: 3099 } })).toBe('');
    expect(boundOrigin({ server: { host: '0.0.0.0', port: 3099 } })).toBe('');
    expect(boundOrigin({})).toBe('');
  });
  it('applyAnswers writes it into cors.origins once, next to the phone address', () => {
    const existing = { server: { host: '100.64.0.1', port: 3099 }, cors: { origins: ['http://100.64.0.1:3099'] } };
    const cfg = applyAnswers(existing, { companionName: 'Echo', userName: 'L', timezone: 'UTC', home: '/h', provider: 'claude', claudeModel: 'claude-sonnet-5-5', revien: false, phoneOrigin: 'https://host.example.ts.net' });
    expect(cfg.cors.origins).toEqual(['https://host.example.ts.net', 'http://100.64.0.1:3099']);
  });
});

describe('migrateLegacyRolling', () => {
  it('moves codex.rolling into agent.rolling, explicit new keys winning', () => {
    const out = migrateLegacyRolling({ agent: { rolling: { codex: true }, codex: { model: 'm', rolling: { enabled: false, tail_chars: 9000 } } } });
    expect(out.agent.rolling).toEqual({ codex: true, tail_chars: 9000 });
    expect(out.agent.codex).toEqual({ model: 'm' });
  });
});

describe('plugins in the wizard (BLOCKER A)', () => {
  const base = { companionName: 'Echo', userName: 'L', timezone: 'UTC', home: '/h', provider: 'claude', claudeModel: 'claude-sonnet-5-5', revien: false };
  const shipped = [{ id: 'hello', name: 'Hello (example plugin)' }, { id: 'browser', name: 'Browser' }];

  it('listShippedPlugins reads id and name from <root>/plugins/*/sanctum.plugin.json, skips broken ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-plugins-'));
    mkdirSync(join(root, 'plugins', 'b'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'b', 'sanctum.plugin.json'), JSON.stringify({ id: 'b', name: 'Bee' }));
    mkdirSync(join(root, 'plugins', 'a'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'a', 'sanctum.plugin.json'), JSON.stringify({ id: 'a' }));
    mkdirSync(join(root, 'plugins', 'bad'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'bad', 'sanctum.plugin.json'), '{nope');
    mkdirSync(join(root, 'plugins', 'empty'), { recursive: true });
    expect(listShippedPlugins(root)).toEqual([{ id: 'a', name: 'a' }, { id: 'b', name: 'Bee' }]);
    expect(listShippedPlugins(join(root, 'missing'))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('parsePluginSelection: empty and "none" mean none (the default); numbers and ids pick; junk is ignored', () => {
    expect(parsePluginSelection('', shipped)).toEqual([]);
    expect(parsePluginSelection('none', shipped)).toEqual([]);
    expect(parsePluginSelection('1', shipped)).toEqual(['hello']);
    expect(parsePluginSelection('2, hello', shipped)).toEqual(['browser', 'hello']);
    expect(parsePluginSelection('all', shipped)).toEqual(['hello', 'browser']);
    expect(parsePluginSelection('9, nope', shipped)).toEqual([]);
  });

  describe('chooseEnabledPlugins: plugins.enabled holds only ids that are ratified now', () => {
    const mkLedger = () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-enabled-')));
      const personDir = join(root, 'person');
      for (const id of ['mine', 'other']) {
        mkdirSync(join(personDir, id), { recursive: true });
        writeFileSync(join(personDir, id, 'sanctum.plugin.json'), JSON.stringify({ id, name: id }));
        writeFileSync(join(personDir, id, 'index.mjs'), `export default '${id}';\n`);
      }
      const ledgerDir = join(root, 'ledger');
      for (const id of ['mine']) ratifyDirectory(join(ledgerDir, 'ratified.json'), id, join(personDir, id));
      return { root, personDir, ledgerDir };
    };
    const said = () => { const out = []; return { out, say: (s) => out.push(s) }; };

    it('the shipped ids are exactly the ones that ratified; with nothing to check an unratified own id is left out with a message naming Settings', () => {
      const s = said();
      expect(chooseEnabledPlugins(['hello', 'mine'], shipped, ['browser'], { say: s.say })).toEqual(['browser']);
      expect(s.out.join('\n')).toMatch(/mine was left out of plugins\.enabled.*Settings > Plugins/);
      expect(chooseEnabledPlugins(undefined, shipped, [])).toEqual([]);
      expect(chooseEnabledPlugins(undefined, shipped, ['hello'])).toEqual(['hello']);
    });

    it('an own id with a ratification in the ledger (an intact copy) stays; one without it is left out, naming the Settings page', () => {
      const { root, personDir, ledgerDir } = mkLedger();
      try {
        const s = said();
        expect(chooseEnabledPlugins(['hello', 'mine', 'other'], shipped, ['browser'], { ledgerDir, personDir, say: s.say })).toEqual(['mine', 'browser']);
        expect(s.out).toHaveLength(1);
        expect(s.out[0]).toMatch(/^other was left out of plugins\.enabled: it is not ratified/);
        expect(s.out[0]).toMatch(/Settings > Plugins/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('an own id whose folder changed since it was ratified, or whose copy was damaged, is left out too', () => {
      const { root, personDir, ledgerDir } = mkLedger();
      try {
        writeFileSync(join(personDir, 'mine', 'index.mjs'), "export default 'edited';\n");
        const s = said();
        expect(chooseEnabledPlugins(['mine'], shipped, [], { ledgerDir, personDir, say: s.say })).toEqual([]);
        expect(s.out[0]).toMatch(/mine was left out/);
        writeFileSync(join(personDir, 'mine', 'index.mjs'), "export default 'mine';\n"); // back to the ratified bytes
        expect(chooseEnabledPlugins(['mine'], shipped, [], { ledgerDir, personDir })).toEqual(['mine']);
        const digest = readLedger(join(ledgerDir, 'ratified.json')).plugins.mine.digest;
        writeFileSync(join(ledgerDir, 'snapshots', 'mine', digest, 'index.mjs'), 'damaged');
        expect(chooseEnabledPlugins(['mine'], shipped, [], { ledgerDir, personDir })).toEqual([]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('the person\'s folder is found by its manifest id, not its folder name: a renamed folder that changed is left out', () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-enabled-')));
      try {
        const personDir = join(root, 'person');
        mkdirSync(join(personDir, 'my-folder'), { recursive: true });
        writeFileSync(join(personDir, 'my-folder', 'sanctum.plugin.json'), JSON.stringify({ id: 'mine', name: 'mine' }));
        writeFileSync(join(personDir, 'my-folder', 'index.mjs'), "export default 'mine';\n");
        const ledgerDir = join(root, 'ledger');
        ratifyDirectory(join(ledgerDir, 'ratified.json'), 'mine', join(personDir, 'my-folder'));
        expect(chooseEnabledPlugins(['mine'], shipped, [], { ledgerDir, personDir })).toEqual(['mine']);
        writeFileSync(join(personDir, 'my-folder', 'index.mjs'), "export default 'edited';\n");
        const s = said();
        expect(chooseEnabledPlugins(['mine'], shipped, [], { ledgerDir, personDir, say: s.say })).toEqual([]);
        expect(s.out[0]).toMatch(/^mine was left out of plugins\.enabled/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });

  it('applyAnswers writes plugins.enabled, keeps plugins.dir, and leaves the block alone when not asked', () => {
    const cfg = applyAnswers({ plugins: { dir: '/elsewhere', enabled: ['x'] } }, { ...base, pluginsEnabled: ['hello'] });
    expect(cfg.plugins).toEqual({ dir: '/elsewhere', enabled: ['hello'] });
    expect(applyAnswers({}, { ...base, pluginsEnabled: [] }).plugins).toEqual({ enabled: [] });
    expect(applyAnswers({ plugins: { enabled: ['x'] } }, base).plugins).toEqual({ enabled: ['x'] });
    expect(applyAnswers({}, base).plugins).toBeUndefined();
  });
});

describe('mergeBrowserMcp', () => {
  it('creates the file content when there is none', () => {
    for (const input of [undefined, '', '  \n']) {
      const r = mergeBrowserMcp(input, FILTER, WORKDIR);
      expect(r.action).toBe('added');
      expect(JSON.parse(r.text)).toEqual({ mcpServers: { browser: BROWSER_MCP_ENTRY } });
    }
  });
  it('adds browser and keeps every other server and top-level key as it was', () => {
    const before = { note: 1, mcpServers: { revien: { command: 'revien', args: ['serve'] }, remote: { type: 'http', url: 'https://x.test/mcp', headers: { a: 'b' } } } };
    const r = mergeBrowserMcp(JSON.stringify(before), FILTER, WORKDIR);
    expect(r.action).toBe('added');
    const after = JSON.parse(r.text);
    expect(after.note).toBe(1);
    expect(after.mcpServers.revien).toEqual(before.mcpServers.revien);
    expect(after.mcpServers.remote).toEqual(before.mcpServers.remote);
    expect(after.mcpServers.browser).toEqual(BROWSER_MCP_ENTRY);
  });
  it('adds mcpServers to a file that has none', () => {
    const r = mergeBrowserMcp('{"other":true}', FILTER, WORKDIR);
    expect(JSON.parse(r.text)).toEqual({ other: true, mcpServers: { browser: BROWSER_MCP_ENTRY } });
  });
  it('leaves a current browser entry alone, byte for byte, including one the person customised', () => {
    for (const entry of [BROWSER_MCP_ENTRY, { ...BROWSER_MCP_ENTRY, args: [...BROWSER_MCP_ENTRY.args, '--viewport-size', '800x600'] }]) {
      const text = JSON.stringify({ mcpServers: { browser: entry } }, null, 4);
      expect(mergeBrowserMcp(text, FILTER, WORKDIR)).toEqual({ action: 'exists', text });
    }
  });
  it('returns action "upgrade" for an existing browser entry that has no filter (pass-1 adopters), with the replacement and every other server kept', () => {
    for (const old of [{ command: 'my-own', args: ['--x'] }, { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--cdp-endpoint', 'http://127.0.0.1:9232'] }, { type: 'http', url: 'https://x.test/mcp' }, null, 'npx']) {
      const text = JSON.stringify({ mcpServers: { revien: { command: 'revien' }, browser: old } });
      const r = mergeBrowserMcp(text, FILTER, WORKDIR);
      expect(r.action).toBe('upgrade');
      expect(r.reason).toBe('unfiltered');
      expect(r.previous).toEqual(old);
      expect(r.entry).toEqual(BROWSER_MCP_ENTRY);
      expect(JSON.parse(r.text)).toEqual({ mcpServers: { revien: { command: 'revien' }, browser: BROWSER_MCP_ENTRY } });
    }
  });
  it('a dummy argument that merely contains mcp-filter.mjs does NOT make an entry filtered: it is upgraded as unfiltered', () => {
    const tail = ['--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', WORKDIR, '--', 'npx', '-y', '@playwright/mcp@0.0.83'];
    for (const old of [
      { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--cdp-endpoint', 'http://127.0.0.1:9232', '--note', 'mcp-filter.mjs'] },
      { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--user-data-dir', FILTER] },
      { command: 'npx', args: ['dummy', FILTER, ...tail] },
      { command: 'node', args: ['evil.mjs', FILTER, ...tail] },
      { command: 'node', args: ['/x/not-mcp-filter.mjs', ...tail] },
    ]) {
      const text = JSON.stringify({ mcpServers: { revien: { command: 'revien' }, browser: old } });
      const r = mergeBrowserMcp(text, FILTER, WORKDIR);
      expect(r.action, JSON.stringify(old)).toBe('upgrade');
      expect(r.reason).toBe('unfiltered');
      expect(r.previous).toEqual(old);
      expect(JSON.parse(r.text).mcpServers.browser).toEqual(BROWSER_MCP_ENTRY);
      expect(browserEntryHasFilter(old)).toBe(false);
    }
  });
  it('an entry written with the real filter in the Windows style (node.exe, backslashes) is current', () => {
    const entry = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\sanctum\\examples\\browser-seat-neko\\mcp-filter.mjs', '--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', WORKDIR, '--', 'npx'] };
    const text = JSON.stringify({ mcpServers: { browser: entry } });
    expect(mergeBrowserMcp(text, FILTER, WORKDIR)).toEqual({ action: 'exists', text });
  });
  it('also upgrades a pass-2 entry that has the filter but not --workdir, which the filter now refuses to start without', () => {
    const old = { command: 'node', args: [FILTER, '--block', 'browser_run_code_unsafe,browser_evaluate', '--', 'npx', '-y', '@playwright/mcp@0.0.83', '--cdp-endpoint', 'http://127.0.0.1:9232'] };
    const r = mergeBrowserMcp(JSON.stringify({ mcpServers: { browser: old } }), FILTER, WORKDIR);
    expect(r.action).toBe('upgrade');
    expect(r.reason).toBe('outdated');
    expect(JSON.parse(r.text).mcpServers.browser).toEqual(BROWSER_MCP_ENTRY);
  });
  it('returns upgrade/outdated for a filtered entry whose args fail the filter\'s own startup validation (typos, flags after --, relative workdir)', () => {
    const tail = ['--', 'npx', '-y', '@playwright/mcp@0.0.83'];
    const bad = [
      ['--block', 'browser_run_code_unsafe,browser_evaluat', '--workdir', WORKDIR, ...tail],
      ['--block', 'browser_run_code_unsafe', '--workdir', WORKDIR, ...tail],
      ['--block', 'browser_run_code_unsafe,browser_evaluate', '--', 'npx', '--workdir', WORKDIR],
      ['--', 'npx', '--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', WORKDIR],
      ['--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', 'data/browser-out', ...tail],
      ['--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', WORKDIR],
    ];
    for (const args of bad) {
      const r = mergeBrowserMcp(JSON.stringify({ mcpServers: { browser: { command: 'node', args: [FILTER, ...args] } } }), FILTER, WORKDIR);
      expect(r.action, args.join(' ')).toBe('upgrade');
      expect(r.reason).toBe('outdated');
    }
  });
  it('browserMcpEntry throws on a missing or non-string path instead of writing null into args', () => {
    expect(() => browserMcpEntry(undefined, WORKDIR)).toThrow();
    expect(() => browserMcpEntry(FILTER, undefined)).toThrow();
    expect(() => browserMcpEntry('', WORKDIR)).toThrow();
    expect(() => browserMcpEntry(FILTER, 5)).toThrow();
    expect(() => mergeBrowserMcp('', undefined, WORKDIR)).toThrow();
  });
  it('the entry turns WebMCP off and keeps the server output inside the workdir the filter runs in', () => {
    const a = BROWSER_MCP_ENTRY.args;
    expect(a).toContain('--no-webmcp');
    expect(a[a.indexOf('--workdir') + 1]).toBe(WORKDIR);
    expect(a[a.indexOf('--output-dir') + 1]).toBe(WORKDIR);
    expect(a.indexOf('--workdir')).toBeLessThan(a.indexOf('--'));
    expect(a.indexOf('--no-webmcp')).toBeGreaterThan(a.indexOf('--'));
    expect(a.indexOf('--output-dir')).toBeGreaterThan(a.indexOf('--'));
  });
  it('refuses malformed or wrongly shaped files and returns them untouched', () => {
    for (const text of ['{ "mcpServers": ', 'not json', '[]', 'null', '"s"', '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":"x"}']) {
      const r = mergeBrowserMcp(text, FILTER, WORKDIR);
      expect(r.action).toBe('refused');
      expect(r.text).toBe(text);
      expect(r.reason).toBeTruthy();
    }
  });
  it('the built-in entry equals the shipped example (placeholder path swapped), and its name is valid on dsh and Codex', () => {
    const raw = readFileSync(fileURLToPath(new URL('../examples/browser-seat-neko/mcp.example.json', import.meta.url)), 'utf-8');
    const ex = JSON.parse(raw.replaceAll('/ABSOLUTE/PATH/TO/sanctum-mobile/', '/opt/sanctum/'));
    expect(ex).toEqual({ mcpServers: { browser: BROWSER_MCP_ENTRY } });
    expect('browser').toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(BROWSER_MCP_ENTRY.args).toContain('--cdp-endpoint');
    expect(BROWSER_MCP_ENTRY.args.join(' ')).not.toMatch(/@latest|--isolated|--headless/);
  });
  it('the shipped entry blocks browser_run_code_unsafe and browser_evaluate and never starts Playwright MCP unfiltered', () => {
    // @playwright/mcp 0.0.83 has no exclude flag (both tools are capability "core", always on),
    // so the entry runs it behind mcp-filter.mjs, which drops them from tools/list and refuses calls.
    expect(BROWSER_BLOCKED_TOOLS).toEqual(['browser_run_code_unsafe', 'browser_evaluate']);
    const raw = readFileSync(fileURLToPath(new URL('../examples/browser-seat-neko/mcp.example.json', import.meta.url)), 'utf-8');
    for (const text of [raw, JSON.stringify(BROWSER_MCP_ENTRY)]) {
      expect(text).toContain('mcp-filter.mjs');
      expect(text).toContain('browser_run_code_unsafe');
      expect(text).toContain('browser_evaluate');
    }
    expect(BROWSER_MCP_ENTRY.command).toBe('node');
    expect(BROWSER_MCP_ENTRY.args[0]).toBe(FILTER);
    expect(BROWSER_MCP_ENTRY.args.indexOf('--')).toBeGreaterThan(0);
    expect(BROWSER_MCP_ENTRY.args.indexOf('npx')).toBeGreaterThan(BROWSER_MCP_ENTRY.args.indexOf('--'));
  });
});

describe('browser skill in the companion home', () => {
  const dir = (p) => fileURLToPath(new URL(`../companion-home/${p}/browser/SKILL.md`, import.meta.url));
  const claude = readFileSync(dir('.claude/skills'), 'utf-8');
  const agents = readFileSync(dir('.agents/skills'), 'utf-8');
  it('is in both roots (Claude scans .claude/skills, dsh scans .agents/skills) and the copies are identical', () => {
    expect(agents).toBe(claude);
  });
  it('has the frontmatter hooks.ts scanSkills reads (name, one-line description) and a kebab-case name for dsh', () => {
    const fm = claude.match(/^---\n([\s\S]*?)\n---/)[1];
    expect(fm.match(/^name:\s*(.+)$/m)[1].trim()).toBe('browser');
    expect(fm.match(/^description:\s*(.+)$/m)[1].trim().length).toBeGreaterThan(10);
    expect(fm).not.toMatch(/^description:.*:/m); // a second colon would need YAML quoting, which scanSkills would keep verbatim
  });
  it('carries the rules: snapshot first, never credentials, ask before sending', () => {
    for (const s of ['browser_snapshot', 'Never enter credentials', 'res ask', 'sends, posts, buys', 'take over']) expect(claude).toContain(s);
  });
  it('AGENTS.md asks first for anything sent, posted or bought from a logged-in account in the shared browser', () => {
    const a = readFileSync(fileURLToPath(new URL('../companion-home/AGENTS.md', import.meta.url)), 'utf-8');
    expect(a).toMatch(/logged-in accounts in the shared browser/i);
  });
});

describe('browser seat docs', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf-8');
  it('the seat README names both blocked tools and says to set browser_url as well', () => {
    const r = read('../examples/browser-seat-neko/README.md');
    expect(r).toContain('browser_run_code_unsafe');
    expect(r).toContain('browser_evaluate');
    expect(r).toMatch(/integrations\.browser_url/);
  });
  it('Codex has no skill root: the skill, AGENTS.md and FORK_NOTES say so', () => {
    const skill = read('../companion-home/.claude/skills/browser/SKILL.md');
    const afterFm = skill.split('\n---\n')[1];
    expect(afterFm.split('\n').find((l) => l.trim())).toMatch(/on Codex, read this file with cat before using the browser/i);
    expect(read('../companion-home/AGENTS.md')).toMatch(/Codex[^\n]*cat[^\n]*SKILL\.md|SKILL\.md[^\n]*Codex[^\n]*cat/);
    expect(read('../FORK_NOTES.md')).toMatch(/Codex has no skill root/i);
  });
  it('the skill says a viewer tab needs integrations.browser_url', () => {
    expect(read('../companion-home/.claude/skills/browser/SKILL.md')).toContain('integrations.browser_url');
  });
});

describe('plugin ratification in the wizard', () => {
  const mk = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-ratify-')));
    for (const id of ['hello', 'other']) {
      mkdirSync(join(root, 'plugins', id, 'dsh'), { recursive: true });
      writeFileSync(join(root, 'plugins', id, 'sanctum.plugin.json'), JSON.stringify({ id, name: id }));
      writeFileSync(join(root, 'plugins', id, 'dsh', 'index.mjs'), `export default '${id}';\n`);
    }
    return root;
  };
  const snapOf = (root, id, digest) => join(root, 'data', 'plugins', 'snapshots', id, digest);

  it('ratifies the shipped plugins it enables, with the digest the backend computes, and only those', () => {
    const root = mk();
    try {
      const r = ratifyShippedPlugins(root, ['hello']);
      expect(r).toEqual({ ok: true, ratified: ['hello'], skipped: [] });
      const ledger = readLedger(ledgerPath(root));
      expect(Object.keys(ledger.plugins)).toEqual(['hello']);
      const want = pluginDigest(join(root, 'plugins', 'hello'));
      expect(ledger.plugins.hello).toMatchObject({ digest: want.digest, files: want.files, root: join(root, 'plugins', 'hello') });
      expect(readdirSync(join(root, 'data', 'plugins')).sort()).toEqual(['ratified.json', 'snapshots']);
      if (process.platform !== 'win32') expect(statSync(ledgerPath(root)).mode & 0o777).toBe(0o600);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('also writes the ratified copy, so the backend finds the plugin ok and running from it (the two implementations agree)', () => {
    const root = mk();
    try {
      ratifyShippedPlugins(root, ['hello', 'other']);
      const dir = join(root, 'plugins', 'hello');
      const want = pluginDigest(dir);
      expect(pluginDigest(snapOf(root, 'hello', want.digest))).toEqual(want);
      expect(checkRatification('hello', dir, ledgerPath(root))).toEqual({ state: 'ok', digest: want.digest, snapshot: snapshotDir(ledgerPath(root), 'hello', want.digest) });
      expect(readdirSync(join(root, 'data', 'plugins', 'snapshots')).sort()).toEqual(['hello', 'other']); // no temp folder left
      if (process.platform !== 'win32') {
        expect(statSync(snapOf(root, 'hello', want.digest)).mode & 0o777).toBe(0o700);
        expect(statSync(join(snapOf(root, 'hello', want.digest), 'dsh', 'index.mjs')).mode & 0o777).toBe(0o600);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('honours a ledger folder of the person\'s choosing', () => {
    const root = mk();
    const away = realpathSync(mkdtempSync(join(tmpdir(), 'setup-ledger-away-')));
    try {
      const r = ratifyShippedPlugins(root, ['hello'], { ledgerDir: away });
      expect(r.ok).toBe(true);
      expect(Object.keys(readLedger(join(away, 'ratified.json')).plugins)).toEqual(['hello']);
      expect(existsSync(join(root, 'data'))).toBe(false);
      expect(checkRatification('hello', join(root, 'plugins', 'hello'), join(away, 'ratified.json')).state).toBe('ok');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(away, { recursive: true, force: true }); }
  });

  it('after a change, ratifying again keeps the new copy and the one before it (a running app may still read from it), and the ledger names the previous digest', () => {
    const root = mk();
    try {
      ratifyShippedPlugins(root, ['hello']);
      const first = pluginDigest(join(root, 'plugins', 'hello')).digest;
      writeFileSync(join(root, 'plugins', 'hello', 'dsh', 'index.mjs'), "export default 'changed';\n");
      ratifyShippedPlugins(root, ['hello']);
      const second = pluginDigest(join(root, 'plugins', 'hello')).digest;
      expect(readdirSync(join(root, 'data', 'plugins', 'snapshots', 'hello')).sort()).toEqual([first, second].sort());
      expect(readLedger(ledgerPath(root)).plugins.hello).toMatchObject({ digest: second, previous: first });
      writeFileSync(join(root, 'plugins', 'hello', 'dsh', 'index.mjs'), "export default 'third';\n");
      ratifyShippedPlugins(root, ['hello']);
      const third = pluginDigest(join(root, 'plugins', 'hello')).digest;
      expect(readdirSync(join(root, 'data', 'plugins', 'snapshots', 'hello')).sort()).toEqual([second, third].sort());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps ledger entries it was not asked about, and reports an id it cannot find or a folder it cannot hash', () => {
    const root = mk();
    try {
      ratifyShippedPlugins(root, ['other']);
      writeFileSync(join(root, 'plugins', 'hello', 'blob'), Buffer.alloc(26 * 1024 * 1024));
      const r = ratifyShippedPlugins(root, ['hello', 'ghost']);
      expect(r.ok).toBe(true);
      expect(r.ratified).toEqual([]);
      expect(r.skipped.map((s) => s.id)).toEqual(['hello', 'ghost']);
      expect(r.skipped[0].reason).toMatch(/keep dependencies outside the plugin folder/);
      expect(Object.keys(readLedger(ledgerPath(root)).plugins)).toEqual(['other']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('F6: a write failure is returned as { ok: false, error }, never thrown, and nothing is ratified', () => {
    const root = mk();
    try {
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(join(root, 'data', 'plugins'), 'a file where the ledger folder should be');
      let r;
      expect(() => { r = ratifyShippedPlugins(root, ['hello']); }).not.toThrow();
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
      expect(r.error).toMatch(/data[\\/]plugins/);
      expect(r.ratified).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('F6: a ledger that cannot be replaced (its path is a folder) is also ok: false, and leaves no copy behind', () => {
    const root = mk();
    try {
      mkdirSync(join(root, 'data', 'plugins', 'ratified.json'), { recursive: true });
      const r = ratifyShippedPlugins(root, ['hello']);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/ratified\.json/);
      const snaps = join(root, 'data', 'plugins', 'snapshots');
      expect(existsSync(snaps) ? readdirSync(snaps).flatMap((id) => readdirSync(join(snaps, id))) : []).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses to ratify code that is not the digest the person confirmed', () => {
    const root = mk();
    try {
      const seen = pluginDigest(join(root, 'plugins', 'hello')).digest;
      writeFileSync(join(root, 'plugins', 'hello', 'dsh', 'index.mjs'), "export default 'swapped after the question';\n");
      const r = ratifyShippedPlugins(root, ['hello', 'other'], { expected: { hello: seen } });
      expect(r.ok).toBe(true);
      expect(r.ratified).toEqual(['other']);
      expect(r.skipped).toEqual([{ id: 'hello', reason: expect.stringMatching(/changed while|changed since/) }]);
      expect(Object.keys(readLedger(ledgerPath(root)).plugins)).toEqual(['other']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a plugin that imports from outside its folder, like the backend', () => {
    const root = mk();
    try {
      writeFileSync(join(root, 'plugins', 'hello', 'dsh', 'index.mjs'), "import x from '../../outside.mjs';\nexport default x;\n");
      const r = ratifyShippedPlugins(root, ['hello']);
      expect(r.ratified).toEqual([]);
      expect(r.skipped[0].reason).toMatch(/dsh\/index\.mjs.*\.\.\/\.\.\/outside\.mjs.*outside the plugin folder/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the import scan agrees with the backend on every form', () => {
    const cases = [
      "import a from '../x.mjs';", 'import a from "../../x.mjs";', "import '../x.mjs';", "import {\n a,\n} from '../x.mjs';", "export * from '../x.mjs';",
      "export { a } from '../x.mjs';", "import('../x.mjs')", "import('../x.mjs?' + 1)", "require('../x.cjs')", "import a from './x.mjs';", "import a from '../sibling.mjs';",
      "import a from 'node:fs';", "import a from 'pkg';", "const n = 'x'; import(n);", "import a from '..\\\\x.mjs';",
      "import('data:text/javascript,export%20default%201');", "import('data:;base64,AAAA')", "const o = { data: 1, metadata: 2 };",
    ];
    for (const rel of ['dsh/a.mjs', 'a.cjs', 'dsh/deep/b.js', 'notes.txt']) {
      for (const text of cases) expect(escapingImportsJs(rel, text), `${rel}: ${text}`).toEqual(escapingImports(rel, text));
    }
  });
});

describe('F4: the wizard\'s ratification step', () => {
  const mk = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-flow-')));
    for (const id of ['hello', 'other']) {
      mkdirSync(join(root, 'plugins', id, 'dsh'), { recursive: true });
      writeFileSync(join(root, 'plugins', id, 'sanctum.plugin.json'), JSON.stringify({ id, name: id }));
      writeFileSync(join(root, 'plugins', id, 'dsh', 'index.mjs'), `export default '${id}';\n`);
    }
    return root;
  };
  /** Scripted prompts: `answers` are consumed in order; every question and line said is recorded. */
  const io = (answers = []) => {
    const said = [];
    const asked = [];
    return {
      said, asked,
      say: (s = '') => said.push(String(s)),
      ask: async (q, def = '') => { asked.push({ q, def }); return answers.length ? answers.shift() : def; },
      confirm: async (q, def) => { asked.push({ q, def }); const a = answers.length ? answers.shift() : undefined; return a === undefined ? def : a; },
    };
  };
  const cfgFor = (root, extra = {}) => ({ agent: { cwd: join(root, 'companion-home'), provider: 'claude' }, plugins: { enabled: [] }, ...extra });

  it('a never-ratified plugin: prints its file list and asks "Ratify this code?" with a default of NO; the person types y to ratify it', async () => {
    const root = mk();
    try {
      const t = io([true]);
      const r = await runPluginRatification(root, ['hello'], cfgFor(root), t);
      expect(r.ratified).toEqual(['hello']);
      expect(r.leftOut).toEqual([]);
      expect(t.said.join('\n')).toMatch(/dsh\/index\.mjs/);
      expect(t.said.join('\n')).toMatch(/sanctum\.plugin\.json/);
      expect(t.asked).toEqual([{ q: 'Ratify this code?', def: false }]);
      expect(Object.keys(readLedger(ledgerPath(root)).plugins)).toEqual(['hello']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('pressing enter on "Ratify this code?" (the default) ratifies nothing, for every plugin', async () => {
    const root = mk();
    try {
      const t = io(); // every confirm takes its default
      const r = await runPluginRatification(root, ['hello', 'other'], cfgFor(root), t);
      expect(r.ratified).toEqual([]);
      expect(r.leftOut.sort()).toEqual(['hello', 'other']);
      expect(t.asked.map((a) => a.def)).toEqual([false, false]);
      expect(existsSync(ledgerPath(root))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('declining a never-ratified plugin leaves it out, with a message, and writes nothing', async () => {
    const root = mk();
    try {
      const t = io([false]);
      const r = await runPluginRatification(root, ['hello'], cfgFor(root), t);
      expect(r.ratified).toEqual([]);
      expect(r.leftOut).toEqual(['hello']);
      expect(t.said.join('\n')).toMatch(/hello.*left out of plugins\.enabled/s);
      expect(existsSync(ledgerPath(root))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a plugin whose code changed since it was ratified: prints the changed paths (kind first) and the digest, asks "Ratify this changed code?" defaulting to NO', async () => {
    const root = mk();
    try {
      ratifyShippedPlugins(root, ['hello']);
      writeFileSync(join(root, 'plugins', 'hello', 'dsh', 'index.mjs'), "export default 'changed';\n");
      writeFileSync(join(root, 'plugins', 'hello', 'new.mjs'), 'x');
      rmSync(join(root, 'plugins', 'hello', 'sanctum.plugin.json'));
      writeFileSync(join(root, 'plugins', 'hello', 'sanctum.plugin.json'), JSON.stringify({ id: 'hello', name: 'hello', version: '2' }));
      const t = io(); // Enter on every question
      const r = await runPluginRatification(root, ['hello'], cfgFor(root), t);
      const text = t.said.join('\n');
      expect(text).toMatch(/^modified {2}dsh\/index\.mjs$/m);
      expect(text).toMatch(/^added {2}new\.mjs$/m);
      expect(text).toMatch(/^modified {2}sanctum\.plugin\.json$/m);
      expect(text).toContain(pluginDigest(join(root, 'plugins', 'hello')).digest);
      expect(t.asked).toEqual([{ q: 'Ratify this changed code?', def: false }]);
      expect(r.ratified).toEqual([]);
      expect(r.leftOut).toEqual(['hello']);
      // the old ratification stands untouched
      expect(readLedger(ledgerPath(root)).plugins.hello.files['dsh/index.mjs']).not.toBe(pluginDigest(join(root, 'plugins', 'hello')).files['dsh/index.mjs']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('changed code the person says yes to is ratified', async () => {
    const root = mk();
    try {
      ratifyShippedPlugins(root, ['hello']);
      writeFileSync(join(root, 'plugins', 'hello', 'dsh', 'index.mjs'), "export default 'changed';\n");
      const r = await runPluginRatification(root, ['hello'], cfgFor(root), io([true]));
      expect(r.ratified).toEqual(['hello']);
      expect(checkRatification('hello', join(root, 'plugins', 'hello'), ledgerPath(root)).state).toBe('ok');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('prints at most 10 changed paths and says how many more', async () => {
    const root = mk();
    try {
      ratifyShippedPlugins(root, ['hello']);
      for (let i = 0; i < 14; i++) writeFileSync(join(root, 'plugins', 'hello', `f${String(i).padStart(2, '0')}.mjs`), 'x');
      const t = io();
      await runPluginRatification(root, ['hello'], cfgFor(root), t);
      const lines = t.said.filter((l) => /^added {2}f\d\d\.mjs$/.test(l));
      expect(lines.length).toBe(10);
      expect(t.said.join('\n')).toMatch(/and 4 more/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('code that is already ratified (and still has its copy) is not asked about again', async () => {
    const root = mk();
    try {
      ratifyShippedPlugins(root, ['hello']);
      const t = io();
      const r = await runPluginRatification(root, ['hello'], cfgFor(root), t);
      expect(r.ratified).toEqual(['hello']);
      expect(t.asked).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('F6: a ledger write failure is said plainly (what failed), nothing is ratified, and nothing throws', async () => {
    const root = mk();
    try {
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(join(root, 'data', 'plugins'), 'in the way');
      const t = io([true, true]);
      const r = await runPluginRatification(root, ['hello', 'other'], cfgFor(root), t);
      expect(r.ratified).toEqual([]);
      expect(r.leftOut.sort()).toEqual(['hello', 'other']);
      expect(t.said.join('\n')).toMatch(/Could not write the ratification ledger.*data[\\/]plugins/s);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a ledger folder the companion can write (the default, with a home that contains it) is refused: it says so and asks for another folder', async () => {
    const root = mk();
    const away = realpathSync(mkdtempSync(join(tmpdir(), 'setup-away-')));
    try {
      const t = io([away, true]);
      const r = await runPluginRatification(root, ['hello'], cfgFor(root, { agent: { cwd: root, provider: 'claude' } }), t);
      expect(t.said.join('\n')).toMatch(/agent\.cwd/);
      expect(t.said.join('\n')).toMatch(/could ratify its own/);
      expect(t.asked[0].q).toMatch(/Folder for the ratification ledger/);
      expect(r.ledgerDir).toBe(away);
      expect(r.ratified).toEqual(['hello']);
      expect(existsSync(join(away, 'ratified.json'))).toBe(true);
      expect(existsSync(join(root, 'data'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(away, { recursive: true, force: true }); }
  });

  it('keeps asking while the chosen folder is also inside a writable root; an empty answer leaves every plugin off', async () => {
    const root = mk();
    try {
      const inside = join(root, 'inner-ledger');
      const t = io([inside, '']);
      const r = await runPluginRatification(root, ['hello', 'other'], cfgFor(root, { agent: { cwd: root, provider: 'claude' } }), t);
      expect(t.asked.length).toBe(2);
      expect(r.ratified).toEqual([]);
      expect(r.leftOut.sort()).toEqual(['hello', 'other']);
      expect(r.ledgerDir).toBeUndefined();
      expect(existsSync(join(root, 'data'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a home outside the app folder needs no extra question: the default ledger folder is fine', async () => {
    const root = mk();
    try {
      const t = io();
      const r = await runPluginRatification(root, ['hello'], cfgFor(root), t);
      expect(t.asked.some((a) => /Folder for the ratification ledger/.test(a.q))).toBe(false);
      expect(r.ledgerDir).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ledgerClash names the root for every kind the backend checks', () => {
    const root = mk();
    try {
      const data = join(root, 'data');
      const kinds = [
        ['agent.cwd', { agent: { cwd: data } }], ['hooks.workspace_root', { hooks: { workspace_root: data } }], ['hooks.vault_path', { hooks: { vault_path: data } }],
        ['hooks.safe_write_prefixes', { hooks: { safe_write_prefixes: [data] } }], ['hooks.extra_write_paths', { hooks: { extra_write_paths: [data] } }],
        ['agent.codex.additional_directories', { agent: { codex: { additional_directories: [data] } } }], ['agent.dsh.home', { agent: { dsh: { home: data } } }], ['plugins.dir', { plugins: { dir: data } }],
      ];
      for (const [label, cfg] of kinds) expect(ledgerClash(root, cfg)?.label, label).toBe(label);
      expect(ledgerClash(root, { agent: { cwd: join(root, 'companion-home') } })).toBeNull();
      expect(ledgerClash(root, { agent: { cwd: root }, plugins: { ledger_dir: join(tmpdir(), 'elsewhere-ledger') } })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('applyAnswers writes plugins.ledger_dir only when the wizard chose one', () => {
    const base = { companionName: 'E', userName: 'L', timezone: 'UTC', home: '/h', provider: 'claude', claudeModel: 'm' };
    expect(applyAnswers({}, { ...base, pluginsEnabled: ['hello'], pluginsLedgerDir: '/safe/ledger' }).plugins).toEqual({ enabled: ['hello'], ledger_dir: '/safe/ledger' });
    expect(applyAnswers({ plugins: { ledger_dir: '/mine' } }, { ...base, pluginsEnabled: [] }).plugins).toEqual({ ledger_dir: '/mine', enabled: [] });
  });

  it('applySetup ratifies before it writes sanctum.yaml, and enables only what ratified', async () => {
    const root = mk();
    const home = join(root, 'companion-home');
    mkdirSync(join(home, 'identity'), { recursive: true });
    writeFileSync(join(home, 'identity', 'profile.md'), 'p\n');
    try {
      const env = gatherSetupEnv(root, { processEnv: {}, homeDir: join(root, 'home'), codexInstalled: true });
      const plan = setupPlan(env.existing, env);
      const base = { provider: 'claude', home, password: 'a-long-enough-pw', pluginsTrust: 'person', plugins: ['hello', 'other'] };
      const run = (sent) => {
        const w = walkValues(plan, sent);
        expect(w.problems).toEqual([]);
        const said = [];
        const r = applySetup(buildAnswers(w.values, plan), plan, { say: (l = '') => said.push(l) });
        return { said, r, yaml: readFileSync(env.yamlPath, 'utf-8') };
      };
      const out = run({ ...base, ratify_0: true, ratify_1: false });
      const at = (re) => out.said.findIndex((l) => re.test(l));
      expect(at(/^Ratified: hello/)).toBeGreaterThanOrEqual(0);
      expect(at(/^Wrote .*sanctum\.yaml/)).toBeGreaterThan(at(/^Ratified: hello/)); // ratified first, written after
      expect(out.yaml).toMatch(/enabled:\n\s+- "hello"\n/);
      expect(out.yaml).not.toMatch(/other/);
      expect(Object.keys(readLedger(ledgerPath(root)).plugins)).toEqual(['hello']); // only what was agreed to
      expect(out.r.leftOut).toEqual(['other']);
      // nothing agreed to: nothing enabled, and no ledger is made
      rmSync(join(root, 'data'), { recursive: true, force: true });
      const none = run({ ...base, ratify_0: false, ratify_1: false });
      expect(none.yaml).toMatch(/enabled: \[\]/);
      expect(existsSync(ledgerPath(root))).toBe(false);
      expect(none.said).toContain('No plugin was turned on.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ── B5: the wizard's copy and the backend's agree, on a fixture set ───────────
describe('B5: the JS copy in setup-lib.mjs and the TS copy in plugin-ratify.ts / plugins.ts agree', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;
  const walk = (dir, rel = '', out = []) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) { out.push({ rel: r, dir: true, mode: st.mode & 0o777 }); walk(abs, r, out); } else out.push({ rel: r, dir: false, mode: st.mode & 0o777, bytes: readFileSync(abs) });
    }
    return out;
  };
  /** A project root holding shipped plugins with awkward contents. */
  const fixtureRoot = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-parity-')));
    const put = (id, files) => {
      for (const [rel, body] of Object.entries(files)) {
        const f = join(root, 'plugins', id, ...rel.split('/'));
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, body);
      }
    };
    put('plain', { 'sanctum.plugin.json': '{"id":"plain","name":"Plain"}', 'dsh/index.mjs': 'export default {};\n' });
    put('awkward', {
      'sanctum.plugin.json': '{"id":"awkward","name":"Awkward"}', 'empty.txt': '', 'crlf.txt': 'a\r\nb\r\n', 'bom.md': '﻿bom\n',
      'bin/all.bin': Buffer.from(Array.from({ length: 256 }, (_, i) => i)), 'deep/er/est/leaf.mjs': 'export const x = 1;\n',
      'ünï côdé.txt': 'unicode and spaces in the name\n', '.hidden': 'dot file\n', 'Z.txt': 'capital', 'a-b.txt': 'dash', 'big.txt': 'x'.repeat(300_000),
    });
    put('cjs', { 'sanctum.plugin.json': '{"id":"cjs","name":"Cjs"}', 'a.cjs': "module.exports = require('./b.cjs');\n", 'b.cjs': 'module.exports = 1;\n', 'data.json': '{"ok": true, "n": 3}' });
    return root;
  };

  it('write the same snapshot bytes, modes and ledger entry for every fixture plugin', () => {
    const root = fixtureRoot();
    const ledgerJs = join(root, 'ledger-js');
    const ledgerTs = join(root, 'ledger-ts');
    try {
      const r = ratifyShippedPlugins(root, ['plain', 'awkward', 'cjs'], { ledgerDir: ledgerJs });
      expect(r).toEqual({ ok: true, ratified: ['plain', 'awkward', 'cjs'], skipped: [] });
      for (const id of ['plain', 'awkward', 'cjs']) ratifyDirectory(join(ledgerTs, 'ratified.json'), id, join(root, 'plugins', id));
      const js = readLedger(join(ledgerJs, 'ratified.json'));
      const ts = readLedger(join(ledgerTs, 'ratified.json'));
      for (const id of ['plain', 'awkward', 'cjs']) {
        const { ratified_at: _a, ...a } = js.plugins[id];
        const { ratified_at: _b, ...b } = ts.plugins[id];
        expect(a, id).toEqual(b);
        const want = pluginDigest(join(root, 'plugins', id));
        expect(a.digest, id).toBe(want.digest);
        const snapJs = walk(snapshotDir(join(ledgerJs, 'ratified.json'), id, want.digest));
        const snapTs = walk(snapshotDir(join(ledgerTs, 'ratified.json'), id, want.digest));
        expect(snapJs.map((e) => e.rel), id).toEqual(snapTs.map((e) => e.rel));
        for (let i = 0; i < snapJs.length; i++) {
          expect(snapJs[i].dir, snapJs[i].rel).toBe(snapTs[i].dir);
          if (!snapJs[i].dir) expect(Buffer.compare(snapJs[i].bytes, snapTs[i].bytes), snapJs[i].rel).toBe(0);
          if (process.platform !== 'win32') expect(snapJs[i].mode, snapJs[i].rel).toBe(snapTs[i].mode);
        }
        // and the live folder's bytes are what was copied
        for (const e of snapJs) if (!e.dir) expect(Buffer.compare(e.bytes, readFileSync(join(root, 'plugins', id, ...e.rel.split('/')))), e.rel).toBe(0);
        expect(checkRatification(id, join(root, 'plugins', id), join(ledgerJs, 'ratified.json')).state, id).toBe('ok');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keep the same two snapshots and the same ledger `previous` over three ratifications, and the backend prunes the old one at boot', () => {
    const root = fixtureRoot();
    const ledgerJs = join(root, 'ledger-js');
    const ledgerTs = join(root, 'ledger-ts');
    try {
      const digests = [];
      for (const text of ['one\n', 'two\n', 'three\n']) {
        writeFileSync(join(root, 'plugins', 'plain', 'note.txt'), text);
        ratifyShippedPlugins(root, ['plain'], { ledgerDir: ledgerJs });
        ratifyDirectory(join(ledgerTs, 'ratified.json'), 'plain', join(root, 'plugins', 'plain'));
        digests.push(pluginDigest(join(root, 'plugins', 'plain')).digest);
      }
      for (const dir of [ledgerJs, ledgerTs]) {
        expect(readdirSync(join(dir, 'snapshots', 'plain')).sort(), dir).toEqual([digests[1], digests[2]].sort());
        expect(readLedger(join(dir, 'ratified.json')).plugins.plain, dir).toMatchObject({ digest: digests[2], previous: digests[1] });
        pruneSnapshots(join(dir, 'ratified.json')); // what the app does at its next start
        expect(readdirSync(join(dir, 'snapshots', 'plain')), dir).toEqual([digests[2]]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuse the same plugin folders with the same message: escaping imports, TypeScript, writable-root references', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-refuse-')));
    const writable = join(root, 'companion-home');
    const fixtures = {
      climb: { 'index.mjs': "import x from '../../x.mjs';\n" },
      pct: { 'a/index.mjs': "import x from './%2e%2e/%2e%2e/x.mjs';\n" },
      tpl: { 'index.mjs': 'await import(`../x.mjs`);\n' },
      dyn: { 'index.mjs': 'await import(`./${name}.mjs`);\n' },
      ts: { 'index.mjs': 'export default 1;\n', 'types.d.ts': 'export type A = 1;\n', 'b.tsx': 'export const b = 1;\n' },
      worker: { 'index.mjs': "new Worker(new URL('../w.mjs', import.meta.url));\n" },
      root: { 'index.mjs': `import x from ${JSON.stringify(join(writable, 'x.mjs'))};\n` },
      nulComment: { 'index.mjs': `//${'\0'.repeat(8200)}\nimport x from ${JSON.stringify(join(writable, 'x.mjs'))};\n` },
      nulBlob: { 'index.mjs': "require('./blob.bin');\n", 'blob.bin': `//${'\0'.repeat(8200)}\nrequire('../../x');\n` },
      binaryToken: { 'index.mjs': 'export default 1;\n', 'icon.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from('../../../x'), Buffer.from([0])]) },
      fine: { 'index.mjs': "import a from './b.mjs'; import c from 'node:fs';\n", 'b.mjs': 'export default 1;\n' },
      png: { 'index.mjs': 'export default 1;\n', 'icon.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(100, 7)]) },
    };
    try {
      for (const [id, files] of Object.entries(fixtures)) {
        for (const [rel, body] of Object.entries({ 'sanctum.plugin.json': `{"id":"${id}","name":"${id}"}`, ...files })) {
          const f = join(root, 'plugins', id, ...rel.split('/'));
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f, body);
        }
      }
      const scan = { writableRoots: [writable] };
      for (const id of Object.keys(fixtures)) {
        const js = ratifyShippedPlugins(root, [id], { ledgerDir: join(root, 'l-js'), writableRoots: scan.writableRoots });
        let tsMessage = null;
        try { ratifyDirectory(join(root, 'l-ts', 'ratified.json'), id, join(root, 'plugins', id), undefined, scan); } catch (e) { tsMessage = e.message; }
        if (id === 'fine' || id === 'png') { expect(js.ratified, id).toEqual([id]); expect(tsMessage, id).toBeNull(); continue; }
        expect(js.ratified, id).toEqual([]);
        expect(tsMessage, id).toBeTruthy();
        expect(js.skipped, id).toEqual([{ id, reason: tsMessage }]);
        expect(planPluginRatification(root, id, join(root, 'l-js'), scan), id).toEqual({ id, kind: 'error', reason: tsMessage });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('give the same verdict, with the same message, on the import scan table', () => {
    const writable = join(tmpdir(), 'wizard-parity-writable');
    const opts = { writableRoots: [writable] };
    const cases = [
      "import a from '../x.mjs';", 'import a from "./%2e%2e/x.mjs";', 'await import(`../x.mjs`);', 'await import(`./${n}.mjs`);', "createRequire(import.meta.url)(`./${n}`);",
      "new URL('../x.mjs', import.meta.url)", "new Worker('../x.mjs')", "import.meta.resolve('../x.mjs')", "import('\\x2e\\x2e/x')", "import('\\u{2e}\\u{2e}/x')",
      "import('./.\\t./x.mjs')", "import('.\\\n./x')", "import('\\.\\./x')", '// import a from "../x.mjs"', "const a = join(here, '..', 'x');", "import a from './%E0%A4%A/x';",
      `import a from ${JSON.stringify(join(writable, 'x.mjs'))};`, `import a from ${JSON.stringify(join(writable, 'x.mjs').toUpperCase())};`, `import a from ${JSON.stringify(`file://${join(writable, 'x.mjs')}`)};`,
      `import a from ${JSON.stringify(join(tmpdir(), 'elsewhere', 'x.mjs'))};`, "const s = `hello ${name}`; const t = '100%'; const u = 'https://e.com/a/../b';", "const [a, ...rest] = list;", "log('/%s/%d', a, b);", "import a from '/%s';", "import a from '../%s.mjs';", "import('data:text/javascript;base64,AAAA')", "import('d\\x61ta:,x')", "const o = { data: 1 }; // metadata: x",
      `//${'\0'.repeat(8200)}\nimport a from '../x.mjs';`, `const p = "${'\0'.repeat(10)}"; import a from ${JSON.stringify(join(writable, 'x.mjs'))};`, 'x\0../../../y\0', "import '../\0../../x';", `${'\0'.repeat(9000)}import a from './d.mjs';`,
      "import a from './d.mjs'; import b from '../sibling.mjs'; import c from 'node:fs'; import d from 'express';",
    ];
    for (const rel of ['a.mjs', 'dsh/a.mjs', 'dsh/deep/a.js', 'a.cjs', 'data.json', 'notes.txt', 'a.ts']) {
      for (const text of cases) {
        expect(escapingImportsJs(rel, text, opts), `${rel}: ${text}`).toEqual(escapingImports(rel, text, opts));
        expect(escapingImportsJs(rel, text), `${rel}: ${text} (no roots)`).toEqual(escapingImports(rel, text));
      }
    }
    const paths = ['a.mjs', 'b.ts', 'c.mts', 'd.cts', 'e.tsx', 'f.jsx', 'G.TS', 'x/types.d.ts', 'plain.js'];
    expect(buildStepFilesJs(paths)).toEqual(buildStepFiles(paths));
  });

  it('give the same clash verdict, and the same writable roots, for a fixture set of configs', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-clash-')));
    cfgHolder.root = root;
    const saved = { TMPDIR: process.env.TMPDIR, AGENT_PROVIDER: process.env.AGENT_PROVIDER };
    try {
      const data = join(root, 'data');
      const upper = join(root, 'DATA');
      const away = join(root, 'away');
      mkdirSync(join(root, 'Comp'), { recursive: true });
      const cfgs = [
        ['default home elsewhere', { agent: { cwd: away } }],
        ['home is the project root', { agent: { cwd: root } }],
        ['home inside data', { agent: { cwd: join(data, 'plugins', 'inner') } }],
        ['home differs only by case', { agent: { cwd: join(root, 'DATA', 'plugins') } }],
        ['ledger_dir moved away', { agent: { cwd: root }, plugins: { ledger_dir: join(tmpdir(), 'away-ledger') } }],
        ['ledger_dir by case', { agent: { cwd: join(root, 'Comp') }, plugins: { ledger_dir: join(root, 'comp', 'ledger') } }],
        ['workspace root', { agent: { cwd: away }, hooks: { workspace_root: data } }],
        ['vault', { agent: { cwd: away }, hooks: { vault_path: data } }],
        ['safe prefixes', { agent: { cwd: away }, hooks: { safe_write_prefixes: [data] } }],
        ['extra write', { agent: { cwd: away }, hooks: { extra_write_paths: [upper] } }],
        ['codex dirs', { agent: { cwd: away, codex: { additional_directories: [data] } } }],
        ['dsh home', { agent: { cwd: away, dsh: { home: data } } }],
        ['plugins dir', { agent: { cwd: away }, plugins: { dir: data } }],
        ['codex provider, ledger in /tmp', { agent: { cwd: away, provider: 'codex' }, plugins: { ledger_dir: join(tmpdir(), 'tmp-ledger') } }],
        ['dsh provider, ledger in /tmp', { agent: { cwd: away, provider: 'dsh' }, plugins: { ledger_dir: join(tmpdir(), 'tmp-ledger') } }],
        ['claude provider, ledger in /tmp', { agent: { cwd: away, provider: 'claude' }, plugins: { ledger_dir: join(tmpdir(), 'tmp-ledger') } }],
        ['Codex in capitals', { agent: { cwd: away, provider: 'Codex' }, plugins: { ledger_dir: join(tmpdir(), 'tmp-ledger') } }],
      ];
      for (const env of [{}, { TMPDIR: join(root, 'tmpdir-env') }, { AGENT_PROVIDER: 'codex' }]) {
        for (const k of Object.keys(saved)) delete process.env[k];
        Object.assign(process.env, env);
        for (const [what, cfg] of cfgs) {
          const js = ledgerClash(root, cfg);
          const ts = tsLedgerClash(cfg);
          expect(js?.label ?? null, `${what} ${JSON.stringify(env)}`).toBe(ts?.label ?? null);
          expect(js?.path ?? null, `${what} ${JSON.stringify(env)}`).toBe(ts?.path ?? null);
          expect(writableRootsJs(root, cfg, { pluginsDir: true }), `roots: ${what} ${JSON.stringify(env)}`).toEqual(tsWritableRoots(cfg, { pluginsDir: true }));
        }
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the clash verdicts are what the rules say, so a broken pair of copies would not pass by agreeing: /tmp under Codex, case folded, a sibling is not a clash', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-clash2-')));
    cfgHolder.root = root;
    try {
      const inTmp = join(tmpdir(), 'ledger-in-tmp');
      expect(ledgerClash(root, { agent: { cwd: join(root, 'h'), provider: 'codex' }, plugins: { ledger_dir: inTmp } })).not.toBeNull();
      expect(ledgerClash(root, { agent: { cwd: join(root, 'h'), provider: 'claude' }, plugins: { ledger_dir: inTmp } })).toBeNull();
      expect(ledgerClash(root, { agent: { cwd: join(root, 'Home') }, plugins: { ledger_dir: join(root, 'HOME', 'l') } })?.label).toBe('agent.cwd');
      expect(ledgerClash(root, { agent: { cwd: join(root, 'comp') }, plugins: { ledger_dir: join(root, 'company', 'l') } })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ratifyShippedPlugins reads an existing snapshot back (as the backend does): a damaged copy is replaced, and the plan does not call it unchanged', () => {
    const root = fixtureRoot();
    const ledgerDir = join(root, 'ledger');
    try {
      ratifyShippedPlugins(root, ['plain'], { ledgerDir });
      const d = pluginDigest(join(root, 'plugins', 'plain')).digest;
      const copy = join(ledgerDir, 'snapshots', 'plain', d);
      expect(planPluginRatification(root, 'plain', ledgerDir).kind).toBe('unchanged');
      writeFileSync(join(copy, 'dsh', 'index.mjs'), 'export default "tampered";\n'); // the copy no longer holds the ratified bytes
      expect(planPluginRatification(root, 'plain', ledgerDir).kind).toBe('new');
      expect(checkRatification('plain', join(root, 'plugins', 'plain'), join(ledgerDir, 'ratified.json')).state).toBe('ok'); // the backend only stats the copy
      const r = ratifyShippedPlugins(root, ['plain'], { ledgerDir });
      expect(r.ratified).toEqual(['plain']);
      expect(readFileSync(join(copy, 'dsh', 'index.mjs'), 'utf-8')).toBe('export default {};\n');
      expect(pluginDigest(copy).digest).toBe(d);
      expect(planPluginRatification(root, 'plain', ledgerDir).kind).toBe('unchanged');
      // a copy with an extra file is damaged too
      writeFileSync(join(copy, 'extra.mjs'), 'x');
      ratifyShippedPlugins(root, ['plain'], { ledgerDir });
      expect(existsSync(join(copy, 'extra.mjs'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  posixIt('ratifyShippedPlugins with a writable-root reference in a plugin: skipped, naming the file', () => {
    const root = fixtureRoot();
    try {
      const writable = join(root, 'companion-home');
      writeFileSync(join(root, 'plugins', 'plain', 'dsh', 'index.mjs'), `import x from ${JSON.stringify(join(writable, 'x.mjs'))};\n`);
      const r = ratifyShippedPlugins(root, ['plain'], { writableRoots: [writable] });
      expect(r.ratified).toEqual([]);
      expect(r.skipped[0].reason).toMatch(/dsh\/index\.mjs/);
      expect(ratifyShippedPlugins(root, ['plain']).ratified).toEqual(['plain']); // without the roots there is nothing to compare with
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runPluginRatification hands the configured writable roots to the scan', async () => {
    const root = fixtureRoot();
    try {
      const home = join(root, 'companion-home');
      writeFileSync(join(root, 'plugins', 'plain', 'dsh', 'index.mjs'), `import x from ${JSON.stringify(join(home, 'x.mjs'))};\n`);
      const said = [];
      const r = await runPluginRatification(root, ['plain'], { agent: { cwd: home, provider: 'claude' }, plugins: { enabled: [] } }, { say: (s = '') => said.push(s), ask: async (_q, d = '') => d, confirm: async () => true });
      expect(r.ratified).toEqual([]);
      expect(said.join('\n')).toMatch(/plain: cannot be ratified: dsh\/index\.mjs/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ── The identity baseline the wizard writes, and the backend that reads it ────
describe('writeIdentityBaseline (setup-lib.mjs) and services/identity/ledger.ts agree', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;
  const home = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'setup-identity-')));
    const h = join(base, 'home');
    mkdirSync(join(h, 'identity'), { recursive: true });
    const put = (n, body) => writeFileSync(join(h, 'identity', n), body);
    put('profile.md', '# Profile\n');
    put('companion.md', 'Narrative\r\nwith CRLF\n');
    put('companion.profile.yaml', 'companion:\n  name: Ada\n');
    put('Notes ünï.md', 'unicode name');
    put('empty.txt', '');
    put('avatar.png', Buffer.from([1, 2, 3]));   // an avatar is not part of the set
    put('.DS_Store', 'junk');                    // nor is a dot file
    mkdirSync(join(h, 'identity', 'sub'));       // nor a folder
    writeFileSync(join(h, 'identity', 'sub', 'deep.md'), 'not directly in identity/');
    return { base, h };
  };

  it('write the same digest, ratified entry, journal line and snapshot bytes; the backend then reads the wizard\'s ledger as ok', () => {
    const { base, h } = home();
    try {
      const js = join(base, 'ledger-js');
      const ts = join(base, 'ledger-ts');
      const r = writeIdentityBaseline(base, h, { ledgerDir: js });
      expect(r.ok, r.reason).toBe(true);
      expect(r.files).toEqual(['Notes ünï.md', 'companion.md', 'companion.profile.yaml', 'empty.txt', 'profile.md']);
      // the backend's own way of making a fresh install's baseline: first look, then ratify by setup without a second journal line
      checkIdentity(h, { ledgerDir: ts, trustStat: false });
      ratifyIdentity(h, { ledgerDir: ts, trustStat: false }, { by: 'setup', journal: false });
      const a = readIdentityLedger(js).ledger;
      const b = readIdentityLedger(ts).ledger;
      const strip = (l) => JSON.parse(JSON.stringify(l, (k, v) => (k === 'ratified_at' || k === 'at' ? '<time>' : v)));
      expect(strip(a)).toEqual(strip(b));
      expect(a.ratified.digest).toBe(r.digest);
      expect(a.ratified.by).toBe('setup');
      const ja = readJournal(js).map((e) => ({ ...e, at: '<time>' }));
      const jb = readJournal(ts).map((e) => ({ ...e, at: '<time>' }));
      expect(ja).toEqual(jb);
      expect(ja).toHaveLength(1);
      expect(ja[0]).toMatchObject({ author: 'baseline', digest_before: '' });
      for (const name of r.files) {
        expect(readFileSync(join(js, 'snapshots', r.digest, name))).toEqual(readFileSync(join(ts, 'snapshots', r.digest, name)));
        expect(readFileSync(join(js, 'snapshots', r.digest, name))).toEqual(readFileSync(join(h, 'identity', name)));
      }
      expect(readdirSync(join(js, 'snapshots', r.digest)).sort()).toEqual([...r.files].sort());
      // the backend reads what the wizard wrote as ratified and unchanged
      const seen = checkIdentity(h, { ledgerDir: js, trustStat: false });
      expect(seen.state).toBe('ok');
      expect(seen.digest).toBe(r.digest);
      expect(seen.detected).toBeUndefined();
      expect(readJournal(js)).toHaveLength(1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  posixIt('are owner-only like the backend\'s', () => {
    const { base, h } = home();
    try {
      const js = join(base, 'ledger-js');
      const r = writeIdentityBaseline(base, h, { ledgerDir: js });
      for (const p of [join(js, 'ledger.json'), join(js, 'journal.jsonl'), join(js, 'snapshots', r.digest, 'profile.md')]) expect(statSync(p).mode & 0o777, p).toBe(0o600);
      for (const d of [join(js, 'snapshots'), join(js, 'snapshots', r.digest)]) expect(statSync(d).mode & 0o777, d).toBe(0o700);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('refuses a ledger folder inside identity/, writes nothing over an existing ledger, and says so for a home without identity', () => {
    const { base, h } = home();
    try {
      const inside = writeIdentityBaseline(base, h, { ledgerDir: join(h, 'identity', 'ledger') });
      expect(inside.ok).toBe(false);
      expect(inside.reason).toMatch(/inside the identity folder/);
      expect(existsSync(join(h, 'identity', 'ledger'))).toBe(false);
      const dir = join(base, 'led');
      expect(writeIdentityBaseline(base, h, { ledgerDir: dir }).ok).toBe(true);
      const before = readFileSync(join(dir, 'ledger.json'), 'utf-8');
      const again = writeIdentityBaseline(base, h, { ledgerDir: dir });
      expect(again).toMatchObject({ ok: false, reason: 'the identity folder already has a ledger' });
      expect(readFileSync(join(dir, 'ledger.json'), 'utf-8')).toBe(before);
      expect(writeIdentityBaseline(base, join(base, 'nowhere'), { ledgerDir: join(base, 'x') }).ok).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('reads identity.ledger_dir from the existing config, relative to the project root', () => {
    expect(identityLedgerDirOf('/opt/app', {})).toBe(join('/opt/app', 'data', 'identity'));
    expect(identityLedgerDirOf('/opt/app', { identity: { ledger_dir: 'state/id' } })).toBe(resolve('/opt/app', 'state', 'id')); // the code resolves a relative folder against the root; resolve() gains the drive on Windows
    expect(identityLedgerDirOf('/opt/app', { identity: { ledger_dir: '/srv/id' } })).toBe(resolve('/srv/id')); // resolve() of a POSIX-absolute path gains the drive on Windows
  });
});

describe("applyMemoryChoice: Sanctum's own memory", () => {
  it("'sanctum' turns Revien and the harness memory off and agent.local_recall on; any other choice clears it, so it is a stand-in for Revien again", () => {
    const on = applyMemoryChoice({ agent: { provider: 'claude' } }, 'sanctum');
    expect(on).toMatchObject({ revien: { enabled: false }, agent: { harness_memory: false, local_recall: true, provider: 'claude' } });
    for (const m of ['revien', 'own', 'harness', 'none']) expect(applyMemoryChoice(on, m).agent).not.toHaveProperty('local_recall');
    expect(applyMemoryChoice({}, 'revien')).toMatchObject({ revien: { enabled: true } });
  });
});
