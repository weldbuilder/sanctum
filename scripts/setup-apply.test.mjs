import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { applySetup, backupFile, gatherSetupEnv, restartNeeded } from './setup-apply.mjs';
import { buildAnswers, setupPlan, walkValues, describePlan } from './setup-plan.mjs';

const made = [];
afterEach(() => { while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true }); });

const SECRETS = ['pw-super-secret-1', 'sk-ant-super-secret', 'sk-provider-super-secret', 'discord-fake-token'];

/** A sandbox app folder with a companion home that exists, and the plan for it. */
function sandbox({ yaml, files = {}, gather = {}, plugins = [] } = {}) {
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-apply-')));
  made.push(sbx);
  const root = path.join(sbx, 'app');
  appFixture(fs, path, root);
  for (const id of plugins) {
    fs.mkdirSync(path.join(root, 'plugins', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', id, 'sanctum.plugin.json'), JSON.stringify({ id, name: id }));
  }
  const home = path.join(sbx, 'home', 'Documents', 'companion-home');
  fs.mkdirSync(path.join(home, 'identity'), { recursive: true });
  fs.writeFileSync(path.join(home, 'identity', 'profile.md'), 'p\n');
  if (yaml) fs.writeFileSync(path.join(root, 'sanctum.yaml'), JSON.stringify(yaml));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(sbx, rel)), { recursive: true }); fs.writeFileSync(path.join(sbx, rel), text); }
  const env = gatherSetupEnv(root, { processEnv: {}, homeDir: path.join(sbx, 'home'), codexInstalled: true, timezoneDefault: 'UTC', ...gather });
  const plan = setupPlan(env.existing, env);
  const run = (sent, opts = { writer: 'the setup wizard', backupConfig: true }) => {
    const w = walkValues(plan, { home, ...sent });
    expect(w.problems).toEqual([]);
    const said = [];
    const result = applySetup(buildAnswers(w.values, plan), plan, { say: (l = '') => said.push(l) }, opts);
    return { result, said };
  };
  return { sbx, root, home, env, plan, run };
}
const read = (p) => fs.readFileSync(p, 'utf-8');
const listing = (dir) => fs.readdirSync(dir).sort();

describe('applySetup for the app: backups', () => {
  it('copies sanctum.yaml, .env and Codex\'s config.toml aside before writing them, and the copies keep the old text', () => {
    const { root, sbx, run, env } = sandbox({
      yaml: { identity: { companion_name: 'Old' } },
      files: { 'app/.env': 'APP_PASSWORD=old-password\n', 'home/.codex/config.toml': 'model = "x"\n' },
    });
    const { result } = run({ provider: 'codex', companionName: 'New', password: 'a-new-password', addProvider: true, providerId: 'local', providerBaseUrl: 'http://127.0.0.1:1234', providerName: 'Local', providerModel: 'm' });
    const files = listing(root);
    const bak = (name) => files.filter((f) => f.startsWith(`${name}.bak-`));
    expect(bak('sanctum.yaml')).toHaveLength(1);
    expect(bak('.env')).toHaveLength(1);
    expect(read(path.join(root, bak('sanctum.yaml')[0]))).toContain('"companion_name":"Old"');
    expect(read(path.join(root, bak('.env')[0]))).toBe('APP_PASSWORD=old-password\n');
    expect(listing(path.join(sbx, 'home', '.codex')).filter((f) => f.startsWith('config.toml.bak-'))).toHaveLength(1);
    expect(read(env.yamlPath)).toContain('companion_name: "New"');
    expect(read(env.envPath)).toContain('APP_PASSWORD=a-new-password');
    expect(result.changed.map((c) => c.what)).toEqual(expect.arrayContaining(['sanctum.yaml', 'Codex config.toml']));
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root, bak('.env')[0])).mode & 0o077).toBe(0); // a copy of secrets is owner-only
  });

  it('the terminal\'s way (no backupConfig) leaves sanctum.yaml and .env uncopied, as it always did', () => {
    const { root, run } = sandbox({ yaml: { identity: { companion_name: 'Old' } }, files: { 'app/.env': 'APP_PASSWORD=old-password\n' } });
    run({ provider: 'claude', password: 'another-password' }, { writer: 'npm run setup' });
    expect(listing(root).filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});

describe('applySetup for the app: the password', () => {
  it('an empty password keeps the saved one: the .env line is not touched', () => {
    const { env, run } = sandbox({ files: { 'app/.env': '# mine\nAPP_PASSWORD=saved-password\nPORT=3200\n' } });
    run({ provider: 'claude' });
    expect(read(env.envPath)).toBe('# mine\nAPP_PASSWORD=saved-password\nPORT=3200\n');
  });

  it('a password that lives only in the environment is kept as it is: nothing is copied into .env', () => {
    const { env, root, run } = sandbox({ gather: { savedPassword: 'from-the-environment' } });
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    run({ provider: 'claude' });
    expect(fs.existsSync(env.envPath)).toBe(false);
  });

  it('a fresh install with no password typed is refused: the app never makes one up, since it would have to show it', () => {
    const { run } = sandbox();
    expect(() => run({ provider: 'claude', password: '' })).toThrow(/password/i);
  });

  it('a typed password replaces the saved one', () => {
    const { env, run } = sandbox({ files: { 'app/.env': 'APP_PASSWORD=saved-password\n' } });
    run({ provider: 'claude', password: 'brand-new-password' });
    expect(read(env.envPath)).toContain('APP_PASSWORD=brand-new-password');
    expect(read(env.envPath)).not.toContain('saved-password');
  });
});

describe('applySetup sets the auth mode from the Claude way in', () => {
  it('a pasted key selects api_key and hands the key with it; no key (claude login) selects subscription; Codex sets nothing', () => {
    const { run } = sandbox();
    const calls = [];
    const opts = { writer: 'the setup wizard', backupConfig: true, setAuthMode: (u) => calls.push(u) };
    const keyed = run({ provider: 'claude', password: SECRETS[0], anthropicKey: SECRETS[1] }, opts);
    expect(calls).toEqual([{ auth_mode: 'api_key', api_key: SECRETS[1] }]);
    expect(keyed.result.authMode).toBe('api_key');
    expect(keyed.said.join('\n')).not.toContain(SECRETS[1]);
    calls.length = 0;
    const login = run({ provider: 'claude', password: SECRETS[0], anthropicKey: '' }, opts);
    expect(calls).toEqual([{ auth_mode: 'subscription' }]);
    expect(login.result.authMode).toBe('subscription');
    calls.length = 0;
    run({ provider: 'codex', password: SECRETS[0], addProvider: false }, opts);
    expect(calls).toEqual([]);
  });

  it('a hook that throws is said (no secret in it) and the rest of the apply stands; with no hook the choice is still on the result', () => {
    const { run, env } = sandbox();
    const bad = run({ provider: 'claude', password: SECRETS[0], anthropicKey: SECRETS[1] }, { writer: 'w', setAuthMode: () => { throw new Error('no database'); } });
    expect(bad.result.authMode).toBeNull();
    expect(bad.said.join('\n')).toMatch(/auth mode could not be set \(no database\)/);
    expect(read(env.envPath)).toContain(SECRETS[1]);
    expect(run({ provider: 'claude', password: SECRETS[0], anthropicKey: SECRETS[1] }).result.authMode).toBe('api_key');
  });
});

describe('applySetup never says or returns a secret', () => {
  it('the password, the Anthropic key and a provider key appear in no line said and nowhere in what is returned', () => {
    const { run, env } = sandbox();
    const claude = run({ provider: 'claude', password: SECRETS[0], anthropicKey: SECRETS[1] });
    for (const s of SECRETS) {
      expect(JSON.stringify(claude.result), s).not.toContain(s);
      expect(claude.said.join('\n'), s).not.toContain(s);
    }
    expect(read(env.envPath)).toContain(SECRETS[1]); // it is saved where it belongs
    const codex = run({ provider: 'codex', password: SECRETS[0], addProvider: true, providerId: 'deepseek', providerBaseUrl: 'https://api.deepseek.com', providerKey: SECRETS[2], providerModel: 'm', providerName: 'DeepSeek' });
    for (const s of SECRETS) {
      expect(JSON.stringify(codex.result), s).not.toContain(s);
      expect(codex.said.join('\n'), s).not.toContain(s);
    }
    expect(read(env.tomlPath)).toContain(SECRETS[2]);
  });

  it('describePlan shows a saved password and key only as "saved"', () => {
    const { plan } = sandbox({ files: { 'app/.env': `APP_PASSWORD=${SECRETS[0]}\nANTHROPIC_API_KEY=${SECRETS[1]}\n` }, yaml: { agent: { provider: 'claude' } } });
    const d = describePlan(plan, {});
    expect(JSON.stringify(d)).not.toContain(SECRETS[0]);
    expect(JSON.stringify(d)).not.toContain(SECRETS[1]);
    expect(d.steps.find((s) => s.id === 'password').saved).toBe(true);
  });
});

describe('applySetup for the app: what it makes and keeps', () => {
  it('keeps the names and the avatar of a companion that has them: the defaults are the saved names and the home folder is not touched', () => {
    const { plan, home, run, env } = sandbox({ yaml: { identity: { companion_name: 'Ada', user_name: 'Sam' } }, files: { 'app/.env': 'APP_PASSWORD=saved-password\n' } });
    fs.writeFileSync(path.join(home, 'identity', 'avatar.png'), Buffer.from([1, 2, 3, 4]));
    const names = walkValues(plan, {}).rows;
    expect(names.find((r) => r.step.id === 'companionName').resolved.default).toBe('Ada');
    expect(names.find((r) => r.step.id === 'userName').resolved.default).toBe('Sam');
    run({ provider: 'claude' });
    expect(read(env.yamlPath)).toMatch(/companion_name: "Ada"/);
    expect(read(env.yamlPath)).toMatch(/user_name: "Sam"/);
    expect([...fs.readFileSync(path.join(home, 'identity', 'avatar.png'))]).toEqual([1, 2, 3, 4]);
  });

  it('makes the home folder from the template when it is not there and the person said so, and says so in `changed`', () => {
    const { sbx, run, root } = sandbox();
    const home = path.join(sbx, 'newplace', 'companion-home');
    const { result, said } = run({ provider: 'claude', home, homeCreate: true, password: 'a-long-enough-pw' });
    expect(fs.existsSync(path.join(home, 'identity', 'profile.md'))).toBe(true);
    expect(result.changed.some((c) => c.path === home)).toBe(true);
    // the starter identity is recorded as ratified at setup (first journal line: baseline), in <root>/data/identity
    const ledger = JSON.parse(read(path.join(root, 'data', 'identity', 'ledger.json')));
    expect(ledger.ratified).toMatchObject({ by: 'setup' });
    expect(Object.keys(ledger.ratified.files).sort()).toEqual(['companion.md', 'profile.md']);
    expect(read(path.join(root, 'data', 'identity', 'journal.jsonl')).trim().split('\n').map((l) => JSON.parse(l).author)).toEqual(['baseline']);
    expect(result.changed.some((c) => /identity ledger/.test(c.what))).toBe(true);
    expect(said.some((l) => /^Identity: the starter files/.test(l))).toBe(true);
    const again = sandbox();
    const other = path.join(again.sbx, 'elsewhere', 'companion-home');
    again.run({ provider: 'claude', home: other, homeCreate: false, password: 'a-long-enough-pw' });
    expect(fs.existsSync(other)).toBe(false); // declined: nothing is made
    expect(fs.existsSync(path.join(again.root, 'data', 'identity'))).toBe(false); // and no ledger either: an existing home gets its baseline at the app's first start
  });

  it('an existing home gets no identity ledger from setup: the app takes its first look at start', () => {
    const { run, root } = sandbox();
    run({ provider: 'claude', password: 'a-long-enough-pw' });
    expect(fs.existsSync(path.join(root, 'data', 'identity'))).toBe(false);
  });

  it('ratifies in person mode only what was confirmed, before it writes sanctum.yaml, and answers with what was left out', () => {
    const { run, root, env } = sandbox({ yaml: { agent: { provider: 'claude' } }, plugins: ['other'] });
    const { result, said } = run({ provider: 'claude', password: 'a-long-enough-pw', pluginsTrust: 'person', plugins: ['hello', 'other'], ratify_0: true, ratify_1: false });
    expect(result.ratified).toEqual(['hello']);
    expect(result.leftOut).toEqual(['other']);
    expect(said.findIndex((l) => /^Ratified: hello/.test(l))).toBeLessThan(said.findIndex((l) => /^Wrote .*sanctum\.yaml/.test(l)));
    expect(read(env.yamlPath)).toMatch(/enabled:\n\s+- "hello"/);
    expect(JSON.parse(read(path.join(root, 'data', 'plugins', 'ratified.json'))).plugins.hello.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lists the ratification ledger in `changed` only when it was written', () => {
    const ledgerListed = (result) => result.changed.some((c) => /ratified\.json$/.test(c.path));
    // declined, with the ledger folder chosen away from the companion's reach: nothing was written
    const a = sandbox({ yaml: { agent: { provider: 'codex', codex: { sandbox_mode: 'workspace-write' } } } });
    // (a folder outside the temp folder, which Codex's sandbox can write)
    const ledger = fs.mkdtempSync(path.join(process.cwd(), '.ledger-test-'));
    made.push(ledger);
    const base = { provider: 'codex', password: 'a-long-enough-pw', pluginsTrust: 'person', plugins: ['hello'], extraDirs: a.root, ledgerDir: ledger };
    const declined = a.run({ ...base, ratify_0: false }).result;
    expect(declined.leftOut).toEqual(['hello']);
    expect(ledgerListed(declined)).toBe(false);
    expect(fs.existsSync(path.join(ledger, 'ratified.json'))).toBe(false);
    // confirmed: written, and listed
    const b = sandbox({ yaml: { agent: { provider: 'claude' } } });
    const first = b.run({ provider: 'claude', password: 'a-long-enough-pw', pluginsTrust: 'person', plugins: ['hello'], ratify_0: true }).result;
    expect(ledgerListed(first)).toBe(true);
    expect(fs.existsSync(path.join(b.root, 'data', 'plugins', 'ratified.json'))).toBe(true);
    // the same again: the code is already in the ledger, so nothing is written and nothing is listed
    const env2 = gatherSetupEnv(b.root, { processEnv: {}, homeDir: path.join(b.sbx, 'home'), codexInstalled: true, timezoneDefault: 'UTC' });
    const plan2 = setupPlan(env2.existing, env2);
    const w2 = walkValues(plan2, { home: b.home, provider: 'claude', pluginsTrust: 'person', plugins: ['hello'] });
    const second = applySetup(buildAnswers(w2.values, plan2), plan2, {}, { writer: 'the setup wizard' });
    expect(second.ratified).toEqual(['hello']);
    expect(ledgerListed(second)).toBe(false);
  });

  it('refuses to ratify code that changed after it was shown (the digest sent back is the one shown)', () => {
    const { run, root } = sandbox({ yaml: { agent: { provider: 'claude' } } });
    const w = walkValues(setupPlan(gatherSetupEnv(root, { processEnv: {}, codexInstalled: false }).existing, gatherSetupEnv(root, { processEnv: {}, codexInstalled: false })), { provider: 'claude', pluginsTrust: 'person', plugins: ['hello'] });
    const shown = w.rows.find((r) => r.step.id === 'ratify_0').resolved.meta.digest;
    fs.writeFileSync(path.join(root, 'plugins', 'hello', 'dsh', 'index.mjs'), "export default 'changed after it was shown';\n");
    const { result, said } = run({ provider: 'claude', password: 'a-long-enough-pw', pluginsTrust: 'person', plugins: ['hello'], ratify_0: true, 'ratify_0#digest': shown });
    expect(result.ratified).toEqual([]);
    expect(said.join('\n')).toMatch(/the code changed since you were shown it/);
    expect(fs.existsSync(path.join(root, 'data', 'plugins', 'ratified.json'))).toBe(false);
  });

  it('makes the Discord private lists, and keeps a list that is already there', () => {
    const { run, sbx } = sandbox({ yaml: { agent: { provider: 'claude' } } });
    const dir = path.join(sbx, 'home', 'Documents', 'sanctum-private');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'words.txt'), 'mine\n');
    const { result } = run({ provider: 'claude', password: 'a-long-enough-pw', discordEnable: true, discordOwnerUserId: '123456789012345678', discordOwnerChannelId: '223456789012345678' });
    expect(listing(dir)).toEqual(['exclusions.txt', 'names.txt', 'words.txt']);
    expect(read(path.join(dir, 'words.txt'))).toBe('mine\n');
    expect(result.changed.some((c) => /Discord private lists/.test(c.what))).toBe(true);
  });
});

describe('restartNeeded', () => {
  it('is false when only names change, true when the model, the origins, the server or the plugins do', () => {
    const before = { identity: { companion_name: 'A' }, agent: { provider: 'claude' }, cors: { origins: [] } };
    expect(restartNeeded(before, { ...before, identity: { companion_name: 'B' } })).toBe(false);
    expect(restartNeeded(before, { ...before, agent: { provider: 'codex' } })).toBe(true);
    expect(restartNeeded(before, { ...before, cors: { origins: ['https://x.ts.net'] } })).toBe(true);
    expect(restartNeeded(before, { ...before, plugins: { enabled: ['hello'] } })).toBe(true);
    expect(restartNeeded(before, { ...before, server: { host: '100.64.0.1' } })).toBe(true);
  });
});

describe('applySetup: re-running over a .env value the wizard (or dotenv) reads with quotes', () => {
  /** Run the wizard again on `sbx` pressing Enter on the password and the key; returns the .env text afterwards. */
  const rerun = ({ sbx, root, home }) => {
    const env = gatherSetupEnv(root, { processEnv: {}, homeDir: path.join(sbx, 'home'), codexInstalled: true, timezoneDefault: 'UTC' });
    const plan = setupPlan(env.existing, env);
    // Enter in the terminal takes the step's default.
    const dflt = (id) => plan.find((x) => x.id === id).default;
    const w = walkValues(plan, { home, provider: 'claude', password: dflt('password'), anthropicKey: dflt('anthropicKey') });
    expect(w.problems).toEqual([]);
    applySetup(buildAnswers(w.values, plan), plan, {}, { writer: 'the setup wizard', backupConfig: false });
    return { text: read(env.envPath), plan, w };
  };

  it('keeps a quoted password and API key through any number of Enter-only re-runs (it used to quote the quotes, then throw)', () => {
    const s = sandbox();
    s.run({ provider: 'claude', password: 'pa#ssword1', anthropicKey: 'sk-ant #1' }, { writer: 'the setup wizard' });
    const first = read(s.env.envPath);
    expect(first).toContain("APP_PASSWORD='pa#ssword1'");
    for (let i = 0; i < 4; i++) {
      const r = rerun(s);
      expect(r.text).toBe(first);
      expect(r.w.values.password).toBe('pa#ssword1');
      expect(r.w.values.anthropicKey).toBe('sk-ant #1');
    }
  });

  it("leaves `APP_PASSWORD='quoted-start` (which dotenv reads as 'quoted-start) as it is", () => {
    const s = sandbox({ files: { 'app/.env': "APP_PASSWORD='quoted-start\n" } });
    for (let i = 0; i < 3; i++) expect(rerun(s).text).toBe("APP_PASSWORD='quoted-start\n");
  });

  it('shows a saved value as its .env line has it (what the original CLI printed in the brackets), while the answer is the value', () => {
    const s = sandbox({ files: { 'app/.env': "APP_PASSWORD='pa#ssword1'\n" } });
    const step = s.plan.find((x) => x.id === 'password');
    expect(step.default).toBe('pa#ssword1');
    expect(step.display('pa#ssword1')).toBe("'pa#ssword1'");
    expect(step.display('something-new')).toBe('something-new');
  });
});

describe('applySetup: a new .env is owner-only', () => {
  it.skipIf(process.platform === 'win32')('creates .env as 0600, and leaves the mode of one that is already there', () => {
    const fresh = sandbox();
    fresh.run({ provider: 'claude', password: 'a-long-enough-pw' });
    expect(fs.statSync(fresh.env.envPath).mode & 0o777).toBe(0o600);
    const old = sandbox({ files: { 'app/.env': 'APP_PASSWORD=old-one-here\n' } });
    fs.chmodSync(old.env.envPath, 0o644);
    old.run({ provider: 'claude', password: 'a-different-pw' });
    expect(fs.statSync(old.env.envPath).mode & 0o777).toBe(0o644);
  });
});

describe('backupFile: the copy\'s name is legal on every OS', () => {
  const reserved = /[<>:"/\\|?*]/;
  it('a stamp with colons, dots and other reserved characters is made safe, and the name still sorts by time', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'setup-bak-'));
    made.push(dir);
    const f = path.join(dir, 'sanctum.yaml');
    fs.writeFileSync(f, 'a: 1\n');
    const bak = backupFile(f, () => '2026-01-02T03:04:05.678Z <>:"/\\|?*');
    expect(path.dirname(bak)).toBe(dir);
    expect(path.basename(bak)).not.toMatch(reserved);
    expect(path.basename(bak).startsWith('sanctum.yaml.bak-2026-01-02T03-04-05-678Z')).toBe(true);
    expect(fs.readFileSync(bak, 'utf-8')).toBe('a: 1\n');
  });
  it('the default stamp (the current time) is safe too', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'setup-bak-'));
    made.push(dir);
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'X=1\n');
    expect(path.basename(backupFile(f))).toMatch(/^\.env\.bak-[0-9A-Za-z_-]+$/);
  });
  it('never replaces an earlier backup: the same stamp twice gives a second file, and the first keeps its contents', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'bak-'));
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'first\n');
    const a = backupFile(f, () => 'same');
    fs.writeFileSync(f, 'second\n');
    const b = backupFile(f, () => 'same');
    expect(b).toBe(`${a}-1`);
    expect(fs.readFileSync(a, 'utf8')).toBe('first\n');
    expect(fs.readFileSync(b, 'utf8')).toBe('second\n');
    expect(backupFile(f, () => 'same')).toBe(`${a}-2`);
  });
});
