// M2 (round 4): the wizard's and /api/setup/apply's own writes into a tenant folder go through the tenant file layer: Codex's config.toml and its .bak, .mcp.json
// and its .bak, the identity baseline copy. A link that appears after the checks, at the file, at a backup name or at a folder on the way, is refused and the file outside
// the tenant folder is byte-identical. Links need privileges on Windows: those cases return early when the platform refuses them. No provider, no model run.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { applySetup, backupFile, gatherSetupEnv } from './setup-apply.mjs';
import { buildAnswers, setupPlan, walkValues } from './setup-plan.mjs';
import { ambientTenantDir, ownWriteFile, withAmbientTenant } from './own-files-lib.mjs';
import { writeIdentityBaseline } from './setup-lib.mjs';

const posix = process.platform !== 'win32';
const sandboxes = [];
afterEach(() => { for (const s of sandboxes.splice(0)) fs.rmSync(s.sbx, { recursive: true, force: true }); });
function sandbox({ noHome = false, tenantYaml } = {}) {
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-own-')));
  const app = path.join(sbx, 'app');
  fs.mkdirSync(path.join(sbx, 'home'), { recursive: true });
  appFixture(fs, path, app);
  const tenants = path.join(app, 'tenants');
  const ada = path.join(tenants, 'ada');
  fs.mkdirSync(ada, { recursive: true });
  if (!noHome) { fs.mkdirSync(path.join(ada, 'home', 'identity'), { recursive: true }); fs.writeFileSync(path.join(ada, 'home', 'identity', 'profile.md'), 'p\n'); }
  fs.mkdirSync(path.join(sbx, 'outside'));
  fs.writeFileSync(path.join(sbx, 'outside', 'secret'), 'SECRET');
  fs.writeFileSync(path.join(app, 'sanctum.yaml'), `identity:\n  timezone: "UTC"\nagent:\n  provider: "codex"\ntenants:\n  dir: ${JSON.stringify(tenants)}\n`);
  fs.writeFileSync(path.join(ada, 'tenant.yaml'), tenantYaml ?? 'hosts: [ada.example.net]\n');
  const s = { sbx, app, tenants, ada, outside: path.join(sbx, 'outside'), secret: path.join(sbx, 'outside', 'secret') };
  sandboxes.push(s);
  return s;
}
const snap = (dir, out = {}) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out[p] = 'dir'; snap(p, out); } else if (e.isFile()) out[p] = fs.readFileSync(p).toString('hex'); else out[p] = 'link';
  }
  return out;
};
const tryLink = (target, at, type) => { try { if (type === 'hard') fs.linkSync(target, at); else fs.symlinkSync(target, at, type); return true; } catch { return false; } };
const envOf = (s) => gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, homeDir: path.join(s.sbx, 'home'), codexInstalled: true, discordToggle: null });
const CODEX = { provider: 'codex', password: 'a-tenant-pass', addProvider: true, providerId: 'local', providerBaseUrl: 'http://127.0.0.1:1234', providerName: 'Local', providerModel: 'm' };
function prepare(s, over = {}) {
  const env = envOf(s);
  const plan = setupPlan(env.existing, env);
  const { values } = walkValues(plan, { ...CODEX, ...over });
  return { env, plan, answers: buildAnswers(values, plan) };
}
/** applySetup with `make` run once between the up-front checks and the first write. */
function raced(s, make, over) {
  const { plan, answers } = prepare(s, over);
  let armed = true;
  const check = () => { if (armed) { armed = false; make(s, plan.env); } return null; };
  let err; let result;
  try { result = applySetup(answers, plan, {}, { writer: 'test', check, now: () => '2026-01-01T00:00:00Z', backupConfig: true }); } catch (e) { err = e; }
  return { err, result, plan };
}
const expectRefused = (err, s) => {
  expect(err?.code).toBe('tenant_refused');
  expect(err.message).toMatch(/in the tenant folder (is a link|has more than one hard link)/);
  expect(err.message).not.toContain(s.sbx);
};

describe('Codex config.toml and its .bak (data/harness/codex)', () => {
  it('a link at config.toml: not backed up through, not written through; the target is byte-identical', () => {
    const s = sandbox();
    const before = snap(s.outside);
    let planted = true;
    const { err } = raced(s, (_s, env) => { fs.mkdirSync(env.codexHome, { recursive: true }); planted = tryLink(s.secret, env.tomlPath, 'file'); });
    if (!planted) return;
    expectRefused(err, s);
    expect(snap(s.outside)).toEqual(before);
  });
  it('a dangling link at config.toml (nothing there yet): the write is refused and nothing is created behind it', () => {
    const s = sandbox();
    const target = path.join(s.outside, 'created-by-attacker');
    let planted = true;
    const { err } = raced(s, (_s, env) => { fs.mkdirSync(env.codexHome, { recursive: true }); planted = tryLink(target, env.tomlPath, 'file'); });
    if (!planted) return;
    expectRefused(err, s);
    expect(fs.existsSync(target)).toBe(false);
  });
  it('a link at the .bak name: the backup is refused and the target behind it is byte-identical', () => {
    const s = sandbox();
    let planted = true;
    const { err } = raced(s, (_s, env) => {
      fs.mkdirSync(env.codexHome, { recursive: true });
      fs.writeFileSync(env.tomlPath, 'model = "x"\n');
      planted = tryLink(s.secret, `${env.tomlPath}.bak-2026-01-01T00-00-00Z`, 'file');
    });
    if (!planted) return;
    expectRefused(err, s);
    expect(fs.readFileSync(s.secret, 'utf8')).toBe('SECRET');
  });
  it('a link at the folder on the way (data/harness/codex): refused, nothing created in the folder behind it', () => {
    const s = sandbox();
    const before = snap(s.outside);
    let planted = true;
    const { err } = raced(s, (_s, env) => { fs.mkdirSync(path.dirname(env.codexHome), { recursive: true }); planted = tryLink(s.outside, env.codexHome, 'junction'); });
    if (!planted) return;
    expectRefused(err, s);
    expect(snap(s.outside)).toEqual(before);
  });
  it('a clean tenant still gets its config.toml, written by temp-and-rename, and no temp file is left', () => {
    const s = sandbox();
    const { err, plan } = raced(s, () => {});
    expect(err).toBeUndefined();
    expect(fs.readFileSync(plan.env.tomlPath, 'utf8')).toContain('[model_providers.local]');
    expect(fs.readdirSync(path.dirname(plan.env.tomlPath)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('.mcp.json and its .bak', () => {
  const browser = 'hosts: [ada.example.net]\nintegrations:\n  browser_url: "http://browser.example.net:6080"\n';
  const runWith = (make) => { const s = sandbox({ tenantYaml: browser }); return { s, ...raced(s, make, { browserEntry: true }) }; };
  it('a dangling link at .mcp.json: the write is refused and nothing is created behind it', () => {
    let planted = true; let target = '';
    const { err, s } = runWith((s2) => { target = path.join(s2.outside, 'mcp-created'); planted = tryLink(target, path.join(s2.ada, '.mcp.json'), 'file'); });
    if (!planted) return;
    expectRefused(err, s);
    expect(fs.existsSync(target)).toBe(false);
  });
  it('a link at .mcp.json that holds a file: no backup through it, no write through it', () => {
    let planted = true;
    const { err, s } = runWith((s2) => { planted = tryLink(s2.secret, path.join(s2.ada, '.mcp.json'), 'file'); });
    if (!planted) return;
    expectRefused(err, s);
    expect(fs.readFileSync(s.secret, 'utf8')).toBe('SECRET');
  });
});

describe('the identity baseline copy (data/identity: journal.jsonl, snapshots/, ledger.json)', () => {
  it('a link at data/identity planted after the checks: the baseline is not written behind it, and the wizard says the ledger was not written', () => {
    const s = sandbox({ noHome: true });
    const before = snap(s.outside);
    let planted = true;
    const { err, result } = raced(s, (_s, env) => { fs.mkdirSync(path.join(s.ada, 'data'), { recursive: true }); planted = tryLink(s.outside, path.join(s.ada, 'data', 'identity'), 'junction'); }, { homeCreate: true });
    if (!planted) return;
    if (err) expectRefused(err, s);
    else expect(result.notes.join(' ')).toMatch(/identity ledger was not written/);
    expect(snap(s.outside)).toEqual(before);
  });
  it('writeIdentityBaseline with a dangling link at ledger.json: refused, nothing created behind it', () => {
    const s = sandbox();
    const ledgerDir = path.join(s.ada, 'data', 'identity');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const target = path.join(s.outside, 'ledger-created');
    if (!tryLink(target, path.join(ledgerDir, 'ledger.json'), 'file')) return;
    const r = withAmbientTenant(s.ada, () => writeIdentityBaseline(s.app, path.join(s.ada, 'home'), { ledgerDir }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/in the tenant folder is a link/);
    expect(fs.existsSync(target)).toBe(false);
  });
  it('writeIdentityBaseline with a link at snapshots/: nothing is staged behind it', () => {
    const s = sandbox();
    const ledgerDir = path.join(s.ada, 'data', 'identity');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const before = snap(s.outside);
    if (!tryLink(s.outside, path.join(ledgerDir, 'snapshots'), 'junction')) return;
    const r = withAmbientTenant(s.ada, () => writeIdentityBaseline(s.app, path.join(s.ada, 'home'), { ledgerDir }));
    expect(r.ok).toBe(false);
    expect(snap(s.outside)).toEqual(before);
  });
});

describe('the single-tenant wizard is unchanged', () => {
  it('backupFile with no tenant folder is the plain copy (and a link source is copied through, as before)', () => {
    const s = sandbox();
    const file = path.join(s.sbx, 'plain.toml');
    fs.writeFileSync(file, 'x = 1\n');
    const bak = backupFile(file, () => 'T');
    expect(fs.readFileSync(bak, 'utf8')).toBe('x = 1\n');
    if (tryLink(s.secret, path.join(s.sbx, 'lnk'), 'file')) expect(fs.readFileSync(backupFile(path.join(s.sbx, 'lnk'), () => 'T'), 'utf8')).toBe('SECRET');
  });
  it('the ambient tenant folder is restored after a call, also when it throws', () => {
    expect(ambientTenantDir()).toBe('');
    try { withAmbientTenant('/x', () => { throw new Error('boom'); }); } catch { /* expected */ }
    expect(ambientTenantDir()).toBe('');
    expect(posix || true).toBe(true);
    const f = path.join(sandbox().sbx, 'o.txt');
    ownWriteFile('', f, 'plain');
    expect(fs.readFileSync(f, 'utf8')).toBe('plain');
  });
});
