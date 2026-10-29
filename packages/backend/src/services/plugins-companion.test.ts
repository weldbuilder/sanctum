// trust: companion (the default): the live folder runs, nothing is ratified, the audit file records changes,
// the companion manages plugins. The person-gated mode has its own tests in plugins.test.ts and plugin-ratify.test.ts
// (their config stubs say trust: 'person').
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const h = vi.hoisted(() => ({ trust: 'companion', ledgerDir: '', shipped: '', person: '', enabled: [] as string[], cwd: '', provider: 'claude', dshSandbox: 'workspace-write' }));
vi.mock('../config.js', () => ({
  get PROJECT_ROOT() { return dirname(h.shipped); },
  getSanctumConfig: () => ({
    plugins: { trust: h.trust, dir: h.person, enabled: h.enabled, ...(h.ledgerDir && { ledger_dir: h.ledgerDir }) },
    agent: { provider: h.provider, cwd: h.cwd, codex: { additional_directories: [], sandbox_mode: 'workspace-write' }, dsh: { home: '', sandbox_mode: h.dshSandbox } },
    hooks: { extra_write_paths: [] },
    server: { host: '127.0.0.1', port: 3099 },
  }),
  internalBaseUrl: (s: { host: string; port: number }) => `http://${s.host}:${s.port}`,
}));
vi.mock('../middleware/internal-token.js', () => ({ getInternalToken: () => 'secret-token-xyz' }));
import {
  loadPlugins, resetPlugins, pluginRows, pluginList, pluginHelp, createPluginMount, pluginsDisabled, personRoot, shippedRoot, pluginTrust, currentLedgerFile, currentAuditFile,
} from './plugins.js';
import { readAudit, auditHistory } from './plugin-audit.js';
import { ratifyDirectory } from './plugin-ratify.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-plugins-companion-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const expressUrl = JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('express')).href);
const quiet = () => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); };
afterEach(() => vi.restoreAllMocks());

let n = 0;
function fresh() {
  const base = join(tmp, `t${n++}`);
  h.trust = 'companion';
  h.shipped = join(base, 'repo', 'plugins');
  h.person = join(base, 'person-plugins');
  h.cwd = join(base, 'companion-home');
  h.ledgerDir = '';
  h.provider = 'claude';
  h.dshSandbox = 'workspace-write';
  h.enabled = [];
  mkdirSync(h.shipped, { recursive: true });
  mkdirSync(h.person, { recursive: true });
  mkdirSync(h.cwd, { recursive: true });
  resetPlugins();
}
function plugin(root: string, id: string, manifest: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify({ id, name: id.toUpperCase(), version: '1.0.0', harness: ['dsh'], ...manifest }));
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), body); }
  return dir;
}
const rowPlugin = (root: string, id: string, extra: Record<string, unknown> = {}, files: Record<string, string> = {}) =>
  plugin(root, id, { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs', config: { v: 1 } }] }, ...extra }, { 'dsh/index.mjs': 'export default {}', ...files });
const routesBody = (reply: string) => `import express from 'express';
export default () => { const r = express.Router(); r.get('/ping', (_q, s) => s.json({ pong: ${JSON.stringify(reply)} })); const i = express.Router(); i.get('/who', (_q, s) => s.json({ internal: ${JSON.stringify(reply)} })); return { public: r, internal: i }; };`.replace("from 'express'", `from ${expressUrl}`);
const routesPlugin = (root: string, id: string, reply = 'v1') =>
  plugin(root, id, { routes: 'routes.mjs' }, { 'routes.mjs': routesBody(reply) });
const ctx = { harness: 'dsh' as const, runKind: 'turn' as const, threadId: 't1' };
const enable = (...ids: string[]) => { h.enabled = ids; };

describe('trust: companion, loading', () => {
  beforeEach(fresh);
  it('pluginTrust: companion unless the config says person', () => {
    expect(pluginTrust()).toBe('companion');
    expect(pluginTrust({ plugins: {} })).toBe('companion');
    expect(pluginTrust({ plugins: { trust: 'weird' } })).toBe('companion');
    h.trust = 'person';
    expect(pluginTrust()).toBe('person');
  });

  it('an enabled plugin contributes rows from the LIVE folder with no ratification at all', () => {
    quiet();
    const dir = rowPlugin(h.shipped, 'live');
    enable('live');
    const rows = pluginRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('plugin:live:r');
    expect(rows[0].name.startsWith(realpathSync.native(join(dir, 'dsh')))).toBe(true); // the live folder (by real path, as the loader resolves it: realpathSync.native), not a snapshot copy
    expect(existsSync(currentLedgerFile())).toBe(false); // checkRatification / the ledger were never involved
    expect(rows[0].config).toMatchObject({ v: 1, sanctum: { token: 'secret-token-xyz', threadId: 't1' } });
  });

  it('an edit applies on the next run: the manifest, the entry file and the help are read again', () => {
    quiet();
    const dir = rowPlugin(h.shipped, 'live', { help: 'help.md' }, { 'help.md': 'first' });
    enable('live');
    expect(pluginRows(ctx)[0].config.v).toBe(1);
    expect(pluginHelp()).toEqual({ live: 'first' });
    writeFileSync(join(dir, 'help.md'), 'second');
    writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify({ id: 'live', name: 'LIVE', version: '1.1.0', harness: ['dsh'], help: 'help.md', dsh: { rows: [{ id: 'r2', entry: 'dsh/index.mjs', config: { v: 2 } }] } }));
    const rows = pluginRows(ctx);
    expect(rows.map((r) => r.id)).toEqual(['plugin:live:r2']);
    expect(rows[0].config.v).toBe(2);
    expect(pluginHelp()).toEqual({ live: 'second' });
  });

  it('a plugin that becomes invalid stops contributing for that run and comes back when fixed', () => {
    quiet();
    const dir = rowPlugin(h.shipped, 'live');
    enable('live');
    expect(pluginRows(ctx)).toHaveLength(1);
    writeFileSync(join(dir, 'sanctum.plugin.json'), '{ broken');
    expect(pluginRows(ctx)).toEqual([]);
    writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify({ id: 'live', name: 'L', version: '1', harness: ['dsh'], dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } }));
    expect(pluginRows(ctx)).toHaveLength(1);
  });

  it('only enabled plugins contribute, and a plugin the companion made after the scan is found when it is enabled', () => {
    quiet();
    rowPlugin(h.shipped, 'a');
    loadPlugins(); // scanned: only "a" exists
    rowPlugin(h.shipped, 'b'); // made afterwards
    enable('b');
    expect(pluginRows(ctx).map((r) => r.id)).toEqual(['plugin:b:r']);
  });

  it('harness and run kind still select rows', () => {
    quiet();
    rowPlugin(h.shipped, 'live', { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }], runs: ['wake'] } });
    enable('live');
    expect(pluginRows(ctx)).toEqual([]);
    expect(pluginRows({ ...ctx, runKind: 'wake' })).toHaveLength(1);
    expect(pluginRows({ ...ctx, harness: 'codex' as any })).toEqual([]);
  });
});

describe('trust: companion, no containment refusals', () => {
  beforeEach(fresh);
  it('plugins.dir inside the companion writable roots is accepted', () => {
    quiet();
    h.person = join(h.cwd, 'plugins');
    mkdirSync(h.person, { recursive: true });
    rowPlugin(h.person, 'mine');
    enable('mine');
    expect(personRoot({ plugins: { trust: 'companion', dir: h.person }, agent: { cwd: h.cwd } })).toBe(h.person);
    expect(pluginRows(ctx).map((r) => r.id)).toEqual(['plugin:mine:r']);
  });

  it('the shipped root loads even when agent.cwd contains it (the default "." setup)', () => {
    quiet();
    h.cwd = dirname(h.shipped); // the app folder, which contains <repo>/plugins
    rowPlugin(h.shipped, 'hello');
    enable('hello');
    expect(shippedRoot({ plugins: { trust: 'companion' }, agent: { cwd: h.cwd } })).toBe(h.shipped);
    expect(pluginRows(ctx)).toHaveLength(1);
  });

  it('the ledger folder inside a writable root, and danger-full-access, do not switch plugins off', () => {
    quiet();
    h.ledgerDir = join(h.cwd, 'ledger');
    h.provider = 'dsh';
    h.dshSandbox = 'danger-full-access';
    rowPlugin(h.shipped, 'live');
    enable('live');
    expect(pluginsDisabled()).toBeNull();
    expect(pluginRows(ctx)).toHaveLength(1);
    // person mode with the same config: off
    h.trust = 'person';
    resetPlugins();
    expect(pluginsDisabled()).toBe('full_access');
  });

  it('the app-correctness checks stay: a manifest path out of its folder is a scan error', () => {
    quiet();
    plugin(h.shipped, 'esc', { dsh: { rows: [{ id: 'r', entry: '../outside.mjs' }] } });
    const p = loadPlugins().find((x) => x.id === 'esc')!;
    expect(p.manifest).toBeNull();
    expect(p.error).toMatch(/entry must be a relative path inside the plugin folder/);
    enable('esc');
    expect(pluginRows(ctx)).toEqual([]);
  });

  it('a link in a manifest path that resolves outside the folder is a scan error', (t) => {
    quiet();
    const outside = join(tmp, `outside-${n}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'index.mjs'), 'export default {}');
    const dir = plugin(h.shipped, 'lnk', { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } });
    try { symlinkSync(outside, join(dir, 'dsh'), process.platform === 'win32' ? 'junction' : undefined); } catch (e: any) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(e?.code)) { t.skip('no symlinks here'); return; } throw e; }
    const p = loadPlugins().find((x) => x.id === 'lnk')!;
    expect(p.error).toMatch(/resolves outside the plugin folder/);
    enable('lnk');
    expect(pluginRows(ctx)).toEqual([]);
  });

  it('a plugin folder that is itself a link out of its root is refused', (t) => {
    quiet();
    const elsewhere = rowPlugin(join(tmp, `elsewhere-${n}`), 'away');
    try { symlinkSync(elsewhere, join(h.shipped, 'away'), process.platform === 'win32' ? 'junction' : undefined); } catch (e: any) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(e?.code)) { t.skip('no symlinks here'); return; } throw e; }
    const p = loadPlugins().find((x) => x.id === 'away')!;
    expect(p.error).toBe('plugin folder resolves outside its root');
    enable('away');
    expect(pluginRows(ctx)).toEqual([]);
  });

  it('the import scan still runs, but its findings are a warning on the list entry and the plugin still runs', () => {
    quiet();
    rowPlugin(h.shipped, 'peek', {}, { 'dsh/index.mjs': "import x from '../../../../etc/outside.mjs';\nexport default {}" });
    enable('peek');
    const [info] = pluginList();
    expect(info.error).toBeNull();
    expect(info.warnings?.length).toBeGreaterThan(0);
    expect(info.warnings!.join(' ')).toMatch(/outside/i);
    expect(info.warnings!.join(' ')).toMatch(/this import reaches outside the plugin folder/);
    expect(info.warnings!.join(' ')).not.toMatch(/the hash covers only the folder/); // no hash gates anything here
    expect(pluginRows(ctx)).toHaveLength(1);
  });
});

describe('trust: companion, the audit record', () => {
  beforeEach(fresh);
  it('records the first sight, then every change with its files, in audit.json (not ratified.json)', () => {
    quiet();
    const dir = rowPlugin(h.shipped, 'live');
    enable('live');
    pluginRows(ctx);
    const file = currentAuditFile();
    expect(file.endsWith('audit.json')).toBe(true);
    expect(auditHistory(file, 'live')).toHaveLength(1);
    pluginRows(ctx); // unchanged: nothing new
    expect(auditHistory(file, 'live')).toHaveLength(1);
    writeFileSync(join(dir, 'dsh', 'index.mjs'), 'export default { changed: true }');
    writeFileSync(join(dir, 'notes.md'), 'hi');
    pluginRows(ctx);
    const hist = auditHistory(file, 'live');
    expect(hist).toHaveLength(2);
    expect(hist[1].changes).toEqual([{ path: 'dsh/index.mjs', kind: 'modified' }, { path: 'notes.md', kind: 'added' }]);
    expect(existsSync(currentLedgerFile())).toBe(false);
    expect(readdirSync(dirname(file))).toEqual(['audit.json']);
  });

  it('a change made while the app was not looking is recorded on the next load', () => {
    quiet();
    const dir = rowPlugin(h.shipped, 'live');
    enable('live');
    loadPlugins();
    resetPlugins();
    writeFileSync(join(dir, 'x.md'), 'new');
    loadPlugins();
    expect(auditHistory(currentAuditFile(), 'live').map((e) => e.changes.map((c) => c.path))).toEqual([['dsh/index.mjs', 'sanctum.plugin.json'], ['x.md']]);
  });

  it('a plugin ratified before the switch seeds the record as already viewed', () => {
    quiet();
    const dir = rowPlugin(h.shipped, 'old');
    enable('old');
    ratifyDirectory(currentLedgerFile(), 'old', dir);
    const [info] = pluginList();
    expect(info.audit).toMatchObject({ changed_since_last_view: false, changes: [] });
    writeFileSync(join(dir, 'x.md'), 'edit');
    expect(pluginList()[0].audit).toMatchObject({ changed_since_last_view: true, changes: [{ path: 'x.md', kind: 'added' }] });
  });

  it('the list entry carries audit and warnings and no ratification', () => {
    quiet();
    rowPlugin(h.shipped, 'live');
    enable('live');
    const [info] = pluginList();
    expect(info).toMatchObject({ id: 'live', enabled: true, error: null, warnings: [], audit: { changed_since_last_view: true } });
    expect(info.audit?.last_change_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(info.ratification).toBeUndefined();
  });

  it('an unhashable folder (a link inside it) records nothing and still runs', (t) => {
    quiet();
    const dir = rowPlugin(h.shipped, 'live');
    try { symlinkSync(join(dir, 'dsh'), join(dir, 'alias'), process.platform === 'win32' ? 'junction' : undefined); } catch (e: any) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(e?.code)) { t.skip('no symlinks here'); return; } throw e; }
    enable('live');
    expect(pluginRows(ctx)).toHaveLength(1);
    expect(pluginList()[0].audit).toBeNull();
    expect(existsSync(currentAuditFile())).toBe(false);
  });
});

// ── The routes ──────────────────────────────────────────────────────────────
describe('trust: companion, /api/plugins', () => {
  beforeEach(fresh);
  let server: Server | undefined;
  const setEnabledCalls: string[][] = [];
  const setEnabledOpts: { memory?: boolean }[] = [];
  async function start(over: { trust?: 'companion' | 'person'; setEnabled?: ((ids: string[]) => void) | null; writes?: boolean } = {}) {
    setEnabledCalls.length = 0;
    setEnabledOpts.length = 0;
    const app = express();
    app.use('/api/plugins', createPluginMount({
      auth: (req, res, next) => (req.headers['x-session'] === 'yes' ? next() : res.status(401).json({ error: 'auth' })),
      internalOnly: (req, res, next) => (req.headers['x-internal-token'] === 'secret-token-xyz' ? next() : res.status(404).json({ error: 'nf' })),
      writeGate: (_req, res, next) => (over.writes === false ? res.status(403).json({ error: 'app_write_off' }) : next()),
      api: { config: {} as any, log: () => {} },
      ...(over.setEnabled === null ? {} : { setEnabled: over.setEnabled ?? ((ids: string[], opts?: { memory?: boolean }) => { setEnabledCalls.push(ids); setEnabledOpts.push({ memory: opts?.memory }); h.enabled = ids; }) }),
    }));
    await new Promise<void>((r) => { server = createServer(app).listen(0, '127.0.0.1', () => r()); });
    const port = (server!.address() as AddressInfo).port;
    const call = (method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) =>
      fetch(`http://127.0.0.1:${port}/api/plugins${path}`, {
        method, headers: { ...(opts.body !== undefined && { 'content-type': 'application/json' }), ...opts.headers }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    return call;
  }
  const S = { 'x-session': 'yes' };
  const T = { 'x-internal-token': 'secret-token-xyz' };
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('GET / carries trust and the audit entries; a plugin made after startup is listed', async () => {
    quiet();
    rowPlugin(h.shipped, 'first');
    enable('first');
    const call = await start();
    let list = await call('GET', '/', { headers: S });
    expect(list.status).toBe(200);
    expect(list.body.trust).toBe('companion');
    expect(list.body.plugins.map((p: any) => p.id)).toEqual(['first']);
    expect(list.body.plugins[0].audit.changed_since_last_view).toBe(true);
    rowPlugin(h.shipped, 'second');
    enable('first', 'second');
    list = await call('GET', '/', { headers: S });
    expect(list.body.plugins.map((p: any) => p.id)).toEqual(['first', 'second']);
    expect((await call('GET', '/')).status).toBe(401);
  });

  it('L1: a plugin that is not enabled is not audited: no record, no flag; enabling it starts the record', async () => {
    quiet();
    rowPlugin(h.shipped, 'off');
    rowPlugin(h.shipped, 'on');
    h.enabled = ['on'];
    const call = await start();
    const list = await call('GET', '/', { headers: S });
    const byId = Object.fromEntries(list.body.plugins.map((p: any) => [p.id, p]));
    expect(byId.off.audit).toBeNull();
    expect(byId.off.enabled).toBe(false);
    expect(byId.on.audit.changed_since_last_view).toBe(true);
    pluginRows(ctx); pluginHelp(); loadPlugins();
    const rec = readAudit(currentAuditFile());
    expect(Object.keys(rec.plugins)).toEqual(['on']); // nothing recorded for "off"
    expect((await call('POST', '/off/seen', { headers: S })).status).toBe(409); // nothing to mark
    await call('PUT', '/enabled', { headers: S, body: { enabled: ['on', 'off'] } });
    expect((await call('GET', '/', { headers: S })).body.plugins.find((p: any) => p.id === 'off').audit.changed_since_last_view).toBe(true);
    expect(Object.keys(readAudit(currentAuditFile()).plugins).sort()).toEqual(['off', 'on']);
  });

  it('PUT /enabled with the internal token writes the list and the next run reads it', async () => {
    quiet();
    rowPlugin(h.shipped, 'a');
    rowPlugin(h.shipped, 'b');
    const call = await start();
    expect(pluginRows(ctx)).toEqual([]);
    const r = await call('PUT', '/enabled', { headers: T, body: { enabled: ['a', 'a', 'ghost'] } });
    expect(r).toEqual({ status: 200, body: { ok: true, enabled: ['a', 'ghost'], unknown: ['ghost'] } });
    expect(setEnabledCalls).toEqual([['a', 'ghost']]);
    expect(setEnabledOpts).toEqual([{ memory: true }]); // companion mode hot-applies
    expect(pluginRows(ctx).map((x) => x.id)).toEqual(['plugin:a:r']);
    await call('PUT', '/enabled', { headers: T, body: { enabled: ['b'] } });
    expect(pluginRows(ctx).map((x) => x.id)).toEqual(['plugin:b:r']);
    await call('PUT', '/enabled', { headers: T, body: { enabled: [] } });
    expect(pluginRows(ctx)).toEqual([]);
  });

  it('PUT /enabled with the session (the person) works the same; no credentials, a wrong token, a bad body, no writer, a closed write gate', async () => {
    quiet();
    const call = await start();
    expect((await call('PUT', '/enabled', { headers: S, body: { enabled: ['x'] } })).status).toBe(200);
    expect(h.enabled).toEqual(['x']);
    expect((await call('PUT', '/enabled', { body: { enabled: [] } })).status).toBe(401);
    expect((await call('PUT', '/enabled', { headers: { 'x-internal-token': 'nope' }, body: { enabled: [] } })).status).toBe(404);
    for (const body of [{}, { enabled: 'a' }, { enabled: [1] }, { enabled: ['../x'] }, { enabled: ['A'] }, { enabled: Array.from({ length: 101 }, (_, i) => `p${i}`) }]) {
      expect((await call('PUT', '/enabled', { headers: T, body })).status).toBe(400);
    }
    expect(h.enabled).toEqual(['x']); // untouched by the refusals
    await new Promise<void>((r) => server!.close(() => r()));
    const noWriter = await start({ setEnabled: null });
    expect((await noWriter('PUT', '/enabled', { headers: S, body: { enabled: [] } })).status).toBe(501);
    await new Promise<void>((r) => server!.close(() => r()));
    const failing = await start({ setEnabled: () => { throw new Error('disk full'); } });
    expect(await failing('PUT', '/enabled', { headers: S, body: { enabled: [] } })).toMatchObject({ status: 500, body: { error: 'config_write_failed', detail: 'disk full' } });
    await new Promise<void>((r) => server!.close(() => r()));
    const closed = await start({ writes: false });
    expect(await closed('PUT', '/enabled', { headers: T, body: { enabled: ['a'] } })).toMatchObject({ status: 403, body: { error: 'app_write_off' } });
    expect((await closed('PUT', '/enabled', { headers: S, body: { enabled: ['a'] } })).status).toBe(200); // the gate limits the companion, not the person
  });

  it('routes of a plugin enabled while the app runs serve at once; disabled again answers 404', async () => {
    quiet();
    routesPlugin(h.shipped, 'rt', 'v1');
    const call = await start();
    expect((await call('GET', '/rt/ping', { headers: S })).status).toBe(404); // not enabled
    expect((await call('GET', '/rt/internal/who', { headers: T })).status).toBe(404);
    await call('PUT', '/enabled', { headers: T, body: { enabled: ['rt'] } });
    expect(await call('GET', '/rt/ping', { headers: S })).toEqual({ status: 200, body: { pong: 'v1' } });
    expect(await call('GET', '/rt/internal/who', { headers: T })).toEqual({ status: 200, body: { internal: 'v1' } });
    expect((await call('GET', '/rt/ping')).status).toBe(401); // still behind session auth
    await call('PUT', '/enabled', { headers: S, body: { enabled: [] } });
    expect((await call('GET', '/rt/ping', { headers: S })).status).toBe(404);
    expect((await call('GET', '/rt/internal/who', { headers: T })).status).toBe(404);
    await call('PUT', '/enabled', { headers: S, body: { enabled: ['rt'] } });
    expect((await call('GET', '/rt/ping', { headers: S })).status).toBe(200);
  });

  it('a plugin created while the app runs, then enabled, serves without a restart', async () => {
    quiet();
    const call = await start();
    routesPlugin(h.shipped, 'later', 'fresh');
    await call('PUT', '/enabled', { headers: T, body: { enabled: ['later'] } });
    expect(await call('GET', '/later/ping', { headers: S })).toEqual({ status: 200, body: { pong: 'fresh' } });
  });

  it('POST /:id/reload with the internal token imports the edited routes; without credentials it is refused', async () => {
    quiet();
    const dir = routesPlugin(h.shipped, 'rt', 'v1');
    enable('rt');
    const call = await start();
    expect((await call('GET', '/rt/ping', { headers: S })).body).toEqual({ pong: 'v1' });
    writeFileSync(join(dir, 'routes.mjs'), routesBody('v2'));
    expect((await call('GET', '/rt/ping', { headers: S })).body).toEqual({ pong: 'v1' }); // an edit alone does not swap the running router
    expect((await call('POST', '/rt/reload')).status).toBe(401);
    expect((await call('POST', '/rt/reload', { headers: { 'x-internal-token': 'wrong' } })).status).toBe(404);
    expect(await call('POST', '/rt/reload', { headers: T })).toEqual({ status: 200, body: { ok: true, plugin: 'rt' } });
    expect((await call('GET', '/rt/ping', { headers: S })).body).toEqual({ pong: 'v2' });
    writeFileSync(join(dir, 'routes.mjs'), routesBody('v3'));
    expect((await call('POST', '/rt/reload', { headers: S })).status).toBe(200); // the person too
    expect((await call('GET', '/rt/ping', { headers: S })).body).toEqual({ pong: 'v3' });
    expect((await call('POST', '/ghost/reload', { headers: T })).status).toBe(404);
    enable();
    expect((await call('POST', '/rt/reload', { headers: T })).status).toBe(404); // not enabled now
  });

  it('a broken edit answers 503 on reload, the previous router keeps serving, and the list says why', async () => {
    quiet();
    const dir = routesPlugin(h.shipped, 'rt', 'v1');
    enable('rt');
    const call = await start();
    expect((await call('GET', '/rt/ping', { headers: S })).status).toBe(200);
    writeFileSync(join(dir, 'routes.mjs'), 'export default () => 3;');
    const bad = await call('POST', '/rt/reload', { headers: T });
    expect(bad.status).toBe(503);
    expect((await call('GET', '/rt/ping', { headers: S })).body).toEqual({ pong: 'v1' });
    expect((await call('GET', '/', { headers: S })).body.plugins[0].error).toMatch(/routes failed to load/);
    writeFileSync(join(dir, 'sanctum.plugin.json'), '{ nope');
    expect((await call('GET', '/rt/ping', { headers: S })).status).toBe(503); // an unusable manifest is named, not a stale success
  });

  it('POST /:id/seen marks the code as viewed; a stale digest is a 409; the list follows', async () => {
    quiet();
    const dir = rowPlugin(h.shipped, 'live');
    enable('live');
    const call = await start();
    const first = (await call('GET', '/', { headers: S })).body.plugins[0];
    expect(first.audit.changed_since_last_view).toBe(true);
    expect((await call('POST', '/live/seen')).status).toBe(401);
    expect((await call('POST', '/live/seen', { headers: T })).status).toBe(401); // the internal token cannot mark things seen: session auth only
    expect((await call('POST', '/live/seen', { headers: S, body: { digest: 'nothex' } })).status).toBe(400);
    writeFileSync(join(dir, 'x.md'), 'edited meanwhile');
    const stale = await call('POST', '/live/seen', { headers: S, body: { digest: first.audit.digest } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('digest_mismatch');
    const now = (await call('GET', '/', { headers: S })).body.plugins[0];
    expect(now.audit.changed_since_last_view).toBe(true);
    expect(now.audit.changes.map((c: any) => c.path)).toContain('x.md');
    expect(await call('POST', '/live/seen', { headers: S, body: { digest: now.audit.digest } })).toEqual({ status: 200, body: { ok: true, plugin: 'live', digest: now.audit.digest } });
    expect((await call('GET', '/', { headers: S })).body.plugins[0].audit).toMatchObject({ changed_since_last_view: false, changes: [] });
    writeFileSync(join(dir, 'x.md'), 'again');
    expect((await call('GET', '/', { headers: S })).body.plugins[0].audit).toMatchObject({ changed_since_last_view: true, changes: [{ path: 'x.md', kind: 'modified' }] });
    expect((await call('POST', '/ghost/seen', { headers: S })).status).toBe(404);
    expect((await call('POST', '/live/seen', { headers: S })).status).toBe(200); // no digest: marks what is on disk
  });

  it('files and file work for the review; ratify has nothing to do in companion mode', async () => {
    quiet();
    rowPlugin(h.shipped, 'live');
    const call = await start();
    const files = await call('GET', '/live/files', { headers: S });
    expect(files.body.files.map((f: any) => f.path)).toEqual(['dsh/index.mjs', 'sanctum.plugin.json']);
    expect((await call('GET', '/live/file?path=dsh%2Findex.mjs', { headers: S })).body.text).toBe('export default {}');
    expect(await call('POST', '/live/ratify', { headers: S, body: { digest: 'a'.repeat(64) } })).toMatchObject({ status: 409, body: { error: 'trust_companion' } });
  });

  it('the fixed routes cannot be shadowed by a plugin whose id is "enabled"', async () => {
    quiet();
    routesPlugin(h.shipped, 'enabled', 'shadow');
    const call = await start();
    expect((await call('PUT', '/enabled', { headers: S, body: { enabled: ['enabled'] } })).status).toBe(200);
    expect((await call('GET', '/enabled/ping', { headers: S })).body).toEqual({ pong: 'shadow' });
  });
});

const personSetEnabled: { ids: string[]; memory: boolean | undefined }[] = [];
describe('trust: person, the new routes', () => {
  beforeEach(() => { personSetEnabled.length = 0; });
  beforeEach(() => { fresh(); h.trust = 'person'; });
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
  async function start() {
    const app = express();
    app.use('/api/plugins', createPluginMount({
      auth: (req, res, next) => (req.headers['x-session'] === 'yes' ? next() : res.status(401).json({ error: 'auth' })),
      internalOnly: (req, res, next) => (req.headers['x-internal-token'] === 'secret-token-xyz' ? next() : res.status(404).json({ error: 'nf' })),
      writeGate: (_q, _s, next) => next(),
      api: { config: {} as any, log: () => {} },
      setEnabled: (ids, opts) => { personSetEnabled.push({ ids, memory: opts?.memory }); if (opts?.memory !== false) h.enabled = ids; },
    }));
    await new Promise<void>((r) => { server = createServer(app).listen(0, '127.0.0.1', () => r()); });
    const port = (server!.address() as AddressInfo).port;
    return (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/plugins${path}`, { method, headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  }
  it('the internal token cannot change plugins.enabled (403 trust_person); the person can; nothing is written for the refusal', async () => {
    quiet();
    const call = await start();
    expect(await call('PUT', '/enabled', { 'x-internal-token': 'secret-token-xyz' }, { enabled: ['a'] })).toEqual({ status: 403, body: { error: 'trust_person' } });
    expect(h.enabled).toEqual([]);
    expect((await call('PUT', '/enabled', { 'x-internal-token': 'wrong' }, { enabled: ['a'] })).status).toBe(404);
    expect((await call('PUT', '/enabled', { 'x-session': 'yes' }, { enabled: ['a'] })).status).toBe(200);
  });
  it('S1: in person mode the session PUT writes the file only (memory: false) and says it applies on restart', async () => {
    quiet();
    const call = await start();
    const r = await call('PUT', '/enabled', { 'x-session': 'yes' }, { enabled: ['a', 'a', 'b'] });
    expect(r).toEqual({ status: 200, body: { ok: true, enabled: ['a', 'b'], applies: 'restart' } });
    expect(personSetEnabled).toEqual([{ ids: ['a', 'b'], memory: false }]);
    expect(h.enabled).toEqual([]); // the running config is untouched: rows, help, routes and flags stay on the mount-time list
  });
  it('the internal token cannot reload or mark seen; GET / says trust: person; seen is a 409', async () => {
    quiet();
    const call = await start();
    expect((await call('POST', '/a/reload', { 'x-internal-token': 'secret-token-xyz' })).status).toBe(401);
    expect(await call('POST', '/a/seen', { 'x-session': 'yes' })).toMatchObject({ status: 409, body: { error: 'trust_person' } });
    expect((await call('GET', '/', { 'x-session': 'yes' })).body).toEqual({ trust: 'person', plugins: [] });
  });
});
