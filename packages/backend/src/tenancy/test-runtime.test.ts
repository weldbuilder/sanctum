// Round 6, item 6 (widened in round 7, item 3): every test that boots tenants boots with the shared safe process fragment and tears the tenants down. A lint-style
// test greps EVERY test file under packages/backend/src and scripts: a file that calls `bootTenants(` must use `safeTenancyProcess(` and `stopBootedTenants(` in the
// same file, a file that opts into `{ fakeProvider: true }` must replace the provider with a fake (vi.mock of providers/index.js), and a file that spawns
// `src/server.ts` in tenant mode must write the equivalent keys into the process yaml (background_runs off, orchestrator off, handoff off, dsh at /bin/false).
// Booting is a scratch server (the standing rule).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_HARNESS, processConfigFor, safeTenancyProcess, safeTenantYaml } from './test-runtime.js';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..');
const scriptsDir = resolve(here, '..', '..', '..', '..', 'scripts');
/** Every *.test.ts / *.test.mjs file under `root` (not node_modules), as absolute paths. */
function testFilesUnder(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...testFilesUnder(p));
    else if (/\.test\.(ts|mjs)$/.test(e.name) && p !== fileURLToPath(import.meta.url)) out.push(p);
  }
  return out;
}
const testFiles = [...testFilesUnder(srcDir), ...testFilesUnder(scriptsDir)];
const text = (f: string) => readFileSync(f, 'utf8');
/** The source with its comments removed (strings and template literals kept as written), and, as `.blanked`, with the insides of strings blanked too, so that a
 *  call is matched only where it is code. A small scanner, not a parser: regex literals that hold quotes are not understood. */
export function codeOf(src: string): { stripped: string; blanked: string } {
  let stripped = '', blanked = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; for (; i < end; i++) if (src[i] === '\n') { stripped += '\n'; blanked += '\n'; } continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && !(c !== '`' && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
      const lit = src.slice(i, j + 1);
      stripped += lit; blanked += c + lit.slice(1, -1).replace(/[^\n]/g, ' ') + c; i = j + 1; continue;
    }
    stripped += c; blanked += c; i++;
  }
  return { stripped, blanked };
}
const shown = (f: string) => relative(resolve(srcDir, '..', '..', '..'), f).split(sep).join('/');

describe('safeTenancyProcess', () => {
  it('turns the orchestrator, background runs and handoff off, points dsh at /bin/false and drops channel tokens from the environment', () => {
    process.env.DISCORD_BOT_TOKEN = 'x'; process.env.TELEGRAM_BOT_TOKEN = 'y';
    const cfg = processConfigFor(resolve(here, 'nowhere'), { orchestrator: { enabled: true }, handoff: { enabled: true } });
    (cfg as unknown as { tenants: unknown }).tenants = { dir: 'somewhere', background_runs: true };
    safeTenancyProcess(cfg);
    expect(cfg.orchestrator.enabled).toBe(false);
    expect(cfg.handoff.enabled).toBe(false);
    expect(cfg.agent.dsh.command).toBe(NO_HARNESS);
    expect((cfg as unknown as { tenants: Record<string, unknown> }).tenants).toEqual({ dir: 'somewhere', background_runs: false, auth: 'per-tenant' });
    expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
  it('{ fakeProvider: true } leaves the orchestrator and background runs as the test set them (dsh still /bin/false)', () => {
    const cfg = processConfigFor(resolve(here, 'nowhere'), { orchestrator: { enabled: true } });
    safeTenancyProcess(cfg, { fakeProvider: true });
    expect(cfg.orchestrator.enabled).toBe(true);
    expect(cfg.agent.dsh.command).toBe(NO_HARNESS);
  });
});

describe('every tenancy test that boots tenants uses the shared fragment and teardown', () => {
  const booting = testFiles.filter((f) => codeOf(text(f)).blanked.includes('bootTenants('));
  it('there are booting tests to check, and the scan reaches outside tenancy/ and scripts/', () => {
    expect(booting.length).toBeGreaterThan(20);
    expect(testFiles.some((f) => shown(f).startsWith('scripts/'))).toBe(true);
    expect(testFiles.some((f) => shown(f).startsWith('packages/backend/src/') && !shown(f).startsWith('packages/backend/src/tenancy/'))).toBe(true);
  });
  for (const f of booting) {
    it(`${shown(f)}: bootTenants( goes with safeTenancyProcess( and stopBootedTenants( in the same file`, () => {
      const s = text(f);
      expect(s, `${shown(f)} boots without safeTenancyProcess`).toContain('safeTenancyProcess(');
      expect(s, `${shown(f)} boots without stopBootedTenants in its teardown`).toContain('stopBootedTenants(');
      // Every bootTenants call passes through the fragment.
      for (const line of codeOf(s).blanked.split('\n')) if (line.includes('bootTenants(')) expect(line, `${shown(f)}: ${line.trim()}`).toContain('safeTenancyProcess(');
    });
  }
  for (const f of booting) {
    it(`${shown(f)}: every tenant.yaml it writes goes through safeTenantYaml( or names agent.dsh.command (tenants do not inherit the dsh binary)`, () => {
      const code = codeOf(text(f)).stripped;
      for (const line of code.split('\n')) {
        if (!/writeFileSync\(/.test(line) || !/['"`]tenant\.yaml['"`]/.test(line)) continue;
        expect(/safeTenantYaml\(|dsh/.test(line), `${shown(f)}: ${line.trim()}`).toBe(true);
      }
    });
  }
  it('a test that keeps the orchestrator or background runs on (fakeProvider) replaces the provider with a fake', () => {
    for (const f of booting) {
      const s = text(f);
      if (s.includes('fakeProvider: true')) expect(s, shown(f)).toMatch(/vi\.mock\('\.\.\/services\/providers\/index\.js'/);
    }
  });
  it('the shared channel kit boots with the fragment too', () => {
    expect(readFileSync(join(here, 'fake-channels.ts'), 'utf8')).toContain('bootTenants(app, safeTenancyProcess(proc))');
  });
});

describe('every test that spawns src/server.ts in tenant mode writes the safe keys into the process yaml', () => {
  /** A string that ends in server.ts or server.js, in any path form ('src/server.ts', '../server.js', join('src', 'server.ts'), a Windows separator). */
const SPAWNS_SERVER = /['"`][^'"`\n]*server\.(?:ts|js)['"`]/;
const spawning = testFiles.filter((f) => SPAWNS_SERVER.test(codeOf(text(f)).stripped));
  it('server-boot.test.ts is one of them', () => { expect(spawning.map(shown)).toContain('packages/backend/src/server-boot.test.ts'); });
  for (const f of spawning) {
    const s = codeOf(text(f)).stripped;
    if (!/['"`]tenants:['"`]/.test(s)) continue; // a single-tenant spawn (the golden): nothing to add
    it(`${shown(f)}: a tenant-mode spawn carries tenants.background_runs: false, orchestrator and handoff off, dsh at /bin/false`, () => {
      expect(s, 'background_runs: false').toContain("'  background_runs: false'");
      expect(s, 'orchestrator off').toMatch(/'orchestrator:',\s*'  enabled: false'/);
      expect(s, 'handoff off').toMatch(/'handoff:',\s*'  enabled: false'/);
      expect(s, 'dsh at /bin/false').toContain("'    command: /bin/false'");
      // Every call that writes a tenants block builds it with the one helper.
      for (const line of s.split('\n')) if (line.includes('startScratch(') && line.includes("'tenants:'")) throw new Error(`${shown(f)}: build the tenants block with safeProcessYaml(): ${line.trim()}`);
      expect(s).toContain('safeProcessYaml(');
    });
  }
  it('the lint itself catches a tenant-mode spawn without the keys, in any path form, and ignores comments and strings', () => {
    for (const p of ["'src/server.ts'", "'../src/server.js'", "join('src', 'server.ts')", '"src\\\\server.ts"', '`./src/server.ts`']) expect(SPAWNS_SERVER.test(p), p).toBe(true);
    expect(SPAWNS_SERVER.test("'src/server.test.ts'")).toBe(false);
    const bad = "spawn(process.execPath, ['src/server.ts']); startScratch(['tenants:', 'dir: x'])";
    expect(SPAWNS_SERVER.test(codeOf(bad).stripped)).toBe(true);
    expect(codeOf(bad).stripped).not.toContain("'  background_runs: false'");
    const src = "// bootTenants(a)\nconst s = 'bootTenants(b)'; /* bootTenants(c) */ const t = `x // not a comment`; run(); // tail";
    expect(codeOf(src).blanked.includes('bootTenants(')).toBe(false);
    expect(codeOf(src).stripped).toContain('x // not a comment');
    expect(codeOf('bootTenants(app, safeTenancyProcess(p));').blanked.includes('bootTenants(')).toBe(true);
  });
  it('safeTenantYaml adds agent.dsh.command to any yaml, keeps what is there, and leaves a broken text alone', () => {
    const parsed = (t: string) => yaml.load(t) as { hosts?: string[]; agent: { dsh: { command: string }; model?: string } };
    expect(parsed(safeTenantYaml()).agent.dsh.command).toBe(NO_HARNESS);
    const mixed = parsed(safeTenantYaml('hosts: [ada.example.net]\nagent:\n  model: m\n'));
    expect(mixed.hosts).toEqual(['ada.example.net']);
    expect(mixed.agent).toEqual({ model: 'm', dsh: { command: NO_HARNESS } });
    expect(parsed(safeTenantYaml('agent:\n  dsh:\n    command: /x/y\n')).agent.dsh.command).toBe('/x/y');
    expect(safeTenantYaml('agent: [unclosed\n')).toBe('agent: [unclosed\n');
  });
});
