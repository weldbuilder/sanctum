// The file-level half of the Claude frame editor's guard (routes/api.ts: GET/PUT /prompts/system). The route judges the PATH first (links, hard links, the
// app's own folders) for a clear answer; a path check followed by a path write can be raced (a folder swapped for a link in between), so the save and the
// read here never trust a path after the boundary.
//
// Linux (/proc/self/fd readable): the folder the walk starts at (the write root, or its deepest existing ancestor) is opened O_DIRECTORY | O_NOFOLLOW and
// its real place is read back from /proc/self/fd/<fd> (readlink, never realpath). Every folder below it is opened, and made when missing, through the HELD
// descriptor of the one above (/proc/self/fd/<fd>/<name>, O_NOFOLLOW), and every held folder is checked by inode against the app's own folders. The file is
// written as a temp file inside the held parent and renamed over the name there, so a save is all or nothing and a folder swapped for a link at any moment
// can only make the save fail.
//
// What this guarantees: a save never follows a link into the app's prompts/ or companion-home/ folders and never writes, replaces or removes an existing file
// there; in tenant mode it also stays inside the tenant folder. What it does not: someone who can already rename folders into those app folders (the owner and
// the companion can, in the default single-tenant layout) can put a new file of their own there, as they could by hand; and a write root that is itself
// replaced by a link is followed, since a home kept on another disk is a link too.
//
// Other platforms (macOS, Windows, a Linux without /proc): no directory descriptor to hold, so the path approach stays (an lstat walk, an O_NOFOLLOW open
// where the platform has it, the inode checks) with every folder verified just before anything is made in it, and a new file or folder looked for, by
// inode, in each app folder by that folder's own path. The save is still a temp file renamed over the name, so it is all or nothing there too. There the folder-swap race is NARROWED, not closed: a swap at the moment of a create can still make
// an empty file or folder in an app folder for an instant (it is refused before a byte is written and taken away by the app folder's own path), and a
// save can land in some other folder the swapped link names. docs/CONFIGURATION.md says so.
import { randomBytes } from 'node:crypto';
import {
  accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';

/** A refusal the route answers with: `status` is the HTTP code (400 a link, a hard link, not a regular file, a folder that moved; 403 the app's own files or
 *  folders, or outside the tenant folder), `message` is safe to show. */
export class FrameRefused extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'FrameRefused'; }
}

// --- Paths -----------------------------------------------------------------------------------------------------------------------------------------------
/** macOS and Windows file systems are case-insensitive by default: `<root>/Prompts` is `<root>/prompts` there. Read at call time (a test mocks the platform). */
const foldsCase = (): boolean => process.platform === 'darwin' || process.platform === 'win32';
const fold = (p: string): string => (foldsCase() ? p.toLowerCase() : p);
/** The same path, comparing case-insensitively where the platform's file system is. */
export const samePath = (a: string, b: string): boolean => fold(a) === fold(b);
/** `p` is `dir` or below it (both absolute, resolved). Case-insensitive on macOS and Windows. */
export function underFolder(p: string, dir: string): boolean {
  const a = fold(p);
  const d = fold(dir);
  return a === d || a.startsWith(d.endsWith(sep) ? d : d + sep);
}

// --- The app's own files and folders ---------------------------------------------------------------------------------------------------------------------
/** A file or folder by identity. bigint: a Windows file id is wider than a double. */
const keyOf = (st: { dev: bigint | number; ino: bigint | number }): string => `${st.dev}:${st.ino}`;

/** The app's own tracked trees, by identity: every folder and every regular file under `<root>/prompts` and `<root>/companion-home` (walked with lstat, a
 *  link to a folder is never followed into; a link to a file adds that file), the two roots themselves (by their real path: a root that is a link protects the folder it names), `folders`, both
 *  spellings of each root (as written, and real) for the path checks, and `dirPaths`, the real path of every protected folder (off Linux, where a new
 *  name is looked for in each of them by its own path, a path no request can swap). Missing trees are skipped. Taken once per request. */
export interface ProtectedFrameSet { dirs: Set<string>; files: Set<string>; folders: string[]; dirPaths: string[] }
const PROTECTED_WALK_LIMIT = 20000; // (the two trees hold a few dozen entries; a tree past this is not walked further, and what was walked still counts)
export function protectedFrameSet(root: string): ProtectedFrameSet {
  const set: ProtectedFrameSet = { dirs: new Set(), files: new Set(), folders: [], dirPaths: [] };
  let seen = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (++seen > PROTECTED_WALK_LIMIT) return;
      const p = join(dir, name);
      let st: BigIntStats;
      try { st = lstatSync(p, { bigint: true }); } catch { continue; } // (gone meanwhile)
      if (st.isDirectory()) { set.dirs.add(keyOf(st)); set.dirPaths.push(p); walk(p); } else if (st.isFile()) set.files.add(keyOf(st));
      else if (st.isSymbolicLink()) { try { const t = statSync(p, { bigint: true }); if (t.isFile()) set.files.add(keyOf(t)); } catch { /* dangling */ } } // (a tracked name that is a link to a file: that file is the app's; a link to a folder is never walked)
    }
  };
  for (const name of ['prompts', 'companion-home']) {
    const dir = join(root, name);
    let real: string;
    try { real = realpathSync.native(dir); } catch { continue; }
    set.folders.push(dir);
    if (real !== dir) set.folders.push(real);
    try { const st = statSync(real, { bigint: true }); if (!st.isDirectory()) continue; set.dirs.add(keyOf(st)); set.dirPaths.push(real); } catch { continue; }
    walk(real);
  }
  return set;
}
/** The regular files of protectedFrameSet (kept for callers that only need the files). */
export function protectedFrameFiles(root: string): Set<string> { return protectedFrameSet(root).files; }

const FRAME_IN_APP = "The frame is never saved into the app's own prompts/ or companion-home/ folder";
/** 403 when the open handle `fd` is one of the protected files, by inode: whatever the path spelled at the time, the descriptor IS the tracked file. */
export function assertNotProtectedInode(fd: number, protectedFiles: ReadonlySet<string>): void {
  if (protectedFiles.has(keyOf(fstatSync(fd, { bigint: true })))) throw new FrameRefused(403, FRAME_IN_APP);
}

/** 400 unless the open handle is a regular file with a single name. */
export function assertRegularSingleLink(fd: number, label: string): void {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new FrameRefused(400, `${label} is not a regular file; the frame is saved only to a plain file`);
  if (st.nlink > 1) throw new FrameRefused(400, `${label} is hard-linked; the frame is not saved through a second name for another file`);
}

// --- Test seam -------------------------------------------------------------------------------------------------------------------------------------------
/** Where a save or read is when the test seam runs: 'boundary' just after the folder the walk starts at is opened (Linux) or before the folders are walked
 *  (elsewhere); 'parent' once the target's parent folder is held (Linux), or after the folder walk and before the file is opened (elsewhere); 'written'
 *  (Linux, a save only) once the temp file is written and closed, before it is checked and renamed. */
export type FrameStage = 'boundary' | 'parent' | 'written';
let stageHook: ((stage: FrameStage, target: string) => void) | null = null;
/** Test seam: `fn(stage, target)` runs at each stage of every save and read (a test swaps a folder for a link there, the race the design must survive).
 *  null restores. */
export function setFrameStageHookForTest(fn: ((stage: FrameStage, target: string) => void) | null): void { stageHook = fn; }

// --- Shared ----------------------------------------------------------------------------------------------------------------------------------------------
export interface FrameIoOptions {
  /** The folder the walk starts at: the write root that holds the target (links above it are the operator's own layout). When it does not exist yet, its
   *  deepest existing ancestor is the start and the rest is made (a save) or is missing (a read: ENOENT). */
  boundary: string;
  /** protectedFrameSet(PROJECT_ROOT), taken once by the caller. null for a read of the app's own shipped file: no refusal by the app's folders then, the link,
   *  type and hard-link checks still hold. */
  guard: ProtectedFrameSet | null;
  /** Tenant mode: the real place of the start folder must pass this (insideCurrentTenant). */
  allowedAt?: (realDir: string) => boolean;
  /** Off Linux only: how a missing folder is made (the tenant-aware ownMkdir). Default mkdirSync. */
  mkdir?: (dir: string) => void;
}

/** /proc/self/fd is there to hold folders by (Linux). Read at call time (a test mocks the platform). */
export function procFdUsable(): boolean {
  if (process.platform !== 'linux') return false;
  try { accessSync('/proc/self/fd', constants.R_OK); return true; } catch { return false; }
}
const at = (fd: number, name?: string): string => (name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`);
const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;
const cannot = (): FrameRefused => new FrameRefused(400, 'The frame path cannot be checked');
const moved = (): FrameRefused => new FrameRefused(400, 'A folder on the frame path changed while it was being used; nothing was written');
const changed = (during: 'save' | 'read'): FrameRefused => new FrameRefused(400, `The frame path changed during the ${during}`);

/** The folder names from `from` down to `to` (`to` at or below `from`). Never `.`, `..` or empty: those are refused, not walked. */
function componentsBetween(from: string, to: string): string[] {
  if (samePath(from, to)) return [];
  const rel = relative(from, to);
  if (!rel || isAbsolute(rel)) throw cannot();
  const parts = rel.split(sep);
  if (parts.some((c) => c === '' || c === '.' || c === '..')) throw cannot();
  return parts;
}

/** The deepest of `dir` and its ancestors that exists, and its real path. A file in the way is "not a folder". */
function deepestReal(dir: string): { base: string; real: string } {
  for (let probe = dir; ; probe = dirname(probe)) {
    try { return { base: probe, real: realpathSync.native(probe) }; } catch (e) {
      const code = codeOf(e);
      if (code === 'ENOTDIR') throw new FrameRefused(400, `${basename(probe)} is not a folder; the frame cannot be saved inside it`);
      if (code !== 'ENOENT') throw cannot();
    }
    if (dirname(probe) === probe) throw cannot();
  }
}

// --- Linux: every operation after the boundary is relative to a held folder ------------------------------------------------------------------------------
const DIR_FLAGS = (): number => constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** 403 when the held folder `fd` is one of the app's own folders, by inode. */
function assertDirNotProtected(fd: number, guard: ProtectedFrameSet | null): void {
  if (guard && guard.dirs.has(keyOf(fstatSync(fd, { bigint: true })))) throw new FrameRefused(403, FRAME_IN_APP);
}

/** Open the start folder and verify where it really is. Returns the held descriptor, the path it was reached by (`base`) and its real place. */
function openBoundary(boundary: string, opts: FrameIoOptions): { fd: number; base: string; real: string } {
  const { base, real } = deepestReal(boundary);
  let fd: number;
  try { fd = openSync(real, DIR_FLAGS()); } catch (e) {
    const code = codeOf(e);
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENOENT') throw moved(); // (it was a folder at the realpath a moment ago)
    throw e;
  }
  try {
    let where: string;
    try { where = readlinkSync(at(fd)); } catch { throw cannot(); }
    // (readlink names where the open handle is now. " (deleted)": the folder is gone. Not its realpath of a moment ago: something above it moved.)
    if (where.endsWith(' (deleted)') || where !== real) throw moved();
    if (opts.guard && opts.guard.folders.some((d) => underFolder(where, d))) throw new FrameRefused(403, FRAME_IN_APP);
    if (opts.allowedAt && !opts.allowedAt(where)) throw new FrameRefused(403, 'The frame path is outside the tenant folder');
    assertDirNotProtected(fd, opts.guard);
    return { fd, base, real };
  } catch (e) { closeSync(fd); throw e; }
}

/** The folders a save made and the descriptors it keeps open for them: `dirs` is each folder made, with the held folder it was made in; `fds` the held folders
 *  walked past (closed by the caller). A failed save removes `dirs`, deepest first, through these descriptors. */
interface Trail { dirs: Array<{ parent: number; name: string }>; fds: number[] }

/** The child folder `name` of the held folder `dirFd`, opened through it (never by path); made first when it is missing and `create` is set. */
function openChildDir(dirFd: number, name: string, create: boolean, guard: ProtectedFrameSet | null, trail?: Trail): number {
  const refuseAsLink = (): never => {
    let link = false;
    try { link = lstatSync(at(dirFd, name)).isSymbolicLink(); } catch { /* gone again */ }
    throw new FrameRefused(400, link ? `${name} is a link; the frame is never saved or read through a link` : `${name} is not a folder; the frame is never saved or read inside it`);
  };
  const open = (): number => openSync(at(dirFd, name), DIR_FLAGS());
  let fd: number;
  try { fd = open(); } catch (e) {
    const code = codeOf(e);
    if (code === 'ELOOP' || code === 'ENOTDIR') refuseAsLink();
    if (code === 'ENOENT' && !create) throw changed('read'); // (a folder removed during the walk)
    if (code !== 'ENOENT') throw e;
    try { mkdirSync(at(dirFd, name), 0o755); trail?.dirs.push({ parent: dirFd, name }); } catch (e2) {
      const c2 = codeOf(e2);
      if (c2 === 'ENOENT') throw changed('save'); // (the held folder was removed meanwhile)
      if (c2 !== 'EEXIST') throw e2; // (EEXIST: made meanwhile; the open below judges it)
    }
    try { fd = open(); } catch (e3) { const c = codeOf(e3); if (c === 'ELOOP' || c === 'ENOTDIR') refuseAsLink(); throw c === 'ENOENT' ? moved() : e3; }
  }
  try { assertDirNotProtected(fd!, guard); } catch (e) { closeSync(fd!); throw e; }
  return fd!;
}

/** Walk from the start folder to the target's parent, each folder through the one above. Returns the held parent and the path it must still be at. The
 *  caller closes `fd`. */
function holdParent(target: string, opts: FrameIoOptions, create: boolean, trail?: Trail): { fd: number; expected: string } {
  const start = openBoundary(opts.boundary, opts);
  let cur = start.fd;
  const release = (fd: number): void => { if (trail) trail.fds.push(fd); else closeSync(fd); }; // (a save keeps them to take away a folder it made)
  try {
    stageHook?.('boundary', target);
    let expected = start.real;
    for (const comp of componentsBetween(start.base, dirname(target))) {
      const next = openChildDir(cur, comp, create, opts.guard, trail);
      const prev = cur; cur = next; release(prev);
      expected = join(expected, comp);
    }
    stageHook?.('parent', target);
    return { fd: cur, expected };
  } catch (e) { release(cur); throw e; }
}

function writeLinux(target: string, content: string, opts: FrameIoOptions): void {
  const name = basename(target);
  const trail: Trail = { dirs: [], fds: [] };
  let P = -1;
  let landed = false;
  try {
    let expected: string;
    ({ fd: P, expected } = holdParent(target, opts, true, trail));
    // The name, judged inside the held parent (a folder swap can no longer redirect it; a swap of the entry itself only changes what the rename replaces).
    let existing: BigIntStats | null = null;
    try { existing = lstatSync(at(P, name), { bigint: true }); } catch (e) { if (codeOf(e) !== 'ENOENT') throw cannot(); }
    if (existing) {
      if (existing.isSymbolicLink()) throw new FrameRefused(400, 'The frame file is a link; the frame is not saved through a link');
      if (!existing.isFile()) throw new FrameRefused(400, 'The frame file is not a regular file; the frame is saved only to a plain file');
      if (existing.nlink > 1n) throw new FrameRefused(400, 'The frame file is hard-linked; the frame is not saved through a second name for another file');
      if (opts.guard?.files.has(keyOf(existing))) throw new FrameRefused(403, FRAME_IN_APP);
    }
    const mode = existing ? Number(existing.mode & 0o777n) : 0o644;
    // All or nothing: a temp file in the held parent (random name, made exclusively), written and synced, then renamed over the name.
    const tmp = `.${name}.tmp-${randomBytes(8).toString('hex')}`;
    let t = -1;
    let mine: BigIntStats | null = null; // (the temp file as written: what the rename must still find at its name)
    try {
      try { t = openSync(at(P, tmp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode); } catch (e) {
        const code = codeOf(e);
        if (code === 'ENOENT') throw moved(); // (the held folder was removed meanwhile)
        if (code === 'EEXIST') throw changed('save'); // (the temp name is taken: not ours, so never removed)
        throw e;
      }
      mine = fstatSync(t, { bigint: true });
      if (existing) fchmodSync(t, mode); // (the existing file's mode exactly, whatever the umask)
      assertRegularSingleLink(t, 'The frame file');
      if (opts.guard) assertNotProtectedInode(t, opts.guard.files);
      const bytes = Buffer.from(content, 'utf8');
      for (let off = 0; off < bytes.length;) {
        const n = writeSync(t, bytes, off, bytes.length - off);
        if (n <= 0) throw new Error('write made no progress');
        off += n;
      }
      fsyncSync(t);
      const done = t; t = -1; closeSync(done); // (closed once: a close that throws is not retried by the error path)
      stageHook?.('written', target);
      // The parent must still be the folder the path names: a folder moved away meanwhile gets nothing (the save lands where the path says, or nowhere).
      let where = '';
      try { where = readlinkSync(at(P)); } catch { throw cannot(); }
      if (where !== expected) throw moved();
      // And the temp name must still be the file just written: a link or a second name put there by someone else in the folder would be installed as the home copy.
      let now: BigIntStats;
      try { now = lstatSync(at(P, tmp), { bigint: true }); } catch { throw changed('save'); }
      if (!now.isFile() || now.dev !== mine.dev || now.ino !== mine.ino || now.nlink !== 1n) throw changed('save');
      try { renameSync(at(P, tmp), at(P, name)); } catch (e) {
        const code = codeOf(e);
        if (code === 'ENOTDIR' || code === 'EISDIR') throw changed('save'); // (the temp or the name replaced by a folder; the rename never replaces one)
        if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new FrameRefused(400, 'The frame file is not a regular file; the frame is saved only to a plain file');
        if (code === 'ENOENT') throw moved();
        throw e;
      }
      landed = true;
      mine = null;
    } catch (e) {
      if (t >= 0) { try { closeSync(t); } catch { /* closed */ } }
      if (mine) { // (through the held parent, by its random name, and only if it still is the file written: never another file)
        try {
          const st = lstatSync(at(P, tmp), { bigint: true });
          if (st.isFile() && st.dev === mine.dev && st.ino === mine.ino) unlinkSync(at(P, tmp)); // (a regular file: a freed inode number is reused at once, by a link too)
        } catch { /* gone */ }
      }
      throw e;
    }
    try { fsyncSync(P); } catch (e) { // (the rename made durable; it has landed either way)
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(codeOf(e) ?? '')) console.warn(`Frame saved, but its folder could not be synced (${codeOf(e) ?? 'error'})`);
    }
  } finally {
    // A save that failed takes away the folders it made, deepest first, through the folders it held (never by path); a folder with anything in it stays.
    if (!landed) for (const d of trail.dirs.reverse()) { try { rmdirSync(at(d.parent, d.name)); } catch { /* not empty (ENOTEMPTY), or gone */ } }
    if (P >= 0) closeSync(P);
    for (const fd of trail.fds) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

function readLinux(path: string, opts: FrameIoOptions): string {
  const name = basename(path);
  const { fd: P } = holdParent(path, opts, false);
  try {
    let fd: number;
    try { fd = openSync(at(P, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
      const code = codeOf(e);
      if (code === 'ELOOP') throw new FrameRefused(400, 'The frame file is a link; the editor does not read through a link');
      if (code === 'ENOENT') throw changed('read'); // (the file or a folder above it removed since the path was judged)
      throw e;
    }
    try { return readFromFd(fd, opts.guard); } finally { closeSync(fd); }
  } finally { closeSync(P); }
}

/** The bytes of an open handle: a regular file with one name (a pipe opened O_NONBLOCK is refused here, never read), not one of the app's files unless this
 *  is a read of the app's own file (guard null). */
function readFromFd(fd: number, guard: ProtectedFrameSet | null): string {
  const st = fstatSync(fd, { bigint: true });
  if (!st.isFile()) throw new FrameRefused(400, 'The frame file is not a regular file; the editor reads only a plain file');
  if (st.nlink > 1n) throw new FrameRefused(400, 'The frame file has more than one hard link; the editor does not read a second name for another file');
  if (guard?.files.has(keyOf(st))) throw new FrameRefused(403, "The editor's frame is never one of the app's own prompt files");
  return readFileSync(fd, 'utf8');
}

// --- Other platforms: the path walk, each folder verified just before it is used -------------------------------------------------------------------------
/** The folder `dir` by path: a folder, not one of the app's own. At or above the boundary a link is the operator's layout (stat follows it); below it, or
 *  when this call just made it (`made`), a link is refused (lstat). */
function checkFolderByPath(dir: string, boundary: string, guard: ProtectedFrameSet | null, made = false): void {
  const below = made || (underFolder(dir, boundary) && !samePath(dir, boundary));
  let st: BigIntStats;
  try { st = below ? lstatSync(dir, { bigint: true }) : statSync(dir, { bigint: true }); } catch { throw moved(); }
  if (st.isSymbolicLink()) throw new FrameRefused(400, `${basename(dir)} is a link; the frame is not saved through a link`);
  if (!st.isDirectory()) throw new FrameRefused(400, `${basename(dir)} is not a folder; the frame cannot be saved inside it`);
  if (guard?.dirs.has(keyOf(st))) throw new FrameRefused(403, FRAME_IN_APP);
}

/** Off Linux: the app folder in which `name` now names the very file or folder `mine` is, found by each app folder's OWN path (stable: no request can swap
 *  a folder inside the app's trees), or ''. This is the check that holds when a folder of the home was swapped for a link at the moment of a create. */
function landedInApp(name: string, mine: { dev: bigint; ino: bigint }, guard: ProtectedFrameSet | null): string {
  for (const d of guard?.dirPaths ?? []) {
    try { const st = lstatSync(join(d, name), { bigint: true }); if (st.ino === mine.ino && st.dev === mine.dev) return d; } catch { /* not there */ }
  }
  return '';
}
/** Off Linux: a folder named `name` that is in an app folder now and was not when the request began (a mkdir that went through a swapped link), or ''. */
function newFolderInApp(name: string, guard: ProtectedFrameSet | null): string {
  for (const d of guard?.dirPaths ?? []) {
    try { const st = lstatSync(join(d, name), { bigint: true }); if (st.isDirectory() && !guard!.dirs.has(keyOf(st))) return join(d, name); } catch { /* not there */ }
  }
  return '';
}

/** Make `dir` and the folders above it that are missing, top down, each one made only inside a folder just verified, and verified itself once made. */
function makeFoldersByPath(dir: string, opts: FrameIoOptions): void {
  const missing: string[] = [];
  for (let p = dir; ; p = dirname(p)) {
    try { lstatSync(p); break; } catch (e) { if (codeOf(e) !== 'ENOENT') throw cannot(); }
    missing.unshift(p);
    if (dirname(p) === p) throw cannot();
  }
  for (const p of missing) {
    checkFolderByPath(dirname(p), opts.boundary, opts.guard, missing.includes(dirname(p)));
    try { (opts.mkdir ?? ((d: string) => mkdirSync(d, 0o755)))(p); } catch (e) { if (codeOf(e) !== 'EEXIST') throw e; }
    // (Made through a folder swapped for a link: it is in an app folder. Taken away again by that folder's own path, rmdir: only ever an empty folder.)
    const stray = newFolderInApp(basename(p), opts.guard);
    if (stray) { try { rmdirSync(stray); } catch { /* not empty, or gone: left */ } throw new FrameRefused(403, FRAME_IN_APP); }
    checkFolderByPath(p, opts.boundary, opts.guard, true);
  }
  // The folders that were there already, from the boundary down.
  for (let p = dir; underFolder(p, opts.boundary) && !samePath(p, opts.boundary); p = dirname(p)) {
    checkFolderByPath(p, opts.boundary, opts.guard);
    if (dirname(p) === p) break;
  }
}

function writeByPath(target: string, content: string, opts: FrameIoOptions): void {
  const guard = opts.guard;
  stageHook?.('boundary', target);
  makeFoldersByPath(dirname(target), opts);
  stageHook?.('parent', target);
  const noFollow = constants.O_NOFOLLOW;
  // What is at the name now. Nothing there: the open below only ever creates (O_CREAT | O_EXCL), so a link that appears meanwhile is never followed.
  let seen: BigIntStats | null = null;
  try { seen = lstatSync(target, { bigint: true }); } catch (e) { if (codeOf(e) !== 'ENOENT') throw cannot(); }
  if (seen?.isSymbolicLink()) throw new FrameRefused(400, 'The frame file is a link; the frame is not saved through a link');
  const flags = (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0);
  // An existing name is first opened READ-ONLY and judged (a regular file with one name, not one of the app's files by inode), so a tracked file reached
  // through a swapped folder is never even opened for writing; the write handle opened next must be that very file.
  let probe: BigIntStats | null = null;
  if (seen) {
    let r: number;
    try { r = openSync(target, constants.O_RDONLY | flags); } catch (e) {
      const code = codeOf(e);
      if (code === 'ELOOP' || code === 'EMLINK') throw new FrameRefused(400, 'The frame file is a link; the frame is not saved through a link');
      if (code === 'ENOENT') throw moved();
      throw e;
    }
    try {
      assertRegularSingleLink(r, 'The frame file');
      if (guard) assertNotProtectedInode(r, guard.files);
      probe = fstatSync(r, { bigint: true });
      if (probe.ino !== seen.ino || probe.dev !== seen.dev) throw moved();
    } finally { closeSync(r); }
  }
  // All or nothing, as on Linux: a temp file in the same folder (random name, made exclusively, never through a link), written and synced, then renamed over
  // the name (a rename replaces an existing file on every platform, and replaces a second name for another file without ever writing through it).
  const name = basename(target);
  const dir = dirname(target);
  const tmpPath = join(dir, `.${name}.tmp-${randomBytes(8).toString('hex')}`);
  const mode = seen ? Number(seen.mode & 0o777n) : 0o644;
  let fd = -1;
  let mine: BigIntStats | null = null; // (the temp file as written: what the rename must still find at its name)
  let landedAt = ''; // (an app folder the temp file was created in through a swapped link; taken away from there)
  try {
    try { fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (noFollow ?? 0), mode); } catch (e) {
      const code = codeOf(e);
      if (code === 'ELOOP' || code === 'EMLINK') throw new FrameRefused(400, 'The frame file is a link; the frame is not saved through a link');
      if (code === 'EEXIST') throw changed('save'); // (the temp name is taken: not ours, so never removed)
      if (code === 'ENOENT') throw moved();
      throw e;
    }
    mine = fstatSync(fd, { bigint: true });
    if (seen && process.platform !== 'win32') fchmodSync(fd, mode); // (the existing file's mode exactly, whatever the umask)
    assertRegularSingleLink(fd, 'The frame file');
    if (guard) assertNotProtectedInode(fd, guard.files);
    // Where the open handle is. A temp file made through a folder swapped for a link is IN an app folder: found there by that folder's own path, refused
    // before a byte is written, and taken away again by that same path (its inode checked; never by the swappable path the save was given).
    const landed = landedInApp(basename(tmpPath), mine, guard);
    if (landed) { landedAt = join(landed, basename(tmpPath)); throw new FrameRefused(403, FRAME_IN_APP); }
    // And the folder it is in, looked up again now that the file is open: not one of the app's (stat follows a link swapped in, to the folder it names).
    let parent: BigIntStats;
    try { parent = statSync(dir, { bigint: true }); } catch { throw moved(); }
    if (guard?.dirs.has(keyOf(parent))) throw new FrameRefused(403, FRAME_IN_APP);
    const bytes = Buffer.from(content, 'utf8');
    for (let off = 0; off < bytes.length;) {
      const n = writeSync(fd, bytes, off, bytes.length - off);
      if (n <= 0) throw new Error('write made no progress');
      off += n;
    }
    fsyncSync(fd);
    const done = fd; fd = -1; closeSync(done); // (closed once: a close that throws is not retried by the error path)
    // The temp name must still be the file just written, and the target still what it was judged to be (a link or a second name put there since is refused).
    let now: BigIntStats;
    try { now = lstatSync(tmpPath, { bigint: true }); } catch { throw changed('save'); }
    if (!now.isFile() || now.dev !== mine.dev || now.ino !== mine.ino || now.nlink !== 1n) throw changed('save');
    let at2: BigIntStats | null = null;
    try { at2 = lstatSync(target, { bigint: true }); } catch (e) { if (codeOf(e) !== 'ENOENT') throw cannot(); }
    if (at2) {
      if (at2.isSymbolicLink()) throw new FrameRefused(400, 'The frame file is a link; the frame is not saved through a link');
      if (!at2.isFile()) throw new FrameRefused(400, 'The frame file is not a regular file; the frame is saved only to a plain file');
      if (at2.nlink > 1n) throw new FrameRefused(400, 'The frame file is hard-linked; the frame is not saved through a second name for another file');
      if (guard?.files.has(keyOf(at2))) throw new FrameRefused(403, FRAME_IN_APP);
    }
    if (!!at2 !== !!seen || (at2 && seen && (at2.ino !== seen.ino || at2.dev !== seen.dev))) throw moved();
    try { renameSync(tmpPath, target); } catch (e) {
      const code = codeOf(e);
      if (code === 'ENOTDIR' || code === 'EISDIR') throw changed('save');
      if (code === 'ENOENT') throw moved();
      throw e;
    }
    mine = null;
  } catch (e) {
    if (fd >= 0) { try { closeSync(fd); } catch { /* closed */ } }
    if (mine) { // (only if it still is the file written: never another file)
      const victim = landedAt || tmpPath;
      try {
        const st = lstatSync(victim, { bigint: true });
        if (st.isFile() && st.dev === mine.dev && st.ino === mine.ino) unlinkSync(victim);
      } catch { /* gone */ }
    }
    throw e;
  }
}

function readByPath(path: string, opts: FrameIoOptions): string {
  stageHook?.('boundary', path);
  // Every folder from the boundary down: not a link (a folder link would read whatever it names), not missing (ENOENT passes through).
  const dirs: string[] = [];
  for (let p = dirname(path); underFolder(p, opts.boundary) && !samePath(p, opts.boundary); p = dirname(p)) { dirs.unshift(p); if (dirname(p) === p) break; }
  for (const d of dirs) {
    const st = lstatSync(d);
    if (st.isSymbolicLink()) throw new FrameRefused(400, `${basename(d)} is a link; the editor does not read through a link`);
    if (!st.isDirectory()) throw new FrameRefused(400, `${basename(d)} is not a folder`);
  }
  stageHook?.('parent', path);
  // (No O_NOFOLLOW on Windows: the open would follow a link, so the link is refused by name first. Elsewhere the open itself refuses it.)
  if (constants.O_NOFOLLOW === undefined) { try { if (lstatSync(path).isSymbolicLink()) throw new FrameRefused(400, 'The frame file is a link; the editor does not read through a link'); } catch (e) { if (e instanceof FrameRefused) throw e; } }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch (e) {
    const code = codeOf(e);
    if (code === 'ELOOP' || code === 'EMLINK') throw new FrameRefused(400, 'The frame file is a link; the editor does not read through a link');
    throw e;
  }
  try {
    const parent = (() => { try { return statSync(dirname(path), { bigint: true }); } catch { return null; } })();
    if (opts.guard && parent && opts.guard.dirs.has(keyOf(parent))) throw new FrameRefused(403, "The editor's frame is never one of the app's own prompt files");
    return readFromFd(fd, opts.guard);
  } finally { closeSync(fd); }
}

// --- Entry points ----------------------------------------------------------------------------------------------------------------------------------------
/** Save `content` to `target` (absolute, resolved). Linux: through held folder descriptors and an atomic temp-and-rename inside the held parent (see the top
 *  of this file). Elsewhere: the path walk and an in-place write through an O_NOFOLLOW descriptor. Throws FrameRefused; every descriptor is closed. */
export function writeFrame(target: string, content: string, opts: FrameIoOptions): void {
  if (procFdUsable()) writeLinux(target, content, opts); else writeByPath(target, content, opts);
}

/** Read the frame at `path` for the editor through the same walk: no link on the way or at the name, a regular file with one name (a pipe opens at once
 *  and is refused instead of hanging the server). Throws FrameRefused (400 / 403); ENOENT and the like pass through. */
export function readFrame(path: string, opts: FrameIoOptions): string {
  return procFdUsable() ? readLinux(path, opts) : readByPath(path, opts);
}

/** The root of the file system `p` is on ('/' or a drive): the start of the walk when no folder above the target is a write root. */
export const fsRootOf = (p: string): string => parse(p).root;
