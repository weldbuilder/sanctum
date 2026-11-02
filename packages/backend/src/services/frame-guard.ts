// The file-level half of the Claude frame editor's guard (routes/api.ts: GET/PUT /prompts/system). The route judges the PATH (links, hard links, the app's
// own folders); a path check followed by a path write can be raced (a folder swapped for a link in between), so the save and the read here go through an OPEN
// DESCRIPTOR that is verified by inode: what is written is the very file that was checked, and never one of the app's own tracked prompt files.
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { join, sep } from 'node:path';

/** A refusal the route answers with: `status` is the HTTP code (400 a link, a hard link, not a regular file; 403 the app's own files), `message` is safe to show. */
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

// --- The app's own files ---------------------------------------------------------------------------------------------------------------------------------
/** A file by identity. bigint: a Windows file id is wider than a double. */
const keyOf = (st: { dev: bigint | number; ino: bigint | number }): string => `${st.dev}:${st.ino}`;

/** The identities (dev:ino) of the app's own tracked prompt files: every file in `<root>/prompts/` and `<root>/companion-home/config/` that exists, by stat
 *  (following a link: a link to one of them is that file). Missing folders and files are skipped. Taken once per request. */
export function protectedFrameFiles(root: string): Set<string> {
  const set = new Set<string>();
  for (const dir of [join(root, 'prompts'), join(root, 'companion-home', 'config')]) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      try { const st = statSync(join(dir, name), { bigint: true }); if (st.isFile()) set.add(keyOf(st)); } catch { /* gone, or a dangling link */ }
    }
  }
  return set;
}

/** 403 when the open handle `fd` is one of the protected files, by inode. This is the check that holds when every path check passed: whatever the path
 *  spelled at the time, the descriptor IS the tracked file. */
export function assertNotProtectedInode(fd: number, protectedSet: ReadonlySet<string>): void {
  if (protectedSet.has(keyOf(fstatSync(fd, { bigint: true })))) throw new FrameRefused(403, "The frame is never saved into the app's own prompts/ or companion-home/ folder");
}

/** 400 unless the open handle is a regular file with a single name. */
export function assertRegularSingleLink(fd: number, label: string): void {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new FrameRefused(400, `${label} is not a regular file; the frame is saved only to a plain file`);
  if (st.nlink > 1) throw new FrameRefused(400, `${label} is hard-linked; the frame is not saved through a second name for another file`);
}

/** Where the open handle really is (Linux: /proc/self/fd). A file created through a folder swapped for a link into the app's folders is a NEW inode, so the
 *  protected set cannot name it; its real location can. '' where the platform cannot say. */
function realPathOfFd(fd: number): string {
  if (process.platform !== 'linux') return '';
  try { return realpathSync.native(`/proc/self/fd/${fd}`); } catch { return ''; }
}

// --- Test seam -------------------------------------------------------------------------------------------------------------------------------------------
let beforeOpen: ((target: string) => void) | null = null;
/** Test seam: `fn(target)` runs after every path check and before the descriptor is opened (a test swaps a folder for a link there, the race the descriptor
 *  must survive). null restores. */
export function setBeforeFrameOpenForTest(fn: ((target: string) => void) | null): void { beforeOpen = fn; }

// --- Write -----------------------------------------------------------------------------------------------------------------------------------------------
/** Save `content` to `target` through a descriptor. `protectedSet` is protectedFrameFiles(PROJECT_ROOT), taken by the caller once. The target is opened
 *  O_WRONLY | O_NOFOLLOW | O_NONBLOCK (no O_TRUNC: nothing is emptied before the file is known to be the right one; a pipe swapped in does not block), and
 *  when nothing is there, again with O_CREAT | O_EXCL (a file this call makes is always its own, never made through a link). The descriptor must be a regular file with one name and not a protected inode, and only then is it truncated and written. The path is never written again.
 *  Where the platform has no O_NOFOLLOW (`constants.O_NOFOLLOW === undefined`, Windows) the open can follow a link, so the lstat taken just before the open
 *  must name the very file the descriptor is (the same second check the tenant layer uses there); the inode check against the protected set holds either way.
 *  `appFolders` (both spellings of the app's prompts/ and companion-home/) is the second check, by where the open handle really is (Linux): it catches a NEW file
 *  created through a folder swapped for a link, which no inode list can name. Throws FrameRefused. Closes the descriptor on every path. */
export function writeFrameThroughFd(target: string, content: string, protectedSet: ReadonlySet<string>, appFolders: readonly string[] = []): void {
  beforeOpen?.(target);
  const noFollow = constants.O_NOFOLLOW;
  let seen: { ino: bigint; dev: bigint } | null = null;
  if (noFollow === undefined) { try { const st = lstatSync(target, { bigint: true }); seen = { ino: st.ino, dev: st.dev }; } catch { seen = null; } }
  const base = constants.O_WRONLY | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number;
  let created = false; // (this call made the file: if it is then refused, the empty file it made is taken away again)
  try {
    // An existing file is opened as it is (no O_TRUNC). One that is not there is created exclusively, so a creation is always ours (O_CREAT, never through a link).
    try { fd = openSync(target, base); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; fd = openSync(target, base | constants.O_CREAT | constants.O_EXCL, 0o644); created = true; }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new FrameRefused(400, 'The frame file is a link; the frame is not saved through a link');
    if (code === 'ENXIO') throw new FrameRefused(400, 'The frame file is not a regular file; the frame is saved only to a plain file'); // (a pipe with no reader)
    throw e;
  }
  try {
    assertRegularSingleLink(fd, 'The frame file');
    assertNotProtectedInode(fd, protectedSet);
    if (noFollow === undefined && seen) { const now = fstatSync(fd, { bigint: true }); if (now.ino !== seen.ino || now.dev !== seen.dev) throw new FrameRefused(400, 'The frame file changed while it was being opened'); }
    const where = realPathOfFd(fd);
    if (where && appFolders.some((d) => underFolder(where, d))) throw new FrameRefused(403, "The frame is never saved into the app's own prompts/ or companion-home/ folder");
    ftruncateSync(fd, 0);
    const bytes = Buffer.from(content, 'utf8');
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at, at);
    fsyncSync(fd);
  } catch (e) {
    if (created) removeIfSame(target, fd);
    throw e;
  } finally { closeSync(fd); }
}

/** Take away the file this call created and then refused, but only if the path still names that very inode. */
function removeIfSame(target: string, fd: number): void {
  try {
    const mine = fstatSync(fd, { bigint: true });
    const there = lstatSync(target, { bigint: true });
    if (there.ino === mine.ino && there.dev === mine.dev) unlinkSync(target);
  } catch { /* already gone, or not ours to remove */ }
}

// --- Read ------------------------------------------------------------------------------------------------------------------------------------------------
/** Read the frame for the editor (single-tenant mode; a tenant's read has the tenant layer's own guard). Opened O_RDONLY | O_NOFOLLOW | O_NONBLOCK (a link is
 *  refused, a pipe opens at once and is refused instead of hanging the server), the descriptor must be a regular file, and the bytes come from the descriptor.
 *  Throws FrameRefused (400) for a link or a file that is not regular; ENOENT and the like pass through. */
export function readFrameThroughFd(path: string): string {
  // (No O_NOFOLLOW on Windows: the open would follow a link, so the link is refused by name first. Elsewhere the open itself refuses it.)
  if (constants.O_NOFOLLOW === undefined) { try { if (lstatSync(path).isSymbolicLink()) throw new FrameRefused(400, 'The frame file is a link; the editor does not read through a link'); } catch (e) { if (e instanceof FrameRefused) throw e; } }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new FrameRefused(400, 'The frame file is a link; the editor does not read through a link');
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new FrameRefused(400, 'The frame file is not a regular file; the editor reads only a plain file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
