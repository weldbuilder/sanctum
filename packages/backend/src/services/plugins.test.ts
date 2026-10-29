import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const h = vi.hoisted(() => ({ ledgerDir: '', shipped: '', person: '', enabled: [] as string[], cwd: '', extra: [] as string[], dshHome: '', provider: 'claude', codexSandbox: 'workspace-write', dshSandbox: 'workspace-write' }));
vi.mock('../config.js', () => ({
  get PROJECT_ROOT() { return dirname(h.shipped); }, // not a /plugins$ regex: h.shipped ends in \plugins on Windows
  getSanctumConfig: () => ({
    plugins: { trust: 'person', dir: h.person, enabled: h.enabled, ...(h.ledgerDir && { ledger_dir: h.ledgerDir }) },
    agent: { provider: h.provider, cwd: h.cwd, codex: { additional_directories: h.extra, sandbox_mode: h.codexSandbox }, dsh: { home: h.dshHome, sandbox_mode: h.dshSandbox } },
    hooks: { extra_write_paths: [] },
    server: { host: '127.0.0.1', port: 3099 },
  }),
  internalBaseUrl: (s: { host: string; port: number }) => `http://${s.host}:${s.port}`,
}));
vi.mock('../middleware/internal-token.js', () => ({ getInternalToken: () => 'secret-token-xyz' }));
import {
  validateManifest, loadPlugins, resetPlugins, pluginRows as pluginRowsOf, pluginList as pluginListOf, pluginHelp as pluginHelpOf, createPluginMount as createMountOf, normalizeRouters, DSH_BASE_ROW_IDS, senderIsOwnerFor, resolveSenderIsOwner, fullAccessSetting, pluginsDisabled, currentLedgerFile,
} from './plugins.js';
import { ratifyDirectory, snapshotDir, pluginDigest } from './plugin-ratify.js';
import { TOOL_TOPICS } from './tool-help.js';
import * as pluginsModule from './plugins.js';
import { buildExecEnv } from './providers/dsh-exec.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-plugins-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Create a symlink, or skip the calling test with a reason when the OS refuses (Windows needs
 *  Developer Mode or elevation for file symlinks; a directory gets a junction, which needs neither). */
function linkOrSkip(t: { skip: (reason?: string) => void }, target: string, path: string, kind: 'dir' | 'file'): boolean {
  try { symlinkSync(target, path, kind === 'dir' && process.platform === 'win32' ? 'junction' : undefined); return true; } catch (e: any) {
    if (e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'ENOSYS') { t.skip(`cannot create a symlink here (${e.code}): needs privileges on this OS`); return false; }
    throw e;
  }
}

let n = 0;
function fresh() {
  const base = join(tmp, `t${n++}`);
  h.shipped = join(base, 'repo', 'plugins');
  h.person = join(base, 'person-plugins'); // outside the companion home, as the contract requires
  h.cwd = join(base, 'companion-home');
  h.extra = [];
  h.ledgerDir = '';
  h.dshHome = '';
  h.provider = 'claude';
  h.codexSandbox = 'workspace-write';
  h.dshSandbox = 'workspace-write';
  h.enabled = [];
  mkdirSync(h.shipped, { recursive: true });
  mkdirSync(h.person, { recursive: true });
  mkdirSync(h.cwd, { recursive: true });
  resetPlugins();
}
function plugin(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify({ id, name: id.toUpperCase(), version: '1.0.0', harness: ['dsh'], ...manifest }));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}
import type { PluginRowCtx } from './plugins.js';
const ctx: PluginRowCtx = { harness: 'dsh', runKind: 'turn', threadId: 'daily-2026-10-19' };

// This file tests the loader's mechanics (rows, routes, containment, reload). Where a test needs rows,
// help or routes the plugins on disk are ratified FOR REAL first (the real ledger and copies under the
// test's project root, the way the person does in the app); the ratification rules themselves are in
// plugin-ratify.test.ts. A plugin that cannot be ratified (a scan error, a link) is left as it is.
/** Ratify every plugin under `roots` (default: the shipped and the person's root) as it is on disk now. Call it again after editing one. */
function ratifyOnDisk(roots: string[] = [h.shipped, h.person]): void {
  for (const p of loadPlugins({ roots })) {
    if (!p.manifest || p.error !== null) continue;
    try { ratifyDirectory(currentLedgerFile(), p.id, p.dir); } catch { /* not ratifiable: it stays out */ }
  }
}
/** loadPlugins after ratifyOnDisk: the plugins as the loader sees them once the person has ratified what is on disk. */
const loadRatified = (opts: Parameters<typeof loadPlugins>[0] = {}) => { ratifyOnDisk(opts.roots); return loadPlugins(opts); };
// The loader's entry points, each ratifying what is on disk first when it is not handed a plugin list
// (a list from loadRatified is already ratified). After editing a plugin, call ratifyOnDisk() to ratify the edit.
const pluginRows = (c: Parameters<typeof pluginRowsOf>[0], plugins?: Parameters<typeof pluginRowsOf>[1], enabled?: Parameters<typeof pluginRowsOf>[2]) => {
  if (!plugins) ratifyOnDisk();
  return pluginRowsOf(c, plugins, enabled);
};
const pluginHelp = (plugins?: Parameters<typeof pluginHelpOf>[0], enabled?: Parameters<typeof pluginHelpOf>[1]) => {
  if (!plugins) ratifyOnDisk();
  return pluginHelpOf(plugins, enabled);
};
const pluginList = (plugins?: Parameters<typeof pluginListOf>[0], enabled?: Parameters<typeof pluginListOf>[1], ledger?: Parameters<typeof pluginListOf>[2]) => {
  if (!plugins) ratifyOnDisk();
  return pluginListOf(plugins, enabled, ledger);
};
const createPluginMount = (deps: Parameters<typeof createMountOf>[0]) => {
  if (!deps.plugins) ratifyOnDisk();
  return createMountOf(deps);
};

const enable = (...ids: string[]) => { h.enabled = ids; };
/** Ids of the plugins whose manifest was valid. */
const validIds = (list: ReturnType<typeof loadPlugins>) => list.filter((p) => p.manifest).map((p) => p.manifest!.id);
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
const expressUrl = JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('express')).href);
/** A plugin whose routes.mjs is `body`, with `from 'express'` pointed at the repo's express. */
function routesPlugin(root: string, id: string, body: string, manifest: Record<string, unknown> = {}) {
  const dir = plugin(root, id, { routes: 'routes.mjs', ...manifest });
  writeFileSync(join(dir, 'routes.mjs'), body.replace("from 'express'", `from ${expressUrl}`));
  return dir;
}

describe('validateManifest', () => {
  const ok = { id: 'a', name: 'A', version: '1.0.0' };
  it('accepts a minimal manifest and fills defaults', () => {
    const r = validateManifest(ok);
    expect(r.errors).toEqual([]);
    expect(r.manifest).toMatchObject({ id: 'a', harness: [], dsh: { rows: [], runs: ['turn', 'wake'] }, tenant_aware: false });
  });
  it('requires id, name and version', () => {
    expect(validateManifest({}).errors).toEqual(expect.arrayContaining(['id is required', 'name is required', 'version is required']));
    expect(validateManifest(null).errors).toEqual(['manifest must be a JSON object']);
    expect(validateManifest([]).errors).toEqual(['manifest must be a JSON object']);
  });
  it('rejects ids that cannot be a URL segment or a row prefix', () => {
    for (const id of ['A', 'a/b', '../x', 'a b', '', 'x'.repeat(33)]) expect(validateManifest({ ...ok, id }).manifest).toBeUndefined();
  });
  it('checks harness, rows, runs and tenant_aware types', () => {
    expect(validateManifest({ ...ok, harness: 'dsh' }).errors[0]).toMatch(/harness/);
    expect(validateManifest({ ...ok, harness: ['vim'] }).errors[0]).toMatch(/harness/);
    expect(validateManifest({ ...ok, dsh: { rows: {} } }).errors[0]).toMatch(/dsh.rows must be an array/);
    expect(validateManifest({ ...ok, dsh: { rows: [{ name: 'x' }] } }).errors[0]).toMatch(/needs a string id/);
    expect(validateManifest({ ...ok, dsh: { runs: ['turn', 'nap'] } }).errors[0]).toMatch(/dsh.runs/);
    expect(validateManifest({ ...ok, tenant_aware: 'yes' }).errors[0]).toMatch(/tenant_aware/);
    expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'r', entry: 'e.mjs', name: 'p' }] } }).errors[0]).toMatch(/both entry and name/);
  });
  it('keeps entry, routes and help inside the plugin folder', () => {
    for (const entry of ['../evil.mjs', '/etc/passwd', 'a/../../b.mjs']) {
      expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'r', entry }] } }).errors[0]).toMatch(/entry/);
    }
    expect(validateManifest({ ...ok, routes: '../r.mjs' }).errors[0]).toMatch(/routes/);
    expect(validateManifest({ ...ok, help: '/abs.md' }).errors[0]).toMatch(/help/);
    expect(validateManifest({ ...ok, routes: 'routes.mjs', help: 'help.md', dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } }).errors).toEqual([]);
  });
  it('NOTES: accepts mcp and ui blocks, rejects wrong types', () => {
    expect(validateManifest({ ...ok, mcp: { srv: { command: 'x' } }, ui: { tab: 'T' } }).errors).toEqual([]);
    expect(validateManifest({ ...ok, mcp: 'x' }).errors[0]).toMatch(/mcp must be an object/);
    expect(validateManifest({ ...ok, ui: { tab: 5 } }).errors[0]).toMatch(/ui.tab/);
  });
});

describe('loadPlugins', () => {
  beforeEach(fresh);
  it('scans both roots and lets the later root win a duplicate id', () => {
    plugin(h.shipped, 'alpha', { name: 'shipped alpha', version: '1.0.0' });
    plugin(h.shipped, 'beta', { name: 'shipped beta' });
    plugin(h.person, 'alpha', { name: 'my alpha', version: '2.0.0' });
    plugin(h.person, 'gamma', {});
    const list = loadPlugins();
    expect(validIds(list)).toEqual(['alpha', 'beta', 'gamma']);
    const alpha = list.find((p) => p.id === 'alpha')!;
    expect(alpha.manifest).toMatchObject({ name: 'my alpha', version: '2.0.0' });
    expect(alpha.root).toBe(1);
    expect(alpha.dir).toBe(join(h.person, 'alpha'));
    expect(list.find((p) => p.id === 'beta')!.root).toBe(0);
  });
  it('treats a missing root as empty', () => {
    expect(loadPlugins({ roots: [join(tmp, 'nope')] })).toEqual([]);
  });
  it('refuses plugins without tenant_aware in multi-tenant mode', () => {
    const warn = quiet();
    plugin(h.shipped, 'single', {});
    plugin(h.shipped, 'multi', { tenant_aware: true });
    expect(validIds(loadPlugins({ multiTenant: true }))).toEqual(['multi']);
    warn.mockRestore();
  });
  it('never imports plugin code: a routes.mjs and a dsh entry with import side effects stay unrun', () => {
    const marker = join(tmp, `side-effect-${n}`);
    const body = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); export default () => null;`;
    plugin(h.shipped, 'eager', { routes: 'routes.mjs', dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } }, { 'routes.mjs': body, 'dsh/index.mjs': body });
    enable('eager');
    loadPlugins();
    pluginList();
    pluginHelp();
    pluginRows(ctx);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('BLOCKER A: the person root and the enabled list', () => {
  beforeEach(fresh);
  const validPlugin = (root: string, id = 'mine') => plugin(root, id, { dsh: { rows: [{ id: 'r', name: 'pkg' }] } });

  it('plugins.dir "" means no person root at all, not <agent.cwd>/plugins', () => {
    const warn = quiet();
    validPlugin(join(h.cwd, 'plugins'));
    h.person = '';
    expect(loadRatified()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('refuses a root inside agent.cwd (the companion\'s writable home), loudly, and ignores it', () => {
    const warn = quiet();
    h.person = join(h.cwd, 'plugins');
    validPlugin(h.person);
    enable('mine');
    expect(loadRatified()).toEqual([]);
    expect(pluginRows(ctx)).toEqual([]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/plugins\.dir .*refus.*agent\.cwd/s);
    warn.mockRestore();
  });
  it('refuses a root equal to agent.cwd', () => {
    const warn = quiet();
    h.person = h.cwd;
    validPlugin(h.person);
    expect(loadRatified()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('refuses a root that is a symlink resolving into agent.cwd', (t) => {
    const warn = quiet();
    const real = join(h.cwd, 'sneaky');
    mkdirSync(real);
    validPlugin(real);
    const link = join(tmp, `link-into-home-${n}`);
    if (!linkOrSkip(t, real, link, 'dir')) return;
    h.person = link;
    expect(loadRatified()).toEqual([]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/refus/);
    warn.mockRestore();
  });
  it('refuses a root inside agent.codex.additional_directories and inside the dsh home', () => {
    const warn = quiet();
    const extra = join(tmp, `extra-${n}`);
    mkdirSync(join(extra, 'p'), { recursive: true });
    h.extra = [extra];
    h.person = join(extra, 'p');
    validPlugin(h.person);
    expect(loadRatified()).toEqual([]);
    resetPlugins();
    h.extra = [];
    const dshHome = join(tmp, `dshhome-${n}`);
    mkdirSync(join(dshHome, 'p'), { recursive: true });
    h.dshHome = dshHome;
    h.person = join(dshHome, 'p');
    validPlugin(h.person);
    expect(loadRatified()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
  it('refuses a root that contains the writable home (a plugin folder could be the home itself)', () => {
    const warn = quiet();
    h.person = join(tmp, `parent-${n}`);
    h.cwd = join(h.person, 'home');
    mkdirSync(h.cwd, { recursive: true });
    writeFileSync(join(h.cwd, 'sanctum.plugin.json'), JSON.stringify({ id: 'home', name: 'h', version: '1' }));
    expect(loadRatified()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('accepts a root outside every writable root', () => {
    validPlugin(h.person);
    expect(validIds(loadRatified())).toEqual(['mine']);
  });

  it('only enabled ids contribute dsh rows, help, and appear enabled in the list; everything is listed', () => {
    plugin(h.shipped, 'on', { help: 'help.md', dsh: { rows: [{ id: 'r', name: 'pkg' }] } }, { 'help.md': 'on: help' });
    plugin(h.shipped, 'off', { help: 'help.md', dsh: { rows: [{ id: 'r', name: 'pkg' }] } }, { 'help.md': 'off: help' });
    enable('on');
    expect(pluginRows(ctx).map((r) => r.id)).toEqual(['plugin:on:r']);
    expect(pluginHelp()).toEqual({ on: 'on: help' });
    expect(pluginList().map((p) => [p.id, p.enabled])).toEqual([['off', false], ['on', true]]);
    enable();
    expect(pluginRows(ctx)).toEqual([]);
    expect(pluginHelp()).toEqual({});
  });
  it('the shipped hello plugin loads nothing until it is named', () => {
    const repoPlugins = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'plugins');
    const all = loadRatified({ roots: [repoPlugins] });
    expect(all.map((p) => p.id)).toContain('hello');
    enable();
    expect(pluginRows(ctx, all)).toEqual([]);
    expect(pluginHelp(all)).toEqual({});
    expect(pluginList(all).find((p) => p.id === 'hello')!.enabled).toBe(false);
    enable('hello');
    expect(pluginRows({ ...ctx, runKind: 'turn' }, all)).toHaveLength(1);
  });
});

describe('pluginRows', () => {
  beforeEach(fresh);
  const rowsOf = (extra: Record<string, unknown> = {}, c = ctx) => {
    resetPlugins();
    plugin(h.shipped, 'ans', {
      dsh: {
        rows: [
          { id: 'tool-ask-user', config: { x: 1 } },
          { id: 'answerer', entry: 'dsh/index.mjs', config: { timeoutMs: 600000 } },
          { id: 'pkg', name: '@scope/some-dsh-plugin', config: { a: 1 } },
        ],
        runs: ['turn'],
      },
      ...extra,
    }, { 'dsh/index.mjs': 'export default {}' });
    enable('ans');
    return pluginRows(c);
  };

  it('resolves entry to an absolute real path as the row name and prefixes ids', () => {
    const rows = rowsOf();
    expect(rows.map((r) => r.id)).toEqual(['tool-ask-user', 'plugin:ans:answerer', 'plugin:ans:pkg']);
    expect(rows[0]).toEqual({ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', config: { x: 1 } });
    const answerer = rows[1];
    // Production runs the RATIFIED COPY: <ledger folder>/snapshots/<id>/<digest>/, never the live entry.
    const copy = realpathSync.native(snapshotDir(currentLedgerFile(), 'ans', pluginDigest(join(h.shipped, 'ans')).digest));
    expect(answerer.name).toBe(join(copy, 'dsh', 'index.mjs'));
    expect(answerer.name).not.toBe(realpathSync.native(join(h.shipped, 'ans', 'dsh', 'index.mjs')));
    expect(answerer.entry).toBeUndefined();
    expect(rows[2].name).toBe('@scope/some-dsh-plugin'); // a package name passes as is
  });
  it('merges the sanctum block into every plugin row config, keeping the plugin\'s own keys', () => {
    const rows = rowsOf({}, { ...ctx, tenant: 't1' });
    const sanctum = { baseUrl: 'http://127.0.0.1:3099', token: 'secret-token-xyz', threadId: 'daily-2026-10-19', tenant: 't1', runKind: 'turn', senderIsOwner: false };
    expect(rows[1].config).toEqual({ timeoutMs: 600000, sanctum });
    expect(rows[2].config).toEqual({ a: 1, sanctum });
  });
  it('defaults the tenant to "default"', () => {
    expect(rowsOf()[1].config.sanctum.tenant).toBe('default');
  });
  it('returns rows only when harness and run kind both match', () => {
    expect(rowsOf({}, { ...ctx, harness: 'codex' })).toEqual([]);
    expect(rowsOf({}, { ...ctx, harness: 'claude' })).toEqual([]);
    for (const runKind of ['wake', 'helper', 'summarizer'] as const) expect(rowsOf({}, { ...ctx, runKind })).toEqual([]);
    expect(rowsOf({}, ctx)).toHaveLength(3);
  });
  it('defaults runs to turn and wake', () => {
    plugin(h.shipped, 'dflt', { dsh: { rows: [{ id: 'r', name: 'pkg' }] } });
    enable('dflt');
    const kinds = (['turn', 'wake', 'helper', 'summarizer'] as const).filter((runKind) => pluginRows({ ...ctx, runKind }).length);
    expect(kinds).toEqual(['turn', 'wake']);
  });
  it('a plugin that lists only another harness contributes no rows here', () => {
    plugin(h.shipped, 'cx', { harness: ['codex'], dsh: { rows: [{ id: 'r', name: 'pkg' }] } });
    enable('cx');
    expect(pluginRows(ctx)).toEqual([]);
  });
  it('drops a row whose entry file is missing', () => {
    const warn = quiet();
    plugin(h.shipped, 'gone', { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } });
    enable('gone');
    expect(pluginRows(ctx)).toEqual([]);
    warn.mockRestore();
  });
  it('the token is in the row config and absent from the child environment', () => {
    const rows = rowsOf();
    expect(JSON.stringify(rows)).toContain('secret-token-xyz');
    const env = buildExecEnv({ sandboxMode: 'workspace-write', cwd: '/c' }, { PATH: '/bin', HOME: '/h', INTERNAL_TOKEN: 'secret-token-xyz', SANCTUM_TOKEN: 'secret-token-xyz' });
    expect(Object.values(env)).not.toContain('secret-token-xyz');
    expect(Object.keys(env)).not.toContain('INTERNAL_TOKEN');
  });
});

describe('SHOULD-FIX 6: config merge and the hello example', () => {
  beforeEach(fresh);
  it('merges sanctum into config without dropping siblings, and a plugin cannot forge the injected keys', () => {
    plugin(h.shipped, 'm', { dsh: { rows: [{ id: 'r', name: 'pkg', config: { marker: 'x', sanctum: { custom: 1, token: 'forged' } } }] } });
    enable('m');
    const cfg = pluginRows(ctx)[0].config;
    expect(cfg.marker).toBe('x');
    expect(cfg.sanctum.custom).toBe(1);
    expect(cfg.sanctum.token).toBe('secret-token-xyz');
    expect(cfg.sanctum.threadId).toBe('daily-2026-10-19');
  });
  it('hello, through the pipeline: pluginRows -> overlay file -> a child process loads the row the way dsh does; no marker means nothing is written', () => {
    const repoPlugins = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'plugins');
    enable('hello');
    // The shipped manifest as it is: no marker.
    const shipped = pluginRows({ ...ctx, threadId: 't9', senderIsOwner: true }, loadRatified({ roots: [repoPlugins] }));
    expect(shipped).toHaveLength(1);
    expect(shipped[0].id).toBe('plugin:hello:marker');
    expect(shipped[0].config).not.toHaveProperty('marker');
    const cwd = join(tmp, `hello-cwd-${n}`);
    mkdirSync(cwd);
    const runRow = (row: any) => {
      const overlay = join(tmp, `hello-overlay-${n}.json`);
      writeFileSync(overlay, JSON.stringify([{ insert: [row] }])); // what dsh --patch reads
      const loader = `import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [{ insert: [row] }] = JSON.parse(readFileSync(${JSON.stringify(overlay)}, 'utf8'));
const mod = await import(pathToFileURL(row.name).href); // absolute paths are not ESM specifiers on Windows
const plugin = mod.default ?? mod;
await plugin.apply({ on() {} }, row.config);`;
      return spawnSync(process.execPath, ['--input-type=module', '-e', loader], { cwd, encoding: 'utf-8' });
    };
    expect(runRow(shipped[0]).status).toBe(0);
    expect(readdirSync(cwd)).toEqual([]); // nothing in the companion home on every turn
    // An operator who wants the marker sets it in the manifest config.
    const copy = join(tmp, `hello-copy-${n}`);
    cpSync(join(repoPlugins, 'hello'), join(copy, 'hello'), { recursive: true });
    const marker = join(tmp, `hello-${n}.marker`);
    const mf = join(copy, 'hello', 'sanctum.plugin.json');
    const manifest = JSON.parse(readFileSync(mf, 'utf-8'));
    manifest.dsh.rows[0].config = { marker };
    writeFileSync(mf, JSON.stringify(manifest));
    const withMarker = pluginRows({ ...ctx, threadId: 't9', senderIsOwner: true }, loadRatified({ roots: [copy] }));
    expect(withMarker[0].config.marker).toBe(marker);
    expect(withMarker[0].config.sanctum).toMatchObject({ threadId: 't9', runKind: 'turn', tenant: 'default', token: 'secret-token-xyz' });
    expect(runRow(withMarker[0]).status).toBe(0);
    expect(readFileSync(marker, 'utf-8')).toBe('hello applied thread=t9 run=turn tenant=default\n');
    expect(readdirSync(cwd)).toEqual([]);
  });
  it('S4: the shipped hello manifest declares no marker, and its entry does nothing without one', () => {
    const repoPlugins = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'plugins');
    const manifest = JSON.parse(readFileSync(join(repoPlugins, 'hello', 'sanctum.plugin.json'), 'utf-8'));
    for (const r of manifest.dsh.rows) expect(r.config?.marker).toBeUndefined();
    const cwd = join(tmp, `hello-bare-${n}`);
    mkdirSync(cwd);
    const entry = join(repoPlugins, 'hello', 'dsh', 'index.mjs');
    for (const config of [undefined, {}, { sanctum: { threadId: 't' } }]) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(entry).href)}); m.apply({}, ${JSON.stringify(config)});`], { cwd });
      expect(r.status).toBe(0);
    }
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe('SHOULD-FIX 2: containment is real, not textual', () => {
  beforeEach(fresh);
  const outside = () => { const d = join(tmp, `outside-${n}`); mkdirSync(d, { recursive: true }); return d; };

  it('a symlinked dsh/index.mjs that leaves the plugin folder is not used as a row, and the list says why', (t) => {
    const warn = quiet();
    const out = outside();
    writeFileSync(join(out, 'evil.mjs'), 'export default {}');
    const dir = plugin(h.shipped, 'sl', { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } });
    mkdirSync(join(dir, 'dsh'));
    if (!linkOrSkip(t, join(out, 'evil.mjs'), join(dir, 'dsh', 'index.mjs'), 'file')) return;
    enable('sl');
    expect(pluginRows(ctx)).toEqual([]);
    expect(pluginList().find((p) => p.id === 'sl')!.error).toMatch(/dsh\/index\.mjs.*outside/);
    warn.mockRestore();
  });
  it('a symlink inside the plugin folder, even one that stays inside, makes the plugin unavailable: plugin folders may not contain links', (t) => {
    const dir = plugin(h.shipped, 'ok', { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } }, { 'dsh/real.mjs': 'export default {}' });
    if (!linkOrSkip(t, join(dir, 'dsh', 'real.mjs'), join(dir, 'dsh', 'index.mjs'), 'file')) return;
    enable('ok');
    quiet();
    ratifyOnDisk(); // the folder cannot be hashed, so there is nothing to ratify
    const [p] = loadPlugins();
    expect(p.ratification.state).toBe('unavailable');
    expect(p.ratification.detail).toMatch(/may not contain links/);
    expect(pluginRows(ctx, [p])).toEqual([]);
    expect(pluginListOf([p])[0].error).toMatch(/links/);
  });
  it('a symlinked plugin folder that leaves its root is rejected whole', (t) => {
    const warn = quiet();
    const out = outside();
    const real = join(out, 'realplugin');
    mkdirSync(join(real, 'dsh'), { recursive: true });
    writeFileSync(join(real, 'sanctum.plugin.json'), JSON.stringify({ id: 'lnk', name: 'L', version: '1', harness: ['dsh'], help: 'help.md', dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } }));
    writeFileSync(join(real, 'dsh', 'index.mjs'), 'export default {}');
    writeFileSync(join(real, 'help.md'), 'lnk: help');
    if (!linkOrSkip(t, real, join(h.shipped, 'lnk'), 'dir')) return;
    enable('lnk');
    expect(pluginRows(ctx)).toEqual([]);
    expect(pluginHelp()).toEqual({});
    const info = pluginList().find((p) => p.id === 'lnk')!;
    expect(info.error).toMatch(/outside its root/);
    expect(info.enabled).toBe(true);
    warn.mockRestore();
  });
  it('a symlinked help.md that leaves the plugin folder gives no topic', (t) => {
    const warn = quiet();
    const out = outside();
    writeFileSync(join(out, 'secret.md'), 'SECRET CONTENT');
    const dir = plugin(h.shipped, 'hl', { help: 'help.md' });
    if (!linkOrSkip(t, join(out, 'secret.md'), join(dir, 'help.md'), 'file')) return;
    enable('hl');
    expect(pluginHelp()).toEqual({});
    expect(pluginList().find((p) => p.id === 'hl')!.error).toMatch(/help\.md.*outside/);
    warn.mockRestore();
  });
  it('rejects a row whose name is not a package name: absolute, relative, traversal, uppercase', () => {
    const warn = quiet();
    const bad = ['/abs/evil.mjs', '../evil', './evil', 'a/../b', '/node_modules/x', 'C:\\x', 'Pkg', '@/x', 'a//b', 'a b'];
    plugin(h.shipped, 'nm', { dsh: { rows: bad.map((name, i) => ({ id: `r${i}`, name })) } });
    enable('nm');
    expect(pluginRows(ctx)).toEqual([]);
    expect(pluginList().find((p) => p.id === 'nm')!.error).toMatch(/name/);
    warn.mockRestore();
  });
  it('passes package-name rows', () => {
    plugin(h.shipped, 'nm2', { dsh: { rows: ['pkg', '@scope/pkg', 'a.b_c-d', 'pkg/sub'].map((name, i) => ({ id: `r${i}`, name })) } });
    enable('nm2');
    expect(pluginRows(ctx).map((r) => r.name)).toEqual(['pkg', '@scope/pkg', 'a.b_c-d', 'pkg/sub']);
  });
});

describe('S1: base rows are real dsh rows, not patches in an insert list', () => {
  beforeEach(fresh);
  const manifestRows = (rows: any[], runs: string[] = ['turn', 'wake', 'helper', 'summarizer'], id = 'b') => {
    plugin(h.shipped, id, { dsh: { rows, runs } });
    enable(...new Set([...h.enabled, id]));
  };
  it('tool-ask-user is an insert row whose name is forced by the loader; the plugin supplies config only', () => {
    manifestRows([
      { id: 'tool-ask-user', name: '@evil/x', disabled: true, before: 'permission', insert: [], config: { timeoutMs: 5 } },
    ]);
    expect(pluginRows(ctx)).toEqual([
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', config: { timeoutMs: 5 } },
    ]);
  });
  it('a tool-ask-user row needs no name or entry in the manifest (the loader supplies it)', () => {
    expect(validateManifest({ id: 'x', name: 'x', version: '1', dsh: { rows: [{ id: 'tool-ask-user', config: {} }] } }).errors).toEqual([]);
    manifestRows([{ id: 'tool-ask-user' }]);
    expect(pluginRows(ctx)).toEqual([{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }]);
  });
  it('several enabled plugins asking for tool-ask-user produce exactly one row (first wins)', () => {
    const warn = quiet();
    manifestRows([{ id: 'tool-ask-user', config: { a: 1 } }], ['turn'], 'one');
    manifestRows([{ id: 'tool-ask-user', config: { a: 2 } }, { id: 'mine', name: 'pkg' }], ['turn'], 'two');
    const rows = pluginRows(ctx);
    expect(rows.filter((r) => r.id === 'tool-ask-user')).toEqual([{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', config: { a: 1 } }]);
    expect(rows.map((r) => r.id)).toEqual(['tool-ask-user', 'plugin:two:mine']);
    warn.mockRestore();
  });
  it('is dropped with a warning on wake, helper and summarizer runs; kept on a turn', () => {
    const warn = quiet();
    manifestRows([{ id: 'tool-ask-user' }]);
    for (const runKind of ['wake', 'helper', 'summarizer'] as const) {
      warn.mockClear();
      expect(pluginRows({ ...ctx, runKind })).toEqual([]);
      expect(warn.mock.calls.flat().join('\n')).toMatch(/tool-ask-user.*turn/s);
    }
    expect(pluginRows(ctx)).toHaveLength(1);
    warn.mockRestore();
  });
  it('approval is rejected like any other base row: nothing from that plugin is emitted, and the list says why', () => {
    const warn = quiet();
    manifestRows([{ id: 'approval', name: 'pkg', config: { policy: 'ask' } }, { id: 'mine', name: 'pkg' }]);
    expect(pluginRows(ctx)).toEqual([]); // a scan error: the plugin contributes nothing, 'mine' included
    expect(pluginList().find((p) => p.id === 'b')!.error).toMatch(/approval.*dsh base row/);
    warn.mockRestore();
  });
  it('DSH_BASE_ROW_IDS contains a hand-picked subset of dsh\'s base ids, and not tool-ask-user', () => {
    for (const id of ['approval', 'permission', 'system-prompt', 'sandbox', 'sandbox-policy', 'agent-default-model', 'llm-pi-ai', 'session-persistence-jsonl', 'storage-json', 'agent-instructions', 'skill-filesystem', 'session-title-llm',
      'timer', 'llm', 'agent', 'agent-loop', 'tools', 'tool-bash', 'tool-fs', 'user-questions', 'hmr', 'headless-startup', 'headless-runner', 'web', 'settings', 'otel']) {
      expect(DSH_BASE_ROW_IDS.has(id), id).toBe(true);
    }
    expect(DSH_BASE_ROW_IDS.has('tool-ask-user')).toBe(false); // not a base row: it is inserted, by name
    expect(DSH_BASE_ROW_IDS.size).toBeGreaterThan(80);
  });
  /** Where the installed dsh lives. SANCTUM_DSH_INSTALL may name either the dsh package dir itself
   *  (has a package.json, e.g. .../node_modules/@deepseek-ai/dsh) or an install root that contains
   *  node_modules/@deepseek-ai/dsh (e.g. an npm --prefix dir's lib). Without it, resolve the package
   *  from the repo. dsh-base and dsh-headless are looked up under the package's own node_modules
   *  (nested install) and beside it (hoisted install). Returns the scope dir holding both, or a reason. */
  function findDshScope(): { scope: string } | { skip: string } {
    const env = process.env.SANCTUM_DSH_INSTALL;
    let pkg: string | undefined;
    if (env) {
      pkg = existsSync(join(env, 'package.json')) ? env : join(env, 'node_modules', '@deepseek-ai', 'dsh');
      if (!existsSync(join(pkg, 'package.json'))) return { skip: `SANCTUM_DSH_INSTALL=${env} has neither a package.json nor node_modules/@deepseek-ai/dsh` };
    } else {
      try { pkg = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')); } catch { /* not installed */ }
      if (!pkg) return { skip: '@deepseek-ai/dsh is not installed here; set SANCTUM_DSH_INSTALL to its package dir or to an install root' };
    }
    for (const scope of [join(pkg, 'node_modules', '@deepseek-ai'), dirname(pkg)]) {
      if (['dsh-base', 'dsh-headless'].every((d) => existsSync(join(scope, d, 'cordis.patch.yml')))) return { scope };
    }
    return { skip: `dsh at ${pkg} has no dsh-base/dsh-headless cordis.patch.yml` };
  }
  const dshFound = findDshScope();
  const dshIdsTitle = 'DSH_BASE_ROW_IDS equals the ids in the installed dsh-base and dsh-headless cordis.patch.yml';
  if ('skip' in dshFound) it.skip(`${dshIdsTitle} (SKIPPED: ${dshFound.skip})`, () => {});
  else it(dshIdsTitle, () => {
    const ids = new Set<string>();
    for (const pkg of ['dsh-base', 'dsh-headless']) {
      for (const line of readFileSync(join(dshFound.scope, pkg, 'cordis.patch.yml'), 'utf-8').split('\n')) {
        const m = /^\s*(?:- )?id: *["']?([^"'\s#]+)/.exec(line);
        if (m) ids.add(m[1]);
      }
    }
    expect([...ids].sort()).toEqual([...DSH_BASE_ROW_IDS].sort());
  });
  it('rejects, rather than prefixes, any row that collides with a dsh base or headless row id', () => {
    const warn = quiet();
    const ids = ['permission', 'system-prompt', 'sandbox', 'sandbox-policy', 'agent-default-model', 'llm-pi-ai', 'session-persistence-jsonl', 'storage-json', 'agent-instructions', 'skill-filesystem', 'mcp-cc', 'mcp-anything',
      'timer', 'headless-runner', 'agent-loop', 'tools', 'web', 'hmr'];
    manifestRows(ids.map((id) => ({ id, name: 'pkg', config: { evil: true } })));
    expect(pluginRows(ctx)).toEqual([]);
    const err = pluginList().find((p) => p.id === 'b')!.error!;
    for (const id of ids) expect(err, id).toContain(`row ${id} collides`);
    warn.mockRestore();
  });
  it('an ordinary id is still prefixed and gets the sanctum block', () => {
    manifestRows([{ id: 'mine', name: 'pkg' }]);
    const [r] = pluginRows(ctx);
    expect(r.id).toBe('plugin:b:mine');
    expect(r.config.sanctum.runKind).toBe('turn');
  });
  it('a row with neither entry nor name is invalid at manifest validation (dsh would treat it as a nameless entry and disable it)', () => {
    const warn = quiet();
    const ok = { id: 'x', name: 'x', version: '1' };
    expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'r' }] } }).errors[0]).toMatch(/dsh\.rows\[0\].*entry or a name/);
    expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'r', config: { a: 1 } }] } }).errors[0]).toMatch(/entry or a name/);
    expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } }).errors).toEqual([]);
    expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'r', name: 'pkg' }] } }).errors).toEqual([]);
    manifestRows([{ id: 'r' }], undefined, 'nameless');
    const found = pluginList().find((p) => p.id === 'nameless')!;
    expect(found.error).toMatch(/entry or a name/);
    expect(pluginRows(ctx)).toEqual([]);
    warn.mockRestore();
  });
});

describe('NOTES: senderIsOwner and mcp/ui', () => {
  beforeEach(fresh);
  it('injects sanctum.senderIsOwner: true by default only for wake, helper and summarizer; false on a turn that did not say; an explicit value wins', () => {
    plugin(h.shipped, 's', { dsh: { rows: [{ id: 'r', name: 'pkg' }], runs: ['turn', 'wake', 'helper', 'summarizer'] } });
    enable('s');
    const get = (c: Partial<PluginRowCtx>) => pluginRows({ ...ctx, ...c })[0].config.sanctum.senderIsOwner;
    expect(get({ runKind: 'turn' })).toBe(false);
    for (const runKind of ['wake', 'helper', 'summarizer'] as const) expect(get({ runKind })).toBe(true);
    expect(get({ runKind: 'turn', senderIsOwner: true })).toBe(true);
    expect(get({ runKind: 'turn', senderIsOwner: false })).toBe(false);
    expect(get({ runKind: 'wake', senderIsOwner: false })).toBe(false);
  });
  it('resolveSenderIsOwner: the one place the default lives', () => {
    expect(resolveSenderIsOwner('turn', undefined)).toBe(false);
    expect(resolveSenderIsOwner('turn', true)).toBe(true);
    expect(resolveSenderIsOwner('turn', false)).toBe(false);
    for (const k of ['wake', 'helper', 'summarizer'] as const) { expect(resolveSenderIsOwner(k, undefined)).toBe(true); expect(resolveSenderIsOwner(k, false)).toBe(false); }
  });
  it('senderIsOwnerFor: web, api, ws and telegram are the owner; discord only when it says so; an unknown or missing platform is not', () => {
    expect(senderIsOwnerFor('web')).toBe(true);
    expect(senderIsOwnerFor('api')).toBe(true);
    expect(senderIsOwnerFor('ws')).toBe(true);
    expect(senderIsOwnerFor('telegram')).toBe(true);
    expect(senderIsOwnerFor(undefined)).toBe(false);
    expect(senderIsOwnerFor('slack')).toBe(false);
    expect(senderIsOwnerFor('discord', true)).toBe(true);
    expect(senderIsOwnerFor('discord', false)).toBe(false);
    expect(senderIsOwnerFor('discord')).toBe(false);
  });
  it('logs once, per plugin, that mcp and ui are accepted but not yet implemented', () => {
    const warn = quiet();
    plugin(h.shipped, 'mu', { mcp: { srv: { command: 'x' } }, ui: { tab: 'T' } });
    loadRatified({ roots: [h.shipped] });
    loadRatified({ roots: [h.shipped] });
    const lines = warn.mock.calls.flat().join('\n');
    expect(lines.match(/"mcp" is accepted but not yet implemented/g)).toHaveLength(1);
    expect(lines.match(/"ui" is accepted but not yet implemented/g)).toHaveLength(1);
    warn.mockRestore();
  });
  it('pluginRouters (dead, nothing called it) is gone', () => {
    expect((pluginsModule as any).pluginRouters).toBeUndefined();
  });
});

describe('pluginList and pluginHelp', () => {
  beforeEach(fresh);
  it('lists what a tab needs, with enabled and error, and serves help.md by id', () => {
    plugin(h.shipped, 'br', { routes: 'routes.mjs', help: 'help.md', ui: { tab: 'Browser', icon: 'globe' }, tenant_aware: true }, { 'help.md': '\nbr: drive the browser.\nmore\n', 'routes.mjs': 'export default () => null' });
    plugin(h.shipped, 'nohelp', {});
    enable('br');
    expect(pluginList().find((p) => p.id === 'br')).toEqual({
      id: 'br', name: 'BR', version: '1.0.0', harness: ['dsh'], routes: true, help: true, ui: { tab: 'Browser', icon: 'globe' }, tenant_aware: true,
      // the real check: the digest of the folder, and the ratified copy that would run
      enabled: true, error: null, ratification: { state: 'ok', digest: pluginDigest(join(h.shipped, 'br')).digest, snapshot: snapshotDir(currentLedgerFile(), 'br', pluginDigest(join(h.shipped, 'br')).digest) },
    });
    expect(pluginList().find((p) => p.id === 'nohelp')).toMatchObject({ enabled: false, error: null });
    expect(pluginHelp()).toEqual({ br: 'br: drive the browser.\nmore' });
  });
});

describe('SHOULD-FIX 5a: broken plugins are visible', () => {
  beforeEach(fresh);
  it('an invalid manifest, bad JSON, a missing entry, a missing help.md and a missing routes.mjs each carry an error', () => {
    const warn = quiet();
    plugin(h.shipped, 'good', {});
    plugin(h.shipped, 'badmf', { harness: ['vim'] });
    mkdirSync(join(h.shipped, 'brokenjson'));
    writeFileSync(join(h.shipped, 'brokenjson', 'sanctum.plugin.json'), '{nope');
    mkdirSync(join(h.shipped, 'empty'));
    plugin(h.shipped, 'noentry', { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } });
    plugin(h.shipped, 'nohelp', { help: 'help.md' });
    plugin(h.shipped, 'noroutes', { routes: 'routes.mjs' });
    const byId = Object.fromEntries(pluginList().map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['badmf', 'brokenjson', 'good', 'noentry', 'nohelp', 'noroutes']);
    expect(byId.good.error).toBeNull();
    expect(byId.badmf.error).toMatch(/harness/);
    expect(byId.brokenjson.error).toMatch(/not valid JSON/);
    expect(byId.noentry.error).toMatch(/entry dsh\/index\.mjs not found/);
    expect(byId.nohelp.error).toMatch(/help\.md not found/);
    expect(byId.noroutes.error).toMatch(/routes\.mjs not found/);
    expect(validIds(loadRatified()).sort()).toEqual(['good', 'noentry', 'nohelp', 'noroutes']);
    warn.mockRestore();
  });
});

describe('route mounting', () => {
  beforeEach(fresh);
  let server: Server | undefined;
  async function start(deps: { writes?: boolean } = {}) {
    const calls: string[] = [];
    const app = express();
    app.use('/api/plugins', createPluginMount({
      auth: (req, res, next) => { calls.push('auth'); req.headers['x-session'] === 'yes' ? next() : res.status(401).json({ error: 'auth' }); },
      internalOnly: (req, res, next) => { calls.push('internal'); req.headers['x-internal-token'] === 'secret-token-xyz' ? next() : res.status(404).json({ error: 'nf' }); },
      writeGate: (_req, res, next) => { calls.push('write'); deps.writes === false ? res.status(403).json({ error: 'app_write_off' }) : next(); },
      api: { config: {} as any, log: () => {} },
    }));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const port = (server!.address() as AddressInfo).port;
    const call = (method: string, path: string, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/api/plugins${path}`, { method, headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    return { calls, call };
  }
  const stop = () => new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  const importMarker = () => join(tmp, `routes-imported-${n}`);
  function rtPlugin() {
    const body = `import express from 'express';
import { appendFileSync } from 'node:fs';
const M = ${JSON.stringify(importMarker())};
appendFileSync(M, 'x');
export default (api) => {
  const pub = express.Router();
  pub.get('/ping', (_q, r) => r.json({ pong: true }));
  pub.post('/save', (_q, r) => r.json({ saved: true }));
  const internal = express.Router();
  internal.get('/who', (_q, r) => r.json({ internal: true }));
  internal.post('/note', (_q, r) => r.json({ noted: true }));
  return { public: pub, internal };
};`;
    routesPlugin(h.shipped, 'rt', body);
    enable('rt');
  }

  it('lists every discovered plugin behind session auth, with enabled and error', async () => {
    rtPlugin();
    plugin(h.shipped, 'idle', {});
    const { call } = await start();
    expect((await call('GET', '/')).status).toBe(401);
    const ok = await call('GET', '/', { 'x-session': 'yes' });
    expect(ok.status).toBe(200);
    expect(ok.body.plugins.map((p: any) => [p.id, p.enabled, p.error])).toEqual([['idle', false, null], ['rt', true, null]]);
    await stop();
  });

  it('only enabled plugins mount routes, and a disabled one is never imported', async () => {
    rtPlugin();
    enable();
    const { call } = await start();
    expect((await call('GET', '/rt/ping', { 'x-session': 'yes' })).status).not.toBe(200);
    expect(existsSync(importMarker())).toBe(false);
    await stop();
  });

  it('public routes sit behind session auth; internal routes behind the internal token, not the session', async () => {
    rtPlugin();
    const { call } = await start();
    expect((await call('GET', '/rt/ping')).status).toBe(401);
    expect(await call('GET', '/rt/ping', { 'x-session': 'yes' })).toEqual({ status: 200, body: { pong: true } });
    expect((await call('GET', '/rt/internal/who', { 'x-session': 'yes' })).status).toBe(404); // a session is not the token
    expect((await call('GET', '/rt/internal/who')).status).toBe(404);
    expect(await call('GET', '/rt/internal/who', { 'x-internal-token': 'secret-token-xyz' })).toEqual({ status: 200, body: { internal: true } });
    expect((await call('GET', '/rt/internal/ping', { 'x-internal-token': 'secret-token-xyz' })).status).toBe(404);
    await stop();
  });

  it('SHOULD-FIX 1: with app_write off, the person\'s session POST is 200 and the internal (token) POST is 403', async () => {
    rtPlugin();
    const { call, calls } = await start({ writes: false });
    expect(await call('POST', '/rt/save', { 'x-session': 'yes' })).toEqual({ status: 200, body: { saved: true } });
    expect(calls).not.toContain('write');
    expect((await call('POST', '/rt/internal/note', { 'x-internal-token': 'secret-token-xyz' })).status).toBe(403);
    expect(calls.filter((c) => c === 'write')).toHaveLength(1);
    expect((await call('GET', '/rt/internal/who', { 'x-internal-token': 'secret-token-xyz' })).status).toBe(200); // reads are not gated
    expect(calls.filter((c) => c === 'write')).toHaveLength(1);
    await stop();
  });

  it('an internal write goes through the token, then the gate, then the plugin; a public one through auth only', async () => {
    rtPlugin();
    const { call, calls } = await start();
    expect((await call('POST', '/rt/save')).status).toBe(401);
    expect(calls).toEqual(['auth']);
    calls.length = 0;
    expect((await call('POST', '/rt/save', { 'x-session': 'yes' })).body).toEqual({ saved: true });
    expect(calls).toEqual(['auth']);
    calls.length = 0;
    expect((await call('POST', '/rt/internal/note', { 'x-internal-token': 'secret-token-xyz' })).body).toEqual({ noted: true });
    expect(calls).toEqual(['internal', 'write']);
    await stop();
  });

  it('imports routes.mjs only after a request passes auth, once', async () => {
    rtPlugin();
    const { call } = await start();
    expect(existsSync(importMarker())).toBe(false); // mounting imported nothing
    await call('GET', '/rt/ping'); // 401
    await call('GET', '/rt/internal/who'); // 404
    expect(existsSync(importMarker())).toBe(false);
    await call('GET', '/rt/ping', { 'x-session': 'yes' });
    await call('GET', '/rt/ping', { 'x-session': 'yes' });
    expect(readFileSync(importMarker(), 'utf-8')).toBe('x');
    await stop();
  });

  it('SHOULD-FIX 2: a routes.mjs symlinked out of the plugin folder is never imported; the plugin has a scan error and mounts no routes', async (t) => {
    const warn = quiet();
    const out = join(tmp, `outside-routes-${n}`);
    mkdirSync(out);
    const marker = join(out, 'imported');
    writeFileSync(join(out, 'routes.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); export default () => null;`);
    const dir = plugin(h.shipped, 'sym', { routes: 'routes.mjs' });
    if (!linkOrSkip(t, join(out, 'routes.mjs'), join(dir, 'routes.mjs'), 'file')) return;
    enable('sym');
    const { call } = await start();
    const r = await call('GET', '/sym/x', { 'x-session': 'yes' });
    expect(r.status).toBe(404);
    expect(existsSync(marker)).toBe(false);
    expect(pluginList().find((p) => p.id === 'sym')!.error).toMatch(/routes\.mjs.*outside/);
    await stop();
    warn.mockRestore();
  });

  describe('S3: a failed import answers 503 and stays failed until an explicit reload', () => {
    const OK_ROUTES = `import express from ${expressUrl};
export default () => { const r = express.Router(); r.get('/ping', (_q, s) => s.json({ pong: true })); return r; };`;
    const attempts = (f: string) => (existsSync(f) ? readFileSync(f, 'utf-8').length : 0);
    it('503 plugin_unavailable on both sides and the error shows in the list, with the way out', async () => {
      const warn = quiet();
      routesPlugin(h.shipped, 'flaky', `throw new Error('import exploded');`);
      enable('flaky');
      const { call } = await start();
      const want = { status: 503, body: { error: 'plugin_unavailable', plugin: 'flaky' } };
      expect(await call('GET', '/flaky/ping', { 'x-session': 'yes' })).toEqual(want);
      expect(await call('GET', '/flaky/internal/who', { 'x-internal-token': 'secret-token-xyz' })).toEqual(want);
      expect(pluginList().find((p) => p.id === 'flaky')!.error).toMatch(/routes failed to load.*import exploded.*reload/s);
      await stop();
      warn.mockRestore();
    });
    it('50 requests to a broken plugin cause exactly one import attempt; a reload causes exactly one more', async () => {
      const warn = quiet();
      const counter = join(tmp, `attempts-${n}`);
      const dir = routesPlugin(h.shipped, 'brk', `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(counter)}, 'x');
throw new Error('still broken');`);
      enable('brk');
      const { call } = await start();
      const s = { 'x-session': 'yes' };
      for (let i = 0; i < 50; i++) expect((await call('GET', '/brk/ping', s)).status).toBe(503);
      expect(attempts(counter)).toBe(1);
      // the file is fixed, but nothing reloads it on its own
      writeFileSync(join(dir, 'routes.mjs'), OK_ROUTES);
      for (let i = 0; i < 5; i++) expect((await call('GET', '/brk/ping', s)).status).toBe(503);
      expect(pluginList().find((p) => p.id === 'brk')!.error).toMatch(/still broken/);
      // reload needs the session
      expect((await call('POST', '/brk/reload')).status).toBe(401);
      expect((await call('POST', '/brk/reload', { 'x-internal-token': 'secret-token-xyz' })).status).toBe(401);
      expect(await call('POST', '/brk/reload', s)).toEqual({ status: 200, body: { ok: true, plugin: 'brk' } });
      expect(await call('GET', '/brk/ping', s)).toEqual({ status: 200, body: { pong: true } });
      expect(pluginList().find((p) => p.id === 'brk')!.error).toBeNull();
      await stop();
      warn.mockRestore();
    });
    it('a reload of a still-broken plugin re-imports exactly once and answers 503 with the reason', async () => {
      const warn = quiet();
      const counter = join(tmp, `attempts-${n}`);
      routesPlugin(h.shipped, 'brk2', `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(counter)}, 'x');
throw new Error('nope again');`);
      enable('brk2');
      const { call } = await start();
      const s = { 'x-session': 'yes' };
      await call('GET', '/brk2/ping', s);
      expect(attempts(counter)).toBe(1);
      const r = await call('POST', '/brk2/reload', s);
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ error: 'plugin_unavailable', plugin: 'brk2' });
      expect(attempts(counter)).toBe(2);
      for (let i = 0; i < 10; i++) await call('GET', '/brk2/ping', s);
      expect(attempts(counter)).toBe(2);
      await stop();
      warn.mockRestore();
    });
    it('reload of an unknown, disabled or routeless plugin is a 404', async () => {
      routesPlugin(h.shipped, 'off', OK_ROUTES);
      plugin(h.shipped, 'noroutes', {});
      enable('noroutes');
      const { call } = await start();
      const s = { 'x-session': 'yes' };
      expect((await call('POST', '/ghost/reload', s)).status).toBe(404);
      expect((await call('POST', '/off/reload', s)).status).toBe(404);
      expect((await call('POST', '/noroutes/reload', s)).status).toBe(404);
      await stop();
    });
    it('a healthy plugin can be reloaded too (one more import, still serving)', async () => {
      const counter = join(tmp, `attempts-${n}`);
      routesPlugin(h.shipped, 'okp', `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(counter)}, 'x');
${OK_ROUTES}`);
      enable('okp');
      const { call } = await start();
      const s = { 'x-session': 'yes' };
      expect((await call('GET', '/okp/ping', s)).status).toBe(200);
      expect(attempts(counter)).toBe(1);
      expect((await call('POST', '/okp/reload', s)).status).toBe(200);
      expect(attempts(counter)).toBe(2);
      expect((await call('GET', '/okp/ping', s)).status).toBe(200);
      expect(attempts(counter)).toBe(2);
      await stop();
    });
    it('a default export that throws is also unavailable, not a crash', async () => {
      const warn = quiet();
      routesPlugin(h.shipped, 'thr', `export default () => { throw new Error('factory exploded'); };`);
      enable('thr');
      const { call } = await start();
      expect((await call('GET', '/thr/x', { 'x-session': 'yes' })).status).toBe(503);
      await stop();
      warn.mockRestore();
    });
    it('boot logs one line per discovered plugin: id, enabled, error', async () => {
      const warn = quiet();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      plugin(h.shipped, 'fine', {});
      plugin(h.shipped, 'off', {});
      plugin(h.shipped, 'nohelp', { help: 'help.md' });
      enable('fine', 'nohelp');
      const { call } = await start();
      await call('GET', '/');
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[plugins]'));
      expect(lines).toHaveLength(3);
      expect(lines).toContain('[plugins] fine: enabled=true error=none');
      expect(lines).toContain('[plugins] off: enabled=false error=none');
      expect(lines.find((l) => l.startsWith('[plugins] nohelp: enabled=true error='))).toMatch(/help\.md not found/);
      await stop();
      log.mockRestore();
      warn.mockRestore();
    });
  });

  describe('BLOCKER B: a throwing handler is a JSON 500, never a process exit', () => {
    const THROWERS = `import express from 'express';
export default () => {
  const r = express.Router();
  r.get('/ok', (_q, s) => s.json({ ok: true }));
  r.get('/sync', () => { throw new Error('boom sync'); });
  r.get('/async', async () => { throw new Error('boom async'); });
  r.get('/reject', () => Promise.reject(new Error('boom reject')));
  const nested = express.Router();
  nested.get('/deep', async () => { throw new Error('boom nested'); });
  r.use('/n', nested);
  const internal = express.Router();
  internal.post('/note', async () => { throw new Error('boom internal'); });
  return { public: r, internal };
};`;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
    const settle = () => new Promise((r) => setTimeout(r, 50));
    const failBody = (id: string) => ({ status: 500, body: { error: 'plugin_failed', plugin: id } });

    it('sync throw, async throw, rejected promise, nested router, internal side: each a JSON 500, logged once, and the plugin keeps serving', async () => {
      routesPlugin(h.shipped, 'th', THROWERS);
      enable('th');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { call } = await start();
      const s = { 'x-session': 'yes' };
      for (const [path, msg] of [['/th/sync', 'boom sync'], ['/th/async', 'boom async'], ['/th/reject', 'boom reject'], ['/th/n/deep', 'boom nested']] as const) {
        err.mockClear();
        expect(await call('GET', path, s)).toEqual(failBody('th'));
        expect(err).toHaveBeenCalledTimes(1);
        expect(String(err.mock.calls[0].join(' '))).toContain(msg);
      }
      err.mockClear();
      expect(await call('POST', '/th/internal/note', { 'x-internal-token': 'secret-token-xyz' })).toEqual(failBody('th'));
      expect(err).toHaveBeenCalledTimes(1);
      expect(await call('GET', '/th/ok', s)).toEqual({ status: 200, body: { ok: true } });
      await settle();
      expect(unhandled).toEqual([]);
      await stop();
      err.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    });

    it('a default export that is a bare function (not a Router) is rejected at import: 503, not a handler', async () => {
      routesPlugin(h.shipped, 'bare', `export default () => (_q, _s) => { throw new Error('bare throw'); };`);
      routesPlugin(h.shipped, 'bare2', `export default () => async (_q, _s) => { throw new Error('bare reject'); };`);
      enable('bare', 'bare2');
      const warn = quiet();
      const { call } = await start();
      expect(await call('GET', '/bare/x', { 'x-session': 'yes' })).toEqual({ status: 503, body: { error: 'plugin_unavailable', plugin: 'bare' } });
      expect((await call('GET', '/bare2/x', { 'x-session': 'yes' })).status).toBe(503);
      expect(pluginList().find((p) => p.id === 'bare')!.error).toMatch(/express\.Router/);
      await settle();
      expect(unhandled).toEqual([]);
      await stop();
      warn.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    });

    it('does not try to send JSON when the plugin already started the response', async () => {
      routesPlugin(h.shipped, 'half', `import express from 'express';
export default () => { const r = express.Router(); r.get('/x', (_q, s) => { s.status(200).write('part'); throw new Error('late'); }); return r; };`);
      enable('half');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { call } = await start();
      await call('GET', '/half/x', { 'x-session': 'yes' }).catch(() => null);
      expect(err).toHaveBeenCalledTimes(1);
      await stop();
      err.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    });
  });
});

describe('normalizeRouters', () => {
  it('reads a router, a { public, internal } pair, and an internal-flagged router', () => {
    const r: any = express.Router();
    expect(normalizeRouters(r)).toEqual({ public: r });
    const i: any = express.Router(); i.internal = true;
    expect(normalizeRouters(i)).toEqual({ internal: i });
    expect(normalizeRouters({ public: r, internal: i })).toEqual({ public: r, internal: i });
    expect(normalizeRouters(null)).toEqual({});
  });
});

// ── Pass 3 ───────────────────────────────────────────────────────────────────
const allow = (_q: any, _s: any, next: () => void) => next();
let live: Server | undefined;
async function mountApp(mountExtra: Record<string, unknown> = {}) {
  const app = express();
  app.use('/api/plugins', createPluginMount({ auth: allow, internalOnly: allow, writeGate: allow, api: { config: {} as any, log: () => {} }, ...mountExtra }));
  await new Promise<void>((r) => { live = app.listen(0, '127.0.0.1', () => r()); });
  const port = (live!.address() as AddressInfo).port;
  return (method: string, path: string) =>
    fetch(`http://127.0.0.1:${port}/api/plugins${path}`, { method }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}
const stopApp = () => new Promise<void>((r) => (live ? live.close(() => r()) : r()));
const failBody = (id: string) => ({ status: 500, body: { error: 'plugin_failed', plugin: id } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('S2: router shapes that used to kill the process', () => {
  beforeEach(fresh);
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
  const done = async () => { await sleep(60); process.off('unhandledRejection', onUnhandled); await stopApp(); };

  it('an express() sub-app is rejected at import with a clear error and a 503', async () => {
    const warn = quiet();
    routesPlugin(h.shipped, 'subapp', `import express from 'express';
export default () => { const a = express(); a.get('/x', (_q, s) => s.json({ x: 1 })); return a; };`);
    routesPlugin(h.shipped, 'subapp2', `import express from 'express';
export default () => { const a = express(); a.get('/x', (_q, s) => s.json({ x: 1 })); return { public: express.Router(), internal: a }; };`);
    enable('subapp', 'subapp2');
    const call = await mountApp();
    expect(await call('GET', '/subapp/x')).toEqual({ status: 503, body: { error: 'plugin_unavailable', plugin: 'subapp' } });
    expect((await call('GET', '/subapp2/x')).status).toBe(503);
    expect(pluginList().find((p) => p.id === 'subapp')!.error).toMatch(/express\(\) app.*express\.Router\(\)/s);
    expect(pluginList().find((p) => p.id === 'subapp2')!.error).toMatch(/express\(\) app/);
    await done();
    warn.mockRestore();
  });

  it('an async router.param callback that rejects is a JSON 500, once', async () => {
    routesPlugin(h.shipped, 'prm', `import express from 'express';
export default () => {
  const r = express.Router();
  r.param('id', async (_q, _s, next, id) => { if (id === 'bad') throw new Error('boom param'); next(); });
  r.get('/p/:id', (q, s) => s.json({ id: q.params.id }));
  return r;
};`);
    enable('prm');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = await mountApp();
    expect(await call('GET', '/prm/p/good')).toEqual({ status: 200, body: { id: 'good' } });
    expect(await call('GET', '/prm/p/bad')).toEqual(failBody('prm'));
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0].join(' '))).toContain('boom param');
    expect(await call('GET', '/prm/p/good')).toEqual({ status: 200, body: { id: 'good' } });
    expect(unhandled).toEqual([]);
    await done();
    err.mockRestore();
  });

  it('an async 4-argument error middleware that rejects is a JSON 500, once', async () => {
    routesPlugin(h.shipped, 'emw', `import express from 'express';
export default () => {
  const r = express.Router();
  r.get('/boom', () => { throw new Error('first'); });
  r.get('/ok', (_q, s) => s.json({ ok: true }));
  r.use(async (err, _q, _s, _n) => { throw new Error('boom errmw after ' + err.message); });
  return r;
};`);
    enable('emw');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = await mountApp();
    expect(await call('GET', '/emw/boom')).toEqual(failBody('emw'));
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0].join(' '))).toContain('boom errmw after first');
    expect(await call('GET', '/emw/ok')).toEqual({ status: 200, body: { ok: true } });
    expect(unhandled).toEqual([]);
    await done();
    err.mockRestore();
  });

  it('a route registered after import (lazily) is guarded too', async () => {
    routesPlugin(h.shipped, 'lazy', `import express from 'express';
export default () => {
  const r = express.Router();
  r.get('/ok', (_q, s) => s.json({ ok: true }));
  setTimeout(() => { r.get('/late', async () => { throw new Error('boom late'); }); }, 30);
  return r;
};`);
    enable('lazy');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = await mountApp();
    expect((await call('GET', '/lazy/ok')).status).toBe(200);
    await sleep(120);
    expect(await call('GET', '/lazy/late')).toEqual(failBody('lazy'));
    expect(err).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    await done();
    err.mockRestore();
  });

  it('a nested sub-router with a multi-handler route, and an array of handlers, keep serving after a failure', async () => {
    routesPlugin(h.shipped, 'mix', `import express from 'express';
export default () => {
  const r = express.Router();
  const inner = express.Router();
  inner.route('/chain').get(async (_q, _s, next) => next(), async () => { throw new Error('boom chain'); });
  r.use('/in', inner);
  r.get('/ok', [(_q, _s, n) => n(), (_q, s) => s.json({ ok: true })]);
  return r;
};`);
    enable('mix');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = await mountApp();
    expect(await call('GET', '/mix/in/chain')).toEqual(failBody('mix'));
    expect(await call('GET', '/mix/ok')).toEqual({ status: 200, body: { ok: true } });
    expect(unhandled).toEqual([]);
    await done();
    err.mockRestore();
  });

  it('exactly one unhandledRejection handler is registered by plugins.ts, however many mounts are created', () => {
    createPluginMount({ auth: allow, internalOnly: allow, writeGate: allow, api: { config: {} as any, log: () => {} } });
    createPluginMount({ auth: allow, internalOnly: allow, writeGate: allow, api: { config: {} as any, log: () => {} } });
    expect(process.listeners('unhandledRejection').filter((l) => l.name === 'sanctumPluginRejectionNet')).toHaveLength(1);
    process.off('unhandledRejection', onUnhandled);
  });

  describe('the process-level safety net, in a real child process', () => {
    const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
    const pluginsTs = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), 'plugins.ts')).href;
    const ratifyTs = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), 'plugin-ratify.ts')).href;
    const child = (hits: Array<[string, string]>, ids: string[], mode = '') => {
      const script = join(tmp, `child-${n}-${Math.random().toString(36).slice(2)}.mjs`);
      writeFileSync(script, `import express from ${expressUrl};
const { createPluginMount, loadPlugins } = await import(${JSON.stringify(pluginsTs)});
const ids = ${JSON.stringify(ids)};
const pass = (_q, _s, next) => next();
const app = express();
// The real ratification check runs here (no mock in a child), against a ledger of its own.
const { ratifyPlugin } = await import(${JSON.stringify(ratifyTs)});
const ledger = ${JSON.stringify(join(tmp, `child-ledger-${n}.json`))};
const plugins = loadPlugins({ roots: [${JSON.stringify(h.shipped)}] });
for (const p of plugins) if (p.manifest) ratifyPlugin(ledger, p);
app.use('/api/plugins', createPluginMount({ auth: pass, internalOnly: pass, writeGate: pass, api: { config: {}, log() {} }, plugins, enabled: new Set(ids), ledger }));
const srv = app.listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;
const out = {};
for (const [k, path] of ${JSON.stringify(hits)}) { const r = await fetch('http://127.0.0.1:' + port + '/api/plugins' + path); out[k] = [r.status, await r.text()]; }
await new Promise((r) => setTimeout(r, 150));
if (${JSON.stringify(mode)} === 'rogue') { Promise.reject(new Error('rogue rejection')); await new Promise((r) => setTimeout(r, 300)); }
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);`);
      const r = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: repoRoot, encoding: 'utf-8', timeout: 60000 });
      const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
      return { status: r.status, stderr: r.stderr, out: line ? JSON.parse(line.slice(7)) : null };
    };
    const SHAPES = `import express from 'express';
export default () => {
  const r = express.Router();
  r.get('/ok', (_q, s) => s.json({ ok: true }));
  r.get('/float', (_q, _s) => { Promise.reject(new Error('boom float')); });
  r.get('/float-later', (_q, _s) => { setTimeout(() => { Promise.reject(new Error('boom float later')); }, 20); });
  r.get('/after', (_q, s) => { s.json({ ok: 'sent' }); setTimeout(() => { Promise.reject(new Error('boom after response')); }, 20); });
  r.get('/emit', async (_q, _s) => { await null; await Promise.reject(new Error('boom awaited')); });
  r.param('id', async () => { throw new Error('boom param'); });
  r.get('/p/:id', (_q, s) => s.json({}));
  return r;
};`;
    it('floating promises inside a plugin dispatch answer a JSON 500, or end an already-started response, and the process lives', () => {
      routesPlugin(h.shipped, 'net', SHAPES);
      const r = child([['ok', '/net/ok'], ['float', '/net/float'], ['later', '/net/float-later'], ['after', '/net/after'], ['emit', '/net/emit'], ['param', '/net/p/1'], ['ok2', '/net/ok']], ['net']);
      expect(r.status).toBe(0);
      expect(r.out.ok).toEqual([200, '{"ok":true}']);
      for (const k of ['float', 'later', 'emit', 'param']) {
        expect(r.out[k][0], k).toBe(500);
        expect(JSON.parse(r.out[k][1]), k).toEqual({ error: 'plugin_failed', plugin: 'net' });
      }
      expect(r.out.after).toEqual([200, '{"ok":"sent"}']);
      expect(r.out.ok2).toEqual([200, '{"ok":true}']);
      expect(r.stderr).toContain('boom float');
      expect(r.stderr).toContain('boom after response');
      expect(r.stderr).not.toMatch(/UnhandledPromiseRejection|triggerUncaughtException/);
    }, 60000);
    it('a sub-app plugin next to a good one does not take the process down', () => {
      routesPlugin(h.shipped, 'sub', `import express from 'express'; export default () => express();`);
      routesPlugin(h.shipped, 'good', `import express from 'express'; export default () => { const r = express.Router(); r.get('/x', (_q, s) => s.json({ good: true })); return r; };`);
      const r = child([['sub', '/sub/x'], ['good', '/good/x']], ['sub', 'good']);
      expect(r.status).toBe(0);
      expect(r.out.sub[0]).toBe(503);
      expect(r.out.good).toEqual([200, '{"good":true}']);
    }, 60000);
    it('outside a plugin context an unhandled rejection is not swallowed: the process still dies, as by default', () => {
      routesPlugin(h.shipped, 'net2', SHAPES);
      const r = child([['ok', '/net2/ok']], ['net2'], 'rogue');
      expect(r.status).not.toBe(0);
      expect(r.out).toBeNull();
      expect(r.stderr).toContain('rogue rejection');
    }, 60000);
  });
});

describe('S4: the shipped root is held to the writable-root check', () => {
  beforeEach(fresh);
  const shippedPlugin = () => plugin(h.shipped, 'hi', { dsh: { rows: [{ id: 'r', name: 'pkg' }] } });
  const repoRoot = () => join(h.shipped, '..');

  it('agent.cwd equal to the project root (the default) refuses the shipped root, loudly, and names the fix', () => {
    const warn = quiet();
    shippedPlugin();
    h.cwd = repoRoot();
    h.ledgerDir = join(tmp, `ledger-away-${n}`); // keep the ledger clash out of this one: it tests the shipped root's own message
    enable('hi');
    expect(loadRatified()).toEqual([]);
    expect(pluginRows(ctx)).toEqual([]);
    const msg = warn.mock.calls.flat().join('\n');
    expect(msg).toMatch(/shipped plugin root .*refus/s);
    expect(msg).toMatch(/agent\.cwd/);
    expect(msg).toMatch(/equals, contains or sits inside/i);
    warn.mockRestore();
  });
  it('agent.cwd that contains the project root refuses it too; so does one inside the plugins folder', () => {
    const warn = quiet();
    shippedPlugin();
    h.cwd = join(h.shipped, '..', '..');
    expect(loadRatified()).toEqual([]);
    resetPlugins();
    h.cwd = join(h.shipped, 'hi', 'state');
    mkdirSync(h.cwd, { recursive: true });
    expect(loadRatified()).toEqual([]);
    warn.mockRestore();
  });
  it('a companion home next to the app folder, or inside it but outside plugins/, leaves the shipped root alone', () => {
    shippedPlugin();
    h.cwd = join(repoRoot(), 'companion-home');
    mkdirSync(h.cwd, { recursive: true });
    expect(validIds(loadRatified())).toEqual(['hi']);
  });
  it('a symlinked home that resolves onto the project root is caught by realpath', (t) => {
    const warn = quiet();
    shippedPlugin();
    const link = join(tmp, `home-link-${n}`);
    if (!linkOrSkip(t, repoRoot(), link, 'dir')) return;
    h.cwd = link;
    expect(loadRatified()).toEqual([]);
    warn.mockRestore();
  });
  it('the other writable roots count for the shipped root as well (codex extra dirs, dsh home)', () => {
    const warn = quiet();
    shippedPlugin();
    h.extra = [repoRoot()];
    expect(loadRatified()).toEqual([]);
    resetPlugins();
    h.extra = [];
    h.dshHome = h.shipped;
    expect(loadRatified()).toEqual([]);
    warn.mockRestore();
  });
});

describe('verifier 6: a folder that does not exist yet, under a symlinked parent', () => {
  beforeEach(fresh);
  it('realOrResolved resolves the nearest existing ancestor and appends the rest', () => {
    const real = join(tmp, `ro-real-${n}`);
    mkdirSync(real);
    const link = join(tmp, `ro-link-${n}`);
    symlinkSync(real, link);
    expect(pluginsModule.realOrResolved(join(link, 'a', 'b'))).toBe(join(realpathSync.native(real), 'a', 'b'));
    expect(pluginsModule.realOrResolved(join(real, 'x'))).toBe(join(realpathSync.native(real), 'x'));
  });
  it('realOrResolved follows a dangling link to where it would land', () => {
    const real = join(tmp, `ro-dang-real-${n}`);
    mkdirSync(real);
    const link = join(tmp, `ro-dang-${n}`);
    symlinkSync(join(real, 'later'), link);
    expect(pluginsModule.realOrResolved(join(link, 'deeper'))).toBe(join(realpathSync.native(real), 'later', 'deeper'));
  });
  it('personRoot refuses plugins.dir that does not exist yet but sits under a link into agent.cwd', () => {
    const warn = quiet();
    const link = join(tmp, `plug-parent-link-${n}`);
    symlinkSync(h.cwd, link);
    h.person = join(link, 'plugins'); // not created
    expect(existsSync(h.person)).toBe(false);
    expect(pluginsModule.personRoot({ plugins: { dir: h.person, trust: 'person' }, agent: { cwd: h.cwd } })).toBe(''); // the refusal is person-mode behaviour
    expect(warn.mock.calls.flat().join('\n')).toMatch(/plugins\.dir .*refus.*agent\.cwd/s);
    warn.mockRestore();
  });
  it('writableClash sees the same clash for a folder that does not exist yet', () => {
    const link = join(tmp, `clash-link-${n}`);
    symlinkSync(h.cwd, link);
    expect(pluginsModule.writableClash(join(link, 'private', 'deep'), { agent: { cwd: h.cwd } })).toMatchObject({ label: 'agent.cwd' });
  });
});

describe('S6: misconfiguration is not silent', () => {
  beforeEach(fresh);
  it('an enabled id with no plugin on disk is listed with error "not found on disk" and warned about at boot', async () => {
    const warn = quiet();
    plugin(h.shipped, 'real', {});
    enable('real', 'ghost');
    expect(pluginList().find((p) => p.id === 'ghost')).toEqual({
      id: 'ghost', name: 'ghost', version: '', harness: [], routes: false, help: false, tenant_aware: false, enabled: true, error: 'not found on disk',
      ratification: { state: 'unavailable', digest: '', detail: 'not found on disk' },
    });
    expect(pluginList().find((p) => p.id === 'real')!.error).toBeNull();
    const call = await mountApp();
    const r = await call('GET', '/');
    expect(r.body.plugins.map((p: any) => [p.id, p.enabled, p.error])).toEqual([['ghost', true, 'not found on disk'], ['real', true, null]]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/plugins\.enabled names "ghost".*no plugin.*on disk/s);
    await stopApp();
    warn.mockRestore();
  });
  it('a plugins.dir that does not exist logs a warning naming it', () => {
    const warn = quiet();
    h.person = join(tmp, `no-such-dir-${n}`);
    loadRatified();
    expect(warn.mock.calls.flat().join('\n')).toMatch(/plugins\.dir .*no-such-dir.* does not exist/s);
    warn.mockRestore();
  });
  it('an empty plugins.dir warns about nothing', () => {
    const warn = quiet();
    h.person = '';
    loadRatified();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('~ is expanded in plugins.dir and in every writable root before the containment check', () => {
    const warn = quiet();
    const oldHome = process.env.HOME;
    const oldProfile = process.env.USERPROFILE;
    const home = join(tmp, `fakehome-${n}`);
    mkdirSync(join(home, 'companion', 'plugins'), { recursive: true });
    mkdirSync(join(home, 'extra', 'p'), { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
    try {
      plugin(join(home, 'companion', 'plugins'), 'mine', {});
      h.cwd = '~/companion';
      h.person = '~/companion/plugins';
      expect(loadRatified()).toEqual([]); // inside the home, though neither path was absolute
      expect(warn.mock.calls.flat().join('\n')).toMatch(/refus/);
      resetPlugins();
      h.cwd = join(tmp, `elsewhere-${n}`);
      h.extra = ['~/extra'];
      h.person = '~/extra/p';
      plugin(join(home, 'extra'), 'p', {});
      expect(loadRatified()).toEqual([]);
      resetPlugins();
      h.extra = [];
      h.person = '~/extra';
      mkdirSync(h.cwd, { recursive: true });
      expect(validIds(loadRatified())).toEqual(['p']); // ~ really expanded: found on disk, not refused
    } finally {
      process.env.HOME = oldHome;
      if (oldProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldProfile;
    }
    warn.mockRestore();
  });
});

// ── Pass 4 ───────────────────────────────────────────────────────────────────
describe('P4: api.Router, scan errors, and reload that keeps the working router', () => {
  beforeEach(fresh);
  const done = async () => { await stopApp(); };
  const expressPing = (v: string) => `import express from 'express'; export default () => { const r = express.Router(); r.get('/ping', (_q, s) => s.json({ v: ${JSON.stringify(v)} })); return r; };`;
  const pingRoutes = (v: string) => `export default (api) => { const r = api.Router(); r.get('/ping', (_q, s) => s.json({ v: ${JSON.stringify(v)} })); return r; };`;

  it('a routes.mjs in the person root that uses only api.Router() mounts and answers 200 (no import of express)', async () => {
    const dir = plugin(h.person, 'mine', { routes: 'routes.mjs' });
    writeFileSync(join(dir, 'routes.mjs'), `export default (api) => {
  const r = api.Router();
  r.get('/ping', (_q, s) => s.json({ pong: true, sameExpress: typeof api.express === 'function' && api.express.Router === api.Router }));
  return r;
};`);
    enable('mine');
    const call = await mountApp();
    expect(await call('GET', '/mine/ping')).toEqual({ status: 200, body: { pong: true, sameExpress: true } });
    await done();
  });

  it('a plugin with a scan error contributes no rows, no routes and no help, and its list entry carries the error', async () => {
    const warn = quiet();
    plugin(h.shipped, 'half', { dsh: { rows: [{ id: 'good', name: 'pkg' }, { id: 'approval', name: 'pkg' }] }, help: 'help.md', routes: 'routes.mjs' },
      { 'help.md': 'some help', 'routes.mjs': pingRoutes('x') });
    plugin(h.shipped, 'whole', { dsh: { rows: [{ id: 'good', name: 'pkg' }] }, help: 'help.md' }, { 'help.md': 'ok help' });
    enable('half', 'whole');
    expect(pluginRows(ctx).map((r) => r.id)).toEqual(['plugin:whole:good']);
    expect(Object.keys(pluginHelp())).toEqual(['whole']);
    expect(pluginList().find((p) => p.id === 'half')!.error).toMatch(/approval.*dsh base row/);
    expect(pluginList().find((p) => p.id === 'whole')!.error).toBeNull();
    const call = await mountApp();
    expect((await call('GET', '/half/ping')).status).toBe(404);
    await done();
    warn.mockRestore();
  });

  it('a failed reload keeps the previous router serving; a later good reload swaps the new one in', async () => {
    const warn = quiet();
    // `import express` (not api.Router) so a red result here is about keeping the old router, nothing else.
    const dir = routesPlugin(h.person, 'rl', '');
    const file = join(dir, 'routes.mjs');
    const put = (body: string) => writeFileSync(file, body.replace("from 'express'", `from ${expressUrl}`));
    put(expressPing('one'));
    enable('rl');
    const call = await mountApp();
    expect(await call('GET', '/rl/ping')).toEqual({ status: 200, body: { v: 'one' } });
    put(`throw new Error('broke it');`); ratifyOnDisk(); // the person ratified the edit in the app
    const bad = await call('POST', '/rl/reload');
    expect(bad.status).toBe(503);
    expect(bad.body).toMatchObject({ error: 'plugin_unavailable', plugin: 'rl' });
    expect(bad.body.detail).toMatch(/broke it/);
    expect(await call('GET', '/rl/ping')).toEqual({ status: 200, body: { v: 'one' } }); // old router still serves
    expect(pluginList().find((p) => p.id === 'rl')!.error).toMatch(/broke it.*previous version is still serving/s);
    put(expressPing('two')); ratifyOnDisk();
    expect(await call('POST', '/rl/reload')).toEqual({ status: 200, body: { ok: true, plugin: 'rl' } });
    expect(await call('GET', '/rl/ping')).toEqual({ status: 200, body: { v: 'two' } });
    expect(pluginList().find((p) => p.id === 'rl')!.error).toBeNull();
    await done();
    warn.mockRestore();
  });
});

// ── Pass 5 ───────────────────────────────────────────────────────────────────
describe('P5: a stale import attempt never overwrites a newer one', () => {
  beforeEach(fresh);
  // `import express`, not api.Router: this isolates the reload behaviour.
  const ping = (v: string) => `import express from 'express'; export default () => { const r = express.Router(); r.get('/ping', (_q, s) => s.json({ v: ${JSON.stringify(v)} })); return r; };`;
  const slow = (ms: number, tail: string) => `await new Promise((r) => setTimeout(r, ${ms}));\n${tail}`;
  const put = (file: string, body: string) => writeFileSync(file, body.replace("from 'express'", `from ${expressUrl}`));

  it('a reload that finishes while the slow first import is still running wins: the late v1 result is discarded and GET ends on v2', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const dir = routesPlugin(h.person, 'race', '');
    const file = join(dir, 'routes.mjs');
    put(file, slow(800, ping('one')));
    enable('race');
    const call = await mountApp();
    const first = call('GET', '/race/ping'); // starts the slow first import
    await sleep(150);
    put(file, ping('two')); ratifyOnDisk();
    expect(await call('POST', '/race/reload')).toEqual({ status: 200, body: { ok: true, plugin: 'race' } });
    await first; // whatever the in-flight request itself saw
    await sleep(1000); // the slow v1 import finishes now
    expect(await call('GET', '/race/ping')).toEqual({ status: 200, body: { v: 'two' } });
    expect(await call('GET', '/race/ping')).toEqual({ status: 200, body: { v: 'two' } });
    expect(pluginList().find((p) => p.id === 'race')!.error).toBeNull();
    expect(debug.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/race.*stale/);
    await stopApp();
    debug.mockRestore();
  });

  it('a late FAILURE from a stale attempt writes no error while a newer good version serves', async () => {
    const warn = quiet();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const dir = routesPlugin(h.person, 'late', '');
    const file = join(dir, 'routes.mjs');
    put(file, slow(600, `throw new Error('late boom');`));
    enable('late');
    const call = await mountApp();
    const first = call('GET', '/late/ping');
    await sleep(150);
    put(file, ping('two')); ratifyOnDisk();
    expect((await call('POST', '/late/reload')).status).toBe(200);
    await first;
    await sleep(800); // the stale attempt has failed by now
    expect(await call('GET', '/late/ping')).toEqual({ status: 200, body: { v: 'two' } });
    expect(pluginList().find((p) => p.id === 'late')!.error).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/late boom/);
    expect(debug.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/late.*stale/);
    await stopApp();
    warn.mockRestore();
    debug.mockRestore();
  });
});

// ── Codex review on feat/plugin-loader ───────────────────────────────────────
describe('B: a manifest may not declare the same dsh row id twice', () => {
  beforeEach(fresh);
  const ok = { id: 'a', name: 'A', version: '1.0.0' };
  it('rejects it at validation, naming the duplicate id', () => {
    const r = validateManifest({ ...ok, dsh: { rows: [{ id: 'dup', name: 'p1' }, { id: 'other', name: 'p2' }, { id: 'dup', name: 'p3' }] } });
    expect(r.manifest).toBeUndefined();
    expect(r.errors.join('\n')).toMatch(/duplicate dsh row id "dup"/);
    expect(r.errors.join('\n')).toMatch(/dsh\.rows\[2\]/);
  });
  it('also for the ask-user id and for an entry row next to a name row', () => {
    expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'tool-ask-user' }, { id: 'tool-ask-user', config: {} }] } }).errors.join()).toMatch(/duplicate dsh row id "tool-ask-user"/);
    expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'x', entry: 'a.mjs' }, { id: 'x', name: 'pkg' }] } }).errors.join()).toMatch(/duplicate dsh row id "x"/);
  });
  it('distinct ids are fine, and the same id in two different manifests is not a duplicate', () => {
    expect(validateManifest({ ...ok, dsh: { rows: [{ id: 'a', name: 'p' }, { id: 'b', name: 'p' }] } }).errors).toEqual([]);
  });
  it('at scan: the plugin is listed as broken with the error, contributes no rows, and a warning names the id', () => {
    const warn = quiet();
    plugin(h.shipped, 'twice', { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }, { id: 'r', entry: 'dsh/index.mjs' }] } }, { 'dsh/index.mjs': 'export default {}' });
    enable('twice');
    const listed = loadRatified().find((p) => p.id === 'twice')!;
    expect(listed.manifest).toBeNull();
    expect(listed.error).toMatch(/duplicate dsh row id "r"/);
    expect(pluginRows(ctx)).toEqual([]);
    expect(pluginList().find((p) => p.id === 'twice')!.error).toMatch(/duplicate dsh row id "r"/);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/duplicate dsh row id "r"/);
    warn.mockRestore();
  });
});

describe('C: a plugin id may not shadow a built-in help topic', () => {
  beforeEach(fresh);
  const ok = { name: 'A', version: '1.0.0' };
  it('rejects every TOOL_TOPICS name as an id', () => {
    expect(TOOL_TOPICS.length).toBeGreaterThan(5);
    for (const id of TOOL_TOPICS) {
      const r = validateManifest({ ...ok, id });
      expect(r.manifest, id).toBeUndefined();
      expect(r.errors.join(), id).toMatch(/id collides with a built-in help topic/);
      expect(r.errors.join(), id).toContain(id);
    }
  });
  it('accepts a near miss', () => {
    expect(validateManifest({ ...ok, id: 'timer2' }).errors).toEqual([]);
    expect(validateManifest({ ...ok, id: 'my-ask' }).errors).toEqual([]);
  });
  it('at scan the plugin shows as broken, and its help never replaces the built-in topic', () => {
    const warn = quiet();
    plugin(h.shipped, 'timer', { help: 'help.md' }, { 'help.md': 'timer: mine' });
    enable('timer');
    expect(loadRatified().find((p) => p.id === 'timer')!.error).toMatch(/collides with a built-in help topic/);
    expect(pluginHelp()).toEqual({});
    warn.mockRestore();
  });
});

describe('A: no plugins load while the active harness runs with danger-full-access', () => {
  beforeEach(fresh);
  const loadable = () => {
    plugin(h.shipped, 'good', { help: 'help.md', routes: 'routes.mjs', dsh: { rows: [{ id: 'r', name: 'pkg' }] } }, { 'help.md': 'good: help', 'routes.mjs': 'export default () => null' });
    enable('good');
  };
  it('fullAccessSetting names the setting only for the ACTIVE provider', () => {
    const cfg = (provider: string, codex: string, dsh: string) => ({ agent: { provider, codex: { sandbox_mode: codex }, dsh: { sandbox_mode: dsh } } });
    expect(fullAccessSetting(cfg('dsh', 'workspace-write', 'danger-full-access'))).toBe('agent.dsh.sandbox_mode');
    expect(fullAccessSetting(cfg('codex', 'danger-full-access', 'workspace-write'))).toBe('agent.codex.sandbox_mode');
    expect(fullAccessSetting(cfg('claude', 'danger-full-access', 'danger-full-access'))).toBeNull(); // Claude: the write-gate hook, not a sandbox mode
    expect(fullAccessSetting(cfg('dsh', 'danger-full-access', 'workspace-write'))).toBeNull(); // codex is not the active one
    expect(fullAccessSetting(cfg('codex', 'workspace-write', 'danger-full-access'))).toBeNull();
    expect(fullAccessSetting(cfg('dsh', 'read-only', 'read-only'))).toBeNull();
    expect(fullAccessSetting({})).toBeNull();
    expect(fullAccessSetting(undefined)).toBeNull();
    // Provider name case and the AGENT_PROVIDER override follow activeProviderName(): yaml `Codex`,
    // `CODEX`, or AGENT_PROVIDER=Codex all run Codex, so all must be seen as Codex here.
    expect(fullAccessSetting(cfg('Codex', 'danger-full-access', 'workspace-write'), {})).toBe('agent.codex.sandbox_mode');
    expect(fullAccessSetting(cfg('CODEX', 'danger-full-access', 'workspace-write'), {})).toBe('agent.codex.sandbox_mode');
    expect(fullAccessSetting(cfg(' dsh ', 'workspace-write', 'danger-full-access'), {})).toBe('agent.dsh.sandbox_mode');
    expect(fullAccessSetting(cfg('claude', 'danger-full-access', 'workspace-write'), { AGENT_PROVIDER: 'Codex' })).toBe('agent.codex.sandbox_mode');
    expect(fullAccessSetting(cfg('codex', 'danger-full-access', 'workspace-write'), { AGENT_PROVIDER: 'claude' })).toBeNull(); // env wins the other way too
  });
  it.each([['dsh', 'dshSandbox', 'agent.dsh.sandbox_mode'], ['codex', 'codexSandbox', 'agent.codex.sandbox_mode']] as const)(
    '%s on danger-full-access: loadPlugins, pluginRows and pluginHelp are all empty, and ONE loud warning names %s', (provider, key, setting) => {
      const warn = quiet();
      loadable();
      expect(validIds(loadRatified())).toEqual(['good']); // control: loads under workspace-write
      resetPlugins();
      warn.mockClear();
      h.provider = provider;
      h[key] = 'danger-full-access';
      expect(pluginsDisabled()).toBe('full_access');
      expect(loadRatified()).toEqual([]);
      expect(pluginRows({ ...ctx, harness: provider })).toEqual([]);
      expect(pluginHelp()).toEqual({});
      loadRatified(); pluginRows(ctx); pluginHelp();
      const lines = warn.mock.calls.flat().map(String).filter((l) => l.includes(setting));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/danger-full-access/);
      expect(lines[0]).toMatch(/no plugins? load/i);
      warn.mockRestore();
    });
  it('an explicit plugin list does not get around it: pluginRows and pluginHelp check the setting themselves', () => {
    const warn = quiet();
    loadable();
    const found = loadRatified({ roots: [h.shipped] });
    expect(pluginRows({ ...ctx, harness: 'dsh' }, found)).toHaveLength(1);
    h.provider = 'dsh'; h.dshSandbox = 'danger-full-access';
    expect(pluginRows({ ...ctx, harness: 'dsh' }, found)).toEqual([]);
    expect(pluginHelp(found)).toEqual({});
    warn.mockRestore();
  });
  it('workspace-write and read-only still load; Claude is unaffected whatever the codex or dsh setting says', () => {
    loadable();
    for (const [provider, sandbox] of [['dsh', 'workspace-write'], ['codex', 'read-only'], ['claude', 'workspace-write']] as const) {
      resetPlugins();
      h.provider = provider; h.dshSandbox = sandbox; h.codexSandbox = sandbox;
      // Under Codex and dsh this fixture sits in /tmp, which their sandboxes can write, so the ledger there is
      // refused for THAT reason (plugin-ratify.test.ts, B4); the sandbox setting is not what turns it off.
      if (provider === 'claude') expect(validIds(loadRatified()), provider).toEqual(['good']);
      else {
        expect(pluginsDisabled(), provider).not.toBe('full_access');
        expect(fullAccessSetting({ agent: { provider, [provider]: { sandbox_mode: sandbox } } }), provider).toBeNull();
      }
    }
    resetPlugins();
    h.provider = 'claude'; h.dshSandbox = 'danger-full-access'; h.codexSandbox = 'danger-full-access';
    expect(validIds(loadRatified())).toEqual(['good']);
  });
  it('no warning when nothing is enabled (a full-access setup with no plugins stays quiet)', () => {
    const warn = quiet();
    loadable();
    enable();
    h.provider = 'dsh'; h.dshSandbox = 'danger-full-access';
    expect(loadRatified()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('GET /api/plugins answers {disabled: "full_access"} and no plugin route is mounted', async () => {
    const warn = quiet();
    routesPlugin(h.shipped, 'rt', `import express from 'express';
export default () => { const r = express.Router(); r.get('/ping', (_q, s) => s.json({ pong: true })); return r; };`);
    enable('rt');
    h.provider = 'codex'; h.codexSandbox = 'danger-full-access';
    const call = await mountApp();
    const list = await call('GET', '/');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ trust: 'person', disabled: 'full_access', plugins: [] });
    expect((await call('GET', '/rt/ping')).status).toBe(404);
    await stopApp();
    h.provider = 'claude';
    resetPlugins();
    const call2 = await mountApp();
    const ok = await call2('GET', '/');
    expect(ok.body.disabled).toBeUndefined();
    expect(ok.body.plugins.map((p: any) => p.id)).toEqual(['rt']);
    expect(await call2('GET', '/rt/ping')).toEqual({ status: 200, body: { pong: true } });
    await stopApp();
    warn.mockRestore();
  });
});

describe('help.md read from a CRLF checkout', () => {
  beforeEach(fresh);
  it('carries no CR into the topic (Windows git checks text files out with CRLF)', () => {
    plugin(h.shipped, 'crlf', { help: 'help.md' }, { 'help.md': 'crlf: first line\r\nsecond line\r\n' });
    enable('crlf');
    expect(pluginHelp()).toEqual({ crlf: 'crlf: first line\nsecond line' });
  });
});
