// Plugin code ratification (docs/PLUGINS.md "Ratifying"): digest, ledger, per-run and per-request checks, the routes.
import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, realpathSync, statSync, utimesSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const h = vi.hoisted(() => ({
  shipped: '', person: '', enabled: [] as string[], cwd: '', ledgerDir: '',
  workspace: '', vault: '', safe: [] as string[], extraWrite: [] as string[], codexDirs: [] as string[], dshHome: '', provider: 'claude',
}));
vi.mock('../config.js', () => ({
  get PROJECT_ROOT() { return dirname(h.shipped); },
  getSanctumConfig: () => ({
    plugins: { trust: 'person', dir: h.person, enabled: h.enabled, ...(h.ledgerDir && { ledger_dir: h.ledgerDir }) },
    agent: { provider: h.provider, cwd: h.cwd, codex: { additional_directories: h.codexDirs, sandbox_mode: 'workspace-write' }, dsh: { home: h.dshHome, sandbox_mode: 'workspace-write' } },
    hooks: { extra_write_paths: h.extraWrite, safe_write_prefixes: h.safe, workspace_root: h.workspace, vault_path: h.vault },
    server: { host: '127.0.0.1', port: 3099 },
  }),
  internalBaseUrl: (s: { host: string; port: number }) => `http://${s.host}:${s.port}`,
}));
vi.mock('../middleware/internal-token.js', () => ({ getInternalToken: () => 'secret-token-xyz' }));

import { loadPlugins, resetPlugins, pluginRows, pluginList, pluginHelp, createPluginMount, pluginsDisabled, pluginsDisabledInfo, personRoot, ledgerClash, writableRoots, type PluginRowCtx } from './plugins.js';
import { pluginDigest, checkRatification, readLedger, ledgerPath, ratifyPlugin, ratifyDirectory, snapshotDir, pruneSnapshots, escapingImports, scanImports, ratifyCacheStats, resetRatifyCache, DigestMismatch, MAX_FILES, MAX_BYTES } from './plugin-ratify.js';

const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'sanctum-ratify-test-'))); // .native, like the code: a Windows 8.3 short name (RUNNER~1) and its long name must come out the same
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

function linkOrSkip(t: { skip: (reason?: string) => void }, target: string, path: string, kind: 'dir' | 'file'): boolean {
  try { symlinkSync(target, path, kind === 'dir' && process.platform === 'win32' ? 'junction' : undefined); return true; } catch (e: any) {
    if (e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'ENOSYS') { t.skip(`cannot create a symlink here (${e.code})`); return false; }
    throw e;
  }
}

let n = 0;
function fresh() {
  const base = join(tmp, `t${n++}`);
  h.shipped = join(base, 'repo', 'plugins');
  h.person = join(base, 'person-plugins');
  h.cwd = join(base, 'companion-home');
  h.enabled = [];
  h.ledgerDir = ''; h.workspace = ''; h.vault = ''; h.safe = []; h.extraWrite = []; h.codexDirs = []; h.dshHome = ''; h.provider = 'claude';
  mkdirSync(h.shipped, { recursive: true });
  mkdirSync(h.person, { recursive: true });
  mkdirSync(h.cwd, { recursive: true });
  resetPlugins();
  return base;
}
const projectRoot = () => dirname(h.shipped);
const ledgerFile = () => (h.ledgerDir ? join(h.ledgerDir, 'ratified.json') : ledgerPath(projectRoot()));
const expressUrl = JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('express')).href);
const importMarker = () => join(tmp, `imports-${n}`);
const imports = () => (existsSync(importMarker()) ? readFileSync(importMarker(), 'utf-8').length : 0);

/** A plugin with a dsh row, a help topic and routes; routes.mjs counts its imports in a marker file. */
function fullPlugin(root = h.shipped, id = 'rt') {
  const dir = join(root, id);
  mkdirSync(join(dir, 'dsh'), { recursive: true });
  writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify({ id, name: 'RT', version: '1.0.0', harness: ['dsh'], routes: 'routes.mjs', help: 'help.md', dsh: { rows: [{ id: 'marker', entry: 'dsh/index.mjs' }], runs: ['turn'] } }));
  writeFileSync(join(dir, 'dsh', 'index.mjs'), 'export default {};\n');
  writeFileSync(join(dir, 'help.md'), 'rt help\n');
  writeFileSync(join(dir, 'routes.mjs'), `import express from ${expressUrl};
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(importMarker())}, 'x');
export default () => { const r = express.Router(); r.get('/ping', (_q, s) => s.json({ pong: 1 })); return { public: r, internal: express.Router() }; };
`);
  h.enabled = [id];
  return dir;
}
const ctx: PluginRowCtx = { harness: 'dsh', runKind: 'turn', threadId: 't1' };

describe('pluginDigest', () => {
  beforeEach(fresh);
  const make = (name: string, files: Record<string, string>, order?: string[]) => {
    const dir = join(tmp, `d${n++}-${name}`);
    mkdirSync(dir, { recursive: true });
    for (const f of order ?? Object.keys(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), files[f]); }
    return dir;
  };
  const files: Record<string, string> = { 'sanctum.plugin.json': '{}', 'Z.txt': 'z', 'a-b.txt': 'ab', 'a/c.txt': 'ac', 'a/deep/d.txt': 'd' };

  it('hashes every file, sorts by posix relpath (code units), and is exactly sha256 over relpath NUL sha LF lines', () => {
    const r = pluginDigest(make('exact', files));
    const keys = ['Z.txt', 'a-b.txt', 'a/c.txt', 'a/deep/d.txt', 'sanctum.plugin.json'];
    expect(Object.keys(r.files)).toEqual(keys);
    for (const k of keys) expect(r.files[k]).toBe(sha(files[k]));
    expect(r.digest).toBe(sha(keys.map((k) => `${k}\0${sha(files[k])}\n`).join('')));
  });
  it('is deterministic and does not depend on the order files were created in', () => {
    const a = pluginDigest(make('o1', files));
    const b = pluginDigest(make('o2', files, Object.keys(files).reverse()));
    expect(b).toEqual(a);
    expect(pluginDigest(make('o3', files)).digest).toBe(a.digest);
  });
  it('differs when any one byte differs, or a file is added, removed or renamed', () => {
    const base = pluginDigest(make('b0', files)).digest;
    expect(pluginDigest(make('b1', { ...files, 'a/c.txt': 'aX' })).digest).not.toBe(base);
    expect(pluginDigest(make('b2', { ...files, 'extra.txt': '' })).digest).not.toBe(base);
    const { 'Z.txt': zv, ...rest } = files;
    expect(pluginDigest(make('b3', rest)).digest).not.toBe(base);
    expect(pluginDigest(make('b4', { ...rest, 'Y.txt': zv })).digest).not.toBe(base);
  });
  it('refuses a symlink anywhere in the tree', (t) => {
    const dir = make('link', files);
    if (!linkOrSkip(t, tmp, join(dir, 'a', 'deep', 'out'), 'dir')) return;
    expect(() => pluginDigest(dir)).toThrow(/plugin folders may not contain links/);
  });
  it('refuses more than the file cap and more than the byte cap, telling the person where dependencies go', () => {
    const many = join(tmp, `d${n++}-many`);
    mkdirSync(many, { recursive: true });
    for (let i = 0; i <= MAX_FILES; i++) writeFileSync(join(many, `f${i}`), '');
    expect(() => pluginDigest(many)).toThrow(/keep dependencies outside the plugin folder/);
    const big = join(tmp, `d${n++}-big`);
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, 'blob'), Buffer.alloc(MAX_BYTES + 1));
    expect(() => pluginDigest(big)).toThrow(/keep dependencies outside the plugin folder/);
  }, 60000);
});

describe('ratification status, rows, help', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());

  it('an enabled plugin that was never ratified contributes nothing, and the list says why', () => {
    const warn = quiet();
    fullPlugin();
    const plugins = loadPlugins();
    expect(pluginRows(ctx, plugins)).toEqual([]);
    expect(pluginHelp(plugins)).toEqual({});
    const [info] = pluginList(plugins);
    expect(info.ratification!.state).toBe('unratified');
    expect(info.ratification!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(info.error).toMatch(/^not ratified: /);
    const count = () => warn.mock.calls.filter((c) => /rt.*not ratified/.test(String(c[0]))).length;
    expect(count()).toBe(1); // one warning for the state, not one per call
    pluginRows(ctx, plugins);
    expect(count()).toBe(1);
  });

  it('a ratified plugin contributes rows and help; a change after boot stops it on the very next call, naming the files', () => {
    const warn = quiet();
    const dir = fullPlugin();
    const plugins = loadPlugins();
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginRows(ctx, plugins).map((r) => r.id)).toEqual(['plugin:rt:marker']);
    expect(Object.keys(pluginHelp(plugins))).toEqual(['rt']);
    expect(pluginList(plugins)[0].ratification).toMatchObject({ state: 'ok' });
    expect(pluginList(plugins)[0].error).toBeNull();

    writeFileSync(join(dir, 'dsh', 'index.mjs'), 'export default { evil: 1 };\n');
    expect(pluginRows(ctx, plugins)).toEqual([]);
    expect(pluginHelp(plugins)).toEqual({});
    const [info] = pluginList(plugins);
    expect(info.ratification!.state).toBe('changed');
    expect(info.ratification!.changes).toEqual([{ path: 'dsh/index.mjs', kind: 'modified' }]);
    expect(info.error).toMatch(/^changed since ratification: 1 files \(dsh\/index\.mjs\)/);
    expect(warn.mock.calls.some((c) => /rt.*changed since ratification/.test(String(c[0])))).toBe(true);
  });

  it('reports added and removed files, caps the named paths at 5, and ratifying again makes it ok', () => {
    quiet();
    const dir = fullPlugin();
    const plugins = loadPlugins();
    ratifyPlugin(ledgerFile(), plugins[0]);
    writeFileSync(join(dir, 'new.mjs'), 'x');
    rmSync(join(dir, 'help.md'));
    const [info] = pluginList(plugins);
    expect(info.ratification!.changes).toEqual([{ path: 'help.md', kind: 'removed' }, { path: 'new.mjs', kind: 'added' }]);
    for (let i = 0; i < 8; i++) writeFileSync(join(dir, `more${i}.mjs`), 'x');
    const err = pluginList(plugins)[0].error!;
    expect(err).toMatch(/^changed since ratification: 10 files \(/);
    expect(err.match(/\.mjs|help\.md/g)!.length).toBe(5);
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginList(plugins)[0].ratification!.state).toBe('ok');
  });

  it('a symlink in the plugin makes it unavailable: refused, with the reason', (t) => {
    quiet();
    const dir = fullPlugin();
    if (!linkOrSkip(t, h.cwd, join(dir, 'lnk'), 'dir')) return;
    const plugins = loadPlugins();
    expect(plugins[0].ratification.state).toBe('unavailable');
    expect(pluginRows(ctx, plugins)).toEqual([]);
    expect(pluginList(plugins)[0].error).toMatch(/links/);
  });

  it('measures the digest cost of a small plugin (printed, asserted loosely)', () => {
    const dir = join(h.shipped, 'hello');
    mkdirSync(join(dir, 'dsh'), { recursive: true });
    writeFileSync(join(dir, 'sanctum.plugin.json'), '{"id":"hello"}');
    writeFileSync(join(dir, 'help.md'), 'x'.repeat(800));
    writeFileSync(join(dir, 'dsh', 'index.mjs'), 'x'.repeat(2500));
    pluginDigest(dir);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) pluginDigest(dir);
    const ms = (performance.now() - t0) / 50;
    console.log(`[ratify] hello-sized plugin digest: ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThan(25); // ~0.1 ms on Linux; the Windows runner has measured just over 5 ms
  });
});

describe('ledger', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  it('is written atomically (no temp file left), with the documented shape, 0600 where the OS honours it', () => {
    quiet();
    fullPlugin();
    const p = loadPlugins()[0];
    ratifyPlugin(ledgerFile(), p);
    const raw = JSON.parse(readFileSync(ledgerFile(), 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.plugins.rt).toMatchObject({ digest: p.ratification.digest, root: p.dir });
    expect(Object.keys(raw.plugins.rt.files).sort()).toEqual(['dsh/index.mjs', 'help.md', 'routes.mjs', 'sanctum.plugin.json']);
    expect(new Date(raw.plugins.rt.ratified_at).toISOString()).toBe(raw.plugins.rt.ratified_at);
    expect(readdirSync(dirname(ledgerFile())).sort()).toEqual(['ratified.json', 'snapshots']);
    expect(ledgerFile()).toBe(join(dirname(h.shipped), 'data', 'plugins', 'ratified.json'));
    if (process.platform !== 'win32') expect(statSync(ledgerFile()).mode & 0o777).toBe(0o600);
  });
  it('a malformed ledger is a loud warning and counts as nothing ratified, never a crash', () => {
    const warn = quiet();
    fullPlugin();
    mkdirSync(dirname(ledgerFile()), { recursive: true });
    writeFileSync(ledgerFile(), '{ not json');
    expect(readLedger(ledgerFile()).plugins).toEqual({});
    expect(warn.mock.calls.some((c) => /ratified\.json/.test(String(c[0])) && /nothing is ratified/.test(String(c[0])))).toBe(true);
    writeFileSync(ledgerFile(), JSON.stringify({ version: 2, plugins: {} }));
    expect(readLedger(ledgerFile()).plugins).toEqual({});
    const plugins = loadPlugins();
    expect(pluginRows(ctx, plugins)).toEqual([]);
    expect(plugins[0].ratification.state).toBe('unratified');
  });
});

describe('routes: ratify, files, dispatch', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  let server: Server | undefined;
  const stop = () => new Promise<void>((r) => { const s = server; server = undefined; if (s) s.close(() => r()); else r(); });
  afterEach(stop);
  async function start(extra: Record<string, unknown> = {}) {
    const app = express();
    app.use('/api/plugins', createPluginMount({
      auth: (req, res, next) => (req.headers['x-session'] === 'yes' ? next() : res.status(401).json({ error: 'auth' })),
      internalOnly: (req, res, next) => (req.headers['x-internal-token'] === 'secret-token-xyz' ? next() : res.status(404).json({ error: 'nf' })),
      writeGate: (_q, _s, next) => next(),
      api: { config: {} as any, log: () => {} },
      ...extra,
    }));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const port = (server!.address() as AddressInfo).port;
    const call = (method: string, path: string, o: { session?: boolean; internal?: boolean; body?: unknown } = {}) =>
      fetch(`http://127.0.0.1:${port}/api/plugins${path}`, {
        method,
        headers: { ...(o.session && { 'x-session': 'yes' }), ...(o.internal && { 'x-internal-token': 'secret-token-xyz' }), ...(o.body !== undefined && { 'content-type': 'application/json' }) },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
    const digest = async () => (await call('GET', '/', { session: true })).body.plugins.find((p: any) => p.id === 'rt').ratification.digest as string;
    return { call, digest };
  }

  it('an unratified enabled plugin answers 503 plugin_not_ratified and is never imported', async () => {
    quiet(); fullPlugin();
    const { call } = await start();
    const r = await call('GET', '/rt/ping', { session: true });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'plugin_not_ratified', plugin: 'rt', state: 'unratified' });
    expect(imports()).toBe(0);
    const list = await call('GET', '/', { session: true });
    expect(list.body.plugins[0].ratification.state).toBe('unratified');
  });

  it('ratify with the right digest writes the ledger and the plugin starts contributing, routes included, without a restart', async () => {
    quiet(); fullPlugin();
    const { call, digest } = await start();
    const d = await digest();
    const r = await call('POST', '/rt/ratify', { session: true, body: { digest: d } });
    expect(r).toEqual({ status: 200, body: { ok: true, plugin: 'rt', digest: d, files: 4 } });
    expect(readLedger(ledgerFile()).plugins.rt.digest).toBe(d);
    expect((await call('GET', '/rt/ping', { session: true })).body).toEqual({ pong: 1 });
    expect(pluginRows(ctx, loadPlugins()).length).toBe(1);
  });

  it('ratify with a stale digest answers 409 digest_mismatch with the recomputed digest and leaves the ledger alone', async () => {
    quiet(); const dir = fullPlugin();
    const { call, digest } = await start();
    const seen = await digest();
    writeFileSync(join(dir, 'help.md'), 'changed after the person looked\n');
    const r = await call('POST', '/rt/ratify', { session: true, body: { digest: seen } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('digest_mismatch');
    expect(r.body.expected).toBe(pluginDigest(dir).digest);
    expect(r.body.expected).not.toBe(seen);
    expect(Array.isArray(r.body.changes)).toBe(true);
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('ratify needs a digest, 404s an unknown plugin, may ratify a plugin that is not enabled, and refuses one with a scan error', async () => {
    quiet(); fullPlugin();
    const { call, digest } = await start();
    expect((await call('POST', '/rt/ratify', { session: true, body: {} })).status).toBe(400);
    expect((await call('POST', '/nope/ratify', { session: true, body: { digest: 'a'.repeat(64) } })).status).toBe(404);
    const d = await digest();
    expect((await call('POST', '/rt/ratify', { session: true, body: { digest: d } })).status).toBe(200);
  });

  it('ratifies a plugin that is not in plugins.enabled', async () => {
    quiet(); fullPlugin();
    h.enabled = [];
    const { call, digest } = await start();
    expect((await call('POST', '/rt/ratify', { session: true, body: { digest: await digest() } })).status).toBe(200);
  });

  it('refuses to ratify a plugin with a scan error: 409 plugin_invalid with the detail', async () => {
    quiet(); const dir = fullPlugin(); rmSync(join(dir, 'routes.mjs'));
    const { call } = await start();
    const bad = await call('POST', '/rt/ratify', { session: true, body: { digest: 'a'.repeat(64) } });
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ error: 'plugin_invalid' });
    expect(bad.body.detail).toMatch(/routes/);
  });

  it('only the person can ratify: no session, or the internal token alone, never writes the ledger', async () => {
    quiet(); fullPlugin();
    const { call, digest } = await start();
    const d = await digest();
    expect((await call('POST', '/rt/ratify', { body: { digest: d } })).status).toBe(401);
    expect((await call('POST', '/rt/ratify', { internal: true, body: { digest: d } })).status).toBe(401);
    // the internal namespace reaches only the plugin's own internal router (here: nothing), never the ratify route
    const viaInternal = await call('POST', '/rt/internal/ratify', { internal: true, body: { digest: d } });
    expect(viaInternal.status).not.toBe(200);
    expect((await call('GET', '/rt/files', { internal: true })).status).toBe(401);
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('GET /:id/files lists the current tree with sha256 and size, behind session auth', async () => {
    quiet(); const dir = fullPlugin();
    const { call } = await start();
    expect((await call('GET', '/rt/files')).status).toBe(401);
    const r = await call('GET', '/rt/files', { session: true });
    expect(r.status).toBe(200);
    expect(r.body.files.map((f: any) => f.path)).toEqual(['dsh/index.mjs', 'help.md', 'routes.mjs', 'sanctum.plugin.json']);
    const help = r.body.files.find((f: any) => f.path === 'help.md');
    expect(help).toEqual({ path: 'help.md', sha256: sha(readFileSync(join(dir, 'help.md'))), size: statSync(join(dir, 'help.md')).size });
  });

  it('a router already serving: the next request after a file change is 503 and imports nothing; after ratifying again it serves the new code', async () => {
    quiet(); const dir = fullPlugin();
    const { call, digest } = await start();
    await call('POST', '/rt/ratify', { session: true, body: { digest: await digest() } });
    expect((await call('GET', '/rt/ping', { session: true })).status).toBe(200);
    expect(imports()).toBe(1);
    writeFileSync(join(dir, 'routes.mjs'), readFileSync(join(dir, 'routes.mjs'), 'utf-8').replace('pong: 1', 'pong: 2'));
    const blocked = await call('GET', '/rt/ping', { session: true });
    expect(blocked.status).toBe(503);
    expect(blocked.body).toMatchObject({ error: 'plugin_not_ratified', plugin: 'rt', state: 'changed', changes: [{ path: 'routes.mjs', kind: 'modified' }] });
    expect(imports()).toBe(1);
    const reload = await call('POST', '/rt/reload', { session: true });
    expect(reload.status).toBe(503);
    expect(reload.body.error).toBe('plugin_not_ratified');
    expect(imports()).toBe(1);
    await call('POST', '/rt/ratify', { session: true, body: { digest: await digest() } });
    expect((await call('GET', '/rt/ping', { session: true })).body).toEqual({ pong: 2 }); // re-imported: the old router is not reused
    expect(imports()).toBe(2);
  });
});

// ── F1: the ledger must be out of the companion's reach ──────────────────────
describe('F1: the ledger is held to the plugin-root containment rule', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { const s = server; server = undefined; if (s) s.close(() => r()); else r(); }));
  const ratified = () => { const plugins = loadPlugins(); ratifyPlugin(ledgerFile(), plugins[0]); return plugins; };
  const dataDir = () => join(projectRoot(), 'data');

  it('with the ledger outside every companion-writable root, plugins work as before', () => {
    quiet(); fullPlugin();
    expect(pluginsDisabled()).toBeNull();
    expect(pluginRows(ctx, ratified()).length).toBe(1);
  });

  // each root kind, once as "contains the ledger" and once as "sits inside the ledger folder"
  const kinds: Array<[string, (p: string) => void]> = [
    ['agent.cwd', (p) => { h.cwd = p; }],
    ['hooks.workspace_root', (p) => { h.workspace = p; }],
    ['hooks.vault_path', (p) => { h.vault = p; }],
    ['hooks.safe_write_prefixes', (p) => { h.safe = [p]; }],
    ['hooks.extra_write_paths', (p) => { h.extraWrite = [p]; }],
    ['agent.codex.additional_directories', (p) => { h.codexDirs = [p]; }],
    ['agent.dsh.home', (p) => { h.dshHome = p; }],
    ['plugins.dir', (p) => { h.person = p; }],
  ];
  for (const [label, set] of kinds) {
    for (const where of ['contains', 'inside'] as const) {
      it(`${label} ${where === 'contains' ? 'containing' : 'inside'} the ledger folder turns plugins off: no rows, no help, no routes, one loud warning`, async () => {
        const warn = quiet(); fullPlugin();
        const plugins = ratified();
        expect(pluginRows(ctx, plugins).length).toBe(1);
        const root = where === 'contains' ? dataDir() : join(dirname(ledgerFile()), 'inner');
        mkdirSync(root, { recursive: true });
        set(root);
        expect(pluginsDisabled()).toBe('ledger_writable');
        expect(pluginRows(ctx, plugins)).toEqual([]);
        expect(pluginHelp(plugins)).toEqual({});
        expect(loadPlugins()).toEqual([]);
        const loud = warn.mock.calls.map((c) => String(c[0])).filter((m) => /ledger/.test(m) && m.includes(label));
        expect(loud.length).toBe(1); // once, however many calls
        expect(loud[0]).toContain(root);
        expect(loud[0]).toMatch(/plugins\.ledger_dir/);
        // the mount: GET / explains, nothing else is mounted
        const app = express();
        app.use('/api/plugins', createPluginMount({ auth: (_q, _s, next) => next(), internalOnly: (_q, _s, next) => next(), writeGate: (_q, _s, next) => next(), api: { config: {} as any, log: () => {} } }));
        await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
        const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/plugins`;
        const list = await (await fetch(base)).json() as any;
        expect(list).toMatchObject({ disabled: 'ledger_writable', plugins: [] });
        expect(list.detail).toContain(label);
        expect(list.detail).toContain(root);
        expect((await fetch(`${base}/rt/ping`)).status).toBe(404);
        expect((await fetch(`${base}/rt/file?path=help.md`)).status).toBe(404);
      });
    }
  }

  it('the default agent.cwd of "." (the app folder) clashes with the default ledger', () => {
    quiet(); fullPlugin();
    h.cwd = projectRoot();
    expect(pluginsDisabled()).toBe('ledger_writable');
  });

  it('plugins.ledger_dir moves the ledger and the snapshots; a clash-free folder turns plugins back on', () => {
    quiet(); fullPlugin();
    h.cwd = projectRoot(); // clash with the default location
    expect(pluginsDisabled()).toBe('ledger_writable');
    h.ledgerDir = join(tmp, `ledger-elsewhere-${n}`);
    expect(pluginsDisabled()).toBeNull();
    const plugins = loadPlugins({ roots: [h.shipped] });
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(existsSync(join(h.ledgerDir, 'ratified.json'))).toBe(true);
    expect(existsSync(join(projectRoot(), 'data'))).toBe(false);
    expect(pluginRows(ctx, plugins).length).toBe(1);
  });

  it('a ledger_dir that is itself inside a companion-writable root is refused, named in the detail', () => {
    quiet(); fullPlugin();
    h.ledgerDir = join(h.cwd, 'ledger');
    expect(pluginsDisabled()).toBe('ledger_writable');
  });

  it('a symlinked parent is followed: a ledger folder that resolves into a writable root is refused', (t) => {
    quiet(); fullPlugin();
    const link = join(tmp, `ledger-link-${n}`);
    if (!linkOrSkip(t, h.cwd, link, 'dir')) return;
    h.ledgerDir = join(link, 'not-yet-created');
    expect(pluginsDisabled()).toBe('ledger_writable');
  });
});

// ── F2: run the ratified copy, not the live folder ───────────────────────────
describe('F2: the ratified copy is what runs', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { const s = server; server = undefined; if (s) s.close(() => r()); else r(); }));
  const snaps = (id = 'rt') => { const d = join(dirname(ledgerFile()), 'snapshots', id); return existsSync(d) ? readdirSync(d).sort() : []; };
  const treeOf = (dir: string): Record<string, string> => pluginDigest(dir).files;

  async function start() {
    const app = express();
    app.use('/api/plugins', createPluginMount({
      auth: (_q, _s, next) => next(), internalOnly: (_q, _s, next) => next(), writeGate: (_q, _s, next) => next(),
      api: { config: {} as any, log: () => {} },
    }));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/plugins`;
    const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
    const digest = async () => (await call('GET', '/')).body.plugins.find((p: any) => p.id === 'rt').ratification.digest as string;
    const ratify = async () => call('POST', '/rt/ratify', { digest: await digest() });
    return { call, digest, ratify };
  }
  /** routes.mjs + a helper it imports + a lazily imported file; /where answers with the module's own url. */
  function snapPlugin() {
    const dir = fullPlugin();
    writeFileSync(join(dir, 'routes.mjs'), `import express from ${expressUrl};
import { tag } from './rhelper.mjs';
export default () => { const r = express.Router();
  r.get('/where', (_q, s) => s.json({ url: import.meta.url, tag }));
  r.get('/lazy', async (_q, s) => { const m = await import('./lazy.mjs'); s.json({ v: m.v, url: m.url }); });
  return { public: r, internal: express.Router() }; };
`);
    writeFileSync(join(dir, 'rhelper.mjs'), "export const tag = 'H1';\n");
    writeFileSync(join(dir, 'lazy.mjs'), "export const v = 'A'; export const url = import.meta.url;\n");
    return dir;
  }
  const sameStampEdit = (f: string, from: string, to: string) => {
    expect(from.length).toBe(to.length);
    const st = statSync(f);
    writeFileSync(f, readFileSync(f, 'utf-8').replace(from, to));
    utimesSync(f, st.atime, st.mtime);
  };

  it('ratifying copies the folder to <ledger>/snapshots/<id>/<digest>/ byte for byte, 0600 files and 0700 folders, no temp folder left', () => {
    quiet(); const dir = snapPlugin();
    const plugins = loadPlugins();
    const r = ratifyPlugin(ledgerFile(), plugins[0]);
    const snap = snapshotDir(ledgerFile(), 'rt', r.digest);
    expect(snap).toBe(join(dirname(ledgerFile()), 'snapshots', 'rt', r.digest));
    expect(treeOf(snap)).toEqual(treeOf(dir));
    expect(readdirSync(join(dirname(ledgerFile()), 'snapshots'))).toEqual(['rt']);
    expect(snaps()).toEqual([r.digest]);
    if (process.platform !== 'win32') {
      expect(statSync(snap).mode & 0o777).toBe(0o700);
      expect(statSync(join(snap, 'dsh')).mode & 0o777).toBe(0o700);
      expect(statSync(join(snap, 'routes.mjs')).mode & 0o777).toBe(0o600);
    }
    expect(plugins[0].ratification).toMatchObject({ state: 'ok', snapshot: snap });
  });

  it('aborts, writing nothing, when the bytes are not the digest it was asked to ratify', () => {
    quiet(); const dir = snapPlugin();
    const asked = pluginDigest(dir).digest;
    writeFileSync(join(dir, 'help.md'), 'edited after the person looked\n');
    let err: unknown;
    try { ratifyDirectory(ledgerFile(), 'rt', dir, asked); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DigestMismatch);
    expect((err as DigestMismatch).result.digest).toBe(pluginDigest(dir).digest);
    expect(existsSync(ledgerFile())).toBe(false);
    expect(snaps()).toEqual([]);
    const root = join(dirname(ledgerFile()), 'snapshots');
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]); // no temp folder either
  });

  it('routes.mjs and every module it imports, even lazily, come from the snapshot, never the live folder', async () => {
    quiet(); const dir = snapPlugin();
    const { call, ratify } = await start();
    const r = await ratify();
    expect(r.status).toBe(200);
    const snap = snapshotDir(ledgerFile(), 'rt', r.body.digest);
    const where = (await call('GET', '/rt/where')).body;
    expect(where.tag).toBe('H1');
    expect(fileURLToPath(where.url)).toBe(join(snap, 'routes.mjs'));
    const lazy = (await call('GET', '/rt/lazy')).body;
    expect(fileURLToPath(lazy.url)).toBe(join(snap, 'lazy.mjs'));
    expect(fileURLToPath(where.url).startsWith(dir)).toBe(false);
  });

  it('re-ratifying a changed helper gives a fresh snapshot path, so the helper is fresh too; the old snapshot is deleted', async () => {
    quiet(); const dir = snapPlugin();
    const { call, ratify } = await start();
    const first = (await ratify()).body.digest;
    expect((await call('GET', '/rt/where')).body.tag).toBe('H1');
    writeFileSync(join(dir, 'rhelper.mjs'), "export const tag = 'H2';\n");
    expect((await call('GET', '/rt/where')).status).toBe(503); // changed, not yet ratified
    const second = (await ratify()).body.digest;
    expect(second).not.toBe(first);
    const again = (await call('GET', '/rt/where')).body;
    expect(again.tag).toBe('H2'); // the verifier's low finding: the helper is no longer the cached old module
    expect(fileURLToPath(again.url)).toBe(join(snapshotDir(ledgerFile(), 'rt', second), 'routes.mjs'));
    expect(snaps()).toEqual([first, second].sort()); // the current copy and the one before it (a request may still be reading from it); the next start drops the old one
  });

  it('a same-size edit with the mtime put back is caught on the very next route request, and by the next run: one check, one answer', async () => {
    quiet(); const dir = snapPlugin();
    const { call, ratify } = await start();
    await ratify();
    expect((await call('GET', '/rt/lazy')).body.v).toBe('A');
    sameStampEdit(join(dir, 'lazy.mjs'), "'A'", "'Z'");
    const r = await call('GET', '/rt/lazy');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'plugin_not_ratified', state: 'changed', changes: [{ path: 'lazy.mjs', kind: 'modified' }] });
    expect(pluginRows(ctx, loadPlugins())).toEqual([]); // the run check says the same
    sameStampEdit(join(dir, 'lazy.mjs'), "'Z'", "'A'");
    expect(pluginRows(ctx, loadPlugins()).length).toBe(1); // and both agree again once it is back
    expect((await call('GET', '/rt/lazy')).status).toBe(200);
  });

  it('the full recheck of a 50-file plugin is well under 5 ms', () => {
    const dir = join(h.shipped, 'big');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sanctum.plugin.json'), '{"id":"big"}');
    for (let i = 0; i < 49; i++) writeFileSync(join(dir, `f${i}.mjs`), `export default ${i};\n`.repeat(40));
    ratifyDirectory(ledgerFile(), 'big', dir);
    expect(checkRatification('big', dir, ledgerFile()).state).toBe('ok');
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) checkRatification('big', dir, ledgerFile());
    const ms = (performance.now() - t0) / 100;
    console.log(`[ratify] 50-file plugin full recheck (hash live folder + read ledger + stat snapshot): ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThan(25); // ~0.1 ms on Linux; the Windows runner has measured just over 5 ms
  });

  it('rows point into the snapshot; a live edit in the window after the check changes what the child imports not at all; a changed folder still stops rows', () => {
    quiet();
    const repoHello = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'plugins', 'hello');
    cpSync(repoHello, join(h.shipped, 'hello'), { recursive: true });
    const entry = join(h.shipped, 'hello', 'dsh', 'index.mjs');
    h.enabled = ['hello'];
    const plugins = loadPlugins();
    const r = ratifyPlugin(ledgerFile(), plugins[0]);
    const snap = snapshotDir(ledgerFile(), 'hello', r.digest);
    const [row] = pluginRows({ harness: 'dsh', runKind: 'turn', threadId: 't9', senderIsOwner: true }, plugins);
    expect(row.name).toBe(join(snap, 'dsh', 'index.mjs'));
    expect(row.name).not.toBe(entry);
    // The window between the run's check and dsh importing the row: the live file is swapped.
    const marker = join(tmp, `evil-${n}.marker`);
    writeFileSync(entry, `import { writeFileSync } from 'node:fs';\nexport default { apply() { writeFileSync(${JSON.stringify(marker)}, 'EVIL'); } };\n`);
    const cwd = join(tmp, `hello-cwd-${n}`); mkdirSync(cwd);
    const overlay = join(tmp, `overlay-${n}.json`);
    writeFileSync(overlay, JSON.stringify([{ insert: [row] }]));
    const loader = `import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [{ insert: [row] }] = JSON.parse(readFileSync(${JSON.stringify(overlay)}, 'utf8'));
const mod = await import(pathToFileURL(row.name).href);
await (mod.default ?? mod).apply({ on() {} }, row.config);`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', loader], { cwd, encoding: 'utf-8' });
    expect(run.status).toBe(0);
    expect(existsSync(marker)).toBe(false); // ratified bytes ran, not the swapped ones
    // The next run's check sees the live folder differ and the plugin goes quiet.
    expect(pluginRows({ harness: 'dsh', runKind: 'turn', threadId: 't9' }, plugins)).toEqual([]);
    expect(pluginList(plugins)[0].ratification!.state).toBe('changed');
    // Put the live file back: the same snapshot rows return.
    cpSync(join(repoHello, 'dsh', 'index.mjs'), entry);
    expect(pluginRows({ harness: 'dsh', runKind: 'turn', threadId: 't9' }, plugins)[0].name).toBe(row.name);
  });

  it('help is read from the snapshot too', () => {
    quiet(); const dir = fullPlugin();
    const plugins = loadPlugins();
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginHelp(plugins)).toEqual({ rt: 'rt help' });
    writeFileSync(join(dir, 'help.md'), 'swapped\n'); // a change: nothing is served
    expect(pluginHelp(plugins)).toEqual({});
  });

  it('a ledger entry whose snapshot is gone is unavailable, saying to ratify again, and contributes nothing', () => {
    quiet(); fullPlugin();
    const plugins = loadPlugins();
    const r = ratifyPlugin(ledgerFile(), plugins[0]);
    rmSync(snapshotDir(ledgerFile(), 'rt', r.digest), { recursive: true, force: true });
    const check = checkRatification('rt', plugins[0].dir, ledgerFile());
    expect(check.state).toBe('unavailable');
    expect(check.detail).toMatch(/ratified copy is missing.*ratify it again/);
    expect(pluginRows(ctx, plugins)).toEqual([]);
  });

  it('pruning clears stale digests, unknown ids, ids that left the ledger and old temp folders', () => {
    quiet(); const dir = fullPlugin();
    const plugins = loadPlugins();
    const a = ratifyPlugin(ledgerFile(), plugins[0]);
    const dir2 = join(h.shipped, 'other'); mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'sanctum.plugin.json'), '{"id":"other"}');
    ratifyDirectory(ledgerFile(), 'other', dir2);
    expect(snaps('other').length).toBe(1);
    const root = join(dirname(ledgerFile()), 'snapshots');
    mkdirSync(join(root, 'rt', 'f'.repeat(64)), { recursive: true });
    mkdirSync(join(root, 'ghost', 'a'.repeat(64)), { recursive: true });
    mkdirSync(join(root, '.tmp-old'), { recursive: true });
    utimesSync(join(root, '.tmp-old'), new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
    pruneSnapshots(ledgerFile());
    expect(snaps()).toEqual([a.digest]);
    expect(existsSync(join(root, 'ghost'))).toBe(false);
    expect(existsSync(join(root, '.tmp-old'))).toBe(false);
    // a plugin that is no longer in the ledger loses its copy at the next prune (there is no un-ratify route: the person edits the file)
    const ledger = readLedger(ledgerFile());
    delete ledger.plugins.other;
    writeFileSync(ledgerFile(), JSON.stringify(ledger));
    pruneSnapshots(ledgerFile());
    expect(snaps('other')).toEqual([]);
    expect(existsSync(join(root, 'other'))).toBe(false);
    expect(existsSync(dir)).toBe(true); // the live folder is never touched
  });

  it('there is no un-ratify route', async () => {
    quiet(); snapPlugin();
    const { call, ratify } = await start();
    await ratify();
    const before = readFileSync(ledgerFile(), 'utf-8');
    for (const [m, p] of [['DELETE', '/rt/ratify'], ['POST', '/rt/unratify'], ['DELETE', '/rt'], ['POST', '/rt/ratify/remove']] as const) {
      expect((await call(m, p, m === 'POST' ? {} : undefined)).status).toBeGreaterThanOrEqual(404);
    }
    expect(readFileSync(ledgerFile(), 'utf-8')).toBe(before);
  });
});

// ── F3: code outside the folder ──────────────────────────────────────────────
describe('F3: imports that leave the plugin folder are refused', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  const plant = (rel: string, text: string) => {
    const dir = fullPlugin();
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    return dir;
  };

  const escaping: Array<[string, string, string, string]> = [
    ['static import', 'dsh/helper.mjs', "import x from '../../outside.mjs';\nexport default x;\n", '../../outside.mjs'],
    ['import with a double-quoted specifier and a query', 'dsh/helper.mjs', 'import x from "../../outside.mjs?v=1";\n', '../../outside.mjs?v=1'],
    ['side-effect import', 'dsh/helper.mjs', "import '../../outside.mjs';\n", '../../outside.mjs'],
    ['multi-line named import', 'dsh/helper.mjs', "import {\n  a,\n  b,\n} from '../../outside.mjs';\n", '../../outside.mjs'],
    ['export-from', 'dsh/helper.mjs', "export { default } from '../../outside.mjs';\n", '../../outside.mjs'],
    ['export-star-from', 'dsh/helper.mjs', "export * from '../../outside.mjs';\n", '../../outside.mjs'],
    ['literal dynamic import', 'dsh/helper.mjs', "export const load = () => import('../../outside.mjs');\n", '../../outside.mjs'],
    ['literal dynamic import with a built-up query', 'dsh/helper.mjs', "export const load = () => import('../../outside.mjs?' + Date.now());\n", '../../outside.mjs?'],
    ['require in a .cjs file', 'dsh/old.cjs', "const x = require('../../outside.cjs');\nmodule.exports = x;\n", '../../outside.cjs'],
    ['a climb from the plugin root itself', 'top.mjs', "import x from '../outside.mjs';\n", '../outside.mjs'],
    ['a climb that only escapes at depth', 'a/b/c.mjs', "import x from '../../../outside.mjs';\n", '../../../outside.mjs'],
    ['a backslash climb (a plugin folder travels to Windows)', 'dsh/helper.mjs', "import x from '..\\\\..\\\\outside.mjs';\n", '..\\\\..\\\\outside.mjs'],
  ];
  for (const [what, rel, text, spec] of escaping) {
    it(`refuses ${what}, naming the file and the specifier; nothing loads, nothing ratifies`, () => {
      quiet();
      const dir = plant(rel, text);
      const [p] = loadPlugins();
      expect(p.error).toContain(rel);
      expect(p.error).toContain(spec);
      expect(p.error).toMatch(/outside the plugin folder/);
      expect(pluginRows(ctx, [p])).toEqual([]);
      expect(pluginList([p])[0].error).toContain(spec);
      expect(() => ratifyDirectory(ledgerFile(), 'rt', dir)).toThrow(new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      expect(existsSync(ledgerFile())).toBe(false);
    });
  }

  // The verifier's three misses: each loads code the digest never saw in real Node, and each is refused at scan.
  describe('every file is scanned as text, and data: URLs are refused', () => {
    const roots = () => ({ writableRoots: [h.cwd] });
    const evil = () => pathToFileURL(join(h.cwd, 'evil.mjs')).href;
    const refusedAtScan = (dir: string, rel: string, why: RegExp) => {
      const [p] = loadPlugins();
      expect(p.error).toContain(rel);
      expect(p.error).toMatch(why);
      expect(pluginRows(ctx, [p])).toEqual([]);
      expect(() => ratifyDirectory(ledgerFile(), 'rt', dir, undefined, { writableRoots: [h.cwd] })).toThrow(why);
      expect(existsSync(ledgerFile())).toBe(false);
    };
    it('a base64 data: specifier that embeds a file: import', () => {
      quiet();
      const url = `data:text/javascript;base64,${Buffer.from(`export * from ${JSON.stringify(evil())};`).toString('base64')}`;
      const dir = plant('dsh/helper.mjs', `export * from '${url}';\n`);
      refusedAtScan(dir, 'dsh/helper.mjs', /data: URLs cannot be ratified/);
    });
    it('a percent-encoded data: specifier that embeds a file: import', () => {
      quiet();
      const dir = plant('dsh/helper.mjs', `import('data:text/javascript,export%20*%20from%20%22${evil()}%22');\n`);
      refusedAtScan(dir, 'dsh/helper.mjs', /data: URLs cannot be ratified/);
    });
    it('require of a .txt file, which Node runs as JavaScript: the .txt is scanned', () => {
      quiet();
      const dir = plant('dsh/helper.mjs', "import { createRequire } from 'node:module';\nexport default createRequire(import.meta.url)('./helper.txt');\n");
      writeFileSync(join(dir, 'dsh', 'helper.txt'), `module.exports = require(${JSON.stringify(join(h.cwd, 'evil.cjs'))});\n`);
      refusedAtScan(dir, 'dsh/helper.txt', /outside the plugin folder/);
    });
    it('an extensionless file under "type":"module"', () => {
      quiet();
      const dir = plant('lib', "import '../../../../../x.mjs';\n");
      refusedAtScan(dir, 'lib', /outside the plugin folder/);
    });
    // NUL is legal inside a JS comment or string: Node loads these files, so the scan reads every file as text, NUL as a separator.
    const NULS = '\0'.repeat(8200);
    const refusedAtRatify = async (dir: string) => {
      const plugins = loadPlugins();
      const app = express();
      app.use('/api/plugins', createPluginMount({ auth: (_q, _s, next) => next(), internalOnly: (_q, _s, next) => next(), writeGate: (_q, _s, next) => next(), api: { config: {} as any, log: () => {} }, plugins }));
      const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      try {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins`;
        const r = await fetch(`${base}/rt/ratify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ digest: pluginDigest(dir).digest }) });
        expect(r.status).toBe(409);
        expect((await r.json() as any).error).toBe('plugin_invalid');
        expect(existsSync(ledgerFile())).toBe(false);
      } finally { await new Promise<void>((r) => server.close(() => r())); }
    };
    it('require of a blob whose first 8 KiB is NULs in a comment, then require of a path outside: refused at scan and at ratify', async () => {
      quiet();
      const dir = plant('dsh/helper.mjs', "import { createRequire } from 'node:module';\nexport default createRequire(import.meta.url)('./blob.bin');\n");
      writeFileSync(join(dir, 'dsh', 'blob.bin'), `//${NULS}\nmodule.exports = require(${JSON.stringify(join(h.cwd, 'evil.cjs'))});\n`);
      refusedAtScan(dir, 'dsh/blob.bin', /outside the plugin folder/);
      await refusedAtRatify(dir);
    });
    it('routes.mjs with NULs in a comment, then a file: import of the companion home: refused at scan and at ratify', async () => {
      quiet();
      const dir = plant('routes.mjs', `//${NULS}\nimport { v } from ${JSON.stringify(evil())};\nexport default () => v;\n`);
      refusedAtScan(dir, 'routes.mjs', /outside the plugin folder/);
      await refusedAtRatify(dir);
    });
    it('the same with the NULs inside a string', async () => {
      quiet();
      const dir = plant('routes.mjs', `const pad = "${NULS}";\nimport { v } from ${JSON.stringify(evil())};\nexport default () => v;\n`);
      refusedAtScan(dir, 'routes.mjs', /outside the plugin folder/);
      await refusedAtRatify(dir);
    });
    it('a NUL run cannot split or hide a climb: the token ends at the NUL', () => {
      expect(escapingImports('a.mjs', 'x\0../../../y\0', roots()).join()).toContain('../../../y');
      expect(escapingImports('a.mjs', `${NULS}../../../y${NULS}`, roots()).length).toBeGreaterThan(0);
      expect(escapingImports('a.mjs', "import '../\0../../x';", roots()).length).toBeGreaterThan(0);
    });
    it('a real PNG with no path-like tokens passes; a binary file whose bytes hold a path-like token is refused', () => {
      quiet();
      const dir = plant('dsh/helper.mjs', 'export default 1;\n');
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(200, 7), Buffer.from([0, 0, 0, 0]), Buffer.from('IEND')]);
      writeFileSync(join(dir, 'icon.png'), png);
      expect(scanImports(dir, roots())).toEqual([]);
      expect(() => ratifyDirectory(ledgerFile(), 'rt', dir)).not.toThrow();
      writeFileSync(join(dir, 'icon.png'), Buffer.concat([png, Buffer.from('../../../../../x.mjs'), Buffer.from([0])]));
      expect(scanImports(dir, roots()).join()).toContain('icon.png');
    });
    it('text after the first 8 KiB of a file is still read', () => {
      quiet();
      const dir = plant('late.txt', `${'x'.repeat(9000)}\nimport '../../../../../x.mjs';\n`);
      expect(scanImports(dir, roots()).join()).toContain('late.txt');
    });
    it('a plain "data:" in prose or an object key is not a data URL', () => {
      expect(escapingImports('notes.md', 'metadata: yes. { data: 1 } the data: field', roots())).toEqual([]);
    });
  });

  it('leaves alone imports that stay inside, bare package names, node: builtins and non-literal dynamic imports', () => {
    quiet();
    plant('a/b/c.mjs', [
      "import a from './d.mjs';", "import b from '../sibling.mjs';", "import c from '../../top.mjs';", "import d from 'node:fs';",
      "import e from 'express';", "import f from '@scope/pkg/sub';", "export * from './d.mjs';",
      "const name = './x.mjs'; export const lazy = () => import(name);"
    ].join('\n') + '\n');
    const [p] = loadPlugins();
    expect(p.error).toBeNull();
  });

  it('a plugin edited after the scan to add an escaping import cannot be ratified: the check runs on the bytes being copied', async () => {
    quiet(); const dir = fullPlugin();
    const plugins = loadPlugins();
    expect(plugins[0].error).toBeNull();
    writeFileSync(join(dir, 'dsh', 'index.mjs'), "import x from '../../outside.mjs';\nexport default x;\n");
    const app = express();
    app.use('/api/plugins', createPluginMount({ auth: (_q, _s, next) => next(), internalOnly: (_q, _s, next) => next(), writeGate: (_q, _s, next) => next(), api: { config: {} as any, log: () => {} }, plugins }));
    const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins`;
      const d = pluginDigest(dir).digest;
      const r = await fetch(`${base}/rt/ratify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ digest: d }) });
      expect(r.status).toBe(409);
      const body = await r.json() as any;
      expect(body.error).toBe('plugin_invalid');
      expect(body.detail).toContain('dsh/index.mjs');
      expect(body.detail).toContain('../../outside.mjs');
      expect(existsSync(ledgerFile())).toBe(false);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });

  it('manifest paths (row entry, routes, help) that resolve outside the folder refuse the plugin', (t) => {
    quiet();
    for (const field of ['entry', 'routes', 'help'] as const) {
      fresh();
      const dir = fullPlugin();
      const m = JSON.parse(readFileSync(join(dir, 'sanctum.plugin.json'), 'utf-8'));
      if (field === 'entry') m.dsh.rows[0].entry = '../escape.mjs'; else m[field] = '../escape.mjs';
      writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify(m));
      writeFileSync(join(dirname(dir), 'escape.mjs'), 'export default 1;\n');
      const [p] = loadPlugins();
      expect(p.error, field).toBeTruthy();
      expect(pluginRows(ctx, [p])).toEqual([]);
    }
    // and through a link: a file inside the folder that resolves outside it
    fresh();
    const dir = fullPlugin();
    const outside = join(tmp, `outside-${n}.mjs`);
    writeFileSync(outside, 'export default 1;\n');
    rmSync(join(dir, 'dsh', 'index.mjs'));
    if (!linkOrSkip(t, outside, join(dir, 'dsh', 'index.mjs'), 'file')) return;
    const [p] = loadPlugins();
    expect(p.error).toMatch(/links|outside the plugin folder/);
    expect(pluginRows(ctx, [p])).toEqual([]);
  });
});

// ── F5: review shows contents ────────────────────────────────────────────────
describe('F5: GET /api/plugins/:id/file', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { const s = server; server = undefined; if (s) s.close(() => r()); else r(); }));
  async function start() {
    const app = express();
    app.use('/api/plugins', createPluginMount({
      auth: (req, res, next) => (req.headers['x-session'] === 'yes' ? next() : res.status(401).json({ error: 'auth' })),
      internalOnly: (req, res, next) => (req.headers['x-internal-token'] === 'secret-token-xyz' ? next() : res.status(404).json({ error: 'nf' })),
      writeGate: (_q, _s, next) => next(),
      api: { config: {} as any, log: () => {} },
    }));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/plugins`;
    return (path: string, o: { session?: boolean; internal?: boolean } = { session: true }) =>
      fetch(base + path, { headers: { ...(o.session && { 'x-session': 'yes' }), ...(o.internal && { 'x-internal-token': 'secret-token-xyz' }) } })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  }
  const q = (p: string) => `/rt/file?path=${encodeURIComponent(p)}`;

  it('needs the session: no session, or the internal token alone, is 401', async () => {
    quiet(); fullPlugin();
    const get = await start();
    expect((await get(q('help.md'), {})).status).toBe(401);
    expect((await get(q('help.md'), { internal: true })).status).toBe(401);
  });

  it('returns { path, sha256, size, text } for a UTF-8 file, read from the live folder (what the person is about to ratify)', async () => {
    quiet(); const dir = fullPlugin();
    const get = await start();
    const r = await get(q('dsh/index.mjs'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ path: 'dsh/index.mjs', sha256: sha('export default {};\n'), size: 19, text: 'export default {};\n' });
    writeFileSync(join(dir, 'help.md'), 'änderung ✓\n');
    const after = (await get(q('help.md'))).body;
    expect(after.text).toBe('änderung ✓\n');
    expect(after.sha256).toBe(sha(readFileSync(join(dir, 'help.md'))));
    expect(after.size).toBe(Buffer.byteLength('änderung ✓\n'));
  });

  it('keeps a leading BOM and CRLF as they are (the hash is of the bytes)', async () => {
    quiet(); const dir = fullPlugin();
    writeFileSync(join(dir, 'help.md'), '﻿line1\r\nline2\r\n');
    const get = await start();
    expect((await get(q('help.md'))).body.text).toBe('﻿line1\r\nline2\r\n');
  });

  it('a file that is not valid UTF-8 comes back as { path, sha256, size, binary: true } with no text; valid UTF-8 is text even when it holds a U+FFFD character', async () => {
    quiet(); const dir = fullPlugin();
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]);
    writeFileSync(join(dir, 'icon.png'), bin);
    writeFileSync(join(dir, 'fffd.txt'), 'valid but holds �\n');
    const get = await start();
    const a = (await get(q('icon.png'))).body;
    expect(a).toEqual({ path: 'icon.png', sha256: sha(bin), size: 7, binary: true });
    const b = (await get(q('fffd.txt'))).body;
    expect(b).toEqual({ path: 'fffd.txt', sha256: sha('valid but holds �\n'), size: Buffer.byteLength('valid but holds �\n'), text: 'valid but holds �\n' });
  });

  it('shows up to 256 KiB; a byte more is binary: true (no text)', async () => {
    quiet(); const dir = fullPlugin();
    writeFileSync(join(dir, 'at-cap.txt'), 'a'.repeat(256 * 1024));
    writeFileSync(join(dir, 'over-cap.txt'), 'a'.repeat(256 * 1024 + 1));
    const get = await start();
    const at = (await get(q('at-cap.txt'))).body;
    expect(at.text.length).toBe(256 * 1024);
    const over = (await get(q('over-cap.txt'))).body;
    expect(over).toEqual({ path: 'over-cap.txt', sha256: sha('a'.repeat(256 * 1024 + 1)), size: 256 * 1024 + 1, binary: true });
  });

  it('only a path from the digest list: traversal, absolute, backslash and non-normalised spellings are all 404, whatever they resolve to', async () => {
    quiet(); const dir = fullPlugin();
    writeFileSync(join(dirname(dir), 'secret.txt'), 'outside\n');
    const get = await start();
    for (const bad of ['../secret.txt', '../rt/help.md', 'dsh/../help.md', './help.md', '/help.md', join(dir, 'help.md'), 'dsh\\index.mjs', 'dsh/', 'dsh', 'HELP.MD', 'help.md ', 'help.md\0', 'nope.txt', '%2e%2e/secret.txt']) {
      const r = await get(q(bad));
      expect(r.status, JSON.stringify(bad)).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain('outside');
    }
  });

  it('a missing or repeated path parameter is 400 path_required; an unknown plugin is 404', async () => {
    quiet(); fullPlugin();
    const get = await start();
    for (const url of ['/rt/file', '/rt/file?path=', '/rt/file?path=help.md&path=dsh/index.mjs']) {
      const r = await get(url);
      expect(r.status, url).toBe(400);
      expect(r.body.error).toBe('path_required');
    }
    expect((await get('/nope/file?path=x')).status).toBe(404);
  });

  it('a folder that cannot be listed (a link in it) is 409 plugin_invalid, like /files', async (t) => {
    quiet(); const dir = fullPlugin();
    if (!linkOrSkip(t, h.cwd, join(dir, 'lnk'), 'dir')) return;
    const get = await start();
    const r = await get(q('help.md'));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('plugin_invalid');
  });
});

// ── B1: rows, help and routes come from the ratified copy's manifest ─────────
describe('B1: the manifest that runs is the ratified one, re-read from the copy', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { const s = server; server = undefined; if (s) s.close(() => r()); else r(); }));
  const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'sanctum.plugin.json'), 'utf-8'));
  const putManifest = (dir: string, m: unknown) => writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify(m));

  it('a manifest edited before boot and restored afterwards (so the plugin reports ok) yields the ratified rows and config, not the edited ones', () => {
    quiet();
    const dir = fullPlugin();
    const m = manifestOf(dir); m.dsh.rows[0].config = { level: 'safe' };
    putManifest(dir, m);
    const orig = readFileSync(join(dir, 'sanctum.plugin.json'));
    ratifyDirectory(ledgerFile(), 'rt', dir);
    // the companion edits the manifest; the app starts while it is edited
    const evil = manifestOf(dir);
    evil.dsh.rows[0].config = { level: 'EVIL' };
    evil.dsh.rows.push({ id: 'x', name: '@deepseek-ai/dsh-tool-bash', config: { sandbox: 'off' } });
    putManifest(dir, evil);
    resetPlugins();
    const plugins = loadPlugins();
    expect(plugins[0].manifest!.dsh.rows.length).toBe(2); // the live manifest was cached at boot
    writeFileSync(join(dir, 'sanctum.plugin.json'), orig); // and put back: the check says ok
    const rows = pluginRows(ctx, plugins);
    expect(rows.map((r) => r.id)).toEqual(['plugin:rt:marker']);
    expect(rows[0].config.level).toBe('safe');
    expect(pluginList(plugins)[0].ratification!.state).toBe('ok');
  });

  it('the list shows the ratified copy\'s name, version and routes when the state is ok, not the live manifest read at boot', () => {
    quiet();
    const dir = fullPlugin();
    const orig = readFileSync(join(dir, 'sanctum.plugin.json'));
    const r = ratifyDirectory(ledgerFile(), 'rt', dir);
    putManifest(dir, { ...manifestOf(dir), name: 'EVIL NAME', version: '9.9.9', routes: undefined });
    resetPlugins();
    const plugins = loadPlugins();
    writeFileSync(join(dir, 'sanctum.plugin.json'), orig); // restored: the check says ok
    const [info] = pluginList(plugins);
    expect(info.ratification!.state).toBe('ok');
    expect(info).toMatchObject({ name: 'RT', version: '1.0.0', routes: true });
    // Not ratified (changed): the live manifest (as read at boot) is what there is to show.
    putManifest(dir, { ...manifestOf(dir), name: 'LIVE NAME' }); // any edit: the folder no longer matches
    expect(pluginList(plugins)[0]).toMatchObject({ name: 'EVIL NAME', version: '9.9.9' });
    writeFileSync(join(dir, 'sanctum.plugin.json'), orig);
    // The copy's own manifest is what is shown, even if it differs from the live one the digest matched.
    writeFileSync(join(snapshotDir(ledgerFile(), 'rt', r.digest), 'sanctum.plugin.json'), JSON.stringify({ ...manifestOf(dir), name: 'COPY NAME', version: '2.0.0' }));
    expect(pluginList(plugins)[0]).toMatchObject({ name: 'COPY NAME', version: '2.0.0' });
  });

  it('a ratified copy with no manifest is unavailable, with the reason, not ok', () => {
    quiet();
    const dir = fullPlugin();
    const r = ratifyDirectory(ledgerFile(), 'rt', dir);
    const plugins = loadPlugins();
    expect(pluginList(plugins)[0].ratification!.state).toBe('ok');
    rmSync(join(snapshotDir(ledgerFile(), 'rt', r.digest), 'sanctum.plugin.json'));
    const [info] = pluginList(plugins);
    expect(info.ratification!.state).toBe('unavailable');
    expect(info.ratification!.detail).toMatch(/manifest in the ratified copy cannot be read/);
    expect(info.error).toMatch(/cannot be ratified: .*manifest in the ratified copy/);
    expect(pluginRows(ctx, plugins)).toEqual([]);
  });

  it('a row removed from the manifest and re-ratified drops out on the next run, with no restart', () => {
    quiet();
    const dir = fullPlugin();
    const m = manifestOf(dir);
    m.dsh.rows.push({ id: 'pkg', name: '@deepseek-ai/dsh-tool-web', config: { risky: true } });
    putManifest(dir, m);
    const plugins = loadPlugins();
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginRows(ctx, plugins).map((r) => r.id)).toEqual(['plugin:rt:marker', 'plugin:rt:pkg']);
    m.dsh.rows = m.dsh.rows.filter((r: any) => r.id !== 'pkg');
    putManifest(dir, m);
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginRows(ctx, plugins).map((r) => r.id)).toEqual(['plugin:rt:marker']);
  });

  it('a re-ratified change to row config, runs, harness and help is picked up without a restart', () => {
    quiet();
    const dir = fullPlugin();
    const plugins = loadPlugins();
    ratifyPlugin(ledgerFile(), plugins[0]);
    const m = manifestOf(dir);
    m.dsh.rows[0].config = { level: 'new' };
    m.help = 'other.md';
    writeFileSync(join(dir, 'other.md'), 'the new help\n');
    putManifest(dir, m);
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginRows(ctx, plugins)[0].config.level).toBe('new');
    expect(pluginHelp(plugins)).toEqual({ rt: 'the new help' });
    m.dsh.runs = ['wake'];
    putManifest(dir, m);
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginRows(ctx, plugins)).toEqual([]); // turn runs no longer match
    expect(pluginRows({ ...ctx, runKind: 'wake' }, plugins).length).toBe(1);
    m.harness = ['claude'];
    putManifest(dir, m);
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginRows({ ...ctx, runKind: 'wake' }, plugins)).toEqual([]);
  });

  it('a manifest in the ratified copy that is not valid contributes nothing, and says why', () => {
    const warn = quiet();
    const dir = fullPlugin();
    const plugins = loadPlugins();
    putManifest(dir, { id: 'rt' }); // no name, no version
    ratifyPlugin(ledgerFile(), plugins[0]);
    expect(pluginRows(ctx, plugins)).toEqual([]);
    expect(pluginHelp(plugins)).toEqual({});
    expect(warn.mock.calls.some((c) => /rt.*manifest in the ratified copy/i.test(String(c[0])))).toBe(true);
  });

  it('the ratified manifest names the routes file: a re-ratified routes path serves from the new file, and a plugin that gains routes is mounted', async () => {
    quiet();
    const dir = fullPlugin();
    const m0 = manifestOf(dir); delete m0.routes; putManifest(dir, m0); // no routes at boot
    resetPlugins();
    const app = express();
    app.use('/api/plugins', createPluginMount({ auth: (_q, _s, next) => next(), internalOnly: (_q, _s, next) => next(), writeGate: (_q, _s, next) => next(), api: { config: {} as any, log: () => {} } }));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/plugins`;
    const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
    const digest = async () => (await call('GET', '/')).body.plugins.find((p: any) => p.id === 'rt').ratification.digest as string;
    expect((await call('POST', '/rt/ratify', { digest: await digest() })).status).toBe(200);
    expect((await call('GET', '/rt/ping')).status).not.toBe(200); // no routes in the ratified manifest
    writeFileSync(join(dir, 'routes2.mjs'), `import express from ${expressUrl};
export default () => { const r = express.Router(); r.get('/ping', (_q, s) => s.json({ pong: 'two' })); return { public: r, internal: express.Router() }; };
`);
    const m1 = manifestOf(dir); m1.routes = 'routes2.mjs'; putManifest(dir, m1);
    expect((await call('POST', '/rt/ratify', { digest: await digest() })).status).toBe(200);
    expect((await call('GET', '/rt/ping')).body).toEqual({ pong: 'two' });
    // and the live manifest edited (not ratified) changes nothing: the check says changed
    const m2 = manifestOf(dir); m2.routes = 'routes.mjs'; putManifest(dir, m2);
    expect((await call('GET', '/rt/ping')).status).toBe(503);
  });
});

// ── B2: the import scan, round 3 ─────────────────────────────────────────────
describe('B2: what the import scan refuses and what it still misses', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  const roots = () => ({ writableRoots: [h.cwd] });
  const caught = (rel: string, text: string, opts: { writableRoots?: string[] } = roots()) => escapingImports(rel, text, opts);

  // Each of these loads code outside the folder in real Node (the %2e%2e, template-literal and .ts cases
  // were checked against node 22 by the round-2 verifier), so each must be refused.
  const refused: Array<[string, string, string]> = [
    ['percent-encoded dots', 'a.mjs', 'import x from "./%2e%2e/x.mjs";'],
    ['percent-encoded dots, upper case', 'a.mjs', 'import x from "./%2E%2E/x.mjs";'],
    ['one encoded dot', 'a.mjs', 'import x from "./.%2e/x.mjs";'],
    ['encoded dots and an encoded slash', 'a.mjs', 'import x from "..%2fx.mjs";'],
    ['encoded backslash', 'a.mjs', 'import x from "..%5cx.mjs";'],
    ['template literal without a substitution', 'a.mjs', 'await import(`../x.mjs`);'],
    ['template literal in require', 'a.cjs', 'const x = require(`../x.cjs`);'],
    ['createRequire', 'a.mjs', "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); r('../x.cjs');"],
    ['new URL against import.meta.url', 'a.mjs', "await import(new URL('../x.mjs', import.meta.url));"],
    ['new Worker with a URL', 'a.mjs', "import { Worker } from 'node:worker_threads'; new Worker(new URL('../x.mjs', import.meta.url));"],
    ['new Worker with a path', 'a.mjs', "import { Worker } from 'node:worker_threads'; new Worker('../x.mjs');"],
    ['import.meta.resolve', 'a.mjs', "const u = import.meta.resolve('../x.mjs');"],
    ['a climb written with hex escapes', 'a.mjs', "await import('\\x2e\\x2e/x.mjs');"],
    ['a climb written with unicode escapes', 'a.mjs', "await import('\\u002e\\u002e/x.mjs');"],
    ['a climb written with braced unicode escapes', 'a.mjs', "await import('\\u{2e}\\u{2e}/x.mjs');"],
    ['a climb written with identity escapes', 'a.mjs', "await import('\\.\\./x.mjs');"],
    ['a tab inside the dots (the URL parser strips it: checked against node 22)', 'a.mjs', "await import('./.\\t./x.mjs');"],
    ['a line continuation inside the dots', 'a.mjs', "await import('.\\\n./x.mjs');"],
    ['a json file', 'data.json', '{"entry": "../x.mjs"}'],
    ['a climb concatenated onto import.meta.dirname', 'a.mjs', "await import(import.meta.dirname + '/../x.mjs');"],
    ['a path.join with a literal .. (from a file in the plugin root)', 'a.mjs', "const p = join(here, '..', '..', 'x.mjs');"],
    ['eval of a string that imports', 'a.mjs', 'eval("import(\'../x.mjs\')");'],
    ['new Function', 'a.mjs', "new Function('return import(\"../x.mjs\")')();"],
    ['a climb that only escapes at depth', 'a/b/c.mjs', "import x from '../../../x.mjs';"],
    ['a comment that mentions an escaping import (comments are scanned too)', 'a.mjs', '// import x from "../x.mjs"\nexport default 1;'],
    ['an escaping import after an apostrophe in a regex or comment', 'a.mjs', "const re = /'/; // it's\nawait import('../x.mjs');"],
  ];
  for (const [what, rel, text] of refused) {
    it(`refuses ${what}`, () => {
      const out = caught(rel, text);
      expect(out.length, text).toBeGreaterThan(0);
      expect(out[0]).toContain(rel);
      expect(out[0]).toMatch(/outside the plugin folder/);
    });
  }

  it('says, in the error, that comments and strings are read as text', () => {
    expect(caught('a.mjs', '// import x from "../x.mjs"')[0]).toMatch(/comment/i);
  });

  it('refuses a template literal with a substitution in a specifier position, as a dynamic specifier', () => {
    const forms = [
      'await import(`./${name}.mjs`);', 'const x = require(`./${name}`);', "createRequire(import.meta.url)(`./${name}.cjs`);",
      'import.meta.resolve(`./${name}`);', "new Worker(`./${name}.mjs`);",
    ];
    for (const f of forms) {
      const out = caught('a.mjs', f);
      expect(out.length, f).toBe(1);
      expect(out[0]).toMatch(/dynamic specifier/);
    }
    expect(caught('a.mjs', 'const s = `hello ${name}`; console.log(`a ${b}`);')).toEqual([]); // a template that is not a specifier
  });

  it('only %XX with two hex digits is a percent escape: printf-style %s and a lone % are literal text, not undecodable paths', () => {
    expect(caught('a.mjs', "log('/%s/%d', a, b); const p = '/%s'; const q = '100%';")).toEqual([]);
    expect(caught('a.mjs', 'import x from "./%2e%2e/x.mjs";').length).toBe(1); // a real escape still decodes
    expect(caught('a.mjs', 'import x from "../%s.mjs";').length).toBe(1); // and a literal % does not hide a climb
  });

  it('refuses a percent escape it cannot decode in something that looks like a path', () => {
    const out = caught('a.mjs', 'import x from "./%E0%A4%A/x.mjs";');
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/percent/);
    expect(caught('a.mjs', "const s = 'width: 100%'; const t = '50% off';")).toEqual([]); // not path-like
  });

  it('refuses an absolute path or file: URL that points inside a companion-writable root, in any case, and leaves other absolute paths alone', () => {
    const inside = join(h.cwd, 'notes', 'x.mjs');
    const outside = join(tmp, 'somewhere-else', 'x.mjs');
    expect(caught('a.mjs', `import x from ${JSON.stringify(inside)};`).length).toBe(1);
    expect(caught('a.mjs', `import x from ${JSON.stringify(pathToFileURL(inside).href)};`).length).toBe(1);
    expect(caught('a.mjs', `import x from ${JSON.stringify(inside.toUpperCase())};`).length).toBe(1); // the write gate lowercases every path
    expect(caught('a.mjs', `import x from ${JSON.stringify(h.cwd)};`).length).toBe(1); // the root itself
    expect(caught('a.mjs', `import x from ${JSON.stringify(outside)};`)).toEqual([]);
    expect(caught('a.mjs', `import x from ${JSON.stringify(pathToFileURL(outside).href)};`)).toEqual([]);
    expect(caught('a.mjs', `import x from ${JSON.stringify(inside)};`, {})).toEqual([]); // no roots given: nothing to compare with
    expect(caught('a.mjs', "const url = '/api/plugins/rt/ping';")).toEqual([]);
  });

  it('a path that reaches a writable root through a symlink is refused too', (t) => {
    const lnk = join(tmp, `lnk-${n}`);
    if (!linkOrSkip(t, h.cwd, lnk, 'dir')) return;
    expect(caught('a.mjs', `import x from ${JSON.stringify(join(lnk, 'x.mjs'))};`).length).toBe(1);
  });

  it('leaves alone what stays inside, bare names, node: builtins, other URLs, ellipses and words that happen to hold two dots', () => {
    const fine = [
      "import a from './d.mjs';", "import b from '../sibling.mjs';", "import d from 'node:fs';", "import e from 'express';", "import f from '@scope/pkg/sub';",
      "export * from './d.mjs';", "const name = './x.mjs'; export const lazy = () => import(name);", "const [first, ...rest] = list; f(...rest);",
      "const range = 'a..b'; const s = 'wait...'; const u = 'https://example.com/a/../b';", "const here = new URL('./data.json', import.meta.url);",
      'const t = `hello ${name}`;',
    ];
    for (const text of fine) expect(caught('a/b/c.mjs', text), text).toEqual([]);
  });

  it('still misses a specifier or path put together at run time, a bare name that resolves from the app\'s node_modules, and an absolute path outside the writable roots', () => {
    const missed = [
      "const parts = ['.', '.', 'x.mjs']; await import(parts.join('/'));", "await import('.' + './x.mjs');", "const n = '..'; await import(n + '/x.mjs');",
      "await import(String.fromCharCode(46, 46) + '/x.mjs');", "import x from 'left-pad';",
      "const r = createRequire(import.meta.url); r(`./${name}.cjs`);", // a template specifier called through an alias
      "import { join } from 'node:path'; const p = join(here, '..', '..', 'x.mjs');", // path pieces are judged one at a time (here from a/b.mjs below) `import x from ${JSON.stringify(join(tmp, 'elsewhere.mjs'))};`,
    ];
    for (const text of missed) expect(caught('a/b.mjs', text), text).toEqual([]);
  });

  it('refuses a plugin folder that holds TypeScript or JSX files, however they are named, with a message that says plugins ship JavaScript', () => {
    quiet();
    for (const f of ['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.jsx', 'A.TS', 'deep/er/types.d.ts']) {
      fresh();
      const dir = fullPlugin();
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'export const x: number = 1;\n');
      const [p] = loadPlugins();
      expect(p.error, f).toContain(f);
      expect(p.error, f).toMatch(/plugins ship JavaScript/);
      expect(pluginRows(ctx, [p]), f).toEqual([]);
      expect(() => ratifyDirectory(ledgerFile(), 'rt', dir), f).toThrow(/plugins ship JavaScript/);
      expect(existsSync(ledgerFile()), f).toBe(false);
    }
  });

  it('scans .json files too, and reports each distinct token once', () => {
    const dir = fullPlugin();
    writeFileSync(join(dir, 'config.json'), '{"a": "../x", "b": "../x"}');
    expect(scanImports(dir).filter((m) => m.includes('config.json')).length).toBe(1);
  });

  it('scanImports and ratifyDirectory take the writable roots: a ratify that would copy a reference into a writable root is refused', () => {
    quiet();
    const dir = fullPlugin();
    const target = join(h.cwd, 'companion-file.mjs');
    writeFileSync(join(dir, 'dsh', 'index.mjs'), `import x from ${JSON.stringify(target)};\nexport default x;\n`);
    expect(scanImports(dir, roots()).join(' ')).toContain(JSON.stringify(target).slice(1, -1)); // the message quotes the literal as written (backslashes doubled on Windows)
    expect(() => ratifyDirectory(ledgerFile(), 'rt', dir, undefined, roots())).toThrow(/dsh\/index\.mjs/);
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('the loader hands the configured writable roots to the scan: a plugin that names a file in agent.cwd has a scan error', () => {
    quiet();
    const dir = fullPlugin();
    writeFileSync(join(dir, 'dsh', 'index.mjs'), `import x from ${JSON.stringify(join(h.cwd, 'x.mjs'))};\nexport default x;\n`);
    const [p] = loadPlugins();
    expect(p.error).toContain(JSON.stringify(join(h.cwd, 'x.mjs')).slice(1, -1));
    expect(pluginRows(ctx, [p])).toEqual([]);
  });
});

// ── B4: /tmp under Codex and dsh, and case folding like the write gate ───────
describe('B4: the sandboxes\' own writable folders, and the gate\'s case folding', () => {
  beforeEach(fresh);
  afterEach(() => { vi.restoreAllMocks(); if (savedProvider === undefined) delete process.env.AGENT_PROVIDER; else process.env.AGENT_PROVIDER = savedProvider; if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir; });
  const savedTmpdir = process.env.TMPDIR;
  const savedProvider = process.env.AGENT_PROVIDER;
  // A folder that is nowhere near the test's temp tree and is never created: only its name is judged.
  const awayFromTmp = () => join(homedir(), `.sanctum-b4-ledger-${n}`);
  const cfgOf = (provider: string, over: Record<string, unknown> = {}) => ({
    plugins: { trust: 'person', dir: '', enabled: [] }, agent: { provider, cwd: h.cwd, codex: { additional_directories: [], sandbox_mode: 'workspace-write' }, dsh: { home: '', sandbox_mode: 'workspace-write' } }, hooks: {}, ...over,
  });

  it('under Claude, /tmp and $TMPDIR are not writable roots (Claude\'s write gate does not list them)', () => {
    const labels = writableRoots(cfgOf('claude'), { pluginsDir: true }).map((w) => w.label);
    expect(labels.some((l) => /tmp/i.test(l))).toBe(false);
  });

  for (const provider of ['codex', 'dsh']) {
    it(`when the active provider is ${provider}, writableRoots includes /tmp and $TMPDIR (neither exclude_slash_tmp nor exclude_tmpdir_env_var is set), so a ledger there is refused`, () => {
      quiet();
      process.env.TMPDIR = join(homedir(), `.sanctum-b4-tmpdir-${n}`); // a $TMPDIR that is not under /tmp, so it is the one that matches
      const roots = writableRoots(cfgOf(provider), { pluginsDir: true });
      if (process.platform !== 'win32') expect(roots.map((w) => w.path)).toContain('/tmp');
      expect(roots.map((w) => w.path)).toContain(process.env.TMPDIR);
      h.provider = provider;
      h.ledgerDir = join(process.env.TMPDIR, 'ledger');
      const info = pluginsDisabledInfo();
      expect(info?.reason).toBe('ledger_writable');
      expect(info?.detail).toContain(process.env.TMPDIR);
      if (process.platform !== 'win32') {
        h.ledgerDir = '/tmp/sanctum-b4-ledger-never-created';
        expect(pluginsDisabledInfo()?.reason).toBe('ledger_writable');
        expect(pluginsDisabledInfo()?.detail).toMatch(/\/tmp/);
      }
      h.ledgerDir = awayFromTmp();
      expect(pluginsDisabledInfo()).toBeNull(); // a ledger elsewhere is fine
    });
  }

  it('the same ledger under /tmp is fine while Claude is the active provider', () => {
    quiet();
    h.ledgerDir = join(tmpdir(), `sanctum-b4-claude-${n}`);
    expect(pluginsDisabledInfo()).toBeNull();
  });

  it('the shipped hello plugin scans clean under claude, codex and dsh (its comments name no path in a sandbox temp folder)', () => {
    const repoHello = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'plugins', 'hello');
    for (const provider of ['claude', 'codex', 'dsh']) {
      expect(scanImports(repoHello, { writableRoots: writableRoots(cfgOf(provider)).map((w) => w.path) }), provider).toEqual([]);
    }
  });

  it('AGENT_PROVIDER wins over the yaml, as activeProviderName does: codex from the environment adds /tmp', () => {
    quiet();
    process.env.AGENT_PROVIDER = 'CODEX';
    h.ledgerDir = join(tmpdir(), `sanctum-b4-env-${n}`);
    expect(pluginsDisabledInfo()?.reason).toBe('ledger_writable');
  });

  it('a plugin root under /tmp is refused too while Codex or dsh runs (the roots check uses the same list)', () => {
    quiet();
    const dir = join(tmp, `person-${n}`);
    mkdirSync(dir, { recursive: true });
    expect(personRoot(cfgOf('claude', { plugins: { trust: 'person', dir, enabled: [] } }))).toBe(dir);
    expect(personRoot(cfgOf('codex', { plugins: { trust: 'person', dir, enabled: [] } }))).toBe('');
    expect(personRoot(cfgOf('dsh', { plugins: { trust: 'person', dir, enabled: [] } }))).toBe('');
  });

  it('the ledger check folds case on every OS, like the write gate (hooks.ts lowercases every path): Comp and comp are the same folder to it', () => {
    quiet();
    const base = join(tmp, `case-${n}`);
    mkdirSync(join(base, 'Comp'), { recursive: true });
    mkdirSync(join(base, 'comp', 'ledger'), { recursive: true });
    h.cwd = join(base, 'Comp');
    h.ledgerDir = join(base, 'comp', 'ledger');
    expect(pluginsDisabledInfo()?.reason).toBe('ledger_writable');
    expect(ledgerClash({ agent: { cwd: join(base, 'Comp') }, plugins: { ledger_dir: join(base, 'COMP', 'ledger') } })?.label).toBe('agent.cwd');
  });

  it('the plugin-root check folds case on every OS too', () => {
    quiet();
    const base = join(tmp, `case-root-${n}`);
    mkdirSync(join(base, 'Home', 'plugins'), { recursive: true });
    const cfg = cfgOf('claude', { plugins: { trust: 'person', dir: join(base, 'Home', 'plugins'), enabled: [] }, agent: { provider: 'claude', cwd: join(base, 'HOME'), codex: {}, dsh: {} } });
    expect(personRoot(cfg)).toBe(''); // plugins.dir is inside agent.cwd once case is folded
  });

  it('a root that differs only by a name that is not a prefix (Comp vs Company) is still not a clash', () => {
    const base = join(tmp, `case-prefix-${n}`);
    mkdirSync(join(base, 'Company', 'ledger'), { recursive: true });
    mkdirSync(join(base, 'comp'), { recursive: true });
    expect(ledgerClash({ agent: { cwd: join(base, 'comp') }, plugins: { ledger_dir: join(base, 'Company', 'ledger') } })).toBeNull();
  });
});

// ── B6: a per-file stat prefilter that is sound ──────────────────────────────
// On win32 trustStat is false by design (ctime means something else), so the three cache-hit tests below skip there;
// the "with trustStat false" test covers that path on every platform.
describe('B6: the per-file stat prefilter', () => {
  beforeEach(() => { fresh(); resetRatifyCache(); });
  afterEach(() => vi.restoreAllMocks());
  const realNow = Date.now.bind(Date);
  /** Pretend the check runs `ms` later than it does, so files written a moment ago are old enough to be trusted. */
  const later = (ms: number) => vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ms);
  const setup = (files = 12) => {
    const dir = join(h.shipped, 'cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sanctum.plugin.json'), '{"id":"cache"}');
    for (let i = 0; i < files - 1; i++) writeFileSync(join(dir, `f${i}.mjs`), `export default ${i};\n`.repeat(20));
    ratifyDirectory(ledgerFile(), 'cache', dir);
    return dir;
  };
  const check = (dir: string, o?: { trustStat?: boolean }) => checkRatification('cache', dir, ledgerFile(), o);
  const stats = () => ({ ...ratifyCacheStats });
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  it.skipIf(process.platform === 'win32')('rehashes only what changed: the second check hashes nothing, and returns the very digest a full rehash gives', () => {
    const dir = setup();
    later(10_000);
    const first = check(dir);
    expect(first.state).toBe('ok');
    expect(stats()).toEqual({ hits: 0, hashed: 12 });
    const second = check(dir);
    expect(second).toEqual(first);
    expect(stats()).toEqual({ hits: 12, hashed: 12 }); // all from the cache
    expect(second.digest).toBe(pluginDigest(dir).digest); // the uncached digest is the same
  });

  it.skipIf(process.platform === 'win32')('an edit is rehashed, and only that file', () => {
    const dir = setup();
    later(10_000);
    check(dir);
    writeFileSync(join(dir, 'f3.mjs'), 'export default "edited";\n');
    const r = check(dir);
    expect(r.state).toBe('changed');
    expect(r.changes).toEqual([{ path: 'f3.mjs', kind: 'modified' }]);
    expect(stats()).toEqual({ hits: 11, hashed: 12 + 1 });
  });

  posixOnly('an edit that puts the size and the mtime back is still caught on POSIX: the edit changes ctime, and utimes cannot set ctime', () => {
    const dir = setup();
    const f = join(dir, 'f4.mjs');
    later(10_000);
    check(dir);
    const before = statSync(f);
    const ref = f + '.ref';
    writeFileSync(ref, '');
    expect(spawnSync('touch', ['-r', f, ref]).status).toBe(0); // the reference carries f's times to the nanosecond
    const text = readFileSync(f, 'utf-8');
    writeFileSync(f, text.replace('export default 4;', 'export default 7;')); // same size
    expect(spawnSync('touch', ['-r', ref, f]).status).toBe(0); // mtime and atime put back exactly (utimes in Node loses the sub-millisecond part)
    rmSync(ref);
    const after = statSync(f);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.ctimeMs).not.toBe(before.ctimeMs); // this is what makes the prefilter sound
    const r = check(dir);
    expect(r.state).toBe('changed');
    expect(r.changes).toEqual([{ path: 'f4.mjs', kind: 'modified' }]);
    expect(stats().hashed).toBe(12 + 1); // that one file was read again, from the changed tuple
  });

  it('the file SET is walked every time: an added and a removed file are seen with a warm cache', () => {
    const dir = setup();
    later(10_000);
    check(dir);
    writeFileSync(join(dir, 'new.mjs'), 'x');
    rmSync(join(dir, 'f1.mjs'));
    const r = check(dir);
    expect(r.state).toBe('changed');
    expect(r.changes).toEqual([{ kind: 'removed', path: 'f1.mjs' }, { kind: 'added', path: 'new.mjs' }]);
    // a link anywhere is still caught by the walk
  });

  it('a file written moments before the check is not trusted (the racy-timestamp window): it is hashed again next time', () => {
    const dir = setup();
    check(dir); // real time: every file was written well under 2 s ago
    check(dir);
    expect(stats()).toEqual({ hits: 0, hashed: 24 });
  });

  it('a cached hash is dropped after a minute and the file is read again, whatever the stat says', () => {
    const dir = setup();
    const spy = later(10_000);
    check(dir);
    spy.mockImplementation(() => realNow() + 10_000 + 61_000);
    check(dir);
    expect(stats()).toEqual({ hits: 0, hashed: 24 });
  });

  it('with trustStat false (the default on win32, where ctime means something else) every check rehashes every file', () => {
    const dir = setup();
    later(10_000);
    check(dir, { trustStat: false }); check(dir, { trustStat: false });
    expect(stats()).toEqual({ hits: 0, hashed: 24 });
  });

  it('a file that cannot be read is unavailable, with a warm cache too', (t) => {
    const dir = setup();
    later(10_000);
    check(dir);
    const f = join(dir, 'f2.mjs');
    rmSync(f);
    if (!linkOrSkip(t, join(dir, 'f3.mjs'), f, 'file')) return;
    expect(check(dir).state).toBe('unavailable');
  });

  it.skipIf(process.platform === 'win32')('pluginRows and the list share the check, so a request path is the cached one', () => {
    const dir = join(h.shipped, 'hello');
    cpSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'plugins', 'hello'), dir, { recursive: true });
    h.enabled = ['hello'];
    ratifyDirectory(ledgerFile(), 'hello', dir);
    later(10_000);
    const plugins = loadPlugins();
    resetRatifyCache();
    expect(pluginRows({ harness: 'dsh', runKind: 'turn', threadId: 't' }, plugins).length).toBe(1);
    const afterFirst = stats();
    pluginRows({ harness: 'dsh', runKind: 'turn', threadId: 't' }, plugins);
    expect(stats().hashed).toBe(afterFirst.hashed);
    expect(stats().hits).toBeGreaterThan(afterFirst.hits);
  });
});

// ── B7: the previous snapshot survives one re-ratification ───────────────────
describe('B7: current and previous snapshots are kept; older ones go; the previous one goes at the next boot', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { const s = server; server = undefined; if (s) s.close(() => r()); else r(); }));
  const snaps = (id = 'rt') => { const d = join(dirname(ledgerFile()), 'snapshots', id); return existsSync(d) ? readdirSync(d).sort() : []; };
  const edit = (dir: string, text: string) => writeFileSync(join(dir, 'help.md'), text);

  it('a re-ratification keeps the new copy and the one before it, and the ledger names the previous digest; a third drops the first', () => {
    quiet(); const dir = fullPlugin();
    const a = ratifyDirectory(ledgerFile(), 'rt', dir).digest;
    expect(readLedger(ledgerFile()).plugins.rt.previous).toBeUndefined();
    edit(dir, 'two\n');
    const b = ratifyDirectory(ledgerFile(), 'rt', dir).digest;
    expect(snaps()).toEqual([a, b].sort());
    expect(readLedger(ledgerFile()).plugins.rt).toMatchObject({ digest: b, previous: a });
    edit(dir, 'three\n');
    const c = ratifyDirectory(ledgerFile(), 'rt', dir).digest;
    expect(snaps()).toEqual([b, c].sort());
    expect(readLedger(ledgerFile()).plugins.rt).toMatchObject({ digest: c, previous: b });
  });

  it('ratifying the same code again changes nothing, and keeps the previous copy', () => {
    quiet(); const dir = fullPlugin();
    const a = ratifyDirectory(ledgerFile(), 'rt', dir).digest;
    edit(dir, 'two\n');
    const b = ratifyDirectory(ledgerFile(), 'rt', dir).digest;
    ratifyDirectory(ledgerFile(), 'rt', dir);
    expect(snaps()).toEqual([a, b].sort());
    expect(readLedger(ledgerFile()).plugins.rt).toMatchObject({ digest: b, previous: a });
  });

  it('pruneSnapshots at boot (the default) keeps only the current copy; with keepPrevious it keeps the previous one too; a malformed previous is ignored', () => {
    quiet(); const dir = fullPlugin();
    const a = ratifyDirectory(ledgerFile(), 'rt', dir).digest;
    edit(dir, 'two\n');
    const b = ratifyDirectory(ledgerFile(), 'rt', dir).digest;
    pruneSnapshots(ledgerFile(), { keepPrevious: true });
    expect(snaps()).toEqual([a, b].sort());
    const ledger = readLedger(ledgerFile());
    ledger.plugins.rt.previous = '../../etc';
    writeFileSync(ledgerFile(), JSON.stringify(ledger));
    pruneSnapshots(ledgerFile(), { keepPrevious: true });
    expect(snaps()).toEqual([b]);
  });

  it('starting the app prunes the previous copy', () => {
    quiet(); const dir = fullPlugin();
    ratifyDirectory(ledgerFile(), 'rt', dir);
    edit(dir, 'two\n');
    const b = ratifyDirectory(ledgerFile(), 'rt', dir).digest;
    expect(snaps().length).toBe(2);
    createPluginMount({ auth: (_q, _s, next) => next(), internalOnly: (_q, _s, next) => next(), writeGate: (_q, _s, next) => next(), api: { config: {} as any, log: () => {} } });
    expect(snaps()).toEqual([b]);
  });

  it('a re-ratification while a handler is awaiting a lazy import does not 500: the import still finds its file', async () => {
    quiet(); const dir = fullPlugin();
    writeFileSync(join(dir, 'routes.mjs'), `import express from ${expressUrl};
export default () => { const r = express.Router();
  r.get('/ping', (_q, s) => s.json({ ok: 1 }));
  r.get('/slow', async (_q, s) => { await new Promise((ok) => setTimeout(ok, 300)); try { const m = await import('./lazy.mjs'); s.json({ v: m.v }); } catch (e) { s.status(500).json({ err: String(e.code || e) }); } });
  return { public: r, internal: express.Router() }; };
`);
    writeFileSync(join(dir, 'lazy.mjs'), "export const v = 'A';\n");
    const app = express();
    app.use('/api/plugins', createPluginMount({ auth: (_q, _s, next) => next(), internalOnly: (_q, _s, next) => next(), writeGate: (_q, _s, next) => next(), api: { config: {} as any, log: () => {} } }));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/plugins`;
    const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
    const digest = async () => (await call('GET', '/')).body.plugins.find((p: any) => p.id === 'rt').ratification.digest as string;
    expect((await call('POST', '/rt/ratify', { digest: await digest() })).status).toBe(200);
    expect((await call('GET', '/rt/ping')).status).toBe(200);
    const slow = call('GET', '/rt/slow'); // is now waiting, with ./lazy.mjs still to import from the first copy
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(join(dir, 'notes.txt'), 'a new file, so a new digest\n');
    expect((await call('POST', '/rt/ratify', { digest: await digest() })).status).toBe(200);
    const r = await slow;
    expect(r).toEqual({ status: 200, body: { v: 'A' } });
  });
});

// ── B8: the ratify route judges the plugin as it is now ──────────────────────
describe('B8: the ratify route re-scans the plugin; removeFromLedger is gone', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { const s = server; server = undefined; if (s) s.close(() => r()); else r(); }));
  async function start() {
    const app = express();
    app.use('/api/plugins', createPluginMount({ auth: (_q, _s, next) => next(), internalOnly: (_q, _s, next) => next(), writeGate: (_q, _s, next) => next(), api: { config: {} as any, log: () => {} } }));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/plugins`;
    const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
    const entry = async () => (await call('GET', '/')).body.plugins.find((p: any) => p.id === 'rt');
    return { call, entry };
  }

  it('a plugin that had a scan error at boot and was fixed since can be ratified without a restart, and then runs', async () => {
    quiet(); const dir = fullPlugin();
    rmSync(join(dir, 'routes.mjs')); // broken at boot: the manifest names routes.mjs
    const { call, entry } = await start();
    expect((await entry()).error).toMatch(/routes/);
    writeFileSync(join(dir, 'routes.mjs'), `import express from ${expressUrl};
export default () => { const r = express.Router(); r.get('/ping', (_q, s) => s.json({ pong: 1 })); return { public: r, internal: express.Router() }; };
`);
    const d = (await entry()).ratification.digest;
    expect((await call('POST', '/rt/ratify', { digest: d })).status).toBe(200);
    expect((await entry()).error).toBeNull();
    expect((await call('GET', '/rt/ping')).body).toEqual({ pong: 1 });
    expect(pluginRows(ctx, loadPlugins()).map((r) => r.id)).toEqual(['plugin:rt:marker']);
  });

  it('a plugin that was fine at boot and broke since is refused on the live scan, and its list entry shows the new error', async () => {
    quiet(); const dir = fullPlugin();
    const { call, entry } = await start();
    expect((await entry()).error).toMatch(/not ratified/);
    rmSync(join(dir, 'help.md'));
    const r = await call('POST', '/rt/ratify', { digest: 'a'.repeat(64) });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'plugin_invalid' });
    expect(r.body.detail).toMatch(/help/);
    expect((await entry()).error).toMatch(/help/);
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('a manifest id that changed since boot cannot be ratified under the old id', async () => {
    quiet(); const dir = fullPlugin();
    const { call, entry } = await start();
    const m = JSON.parse(readFileSync(join(dir, 'sanctum.plugin.json'), 'utf-8')); m.id = 'renamed';
    writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify(m));
    const r = await call('POST', '/rt/ratify', { digest: (await entry()).ratification.digest });
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/renamed/);
  });

  it('removeFromLedger no longer exists (nothing used it; there is no un-ratify)', async () => {
    const mod = await import('./plugin-ratify.js') as Record<string, unknown>;
    expect(mod.removeFromLedger).toBeUndefined();
  });
});

describe('L1: a bare package name resolves from the ratified copy, not from the app', () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());
  const importIn = (snap: string, file: string) => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(join(snap, file)).href)}).then((m) => console.log(m.default), (e) => { console.log(e.code); });`], { encoding: 'utf-8', cwd: tmp });
    return run.stdout.trim();
  };
  it('with plugins.ledger_dir outside the app folder, `import express` fails with ERR_MODULE_NOT_FOUND; a node_modules inside the plugin folder resolves', () => {
    quiet();
    h.ledgerDir = join(dirname(projectRoot()), 'custom-ledger');
    const dir = fullPlugin();
    writeFileSync(join(dir, 'bare.mjs'), "import e from 'express';\nexport default typeof e;\n");
    writeFileSync(join(dir, 'vendored.mjs'), "import v from 'vend';\nexport default v;\n");
    mkdirSync(join(dir, 'node_modules', 'vend'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'vend', 'package.json'), '{"name":"vend","type":"module","main":"index.js"}');
    writeFileSync(join(dir, 'node_modules', 'vend', 'index.js'), "export default 'vendored';\n");
    const r = ratifyDirectory(ledgerFile(), 'rt', dir);
    const snap = snapshotDir(ledgerFile(), 'rt', r.digest);
    expect(importIn(snap, 'bare.mjs')).toBe('ERR_MODULE_NOT_FOUND'); // the app's node_modules is not on the path up from the ledger folder
    expect(importIn(snap, 'vendored.mjs')).toBe('vendored');
  });
});
