// Round 6, items 2, 3 and 4: no tenant path is ever checked and then opened by name. Every read opens through ownOpenRead (O_RDONLY | O_NOFOLLOW |
// O_NONBLOCK, then fstat: a regular file with one link), so a pipe or link swapped in AFTER the check is refused without blocking the event loop. The checks
// themselves are made to pass (the after-check seam swaps the file in the gap), and a writer process is started on every FIFO so that a wrong open would
// deliver bytes and fail the test rather than hang it. sendOwnFile streams from the open handle. Posix cases skip on Windows. No provider, no model run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { enableTenancy, runInTenant } from './context.js';
import { fakeRuntime, makeTenantsDir, processConfigFor } from './test-runtime.js';
import { loadTenantConfig } from './config.js';
import { TenantEditRefused, ownOpenRead, readOwnOrApp, sendOwnFile, setAfterReadCheckForTest } from './own-files.js';
import { createRolling } from '../services/rolling-context.js';
import { readLogs } from '../services/logs.js';
import { createTranscript } from '../services/discord/public-transcript.js';
import { encryptSecret } from '../services/google-auth.js';
import { loadPlugins, pluginHelp } from '../services/plugins.js';
import { IdentitySourceError, readFolder } from '../services/identity/source.js';

const posix = process.platform !== 'win32';
const made: string[] = [];
const children: ChildProcess[] = [];
interface World { top: string; ada: string; bea: string; secret: string }
function world(): World {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'sanctum-r6-')));
  made.push(top);
  const ada = join(top, 'tenants', 'ada');
  const bea = join(top, 'tenants', 'bea');
  for (const t of [ada, bea]) for (const d of ['home', 'data']) mkdirSync(join(t, d), { recursive: true });
  writeFileSync(join(bea, 'data', 'secret.txt'), 'BEA-SECRET');
  return { top, ada, bea, secret: join(bea, 'data', 'secret.txt') };
}
const tryLink = (target: string, at: string): boolean => { try { symlinkSync(target, at, 'file'); return true; } catch { return false; } };
const inTenant = <T>(w: World, fn: () => T, over: Parameters<typeof fakeRuntime>[1] = {}): T => runInTenant(fakeRuntime('ada', { dir: w.ada, dataDir: join(w.ada, 'data'), homeDir: join(w.ada, 'home'), ...over }), fn);
/** A FIFO at `path` with a writer process waiting to deliver `payload` to whoever opens it for reading. */
function fifoWithWriter(path: string, payload: string): void {
  execFileSync('mkfifo', [path]);
  children.push(spawn('sh', ['-c', 'printf "%s" "$0" > "$1"', payload, path], { stdio: 'ignore' }));
}
/** Swap `file` for something else in the gap between the check and the open. */
function swapOnce(swap: (abs: string) => void): void {
  let done = false;
  setAfterReadCheckForTest((abs) => { if (done) return; done = true; swap(abs); });
}

beforeEach(() => enableTenancy(true));
afterEach(() => {
  setAfterReadCheckForTest(null);
  enableTenancy(false);
  vi.restoreAllMocks();
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ownOpenRead: one guarded open, no check-then-plain-open', () => {
  it('opens a real file and hands back the open handle and its fstat', () => {
    const w = world();
    writeFileSync(join(w.ada, 'data', 'f.txt'), 'hello');
    const { fd, stat } = inTenant(w, () => ownOpenRead(join(w.ada, 'data', 'f.txt'), { kind: 'file' }));
    try { const b = Buffer.alloc(5); readSync(fd, b, 0, 5, 0); expect(b.toString()).toBe('hello'); expect(stat.size).toBe(5); } finally { closeSync(fd); }
  });
  it('tenancy off: the plain open', () => {
    const w = world();
    enableTenancy(false);
    const { fd } = ownOpenRead(w.secret);
    closeSync(fd);
  });
  it.runIf(posix)('a FIFO at the path is refused without blocking, and no byte of it is read', () => {
    const w = world();
    fifoWithWriter(join(w.ada, 'data', 'pipe'), 'LEAK');
    expect(() => inTenant(w, () => ownOpenRead(join(w.ada, 'data', 'pipe')))).toThrow(TenantEditRefused);
  });
  it.runIf(posix)('a regular file swapped for a FIFO after the check passed: the open does not wait for a writer, fstat refuses it', () => {
    const w = world();
    const f = join(w.ada, 'data', 'f.txt');
    writeFileSync(f, 'real');
    swapOnce((abs) => { rmSync(abs); fifoWithWriter(abs, 'LEAK'); });
    expect(() => inTenant(w, () => ownOpenRead(f, { kind: 'file' }))).toThrow(/not a regular file/);
  });
  it('a regular file swapped for a link after the check passed: O_NOFOLLOW refuses it, nothing of the target is read', () => {
    const w = world();
    const f = join(w.ada, 'data', 'f.txt');
    writeFileSync(f, 'real');
    let linked = true;
    swapOnce((abs) => { rmSync(abs); linked = tryLink(w.secret, abs); });
    if (!linked && !tryLink(w.secret, join(w.top, 'probe'))) return;
    // posix: O_NOFOLLOW refuses the link ("is a link"). Windows has no O_NOFOLLOW: the open follows it and the inode comparison against what was checked refuses
    // instead ("changed while it was being opened"). Both refuse before a byte is read; either sentence is correct on every platform.
    expect(() => inTenant(w, () => ownOpenRead(f, { kind: 'file' }))).toThrow(/is a link|changed while it was being opened/);
  });
  it.runIf(posix)('a regular file swapped for a second hard link to another tenant\'s file after the check: refused on the open handle', () => {
    const w = world();
    const f = join(w.ada, 'data', 'f.txt');
    writeFileSync(f, 'real');
    swapOnce((abs) => { rmSync(abs); linkSync(w.secret, abs); });
    expect(() => inTenant(w, () => ownOpenRead(f, { kind: 'file' }))).toThrow(/more than one hard link/);
  });
});

describe('the plain reads of tenant paths are guarded opens', () => {
  it.runIf(posix)('services/logs tailBytes: a FIFO at data/logs/tenant.log, and one swapped in after the check, give no lines and never block', () => {
    const w = world();
    const log = join(w.ada, 'data', 'logs', 'tenant.log');
    mkdirSync(join(w.ada, 'data', 'logs'), { recursive: true });
    writeFileSync(log, '2026-01-01T00:00:00Z: real line\n');
    expect(inTenant(w, () => readLogs({ lines: 10 })).lines.map((l) => l.text)).toEqual(['real line']);
    swapOnce((abs) => { rmSync(abs); fifoWithWriter(abs, 'LEAK-LOG-LINE\n'); });
    const raced = inTenant(w, () => readLogs({ lines: 10 }));
    expect(JSON.stringify(raced)).not.toContain('LEAK-LOG-LINE');
    expect(raced.present.out).toBe(false);
    setAfterReadCheckForTest(null);
    const again = inTenant(w, () => readLogs({ lines: 10 })); // (the FIFO is still there)
    expect(JSON.stringify(again)).not.toContain('LEAK-LOG-LINE');
  });

  it.runIf(posix)('discord public transcript tail: a FIFO swapped in after the check gives no lines; a link to another tenant\'s file gives none', () => {
    const w = world();
    const root = join(w.ada, 'data', 'discord', 'public');
    const t = createTranscript(() => root);
    const who = { id: '1', name: 'u', bot: false };
    const where = { guild: '123', channel: '456' };
    inTenant(w, () => t.append({ kind: 'in', who, where, text: 'real words', len: 10 }));
    expect(inTenant(w, () => t.tail('123', '456', 5)).map((l) => l.text)).toEqual(['real words']);
    swapOnce((abs) => { rmSync(abs); fifoWithWriter(abs, JSON.stringify({ kind: 'in', who, where, text: 'LEAK-TRANSCRIPT', len: 1 }) + '\n'); });
    expect(JSON.stringify(inTenant(w, () => t.tail('123', '456', 5)))).not.toContain('LEAK-TRANSCRIPT');
    setAfterReadCheckForTest(null);
    rmSync(t.file('123', '456'));
    writeFileSync(join(w.bea, 'data', 'theirs.jsonl'), JSON.stringify({ kind: 'in', who, where, text: 'BEA-TRANSCRIPT', len: 1 }) + '\n');
    if (tryLink(join(w.bea, 'data', 'theirs.jsonl'), t.file('123', '456'))) expect(JSON.stringify(inTenant(w, () => t.tail('123', '456', 5)))).not.toContain('BEA-TRANSCRIPT');
  });

  it('rolling-context: a sidecar that is a link to the other tenant\'s sidecar is not read (health lists nothing for it); a real one is', async () => {
    const w = world();
    const dir = join(w.ada, 'data', 'rolling');
    mkdirSync(dir, { recursive: true });
    const record = { segments: [{ text: 'S', coveredCount: 3 }], coveredThroughMessageId: 'm2', coveredCount: 3, updatedAt: '2026-01-01T00:00:00Z' };
    writeFileSync(join(dir, 'mine.json'), JSON.stringify(record));
    mkdirSync(join(w.bea, 'data', 'rolling'), { recursive: true });
    writeFileSync(join(w.bea, 'data', 'rolling', 'theirs.json'), JSON.stringify(record));
    const linked = tryLink(join(w.bea, 'data', 'rolling', 'theirs.json'), join(dir, 'theirs.json'));
    const rolling = createRolling({ dir, readTurns: async () => [], appendMarker: async () => {}, runPrompt: async () => ({ text: '', engine: 'fake' }) });
    const health = await inTenant(w, () => rolling.health());
    expect(health.threads.map((t) => t.threadId)).toContain('mine');
    if (linked) expect(health.threads.map((t) => t.threadId)).not.toContain('theirs');
  });

  it('google-auth key file: a link at data/.google-key to another tenant\'s key is never used as this tenant\'s secret (the write over it is refused, the other key is untouched)', () => {
    const w = world();
    const theirs = join(w.bea, 'data', '.google-key');
    writeFileSync(theirs, 'BEA-KEY-BYTES');
    if (!tryLink(theirs, join(w.ada, 'data', '.google-key'))) return;
    const config = { server: { db_path: join(w.ada, 'data', 'sanctum.db') } } as never;
    delete process.env.GOOGLE_TOKEN_SECRET;
    expect(() => inTenant(w, () => encryptSecret('refresh-token'), { config })).toThrow(TenantEditRefused);
    expect(readFileSync(theirs, 'utf8')).toBe('BEA-KEY-BYTES');
  });

  it('identity files: a file swapped for a link to another tenant\'s file after the check is not read', () => {
    const w = world();
    const dir = join(w.ada, 'home', 'identity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'profile.md'), 'MINE');
    expect(inTenant(w, () => readFolder(dir)).files.map((f) => f.text)).toEqual(['MINE']);
    let linked = true;
    swapOnce((abs) => { rmSync(abs); linked = tryLink(w.secret, abs); });
    if (!linked && !tryLink(w.secret, join(w.top, 'probe'))) return;
    expect(() => inTenant(w, () => readFolder(dir))).toThrow(IdentitySourceError);
  });

  it('readOwnOrApp: a file inside the tenant is read through the guard (a swapped-in link refused); a file outside it is the plain read', () => {
    const w = world();
    const f = join(w.ada, 'data', 'f.txt');
    writeFileSync(f, 'mine');
    expect(inTenant(w, () => readOwnOrApp(f))).toBe('mine');
    expect(inTenant(w, () => readOwnOrApp(w.secret))).toBe('BEA-SECRET'); // (a process default outside every tenant folder: the plain read; confinement keeps a tenant's config off it)
    let linked = true;
    swapOnce((abs) => { rmSync(abs); linked = tryLink(w.secret, abs); });
    if (!linked && !tryLink(w.secret, join(w.top, 'probe2'))) return;
    expect(() => inTenant(w, () => readOwnOrApp(f))).toThrow(TenantEditRefused);
  });
});

describe('plugins.dir in a tenant: manifest and help.md are guarded opens', () => {
  const manifest = (id: string, extra: object = {}) => JSON.stringify({ id, name: id, version: '0.0.1', harness: ['dsh'], tenant_aware: true, dsh: { rows: [{ id: 'r', name: 'some-package' }], runs: ['turn'] }, ...extra });
  function pluginsWorld(): { w: World; root: string; dir: string } {
    const w = world();
    const root = join(w.ada, 'plugins');
    const dir = join(root, 'probe');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sanctum.plugin.json'), manifest('probe', { help: 'help.md' }));
    writeFileSync(join(dir, 'help.md'), 'HELP-TEXT');
    return { w, root, dir };
  }
  it('a real manifest loads and its help is read', () => {
    const { w, root } = pluginsWorld();
    const list = inTenant(w, () => loadPlugins({ roots: [root] }));
    expect(list.map((p) => [p.id, p.manifest !== null])).toEqual([['probe', true]]);
    expect(inTenant(w, () => pluginHelp(list, new Set(['probe'])))).toEqual({ probe: 'HELP-TEXT' });
  });
  it.runIf(posix)('a manifest that is a second hard link to another file is refused (the plugin is listed unloaded), and so is a hard-linked help.md', () => {
    const { w, root, dir } = pluginsWorld();
    const other = join(w.bea, 'data', 'manifest.json');
    writeFileSync(other, manifest('probe'));
    rmSync(join(dir, 'sanctum.plugin.json'));
    linkSync(other, join(dir, 'sanctum.plugin.json'));
    const list = inTenant(w, () => loadPlugins({ roots: [root] }));
    expect(list[0].manifest).toBeNull();
    expect(list[0].error ?? '').toMatch(/hard link/);
    // help.md
    rmSync(join(dir, 'sanctum.plugin.json'));
    writeFileSync(join(dir, 'sanctum.plugin.json'), manifest('probe', { help: 'help.md' }));
    writeFileSync(join(w.bea, 'data', 'help.md'), 'BEA-HELP');
    rmSync(join(dir, 'help.md'));
    linkSync(join(w.bea, 'data', 'help.md'), join(dir, 'help.md'));
    const again = inTenant(w, () => loadPlugins({ roots: [root] }));
    expect(inTenant(w, () => pluginHelp(again, new Set(['probe'])))).toEqual({});
  });
  it.runIf(posix)('a manifest swapped for a FIFO after the checks passed: refused without blocking, nothing read', () => {
    const { w, root, dir } = pluginsWorld();
    swapOnce((abs) => { if (!abs.endsWith('sanctum.plugin.json')) return; rmSync(abs); fifoWithWriter(abs, manifest('LEAKED')); });
    // (the seam fires once, on the first guarded open: the manifest read of the scan)
    const list = inTenant(w, () => loadPlugins({ roots: [root] }));
    expect(JSON.stringify(list)).not.toContain('LEAKED');
    expect(list[0].manifest).toBeNull();
    void dir;
  });
  it('a manifest that is a link to another tenant\'s manifest is refused', () => {
    const { w, root, dir } = pluginsWorld();
    const other = join(w.bea, 'data', 'manifest.json');
    writeFileSync(other, manifest('probe'));
    rmSync(join(dir, 'sanctum.plugin.json'));
    if (!tryLink(other, join(dir, 'sanctum.plugin.json'))) return;
    const list = inTenant(w, () => loadPlugins({ roots: [root] }));
    expect(list[0].manifest).toBeNull();
  });
});

describe('item 3: sendOwnFile streams from the open handle', () => {
  let server: http.Server;
  let port = 0;
  let w: World;
  const body = 'abcdefghijklmnopqrstuvwxyz'.repeat(4); // 104 bytes
  const big = Buffer.alloc(300 * 1024, 'z');
  const routes = async (): Promise<void> => {
    w = world();
    writeFileSync(join(w.ada, 'data', 'f.txt'), body);
    writeFileSync(join(w.ada, 'data', 'empty.txt'), '');
    writeFileSync(join(w.ada, 'data', 'big.bin'), big);
    writeFileSync(join(w.ada, 'data', 'doc.json'), '{"a":1}');
    const app = express();
    const rt = fakeRuntime('ada', { dir: w.ada, dataDir: join(w.ada, 'data'), homeDir: join(w.ada, 'home') });
    app.get('/send/:name', (req, res) => {
      try {
        if (req.query.type) res.setHeader('Content-Type', String(req.query.type));
        runInTenant(rt, () => sendOwnFile(res, join(w.ada, 'data', req.params.name)));
      } catch (e) { res.status(e instanceof TenantEditRefused ? 400 : 500).json({ error: (e as Error).message }); }
    });
    await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
    port = (server.address() as AddressInfo).port;
  };
  const get = (name: string, headers: Record<string, string> = {}, method = 'GET', query = ''): Promise<{ status: number; headers: http.IncomingHttpHeaders; buf: Buffer }> => new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: `/send/${name}${query}`, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });
  beforeEach(routes);
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  it('a real file: Content-Type (the caller\'s, else by extension), Content-Length, Last-Modified, Accept-Ranges and the whole body', async () => {
    const r = await get('f.txt', {}, 'GET', '?type=text/plain');
    expect(r.status).toBe(200);
    expect(r.buf.toString()).toBe(body);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.headers['content-length']).toBe(String(body.length));
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['last-modified']).toBe(statSync(join(w.ada, 'data', 'f.txt')).mtime.toUTCString());
    expect((await get('doc.json')).headers['content-type']).toMatch(/^application\/json/);
    const big2 = await get('big.bin');
    expect(big2.buf.equals(big)).toBe(true);
  });
  it('HEAD: the headers and no body', async () => {
    const r = await get('f.txt', {}, 'HEAD');
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(body.length));
    expect(r.buf.length).toBe(0);
  });
  it('Range: a single range is 206 with Content-Range; a suffix range; an open-ended one; an unsatisfiable one is 416; several ranges serve the whole file', async () => {
    const a = await get('f.txt', { range: 'bytes=2-5' });
    expect(a.status).toBe(206);
    expect(a.headers['content-range']).toBe(`bytes 2-5/${body.length}`);
    expect(a.headers['content-length']).toBe('4');
    expect(a.buf.toString()).toBe(body.slice(2, 6));
    const s = await get('f.txt', { range: 'bytes=-3' });
    expect(s.status).toBe(206);
    expect(s.buf.toString()).toBe(body.slice(-3));
    const o = await get('f.txt', { range: `bytes=${body.length - 2}-` });
    expect(o.buf.toString()).toBe(body.slice(-2));
    const bigRange = await get('big.bin', { range: 'bytes=100000-200000' });
    expect(bigRange.status).toBe(206);
    expect(bigRange.buf.length).toBe(100001);
    const bad = await get('f.txt', { range: 'bytes=5000-6000' });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${body.length}`);
    const many = await get('f.txt', { range: 'bytes=0-1,4-5' });
    expect(many.status).toBe(200);
    expect(many.buf.toString()).toBe(body);
    const head = await get('f.txt', { range: 'bytes=0-3' }, 'HEAD');
    expect(head.status).toBe(206);
    expect(head.buf.length).toBe(0);
  });
  it('If-Modified-Since the file\'s own Last-Modified answers 304; an empty file is 200 with length 0', async () => {
    const first = await get('f.txt');
    const cached = await get('f.txt', { 'if-modified-since': String(first.headers['last-modified']) });
    expect(cached.status).toBe(304);
    const e = await get('empty.txt');
    expect(e.status).toBe(200);
    expect(e.headers['content-length']).toBe('0');
    expect(e.buf.length).toBe(0);
  });
  it('the path never reaches express: res.sendFile is not called in a tenant, and is called with tenancy off', async () => {
    const spy = vi.spyOn(express.response, 'sendFile');
    await get('f.txt');
    expect(spy).not.toHaveBeenCalled();
  });
  it('a link at the path is refused (400), the target is not served', async () => {
    if (!tryLink(w.secret, join(w.ada, 'data', 'evil.txt'))) return;
    const r = await get('evil.txt');
    expect(r.status).toBe(400);
    expect(r.buf.toString()).not.toContain('BEA-SECRET');
  });
  it('a link swapped in after the check passed is not served: the open refuses it (the check is made to pass)', async () => {
    let linked = true;
    swapOnce((abs) => { rmSync(abs); linked = tryLink(w.secret, abs); });
    if (!linked && !tryLink(w.secret, join(w.top, 'probe3'))) return;
    const r = await get('f.txt');
    expect(r.status).toBe(400);
    expect(r.buf.toString()).not.toContain('BEA-SECRET');
  });
  it.runIf(posix)('a FIFO swapped in after the check passed: refused at once, the request does not hang', async () => {
    swapOnce((abs) => { rmSync(abs); fifoWithWriter(abs, 'LEAK-FIFO'); });
    const r = await get('f.txt');
    expect(r.status).toBe(400);
    expect(r.buf.toString()).not.toContain('LEAK-FIFO');
  });
  it('the doc comment no longer says the file is served "by its real name"', () => {
    expect(readFileSync(resolve(__dirname, 'own-files.ts'), 'utf8')).not.toContain('served by its real name');
  });
  it('tenancy off: res.sendFile as before', async () => {
    enableTenancy(false);
    const spy = vi.spyOn(express.response, 'sendFile');
    const r = await get('f.txt');
    expect(spy).toHaveBeenCalled();
    expect(r.status).toBe(200);
  });
});

describe('item 4: the wake prompts folder is scanned when tenants.dir is a symlink', () => {
  it('a link in <tenant>/prompts/wakes refuses the tenant at load through the link path, like the real path; a clean folder loads', () => {
    const root = makeTenantsDir({ ada: { yaml: 'orchestrator:\n  wake_prompts_dir: prompts/wakes\n' } });
    made.push(root);
    const real = realpathSync.native(root);
    const linkRoot = `${real}-link`;
    try { symlinkSync(real, linkRoot, 'junction'); } catch { return; }
    made.push(linkRoot);
    const dir = join(real, 'ada', 'prompts', 'wakes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'morning.md'), 'Good morning');
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    expect(() => loadTenantConfig(proc, join(real, 'ada'), 'ada')).not.toThrow();
    expect(() => loadTenantConfig(proc, join(linkRoot, 'ada'), 'ada')).not.toThrow();
    const secret = join(real, 'secret.txt');
    writeFileSync(secret, 'SECRET');
    if (!tryLink(secret, join(dir, 'evening.md'))) return;
    expect(() => loadTenantConfig(proc, join(real, 'ada'), 'ada')).toThrow(/prompts\/wakes\/evening\.md in the tenant folder is a link/);
    expect(() => loadTenantConfig(proc, join(linkRoot, 'ada'), 'ada')).toThrow(/prompts\/wakes\/evening\.md in the tenant folder is a link/);
    expect(readdirSync(dir).sort()).toEqual(['evening.md', 'morning.md']);
  });
});
