// Round 7, item 4: the wizard has ONE rule for "a path a tenant's config names is inside the tenant folder": the backend's (scripts/own-files-lib.mjs). It used to have a
// weaker second copy (insideDir) that let `/proc/self/root<tenant>/home` and `./data/link/../home` through while boot refused them, so the wizard could write a tenant.yaml
// that boot skips. Each case below runs the wizard's check and the backend's over the same path. Links need privileges on Windows: those cases return early.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as inherit from './setup-inherit.mjs';
import * as lib from './own-files-lib.mjs';
import { isInsideDir, pathProblems } from '../packages/backend/src/tenancy/confine.ts';

const posix = process.platform !== 'win32';
const made = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function world() {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-r7-')));
  made.push(top);
  const tenant = path.join(top, 'tenants', 'ada');
  fs.mkdirSync(path.join(tenant, 'home'), { recursive: true });
  fs.mkdirSync(path.join(tenant, 'data'), { recursive: true });
  fs.mkdirSync(path.join(top, 'elsewhere', 'sub'), { recursive: true });
  let linked = true;
  try { fs.symlinkSync(path.join(top, 'elsewhere', 'sub'), path.join(tenant, 'data', 'link'), 'junction'); } catch { linked = false; }
  return { top, tenant, linked };
}
const wizardRefuses = (tenant, p) => inherit.tenantYamlProblems({ agent: { cwd: p } }, tenant, undefined).some((s) => s.startsWith('agent.cwd must be inside'));
const backendRefuses = (tenant, p) => pathProblems({ agent: { cwd: p } }, tenant, { shipped: true }).includes('agent.cwd');

describe('one function behind the wizard and the backend', () => {
  it('the wizard has no insideDir of its own; the lists of path keys are the lib\'s objects', () => {
    expect('insideDir' in inherit).toBe(false);
    expect(typeof lib.isInsideTenantDir).toBe('function');
    expect(typeof lib.namedPathInsideTenant).toBe('function');
    expect(lib.OWNED_PATH_SCALARS).toContain('agent.cwd');
    expect(lib.SHIPPED_PATH_SCALARS).toContain('orchestrator.wake_prompts_dir');
    expect(Object.isFrozen(lib.OWNED_PATH_SCALARS)).toBe(true);
  });
});

describe('the wizard and boot agree, path by path', () => {
  const table = (w) => [
    ['home', true], ['./home', true], ['home/sub/deeper', true], [path.join(w.tenant, 'home'), true], [path.join(w.tenant, 'home', '.'), true],
    [path.join(w.tenant, 'home', '..', 'data'), true],
    ['../ada2/home', false], [path.join(w.top, 'elsewhere'), false], [path.join(w.tenant, '..'), false], [path.join(w.tenant, '..', '..', 'elsewhere'), false],
    ['~', false], ['~/notes', false], ['', true],
    ...(w.linked ? [[path.join(w.tenant, 'data', 'link'), false], [path.join(w.tenant, 'data', 'link', 'x'), false]] : []),
  ];
  it('the existing table: every path gets the same answer from both, and the answer is the expected one', () => {
    const w = world();
    for (const [p, inside] of table(w)) {
      expect(isInsideDir(w.tenant, p), `backend ${p}`).toBe(inside);
      expect(lib.namedPathInsideTenant(w.tenant, p), `lib ${p}`).toBe(inside);
      if (p !== '') { expect(backendRefuses(w.tenant, p), `backend refuses ${p}`).toBe(!inside); expect(wizardRefuses(w.tenant, p), `wizard refuses ${p}`).toBe(!inside); }
    }
  });
  it.runIf(posix && fs.existsSync('/proc/self/root'))('/proc/self/root<tenant>/home: the wizard refuses what boot refuses (it used to pass)', () => {
    const w = world();
    const p = `/proc/self/root${w.tenant}/home`;
    expect(backendRefuses(w.tenant, p)).toBe(true);
    expect(wizardRefuses(w.tenant, p)).toBe(true);
    expect(inherit.tenantYamlProblems({ agent: { cwd: p } }, w.tenant)).toContain('agent.cwd must be inside the tenant folder');
  });
  it('./data/link/../home (a link on the way, then a ..): the wizard refuses what boot refuses (it used to pass)', () => {
    const w = world();
    if (!w.linked) return;
    // posix: the OS follows `link` first, so `..` leaves the tenant: both refuse. Windows resolves `..` lexically (data/link/../home is data/home, inside the
    // tenant): both ACCEPT. Either way the wizard and the backend give the same answer.
    const p = './data/link/../home';
    expect(backendRefuses(w.tenant, p)).toBe(posix);
    expect(wizardRefuses(w.tenant, p)).toBe(posix);
    expect(backendRefuses(w.tenant, `${w.tenant}/data/link/../home`)).toBe(posix);
    expect(wizardRefuses(w.tenant, `${w.tenant}/data/link/../home`)).toBe(posix);
  });
  it('the same holds for the list keys and the tenant .env path keys', () => {
    const w = world();
    if (!w.linked) return;
    const bad = './data/link/../home';
    // (posix refuses a `..` after a link; Windows normalises it lexically to a path inside the tenant, which is accepted: same answer from both sides)
    const has = (list, sentence) => (posix ? expect(list).toContain(sentence) : expect(list).not.toContain(sentence));
    has(inherit.tenantYamlProblems({ hooks: { extra_write_paths: [bad] } }, w.tenant), 'hooks.extra_write_paths must be inside the tenant folder');
    has(pathProblems({ hooks: { extra_write_paths: [bad] } }, w.tenant, { shipped: true }), 'hooks.extra_write_paths');
    const envProblems = inherit.tenantYamlProblems({}, w.tenant, undefined, { envText: `AGENT_CWD=${bad}\n` }).join('\n');
    if (posix) expect(envProblems).toContain('AGENT_CWD in the tenant .env must be inside the tenant folder');
    else expect(envProblems).not.toContain('AGENT_CWD in the tenant .env must be inside the tenant folder');
  });
});
