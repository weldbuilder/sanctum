// npm run doctor (scripts/doctor.mjs): the soak runbook's hand checks, over temp fixtures. Demo names are Echo and Sam.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SHIPPED_PATHS, formatReport, frameResolution, nodeInRange, parseArgs, runDoctor } from './doctor.mjs';

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
  for (const f of ['dsh-base-prompt.md', 'codex-base-prompt.md', 'codex-summarizer-prompt.md', 'companion-claude.md', 'wake.md']) put(path.join(root, 'prompts', f), 'x\n', 0o644);
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
