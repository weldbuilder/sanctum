// npm run doctor (scripts/doctor.mjs): the soak runbook's hand checks, over temp fixtures. Demo names are Echo and Sam.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AUTH_KEY_IGNORED_LINE } from './setup-lib.mjs';
import { CONSENT_CAPABILITIES, consentSummary, referenceCounts, IMAGEGEN_KEY_ENV, SHIPPED_PATHS, SMALL_TIER, formatReport, frameResolution, nodeInRange, parseArgs, runDoctor, runHeadless } from './doctor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const posix = process.platform !== 'win32';
const put = (file, text, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode }); fs.chmodSync(file, mode); };

/** A companion home: identity/ and the three harness copies in config/. */
function homeFor(home) {
  put(path.join(home, 'identity', 'profile.md'), 'p\n', 0o644);
  for (const f of ['companion-claude.md', 'codex-base-prompt.md', 'dsh-base-prompt.md']) put(path.join(home, 'config', f), 'x\n', 0o644);
}
/** A healthy app folder: package.json with engines, the build stamp, the shipped prompts, a companion home with its harness copies. */
function app(extraYaml = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'doctor-')));
  put(path.join(root, 'package.json'), JSON.stringify({ name: 'x', engines: { node: '>=20.0.0 <25.0.0' } }), 0o644);
  put(path.join(root, 'packages', 'frontend', 'build', '.build-id'), 'abc1234\n', 0o644);
  for (const f of ['dsh-base-prompt.md', 'codex-base-prompt.md', 'codex-summarizer-prompt.md', 'summarizer-own-voice.md', 'companion-claude.md', 'wake.md']) put(path.join(root, 'prompts', f), 'x\n', 0o644);
  fs.mkdirSync(path.join(root, 'prompts', 'wakes'), { recursive: true });
  put(path.join(root, 'CLAUDE.md'), 'x\n', 0o644);
  put(path.join(root, '.mcp.json'), '{}\n', 0o644);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true, mode: 0o700 });
  put(path.join(root, '.env'), 'TZ=UTC\n');
  homeFor(path.join(root, 'home'));
  put(path.join(root, 'sanctum.yaml'), `identity:\n  companion_name: Echo\n  user_name: Sam\n  timezone: UTC\nagent:\n  cwd: ./home\n${extraYaml}`, 0o644);
  return root;
}
/** Adds a tenants: block and the given tenants ({ id, yaml, env, envMode, token }) to `root`. */
function withTenants(root, tenants) {
  fs.appendFileSync(path.join(root, 'sanctum.yaml'), 'tenants:\n  dir: ./tenants\n  auth: per-tenant\n');
  for (const t of tenants) {
    const dir = path.join(root, 'tenants', t.id);
    homeFor(path.join(dir, 'home'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(dir, 'data'), 0o700);
    put(path.join(dir, 'tenant.yaml'), t.yaml ?? `hosts:\n  - ${t.id}.example.net\n`, 0o644);
    put(path.join(dir, '.env'), t.env ?? 'ANTHROPIC_API_KEY=sk-demo-secret-value\n', t.envMode ?? 0o600);
    put(path.join(dir, 'data', '.internal-token'), t.token ?? `${t.id}`.padEnd(64, 'a'));
  }
}
const lines = (report, status) => report.sections.flatMap((s) => s.checks).filter((c) => c.status === status);
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const go = (root, extra = {}) => runDoctor({ root, env: {}, nodeVersion: '22.1.0', ...extra });

describe('doctor: a healthy layout', () => {
  it('a single-tenant install is all OK and exits 0', () => {
    const root = app();
    try {
      const report = go(root);
      expect(lines(report, 'FAIL')).toEqual([]);
      expect(lines(report, 'WARN')).toEqual([]);
      expect(report.exitCode).toBe(0);
      expect(report.sections.map((s) => s.name)).toEqual(['Config', 'Tenants', 'Process']);
      expect(report.counts.OK).toBeGreaterThan(10);
      expect(formatReport(report)).toMatch(/\n {2}OK {4}sanctum\.yaml: /);
    } finally { cleanup(root); }
  });
  it('two healthy tenants are all OK', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada' }, { id: 'bea' }]);
      const report = go(root);
      expect(lines(report, 'FAIL')).toEqual([]);
      expect(lines(report, 'WARN')).toEqual([]);
      expect(report.exitCode).toBe(0);
      expect(report.sections[1].checks.some((c) => c.check === 'tenant ada: boot scan' && c.status === 'OK')).toBe(true);
    } finally { cleanup(root); }
  });
  it('--tenant reports one tenant and still checks the clashes across all', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada' }, { id: 'bea' }]);
      const names = go(root, { tenant: 'bea' }).sections[1].checks.map((c) => c.check);
      expect(names.some((n) => n.startsWith('tenant bea: '))).toBe(true);
      expect(names.some((n) => n.startsWith('tenant ada: '))).toBe(false);
      expect(names).toContain('duplicate hosts');
      expect(go(root, { tenant: 'zed' }).exitCode).toBe(1);
    } finally { cleanup(root); }
  });
});

describe('doctor: what fails', () => {
  it.skipIf(!posix)('a world-readable tenant .env is a FAIL naming the path and mode, and never the key', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada', envMode: 0o644 }]);
      const report = go(root);
      const bad = lines(report, 'FAIL').find((c) => c.check === 'tenant ada: mode .env');
      expect(bad.message).toContain(path.join(root, 'tenants', 'ada', '.env'));
      expect(bad.message).toContain('644');
      expect(report.exitCode).toBe(1);
      expect(JSON.stringify(report)).not.toContain('sk-demo-secret-value');
    } finally { cleanup(root); }
  });
  it('two tenants with one host is a FAIL', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada', yaml: 'hosts:\n  - echo.example.net\n' }, { id: 'bea', yaml: 'hosts:\n  - Echo.Example.net\n' }]);
      const report = go(root);
      const dup = lines(report, 'FAIL').find((c) => c.check === 'duplicate host');
      expect(dup.message).toContain('echo.example.net');
      expect(dup.message).toContain('ada and bea');
      expect(report.exitCode).toBe(1);
    } finally { cleanup(root); }
  });
  it('two tenants with one internal token or one bot token are FAILs that print no token', () => {
    const root = app();
    try {
      const token = 'f'.repeat(64);
      withTenants(root, [{ id: 'ada', token, env: 'DISCORD_BOT_TOKEN=bot-secret-xyz\n' }, { id: 'bea', token, env: 'DISCORD_BOT_TOKEN=bot-secret-xyz\n' }]);
      const report = go(root);
      const failed = lines(report, 'FAIL').map((c) => c.check);
      expect(failed).toContain('duplicate internal token');
      expect(failed).toContain('duplicate discord bot token');
      expect(JSON.stringify(report)).not.toContain(token);
      expect(JSON.stringify(report)).not.toContain('bot-secret-xyz');
    } finally { cleanup(root); }
  });
  it('a never-inherited path key outside the tenant folder is a FAIL', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada', yaml: `hosts:\n  - ada.example.net\nagent:\n  cwd: ${JSON.stringify(path.join(root, 'elsewhere'))}\n` }]);
      const report = go(root);
      expect(lines(report, 'FAIL').find((c) => c.check === 'tenant ada: config' && /agent\.cwd must be inside the tenant folder/.test(c.message))).toBeTruthy();
      expect(report.exitCode).toBe(1);
    } finally { cleanup(root); }
  });
  it('a tenant that sets a process-only key fails; the operator\'s secret-named keys never reach it', () => {
    const root = app('  api_key: nope\n');
    try {
      withTenants(root, [{ id: 'ada', yaml: 'hosts:\n  - ada.example.net\nserver:\n  port: 1\n' }]);
      const report = go(root);
      expect(lines(report, 'FAIL').some((c) => /server: belongs to the process/.test(c.message))).toBe(true);
      expect(report.sections[1].checks.find((c) => c.check === 'tenant ada: never-inherited').status).toBe('OK');
      expect(JSON.stringify(report)).not.toContain('nope');
    } finally { cleanup(root); }
  });
  it('a tenant folder holding a link is a boot-scan FAIL and its hosts are reserved', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada' }]);
      fs.symlinkSync(path.join(root, 'sanctum.yaml'), path.join(root, 'tenants', 'ada', 'data', 'x.txt'));
      const report = go(root);
      expect(lines(report, 'FAIL').some((c) => c.check === 'tenant ada: boot scan')).toBe(true);
      expect(lines(report, 'WARN').some((c) => c.check === 'reserved host' && c.message.includes('ada.example.net'))).toBe(true);
    } finally { cleanup(root); }
  });
  it('a missing home, a missing build folder and an out-of-range node are FAILs; a yaml that does not parse names its path', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada' }]);
      fs.rmSync(path.join(root, 'tenants', 'ada', 'home'), { recursive: true });
      fs.rmSync(path.join(root, 'packages', 'frontend', 'build'), { recursive: true });
      const failed = lines(go(root, { nodeVersion: '18.0.0' }), 'FAIL').map((c) => c.check);
      expect(failed).toEqual(expect.arrayContaining(['tenant ada: home', 'build stamp', 'node']));
      put(path.join(root, 'sanctum.yaml'), 'a: [unclosed\n', 0o644);
      expect(lines(go(root), 'FAIL').some((c) => c.check === 'sanctum.yaml' && c.message.includes(path.join(root, 'sanctum.yaml')))).toBe(true);
    } finally { cleanup(root); }
  });
  it('a configured prompt that does not exist is a FAIL; a missing frame is a WARN; the home copy covers a missing base prompt', () => {
    const root = app('  codex:\n    base_instructions_file: ./prompts/nope.md\norchestrator:\n  wake_prompts_dir: ./prompts/nowhere\n');
    try {
      fs.rmSync(path.join(root, 'home', 'config', 'companion-claude.md'));
      fs.rmSync(path.join(root, 'prompts', 'companion-claude.md'));
      const report = go(root);
      expect(lines(report, 'FAIL').map((c) => c.check)).toContain('orchestrator.wake_prompts_dir');
      expect(lines(report, 'WARN').some((c) => c.check === 'frame' && /claude_code preset/.test(c.message))).toBe(true);
      expect(report.sections[0].checks.find((c) => c.check === 'agent.codex.base_instructions_file').status).toBe('OK');
    } finally { cleanup(root); }
  });
});

describe('doctor: links, refused paths and the build', () => {
  it.skipIf(!posix)('a tenant .env that is a link reports the scan FAIL and no mode line through it', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada' }]);
      const real = path.join(root, 'real.env');
      put(real, 'TZ=UTC\n', 0o644);
      const envPath = path.join(root, 'tenants', 'ada', '.env');
      fs.rmSync(envPath);
      fs.symlinkSync(real, envPath);
      const report = go(root);
      expect(lines(report, 'FAIL').some((c) => c.check === 'tenant ada: boot scan')).toBe(true);
      const modeLine = report.sections[1].checks.find((c) => c.check === 'tenant ada: mode .env');
      expect(modeLine.status).toBe('WARN');
      expect(modeLine.message).toMatch(/not checked.*boot scan/);
      expect(modeLine.message).not.toMatch(/mode 644/);
      expect(lines(report, 'FAIL').some((c) => c.check === 'tenant ada: mode .env')).toBe(false);
    } finally { cleanup(root); }
  });
  it('a refused agent.cwd prints one skipped line and probes nothing outside the folder', () => {
    const root = app();
    try {
      const outside = path.join(root, 'elsewhere');
      fs.mkdirSync(outside);
      withTenants(root, [{ id: 'ada', yaml: `hosts:\n  - ada.example.net\nagent:\n  cwd: ${JSON.stringify(outside)}\n` }]);
      const checks = go(root).sections[1].checks.filter((c) => c.check.startsWith('tenant ada: '));
      expect(checks.find((c) => c.check === 'tenant ada: config').status).toBe('FAIL');
      expect(checks.find((c) => c.check === 'tenant ada: home').message).toBe('skipped: boot would not start this tenant.');
      expect(checks.filter((c) => /home|frame/.test(c.check) && !/skipped/.test(c.message))).toEqual([]);
      expect(checks.some((c) => c.message.includes(outside) && !/^.*config$/.test(c.check))).toBe(false);
      for (const c of checks) expect(c.message).not.toMatch(/\.\.|\.\s*\.$/);
    } finally { cleanup(root); }
  });
  it('a missing build folder is a FAIL; a missing stamp with the build present is a WARN; BUILD_ID in the environment is OK', () => {
    const root = app();
    try {
      const stamp = path.join(root, 'packages', 'frontend', 'build', '.build-id');
      const find = (report) => report.sections[2].checks.find((c) => c.check === 'build stamp');
      fs.rmSync(stamp);
      expect(find(go(root)).status).toBe('WARN');
      expect(find(go(root, { env: { BUILD_ID: 'deploy-42' } })).status).toBe('OK');
      expect(go(root).exitCode).toBe(0);
      fs.rmSync(path.join(root, 'packages', 'frontend', 'build'), { recursive: true });
      expect(find(go(root)).status).toBe('FAIL');
      expect(find(go(root)).message).toMatch(/no UI is served/);
    } finally { cleanup(root); }
  });
  it('frameResolution agrees with the backend resolveFrameFile: the home copy, the configured file, neither', async () => {
    const { resolveFrameFile } = await import('../packages/backend/src/services/frame-file.ts');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'doctor-frame-')));
    try {
      const cwd = path.join(root, 'home');
      const configured = path.join(root, 'prompts', 'companion-claude.md');
      const same = () => expect(frameResolution(cwd, configured)).toEqual(resolveFrameFile(cwd, configured));
      same();
      expect(frameResolution(cwd, configured).source).toBe('none');
      put(configured, 'x\n', 0o644);
      same();
      expect(frameResolution(cwd, configured).source).toBe('configured');
      put(path.join(cwd, 'config', 'companion-claude.md'), 'x\n', 0o644);
      same();
      expect(frameResolution(cwd, configured).source).toBe('home');
    } finally { cleanup(root); }
  });
});

describe('doctor: the command', () => {
  it('--json prints the same report, and the exit code follows the FAILs', () => {
    const root = app();
    try {
      const run = (...args) => spawnSync(process.execPath, [path.join(HERE, 'doctor.mjs'), '--root', root, ...args], { encoding: 'utf-8', env: { ...process.env, TZ: 'UTC' } });
      const ok = run('--json');
      const json = JSON.parse(ok.stdout);
      expect(json).toMatchObject({ ok: true, exitCode: 0, counts: { FAIL: 0 } });
      expect(json.sections.map((s) => s.name)).toEqual(['Config', 'Tenants', 'Process']);
      for (const c of json.sections.flatMap((s) => s.checks)) expect(Object.keys(c).sort()).toEqual(['check', 'message', 'status']);
      expect(ok.status).toBe(0);
      const text = run();
      expect(text.stdout).toMatch(/^Config\n/);
      expect(text.status).toBe(0);
      fs.rmSync(path.join(root, 'packages', 'frontend', 'build'), { recursive: true });
      const bad = run('--json');
      expect(bad.status).toBe(1);
      expect(JSON.parse(bad.stdout).ok).toBe(false);
      expect(run('--tenant', 'Bad Id').status).toBe(2);
    } finally { cleanup(root); }
  });
  it('parses its arguments and the engines range', () => {
    expect(parseArgs(['--tenant', 'ada', '--json'])).toEqual({ json: true, tenant: 'ada' });
    expect(parseArgs(['--tenant=bea'])).toEqual({ json: false, tenant: 'bea' });
    expect(parseArgs(['--nope']).error).toMatch(/Unknown option/);
    expect(nodeInRange('>=20.0.0 <25.0.0', '22.3.1')).toBe(true);
    expect(nodeInRange('>=20.0.0 <25.0.0', '25.0.0')).toBe(false);
    expect(nodeInRange('>=20.0.0 <25.0.0', '19.9.9')).toBe(false);
    expect(nodeInRange('^20', '20.1.0')).toBe(null);
  });
  it('the shipped default paths equal the backend\'s DEFAULTS', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'packages', 'backend', 'src', 'config.ts'), 'utf-8');
    for (const [key, value] of Object.entries(SHIPPED_PATHS)) {
      const leaf = key.split('.').pop();
      expect(src, key).toMatch(new RegExp(`${leaf}: '${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    }
  });
});

describe('doctor: review fixes', () => {
  it('a yaml parse error reports the line and a category, never the value', () => {
    const root = app();
    try {
      fs.appendFileSync(path.join(root, 'sanctum.yaml'), 'auth:\n  password: *super-secret\n');
      const report = go(root);
      const bad = lines(report, 'FAIL').find((c) => c.check === 'sanctum.yaml');
      expect(bad.message).toMatch(/line \d+/);
      const out = formatReport(report) + JSON.stringify(report);
      for (let i = 0; i + 4 <= 'super-secret'.length; i++) for (let n = 4; i + n <= 'super-secret'.length; n++) expect(out).not.toContain('super-secret'.slice(i, i + n));
    } finally { cleanup(root); }
  });
  const block = (extra) => {
    const root = app();
    fs.appendFileSync(path.join(root, 'sanctum.yaml'), `tenants:\n  dir: ./tenants\n${extra}`);
    fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
    return root;
  };
  for (const [name, yaml, field] of [
    ['auth per_tenant', '  auth: per_tenant\n', 'tenants.auth'],
    ['inherit as a string', '  auth: household\n  inherit: "false"\n', 'tenants.inherit'],
    ['default that is not an id', '  auth: household\n  default: Not An Id\n', 'tenants.default'],
    ['background_runs as a string', '  auth: household\n  background_runs: "yes"\n', 'tenants.background_runs'],
  ]) {
    it(`a ${name} is a FAIL naming ${field}, with no household OK line`, () => {
      const root = block(yaml);
      try {
        const report = go(root);
        const bad = lines(report, 'FAIL').find((c) => c.check === 'tenants block');
        expect(bad.message).toContain(field);
        expect(report.sections[1].checks.some((c) => c.check === 'tenants.auth' && c.status === 'OK')).toBe(false);
        expect(report.exitCode).toBe(1);
      } finally { cleanup(root); }
    });
  }
  it('the accepted tenants.auth values match the backend source', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'packages', 'backend', 'src', 'tenancy', 'config.ts'), 'utf-8');
    const m = src.match(/t\.auth !== '([\w-]+)' && t\.auth !== '([\w-]+)'/);
    expect(m && [m[1], m[2]].sort()).toEqual(['household', 'per-tenant']);
    expect(src).toContain("typeof t.inherit !== 'boolean'");
    expect(src).toContain("typeof t.background_runs !== 'boolean'");
  });
  it('a host listed twice by one tenant is a WARN, not a clash', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada', yaml: 'hosts:\n  - echo.example.net\n  - Echo.Example.net\n' }]);
      const report = go(root);
      expect(lines(report, 'FAIL')).toEqual([]);
      expect(lines(report, 'WARN').some((c) => c.check === 'tenant ada: hosts')).toBe(true);
      expect(report.sections[1].checks.some((c) => c.check === 'duplicate hosts' && c.status === 'OK')).toBe(true);
    } finally { cleanup(root); }
  });
  it('a host shared by two tenants is still a FAIL when one of them lists it twice', () => {
    const root = app();
    try {
      withTenants(root, [{ id: 'ada', yaml: 'hosts:\n  - echo.example.net\n  - echo.example.net\n' }, { id: 'bea', yaml: 'hosts:\n  - echo.example.net\n' }]);
      const dup = lines(go(root), 'FAIL').filter((c) => c.check === 'duplicate host');
      expect(dup).toHaveLength(1);
      expect(dup[0].message).toContain('ada and bea');
    } finally { cleanup(root); }
  });
});

describe('doctor: pictures and summaries', () => {
  const find = (report, check) => report.sections.flatMap((s) => s.checks).filter((c) => c.check === check);

  it('image generation off (nothing set, or "none") is an INFO line pointing at UPGRADE.md, not a warning', () => {
    for (const extra of ['', 'imagegen:\n  provider: none\n']) {
      const root = app();
      try {
        if (extra) fs.appendFileSync(path.join(root, 'sanctum.yaml'), extra);
        const report = go(root);
        const [c] = find(report, 'imagegen');
        expect(c.status).toBe('INFO');
        expect(c.message).toBe('image generation off; see UPGRADE.md, "Pictures and companion-voiced summaries".');
        expect(lines(report, 'WARN')).toEqual([]);
        expect(report.exitCode).toBe(0);
        expect(report.counts.INFO).toBe(2); // imagegen, and the always-present permissions line
        expect(formatReport(report)).toMatch(/\n {2}INFO {2}imagegen: image generation off; see UPGRADE\.md/);
      } finally { cleanup(root); }
    }
  });

  it('a provider with its key is OK (the key from .env or the environment); the key is never printed', () => {
    for (const [provider, keyVar] of Object.entries(IMAGEGEN_KEY_ENV)) {
      const root = app(`imagegen:\n  provider: ${provider}\n`);
      try {
        put(path.join(root, '.env'), `TZ=UTC\n${keyVar}=sk-demo-secret-key\n`);
        const report = go(root);
        expect(find(report, 'imagegen')[0]).toMatchObject({ status: 'OK', message: `image generation is on (${provider}) and ${keyVar} is set.` });
        expect(JSON.stringify(report)).not.toContain('sk-demo-secret-key');
      } finally { cleanup(root); }
    }
  });

  it('a provider with no key is a WARN naming the variable', () => {
    for (const [provider, keyVar] of Object.entries(IMAGEGEN_KEY_ENV)) {
      const root = app(`imagegen:\n  provider: ${provider}\n`);
      try {
        const [c] = find(go(root), 'imagegen');
        expect(c.status).toBe('WARN');
        expect(c.message).toContain(keyVar);
        expect(find(go(root, { env: { [keyVar]: 'k' } }), 'imagegen')[0].status).toBe('OK');
      } finally { cleanup(root); }
    }
  });

  describe('references', () => {
    const seed = (root, rows) => {
      const Database = createRequire(import.meta.url)('better-sqlite3');
      const db = new Database(path.join(root, 'data', 'sanctum.db'));
      db.exec('CREATE TABLE "references" (id TEXT PRIMARY KEY, name TEXT, file_id TEXT, self INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT \'\', created_at TEXT)');
      rows.forEach(([name, self], i) => db.prepare('INSERT INTO "references" (id, name, file_id, self, created_at) VALUES (?, ?, ?, ?, ?)').run(`id${i}`, name, `f${i}`, self, 'now'));
      db.close();
    };
    const refLine = (report) => report.sections.flatMap((s) => s.checks).filter((c) => c.check === 'references');

    it('counts what the library holds, and how many are the companion\'s', () => {
      const root = app('imagegen:\n  provider: runware\n');
      try {
        seed(root, [['Echo', 1], ['Sam', 0], ['Lake house', 0]]);
        expect(referenceCounts(path.join(root, 'data', 'sanctum.db'))).toEqual({ total: 3, self: 1 });
        const [c] = refLine(go(root));
        expect(c).toMatchObject({ status: 'INFO', message: 'References: 3 (1 marked as the companion).' });
      } finally { cleanup(root); }
    });

    it('pictures on with an empty or missing library: an INFO line of zero, never a warning', () => {
      const root = app('imagegen:\n  provider: replicate\n');
      try {
        const report = go(root, { env: { REPLICATE_API_TOKEN: 'k' } });
        expect(refLine(report)[0]).toMatchObject({ status: 'INFO', message: 'References: 0 (0 marked as the companion).' });
        expect(lines(report, 'WARN')).toEqual([]);
      } finally { cleanup(root); }
    });

    it('pictures off and nothing in the library: no line at all; a library with entries still shows', () => {
      const root = app();
      try {
        expect(refLine(go(root))).toEqual([]);
        seed(root, [['Sam', 0]]);
        expect(refLine(go(root))[0].message).toBe('References: 1 (0 marked as the companion).');
      } finally { cleanup(root); }
    });
  });

  it('an unknown provider is a WARN', () => {
    const root = app('imagegen:\n  provider: dalle\n');
    try { expect(find(go(root), 'imagegen')[0]).toMatchObject({ status: 'WARN' }); } finally { cleanup(root); }
  });

  it('the summarizer on the chat model is OK, with no small-tier line', () => {
    const root = app();
    try {
      const report = go(root);
      expect(find(report, 'summarizer')[0].status).toBe('OK');
      expect(find(report, 'summarizer model')).toEqual([]);
    } finally { cleanup(root); }
  });

  it('openai-compat with a model, a base_url and its key is OK', () => {
    const root = app('  summarizer:\n    provider: openai-compat\n    model: deepseek/deepseek-chat\n    base_url: https://openrouter.ai/api/v1\n');
    try {
      const report = go(root, { env: { SUMMARIZER_API_KEY: 'sk-x' } });
      expect(find(report, 'summarizer')[0].status).toBe('OK');
      expect(find(report, 'summarizer model')).toEqual([]);
    } finally { cleanup(root); }
  });

  it('openai-compat missing the model, the base_url or the key is a WARN naming each one', () => {
    const root = app('  summarizer:\n    provider: openai-compat\n');
    try {
      const [c] = find(go(root), 'summarizer');
      expect(c.status).toBe('WARN');
      expect(c.message).toContain('agent.summarizer.model');
      expect(c.message).toContain('agent.summarizer.base_url');
      expect(c.message).toContain('SUMMARIZER_API_KEY');
      expect(c.message).toContain('every summary fails until they are set');
      expect(c.message).not.toContain('falls back');
    } finally { cleanup(root); }
    const named = app('  summarizer:\n    provider: openai-compat\n    model: big\n    base_url: https://x.test/v1\n    api_key_env: MY_SUM_KEY\n');
    try {
      const [c] = find(go(named, { env: { SUMMARIZER_API_KEY: 'unused' } }), 'summarizer');
      expect(c.status).toBe('WARN');
      expect(c.message).toContain('MY_SUM_KEY');
      expect(c.message).not.toContain('agent.summarizer.model');
    } finally { cleanup(named); }
  });

  it('the deprecated rolling.model_provider is a provider only when it names a harness; otherwise it is a route', () => {
    const route = app('  rolling:\n    model_provider: deepseek\n    model: m1\n');
    try {
      const [c] = find(go(route), 'summarizer');
      expect(c.message).toContain('route "deepseek"');
    } finally { cleanup(route); }
    const harness = app('  rolling:\n    model_provider: codex\n');
    try {
      const [c] = find(go(harness), 'summarizer');
      expect(c.message).toContain('run on codex');
    } finally { cleanup(harness); }
  });

  it('a small-tier summarizer model is a WARN; gemini is not small', () => {
    for (const [model, small] of [['claude-haiku-4-5', true], ['gpt-5-mini', true], ['llama-3-8b', true], ['google/gemini-2.5-pro', false], ['deepseek/deepseek-chat', false]]) {
      const root = app(`  summarizer:\n    provider: openai-compat\n    model: ${model}\n    base_url: https://x.test/v1\n`);
      try {
        const got = find(go(root, { env: { SUMMARIZER_API_KEY: 'k' } }), 'summarizer model');
        expect(got.length, model).toBe(small ? 1 : 0);
        if (small) expect(got[0].status).toBe('WARN');
      } finally { cleanup(root); }
    }
  });

  it('the small-tier regex is the backend\'s (services/summarizer/config.ts)', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'packages', 'backend', 'src', 'services', 'summarizer', 'config.ts'), 'utf-8');
    const m = /export const SMALL_TIER = (\/.+\/[a-z]*);/.exec(src);
    expect(m, 'SMALL_TIER in config.ts').toBeTruthy();
    expect(String(SMALL_TIER)).toBe(m[1]);
  });

  it('the image key variables are the backend\'s (services/imagegen/index.ts)', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'packages', 'backend', 'src', 'services', 'imagegen', 'index.ts'), 'utf-8');
    for (const [p, v] of Object.entries(IMAGEGEN_KEY_ENV)) expect(src).toContain(`${p}: '${v}'`);
  });
});

describe('doctor: permissions (the consent gate)', () => {
  const find = (report, check) => report.sections.flatMap((s) => s.checks).filter((c) => c.check === check);

  it('one INFO line, always: Open mode with nothing off, and the local-model sentence', () => {
    const root = app();
    try {
      const report = go(root);
      const [c] = find(report, 'permissions');
      expect(find(report, 'permissions')).toHaveLength(1);
      expect(c.status).toBe('INFO');
      expect(c.message).toMatch(/^Open mode; nothing is off\. These switches are code and hold for any model; a model run locally has no provider rails, so the rails are yours\./);
      expect(c.message).toContain('Permissions and the consent gate');
      expect(report.exitCode).toBe(0);
    } finally { cleanup(root); }
  });

  it('reads the database: Guard mode, a switch-off, a window that ended', async () => {
    const root = app();
    try {
      const { default: Database } = await import('better-sqlite3');
      const dbPath = path.join(root, 'data', 'sanctum.db');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const set = db.prepare('INSERT INTO config (key, value) VALUES (?, ?)');
      set.run('consent.grants', JSON.stringify([
        { capability: 'shell', effect: 'off', grant_id: 'a', granted_at: '2026-11-01T00:00:00Z', expires_at: null },
        { capability: 'web', effect: 'on', grant_id: 'b', granted_at: '2026-11-01T00:00:00Z', expires_at: '2026-11-01T01:00:00Z' },
        { capability: 'voice_out', effect: 'on', grant_id: 'c', granted_at: '2026-11-01T00:00:00Z', expires_at: '2999-01-01T00:00:00Z' },
      ]));
      db.close();
      expect(consentSummary(dbPath)).toEqual({ mode: 'open', off: ['shell', 'web'] });
      expect(find(go(root), 'permissions')[0].message).toMatch(/^Open mode; off: shell, web\./);
      const db2 = new Database(dbPath);
      db2.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('consent.mode', 'guard');
      db2.close();
      const guard = consentSummary(dbPath);
      expect(guard.mode).toBe('guard');
      expect(guard.off).not.toContain('voice_out'); // granted
      expect(guard.off).toContain('app_write');
      expect(find(go(root), 'permissions')[0].message).toMatch(/^Guard mode is on: everything is off until granted \(off now: app_write, shell, /);
    } finally { cleanup(root); }
  });

  it('a missing or unreadable database is the default, not an error; the PIN and its hash are never read', () => {
    expect(consentSummary('/nonexistent/sanctum.db')).toEqual({ mode: 'open', off: [] });
    const src = fs.readFileSync(path.join(HERE, 'doctor.mjs'), 'utf8');
    expect(src).not.toMatch(/pin_hash|pin_lock/);
  });

  it('the capability list is the backend\'s (services/consent/gate.ts CAPABILITIES)', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'packages', 'backend', 'src', 'services', 'consent', 'gate.ts'), 'utf8');
    const body = /export const CAPABILITIES = \[([\s\S]*?)\] as const;/.exec(src)[1];
    expect([...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...CONSENT_CAPABILITIES]);
  });
});

describe('doctor: a key the auth mode ignores', () => {
  const require = createRequire(import.meta.url);
  const withMode = (mode, envText) => {
    const root = app();
    const Database = require('better-sqlite3');
    const db = new Database(path.join(root, 'data', 'sanctum.db'));
    db.exec("CREATE TABLE auth_preferences (id INTEGER PRIMARY KEY, auth_mode TEXT NOT NULL, api_key TEXT, updated_at TEXT)");
    db.prepare('INSERT INTO auth_preferences (id, auth_mode, updated_at) VALUES (1, ?, ?)').run(mode, 'x');
    db.close();
    put(path.join(root, '.env'), envText);
    return root;
  };
  const authWarns = (root) => lines(go(root), 'WARN').filter((c) => c.check === 'auth mode');
  it('WARN with the boot sentence only when a key is set and the mode is subscription', () => {
    const roots = [withMode('subscription', 'ANTHROPIC_API_KEY=sk-demo-key\n'), withMode('api_key', 'ANTHROPIC_API_KEY=sk-demo-key\n'), withMode('subscription', 'TZ=UTC\n'), app()];
    try {
      const [mismatch, apiKey, noKey, noDb] = roots.map(authWarns);
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0].message).toBe(`${AUTH_KEY_IGNORED_LINE}.`);
      expect(JSON.stringify(mismatch)).not.toContain('sk-demo-key');
      expect(apiKey).toEqual([]);
      expect(noKey).toEqual([]);
      expect(noDb).toEqual([]);
    } finally { roots.forEach(cleanup); }
  });
});

// ── --headless: the Service section, every branch through injected probes (no real system is touched) ──────────────────────────────────

/** Fake probes. `cmds` maps "cmd arg arg" to { status, stdout } (a command not listed "is not installed"); `urls` maps a URL to a status or an Error; `files` maps a path to its text. */
function fake({ cmds = {}, urls = {}, files = {}, free = 50 * 1024 ** 3, uid = 1000, envUid, writable = true } = {}) {
  return {
    exec: (cmd, args) => { const hit = cmds[[cmd, ...args].join(' ')]; return hit ? { status: 0, stderr: '', stdout: '', ...hit } : { error: 'ENOENT', status: null, stdout: '', stderr: '' }; },
    fetch: async (url) => { const r = urls[url]; if (r === undefined || r instanceof Error) throw r ?? new Error('connection refused'); return { ok: r >= 200 && r < 300, status: r }; },
    fs: {
      exists: (p) => p in files || fs.existsSync(p),
      readFile: (p) => { if (p in files) return files[p]; throw new Error('EACCES'); },
      stat: (p) => (p.endsWith('.env') && envUid !== undefined ? { uid: envUid } : fs.statSync(p)),
      access: (p, m) => { if (!writable) throw new Error('EACCES'); fs.accessSync(p, m); },
      freeBytes: () => free,
    },
    uid: uid === null ? undefined : uid,
  };
}
const TS_RUNNING = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'echo-box.tail1234.ts.net.' } });
const tsOn = (servePort = 3099) => ({
  'tailscale status --json': { stdout: TS_RUNNING },
  'tailscale serve status': { stdout: `https://echo-box.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:${servePort}\n` },
});
const ACTIVE = { 'systemctl is-active sanctum': { stdout: 'active\n' } };
const HEALTH = { 'http://127.0.0.1:3099/api/health': 200 };
const service = async (root, probes, extra = {}) => {
  const report = await runHeadless({ root, env: {}, nodeVersion: '22.1.0', probes, ...extra });
  return { report, svc: Object.fromEntries(report.sections.find((x) => x.name === 'Service').checks.map((c) => [c.check, c])) };
};
const ORIGIN_YAML = 'cors:\n  origins:\n    - "https://echo-box.tail1234.ts.net"\n';

describe('doctor --headless: the Service section', () => {
  it('a healthy Tailscale box is all OK or INFO, and the section comes last', async () => {
    const root = app(ORIGIN_YAML);
    try {
      const { report, svc } = await service(root, fake({ cmds: { ...ACTIVE, ...tsOn() }, urls: HEALTH, envUid: 1000 }));
      expect(report.sections.map((x) => x.name)).toEqual(['Config', 'Tenants', 'Process', 'Service']);
      expect(svc.service.status).toBe('OK');
      expect(svc.port.status).toBe('OK');
      expect(svc.tailscale.status).toBe('INFO');
      expect(svc.tailscale.message).toContain('echo-box.tail1234.ts.net');
      expect(svc.tailscale.message).toContain('lists port 3099');
      expect(svc.https.status).toBe('OK');
      expect(svc.bind.status).toBe('OK');
      expect(svc.origin).toMatchObject({ status: 'OK', message: expect.stringContaining('https://echo-box.tail1234.ts.net') });
      expect(svc.disk.status).toBe('OK');
      expect(svc.home.status).toBe('OK');
      expect(svc['.env owner'].status).toBe('OK');
      expect(lines(report, 'FAIL')).toEqual([]);
      expect(lines(report, 'WARN')).toEqual([]);
      expect(report.exitCode).toBe(0);
      expect(formatReport(report)).toContain('\nService\n  OK    service: sanctum.service is active.');
    } finally { cleanup(root); }
  });
  it('the unit: systemctl missing is INFO, inactive is FAIL, absent is WARN', async () => {
    const root = app();
    try {
      expect((await service(root, fake())).svc.service.status).toBe('INFO');
      const down = (await service(root, fake({ cmds: { 'systemctl is-active sanctum': { status: 3, stdout: 'failed\n' }, 'systemctl cat sanctum.service': { stdout: '[Unit]' } } }))).svc.service;
      expect(down.status).toBe('FAIL');
      expect(down.message).toContain('failed');
      expect((await service(root, fake({ cmds: { 'systemctl is-active sanctum': { status: 4, stdout: 'inactive\n' }, 'systemctl cat sanctum.service': { status: 1 } } }))).svc.service.status).toBe('WARN');
    } finally { cleanup(root); }
  });
  it('the port: active but silent is FAIL (exit 1), silent and not active is WARN, and PORT / HOST are honoured', async () => {
    const root = app();
    try {
      const silent = await service(root, fake({ cmds: ACTIVE }));
      expect(silent.svc.port.status).toBe('FAIL');
      expect(silent.report.exitCode).toBe(1);
      expect((await service(root, fake())).svc.port.status).toBe('WARN');
      const moved = await service(root, fake({ urls: { 'http://127.0.0.1:4100/api/health': 200 } }), { env: { PORT: '4100' } });
      expect(moved.svc.port.status).toBe('OK');
      const wide = await service(root, fake({ urls: HEALTH }), { env: { HOST: '0.0.0.0' } });
      expect(wide.svc.port.status).toBe('OK');
      expect((await service(root, fake({ urls: { 'http://127.0.0.1:3099/api/health': 503 } }))).svc.port.status).toBe('WARN');
    } finally { cleanup(root); }
  });
  it('Tailscale: signed out is INFO and fronts nothing; serve without the port is INFO and WARNs about HTTPS', async () => {
    const root = app();
    try {
      const out = await service(root, fake({ cmds: { 'tailscale status --json': { stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) } } }));
      expect(out.svc.tailscale.message).toMatch(/not signed in/);
      expect(out.svc.https.status).toBe('WARN');
      const other = await service(root, fake({ cmds: tsOn(8080) }));
      expect(other.svc.tailscale.message).toContain('does not list port 3099');
      expect(other.svc.https.status).toBe('WARN');
      expect(other.svc.https.message).toMatch(/cookie will not be Secure/);
    } finally { cleanup(root); }
  });
  it('Caddy: a Caddyfile that proxies the port fronts it; one that does not, does not', async () => {
    const root = app('cors:\n  origins:\n    - "https://sanctum.example.org"\n');
    try {
      const good = await service(root, fake({ urls: HEALTH, files: { '/etc/caddy/Caddyfile': '# managed\nsanctum.example.org {\n\treverse_proxy 127.0.0.1:3099\n}\n' } }));
      expect(good.svc.caddy.message).toContain('proxies sanctum.example.org to port 3099');
      expect(good.svc.https.status).toBe('OK');
      expect(good.svc.origin).toMatchObject({ status: 'OK', message: expect.stringContaining('https://sanctum.example.org') });
      const wrong = await service(root, fake({ files: { '/etc/caddy/Caddyfile': 'sanctum.example.org {\n\treverse_proxy 127.0.0.1:9000\n}\n' } }));
      expect(wrong.svc.caddy.message).toMatch(/does not mention port 3099/);
      expect(wrong.svc.https.status).toBe('WARN');
      expect(wrong.svc.origin).toBeUndefined();
    } finally { cleanup(root); }
  });
  it('the origin: a fronting address missing from cors.origins is a WARN that names it', async () => {
    const root = app();
    try {
      const { svc } = await service(root, fake({ cmds: tsOn() }));
      expect(svc.origin.status).toBe('WARN');
      expect(svc.origin.message).toContain('https://echo-box.tail1234.ts.net');
      expect(svc.origin.message).toMatch(/phone is refused/);
    } finally { cleanup(root); }
  });
  it('the bind address: loopback behind a proxy is OK, wide behind a proxy is WARN, and with no proxy it is an INFO that names it', async () => {
    const root = app(ORIGIN_YAML);
    try {
      expect((await service(root, fake({ cmds: tsOn() }))).svc.bind.status).toBe('OK');
      const wide = await service(root, fake({ cmds: tsOn() }), { env: { HOST: '0.0.0.0' } });
      expect(wide.svc.bind.status).toBe('WARN');
      const none = await service(root, fake(), { env: { HOST: '0.0.0.0' } });
      expect(none.svc.bind).toMatchObject({ status: 'INFO', message: expect.stringContaining('bound to 0.0.0.0; make sure something in front does TLS') });
    } finally { cleanup(root); }
  });
  it('a container: no systemctl, and no proxy in sight is INFO, not WARN', async () => {
    const root = app();
    try {
      const { svc } = await service(root, fake({ files: { '/.dockerenv': '' } }), { env: { HOST: '0.0.0.0' } });
      expect(svc.service.status).toBe('INFO');
      expect(svc.https.status).toBe('INFO');
      expect(svc.https.message).toMatch(/container/);
    } finally { cleanup(root); }
  });
  it('disk: under 1 GB is a WARN, a failed read is a WARN, plenty is OK', async () => {
    const root = app();
    try {
      expect((await service(root, fake({ free: 0.5 * 1024 ** 3 }))).svc.disk.message).toMatch(/0\.5 GB free .*under 1 GB/);
      expect((await service(root, fake({ free: 0.5 * 1024 ** 3 }))).svc.disk.status).toBe('WARN');
      expect((await service(root, fake({ free: 2 * 1024 ** 3 }))).svc.disk.status).toBe('OK');
      const bad = fake();
      bad.fs.freeBytes = () => { throw new Error('statfs failed'); };
      expect((await service(root, bad)).svc.disk.status).toBe('WARN');
    } finally { cleanup(root); }
  });
  it('the home must be writable by the user running doctor, and exist', async () => {
    const root = app();
    try {
      expect((await service(root, fake({ writable: false }))).svc.home.status).toBe('FAIL');
      fs.rmSync(path.join(root, 'home'), { recursive: true });
      expect((await service(root, fake())).svc.home.status).toBe('WARN');
    } finally { cleanup(root); }
  });
  it('.env must belong to the user running doctor, and a missing .env or an unknown uid skips the line', async () => {
    const root = app();
    try {
      const other = (await service(root, fake({ envUid: 0, uid: 1000 }))).svc['.env owner'];
      expect(other.status).toBe('WARN');
      expect(other.message).toMatch(/owned by uid 0, but this runs as uid 1000/);
      expect((await service(root, fake({ uid: null }))).svc['.env owner']).toBeUndefined();
      fs.rmSync(path.join(root, '.env'));
      expect((await service(root, fake({ envUid: 0 }))).svc['.env owner']).toBeUndefined();
    } finally { cleanup(root); }
  });
  it('prints no secret, and the real probes are used for any probe not replaced', async () => {
    const root = app();
    try {
      fs.writeFileSync(path.join(root, '.env'), 'TZ=UTC\nAPP_PASSWORD=hunter2-demo\n', { mode: 0o600 });
      const { report } = await service(root, fake({ cmds: tsOn() }));
      expect(JSON.stringify(report)).not.toContain('hunter2-demo');
      const r = await runHeadless({ root, env: {}, nodeVersion: '22.1.0', probes: { exec: () => ({ error: 'ENOENT' }), fetch: async () => { throw new Error('refused'); } } });
      expect(r.sections.at(-1).name).toBe('Service');
    } finally { cleanup(root); }
  });
});

describe('doctor --headless: the command line, and the output without it', () => {
  it('parses the flag, keeps --json, and sets nothing when it is absent', () => {
    expect(parseArgs(['--headless'])).toEqual({ json: false, headless: true });
    expect(parseArgs(['--headless', '--json', '--root', '/x'])).toEqual({ json: true, headless: true, root: '/x' });
    expect(parseArgs(['--json'])).toEqual({ json: true });
    expect(parseArgs(['--nope']).error).toContain('[--headless]');
  });
  it('without --headless there is no Service section, and the command prints the same text as before', () => {
    const root = app();
    try {
      const plain = spawnSync(process.execPath, [path.join(HERE, 'doctor.mjs'), '--root', root], { encoding: 'utf-8', env: { ...process.env, PORT: '', HOST: '' } });
      expect(plain.stdout).not.toMatch(/^Service$/m);
      expect(plain.stdout.split('\n').filter((l) => /^[A-Z][a-z]+$/.test(l))).toEqual(['Config', 'Tenants', 'Process']);
      expect(plain.stdout).toBe(formatReport(go(root, { env: { ...process.env, PORT: '', HOST: '' }, nodeVersion: process.versions.node })) + '\n');
    } finally { cleanup(root); }
  });
  it('the command with --headless --json carries the Service section and exits with the report', () => {
    const root = app();
    try {
      const r = spawnSync(process.execPath, [path.join(HERE, 'doctor.mjs'), '--root', root, '--headless', '--json'], { encoding: 'utf-8' });
      const json = JSON.parse(r.stdout);
      expect(json.sections.map((x) => x.name)).toEqual(['Config', 'Tenants', 'Process', 'Service']);
      expect(r.status).toBe(json.exitCode);
    } finally { cleanup(root); }
  });
});
