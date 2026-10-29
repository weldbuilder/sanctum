// Round 5 (items 1, 4, 6, 7, 9, 10): the tenant file layer decides "inside the tenant" from the REAL path of the deepest existing ancestor, never from how a
// path is spelled. An alias of the tenant folder (/proc/self/root<real>, a path through a second link, a case-only spelling) is still the tenant folder: the
// write layer, every read helper and the scan apply, and a configuration naming such a path is refused at load. A pipe, socket or device is never opened.
// Links need privileges on Windows (cases return early when refused); the pipe cases are posix. No provider, no model run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableTenancy, runInTenant } from './context.js';
import { fakeRuntime, makeTenantsDir, processConfigFor } from './test-runtime.js';
import { isInsideDir } from './confine.js';
import { loadTenantConfig } from './config.js';
import {
  TenantEditRefused, ownAppendFile, ownMkdir, ownReadDir, ownStat, ownUnlink, ownWriteFile, ownWriteFileAsync, readOwn, readOwnText, setShippedReadRootsForTests,
  tenantFilesProblem, writeThreadFile,
} from './own-files.js';

const posix = process.platform !== 'win32';
const made: string[] = [];
interface World { top: string; tenant: string; home: string; outside: string; secret: string }
function world(): World {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'sanctum-alias-')));
  made.push(top);
  const tenant = join(top, 'tenants', 'ada');
  const home = join(tenant, 'home');
  const outside = join(top, 'outside');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(outside, 'dir'), { recursive: true });
  mkdirSync(join(tenant, 'data'), { recursive: true });
  writeFileSync(join(outside, 'secret'), 'SECRET');
  writeFileSync(join(home, 'src.txt'), 'SRC');
  return { top, tenant, home, outside, secret: join(outside, 'secret') };
}
const tryLink = (target: string, at: string, type: 'file' | 'dir'): boolean => { try { symlinkSync(target, at, type === 'dir' ? 'junction' : 'file'); return true; } catch { return false; } };
const swapCase = (p: string) => p.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

/** The spellings of the tenant folder this machine has. Each returns a path of the SAME folder that does not start with the folder's own spelling. */
function aliases(w: World): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (posix && existsSync('/proc/self/root')) out.push(['/proc/self/root', `/proc/self/root${w.tenant}`]);
  const second = join(w.top, 'second');
  if (tryLink(w.tenant, second, 'dir')) out.push(['a path through a second link', second]);
  const swapped = swapCase(w.tenant);
  if (swapped !== w.tenant && existsSync(swapped) && realpathSync.native(swapped) === w.tenant) out.push(['a case-only spelling', swapped]);
  return out;
}

beforeEach(() => enableTenancy(true));
afterEach(() => { enableTenancy(false); setShippedReadRootsForTests(null); vi.restoreAllMocks(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const inTenant = <T>(w: World, fn: () => T): T => runInTenant(fakeRuntime('ada', { dir: w.tenant, dataDir: join(w.tenant, 'data'), homeDir: w.home }), fn);

describe('item 1: an alias of the tenant folder is the tenant folder (writes, reads, config load)', () => {
  it('this machine has at least one alias spelling to test (a second link at least), or the platform refuses links', () => {
    const w = world();
    const a = aliases(w);
    if (!a.length) expect(tryLink(w.tenant, join(w.top, 'probe'), 'dir')).toBe(false);
  });

  it('writes: a link planted in home/ is refused through every alias; the file outside is byte-identical; a plain write through the alias lands in the tenant', () => {
    const w = world();
    expect(tryLink(w.secret, join(w.home, 'evil'), 'file') || !posix).toBe(true);
    const linked = tryLink(w.secret, join(w.home, 'evil'), 'file');
    const dirLinked = tryLink(join(w.outside, 'dir'), join(w.home, 'dirlink'), 'dir');
    for (const [name, a] of aliases(w)) {
      if (linked) {
        expect(() => inTenant(w, () => ownWriteFile(join(a, 'home', 'evil'), 'X')), name).toThrow(TenantEditRefused);
        expect(() => inTenant(w, () => ownAppendFile(join(a, 'home', 'evil'), 'X')), name).toThrow(TenantEditRefused);
        expect(() => inTenant(w, () => ownUnlink(join(a, 'home', 'evil'))), name).toThrow(TenantEditRefused);
        expect(() => inTenant(w, () => writeThreadFile(join(a, 'home'), 'T')), name).not.toThrow();
      }
      if (dirLinked) {
        expect(() => inTenant(w, () => ownWriteFile(join(a, 'home', 'dirlink', 'f'), 'X')), name).toThrow(TenantEditRefused);
        expect(() => inTenant(w, () => ownMkdir(join(a, 'home', 'dirlink', 'sub'))), name).toThrow(TenantEditRefused);
      }
      expect(readFileSync(w.secret, 'utf8'), name).toBe('SECRET');
      expect(readdirSync(join(w.outside, 'dir')), name).toEqual([]);
      inTenant(w, () => ownWriteFile(join(a, 'home', `ok-${readdirSync(w.home).length}.txt`), 'OK'));
      expect(readdirSync(w.home).some((n) => n.startsWith('ok-'))).toBe(true);
    }
  });

  it('writeThreadFile (the S1 repro): a .sanctum-thread link planted in the home is refused through an alias cwd, and the target is not written', () => {
    const w = world();
    if (!tryLink(w.secret, join(w.home, '.sanctum-thread'), 'file')) return;
    expect(inTenant(w, () => writeThreadFile(w.home, 'T'))).toBe('refused'); // (the plain spelling, as before)
    for (const [name, a] of aliases(w)) {
      expect(inTenant(w, () => writeThreadFile(join(a, 'home'), 'THREAD-ID')), name).toBe('refused');
      expect(readFileSync(w.secret, 'utf8'), name).toBe('SECRET');
    }
  });

  it('writeFile async and the append flag: refused through an alias too', async () => {
    const w = world();
    if (!tryLink(w.secret, join(w.home, 'evil'), 'file')) return;
    for (const [name, a] of aliases(w)) {
      await expect(inTenant(w, () => ownWriteFileAsync(join(a, 'home', 'evil'), 'X')), name).rejects.toBeInstanceOf(TenantEditRefused);
      expect(readFileSync(w.secret, 'utf8'), name).toBe('SECRET');
    }
  });

  it('reads: a link planted in home/ is refused through every alias (no bytes); a real file is read through the alias', () => {
    const w = world();
    const linked = tryLink(w.secret, join(w.home, 'evil'), 'file');
    const dirLinked = tryLink(w.outside, join(w.home, 'outdir'), 'dir');
    for (const [name, a] of aliases(w)) {
      expect(inTenant(w, () => readOwnText(join(a, 'home', 'src.txt'))), name).toBe('SRC');
      if (linked) expect(() => inTenant(w, () => readOwn(join(a, 'home', 'evil'))), name).toThrow(TenantEditRefused);
      if (dirLinked) {
        expect(() => inTenant(w, () => readOwn(join(a, 'home', 'outdir', 'secret'))), name).toThrow(TenantEditRefused);
        expect(() => inTenant(w, () => ownReadDir(join(a, 'home', 'outdir'))), name).toThrow(TenantEditRefused);
        expect(() => inTenant(w, () => ownStat(join(a, 'home', 'outdir', 'secret'))), name).toThrow(TenantEditRefused);
      }
    }
  });

  it('a `..` that a link carries out of the tenant is judged by the operating system, not by the text: refused', () => {
    const w = world();
    if (!tryLink(join(w.outside, 'dir'), join(w.home, 'dirlink'), 'dir')) return;
    writeFileSync(join(w.outside, 'sibling'), 'SIBLING');
    // <home>/dirlink/../sibling is <outside>/sibling to the OS (the link is followed first), though its text normalises to <home>/sibling.
    const spelled = `${w.home}${posix ? '/' : '\\'}dirlink${posix ? '/' : '\\'}..${posix ? '/' : '\\'}sibling`;
    if (posix) expect(() => inTenant(w, () => readOwn(spelled))).toThrow(TenantEditRefused);
    // Windows resolves `..` lexically (dirlink\..\sibling is home\sibling, a plain path inside the tenant that does not exist): ENOENT, and the outside file is never read.
    else expect(() => inTenant(w, () => readOwn(spelled))).toThrow(/ENOENT|no such file/);
  });

  it('config load: isInsideDir and a tenant.yaml naming an alias path are refused, not accepted', () => {
    const w = world();
    // On Windows case is not an alias: path.relative is case-insensitive, so a case-only spelling of an existing path IS the same path and is accepted.
    const sameOnThisPlatform = (name: string) => name === 'a case-only spelling' && process.platform === 'win32';
    for (const [name, a] of aliases(w)) {
      expect(isInsideDir(w.tenant, join(a, 'home')), name).toBe(sameOnThisPlatform(name));
      expect(isInsideDir(w.tenant, join(a, 'home', 'not-yet', 'there')), name).toBe(sameOnThisPlatform(name));
    }
    expect(isInsideDir(w.tenant, join(w.home, 'not-yet'))).toBe(true);
    expect(isInsideDir(w.tenant, 'home')).toBe(true);
    for (const [name, a] of aliases(w)) {
      if (name === 'a case-only spelling' && process.platform === 'win32') continue; // (the same path on Windows: not refused)
      for (const [key, yamlText] of [['agent.cwd', `agent:\n  cwd: ${JSON.stringify(join(a, 'home'))}\n`], ['identity.ledger_dir', `identity:\n  ledger_dir: ${JSON.stringify(join(a, 'data', 'identity'))}\n`]]) {
        const root = makeTenantsDir({ ada: { yaml: yamlText } });
        made.push(root);
        expect(() => loadTenantConfig(processConfigFor(resolve(tmpdir(), 'sanctum-process')), join(root, 'ada'), 'ada'), `${name} ${key}`).toThrow(new RegExp(key.replace('.', '\\.')));
      }
    }
  });
});

describe('item 2 (layer): reads fail closed outside the tenant folder', () => {
  it('a path outside the folder is refused by readOwn, ownAssertReadable users, readOwnText, ownReadDir and ownStat; nothing outside is read', () => {
    const w = world();
    expect(() => inTenant(w, () => readOwn(w.secret))).toThrow(TenantEditRefused);
    expect(() => inTenant(w, () => readOwnText(w.secret))).toThrow(/outside the tenant folder/);
    expect(() => inTenant(w, () => ownReadDir(w.outside))).toThrow(TenantEditRefused);
    expect(() => inTenant(w, () => ownStat(w.secret))).toThrow(TenantEditRefused);
    expect(() => inTenant(w, () => readOwn(join(w.tenant, '..', 'outside', 'secret')))).toThrow(TenantEditRefused);
    expect(inTenant(w, () => readOwn(join(w.home, 'src.txt'))).toString()).toBe('SRC');
  });
  it('`{ shipped: true }` allows only the shipped roots; the app .env next to them stays refused', () => {
    const w = world();
    const shipped = join(w.top, 'shipped');
    mkdirSync(shipped);
    writeFileSync(join(shipped, 'plugin.json'), 'SHIPPED');
    setShippedReadRootsForTests([shipped]);
    expect(inTenant(w, () => readOwn(join(shipped, 'plugin.json'), { shipped: true })).toString()).toBe('SHIPPED');
    expect(() => inTenant(w, () => readOwn(join(shipped, 'plugin.json')))).toThrow(TenantEditRefused); // (no allowance asked for)
    expect(() => inTenant(w, () => readOwn(w.secret, { shipped: true }))).toThrow(TenantEditRefused);
    expect(() => inTenant(w, () => readOwn(join(shipped, '..', 'outside', 'secret'), { shipped: true }))).toThrow(TenantEditRefused);
  });
  it('tenancy off: every helper is the plain call', () => {
    const w = world();
    enableTenancy(false);
    expect(readOwn(w.secret).toString()).toBe('SECRET');
    expect(readOwnText(w.secret)).toBe('SECRET');
  });
});

describe.runIf(posix)('item 4: a pipe is never opened', () => {
  it('a FIFO at data/logs/tenant.log: ownAppendFile refuses without blocking (a reader that would unblock it is started and never needed)', async () => {
    const w = world();
    mkdirSync(join(w.tenant, 'data', 'logs'), { recursive: true });
    const fifo = join(w.tenant, 'data', 'logs', 'tenant.log');
    execFileSync('mkfifo', [fifo]);
    // A reader opens the pipe so that, were the layer to open it for writing, the open would return and the write would reach `cat`.
    const reader = spawn('cat', [fifo], { stdio: ['ignore', 'pipe', 'ignore'] });
    let got = '';
    reader.stdout.on('data', (d) => { got += String(d); });
    try {
      expect(() => inTenant(w, () => ownAppendFile(fifo, 'LINE\n'))).toThrow(/not a regular file or folder/);
      expect(() => inTenant(w, () => ownWriteFile(fifo, 'LINE\n'))).toThrow(TenantEditRefused);
      expect(() => inTenant(w, () => readOwn(fifo))).toThrow(TenantEditRefused);
      expect(got).toBe('');
    } finally { reader.kill('SIGKILL'); }
  });
  it('the scan flags a FIFO under data/ (and in home/, and the quick net sees one at the first level)', () => {
    const w = world();
    expect(tenantFilesProblem(w.tenant)).toBe('');
    mkdirSync(join(w.tenant, 'data', 'deep'), { recursive: true });
    execFileSync('mkfifo', [join(w.tenant, 'data', 'deep', 'p')]);
    expect(tenantFilesProblem(w.tenant)).toBe("data/deep/p in the tenant folder is not a regular file or folder (a pipe, socket or device); a tenant's own files and folders must be real ones inside its folder.");
    rmSync(join(w.tenant, 'data', 'deep', 'p'));
    execFileSync('mkfifo', [join(w.home, 'notes')]);
    expect(tenantFilesProblem(w.tenant)).toMatch(/^home\/notes in the tenant folder is not a regular file/);
    rmSync(join(w.home, 'notes'));
    execFileSync('mkfifo', [join(w.tenant, 'data', 'top')]);
    expect(tenantFilesProblem(w.tenant, { quick: true })).toMatch(/^data\/top in the tenant folder is not a regular file/);
  });
});

describe('item 6: the scan never refuses on count', () => {
  it('25,000 entries under data/digests: a tenant loads, and one line says how many were looked at', () => {
    const w = world();
    const dir = join(w.tenant, 'data', 'digests');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 25000; i += 1) writeFileSync(join(dir, `d${i}.md`), '');
    const lines: string[] = [];
    expect(tenantFilesProblem(w.tenant, { log: (l) => lines.push(l) })).toBe('');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/looked at 2\d{4} entries/);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = join(w.top, 'tenants');
    expect(() => loadTenantConfig(processConfigFor(resolve(tmpdir(), 'sanctum-process')), join(root, 'ada'), 'ada')).not.toThrow();
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => /looked at \d+ entries/.test(l))).toHaveLength(1);
  }, 60000);
  it('below the threshold nothing is logged', () => {
    const w = world();
    const lines: string[] = [];
    expect(tenantFilesProblem(w.tenant, { log: (l) => lines.push(l) })).toBe('');
    expect(lines).toEqual([]);
  });
});

describe('item 7: the wake prompts folder is scanned', () => {
  it('a link in <tenant>/prompts/wakes (the folder tenant.yaml names) refuses the tenant at load, naming the file; a clean folder loads', () => {
    const root = makeTenantsDir({ ada: { yaml: 'orchestrator:\n  wake_prompts_dir: prompts/wakes\n' } });
    made.push(root);
    const dir = join(root, 'ada', 'prompts', 'wakes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'morning.md'), 'Good morning');
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    expect(() => loadTenantConfig(proc, join(root, 'ada'), 'ada')).not.toThrow();
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'SECRET');
    if (!tryLink(secret, join(dir, 'evening.md'), 'file')) return;
    expect(() => loadTenantConfig(proc, join(root, 'ada'), 'ada')).toThrow(/prompts\/wakes\/evening\.md in the tenant folder is a link/);
  });
  it('a hard link and a pipe in that folder are refused too', () => {
    const root = makeTenantsDir({ ada: { yaml: 'orchestrator:\n  wake_prompts_dir: prompts/wakes\n' } });
    made.push(root);
    const dir = join(root, 'ada', 'prompts', 'wakes');
    mkdirSync(dir, { recursive: true });
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'SECRET');
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    if (posix) {
      linkSync(secret, join(dir, 'midday.md'));
      expect(() => loadTenantConfig(proc, join(root, 'ada'), 'ada')).toThrow(/prompts\/wakes\/midday\.md in the tenant folder has more than one hard link/);
      rmSync(join(dir, 'midday.md'));
      execFileSync('mkfifo', [join(dir, 'night.md')]);
      expect(() => loadTenantConfig(proc, join(root, 'ada'), 'ada')).toThrow(/prompts\/wakes\/night\.md in the tenant folder is not a regular file/);
    }
  });
});

describe('items 9 and 10: the append flag appends; ownMkdir returns what mkdirSync returns', () => {
  it('ownWriteFile and ownWriteFileAsync with flag "a" append inside a tenant (never replace)', async () => {
    const w = world();
    const f = join(w.home, 'log.txt');
    inTenant(w, () => { ownWriteFile(f, 'one\n', { flag: 'a' }); ownWriteFile(f, 'two\n', { flag: 'a' }); });
    expect(readFileSync(f, 'utf8')).toBe('one\ntwo\n');
    await inTenant(w, async () => { await ownWriteFileAsync(f, 'three\n', { flag: 'a' }); });
    expect(readFileSync(f, 'utf8')).toBe('one\ntwo\nthree\n');
    inTenant(w, () => ownWriteFile(f, 'fresh\n')); // (the default flag still replaces)
    expect(readFileSync(f, 'utf8')).toBe('fresh\n');
  });
  it('ownMkdir returns the first folder created for a recursive mkdir (and undefined when it existed), as mkdirSync does', () => {
    const w = world();
    const first = join(w.home, 'a');
    // (node answers a recursive mkdir's first folder in the namespaced `\\\\?\\C:\\...` spelling on Windows: compare like with like, without the prefix)
    const plainSpelling = (p: string | undefined) => (typeof p === 'string' ? p.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '') : p);
    expect(plainSpelling(inTenant(w, () => ownMkdir(join(first, 'b', 'c'), { recursive: true })))).toBe(first);
    expect(inTenant(w, () => ownMkdir(join(first, 'b', 'c'), { recursive: true }))).toBeUndefined();
    enableTenancy(false);
    expect(plainSpelling(ownMkdir(join(w.home, 'x', 'y'), { recursive: true }))).toBe(join(w.home, 'x'));
  });
});
