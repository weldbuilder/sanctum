// Round 6, item 1: dot segments never reach the decision, and the write layer FAILS CLOSED. A target with `.` or `..` in it is normalised with path.resolve
// first, then judged from the real path of its deepest existing ancestor; in a tenant a write that cannot be proven inside the tenant folder is refused (never
// handed to the plain fs call), and a target provably outside is refused too unless the caller passes `{ process: true }`. Every form is tried through a plain
// tenants.dir and through a symlinked one. Links need privileges on Windows (those cases return early when refused). No provider, no model run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NoTenantContext, enableTenancy, runInTenant } from './context.js';
import { fakeRuntime } from './test-runtime.js';
import {
  TenantEditRefused, ownAppendFile, ownAssertReal, ownAssertWritable, ownChmod, ownCopyFile, ownCp, ownMkdir, ownMkdirAsync, ownRename, ownRenameAsync, ownRm, ownRmAsync,
  ownUnlink, ownWriteFile, ownWriteFileAsync, ownWriteFileAtomic,
} from './own-files.js';
import * as lib from '../../../../scripts/own-files-lib.mjs';

const posix = process.platform !== 'win32';
const made: string[] = [];
interface World { top: string; plain: string; viaLink: string | null; outside: string; real: string }
function world(): World {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'sanctum-dots-')));
  made.push(top);
  const outside = join(top, 'outside');
  mkdirSync(join(outside, 'sub'), { recursive: true });
  writeFileSync(join(outside, 'existing'), 'OUTSIDE-EXISTING');
  writeFileSync(join(outside, 'sibling'), 'SIBLING');
  const real = join(top, 'tenants', 'ada');
  for (const d of ['home', 'data']) mkdirSync(join(real, d), { recursive: true });
  writeFileSync(join(real, 'home', 'src.txt'), 'SRC');
  let planted = true;
  try { symlinkSync(outside, join(real, 'data', 'lnk'), 'junction'); } catch { planted = false; }
  let viaLink: string | null = null;
  try { symlinkSync(join(top, 'tenants'), join(top, 'tenants-link'), 'junction'); viaLink = join(top, 'tenants-link', 'ada'); } catch { /* no links here */ }
  return { top, plain: real, viaLink: planted ? viaLink : null, outside, real: planted ? real : '' };
}
const snapshotOutside = (w: World) => JSON.stringify(readdirSync(w.outside, { recursive: true }).sort());

beforeEach(() => enableTenancy(true));
afterEach(() => { enableTenancy(false); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** The tenant whose folder is `dir` (spelled any way), entered. */
const inTenant = <T>(dir: string, fn: () => T): T => runInTenant(fakeRuntime('ada', { dir, dataDir: `${dir}/data`, homeDir: `${dir}/home` }), fn);

/** The dot-segment spellings of paths through data/lnk (a link out of the tenant), under `b` (the tenant folder as spelled). Plain concatenation: path.join would normalise them away. */
const forms = (b: string, leaf: string): Array<[string, string]> => [
  ['lnk/./leaf', `${b}/data/lnk/./${leaf}`],
  ['./lnk/leaf', `${b}/data/./lnk/${leaf}`],
  ['lnk/../data/lnk/leaf', `${b}/data/lnk/../data/lnk/${leaf}`],
  ['home/../data/lnk/leaf', `${b}/home/../data/lnk/${leaf}`],
  ['lnk/./sub/./leaf', `${b}/data/lnk/./sub/./${leaf}`],
];
/** A `..` that the link carries OUT of the tenant: to the OS, <data>/lnk/../sibling is <outside>/../sibling; its text normalises to <data>/sibling. */
const carried = (b: string): string => `${b}/data/lnk/../sibling`;
/** Where the two platforms differ. Posix follows the link first, so `lnk/..` is the link target's parent (outside): undecidable from the text, REFUSED. Windows resolves
 *  `..` lexically before it looks at any link (`lnk/../x` is `x` next to `lnk`), so these spellings are plain paths INSIDE the tenant (data/data/lnk/x, data/sibling):
 *  the layer lets them through to the fs, which answers a plain fs error (ENOENT for a missing parent, EEXIST for a `wx` write over a file that is there,
 *  EPERM where Windows reports a rename into a missing folder) or does the operation inside the tenant. Never a write outside either way: that is asserted on the
 *  outside snapshot separately. */
const lexicalOnWindows = (fname: string) => !posix && (fname === 'lnk/../data/lnk/leaf' || fname === '..-carried');
/** A plain fs error (Node's ErrnoException: a code and a syscall), as the OS answers for an inside path; never the layer's refusal. */
const plainFsError = (e: unknown): boolean => { const x = e as NodeJS.ErrnoException; return !!x && typeof x.code === 'string' && typeof x.syscall === 'string'; };
/** Run `fn`; true when it was refused by the layer. On a lexical-`..` form on Windows a plain fs error or a success is also acceptable (it landed inside the tenant). */
function refusedOrInside(fn: () => unknown, lexical: boolean, label: string): void {
  try { fn(); } catch (e) {
    if (e instanceof TenantEditRefused) return;
    if (lexical && plainFsError(e)) return;
    throw new Error(`${label}: neither refused nor a plain fs error: ${(e as Error)?.message}`);
  }
  if (!lexical) throw new Error(`${label}: expected a refusal`);
}
async function refusedOrInsideAsync(fn: () => Promise<unknown>, lexical: boolean, label: string): Promise<void> {
  try { await fn(); } catch (e) {
    if (e instanceof TenantEditRefused) return;
    if (lexical && plainFsError(e)) return;
    throw new Error(`${label}: neither refused nor a plain fs error: ${(e as Error)?.message}`);
  }
  if (!lexical) throw new Error(`${label}: expected a refusal`);
}

const spellings = (w: World): Array<[string, string, string]> => [
  ['plain tenants.dir', w.plain, w.plain],
  ...(w.viaLink ? [['symlinked tenants.dir, tenant entered by its real path', w.plain, w.viaLink], ['symlinked tenants.dir, tenant entered by the link', w.viaLink, w.viaLink], ['symlinked tenants.dir, tenant entered by the link, target spelled real', w.viaLink, w.plain]] as Array<[string, string, string]> : []),
];

describe('a dot-segment path never writes outside, in any helper, through a plain or a symlinked tenants.dir', () => {
  it('this machine can plant the link out (or the platform refuses links and the cases below do not apply)', () => {
    const w = world();
    if (!w.real) expect(() => symlinkSync(w.outside, join(w.top, 'probe'), 'junction')).toThrow();
  });

  const ops: Array<[string, (dir: string, p: string) => unknown, boolean]> = [
    ['ownWriteFile', (_d, p) => ownWriteFile(p, 'EVIL'), false],
    ['ownWriteFile (flag a)', (_d, p) => ownWriteFile(p, 'EVIL', { flag: 'a' }), false],
    ['ownWriteFile (flag wx)', (_d, p) => ownWriteFile(p, 'EVIL', { flag: 'wx' }), false],
    ['ownWriteFileAtomic', (_d, p) => ownWriteFileAtomic(p, 'EVIL'), false],
    ['ownAppendFile', (_d, p) => ownAppendFile(p, 'EVIL'), false],
    ['ownMkdir', (_d, p) => ownMkdir(p, { recursive: true }), false],
    ['ownChmod', (_d, p) => ownChmod(p, 0o700), false],
    ['ownCopyFile (dest)', (d, p) => ownCopyFile(`${d}/home/src.txt`, p), false],
    ['ownCp (dest)', (d, p) => ownCp(`${d}/home/src.txt`, p), false],
    ['ownRename (dest)', (d, p) => ownRename(`${d}/home/src.txt`, p), false],
    ['ownUnlink', (_d, p) => ownUnlink(p), true],
    ['ownRm', (_d, p) => ownRm(p, { force: true }), true],
    ['ownAssertWritable', (_d, p) => ownAssertWritable(p), false],
    ['ownAssertReal', (_d, p) => ownAssertReal(p), false],
  ];
  for (const [name, op] of ops.map(([n, o]) => [n, o] as const)) {
    it(`${name}: every dot form is refused and nothing outside changes`, () => {
      const w = world();
      if (!w.real) return;
      const before = snapshotOutside(w);
      for (const [sname, enter, spell] of spellings(w)) {
        for (const [fname, p] of [...forms(spell, 'x2'), ['..-carried', carried(spell)] as [string, string]]) {
          refusedOrInside(() => inTenant(enter, () => op(spell, p)), lexicalOnWindows(fname), `${sname}: ${fname}`);
        }
      }
      expect(snapshotOutside(w), name).toBe(before);
      expect(readFileSync(join(w.outside, 'existing'), 'utf8')).toBe('OUTSIDE-EXISTING');
    });
  }

  it('async write, mkdir, rename and rm refuse the dot forms too', async () => {
    const w = world();
    if (!w.real) return;
    const before = snapshotOutside(w);
    for (const [sname, enter, spell] of spellings(w)) {
      for (const [fname, p] of forms(spell, 'x3')) {
        const lex = lexicalOnWindows(fname);
        await refusedOrInsideAsync(() => inTenant(enter, () => ownWriteFileAsync(p, 'EVIL')), lex, `${sname} write ${fname}`);
        // (a recursive mkdir on a lexical form on Windows creates the folder INSIDE the tenant: a success there is fine, so it is not asserted as a refusal)
        await refusedOrInsideAsync(() => inTenant(enter, () => ownMkdirAsync(p, { recursive: true })), lex, `${sname} mkdir ${fname}`);
        await refusedOrInsideAsync(() => inTenant(enter, () => ownRenameAsync(`${spell}/home/src.txt`, p)), lex, `${sname} rename ${fname}`);
        await refusedOrInsideAsync(() => inTenant(enter, () => ownRmAsync(p, { force: true })), lex, `${sname} rm ${fname}`);
      }
    }
    expect(snapshotOutside(w)).toBe(before);
    // (src.txt may have been renamed into the tenant by a lexical form on Windows; on posix it never moves)
    if (posix) expect(readFileSync(join(w.real, 'home', 'src.txt'), 'utf8')).toBe('SRC');
  });

  it('rename and unlink of what is OUTSIDE, named through the link with dots, are refused: the outside file stays', () => {
    const w = world();
    if (!w.real) return;
    for (const [sname, enter, spell] of spellings(w)) {
      for (const [fname, p] of forms(spell, 'existing')) {
        const lex = lexicalOnWindows(fname); // (on Windows data/lnk/../data/lnk/existing is data/data/lnk/existing inside the tenant: ENOENT, never the outside file)
        refusedOrInside(() => inTenant(enter, () => ownRename(p, `${spell}/home/taken.txt`)), lex, `${sname} rename-from ${fname}`);
        refusedOrInside(() => inTenant(enter, () => ownUnlink(p)), lex, `${sname} unlink ${fname}`);
        refusedOrInside(() => inTenant(enter, () => ownCp(p, `${spell}/home/copy.txt`)), lex, `${sname} cp-from ${fname}`);
        refusedOrInside(() => inTenant(enter, () => ownCopyFile(p, `${spell}/home/copy.txt`)), lex, `${sname} copy-from ${fname}`);
      }
    }
    expect(readFileSync(join(w.outside, 'existing'), 'utf8')).toBe('OUTSIDE-EXISTING');
    expect(existsSync(join(w.real, 'home', 'taken.txt'))).toBe(false);
  });

  it('dot segments that stay inside the tenant are normalised and work (the write lands where the text says)', () => {
    const w = world();
    for (const [sname, enter, spell] of spellings(w)) {
      inTenant(enter, () => {
        ownWriteFile(`${spell}/home/./a.txt`, 'A');
        ownWriteFile(`${spell}/home/../data/b.txt`, 'B');
        ownMkdir(`${spell}/data/./deep/../deeper`, { recursive: true });
      });
      expect(readFileSync(join(w.plain, 'home', 'a.txt'), 'utf8'), sname).toBe('A');
      expect(readFileSync(join(w.plain, 'data', 'b.txt'), 'utf8'), sname).toBe('B');
      expect(existsSync(join(w.plain, 'data', 'deeper')), sname).toBe(true);
      rmSync(join(w.plain, 'home', 'a.txt')); rmSync(join(w.plain, 'data', 'b.txt')); rmSync(join(w.plain, 'data', 'deeper'), { recursive: true });
    }
  });
});

describe('the default flipped: a write that is not provably inside the tenant folder is refused', () => {
  it('a target provably outside is refused by every write helper, and `{ process: true }` is honoured', async () => {
    const w = world();
    const out = (n: string) => join(w.outside, n);
    inTenant(w.plain, () => {
      expect(() => ownWriteFile(out('f1'), 'X')).toThrow(/outside the tenant folder/);
      expect(() => ownWriteFile(`${w.plain}/../../outside/f2`, 'X')).toThrow(TenantEditRefused);
      expect(() => ownAppendFile(out('f3'), 'X')).toThrow(TenantEditRefused);
      expect(() => ownMkdir(out('d1'))).toThrow(TenantEditRefused);
      expect(() => ownRename(join(w.plain, 'home', 'src.txt'), out('moved'))).toThrow(TenantEditRefused);
      expect(() => ownUnlink(out('existing'))).toThrow(TenantEditRefused);
      expect(() => ownRm(out('existing'), { force: true })).toThrow(TenantEditRefused);
      expect(() => ownChmod(out('existing'), 0o600)).toThrow(TenantEditRefused);
      expect(() => ownCopyFile(join(w.plain, 'home', 'src.txt'), out('c1'))).toThrow(TenantEditRefused);
      expect(() => ownCp(join(w.plain, 'home', 'src.txt'), out('c2'))).toThrow(TenantEditRefused);
      expect(() => ownWriteFileAtomic(out('f4'), 'X')).toThrow(TenantEditRefused);
      expect(() => ownAssertWritable(out('f5'))).toThrow(TenantEditRefused);
    });
    await expect(inTenant(w.plain, () => ownWriteFileAsync(out('f6'), 'X'))).rejects.toBeInstanceOf(TenantEditRefused);
    expect(readdirSync(w.outside).sort()).toEqual(['existing', 'sibling', 'sub']);
    // the explicit allowance
    inTenant(w.plain, () => {
      ownWriteFile(out('p1'), 'P', { process: true });
      ownAppendFile(out('p2'), 'P', { process: true });
      ownMkdir(out('pd'), { process: true });
      ownCopyFile(join(w.plain, 'home', 'src.txt'), out('p3'), 0, { process: true });
      ownCp(join(w.plain, 'home', 'src.txt'), out('p4'), { process: true });
      ownWriteFileAtomic(out('p5'), 'P', { process: true });
      ownChmod(out('p1'), 0o600, { process: true });
      ownRename(out('p3'), out('p3b'), { process: true });
      ownUnlink(out('p3b'), { process: true });
      ownRm(out('p4'), { process: true });
      ownAssertWritable(out('p6'), { process: true });
    });
    await inTenant(w.plain, () => ownWriteFileAsync(out('p7'), 'P', { process: true }));
    await inTenant(w.plain, () => ownMkdirAsync(out('pd2'), { process: true }));
    expect(readFileSync(out('p1'), 'utf8')).toBe('P');
    expect(readFileSync(out('p2'), 'utf8')).toBe('P');
    expect(readFileSync(out('p5'), 'utf8')).toBe('P');
    expect(readFileSync(out('p7'), 'utf8')).toBe('P');
    expect(existsSync(out('pd')) && existsSync(out('pd2'))).toBe(true);
    expect(existsSync(out('p3b')) || existsSync(out('p4'))).toBe(false);
  });

  it('`{ process: true }` does not excuse a link inside the tenant folder, and tenancy off ignores it (plain fs)', () => {
    const w = world();
    if (!w.real) return;
    expect(() => inTenant(w.plain, () => ownWriteFile(`${w.plain}/data/lnk/inner`, 'X', { process: true }))).toThrow(/is a link/);
    expect(existsSync(join(w.outside, 'inner'))).toBe(false);
    enableTenancy(false);
    ownWriteFile(join(w.outside, 'plain-off'), 'Z'); // (tenancy off: the plain call, no tenant needed)
    expect(readFileSync(join(w.outside, 'plain-off'), 'utf8')).toBe('Z');
  });

  it('a path that cannot be decided (a symlink loop on the way) is refused, not written', () => {
    const w = world();
    try { symlinkSync(join(w.top, 'loop-b'), join(w.top, 'loop-a'), 'junction'); symlinkSync(join(w.top, 'loop-a'), join(w.top, 'loop-b'), 'junction'); } catch { return; }
    expect(() => inTenant(w.plain, () => ownWriteFile(join(w.top, 'loop-a', 'f'), 'X'))).toThrow(TenantEditRefused);
    expect(() => inTenant(w.plain, () => ownMkdir(join(w.top, 'loop-a', 'd')))).toThrow(TenantEditRefused);
  });

  it('with no current tenant (tenancy on, no store) a write helper throws NoTenantContext unless `{ process: true }` (round 7, item 5)', () => {
    const w = world();
    expect(() => ownWriteFile(join(w.outside, 'boot-time'), 'B')).toThrow(NoTenantContext);
    expect(existsSync(join(w.outside, 'boot-time'))).toBe(false);
    ownWriteFile(join(w.outside, 'boot-time'), 'B', { process: true });
    expect(readFileSync(join(w.outside, 'boot-time'), 'utf8')).toBe('B');
  });
});

describe('ownTouches and isInsideTenantDir agree on dot segments', () => {
  it('<R>/home/. is the tenant\'s home for both; so is <R>/home/./not-yet; <R>/home/../.. is outside for both', () => {
    const w = world();
    for (const b of [w.plain, ...(w.viaLink ? [w.viaLink] : [])]) {
      for (const p of [`${b}/home/.`, `${b}/home/./not-yet`, `${b}/home/../data`, `${b}/./home`]) {
        expect(lib.isInsideTenantDir(b, p), p).toBe(true);
        expect(lib.ownTouches(b, p), p).toBe(true);
      }
      for (const p of [`${b}/home/../..`, `${b}/home/../../outside/x`, `${b}/..`]) {
        expect(lib.isInsideTenantDir(b, p), p).toBe(false);
        expect(lib.ownTouches(b, p), p).toBe(false);
      }
    }
  });
  it('a `..` that a link carries out of the tenant: posix refuses it in isInsideTenantDir (and ownTouches guards it); Windows resolves it lexically to a plain inside path', () => {
    const w = world();
    if (!w.real) return;
    // posix: the OS follows lnk first, so the text (data/sibling) and the OS (outside/../sibling) disagree: undecidable, refused. win32: data/sibling, inside, for both.
    expect(lib.isInsideTenantDir(w.plain, carried(w.plain))).toBe(!posix);
    expect(lib.ownTouches(w.plain, carried(w.plain))).toBe(true);
  });
});
