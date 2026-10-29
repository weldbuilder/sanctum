// Round 6, items 10 and 11: create-only flags (`wx`, `wx+`, `ax`, `ax+`) keep their EEXIST meaning inside a tenant: the target is opened directly with
// O_EXCL | O_NOFOLLOW after the checks, never replaced by temp-and-rename; and the async write is the lib's write (one implementation).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableTenancy, runInTenant } from './context.js';
import { fakeRuntime } from './test-runtime.js';
import { TenantEditRefused, ownWriteFile, ownWriteFileAsync } from './own-files.js';

const posix = process.platform !== 'win32';
const made: string[] = [];
function world() {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'sanctum-flags-')));
  made.push(top);
  const dir = join(top, 'ada');
  mkdirSync(join(dir, 'home'), { recursive: true });
  return { top, dir, home: join(dir, 'home') };
}
beforeEach(() => enableTenancy(true));
afterEach(() => { enableTenancy(false); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const inTenant = <T>(dir: string, fn: () => T): T => runInTenant(fakeRuntime('ada', { dir, dataDir: join(dir, 'data'), homeDir: join(dir, 'home') }), fn);
const code = (e: unknown) => (e as { code?: string })?.code;

describe('create-only flags keep EEXIST semantics inside a tenant', () => {
  for (const flag of ['wx', 'wx+', 'ax', 'ax+']) {
    it(`flag ${flag}: creates a new file, then EEXIST (the first bytes stay, no temp file is left, the inode is not replaced)`, async () => {
      const w = world();
      const f = join(w.home, `f-${flag.replace('+', 'p')}.txt`);
      inTenant(w.dir, () => ownWriteFile(f, 'FIRST', { flag, ...(posix ? { mode: 0o600 } : {}) }));
      expect(readFileSync(f, 'utf8')).toBe('FIRST');
      if (posix) expect(statSync(f).mode & 0o777).toBe(0o600);
      const ino = statSync(f, { bigint: true }).ino;
      let thrown: unknown;
      try { inTenant(w.dir, () => ownWriteFile(f, 'SECOND', { flag })); } catch (e) { thrown = e; }
      expect(code(thrown), `${flag} sync`).toBe('EEXIST');
      await expect(inTenant(w.dir, () => ownWriteFileAsync(f, 'THIRD', { flag }))).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(f, 'utf8')).toBe('FIRST');
      expect(statSync(f, { bigint: true }).ino).toBe(ino);
      expect(readdirSync(w.home).filter((n) => n.includes('.tmp-'))).toEqual([]);
    });
  }
  it('a link planted at the target is refused (a create-only write never goes through it)', () => {
    const w = world();
    writeFileSync(join(w.top, 'secret'), 'SECRET');
    try { symlinkSync(join(w.top, 'secret'), join(w.home, 'evil'), 'file'); } catch { return; }
    for (const flag of ['wx', 'wx+', 'ax', 'ax+']) expect(() => inTenant(w.dir, () => ownWriteFile(join(w.home, 'evil'), 'X', { flag })), flag).toThrow(TenantEditRefused);
    expect(readFileSync(join(w.top, 'secret'), 'utf8')).toBe('SECRET');
  });
  it('the plain flags still do what they did: w replaces by rename, a appends', async () => {
    const w = world();
    const f = join(w.home, 'plain.txt');
    inTenant(w.dir, () => { ownWriteFile(f, 'ONE'); ownWriteFile(f, 'TWO', { flag: 'w' }); });
    expect(readFileSync(f, 'utf8')).toBe('TWO');
    inTenant(w.dir, () => { ownWriteFile(f, '+A', { flag: 'a' }); ownWriteFile(f, '+B', { flag: 'a+' }); });
    await inTenant(w.dir, () => ownWriteFileAsync(f, '+C', { flag: 'as' }));
    expect(readFileSync(f, 'utf8')).toBe('TWO+A+B+C');
  });
});

describe('the async write is the lib\'s write', () => {
  it('own-files.ts has no temp-and-rename of its own any more (the lib is the one implementation)', () => {
    const src = readFileSync(join(__dirname, 'own-files.ts'), 'utf8');
    expect(src).not.toContain('tempNameFor');
    expect(src).not.toContain('ownUnlinkAsync');
    expect(src).not.toContain('SCAN_CAP');
  });
  it('ownWriteFileAsync carries an existing file\'s mode over and sets the requested mode, like ownWriteFile; tenancy off is fs.promises.writeFile', async () => {
    const w = world();
    const f = join(w.home, 'm.txt');
    await inTenant(w.dir, () => ownWriteFileAsync(f, 'A', { mode: 0o600 }));
    await inTenant(w.dir, () => ownWriteFileAsync(f, 'B'));
    expect(readFileSync(f, 'utf8')).toBe('B');
    if (posix) expect(statSync(f).mode & 0o777).toBe(0o600);
    enableTenancy(false);
    await ownWriteFileAsync(join(w.top, 'off.txt'), 'OFF');
    expect(readFileSync(join(w.top, 'off.txt'), 'utf8')).toBe('OFF');
  });
});
