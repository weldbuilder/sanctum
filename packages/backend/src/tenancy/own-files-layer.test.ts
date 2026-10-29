// The tenant file layer (tenancy/own-files.ts over scripts/own-files-lib.mjs), helper by helper. For each write, append, mkdir, chmod, copy, rename and delete,
// inside a tenant folder with tenancy on, four plants: a symlink at the target, a hard link at the target, a link at the parent, and a link at the temp name.
// Each is refused and the file outside the tenant folder is byte-identical afterwards. Tenancy off, and a target outside the folder, are the plain fs call.
// Links need privileges on Windows: those cases return early when the platform refuses them. No provider, no model run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoTenantContext, enableTenancy, runInTenant } from './context.js';
import { fakeRuntime } from './test-runtime.js';
import {
  TenantEditRefused, ownAppendFile, ownChmod, ownCopyFile, ownCp, ownMkdir, ownMkdirAsync, ownRename, ownRenameAsync, ownRm, ownRmAsync, ownUnlink,
  ownWriteFile, ownWriteFileAsync, ownWriteFileAtomic, setTempNameForTest, tenantWriteRefusal,
} from './own-files.js';

const posix = process.platform !== 'win32';
const made: string[] = [];
interface World { top: string; tenant: string; home: string; outside: string; secret: string; src: string; srcDir: string }
function world(): World {
  const top = mkdtempSync(join(tmpdir(), 'sanctum-layer-'));
  made.push(top);
  const tenant = join(top, 'tenants', 'ada');
  const home = join(tenant, 'home');
  const outside = join(top, 'outside');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(outside, 'dir'), { recursive: true });
  writeFileSync(join(outside, 'secret'), 'SECRET');
  writeFileSync(join(outside, 'dir', 'f'), 'SECRET2');
  writeFileSync(join(home, 'src.txt'), 'SRC');
  mkdirSync(join(home, 'srcdir'));
  writeFileSync(join(home, 'srcdir', 'a.txt'), 'A');
  return { top, tenant, home, outside, secret: join(outside, 'secret'), src: join(home, 'src.txt'), srcDir: join(home, 'srcdir') };
}
const snap = (dir: string, out: Record<string, string> = {}): Record<string, string> => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { out[p] = 'dir'; snap(p, out); } else if (e.isFile()) out[p] = readFileSync(p).toString('hex'); else out[p] = 'link';
  }
  return out;
};
const tryLink = (target: string, at: string, type: 'file' | 'dir' | 'hard'): boolean => {
  try { if (type === 'hard') linkSync(target, at); else symlinkSync(target, at, type === 'dir' ? 'junction' : 'file'); return true; } catch { return false; }
};

beforeEach(() => enableTenancy(true));
afterEach(() => { enableTenancy(false); setTempNameForTest(null); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const inTenant = <T>(w: World, fn: () => T): T => runInTenant(fakeRuntime('ada', { dir: w.tenant }), fn);

type Plant = 'symlink' | 'hardlink' | 'parent' | 'temp';
/** One helper: how to call it on `target` (`w.src`, `w.srcDir` are its sources), and which plants apply to it. */
interface Helper { name: string; plants: Plant[]; call: (w: World, target: string) => unknown; dirTarget?: boolean }
const ALL: Plant[] = ['symlink', 'hardlink', 'parent', 'temp'];
const HELPERS: Helper[] = [
  { name: 'ownWriteFile', plants: ALL, call: (_w, t) => ownWriteFile(t, 'NEW') },
  { name: 'ownWriteFile (flag wx)', plants: ['symlink', 'hardlink', 'parent'], call: (_w, t) => ownWriteFile(t, 'NEW', { flag: 'wx' }) },
  { name: 'ownWriteFileAtomic', plants: ALL, call: (_w, t) => ownWriteFileAtomic(t, 'NEW') },
  { name: 'ownAppendFile', plants: ['symlink', 'hardlink', 'parent'], call: (_w, t) => ownAppendFile(t, 'NEW') },
  { name: 'ownMkdir', plants: ['symlink', 'parent'], call: (_w, t) => ownMkdir(t, { recursive: true }), dirTarget: true },
  { name: 'ownChmod', plants: ['symlink', 'parent'], call: (_w, t) => ownChmod(t, 0o777) },
  { name: 'ownCopyFile', plants: ALL, call: (w, t) => ownCopyFile(w.src, t) },
  { name: 'ownCp', plants: ['symlink', 'parent'], call: (w, t) => ownCp(w.srcDir, t, { recursive: true }), dirTarget: true },
  { name: 'ownRename (onto the target)', plants: ['symlink', 'hardlink', 'parent'], call: (w, t) => ownRename(w.src, t) },
  { name: 'ownRename (the target moved)', plants: ['symlink', 'hardlink', 'parent'], call: (w, t) => ownRename(t, join(w.home, 'moved.txt')) },
  { name: 'ownRm', plants: ['symlink', 'hardlink', 'parent'], call: (_w, t) => ownRm(t, { recursive: true, force: true }) },
  { name: 'ownUnlink', plants: ['symlink', 'hardlink', 'parent'], call: (_w, t) => ownUnlink(t) },
  { name: 'ownWriteFileAsync', plants: ALL, call: (_w, t) => ownWriteFileAsync(t, 'NEW') },
  { name: 'ownMkdirAsync', plants: ['symlink', 'parent'], call: (_w, t) => ownMkdirAsync(t, { recursive: true }), dirTarget: true },
  { name: 'ownRenameAsync', plants: ['symlink', 'hardlink', 'parent'], call: (w, t) => ownRenameAsync(w.src, t) },
  { name: 'ownRmAsync', plants: ['symlink', 'hardlink', 'parent'], call: (_w, t) => ownRmAsync(t, { recursive: true, force: true }) },
];

/** Plant `plant` in `w`; returns the target to hand the helper, or null when the platform refuses the link. */
function plantFor(w: World, plant: Plant, dirTarget: boolean): string | null {
  if (plant === 'symlink') {
    const t = join(w.home, 'f');
    return tryLink(dirTarget ? join(w.outside, 'dir') : w.secret, t, dirTarget ? 'dir' : 'file') ? t : null;
  }
  if (plant === 'hardlink') { const t = join(w.home, 'f'); return posix && tryLink(w.secret, t, 'hard') ? t : null; }
  if (plant === 'parent') {
    if (!tryLink(join(w.outside, 'dir'), join(w.home, 'sub'), 'dir')) return null;
    return join(w.home, 'sub', dirTarget ? 'newdir' : 'f');
  }
  const t = join(w.home, 'g.txt');
  const tmp = join(w.home, '.g.txt.planted');
  if (!tryLink(w.secret, tmp, 'file')) return null;
  setTempNameForTest(() => tmp);
  return t;
}

describe.each(HELPERS)('$name', (h) => {
  for (const plant of h.plants) {
    const label = { symlink: 'a symlink at the target', hardlink: 'a hard link at the target', parent: 'a link at the parent', temp: 'a link at the temp name' }[plant];
    it(`refuses ${label}; the file outside the tenant folder is byte-identical`, async () => {
      const w = world();
      const target = plantFor(w, plant, !!h.dirTarget);
      if (!target) return; // the platform refused the link
      const before = snap(w.outside);
      const beforeMode = statSync(w.secret).mode & 0o777;
      let err: unknown;
      try { await inTenant(w, () => h.call(w, target)); } catch (e) { err = e; }
      expect(err, `${h.name} with ${label} must throw`).toBeDefined();
      if (plant !== 'temp') {
        expect(err).toBeInstanceOf(TenantEditRefused);
        const msg = (err as Error).message;
        expect(msg).toMatch(/in the tenant folder (is a link|has more than one hard link)/);
        expect(msg).not.toContain(w.top); // (a path relative to the tenant folder, never an absolute one)
        expect(msg).not.toMatch(/[A-Za-z]:\\|^\//);
      } else expect((err as { code?: string }).code).toBe('EEXIST'); // (opened `wx`: whatever was planted at the temp name is never written through)
      expect(snap(w.outside)).toEqual(before);
      expect(statSync(w.secret).mode & 0o777).toBe(beforeMode);
      expect(existsSync(w.secret)).toBe(true);
    });
  }

  it('does the work on a clean target inside the folder, and leaves no temp file behind', async () => {
    const w = world();
    const target = h.dirTarget ? join(w.home, 'clean-dir') : join(w.home, 'clean.txt');
    if (/Rm|Unlink|moved|Chmod/.test(h.name)) writeFileSync(target, "X"); // (a thing to remove, move or chmod)
    await inTenant(w, () => h.call(w, target));
    expect(readdirSync(w.home).filter((n) => /\.tmp|planted/.test(n))).toEqual([]);
  });
});

describe('the layer is the plain fs call outside tenant mode, and outside the tenant folder', () => {
  it('tenancy off: a write goes through a symlink exactly as fs.writeFileSync does (nothing refused)', () => {
    enableTenancy(false);
    const w = world();
    if (!tryLink(w.secret, join(w.home, 'f'), 'file')) return;
    ownWriteFile(join(w.home, 'f'), 'THROUGH');
    expect(readFileSync(w.secret, 'utf8')).toBe('THROUGH');
    ownAppendFile(join(w.home, 'f'), '+MORE');
    expect(readFileSync(w.secret, 'utf8')).toBe('THROUGH+MORE');
    expect(lstatSync(join(w.home, 'f')).isSymbolicLink()).toBe(true);
  });
  it('tenancy off: errors are fs\'s own (a missing folder is ENOENT, not a refusal)', () => {
    enableTenancy(false);
    const w = world();
    expect(() => ownWriteFile(join(w.home, 'nope', 'f'), 'x')).toThrow(/ENOENT/);
    expect(() => ownUnlink(join(w.home, 'missing'))).toThrow(/ENOENT/);
  });
  it('tenancy on, a target outside the tenant folder: refused (round 6: the default flipped); `{ process: true }` is the explicit allowance', () => {
    const w = world();
    expect(() => inTenant(w, () => ownWriteFile(w.secret, 'OPERATOR WROTE'))).toThrow(/outside the tenant folder/);
    expect(readFileSync(w.secret, 'utf8')).not.toBe('OPERATOR WROTE');
    inTenant(w, () => ownWriteFile(w.secret, 'OPERATOR WROTE', { process: true }));
    expect(readFileSync(w.secret, 'utf8')).toBe('OPERATOR WROTE');
  });
  it('tenancy on, no tenant entered: NoTenantContext, as the reads; `{ process: true }` writes plainly (round 7, item 5)', () => {
    const w = world();
    expect(() => ownWriteFile(join(w.home, 'p.txt'), 'x')).toThrow(NoTenantContext);
    expect(existsSync(join(w.home, 'p.txt'))).toBe(false);
    ownWriteFile(join(w.home, 'p.txt'), 'x', { process: true });
    expect(readFileSync(join(w.home, 'p.txt'), 'utf8')).toBe('x');
  });
});

describe('what a good write looks like in a tenant folder', () => {
  it('an existing file keeps its permissions and gets the new bytes by rename; a new owner-only file is 0600 from the start', () => {
    const w = world();
    inTenant(w, () => {
      ownWriteFile(join(w.home, 'new.env'), 'K=1', { mode: 0o600 });
      ownWriteFile(join(w.home, 'src.txt'), 'CHANGED');
    });
    expect(readFileSync(join(w.home, 'src.txt'), 'utf8')).toBe('CHANGED');
    if (posix) expect(statSync(join(w.home, 'new.env')).mode & 0o777).toBe(0o600);
  });
  it('an append creates the file with the mode given and adds to it', () => {
    const w = world();
    inTenant(w, () => { ownAppendFile(join(w.home, 'j.jsonl'), 'a\n', { mode: 0o600 }); ownAppendFile(join(w.home, 'j.jsonl'), 'b\n', { mode: 0o600 }); });
    expect(readFileSync(join(w.home, 'j.jsonl'), 'utf8')).toBe('a\nb\n');
    if (posix) expect(statSync(join(w.home, 'j.jsonl')).mode & 0o777).toBe(0o600);
  });
  it('ownCp leaves a link in the copied tree out instead of recreating it inside the tenant folder', () => {
    const w = world();
    if (!tryLink(w.secret, join(w.srcDir, 'lnk'), 'file')) return;
    inTenant(w, () => ownCp(w.srcDir, join(w.home, 'copy'), { recursive: true }));
    expect(readdirSync(join(w.home, 'copy'))).toEqual(['a.txt']);
  });
  it('tenantWriteRefusal(target) says the same sentence the helpers throw, relative to the tenant folder, also for a parent link', () => {
    const w = world();
    if (!tryLink(join(w.outside, 'dir'), join(w.home, 'sub'), 'dir')) return;
    const why = inTenant(w, () => tenantWriteRefusal(join(w.home, 'sub', 'f')));
    expect(why).toBe("home/sub in the tenant folder is a link; a tenant's own files and folders must be real ones inside its folder.");
  });
});
