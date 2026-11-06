import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { gatherSetupEnv } from './setup-apply.mjs';
import { STEP_KINDS, setupPlan, walkValues, describePlan, checkKind, buildAnswers, parseAnswer, defaultText, evalStep } from './setup-plan.mjs';

const made = [];
afterEach(() => { while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true }); });

/** A sandbox app folder (fixed starter template and one shipped plugin) and its plan. `yaml` is an object written as JSON (valid YAML). */
function sandbox({ yaml, files = {}, codex = true, plugins = [] } = {}) {
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-plan-')));
  made.push(sbx);
  const root = path.join(sbx, 'app');
  appFixture(fs, path, root);
  for (const id of plugins) {
    fs.mkdirSync(path.join(root, 'plugins', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', id, 'sanctum.plugin.json'), JSON.stringify({ id, name: id }));
    fs.writeFileSync(path.join(root, 'plugins', id, 'index.mjs'), `export default '${id}';\n`);
  }
  if (yaml) fs.writeFileSync(path.join(root, 'sanctum.yaml'), JSON.stringify(yaml));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(sbx, rel)), { recursive: true }); fs.writeFileSync(path.join(sbx, rel), text); }
  const env = gatherSetupEnv(root, { processEnv: {}, homeDir: path.join(sbx, 'home'), codexInstalled: codex, timezoneDefault: 'UTC' });
  return { sbx, root, env, plan: setupPlan(env.existing, env) };
}
const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
const askedIds = (plan, sent) => walkValues(plan, sent).rows.filter((r) => r.active).map((r) => r.step.id);

describe('setupPlan: the steps', () => {
  it('is an ordered list of steps with unique ids and one of the five kinds', () => {
    const { plan } = sandbox({ plugins: ['alpha', 'beta'] });
    expect(plan.length).toBeGreaterThan(30);
    expect(new Set(plan.map((s) => s.id)).size).toBe(plan.length);
    for (const s of plan) {
      expect(STEP_KINDS, s.id).toContain(s.kind);
      expect(['string', 'function'], s.id).toContain(typeof s.question);
    }
    expect(plan.filter((s) => s.kind === 'choice' || s.kind === 'multichoice').every((s) => s.options !== undefined)).toBe(true);
  });

  it('is in this order (the plan the terminal and the app both walk)', () => {
    const { plan } = sandbox({ plugins: ['alpha', 'beta'] });
    expect(plan.map((s) => s.id)).toEqual([
      'companionName', 'userName', 'timezone', 'home', 'homeCreate',
      'provider', 'addProvider', 'providerId', 'providerName', 'providerBaseUrl', 'providerKey', 'providerModel', 'providerDefault', 'codexModel', 'codexProvider', 'claudeModel', 'anthropicKey', 'dshModel', 'dshKey',
      'sandbox', 'extraDirs', 'appWrite', 'rolling', 'pluginsTrust', 'plugins',
      'imageProvider', 'imageKey', 'summaryWho', 'summaryEndpoint', 'summaryKey',
      'discordEnable', 'discordOwnerUserId', 'discordOwnerChannelId', 'discordPrivateDir', 'password',
      'memory', 'codexMemoriesOff', 'codexMemoriesOn', 'browserSeat', 'browserEntry', 'phoneOrigin',
      'ledgerDir', 'ratify_0', 'ratify_1', 'ratify_2',
    ]);
  });

  it('writes nothing, ratifies nothing and makes nothing: building and walking a plan only reads', () => {
    const { sbx, root, plan } = sandbox({ plugins: ['alpha'], yaml: { plugins: { trust: 'person', enabled: ['alpha'] } } });
    const before = listing(sbx);
    walkValues(plan, { pluginsTrust: 'person', plugins: ['alpha'], ratify_0: true, discordEnable: true, homeCreate: true, browserSeat: true });
    describePlan(plan, {});
    expect(listing(sbx)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
  });

  it('asks the Codex steps on Codex and the Claude steps on Claude, never both', () => {
    const { plan } = sandbox();
    const codex = askedIds(plan, { provider: 'codex' });
    const claude = askedIds(plan, { provider: 'claude' });
    expect(codex).toEqual(expect.arrayContaining(['addProvider', 'codexModel', 'codexProvider', 'sandbox', 'extraDirs']));
    expect(codex).not.toContain('claudeModel');
    expect(claude).toEqual(expect.arrayContaining(['claudeModel', 'anthropicKey']));
    for (const id of ['addProvider', 'codexModel', 'sandbox', 'extraDirs']) expect(claude, id).not.toContain(id);
  });

  it('takes its defaults from the existing config, .env and Codex config, as the terminal always has', () => {
    const { plan } = sandbox({
      yaml: { identity: { companion_name: 'Ada', user_name: 'Sam', timezone: 'Europe/Berlin' }, agent: { provider: 'claude', model: 'claude-x', app_write: false, harness_memory: true, codex: { sandbox_mode: 'read-only' } }, plugins: { trust: 'person' }, cors: { origins: ['https://p.tail1.ts.net'] } },
      files: { 'app/.env': 'APP_PASSWORD=saved-pw\nANTHROPIC_API_KEY=sk-saved\n' },
    });
    const by = (id) => walkValues(plan, {}).rows.find((r) => r.step.id === id)?.resolved;
    expect(by('companionName').default).toBe('Ada');
    expect(by('userName').default).toBe('Sam');
    expect(by('timezone').default).toBe('Europe/Berlin');
    expect(by('provider').default).toBe('claude');
    expect(by('claudeModel').default).toBe('claude-x');
    expect(by('anthropicKey').default).toBe('sk-saved');
    expect(by('appWrite').default).toBe(false);
    expect(by('memory').default).toBe('harness');
    expect(by('pluginsTrust').default).toBe('person');
    expect(by('password').default).toBe('saved-pw');
    expect(by('phoneOrigin').default).toBe('https://p.tail1.ts.net');
    const codex = walkValues(plan, { provider: 'codex' }).rows.find((r) => r.step.id === 'sandbox').resolved;
    expect(codex.default).toBe('read-only');
  });

  it('a Codex provider that was just added becomes the default chat model and provider, from the plan\'s own answers', () => {
    const { plan } = sandbox({ codex: true });
    const w = (sent) => Object.fromEntries(walkValues(plan, sent).rows.filter((r) => r.active).map((r) => [r.step.id, r.resolved.default]));
    const base = { provider: 'codex', addProvider: true, providerId: 'DeepSeek' };
    const d = w(base);
    expect(d.providerName).toBe('DeepSeek');
    expect(d.providerBaseUrl).toBe('https://api.deepseek.com');
    expect(d.providerModel).toBe('deepseek-chat');
    expect(d.codexModel).toBe('deepseek-chat');
    expect(d.codexProvider).toBe('deepseek');
    // no base URL: nothing is added, so the chat defaults are the existing ones
    const none = w({ ...base, providerBaseUrl: '' });
    expect(none.codexProvider).toBe('');
    expect(Object.keys(none)).not.toContain('providerDefault');
  });

  it('the Codex install status, the provider list and the memories flag come from the inputs, not from the machine', () => {
    const on = sandbox({ codex: true, files: { 'home/.codex/config.toml': 'model = "m"\n\n[model_providers.x]\nname = "X"\nbase_url = "http://x"\n\n[features]\nmemories = true\n' } });
    const help = evalStep(on.plan.find((s) => s.id === 'addProvider'), { provider: 'codex' }).help.join('\n');
    expect(help).toContain('Codex is installed.');
    expect(help).toContain('Codex\'s own default: m.');
    expect(help).toContain('x (http://x)');
    expect(askedIds(on.plan, { provider: 'codex', memory: 'revien' })).toContain('codexMemoriesOff');
    expect(askedIds(on.plan, { provider: 'codex', memory: 'harness' })).not.toContain('codexMemoriesOn');
    const off = sandbox({ codex: false });
    expect(evalStep(off.plan.find((s) => s.id === 'addProvider'), { provider: 'codex' }).help.join('\n')).toContain('Codex was not found');
    expect(askedIds(off.plan, { provider: 'codex', memory: 'harness' })).toContain('codexMemoriesOn');
  });
});

describe('setupPlan: Discord, the lists folder', () => {
  it('asks to set Discord up only when it is not already on, and then asks for the ids and the folder', () => {
    const off = sandbox();
    expect(askedIds(off.plan, {})).toContain('discordEnable');
    expect(askedIds(off.plan, {})).not.toContain('discordOwnerUserId');
    expect(askedIds(off.plan, { discordEnable: true })).toEqual(expect.arrayContaining(['discordOwnerUserId', 'discordOwnerChannelId', 'discordPrivateDir']));
    const on = sandbox({ yaml: { discord: { enabled: true } } });
    expect(askedIds(on.plan, {})).not.toContain('discordEnable');
    expect(askedIds(on.plan, {})).toContain('discordPrivateDir');
  });

  it('proposes a folder beside the home folder, and refuses one the companion can write (privateDirProblem), inline', () => {
    const { plan, sbx } = sandbox();
    const w = walkValues(plan, { discordEnable: true, home: path.join(sbx, 'home', 'Documents', 'companion-home') });
    const dir = w.rows.find((r) => r.step.id === 'discordPrivateDir').resolved.default;
    expect(dir).toBe(path.join(sbx, 'home', 'Documents', 'sanctum-private'));
    expect(w.problems.find((p) => p.id === 'discordPrivateDir')).toBeUndefined();
    const bad = walkValues(plan, { discordEnable: true, home: path.join(sbx, 'home', 'Documents', 'companion-home'), discordPrivateDir: path.join(sbx, 'home', 'Documents', 'companion-home', 'private') });
    expect(bad.problems.map((p) => p.id)).toContain('discordPrivateDir');
    expect(bad.problems.find((p) => p.id === 'discordPrivateDir').message).toMatch(/inside .* your companion can write/);
  });

  it('a Discord id that is not digits is a problem for the app, where the terminal empties it', () => {
    const { plan } = sandbox();
    const w = walkValues(plan, { discordEnable: true, discordOwnerUserId: 'not-an-id' });
    expect(w.problems.find((p) => p.id === 'discordOwnerUserId').message).toMatch(/digits only/);
  });
});

describe('setupPlan: plugins and their ratification', () => {
  it('has one ratify step per shipped plugin, asked only when you manage plugins and picked it', () => {
    const { plan } = sandbox({ plugins: ['alpha', 'beta'], codex: false });
    const claude = { provider: 'claude' };
    expect(askedIds(plan, { ...claude, pluginsTrust: 'companion', plugins: ['alpha'] }).filter((i) => i.startsWith('ratify_'))).toEqual([]);
    expect(askedIds(plan, { ...claude, pluginsTrust: 'person', plugins: [] }).filter((i) => i.startsWith('ratify_'))).toEqual([]);
    expect(askedIds(plan, { ...claude, pluginsTrust: 'person', plugins: ['beta', 'alpha'] }).filter((i) => i.startsWith('ratify_'))).toEqual(['ratify_0', 'ratify_1']);
    const w = walkValues(plan, { ...claude, pluginsTrust: 'person', plugins: ['beta', 'alpha'] });
    expect(w.rows.find((r) => r.step.id === 'ratify_0').resolved.meta).toMatchObject({ pluginId: 'beta', kind: 'new' });
    expect(w.rows.find((r) => r.step.id === 'ratify_1').resolved.meta.pluginId).toBe('alpha');
    expect(w.rows.find((r) => r.step.id === 'ratify_0').resolved.meta.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(w.rows.find((r) => r.step.id === 'ratify_0').resolved.default).toBe(false);
  });

  it('shows the file list of a new plugin and asks the ledger folder only while the ledger would be in the companion\'s reach', () => {
    const { plan, sbx } = sandbox({ plugins: ['alpha'], codex: false });
    const claude = { provider: 'claude', pluginsTrust: 'person', plugins: ['alpha'] };
    const ok = walkValues(plan, claude);
    expect(ok.rows.find((r) => r.step.id === 'ledgerDir').active).toBe(false);
    expect(ok.rows.find((r) => r.step.id === 'ratify_0').resolved.help.join('\n')).toMatch(/the code you are about to ratify \(2 files\)[\s\S]*index\.mjs[\s\S]*digest [0-9a-f]{64}/);
    const reach = { ...claude, extraDirs: undefined };
    const clash = walkValues(plan, { ...reach, home: path.join(sbx, 'app') });
    expect(clash.rows.find((r) => r.step.id === 'ledgerDir').active).toBe(true);
    expect(clash.rows.find((r) => r.step.id === 'ledgerDir').resolved.help.join('\n')).toMatch(/could ratify its own changes/);
    // nothing to ratify while the ledger has nowhere safe to go: the plugins are left out
    const left = clash.rows.find((r) => r.step.id === 'ratify_0');
    expect(left.active).toBe(false);
    expect(left.otherwise.join('\n')).toMatch(/alpha was left out of plugins\.enabled/);
    // a folder out of reach lifts it
    const lifted = walkValues(plan, { ...reach, home: path.join(sbx, 'app'), ledgerDir: path.join(sbx, 'ledger') });
    expect(lifted.problems.map((p) => p.id)).not.toContain('ledgerDir');
    expect(lifted.rows.find((r) => r.step.id === 'ratify_0').active).toBe(true);
    // a folder still in reach is a problem, with the two lines
    const stillIn = walkValues(plan, { ...reach, home: path.join(sbx, 'app'), ledgerDir: path.join(sbx, 'app', 'data') });
    expect(stillIn.problems.find((p) => p.id === 'ledgerDir').message).toMatch(/could ratify its own changes/);
  });
});

describe('answers sent to the app: checkKind and what the browser is told', () => {
  const r = (kind, extra = {}) => ({ kind, options: [{ value: 'a' }, { value: 'b' }], ...extra });
  it('checks each kind', () => {
    expect(checkKind({}, r('yesno'), true)).toEqual({ value: true });
    expect(checkKind({}, r('yesno'), 'false')).toEqual({ value: false });
    expect(checkKind({}, r('yesno'), 'maybe').error).toBeTruthy();
    expect(checkKind({}, r('choice'), 'b')).toEqual({ value: 'b' });
    expect(checkKind({}, r('choice'), 'c').error).toBeTruthy();
    expect(checkKind({}, r('multichoice'), ['a', 'a'])).toEqual({ value: ['a'] });
    expect(checkKind({}, r('multichoice'), ['z']).error).toBeTruthy();
    expect(checkKind({}, r('text'), '  hi ')).toEqual({ value: 'hi' });
    expect(checkKind({}, r('text'), 5).error).toBeTruthy();
    expect(checkKind({}, r('secret'), 'a\nb').error).toMatch(/one line/);
  });

  it('describePlan names the steps asked and hides every secret, saying only that one is saved', () => {
    const { plan } = sandbox({ files: { 'app/.env': 'APP_PASSWORD=very-secret-pw\nANTHROPIC_API_KEY=sk-very-secret\n' }, yaml: { agent: { provider: 'claude' } } });
    const d = describePlan(plan, {});
    const text = JSON.stringify(d);
    expect(text).not.toContain('very-secret-pw');
    expect(text).not.toContain('sk-very-secret');
    expect(d.steps.find((s) => s.id === 'password')).toMatchObject({ kind: 'secret', saved: true });
    expect(d.steps.find((s) => s.id === 'password').default).toBeUndefined();
    expect(d.steps.find((s) => s.id === 'anthropicKey')).toMatchObject({ saved: true });
    expect(d.steps.map((s) => s.id)).not.toContain('codexModel');
    expect(d.steps.every((s) => STEP_KINDS.includes(s.kind))).toBe(true);
  });

  it('the terminal\'s way of reading an answer: Enter is the default, a number picks, anything else falls back', () => {
    const { plan } = sandbox({ plugins: ['alpha', 'beta'] });
    const step = (id) => plan.find((s) => s.id === id);
    const ev = (id, v = {}) => evalStep(step(id), v);
    expect(parseAnswer(step('provider'), ev('provider'), '', {})).toBe('codex');
    expect(parseAnswer(step('provider'), ev('provider'), '2', {})).toBe('claude');
    expect(parseAnswer(step('provider'), ev('provider'), 'claude', {})).toBe('codex');
    expect(defaultText(ev('provider'))).toBe('1');
    expect(parseAnswer(step('sandbox'), ev('sandbox'), '3', {})).toBe('danger-full-access');
    expect(parseAnswer(step('sandbox'), ev('sandbox'), '9', {})).toBe('workspace-write');
    expect(parseAnswer(step('pluginsTrust'), ev('pluginsTrust'), 'you', {})).toBe('person');
    expect(parseAnswer(step('plugins'), ev('plugins'), 'all', {})).toEqual(['alpha', 'beta', 'hello']);
    expect(parseAnswer(step('plugins'), ev('plugins'), '2, alpha', {})).toEqual(['beta', 'alpha']);
    expect(defaultText(ev('plugins'))).toBe('none');
    expect(parseAnswer(step('appWrite'), ev('appWrite'), '', {})).toBe(true);
    expect(parseAnswer(step('appWrite'), ev('appWrite'), 'Nope', {})).toBe(false);
    expect(parseAnswer(step('appWrite'), ev('appWrite'), 'yes please', {})).toBe(true);
  });
});

describe('relative paths in answers are relative to the app folder, as the terminal has always read them', () => {
  it('the home folder, the extra folders and the Discord folder resolve against the root the plan was built for, not the working directory', () => {
    const { plan, root, sbx } = sandbox();
    expect(process.cwd()).not.toBe(root); // the server runs from packages/backend, the terminal from the root
    const w = walkValues(plan, { password: 'long-enough-pw', provider: 'codex', home: 'rel-home', extraDirs: 'rel/a, ~/b, /abs/c', discordEnable: true, discordPrivateDir: 'rel-private' });
    expect(w.problems).toEqual([]);
    expect(w.values.home).toBe(path.join(root, 'rel-home'));
    expect(w.values.extraDirs).toEqual([path.join(root, 'rel', 'a'), path.join(sbx, 'home', 'b'), path.resolve(root, '/abs/c')]); // built as the code builds it: a rooted path with no drive takes the drive of root, not of the working directory
    expect(w.values.discordPrivateDir).toBe(path.join(root, 'rel-private'));
  });
});

describe('the password question says the same thing in the terminal and in the app', () => {
  it('the terminal keeps its words ("empty = make one up", the recordings pin them); the app, which rejects an empty answer, does not say it', () => {
    const { plan } = sandbox();
    const step = plan.find((s) => s.id === 'password');
    expect(evalStep(step, {}).question).toBe('App password (empty = make one up for you)');
    const shown = describePlan(plan, {}).steps.find((s) => s.id === 'password');
    expect(shown.question).toBe('App password');
    expect(JSON.stringify(describePlan(plan, {}))).not.toMatch(/make one up/);
  });
});

describe('buildAnswers', () => {
  it('turns the plan\'s values into what applyAnswers reads, with the codex-only and claude-only keys apart', () => {
    const { plan } = sandbox();
    const codex = buildAnswers(walkValues(plan, { provider: 'codex', companionName: 'Ada' }).values, plan);
    expect(codex).toMatchObject({ companionName: 'Ada', provider: 'codex', sandbox: 'workspace-write', extraDirs: [], rolling: true, pluginsTrust: 'companion', memory: 'revien', discord: null });
    expect(codex.claudeModel).toBeUndefined();
    const claude = buildAnswers(walkValues(plan, { provider: 'claude' }).values, plan);
    expect(claude).toMatchObject({ provider: 'claude', claudeModel: 'claude-sonnet-5-5' });
    expect(claude.sandbox).toBeUndefined();
    expect(claude.summarizerProvider).toBeUndefined();
    expect(codex.summarizerModel).toBeUndefined();
  });
});

describe('the app\'s checks on what goes into .env', () => {
  it('refuses a password or key that .env cannot hold, with a sentence', () => {
    const { plan } = sandbox({ yaml: { agent: { provider: 'claude' } } });
    const bad = 'a\'b"c`d#e-long-enough';
    expect(walkValues(plan, { provider: 'claude', password: bad }).problems.find((p) => p.id === 'password').message).toMatch(/cannot be kept in \.env/);
    expect(walkValues(plan, { provider: 'claude', anthropicKey: bad }).problems.find((p) => p.id === 'anthropicKey').message).toMatch(/cannot be kept in \.env/);
    expect(walkValues(plan, { provider: 'claude', password: 'has # and spaces ok' }).problems.map((p) => p.id)).not.toContain('password');
  });

  it('wants a password on a fresh install, and 8 characters or more when one is typed', () => {
    const { plan } = sandbox({ yaml: { agent: { provider: 'claude' } } });
    const msg = (sent) => walkValues(plan, { provider: 'claude', ...sent }).problems.find((p) => p.id === 'password')?.message;
    expect(msg({})).toMatch(/Choose a password/);
    expect(msg({ password: 'short' })).toMatch(/at least 8/);
    expect(msg({ password: 'long-enough' })).toBeUndefined();
  });

  it('keeps a saved password without asking for it again, even a short old one', () => {
    const { plan } = sandbox({ yaml: { agent: { provider: 'claude' } }, files: { 'app/.env': 'APP_PASSWORD=old\n' } });
    expect(walkValues(plan, { provider: 'claude' }).problems.map((p) => p.id)).not.toContain('password');
    expect(walkValues(plan, { provider: 'claude', password: 'old' }).problems.map((p) => p.id)).not.toContain('password');
    expect(walkValues(plan, { provider: 'claude', password: 'new' }).problems.map((p) => p.id)).toContain('password');
  });
});

describe('setupPlan: household mode (a companion shares the house password)', () => {
  it('asks no password and no hostname, says so in one line each, and never answers with a password', () => {
    const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-plan-house-')));
    made.push(sbx);
    const root = path.join(sbx, 'app');
    appFixture(fs, path, root);
    const tenantDir = path.join(root, 'tenants', 'ada');
    fs.mkdirSync(tenantDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'sanctum.yaml'), JSON.stringify({ tenants: { dir: path.join(root, 'tenants') } })); // (no `auth`: household)
    const plan = (opts) => { const env = gatherSetupEnv(root, { processEnv: {}, homeDir: path.join(sbx, 'home'), codexInstalled: true, timezoneDefault: 'UTC', tenantDir, tenantId: 'ada', operator: true, ...opts }); return { env, plan: setupPlan(env.existing, env) }; };
    const house = plan({});
    expect(house.env.household).toBe(true);
    const asked = askedIds(house.plan, { provider: 'claude' });
    expect(asked).not.toContain('password');
    expect(asked).not.toContain('tenantHost');
    const { notes, problems } = describePlan(house.plan, { provider: 'claude', password: 'ignored-by-household' });
    expect(notes.filter((n) => /household mode/.test(n) && /^Password/.test(n))).toHaveLength(1);
    expect(problems.map((p) => p.id)).not.toContain('password');
    expect(buildAnswers(walkValues(house.plan, { provider: 'claude', password: 'ignored-by-household' }).values, house.plan).password).toBeUndefined();
    // Per-tenant (the file says so, or the caller does): the same plan asks both again.
    const per = plan({ household: false });
    expect(per.env.household).toBe(false);
    expect(askedIds(per.plan, { provider: 'claude' })).toEqual(expect.arrayContaining(['password', 'tenantHost']));
  });
});
