// Round 7 of stage 4, the tenant file layer: item 1 (every read of a tenant file is a guarded open: the identity journal, tenant.yaml at reload, the token file at boot),
// item 5 (a write with tenancy on and no tenant context throws NoTenantContext unless `{ process: true }`), item 6 (the inode check after the open, every platform),
// item 7 (sendOwnFile: ETag, conditional GET with Range, a file gone before the open is a 404), item 8 (ownCp refuses a pipe in the tree). A writer process is started on
// every FIFO that could be read, so a wrong open would deliver bytes and fail the test rather than hang it; the one case that cannot have a writer (the journal)
// runs in a child process with a timeout. Posix cases skip on Windows. No provider, no model run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NoTenantContext, enableTenancy, registerProcessConfig, runInTenant } from './context.js';
import { fakeRuntime, processConfigFor, safeTenantYaml } from './test-runtime.js';
import { createTenantRuntime } from './runtime.js';
import { loadTenantConfig } from './config.js';
import {
  TenantEditRefused, ownAppendFile, ownAssertReal, ownAssertWritable, ownChmod, ownCopyFile, ownCp, ownMkdir, ownMkdirAsync, ownOpenRead, ownRename, ownRenameAsync, ownRm, ownRmAsync,
  ownUnlink, ownWriteFile, ownWriteFileAsync, ownWriteFileAtomic, sendOwnFile, setAfterReadCheckForTest, withScanMemo, tenantFilesProblem, writeOwnFile,
} from './own-files.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, '..', '..');
const posix = process.platform !== 'win32';
const made: string[] = [];
const children: ChildProcess[] = [];
const dbs: Array<{ close(): void }> = [];
interface World { top: string; ada: string; bea: string }
function world(): World {
  const top = mkdtempSync(join(tmpdir(), 'sanctum-r7-'));
  made.push(top);
  const ada = join(top, 'tenants', 'ada');
  const bea = join(top, 'tenants', 'bea');
  for (const t of [ada, bea]) for (const d of ['home', 'data']) mkdirSync(join(t, d), { recursive: true });
  return { top, ada, bea };
}
const inTenant = <T>(w: World, fn: () => T): T => runInTenant(fakeRuntime('ada', { dir: w.ada, dataDir: join(w.ada, 'data'), homeDir: join(w.ada, 'home') }), fn);
function fifoWithWriter(path: string, payload: string): void {
  execFileSync('mkfifo', [path]);
  children.push(spawn('sh', ['-c', 'printf "%s" "$0" > "$1"', payload, path], { stdio: 'ignore' }));
}
function swapOnce(swap: (abs: string) => void): void {
  let done = false;
  setAfterReadCheckForTest((abs) => { if (done) return; done = true; swap(abs); });
}
const tryLink = (target: string, at: string): boolean => { try { symlinkSync(target, at, 'file'); return true; } catch { return false; } };

beforeEach(() => enableTenancy(true));
afterEach(() => {
  setAfterReadCheckForTest(null);
  enableTenancy(false);
  registerProcessConfig(() => null);
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dbs.splice(0)) { try { d.close(); } catch { /* closed */ } }
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── Item 1 ────────────────────────────────────────────────────────────────────
describe('item 1: the remaining plain reads of a tenant file are guarded opens', () => {
  it.runIf(posix)('checkIdentity with a FIFO at journal.jsonl (no writer) returns without blocking, as a refusal: a plain open of it would hang the whole process', () => {
    const w = world();
    mkdirSync(join(w.ada, 'home', 'identity'), { recursive: true });
    writeFileSync(join(w.ada, 'home', 'identity', 'profile.md'), 'p\n');
    writeFileSync(join(w.ada, 'home', 'identity', 'companion.md'), 'c\n');
    mkdirSync(join(w.ada, 'data', 'identity'), { recursive: true });
    execFileSync('mkfifo', [join(w.ada, 'data', 'identity', 'journal.jsonl')]);
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/test-helpers/fifo-journal-child.ts', w.ada], { cwd: backendDir, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' });
    expect(run.signal, `the child hung (a plain open of the FIFO)\n${run.stderr}`).toBeNull();
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split('\n').pop() as string) as { state: string; detail: string };
    expect(out.detail).toMatch(/could not be written/);
  }, 60_000);

  it.runIf(posix)('rt.reload() with tenant.yaml swapped for a FIFO after the folder scan: refused, the writer\'s bytes are not read, the config and hosts are unchanged', () => {
    const w = world();
    writeFileSync(join(w.ada, 'tenant.yaml'), safeTenantYaml('hosts: [ada.example.net]\n'));
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    registerProcessConfig(() => proc);
    const rt = createTenantRuntime(proc, 'ada', w.ada);
    dbs.push(rt.db);
    const before = JSON.stringify(rt.config);
    withScanMemo(() => {
      expect(tenantFilesProblem(w.ada)).toBe(''); // (the scan has looked: a clean folder; the swap comes after it)
      rmSync(join(w.ada, 'tenant.yaml'));
      fifoWithWriter(join(w.ada, 'tenant.yaml'), 'hosts: [evil.example.net]\n');
      expect(() => rt.reload()).toThrow(/not a regular file|cannot be read/);
    });
    expect(JSON.stringify(rt.config)).toBe(before);
    expect(rt.hosts).toEqual(['ada.example.net']);
  });

  it.runIf(posix)('createTenantRuntime with data/.internal-token swapped for a FIFO after the scan: refused (the tenant is skipped at boot), the writer\'s bytes are never the token', () => {
    const w = world();
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    withScanMemo(() => {
      expect(tenantFilesProblem(w.ada)).toBe('');
      fifoWithWriter(join(w.ada, 'data', '.internal-token'), 'f'.repeat(64));
      expect(() => createTenantRuntime(proc, 'ada', w.ada)).toThrow(/not a regular file|cannot be read|resolves/);
    });
    // And the real boot order, with no memo: the scan refuses the FIFO first, the same way.
    expect(() => createTenantRuntime(proc, 'ada', w.ada)).toThrow(/not a regular file/);
  });

  it.runIf(posix)('an .env that is a FIFO is refused at load too (the writer\'s bytes are not parsed into the tenant\'s keys)', () => {
    const w = world();
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    withScanMemo(() => {
      expect(tenantFilesProblem(w.ada)).toBe('');
      fifoWithWriter(join(w.ada, '.env'), 'APP_PASSWORD=stolen\n');
      expect(() => loadTenantConfig(proc, w.ada, 'ada')).toThrow(/tenant ada: .*not a regular file/);
    });
  });
});

// ── Item 5 ────────────────────────────────────────────────────────────────────
describe('item 5: a write with tenancy on and no tenant context throws NoTenantContext, as the reads do', () => {
  it('every write helper, sync and async, throws and writes nothing; with { process: true } it is the plain call', async () => {
    const w = world();
    const f = join(w.top, 'process-file');
    writeFileSync(f, 'old');
    const d = join(w.top, 'process-dir');
    const calls: Array<[string, (allow?: { process: true }) => unknown]> = [
      ['ownWriteFile', (a) => ownWriteFile(join(w.top, 'a'), 'x', a ? { process: true } : undefined)],
      ['writeOwnFile', (a) => writeOwnFile(join(w.top, 'b'), 'x', a)],
      ['ownAppendFile', (a) => ownAppendFile(join(w.top, 'c'), 'x', a ? { process: true } : undefined)],
      ['ownMkdir', (a) => ownMkdir(d, a ? { recursive: true, process: true } : { recursive: true })],
      ['ownChmod', (a) => ownChmod(f, 0o644, a)],
      ['ownCopyFile', (a) => ownCopyFile(f, join(w.top, 'copy'), 0, a)],
      ['ownCp', (a) => ownCp(f, join(w.top, 'cp'), a ? { process: true } : {})],
      ['ownRename', (a) => ownRename(join(w.top, 'copy'), join(w.top, 'renamed'), a)],
      ['ownWriteFileAtomic', (a) => ownWriteFileAtomic(join(w.top, 'e'), 'x', a ? { process: true } : {})],
      ['ownAssertWritable', (a) => ownAssertWritable(join(w.top, 'nothing'), a)],
      ['ownAssertReal', (a) => ownAssertReal(w.top, a)],
      ['ownUnlink', (a) => ownUnlink(join(w.top, 'renamed'), a)],
      ['ownRm', (a) => ownRm(join(w.top, 'cp'), a ? { force: true, process: true } : { force: true })],
    ];
    const before = new Set(readdirTop(w.top));
    for (const [name, call] of calls) expect(() => call(), name).toThrow(NoTenantContext);
    expect(new Set(readdirTop(w.top))).toEqual(before);
    expect(readFileSync(f, 'utf8')).toBe('old');
    for (const [name, call] of calls) expect(() => call({ process: true }), name).not.toThrow();
    expect(readFileSync(join(w.top, 'a'), 'utf8')).toBe('x');
    expect(existsSync(join(w.top, 'renamed'))).toBe(false); // (copied, renamed, then unlinked, in that order)
    // The async forms.
    await expect(ownMkdirAsync(join(w.top, 'am'))).rejects.toThrow(NoTenantContext);
    await expect(ownWriteFileAsync(join(w.top, 'aw'), 'x')).rejects.toThrow(NoTenantContext);
    await expect(ownRenameAsync(f, join(w.top, 'ar'))).rejects.toThrow(NoTenantContext);
    await expect(ownRmAsync(f)).rejects.toThrow(NoTenantContext);
    expect(readFileSync(f, 'utf8')).toBe('old');
    await ownMkdirAsync(join(w.top, 'am'), { process: true });
    await ownWriteFileAsync(join(w.top, 'aw'), 'x', { process: true });
    await ownRenameAsync(join(w.top, 'aw'), join(w.top, 'ar'), { process: true });
    await ownRmAsync(join(w.top, 'ar'), { process: true });
    expect(existsSync(join(w.top, 'am'))).toBe(true);
    expect(existsSync(join(w.top, 'ar'))).toBe(false);
  });
  it('inside a tenant the helpers are as before (a write in its folder works); tenancy off: the plain call, no flag needed', () => {
    const w = world();
    inTenant(w, () => ownWriteFile(join(w.ada, 'home', 'ok.txt'), 'in'));
    expect(readFileSync(join(w.ada, 'home', 'ok.txt'), 'utf8')).toBe('in');
    enableTenancy(false);
    ownWriteFile(join(w.top, 'plain'), 'off');
    expect(readFileSync(join(w.top, 'plain'), 'utf8')).toBe('off');
  });
});
const readdirTop = (p: string): string[] => { try { return readdirSync(p); } catch { return []; } };

// ── Item 6 ────────────────────────────────────────────────────────────────────
describe('item 6: the open handle is compared with what was checked (inode and device), on every platform', () => {
  it('a regular file swapped for ANOTHER regular file (a different inode) after the check is refused, and the right file opens when nothing changes', () => {
    const w = world();
    const f = join(w.ada, 'data', 'f.txt');
    writeFileSync(f, 'checked');
    const ok = inTenant(w, () => ownOpenRead(f, { kind: 'file' }));
    closeSync(ok.fd);
    const inoBefore = statSync(f, { bigint: true }).ino;
    // (the new file is made while the old one still exists, then renamed over it: a file made after a delete may be handed the same inode number)
    swapOnce((abs) => { writeFileSync(`${abs}.new`, 'swapped-in'); renameSync(`${abs}.new`, abs); });
    expect(() => inTenant(w, () => ownOpenRead(f, { kind: 'file' }))).toThrow(/changed while it was being opened/);
    expect(readFileSync(f, 'utf8')).toBe('swapped-in');
    expect(statSync(f, { bigint: true }).ino).not.toBe(inoBefore);
  });
  it('a regular file swapped for a link to another tenant\'s file after the check is refused (O_NOFOLLOW where there is one, the inode comparison where there is not)', () => {
    const w = world();
    writeFileSync(join(w.bea, 'data', 'secret.txt'), 'BEA-SECRET');
    const f = join(w.ada, 'data', 'f.txt');
    writeFileSync(f, 'checked');
    if (!tryLink(join(w.bea, 'data', 'secret.txt'), join(w.top, 'probe'))) return; // (links need privileges on Windows)
    let delivered = false;
    swapOnce((abs) => { rmSync(abs); tryLink(join(w.bea, 'data', 'secret.txt'), abs); });
    try { const o = inTenant(w, () => ownOpenRead(f, { kind: 'file' })); closeSync(o.fd); delivered = true; } catch (e) { expect(e).toBeInstanceOf(TenantEditRefused); }
    expect(delivered).toBe(false);
  });
  it('a file created between the check and the open where there was none is refused too (nothing was checked)', () => {
    const w = world();
    const f = join(w.ada, 'data', 'late.txt');
    swapOnce((abs) => { writeFileSync(abs, 'appeared'); });
    expect(() => inTenant(w, () => ownOpenRead(f, { kind: 'file' }))).toThrow(/changed while it was being opened|ENOENT/);
  });
});

// ── Item 7 ────────────────────────────────────────────────────────────────────
describe('item 7: sendOwnFile, like express', () => {
  let server: http.Server;
  let port = 0;
  let w: World;
  const body = 'abcdefghijklmnopqrstuvwxyz'.repeat(4);
  const get = (name: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; buf: Buffer }> => new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: `/send/${name}`, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });
  beforeEach(async () => {
    w = world();
    writeFileSync(join(w.ada, 'data', 'f.txt'), body);
    utimesSync(join(w.ada, 'data', 'f.txt'), new Date('2026-01-02T03:04:05.678Z'), new Date('2026-01-02T03:04:05.678Z'));
    const app = express();
    const rt = fakeRuntime('ada', { dir: w.ada, dataDir: join(w.ada, 'data'), homeDir: join(w.ada, 'home') });
    app.get('/send/:name', (req, res) => {
      try { runInTenant(rt, () => sendOwnFile(res, join(w.ada, 'data', req.params.name))); }
      catch (e) { res.status(e instanceof TenantEditRefused ? 400 : 500).json({ error: (e as Error).message }); }
    });
    await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  it('a weak ETag of the size and mtime in ms; If-None-Match with it (or a list holding it, or *) is a 304 with no body; another value is a 200', async () => {
    const st = statSync(join(w.ada, 'data', 'f.txt'));
    const etag = `W/"${st.size}-${st.mtimeMs}"`;
    const first = await get('f.txt');
    expect(first.headers.etag).toBe(etag);
    expect(first.status).toBe(200);
    for (const inm of [etag, `"other", ${etag}`, '*']) {
      const r = await get('f.txt', { 'if-none-match': inm });
      expect(r.status, inm).toBe(304);
      expect(r.buf.length).toBe(0);
    }
    const other = await get('f.txt', { 'if-none-match': 'W/"1-1"' });
    expect(other.status).toBe(200);
    expect(other.buf.toString()).toBe(body);
  });
  it('If-Modified-Since together with Range is a 304 when the file has not changed (as express answers), and a Range alone is a 206', async () => {
    const first = await get('f.txt');
    const both = await get('f.txt', { range: 'bytes=0-3', 'if-modified-since': String(first.headers['last-modified']) });
    expect(both.status).toBe(304);
    expect(both.buf.length).toBe(0);
    const bothEtag = await get('f.txt', { range: 'bytes=0-3', 'if-none-match': String(first.headers.etag) });
    expect(bothEtag.status).toBe(304);
    const only = await get('f.txt', { range: 'bytes=0-3' });
    expect(only.status).toBe(206);
    expect(only.buf.toString()).toBe(body.slice(0, 4));
    // An If-Modified-Since from before the file's mtime is not fresh: the range is served.
    const stale = await get('f.txt', { range: 'bytes=0-3', 'if-modified-since': new Date('2020-01-01T00:00:00Z').toUTCString() });
    expect(stale.status).toBe(206);
  });
  it('an If-Range that does not match ignores the Range (200, the whole file); a matching date serves it (206)', async () => {
    const first = await get('f.txt');
    const mismatch = await get('f.txt', { range: 'bytes=0-3', 'if-range': new Date('2020-01-01T00:00:00Z').toUTCString() });
    expect(mismatch.status).toBe(200);
    expect(mismatch.buf.toString()).toBe(body);
    const weak = await get('f.txt', { range: 'bytes=0-3', 'if-range': String(first.headers.etag) });
    expect(weak.status).toBe(200); // (a weak validator never satisfies If-Range)
    const match = await get('f.txt', { range: 'bytes=0-3', 'if-range': String(first.headers['last-modified']) });
    expect(match.status).toBe(206);
  });
  it('a file deleted between the check and the open is a 404, not a 500', async () => {
    swapOnce((abs) => { rmSync(abs); });
    const r = await get('f.txt');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.buf.toString()).error).toBe('File not found');
    const missing = await get('never-there.txt');
    expect(missing.status).toBe(404);
  });
});

// ── Item 8 ────────────────────────────────────────────────────────────────────
describe('item 8: ownCp refuses a pipe in the tree cleanly', () => {
  it.runIf(posix)('a tree holding a FIFO: refused with the layer\'s sentence naming it, nothing copied, not Node\'s internal assertion', () => {
    const w = world();
    const src = join(w.ada, 'home', 'tree');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'A');
    execFileSync('mkfifo', [join(src, 'sub', 'pipe')]);
    const dest = join(w.ada, 'home', 'copy');
    let err: unknown;
    try { inTenant(w, () => ownCp(src, dest, { recursive: true })); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TenantEditRefused);
    expect((err as Error).message).toMatch(/sub\/pipe in the copied tree is not a regular file or folder \(a pipe, socket or device\)/);
    expect((err as Error).message).not.toMatch(/INTERNAL_ASSERTION|Unreachable/);
    expect(existsSync(dest)).toBe(false);
  });
  it.runIf(posix)('a FIFO as the source itself is refused the same way; a clean tree still copies, links left out', () => {
    const w = world();
    execFileSync('mkfifo', [join(w.ada, 'home', 'p')]);
    expect(() => inTenant(w, () => ownCp(join(w.ada, 'home', 'p'), join(w.ada, 'home', 'p2')))).toThrow(TenantEditRefused);
    const src = join(w.ada, 'home', 'ok');
    mkdirSync(src);
    writeFileSync(join(src, 'a.txt'), 'A');
    inTenant(w, () => ownCp(src, join(w.ada, 'home', 'ok2'), { recursive: true }));
    expect(readFileSync(join(w.ada, 'home', 'ok2', 'a.txt'), 'utf8')).toBe('A');
  });
});
