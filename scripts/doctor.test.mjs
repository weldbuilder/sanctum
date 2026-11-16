// npm run doctor (scripts/doctor.mjs): the soak runbook's hand checks, over temp fixtures. Demo names are Echo and Sam.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CONSENT_CAPABILITIES, consentSummary, IMAGEGEN_KEY_ENV, SHIPPED_PATHS, SMALL_TIER, formatReport, frameResolution, nodeInRange, parseArgs, runDoctor } from './doctor.mjs';

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
