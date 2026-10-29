// The setup plan reads a tenant's own files (tenant.yaml, .env, the Codex config, .mcp.json) through the guarded open, never a plain read: a pipe at any of
// them is refused with tenant_refused instead of being opened (a plain readFileSync on a pipe holds the event loop for every tenant through GET /api/setup/plan).
// Each pipe has a writer attached, so a wrong open would deliver the writer's bytes and fail the assertion rather than hang. Pipes exist on posix only.
import { afterEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { gatherSetupEnv } from './setup-apply.mjs';
import { tenantPaths } from './setup-inherit.mjs';

const posix = process.platform !== 'win32';
const sandboxes = [];
const children = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const s of sandboxes.splice(0)) fs.rmSync(s.sbx, { recursive: true, force: true });
});
function sandbox() {
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-plan-fifo-')));
  const app = path.join(sbx, 'app');
  appFixture(fs, path, app);
  const tenants = path.join(app, 'tenants');
  const ada = path.join(tenants, 'ada');
  fs.mkdirSync(path.join(ada, 'home', 'identity'), { recursive: true });
  fs.writeFileSync(path.join(ada, 'home', 'identity', 'profile.md'), 'p\n');
  fs.writeFileSync(path.join(app, 'sanctum.yaml'), `identity:\n  timezone: "UTC"\nagent:\n  provider: "claude"\ntenants:\n  dir: ${JSON.stringify(tenants)}\n`);
  fs.writeFileSync(path.join(ada, 'tenant.yaml'), 'hosts: [ada.example.net]\n');
  fs.writeFileSync(path.join(ada, '.env'), 'APP_PASSWORD=tenant-pw\n');
  const t = tenantPaths(ada);
  fs.mkdirSync(t.harness.CODEX_HOME, { recursive: true });
  const s = { sbx, app, ada, t };
  sandboxes.push(s);
  return s;
}
function fifoWithWriter(at, payload) {
  fs.rmSync(at, { force: true });
  execFileSync('mkfifo', [at]);
  children.push(spawn('sh', ['-c', 'printf "%s" "$0" > "$1"', payload, at], { stdio: 'ignore' }));
}
const gather = (s) => gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, codexInstalled: false, discordToggle: null });

describe.runIf(posix)('the setup plan never opens a pipe in the tenant folder', () => {
  const cases = [
    ['tenant.yaml', (s) => path.join(s.ada, 'tenant.yaml'), 'hosts: [evil.example.net]\n'],
    ['.env', (s) => path.join(s.ada, '.env'), 'APP_PASSWORD=evil\n'],
    ['the Codex config', (s) => path.join(s.t.harness.CODEX_HOME, 'config.toml'), 'model = "evil"\n'],
    ['.mcp.json', (s) => s.t.mcpJsonPath, '{"mcpServers":{}}'],
  ];
  it.each(cases)('a pipe at %s with a writer attached: refused, the writer\'s bytes never reach the plan', (_name, at, payload) => {
    const s = sandbox();
    expect(() => gather(s)).not.toThrow(); // (a clean folder gathers)
    fifoWithWriter(at(s), payload);
    let err;
    try { const env = gather(s); err = new Error(`gathered: ${JSON.stringify([env.tenantYaml, env.envText, env.tomlText, env.mcpJsonText])}`); } catch (e) { err = e; }
    expect(err?.code).toBe('tenant_refused');
    expect(err.message).toMatch(/not a regular file|in the tenant folder/);
    expect(err.message).not.toMatch(/evil/);
  });
  it('a pipe or a link at data/sanctum.db reads as "no database setting", and the gather does not open it', () => {
    const s = sandbox();
    fs.mkdirSync(path.dirname(s.t.dbPath), { recursive: true });
    fifoWithWriter(s.t.dbPath, 'SQLite format 3');
    const env = gatherSetupEnv(s.app, { tenantDir: s.ada, tenantId: 'ada', processEnv: {}, codexInstalled: false });
    expect(env.discordToggle).toBeNull();
  });
});
