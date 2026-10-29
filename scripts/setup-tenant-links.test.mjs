// Round 3 of stage 4, the wizard's side: a tenant's own files and folders are its own (items 1, 2, 9), Revien addresses in every spelling (item 4),
// a nested ~ and `inherit: false` survive a rewrite (items 5 and 6). Each check is run against the backend's own function over the same case (parity).
// Links need privileges on Windows: those cases return early when the platform refuses them. No provider, no model run.
import { afterEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { applySetup, gatherSetupEnv } from './setup-apply.mjs';
import { buildAnswers, setupPlan, walkValues } from './setup-plan.mjs';
import { runSetup } from './setup-walk.mjs';
import { DEFAULT_REVIEN_URL, normaliseRevienAddress, revienProblems, tenantFilesProblem, tenantsDirProblem, tenantYamlProblems } from './setup-inherit.mjs';
import { loadTenantConfig, tenantFilesProblem as backendFilesProblem, tenantsDirProblem as backendDirProblem } from '../packages/backend/src/tenancy/config.ts';
import { processConfigFor } from '../packages/backend/src/tenancy/test-runtime.ts';
import { PROJECT_ROOT, mergeConfigDefaults } from '../packages/backend/src/config.ts';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const posix = process.platform !== 'win32';
const PROCESS_YAML = (tenants, extra = '') => `identity:\n  timezone: "UTC"\nagent:\n  provider: "claude"\n  model: "operator-model"\ntenants:\n  dir: ${JSON.stringify(tenants)}\n  auth: per-tenant\n${extra}`;

const sandboxes = [];
afterEach(() => { for (const s of sandboxes.splice(0)) fs.rmSync(s.sbx, { recursive: true, force: true }); });
function sandbox({ operatorYaml, tenantYaml, tenantEnv } = {}) {
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-links-')));
  const app = path.join(sbx, 'app');
  fs.mkdirSync(path.join(sbx, 'home'), { recursive: true });
  appFixture(fs, path, app);
  const tenants = path.join(app, 'tenants');
  const ada = path.join(tenants, 'ada');
  fs.mkdirSync(path.join(ada, 'home', 'identity'), { recursive: true });
  fs.writeFileSync(path.join(ada, 'home', 'identity', 'profile.md'), 'p\n');
  fs.mkdirSync(path.join(app, 'data', 'identity'), { recursive: true });
  fs.writeFileSync(path.join(app, 'data', 'identity', 'ledger.jsonl'), '{"line":1}\n');
  fs.writeFileSync(path.join(app, '.env'), 'APP_PASSWORD=operator-pw\nANTHROPIC_API_KEY=sk-operator\n');
  fs.writeFileSync(path.join(app, 'other.yaml'), 'hosts: [stolen.example.net]\n');
  fs.mkdirSync(path.join(sbx, 'elsewhere'));
  fs.writeFileSync(path.join(app, 'sanctum.yaml'), operatorYaml ?? PROCESS_YAML(tenants));
  fs.writeFileSync(path.join(ada, 'tenant.yaml'), tenantYaml ?? 'hosts: [ada.example.net]\n');
  if (tenantEnv !== undefined) fs.writeFileSync(path.join(ada, '.env'), tenantEnv);
  const s = { sbx, app, tenants, ada, elsewhere: path.join(sbx, 'elsewhere') };
  sandboxes.push(s);
  return s;
}
async function run(s, answers = [], opts = {}) {
  let out = '';
  const queue = [...answers];
  const io = {
    say: (t = '') => { out += `${t}\n`; },
    prompt: async (text) => { out += text; const hit = queue.length && text.includes(queue[0][0]) ? queue.shift()[1] : ''; out += `${hit}\n`; return hit; },
  };
  await runSetup({ root: s.app, io, processEnv: opts.processEnv ?? {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, tenant: 'ada', ...opts });
  return out;
}
const claude = [['Which one?', '2'], ['Anthropic API key', 'sk-ant-x'], ['App password', 'a-tenant-pass']];
const snapshot = (dir, out = {}) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out[p] = 'dir'; snapshot(p, out); } else if (e.isFile()) out[p] = fs.readFileSync(p).toString('hex'); else out[p] = 'link';
  }
  return out;
};
const tryLink = (target, at, type) => { try { if (type === 'hard') fs.linkSync(target, at); else fs.symlinkSync(target, at, type); return true; } catch { return false; } };
const envOf = (s) => gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: false, discordToggle: null });
const answersFor = (s, over = {}) => { const env = envOf(s); const plan = setupPlan(env.existing, env); const { values } = walkValues(plan, { provider: 'claude', password: 'a-tenant-pass', anthropicKey: '', ...over }); return { plan, answers: { ...buildAnswers(values, plan), ...(over.tenantHost ? { tenantHost: over.tenantHost } : {}) } }; };

/** The ways a tenant's own files stop being its own, in tenant `ada`. */
const CASES = [
  { name: 'tenants/ada/.env -> app/.env', rel: '.env', build: (s) => tryLink(path.join(s.app, '.env'), path.join(s.ada, '.env'), 'file') },
  { name: 'a hardlinked tenants/ada/.env', rel: '.env', posixOnly: true, build: (s) => tryLink(path.join(s.app, '.env'), path.join(s.ada, '.env'), 'hard') },
  { name: 'tenants/ada/tenant.yaml -> app/other.yaml', rel: 'tenant.yaml', build: (s) => { fs.rmSync(path.join(s.ada, 'tenant.yaml')); return tryLink(path.join(s.app, 'other.yaml'), path.join(s.ada, 'tenant.yaml'), 'file'); } },
  { name: 'a hardlinked tenants/ada/tenant.yaml', rel: 'tenant.yaml', posixOnly: true, build: (s) => { fs.rmSync(path.join(s.ada, 'tenant.yaml')); return tryLink(path.join(s.app, 'other.yaml'), path.join(s.ada, 'tenant.yaml'), 'hard'); } },
  { name: 'tenants/ada/data -> app/data', rel: 'data', build: (s) => tryLink(path.join(s.app, 'data'), path.join(s.ada, 'data'), 'junction') },
  { name: 'tenants/ada/private -> <outside>', rel: 'private', build: (s) => tryLink(s.elsewhere, path.join(s.ada, 'private'), 'junction') },
  { name: 'tenants/ada/home -> <outside>', rel: 'home', build: (s) => { fs.rmSync(path.join(s.ada, 'home'), { recursive: true }); return tryLink(s.elsewhere, path.join(s.ada, 'home'), 'junction'); } },
  { name: 'a link three levels deep: tenants/ada/data/a/b/c -> <outside>', rel: 'data/a/b/c', build: (s) => { fs.mkdirSync(path.join(s.ada, 'data', 'a', 'b'), { recursive: true }); return tryLink(s.elsewhere, path.join(s.ada, 'data', 'a', 'b', 'c'), 'junction'); } },
  { name: 'a hardlinked file deep under private/', rel: 'private/x/y/copy', posixOnly: true, build: (s) => { fs.mkdirSync(path.join(s.ada, 'private', 'x', 'y'), { recursive: true }); return tryLink(path.join(s.app, '.env'), path.join(s.ada, 'private', 'x', 'y', 'copy'), 'hard'); } },
  { name: 'a link in the top level of home/', rel: 'home/notes', build: (s) => tryLink(path.join(s.app, 'other.yaml'), path.join(s.ada, 'home', 'notes'), 'file') },
  { name: 'tenants/ada/data/harness -> <outside>', rel: 'data/harness', build: (s) => { fs.mkdirSync(path.join(s.ada, 'data')); return tryLink(s.elsewhere, path.join(s.ada, 'data', 'harness'), 'junction'); } },
];

describe('the scan the wizard runs is the scan boot runs', () => {
  it('is one implementation: the same function behind both names (the per-case parity tests below run it over every case)', () => { expect(tenantFilesProblem).toBe(backendFilesProblem); expect(tenantsDirProblem).toBe(backendDirProblem); });
});

describe.each(CASES)('$name', (c) => {
  const set = () => { const s = sandbox(); return c.build(s) && !(c.posixOnly && !posix) ? s : null; };

  it('parity: the wizard\'s check and the backend\'s say the very same sentence, naming the path relative to the tenant folder', () => {
    const s = set(); if (!s) return;
    const why = tenantFilesProblem(s.ada);
    expect(why).toBe(backendFilesProblem(s.ada));
    expect(why).toContain(`${c.rel} in the tenant folder`);
    expect(why).not.toContain(s.sbx);
    expect(tenantFilesProblem(path.join(sandbox().tenants, 'ada'))).toBe('');
  });

  it('npm run setup -- --tenant ada is refused with that sentence before anything is written; app/.env and app/data are byte-identical', async () => {
    const s = set(); if (!s) return;
    const before = { app: snapshot(s.app), elsewhere: snapshot(s.elsewhere) };
    const why = backendFilesProblem(s.ada);
    await expect(run(s, [['Hostname this tenant', ''], ...claude])).rejects.toThrow(new RegExp(`^${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    expect(snapshot(s.app)).toEqual(before.app);
    expect(snapshot(s.elsewhere)).toEqual(before.elsewhere);
    expect(fs.readFileSync(path.join(s.app, '.env'), 'utf8')).toBe('APP_PASSWORD=operator-pw\nANTHROPIC_API_KEY=sk-operator\n');
  });

  it('applySetup (what /api/setup/apply calls) refuses with the same sentence, code tenant_refused, and writes nothing', () => {
    const s = sandbox();
    const { plan, answers } = answersFor(s); // (the plan is read while the folder is still clean; the link appears before the write)
    if (!(c.build(s) && !(c.posixOnly && !posix))) return;
    const before = snapshot(s.app);
    let err;
    try { applySetup(answers, plan, {}, { writer: 'test', backupConfig: true }); } catch (e) { err = e; }
    expect(err?.code).toBe('tenant_refused');
    expect(err.message).toBe(backendFilesProblem(s.ada));
    expect(snapshot(s.app)).toEqual(before);
  });
});

describe('a link that appears after the checks is refused by the write layer, never written through (item 1 c, round 4)', () => {
  // Round 3 replaced such an entry by rename; round 4 refuses it (the write layer's rule: a link or a second hard link at the target is never replaced silently).
  const race = (make, assertAfter) => () => {
    const s = sandbox();
    const { plan, answers } = answersFor(s);
    let armed = true;
    const check = () => { if (armed) { armed = false; make(s); } return null; }; // runs between the checks and the writes
    let err;
    try { applySetup(answers, plan, {}, { writer: 'test', check }); } catch (e) { if (/EPERM|EACCES/.test(String(e?.code))) return; err = e; }
    expect(err?.code).toBe('tenant_refused');
    expect(err.message).toMatch(/in the tenant folder (is a link|has more than one hard link)/);
    expect(err.message).not.toContain(s.sbx);
    assertAfter(s);
  };
  it('.env -> app/.env: app/.env is byte-identical', race((s) => { if (!tryLink(path.join(s.app, '.env'), path.join(s.ada, '.env'), 'file')) throw Object.assign(new Error('x'), { code: 'EPERM' }); }, (s) => {
    expect(fs.readFileSync(path.join(s.app, '.env'), 'utf8')).toBe('APP_PASSWORD=operator-pw\nANTHROPIC_API_KEY=sk-operator\n');
    expect(fs.lstatSync(path.join(s.ada, '.env')).isSymbolicLink()).toBe(true); // (left as it is: refused, not replaced)
  }));
  it.runIf(posix)('a hardlinked .env: app/.env is byte-identical', race((s) => fs.linkSync(path.join(s.app, '.env'), path.join(s.ada, '.env')), (s) => {
    expect(fs.readFileSync(path.join(s.app, '.env'), 'utf8')).toBe('APP_PASSWORD=operator-pw\nANTHROPIC_API_KEY=sk-operator\n');
  }));
  it.runIf(posix)('a hardlinked tenant.yaml: the other name keeps its bytes', race((s) => { fs.rmSync(path.join(s.ada, 'tenant.yaml')); fs.linkSync(path.join(s.app, 'other.yaml'), path.join(s.ada, 'tenant.yaml')); }, (s) => {
    expect(fs.readFileSync(path.join(s.app, 'other.yaml'), 'utf8')).toBe('hosts: [stolen.example.net]\n');
  }));
  it('a tenant.yaml link: the target keeps its bytes', race((s) => { fs.rmSync(path.join(s.ada, 'tenant.yaml')); if (!tryLink(path.join(s.app, 'other.yaml'), path.join(s.ada, 'tenant.yaml'), 'file')) throw Object.assign(new Error('x'), { code: 'EPERM' }); }, (s) => {
    expect(fs.readFileSync(path.join(s.app, 'other.yaml'), 'utf8')).toBe('hosts: [stolen.example.net]\n');
  }));
  it('no temp file is left behind, and the single-tenant write path is unchanged (the same file, written in place)', () => {
    const s = sandbox({ tenantEnv: 'APP_PASSWORD=old-pass\n' });
    const { plan, answers } = answersFor(s);
    applySetup(answers, plan, {}, { writer: 'test' });
    expect(fs.readdirSync(s.ada).filter((n) => n.includes('.tmp-'))).toEqual([]);
    const root = sandbox();
    const inoBefore = fs.statSync(path.join(root.app, '.env')).ino;
    const env = gatherSetupEnv(root.app, { processEnv: {}, homeDir: path.join(root.sbx, 'home'), codexInstalled: false, discordToggle: null });
    const p2 = setupPlan(env.existing, env);
    const w = walkValues(p2, { provider: 'claude', password: 'new-operator-pass', anthropicKey: '' });
    applySetup(buildAnswers(w.values, p2), p2, {}, { writer: 'test' });
    expect(fs.readFileSync(path.join(root.app, '.env'), 'utf8')).toContain('APP_PASSWORD=new-operator-pass');
    if (posix) expect(fs.statSync(path.join(root.app, '.env')).ino).toBe(inoBefore); // (a tenant's is replaced by rename, the process's is written in place as before)
  });
});

describe('tenants.dir that is the app folder (item 9)', () => {
  it('parity: the wizard refuses it with the sentence boot throws, also through a link; its own folder is fine', async () => {
    const s = sandbox();
    expect(tenantsDirProblem(s.app, s.app)).toBe(backendDirProblem(s.app, s.app));
    expect(tenantsDirProblem(s.app, s.app)).toMatch(/is the app folder itself/);
    expect(tenantsDirProblem(s.tenants, s.app)).toBe('');
    expect(backendDirProblem(s.tenants, s.app)).toBe('');
    expect(backendDirProblem(PROJECT_ROOT, PROJECT_ROOT)).toBe(tenantsDirProblem(PROJECT_ROOT, PROJECT_ROOT));
    fs.mkdirSync(path.join(s.app, 'ada'), { recursive: true });
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), PROCESS_YAML(s.app));
    const before = snapshot(s.app);
    await expect(run(s, claude)).rejects.toThrow(backendDirProblem(s.app, s.app));
    expect(snapshot(s.app)).toEqual(before);
    const via = path.join(s.sbx, 'via');
    if (!tryLink(s.app, via, 'junction')) return;
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), PROCESS_YAML(via));
    await expect(run(s, claude)).rejects.toThrow(/is the app folder itself/);
  });
});

describe('Revien addresses (item 4), the wizard against the loader', () => {
  const procOf = (s) => { const file = yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8')); return { file, cfg: processConfigFor(s.app, file) }; };
  it('the shipped default address in the wizard is the backend\'s', () => { expect(DEFAULT_REVIEN_URL).toBe(mergeConfigDefaults({}).revien.url); });

  it('a tenant that enables Revien with no url: the wizard refuses with one sentence, the loader parks Revien with the same words', () => {
    const s = sandbox();
    const why = tenantYamlProblems({ revien: { enabled: true } }, s.ada, 'UTC', { processRevienUrl: DEFAULT_REVIEN_URL });
    expect(why).toHaveLength(1);
    expect(why[0]).toMatch(/needs the tenant's own revien\.url/);
    const { file, cfg } = procOf(s);
    fs.writeFileSync(path.join(s.ada, 'tenant.yaml'), 'hosts: [ada.example.net]\nrevien:\n  enabled: true\n');
    const warned = [];
    const orig = console.warn; console.warn = (...a) => warned.push(a.join(' '));
    try { expect(loadTenantConfig(cfg, s.ada, 'ada', { processFile: file }).config.revien.enabled).toBe(false); } finally { console.warn = orig; }
    expect(warned.filter((w) => w.includes(why[0]))).toHaveLength(1);
  });

  it.each([
    ['the shipped default, as localhost', undefined, 'http://localhost:7437'], ['the shipped default, as 127.1 with a path', undefined, 'http://127.1:7437/v1'],
    ['the operator\'s url, other case and a trailing dot', 'http://daemon.example.net:7437', 'http://DAEMON.example.net.:7437/'],
    ['the operator\'s url with userinfo', 'http://daemon.example.net:7437', 'http://u:p@daemon.example.net:7437'],
  ])('a tenant address equal to the process address (%s) is refused by the wizard and parked by the loader', (_n, operatorUrl, tenantUrl) => {
    const s = sandbox({ operatorYaml: PROCESS_YAML(path.join(path.join(sandbox().sbx, 'x')), operatorUrl ? `revien:\n  url: ${JSON.stringify(operatorUrl)}\n` : '') });
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), PROCESS_YAML(s.tenants, operatorUrl ? `revien:\n  url: ${JSON.stringify(operatorUrl)}\n` : ''));
    const env = envOf(s);
    expect(env.processRevienUrl).toBe(operatorUrl ?? DEFAULT_REVIEN_URL);
    expect(tenantYamlProblems({ revien: { enabled: true, url: tenantUrl } }, s.ada, 'UTC', { processRevienUrl: env.processRevienUrl })).toEqual([expect.stringMatching(/process's own Revien address/)]);
    const plan = setupPlan(env.existing, env);
    const step = plan.find((x) => x.id === 'revienUrl');
    expect(step.validate(tenantUrl)).toMatch(/app's own Revien daemon/);
    expect(step.validate('http://127.0.0.1:7499')).toBe('');
    const { file, cfg } = procOf(s);
    fs.writeFileSync(path.join(s.ada, 'tenant.yaml'), `hosts: [ada.example.net]\nrevien:\n  enabled: true\n  url: ${JSON.stringify(tenantUrl)}\n`);
    const orig = console.warn; console.warn = () => {};
    try { expect(loadTenantConfig(cfg, s.ada, 'ada', { processFile: file }).config.revien.enabled).toBe(false); } finally { console.warn = orig; }
    fs.writeFileSync(path.join(s.ada, 'tenant.yaml'), 'hosts: [ada.example.net]\nrevien:\n  enabled: true\n  url: "http://127.0.0.1:7499"\n');
    expect(loadTenantConfig(cfg, s.ada, 'ada', { processFile: file, quiet: true }).config.revien.enabled).toBe(true);
  });

  it('the terminal asks again when the address is the app\'s own, in any spelling, and writes the one that follows', async () => {
    const s = sandbox();
    const said = await run(s, [['Hostname this tenant', ''], ...claude, ['Which one?', '1'], ['Address of this tenant', 'http://localhost:7437'], ['Address of this tenant', 'http://127.0.0.1:7438']]);
    expect(said).toMatch(/app's own Revien daemon/);
    expect(yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).revien).toEqual({ enabled: true, url: 'http://127.0.0.1:7438' });
  });

  it('the wizard writes a tenant.yaml with a process-address Revien nowhere: applySetup refuses it before writing', () => {
    const s = sandbox({ tenantYaml: 'hosts: [ada.example.net]\nrevien:\n  enabled: true\n  url: "http://localhost:7437"\n' });
    const { plan, answers } = answersFor(s);
    const before = snapshot(s.app);
    expect(() => applySetup(answers, plan, {}, { writer: 'test' })).toThrow(/process's own Revien address/);
    expect(snapshot(s.app)).toEqual(before);
    expect(revienProblems({ revien: { enabled: false, url: 'http://localhost:7437' } })).toEqual([]);
    expect(normaliseRevienAddress('http://localhost:7437')).toBe(normaliseRevienAddress(DEFAULT_REVIEN_URL));
  });
});

describe('a re-run never writes null for a key it shows a default for (item 5)', () => {
  it.each([
    ['an operator agent section', (tenants) => PROCESS_YAML(tenants)], ['no operator agent section', (tenants) => `identity:\n  timezone: "UTC"\ntenants:\n  dir: ${JSON.stringify(tenants)}\n  auth: per-tenant\n`],
  ])('agent: { cwd: ~ } and identity: { timezone: ~ } with %s: the file the wizard writes holds neither, and the tenant loads on its home/', async (_n, operator) => {
    const s = sandbox({ tenantYaml: 'hosts: [ada.example.net]\nagent:\n  cwd: ~\n  model: ~\nidentity:\n  timezone: ~\n' });
    fs.writeFileSync(path.join(s.app, 'sanctum.yaml'), operator(s.tenants));
    await run(s, [['Hostname this tenant', ''], ...claude]);
    const written = yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8'));
    const nulls = [];
    const walk = (o, p) => { for (const [k, v] of Object.entries(o || {})) { if (v === null) nulls.push(`${p}${k}`); else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${p}${k}.`); } };
    walk(written, '');
    const operatorHasModel = /operator-model/.test(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8'));
    // a null over a key the operator's file does not hold says nothing and is not written; one over a held key (agent.model) keeps its meaning
    expect(nulls.sort()).toEqual(operatorHasModel ? ['agent.model'] : []);
    expect(written.agent?.cwd).toBeUndefined();
    expect(written.identity?.timezone).toBeUndefined();
    const file = yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8'));
    const c = loadTenantConfig(processConfigFor(s.app, file), s.ada, 'ada', { processFile: file, quiet: true }).config;
    expect(c.agent.cwd).toBe(path.join(s.ada, 'home'));
    expect(c.identity.timezone).toBe('UTC');
    expect(c.agent.model).toBe(mergeConfigDefaults({}).agent.model);
  });
});

describe('`inherit: false` survives a rewrite (item 6), end to end', () => {
  const operator = (s) => PROCESS_YAML(s.tenants, 'agent_extra: 1\n');
  it('agent: ~ and the wizard writes codex values under agent: the file says `inherit: false` and the tenant still inherits nothing under agent', () => {
    const s = sandbox({ tenantYaml: 'hosts: [ada.example.net]\nagent: ~\n' });
    const { plan, answers } = answersFor(s, { provider: 'codex' });
    applySetup(answers, plan, {}, { writer: 'test' });
    const written = yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8'));
    expect(written.agent).toBeTruthy();
    expect(written.agent.inherit).toBe(false);
    expect(written.agent.provider).toBe('codex');
    const file = yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8'));
    const c = loadTenantConfig(processConfigFor(s.app, file), s.ada, 'ada', { processFile: file, quiet: true }).config;
    expect(c.agent.model).toBe(mergeConfigDefaults({}).agent.model); // not operator-model
    expect(c.agent.provider).toBe('codex');
    expect(JSON.stringify(c)).not.toContain('"inherit"');
    // and once more: the second run keeps the marker
    const again = answersFor(s, { provider: 'codex' });
    applySetup(again.answers, again.plan, {}, { writer: 'test' });
    expect(yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8')).agent.inherit).toBe(false);
    expect(operator(s)).toContain('tenants');
  });
  it('an existing `agent: { inherit: false, provider: claude }` stays a replacement after a rewrite that changes nothing under it', () => {
    const s = sandbox({ tenantYaml: 'hosts: [ada.example.net]\nagent:\n  inherit: false\n  provider: claude\n' });
    const { plan, answers } = answersFor(s);
    applySetup(answers, plan, {}, { writer: 'test' });
    const written = yaml.load(fs.readFileSync(path.join(s.ada, 'tenant.yaml'), 'utf-8'));
    expect(written.agent.inherit).toBe(false);
    const file = yaml.load(fs.readFileSync(path.join(s.app, 'sanctum.yaml'), 'utf-8'));
    expect(loadTenantConfig(processConfigFor(s.app, file), s.ada, 'ada', { processFile: file, quiet: true }).config.agent.model).toBe(mergeConfigDefaults({}).agent.model);
  });
});
