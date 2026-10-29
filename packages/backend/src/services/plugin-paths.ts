// Path helpers for the plugin loader, with the path module passed in so the Windows rules
// (path.win32: drive letters, backslashes, UNC, case-insensitive names) run on any platform
// in tests. plugins.ts binds them to the real platform at the bottom.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import nodePath, { posix, win32 } from 'node:path';

/** The slice of `node:path` these helpers use; `path`, `path.win32` and `path.posix` all fit. */
export type PathApi = Pick<typeof nodePath, 'resolve' | 'relative' | 'isAbsolute' | 'normalize' | 'join' | 'sep'>;

const folded = (s: string, ci: boolean) => (ci ? s.toLowerCase() : s);

/** True when `child` is `parent` or below it, compared as absolute paths with `..` collapsed.
 *  `ci` folds case first (Windows file names are case-insensitive). Across drives or UNC
 *  shares `relative` answers with an absolute path, which is never inside. A folder that
 *  merely starts with two dots (`..hidden`) is not a climb. Both paths should already be real
 *  (symlinks resolved): this is textual. */
export function pathInside(pm: PathApi, child: string, parent: string, ci: boolean): boolean {
  const r = pm.relative(folded(pm.resolve(parent), ci), folded(pm.resolve(child), ci));
  return r === '' || (r !== '..' && !r.startsWith(`..${pm.sep}`) && !pm.isAbsolute(r));
}

/** True when both name the same absolute path (separators, trailing separator, `..` and, with `ci`, case aside). */
export function samePath(pm: PathApi, a: string, b: string, ci: boolean): boolean {
  return folded(pm.resolve(a), ci) === folded(pm.resolve(b), ci);
}

/** True when `rel` is a manifest path that stays inside the plugin folder. Judged under BOTH
 *  separator styles, whatever the platform: a manifest that climbs with backslashes is a climb
 *  on Windows even when it is validated on Linux, and a plugin folder travels between them.
 *  Rejects absolute paths of either flavour (`/x`, `C:\x`, `\\srv\x`), drive-relative `C:x`,
 *  a NUL byte, and anything that normalises to `.` or to a path starting with `..` as a segment. */
export function containedRel(rel: string): boolean {
  if (!rel || rel.includes('\0')) return false;
  if (posix.isAbsolute(rel) || win32.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  for (const pm of [posix, win32]) {
    const n = pm.normalize(rel);
    if (n === '.' || n === '..' || n.startsWith(`..${pm.sep}`)) return false;
  }
  return true;
}

/** `~` and `~/x` to `home`; on a platform whose separator is a backslash, `~\x` too. */
export function expandTildeWith(pm: PathApi, home: string, p: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || (pm.sep === '\\' && p.startsWith('~\\'))) return pm.join(home, p.slice(2));
  return p;
}

/** The real path of `p`, whether or not it exists yet: the nearest existing ancestor is realpath'd
 *  (so a symlinked parent is followed) and the missing remainder is appended. When `linkTarget`
 *  is given, a dangling link on the way is followed to where it would land. The wizard
 *  (scripts/setup-discord.mjs) carries the same algorithm, since a plain .mjs cannot import this
 *  file: keep the two in step. */
export function realOrResolvedWith(
  pm: PathApi,
  real: (p: string) => string,
  p: string,
  linkTarget?: (p: string) => string | null,
  depth = 0,
): string {
  const abs = pm.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  const tail = () => [...rest].reverse();
  for (;;) {
    try { return pm.join(real(cur), ...tail()); } catch { /* not there, or a dangling link */ }
    if (linkTarget && depth < 40) {
      let t: string | null = null;
      try { t = linkTarget(cur); } catch { /* does not exist at all */ }
      if (t !== null) return realOrResolvedWith(pm, real, pm.join(pm.resolve(pm.join(cur, '..'), t), ...tail()), linkTarget, depth + 1);
    }
    const parent = pm.resolve(cur, '..');
    if (parent === cur) return abs;
    rest.push(pm.relative(parent, cur));
    cur = parent;
  }
}

// ── Bound to this platform ───────────────────────────────────────────────────
/** Windows file names ignore case. */
export const CASE_INSENSITIVE = process.platform === 'win32';

/** The real path, strictly (throws when it does not exist). `.native` asks the OS, so on Windows
 *  an 8.3 short name (`RUNNER~1`) and the long name (`runneradmin`) come out as the same path and
 *  the drive letter and folder names carry the case the file system stores. */
export const realPath = (p: string): string => realpathSync.native(p);
const linkTarget = (p: string): string | null => (lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null);
export const realOrResolved = (p: string): string => realOrResolvedWith(nodePath, realPath, p, linkTarget);
export const isInside = (child: string, parent: string): boolean => pathInside(nodePath, child, parent, CASE_INSENSITIVE);
export const isSame = (a: string, b: string): boolean => samePath(nodePath, a, b, CASE_INSENSITIVE);

// ── The write gate's own spelling ────────────────────────────────────────────
/** A path the way the write gate compares it (hooks.ts: resolve, backslashes to '/', lower case),
 *  on every OS: the gate folds case everywhere, so a containment check that has to agree with it
 *  (the ledger and the plugin roots against the companion-writable roots) folds case everywhere too,
 *  not only on Windows. Folding more than the file system does can only refuse a layout that would
 *  have been fine (two folders that differ by case alone); it never lets one through. */
export const gateCanon = (p: string): string => nodePath.resolve(p).replace(/\\/g, '/').toLowerCase();

/** True when `child` is `parent` or below it, in the write gate's canonical form (see gateCanon). */
export function gateInside(child: string, parent: string): boolean {
  const c = gateCanon(child);
  const r = gateCanon(parent);
  return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** The real path of `p`, or, when it does not exist yet, the real path of its deepest existing
 *  ancestor with the rest appended: a folder that is not created yet still resolves through a
 *  symlinked parent. */
export function realDeep(p: string): string {
  let cur = nodePath.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return rest.length ? nodePath.join(realPath(cur), ...[...rest].reverse()) : realPath(cur); } catch { /* not there yet */ }
    const up = nodePath.dirname(cur);
    if (up === cur) return nodePath.resolve(p);
    rest.push(nodePath.basename(cur));
    cur = up;
  }
}
