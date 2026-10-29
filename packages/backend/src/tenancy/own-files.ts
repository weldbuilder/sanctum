// The tenant-safe file layer (docs/MULTI-TENANT.md, "A tenant's own files"). Every write, append, mkdir, copy, rename and delete that can land inside a
// tenant folder goes through here. Tenancy off (no current tenant): each helper is the plain fs call it replaces (same arguments, same errors). In a tenant
// the target is normalised first and the helper FAILS CLOSED: a target not provably inside the tenant's folder (or one that cannot be decided) is refused,
// and a target provably outside is written only with the explicit `{ process: true }` option. Inside the folder it refuses a link at the target, a second
// hard link, or a link anywhere on the way to it, and writes by temp file (random name, opened `wx`, same folder) and rename, appends with O_NOFOLLOW. The
// rules live in scripts/own-files-lib.mjs (shared with `npm run setup`).
import { createReadStream, type CopySyncOptions, type MakeDirectoryOptions, type RmOptions, type WriteFileOptions, closeSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import type { Response } from 'express';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoTenantContext, bootedTenants, currentTenant, getProcessConfig, tenancyEnabled, tenantOrNull } from './context.js';
import { parseTenantsBlock } from './config.js';
import * as lib from '../../../../scripts/own-files-lib.mjs';

export { SCAN_LOG_ABOVE, SCAN_SKIPPED, scanStats, withScanMemo, tenantFilesProblem, tenantsDirProblem, tenantHoldsAppProblem, setTempNameForTest, setAfterReadCheckForTest } from '../../../../scripts/own-files-lib.mjs';

/** A write the current tenant may not make (a link, a hard link, a path that left its folder). The message is safe to send to the browser: absolute paths
 *  are cut to their last segment. */
export class TenantEditRefused extends lib.OwnFileRefused {
  constructor(reason: string) {
    // Only absolute paths are cut (a leading slash or a drive letter); a plain "Pacific/Auckland" or "docs/x.md" stays whole.
    super(reason.replace(/(?:^|(?<=[\s'"(:=]))(?:[A-Za-z]:)?[\\/](?:[^\\/\s'",;()]+[\\/])*[^\\/\s'",;()]+/g, (m) => m.split(/[\\/]/).pop() ?? ''));
    this.name = 'TenantEditRefused';
    this.stack = `${this.name}: ${this.message}`;
  }
}

/** The layer's own refusals, as TenantEditRefused (what the routes and plugins already catch). */
function wrap<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof lib.OwnFileRefused && !(e instanceof TenantEditRefused)) throw new TenantEditRefused(e.message);
    throw e;
  }
}
/** The tenant folder a write is guarded for. Tenancy off: '' (the plain fs call). Tenancy on: the current tenant's folder; with NO tenant context it THROWS
 *  NoTenantContext (a write that does not know whose it is must never fall through to plain fs, as the reads never do), unless the caller passed
 *  `{ process: true }`: then it is a process-level write and the answer is '' (plain). Inside a tenant `{ process: true }` is handled by the plan. */
const dirFor = (allow: boolean): string => {
  try { return tenantOrNull('a tenant write')?.dir ?? ''; } catch (e) { if (allow && e instanceof NoTenantContext) return ''; throw e; }
};
/** `{ process: true }`: the explicit allowance for a genuinely process-level write: one that runs with tenancy on and no tenant context (otherwise
 *  NoTenantContext), or inside a tenant context with a target provably outside the tenant's folder (otherwise refused). Every use is listed in docs/MULTI-TENANT.md. */
export interface ProcessAllowance { process?: boolean }
type WriteOpts = WriteFileOptions | (Exclude<WriteFileOptions, string | null | undefined> & ProcessAllowance);
const allowOf = (o: unknown): boolean => !!o && typeof o === 'object' && (o as ProcessAllowance).process === true;

/** Why the current tenant's own files may not be written now, or null: tenant.yaml, .env, .mcp.json, home/, private/ or data/ or anything directly in
 *  data/ or private/ became a link or is hard-linked (the quick check; boot and reload run the full scan), or `target` (a file a route is about to write)
 *  is a link, is hard-linked or sits behind a link. Null with tenancy off. The sentence is safe to send with a 400. */
export function tenantWriteRefusal(target?: string): string | null {
  const tenant = tenantOrNull('a tenant write');
  if (!tenant) return null;
  const folder = lib.tenantFilesProblem(tenant.dir, { quick: true });
  if (folder) return folder;
  return (target ? lib.ownWritePlan(tenant.dir, target).problem : '') || null;
}

/** Write a file a route owns, as utf-8 text. Tenancy off: `writeFileSync(path, text, 'utf-8')`. In a tenant: see ownWriteFile. */
export function writeOwnFile(path: string, text: string, opts?: ProcessAllowance): void { ownWriteFile(path, text, { encoding: 'utf-8', ...(opts?.process ? { process: true } : {}) }); }

export function ownWriteFile(path: string, data: string | NodeJS.ArrayBufferView, options?: WriteOpts): void { wrap(() => lib.ownWriteFile(dirFor(allowOf(options)), path, data, options as WriteFileOptions)); }
export function ownAppendFile(path: string, data: string | NodeJS.ArrayBufferView, options?: WriteOpts): void { wrap(() => lib.ownAppendFile(dirFor(allowOf(options)), path, data, options as WriteFileOptions)); }
/** ownMkdir for a tenant given by its folder (code that runs before, or outside, the tenant's context: boot, per-runtime helpers). */
export function ownMkdirIn(tenantDir: string, path: string, options?: MakeDirectoryOptions | number): string | undefined { return wrap(() => lib.ownMkdir(tenantDir, path, options) as string | undefined); }
/** ownWriteFile for a tenant given by its folder. */
export function ownWriteFileIn(tenantDir: string, path: string, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions): void { wrap(() => lib.ownWriteFile(tenantDir, path, data, options)); }
export function ownMkdir(path: string, options?: (MakeDirectoryOptions & ProcessAllowance) | number): string | undefined { return wrap(() => lib.ownMkdir(dirFor(typeof options === 'object' && allowOf(options)), path, options) as string | undefined); }
export function ownChmod(path: string, mode: number | string, opts?: ProcessAllowance): void { wrap(() => lib.ownChmod(dirFor(allowOf(opts)), path, mode, opts)); }
export function ownCopyFile(src: string, dest: string, flags = 0, opts?: ProcessAllowance): void { wrap(() => lib.ownCopyFile(dirFor(allowOf(opts)), src, dest, flags, opts)); }
export function ownCp(src: string, dest: string, options: CopySyncOptions & ProcessAllowance = {}): void { wrap(() => lib.ownCp(dirFor(allowOf(options)), src, dest, options)); }
export function ownRename(from: string, to: string, opts?: ProcessAllowance): void { wrap(() => lib.ownRename(dirFor(allowOf(opts)), from, to, opts)); }
export function ownRm(path: string, options?: RmOptions & ProcessAllowance): void { wrap(() => lib.ownRm(dirFor(allowOf(options)), path, options)); }
export function ownUnlink(path: string, opts?: ProcessAllowance): void { wrap(() => lib.ownUnlink(dirFor(allowOf(opts)), path, opts)); }
/** The `.sanctum-thread` marker the agent writes into its working folder on every chat turn (S1): the companion can write that folder, so it can plant a link
 *  at this name. In a tenant the write is refused over a link (never through it); the turn goes on either way. Returns what happened. */
export function writeThreadFile(cwd: string, threadId: string): 'written' | 'skipped' | 'refused' {
  try {
    if (!existsSync(cwd)) return 'skipped';
    ownWriteFile(join(cwd, '.sanctum-thread'), threadId);
    return 'written';
  } catch (e) { return e instanceof lib.OwnFileRefused ? 'refused' : 'skipped'; }
}

/** Throws TenantEditRefused when `path` (a file about to be written by a caller that does its own temp-and-rename) is a link, is hard-linked, sits behind a link,
 *  or is not provably inside the current tenant's folder (unless `{ process: true }`). Nothing with tenancy off. */
export function ownAssertWritable(path: string, opts?: ProcessAllowance): void { wrap(() => { const p = lib.ownWritePlan(dirFor(allowOf(opts)), path, 'write', allowOf(opts)).problem; if (p) throw new lib.OwnFileRefused(p); }); }
/** Throws when `path` (a folder about to be read and emptied) is a link, sits behind one, or is not provably inside the current tenant's folder. Nothing otherwise. */
export function ownAssertReal(path: string, opts?: ProcessAllowance): void { wrap(() => { const p = lib.ownWritePlan(dirFor(allowOf(opts)), path, 'assert-real', allowOf(opts)).problem; if (p) throw new lib.OwnFileRefused(p); }); }

/** Write a file by temp file and rename, in every mode: a random temp name opened `wx` in the same folder (a link planted at a guessable name is never
 *  written through), owner-only, then `mode` (default 0600) before the rename. In a tenant folder the target and the way to it are checked first. */
export function ownWriteFileAtomic(path: string, data: string | Buffer, opts: { mode?: number; dotTemp?: boolean; encoding?: BufferEncoding; process?: boolean } = {}): void { wrap(() => lib.ownWriteFileAtomic(dirFor(opts.process === true), path, data, opts)); }

// Async forms, for the call sites that already await fs/promises. The check is the same (a handful of lstats); the operation is the promise one.
/** The path an async helper goes on to use: the target normalised when it is a tenant's, the path itself with tenancy off (or `{ process: true }` with no
 *  tenant context). Throws TenantEditRefused (NoTenantContext with tenancy on, no tenant and no allowance). */
function planned(path: string, op: lib.WriteOp = 'write', allow = false): string {
  const p = lib.ownWritePlan(dirFor(allow), path, op, allow);
  if (p.problem) throw new TenantEditRefused(p.problem);
  return p.abs;
}
export async function ownMkdirAsync(path: string, options?: MakeDirectoryOptions & ProcessAllowance): Promise<void> { const s = lib.splitProcess(options); await fsp.mkdir(planned(path, 'mkdir', s.allow), s.options); }
export async function ownRenameAsync(from: string, to: string, opts?: ProcessAllowance): Promise<void> { await fsp.rename(planned(from, 'write', allowOf(opts)), planned(to, 'write', allowOf(opts))); }
export async function ownRmAsync(path: string, options?: RmOptions & ProcessAllowance): Promise<void> { const s = lib.splitProcess(options); await fsp.rm(planned(path, 'write', s.allow), s.options); }
/** writeFile. Tenancy off: fs.promises.writeFile. In a tenant the lib's synchronous write does it (one implementation of temp-and-rename, the append and
 *  exclusive flags, and the fail-closed rule): these are small files (a patch overlay, a sidecar), so the event loop is not held for long. */
export async function ownWriteFileAsync(path: string, data: string | NodeJS.ArrayBufferView, options?: WriteOpts): Promise<void> {
  const d = dirFor(allowOf(options));
  if (!d) { await fsp.writeFile(path, data, lib.splitProcess(options).options as WriteFileOptions); return; }
  wrap(() => lib.ownWriteFile(d, path, data, options as WriteFileOptions));
}


// ── Reads fail closed ─────────────────────────────────────────────────────────
// In a tenant every read of a path goes through these. A path outside the tenant's folder is refused unless the caller passes `{ shipped: true }`, and
// then only the shipped plugin root and the app's static assets are allowed (never the app's .env, its database, or another tenant's folder). Inside the
// folder a link, a hard-linked file, a path behind a link, a pipe/socket/device is refused. Tenancy off: the plain call.
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
let shippedOverride: string[] | null = null;
/** Test seam: the roots `{ shipped: true }` allows. Pass null to restore. */
export function setShippedReadRootsForTests(roots: string[] | null): void { shippedOverride = roots; }
/** The app's own read-only files: the shipped plugins and the built frontend. */
export function shippedReadRoots(): string[] {
  return shippedOverride ?? [join(APP_ROOT, 'plugins'), join(APP_ROOT, 'packages', 'frontend', 'build'), ...registeredShipped.flatMap((f) => { try { return f(); } catch { return []; } })];
}
const registeredShipped: Array<() => string[]> = [];
/** The plugin loader names the shipped plugin root it reads (it can be moved for tests), so `{ shipped: true }` follows it. */
export function registerShippedReadRoots(fn: () => string[]): void { registeredShipped.push(fn); }
export interface ReadOpts { shipped?: boolean; /** 'file': a regular file only (a folder is refused) */ kind?: 'file' }
const readDirOf = (): string => tenantOrNull('a tenant read')?.dir ?? '';
const readOptsOf = (o?: ReadOpts) => ({ ...(o?.shipped ? { shipped: shippedReadRoots() } : {}), ...(o?.kind ? { kind: o.kind } : {}) });

/** Throws TenantEditRefused when `path` may not be read by the current tenant (outside its folder without `{ shipped: true }`, a link, hard-linked, behind a link,
 *  not a regular file or folder). Tenancy off: nothing. */
export function ownAssertReadable(path: string, opts?: ReadOpts): void { wrap(() => { const p = lib.ownReadProblem(readDirOf(), path, readOptsOf(opts)); if (p) throw new lib.OwnFileRefused(p); }); }
/** true when `path` may be opened for reading (see ownAssertReadable). */
export function ownReadable(path: string, opts?: ReadOpts): boolean { return !lib.ownReadProblem(readDirOf(), path, readOptsOf(opts)); }
/** readFileSync through the read guard (opened without following a link; the open handle checked). Tenancy off: the plain call. */
export function readOwn(path: string, opts?: ReadOpts): Buffer { return wrap(() => lib.ownReadFile(readDirOf(), path, readOptsOf(opts)) as Buffer); }
/** readFileSync(path, 'utf-8') through the read guard. */
export function readOwnText(path: string, opts?: ReadOpts): string { return wrap(() => lib.ownReadFile(readDirOf(), path, { ...readOptsOf(opts), encoding: 'utf-8' }) as string); }
const realOf = (p: string): string => { try { return lib.nativeReal(p); } catch { return resolve(p); } };
/** With tenancy on, a folder named to readOwnIn/readOwnTextIn must be inside the configured tenants.dir (by realpath) or be a registered tenant's folder; anything
 *  else is refused. Tenancy off: nothing. */
function assertTenantFolder(tenantDir: string): void {
  if (!tenancyEnabled()) return;
  const real = realOf(tenantDir);
  const inside = (root: string): boolean => { const r = relative(root, real); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };
  let block: ReturnType<typeof parseTenantsBlock>;
  try { block = parseTenantsBlock(getProcessConfig()); } catch { block = null; } // (no process config loaded: the same unit-test shape)
  // (Tenancy on with no process config or no tenants block is a unit-test shape; a real tenant-mode process always has both.)
  if (!block) return;
  if (inside(realOf(block.dir))) return;
  if (bootedTenants().some((t) => realOf(t.dir) === real)) return;
  throw new TenantEditRefused('that folder is not inside the tenants folder');
}
/** readOwn for a tenant given by its folder (code that runs before, or outside, the tenant's context: boot, reload, the loose readers of a tenant that
 *  failed to load). The same guarded open. */
export function readOwnIn(tenantDir: string, path: string, opts?: ReadOpts): Buffer { assertTenantFolder(tenantDir); return wrap(() => lib.ownReadFile(tenantDir, path, readOptsOf(opts)) as Buffer); }
/** readOwnText for a tenant given by its folder. */
export function readOwnTextIn(tenantDir: string, path: string, opts?: ReadOpts): string { assertTenantFolder(tenantDir); return wrap(() => lib.ownReadFile(tenantDir, path, { ...readOptsOf(opts), encoding: 'utf-8' }) as string); }
/** For a file the PROCESS names, never a request: a default that ships with the app (outside every tenant folder: read plainly) or a path confinement put in the
 *  tenant's folder (read through the guard, so a link planted there is refused). Anything that touches the tenant folder by any spelling is guarded. Tenancy off: plain. */
export function readOwnOrApp(path: string): string;
export function readOwnOrApp(path: string, encoding: null): Buffer;
export function readOwnOrApp(path: string, encoding: BufferEncoding | null = 'utf-8'): string | Buffer {
  const rt = currentTenant();
  const guarded = !!rt && lib.ownTouches(rt.dir, path);
  if (guarded) return encoding === null ? readOwn(path) : readOwnText(path);
  return encoding === null ? readFileSync(path) : readFileSync(path, encoding);
}
/** readOwnOrApp's async form, for a caller that already awaits fs/promises: a path inside the current tenant's folder is read through the guard; anything else (and
 *  tenancy off) is `fs.promises.readFile(path, 'utf-8')`. */
export async function readOwnOrAppAsync(path: string): Promise<string> {
  const rt = currentTenant();
  if (rt && lib.ownTouches(rt.dir, path)) return readOwnText(path);
  return fsp.readFile(path, 'utf-8');
}
/** readdirSync through the read guard. */
export function ownReadDir(path: string, opts?: ReadOpts): string[];
export function ownReadDir(path: string, opts: ReadOpts & { withFileTypes: true }): Dirent[];
export function ownReadDir(path: string, opts?: ReadOpts & { withFileTypes?: boolean }): string[] | Dirent[] {
  return wrap(() => lib.ownReadDir(readDirOf(), path, { ...readOptsOf(opts), ...(opts?.withFileTypes ? { options: { withFileTypes: true } } : {}) }));
}
/** statSync through the read guard. */
export function ownStat(path: string, opts?: ReadOpts): Stats { return wrap(() => lib.ownStat(readDirOf(), path, readOptsOf(opts)) as Stats); }
/** Open a file for reading through the read guard and return its open handle: `{ fd, stat }` (stat is fstat of the handle). Tenancy off: the plain
 *  `openSync(path, 'r')`. In a tenant the path is checked, opened O_RDONLY | O_NOFOLLOW | O_NONBLOCK (a pipe swapped in after the check opens at once, it never
 *  blocks the event loop), and the open handle must be a regular file with one hard link: there is never a check followed by a plain open of the path. The
 *  caller closes `fd`. For tailing and streaming. */
export function ownOpenRead(path: string, opts?: ReadOpts): { fd: number; stat: Stats } { return wrap(() => lib.ownOpenRead(readDirOf(), path, readOptsOf(opts))); }

/** res.sendFile through the read guard: tenancy off, the plain call. In a tenant the file is opened with ownOpenRead (no link followed, no pipe waited on, the
 *  handle checked) and streamed FROM THE HANDLE; the path never reaches express, so a link swapped in after the check is never served. Content-Type (kept when
 *  the caller set one), Content-Length, a weak ETag (`W/"<size>-<mtimeMs>"`), Last-Modified and Accept-Ranges are set; HEAD sends no body. As express does, a
 *  conditional GET is answered first: If-None-Match (or If-Modified-Since) that still matches is a 304, even with a Range. Otherwise a single Range is 206 and an
 *  unsatisfiable one 416 (an If-Range that does not match ignores the Range). A file that is gone by the time it is opened is a 404. */
export function sendOwnFile(res: Response, path: string, opts?: ReadOpts): void {
  const tenant = tenantOrNull('a tenant read');
  if (!tenant) { res.sendFile(path); return; }
  let opened: { fd: number; stat: Stats };
  try { opened = ownOpenRead(path, { ...opts, kind: 'file' }); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') { res.status(404).json({ error: 'File not found' }); return; }
    throw e;
  }
  const { fd, stat } = opened;
  const req = res.req;
  try {
    const size = stat.size;
    const etag = `W/"${size}-${stat.mtimeMs}"`;
    if (!res.getHeader('Content-Type')) res.type(extname(path) || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    if (req.fresh) { // (express's own check: If-None-Match against the ETag, else If-Modified-Since; before any Range, as send() does)
      res.status(304).end();
      closeSync(fd);
      return;
    }
    let start = 0;
    let end = size - 1;
    let status = 200;
    const ifRange = String(req.headers['if-range'] ?? '');
    const rangeStands = !ifRange || (/^\s*(?:W\/)?"/.test(ifRange) ? ifRange.trim() === etag && !etag.startsWith('W/') : Date.parse(ifRange) >= Math.floor(stat.mtimeMs / 1000) * 1000);
    const ranges = req.headers.range && rangeStands ? req.range(size) : undefined;
    if (ranges === -1) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.setHeader('Content-Length', '0');
      res.end();
      closeSync(fd);
      return;
    }
    if (Array.isArray(ranges) && (ranges as { type?: string }).type === 'bytes' && ranges.length === 1) {
      start = ranges[0].start; end = ranges[0].end; status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    const length = size === 0 ? 0 : end - start + 1;
    res.status(status).setHeader('Content-Length', String(length));
    if (req.method === 'HEAD' || length === 0) { res.end(); closeSync(fd); return; }
    const stream = createReadStream(null as unknown as string, { fd, start, end, autoClose: true });
    stream.on('error', () => { res.destroy(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) { try { closeSync(fd); } catch { /* closed */ } throw e; }
}
