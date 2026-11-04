// The update steps (scripts/updater-core.mjs) against a fake repo in a temp folder: no network (GitHub is a stub), no real app.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UpdateError, applyStaged, archivePlan, clearRollback, discardStage, killAllChildren, killProcessGroup, makeRollbackCopy, miniYaml, protectedPaths, readRollback,
  recoverInterruptedSwap, rollbackNow, STAGE_LEFT_MARKER, errorTail, procStartTime, rollbackNextRoot, takeRecoveryResult, resolveRepo, rollbackInfo, run, runRollback, runUpdate, selfUpdateSupport, stageDir, stageUpdate,
} from './updater-core.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Sam', GIT_AUTHOR_EMAIL: 'sam@example.test', GIT_COMMITTER_NAME: 'Sam', GIT_COMMITTER_EMAIL: 'sam@example.test', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();

const BUILD_JS = `
const fs = require('fs'), path = require('path');
if (fs.existsSync('FAIL_BUILD')) { console.error('boom: the build is broken'); process.exit(1); }
const v = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version;
for (const [f, body] of [['node_modules/built.txt', v], ['packages/backend/dist/server.js', '// backend ' + v], ['packages/shared/dist/index.js', '// shared ' + v], ['packages/frontend/build/index.html', '<p>' + v + '</p>']]) {
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body);
}`;
const lock = (v) => JSON.stringify({ name: 'fake', version: v, lockfileVersion: 3, requires: true, packages: { '': { name: 'fake', version: v } } }, null, 2);
const pkg = (v) => JSON.stringify({ name: 'fake', version: v, scripts: { build: 'node build.js' } }, null, 2);

function write(root, rel, body) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
const read = (root, rel) => readFileSync(join(root, rel), 'utf-8');

/** GitHub stand-in: the raw package.json says `version`; the download (if any) is `tarball`. */
const fakeFetch = (version, tarball) => async (url) => {
  if (String(url).includes('raw.githubusercontent')) return { ok: true, status: 200, text: async () => JSON.stringify({ version }) };
  if (tarball && String(url).includes('codeload')) return { ok: true, status: 200, arrayBuffer: async () => readFileSync(tarball) };
  return { ok: false, status: 404 };
};

/** A real swap on Windows can wait on git, antivirus and indexers for a while: 20 s there; Linux keeps vitest's defaults. */
const SLOW_MS = process.platform === 'win32' ? 20_000 : undefined;
const SLOW = { timeout: SLOW_MS };
// Every real-git test here is slow on a loaded Windows runner (the cut-swap recoveries sit right at vitest's 5 s default), so the whole file takes the Windows budget.
if (SLOW_MS) vi.setConfig({ testTimeout: SLOW_MS });
let tmp;
const settings = { repo: 'echo/sanctum', branch: 'main', cwd: '.', dbPath: './data/sanctum.db' };
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'updater-core-')); });
// (On Windows a worktree's files may be held for a moment after git exits: retry the removal with a backoff, as discardStage does.)
afterEach(() => { rmSync(tmp, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 3, retryDelay: 250 }); });

describe('git checkout', () => {
  let origin, app;
  function release(v, extra = {}) {
    write(origin, 'package.json', pkg(v)); write(origin, 'package-lock.json', lock(v)); write(origin, 'build.js', BUILD_JS);
    for (const [k, body] of Object.entries(extra)) write(origin, k, body);
    git(origin, 'add', '-A'); git(origin, '-c', 'commit.gpgsign=false', 'commit', '-m', `release ${v}`);
  }
  /** The state of the running folder that an update must not touch before the swap. */
  const live = () => ({
    head: git(app, 'rev-parse', 'HEAD'), modules: read(app, 'node_modules/built.txt'), dist: read(app, 'packages/backend/dist/server.js'),
    page: read(app, 'packages/frontend/build/index.html'), pkg: read(app, 'package.json'), lock: read(app, 'package-lock.json'), status: git(app, 'status', '--porcelain'),
  });
  beforeEach(() => {
    origin = join(tmp, 'origin'); app = join(tmp, 'app');
    mkdirSync(origin);
    git(origin, 'init', '-b', 'main');
    write(origin, '.gitignore', 'dist/\nbuild/\nnode_modules/\ndata/\n'); // (no .update-stage here: an older checkout's ignore file)
    release('1.0.0');
    git(tmp, 'clone', '-q', origin, app);
    execFileSync('node', ['build.js'], { cwd: app }); // the installed build
  });

  it('a clean tree updates through the stage, records the previous sha, builds, and keeps the previous node_modules and builds in .update-rollback', SLOW, async () => {
    const before = git(app, 'rev-parse', 'HEAD');
    release('1.1.0');
    const states = [], lines = [];
    const r = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0'), setState: (s) => states.push(s), log: (l) => lines.push(l) });
    expect(r).toMatchObject({ upToDate: false, from: '1.0.0', to: '1.1.0', mode: 'git', sha: before });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(r.toSha);
    expect(states).toEqual(['checking', 'fetching', 'installing', 'building']);
    expect(read(app, 'packages/backend/dist/server.js')).toContain('1.1.0');
    expect(read(app, 'node_modules/built.txt')).toBe('1.1.0'); // the stage's node_modules, moved in
    expect(lines.some((l) => l.includes('npm ci'))).toBe(true);
    expect(existsSync(stageDir(app))).toBe(false); // the stage is removed when done
    expect(git(app, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(app, 'status', '--porcelain')).toBe(''); // .update-stage and .update-rollback never show as local changes
    const info = rollbackInfo(app);
    expect(info).toMatchObject({ available: true, version: '1.0.0', mode: 'git' });
    const rb = readRollback(app);
    expect(rb.manifest).toMatchObject({ sha: before, toSha: r.toSha, toVersion: '1.1.0', phase: 'swapped' });
    expect(read(rb.dir, 'files/node_modules/built.txt')).toBe('1.0.0'); // the previous node_modules, moved (not copied)
    expect(read(rb.dir, 'files/packages/backend/dist/server.js')).toContain('1.0.0');
  });

  it('nothing in the running folder changes until the swap: not HEAD, node_modules, dist, build, the lockfile, or git status', SLOW, async () => {
    release('1.1.0');
    const before = live();
    const plan = await stageUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    expect(plan).toMatchObject({ staged: true, from: '1.0.0', to: '1.1.0', mode: 'git' });
    expect(live()).toEqual(before);
    expect(read(stageDir(app), 'node_modules/built.txt')).toBe('1.1.0'); // built there
    expect(read(stageDir(app), 'packages/backend/dist/server.js')).toContain('1.1.0');
    expect(existsSync(join(app, '.update-rollback'))).toBe(false);
    const r = await applyStaged({ root: app, plan });
    expect(r).toMatchObject({ to: '1.1.0' });
    expect(read(app, 'node_modules/built.txt')).toBe('1.1.0');
    expect(existsSync(stageDir(app))).toBe(false);
  });

  it('the swap checks the tree again: a file edited while the build ran refuses it, with the list, and nothing moves', SLOW, async () => {
    release('1.1.0');
    const plan = await stageUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'notes.txt', 'mine');
    const before = live();
    const err = await applyStaged({ root: app, plan }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.dirty).toEqual(expect.arrayContaining(['?? notes.txt']));
    expect({ ...live(), status: '' }).toEqual({ ...before, status: '' });
    expect(existsSync(join(app, '.update-rollback'))).toBe(false);
  });

  it('the swap refuses a checkout that moved on while the build ran', SLOW, async () => {
    release('1.1.0');
    const plan = await stageUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'mine.txt', 'x'); git(app, 'add', 'mine.txt'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'my own commit');
    const err = await applyStaged({ root: app, plan }).catch((e) => e);
    expect(err.message).toMatch(/moved on while the update was built/);
    expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
  });

  it('says so when the release has no lockfile and falls back to npm install', SLOW, async () => {
    release('1.1.0');
    git(origin, 'rm', '-q', 'package-lock.json'); git(origin, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'drop the lockfile');
    const lines = [];
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0'), log: (l) => lines.push(l) });
    expect(lines.some((l) => /no package-lock\.json: falling back to npm install/.test(l))).toBe(true);
  });

  it('a dirty tree is refused with the list, and nothing changes', SLOW, async () => {
    release('1.1.0');
    write(app, 'notes.txt', 'mine'); write(app, 'build.js', BUILD_JS + '\n// edited');
    const before = git(app, 'rev-parse', 'HEAD');
    const err = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.dirty).toEqual(expect.arrayContaining(['?? notes.txt', ' M build.js']));
    expect(err.message).toContain('notes.txt');
    expect(git(app, 'rev-parse', 'HEAD')).toBe(before);
    expect(read(app, 'notes.txt')).toBe('mine');
    expect(existsSync(join(app, '.update-rollback'))).toBe(false);
    expect(existsSync(stageDir(app))).toBe(false);
  });

  it('a failed build leaves the running folder exactly as it was (nothing to restore), deletes the stage, and says why', SLOW, async () => {
    release('1.1.0', { FAIL_BUILD: 'x' });
    const before = live();
    const lines = [];
    const err = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0'), log: (l) => lines.push(l) }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.restored).toBe(false);
    expect(err.message).toMatch(/^npm run build failed/);
    expect(err.message).toContain('boom: the build is broken'); // the last lines of the step's output are in the error
    expect(lines.some((l) => l.includes('boom'))).toBe(true);
    expect(live()).toEqual(before);
    expect(existsSync(stageDir(app))).toBe(false);
    expect(git(app, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(existsSync(join(app, '.update-rollback'))).toBe(false);
  });

  it('a stage a killed run left behind is deleted by the next run (and by discardStage at boot), worktree entry included', SLOW, async () => {
    release('1.1.0');
    git(app, 'fetch', '-q', 'origin', 'main');
    git(app, 'worktree', 'add', '--detach', stageDir(app), 'origin/main');
    write(stageDir(app), 'node_modules/half-installed.txt', 'x');
    expect(git(app, 'worktree', 'list').split('\n')).toHaveLength(2);
    expect(await discardStage(app)).toBe(true);
    expect(existsSync(stageDir(app))).toBe(false);
    expect(git(app, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(await discardStage(app)).toBe(false);
    // and a run that finds one just starts over
    git(app, 'worktree', 'add', '--detach', stageDir(app), 'origin/main');
    const r = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    expect(r.to).toBe('1.1.0');
  });

  it('a branch other than updates.branch is refused', SLOW, async () => {
    git(app, 'checkout', '-q', '-b', 'mine');
    const err = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') }).catch((e) => e);
    expect(err.message).toMatch(/on "mine" but the update branch is "main"/);
  });

  it('nothing to do when already newest', SLOW, async () => {
    expect(await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.0.0') })).toMatchObject({ upToDate: true });
  });

  it('roll back resets to the recorded sha, moves node_modules, dist and build back, and forgets the copy; a dirty tree refuses', SLOW, async () => {
    const before = git(app, 'rev-parse', 'HEAD');
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'scratch.txt', 'x');
    const refused = await runRollback({ root: app }).catch((e) => e);
    expect(refused.message).toMatch(/local changes/);
    rmSync(join(app, 'scratch.txt'));
    const r = await runRollback({ root: app });
    expect(r.version).toBe('1.0.0');
    expect(git(app, 'rev-parse', 'HEAD')).toBe(before);
    expect(read(app, 'packages/backend/dist/server.js')).toContain('1.0.0');
    expect(read(app, 'packages/frontend/build/index.html')).toContain('1.0.0');
    expect(read(app, 'node_modules/built.txt')).toBe('1.0.0'); // node_modules is back with the code, with no reinstall
    expect(rollbackInfo(app).available).toBe(false);
  });

  it('roll back reinstalls when the previous node_modules is not in the copy and the lockfile changed (the lockfile is read before the reset)', SLOW, async () => {
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    const rb = readRollback(app);
    // (the previous version had no node_modules at all: the entry is `absent`; a directory the copy LOST is another case, tested below)
    rmSync(join(rb.dir, 'files', 'node_modules'), { recursive: true });
    writeFileSync(join(rb.dir, 'manifest.json'), JSON.stringify({ ...rb.manifest, entries: rb.manifest.entries.map((e) => (e.path === 'node_modules' ? { ...e, kind: 'absent' } : e)) }));
    const lines = [];
    await runRollback({ root: app, log: (l) => lines.push(l) });
    expect(read(app, 'package-lock.json')).toContain('"1.0.0"');
    expect(lines.some((l) => l.includes('npm ci'))).toBe(true);
  });

  it('a failed restart puts the previous version back (rollbackNow with force), node_modules included', SLOW, async () => {
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'during.txt', 'x'); // (a force rollback does not mind: the restart failed, put it back)
    const { rollbackNow } = await import('./updater-core.mjs');
    await rollbackNow({ root: app, force: true });
    expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
  });

  it('a swap that fails keeps the previous rollback copy whole (the new copy is written to .update-rollback.next and dropped)', SLOW, async () => {
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    const kept = readRollback(app);
    const keptManifest = JSON.stringify(kept.manifest);
    expect(read(kept.dir, 'files/node_modules/built.txt')).toBe('1.0.0');
    release('1.2.0');
    const plan = await stageUpdate({ root: app, settings, fetchFn: fakeFetch('1.2.0') });
    const err = await applyStaged({ root: app, plan: { ...plan, toSha: '0000000000000000000000000000000000000000' } }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.restored).toBe(true);
    const after = readRollback(app);
    expect(JSON.stringify(after.manifest)).toBe(keptManifest); // still the 1.0.0 -> 1.1.0 copy, untouched
    expect(read(after.dir, 'files/node_modules/built.txt')).toBe('1.0.0');
    expect(existsSync(rollbackNextRoot(app))).toBe(false);
    expect(read(app, 'node_modules/built.txt')).toBe('1.1.0'); // the running folder is as it was
  });

  it('a swap that succeeds replaces the previous copy only at the end, and leaves no .update-rollback.next', SLOW, async () => {
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    release('1.2.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.2.0') });
    expect(existsSync(rollbackNextRoot(app))).toBe(false);
    expect(readRollback(app).manifest).toMatchObject({ version: '1.1.0', toVersion: '1.2.0', phase: 'swapped' });
  });

  describe('a stage that cannot be removed', () => {
    const ebusy = () => Object.assign(new Error("EBUSY: resource busy or locked, rmdir '.update-stage'"), { code: 'EBUSY' });
    /** An rm that fails `times` times (then removes for real); times = Infinity: it always fails, and the stage is still there afterwards (as if something held it). */
    const flaky = (times) => { let n = 0; const calls = () => n; const fn = async (p, o) => { n++; if (n <= times) { mkdirSync(p, { recursive: true }); write(p, 'held.txt', 'x'); throw ebusy(); } await rm(p, o); }; fn.calls = calls; return fn; };
    const staged = async (v) => { release(v); return stageUpdate({ root: app, settings, fetchFn: fakeFetch(v) }); };

    it('EBUSY twice then success: the swap succeeds, the stage is gone, no marker', SLOW, async () => {
      const plan = await staged('1.1.0');
      const rmFn = flaky(2), lines = [];
      const r = await applyStaged({ root: app, plan, log: (l) => lines.push(l), stageRemoval: { rmFn, retryDelayMs: 1 } });
      expect(r).toMatchObject({ upToDate: false, to: '1.1.0' });
      expect(rmFn.calls()).toBe(3);
      expect(existsSync(stageDir(app))).toBe(false);
      expect(lines.some((l) => l.includes('stage left behind'))).toBe(false);
      expect(read(app, 'node_modules/built.txt')).toBe('1.1.0');
    });

    it('EBUSY always: the swap still succeeds, says so, leaves the marker, and the next boot (discardStage) removes it; the next update starts clean', SLOW, async () => {
      const plan = await staged('1.1.0');
      const lines = [];
      const r = await applyStaged({ root: app, plan, log: (l) => lines.push(l), stageRemoval: { rmFn: flaky(Infinity), retryDelayMs: 1 } });
      expect(r).toMatchObject({ upToDate: false, from: '1.0.0', to: '1.1.0' });
      expect(read(app, 'node_modules/built.txt')).toBe('1.1.0');
      expect(readRollback(app).manifest).toMatchObject({ phase: 'swapped', toVersion: '1.1.0' });
      expect(lines.some((l) => l.includes('stage left behind; it is removed at the next boot'))).toBe(true);
      expect(existsSync(join(stageDir(app), STAGE_LEFT_MARKER))).toBe(true);
      expect(git(app, 'status', '--porcelain')).toBe(''); // (a leftover stage never makes the tree look dirty)
      expect(await discardStage(app)).toBe(true); // boot cleanup
      expect(existsSync(stageDir(app))).toBe(false);
      // and a leftover does not block the next update: stageUpdate removes it first
      mkdirSync(stageDir(app), { recursive: true }); write(stageDir(app), STAGE_LEFT_MARKER, 'x');
      const next = await staged('1.2.0');
      expect(next.to).toBe('1.2.0');
    });

    it('a failed swap whose stage cannot be removed still reports the swap failure (restored), not the removal', SLOW, async () => {
      const plan = await staged('1.1.0');
      const err = await applyStaged({ root: app, plan: { ...plan, toSha: '0000000000000000000000000000000000000000' }, stageRemoval: { rmFn: flaky(Infinity), retryDelayMs: 1 } }).catch((e) => e);
      expect(err).toBeInstanceOf(UpdateError);
      expect(err.restored).toBe(true);
      expect(err.message).not.toMatch(/EBUSY/);
      expect(existsSync(join(stageDir(app), STAGE_LEFT_MARKER))).toBe(true);
    });
  });

  describe('a rollback copy this version cannot act on', () => {
    const rbManifest = () => join(readRollback(app).dir, 'manifest.json');
    const doUpdate = async (v) => { release(v); await runUpdate({ root: app, settings, fetchFn: fakeFetch(v) }); };

    it('a format-2 manifest is not offered as a rollback, rollbackNow refuses it with a reason, and the file is not rewritten', SLOW, async () => {
      await doUpdate('1.1.0');
      const file = rbManifest();
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), format: 2 }));
      const before = readFileSync(file, 'utf-8');
      expect(readRollback(app)).toBe(null);
      expect(rollbackInfo(app).available).toBe(false);
      const err = await rollbackNow({ root: app }).catch((e) => e);
      expect(err).toBeInstanceOf(UpdateError);
      expect(err.message).toMatch(/format 2/);
      expect(readFileSync(file, 'utf-8')).toBe(before);
    });

    it('an update over a recovery_failed main copy is refused (at stageUpdate and at the swap), and the copy is byte-identical afterwards', SLOW, async () => {
      await doUpdate('1.1.0');
      const file = rbManifest();
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), phase: 'recovery_failed' }));
      const before = readFileSync(file, 'utf-8');
      const filesBefore = readdirSync(join(readRollback(app).dir, 'files')).sort();
      release('1.2.0');
      const err = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.2.0') }).catch((e) => e);
      expect(err).toBeInstanceOf(UpdateError);
      expect(err.message).toMatch(/recovery_failed/);
      expect(err.message).toMatch(/--recover/);
      expect(existsSync(stageDir(app))).toBe(false);
      expect(readFileSync(file, 'utf-8')).toBe(before);
      expect(readdirSync(join(readRollback(app).dir, 'files')).sort()).toEqual(filesBefore);
      // the swap itself refuses too (a plan staged before the copy went bad)
      write(stageDir(app), 'package.json', pkg('1.2.0'));
      const sha = git(app, 'rev-parse', 'HEAD');
      const err2 = await applyStaged({ root: app, plan: { upToDate: false, staged: true, from: '1.1.0', to: '1.2.0', mode: 'git', sha, toSha: git(app, 'rev-parse', 'origin/main'), branch: 'main', files: [] } }).catch((e) => e);
      expect(err2.message).toMatch(/recovery_failed/);
      expect(readFileSync(file, 'utf-8')).toBe(before);
    });
  });

  it('already on the target commit with a version that is not newer: no build, no swap, no rollback copy ("already on 1.0.0")', SLOW, async () => {
    const lines = [], states = [];
    const r = await runUpdate({ root: app, settings, force: true, fetchFn: fakeFetch('1.0.0'), log: (l) => lines.push(l), setState: (s) => states.push(s) });
    expect(r).toMatchObject({ upToDate: true, already: true, current: '1.0.0' });
    expect(lines).toContain('already on 1.0.0');
    expect(states).not.toContain('installing');
    expect(rollbackInfo(app).available).toBe(false);
    expect(existsSync(stageDir(app))).toBe(false);
    // the swap itself has the same guard
    const sha = git(app, 'rev-parse', 'HEAD');
    appendFileSync(join(app, '.git', 'info', 'exclude'), '.update-stage/\n');
    write(stageDir(app), 'package.json', pkg('1.0.0'));
    const swapped = await applyStaged({ root: app, plan: { upToDate: false, staged: true, from: '1.0.0', to: '1.0.0', mode: 'git', sha, toSha: sha, branch: 'main', files: [] } });
    expect(swapped).toMatchObject({ upToDate: true, already: true });
    expect(rollbackInfo(app).available).toBe(false);
  });

  describe('a swap cut short (the pre-boot recovery)', () => {
    /** Run a full update, then rewind the folder to what a kill after `kept` renames would have left: the first `kept` moved entries are new, the rest still the
     *  originals, the manifest says `swapping`. `merged`: whether the git merge had run. */
    async function cutAt(kept, { merged = true, manifestFlag = false } = {}) {
      const before = git(app, 'rev-parse', 'HEAD');
      release('1.1.0');
      const r = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
      const rb = readRollback(app);
      const moved = rb.manifest.entries.filter((e) => e.how === 'moved');
      moved.forEach((e, i) => {
        if (i < kept) return;
        e.step = 'pending'; // (the swap had not reached it: the manifest says so)
        if (e.kind === 'dir') { rmSync(join(app, e.path), { recursive: true, force: true }); mkdirSync(dirname(join(app, e.path)), { recursive: true }); copyDir(join(rb.dir, 'files', e.path), join(app, e.path)); rmSync(join(rb.dir, 'files', e.path), { recursive: true, force: true }); }
      });
      if (!merged) git(app, 'reset', '--hard', before);
      // the cut state lives in .update-rollback.next
      rmSync(rollbackNextRoot(app), { recursive: true, force: true });
      mkdirSync(rollbackNextRoot(app), { recursive: true });
      execFileSync('mv', [rb.dir, join(rollbackNextRoot(app), '1.0.0')]);
      rmSync(join(app, '.update-rollback'), { recursive: true, force: true });
      const mf = join(rollbackNextRoot(app), '1.0.0', 'manifest.json');
      writeFileSync(mf, JSON.stringify({ ...rb.manifest, phase: 'swapping', merged: manifestFlag }, null, 2));
      mkdirSync(stageDir(app), { recursive: true });
      return { before, toSha: r.toSha };
    }
    const copyDir = (a, b) => execFileSync('cp', ['-a', a, b]);

    it.each([
      ['after the first rename (node_modules swapped, the rest not)', 1, true],
      ['after dist and build are swapped (every rename done, phase still swapping)', 99, true],
      ['between the merge and the manifest write (HEAD is new, no merged flag, nothing renamed)', 0, true],
      ['before the merge ran (HEAD still the old one)', 0, false],
    ])('%s: the previous version is back, HEAD included, whatever the merged flag says', async (_n, kept, merged) => {
      const { before } = await cutAt(kept, { merged, manifestFlag: false });
      const lines = [];
      expect(await recoverInterruptedSwap(app, (l) => lines.push(l))).toBe(true);
      expect(git(app, 'rev-parse', 'HEAD')).toBe(before);
      expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
      expect(read(app, 'packages/backend/dist/server.js')).toContain('1.0.0');
      expect(read(app, 'packages/frontend/build/index.html')).toContain('1.0.0');
      expect(read(app, 'package.json')).toContain('"1.0.0"');
      expect(existsSync(rollbackNextRoot(app))).toBe(false);
      expect(lines.join('\n')).toMatch(/cut short/);
      expect(takeRecoveryResult(app)).toMatchObject({ outcome: 'restored', phase: 'swapping' }); // the booting app words its job from this
      expect(takeRecoveryResult(app)).toBe(null);
      expect(await recoverInterruptedSwap(app)).toBe(false); // and a second run finds nothing
    });

    it('a cut swap leaves the PREVIOUS rollback copy alone', SLOW, async () => {
      release('1.1.0');
      await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
      const prev = JSON.stringify(readRollback(app).manifest);
      git(app, 'reset', '--hard', 'HEAD'); // (clean)
      const next = join(rollbackNextRoot(app), '1.1.0');
      write(next, 'manifest.json', JSON.stringify({ version: '1.1.0', mode: 'tarball', phase: 'swapping', entries: [] }));
      expect(await recoverInterruptedSwap(app)).toBe(true);
      expect(JSON.stringify(readRollback(app).manifest)).toBe(prev);
    });

    it('a complete swap whose copy was not yet moved over the previous one is finished (promoted)', SLOW, async () => {
      release('1.1.0');
      await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
      const rb = readRollback(app);
      mkdirSync(rollbackNextRoot(app), { recursive: true });
      execFileSync('mv', [rb.dir, join(rollbackNextRoot(app), '1.0.0')]);
      expect(await recoverInterruptedSwap(app)).toBe(false); // (nothing was put back: the swap had succeeded)
      expect(existsSync(rollbackNextRoot(app))).toBe(false);
      expect(readRollback(app).manifest).toMatchObject({ version: '1.0.0', phase: 'swapped' });
      expect(read(app, 'node_modules/built.txt')).toBe('1.1.0');
    });

    it('a .update-rollback.next with no manifest (cut before anything moved) is just removed', async () => {
      mkdirSync(join(rollbackNextRoot(app), '1.0.0', 'files'), { recursive: true });
      expect(await recoverInterruptedSwap(app)).toBe(false);
      expect(existsSync(rollbackNextRoot(app))).toBe(false);
    });
  });

  describe('a roll back is crash-safe', () => {
    it('the current directories go aside first and are deleted only after the manifest says rolled_back', SLOW, async () => {
      release('1.1.0');
      await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
      const rb = readRollback(app);
      const seen = [];
      await rollbackNow({ root: app, force: false, log: (l) => seen.push(l) });
      const m = JSON.parse(readFileSync(join(rb.dir, 'manifest.json'), 'utf-8'));
      expect(m.phase).toBe('rolled_back');
      expect(existsSync(join(rb.dir, 'aside'))).toBe(false); // deleted last
      expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
    });

    it('a crash after the old node_modules is back but before the rest is finished by the recovery (HEAD reset, the other directories put back, copy consumed)', SLOW, async () => {
      const before = git(app, 'rev-parse', 'HEAD');
      release('1.1.0');
      await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
      const rb = readRollback(app);
      // what a roll back looks like part-way: manifest rolling_back, HEAD already reset, node_modules put back with the new one set aside, dist not yet
      const { phase: _p, ...rest } = rb.manifest;
      writeFileSync(join(rb.dir, 'manifest.json'), JSON.stringify({ ...rest, phase: 'rolling_back' }, null, 2));
      mkdirSync(join(rb.dir, 'aside'), { recursive: true });
      renameSync(join(app, 'node_modules'), join(rb.dir, 'aside', 'node_modules'));
      renameSync(join(rb.dir, 'files', 'node_modules'), join(app, 'node_modules'));
      expect(await recoverInterruptedSwap(app)).toBe(true);
      expect(git(app, 'rev-parse', 'HEAD')).toBe(before);
      expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
      expect(read(app, 'packages/backend/dist/server.js')).toContain('1.0.0');
      expect(read(app, 'packages/frontend/build/index.html')).toContain('1.0.0');
      expect(existsSync(join(app, '.update-rollback'))).toBe(false); // a roll back consumes its copy
    });

    it('a crash after the manifest said rolled_back only has the set-aside copies left to delete', SLOW, async () => {
      release('1.1.0');
      await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
      await rollbackNow({ root: app, force: false });
      const rb = readRollback(app);
      mkdirSync(join(rb.dir, 'aside'), { recursive: true });
      write(rb.dir, 'aside/node_modules/leftover', 'x');
      expect(await recoverInterruptedSwap(app)).toBe(false);
      expect(existsSync(join(app, '.update-rollback'))).toBe(false);
      expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
    });
  });

  describe('which repository', () => {
    it('follows origin when only package.json named the repository (a fork\'s clone updates from the fork); refuses when updates.repo disagrees', SLOW, async () => {
      git(app, 'config', 'url.' + origin + '.insteadOf', 'https://github.com/someone/fork.git');
      git(app, 'remote', 'set-url', 'origin', 'https://github.com/someone/fork.git');
      expect(resolveRepo(app, { repo: 'echo/sanctum', explicit: false })).toMatchObject({ repo: 'someone/fork', note: expect.stringContaining('someone/fork') });
      expect(resolveRepo(app, { repo: 'someone/Fork', explicit: true })).toEqual({ repo: 'someone/Fork' });
      const refused = resolveRepo(app, { repo: 'echo/sanctum', explicit: true });
      expect(refused.error).toMatch(/updates\.repo is "echo\/sanctum" but this checkout's origin is "someone\/fork"/);
      release('1.1.0');
      const urls = [];
      const fetchFn = async (url) => { urls.push(String(url)); return fakeFetch('1.1.0')(url); };
      await runUpdate({ root: app, settings: { ...settings, repoExplicit: false }, fetchFn });
      expect(urls[0]).toContain('/someone/fork/');
      const err = await runUpdate({ root: app, settings: { ...settings, repoExplicit: true }, fetchFn, force: true }).catch((e) => e);
      expect(err.message).toMatch(/origin is "someone\/fork"/);
    });
    it('an origin that is not on GitHub (a local path) leaves the settings alone', () => {
      expect(resolveRepo(app, { repo: 'echo/sanctum', explicit: true })).toEqual({ repo: 'echo/sanctum' });
    });
  });

  it('the CLI roll back needs nothing from the app: it runs in a copy with no node_modules at all (no js-yaml), and puts the previous version back', SLOW, async () => {
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'sanctum.yaml', 'updates:\n  branch: main\nagent:\n  cwd: ./home\n');
    git(app, 'add', 'sanctum.yaml'); // (the tracked tree stays clean for the reset)
    git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local settings');
    // a rollback refuses a checkout that moved on, so start from the state the update left: reset the settings commit away
    git(app, 'reset', '-q', '--hard', 'HEAD~1');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    for (const f of ['update.mjs', 'updater-core.mjs', 'boot-recover.mjs']) copyFileSync(join(__dirname, f), join(app, 'scripts', f));
    appendFileSync(join(app, '.git', 'info', 'exclude'), 'scripts/\n'); // (in the real repo scripts/ is tracked)
    rmSync(join(app, 'node_modules'), { recursive: true, force: true }); // js-yaml (and everything else) is gone; the rollback copy holds the old modules
    expect(existsSync(join(app, 'node_modules', 'js-yaml'))).toBe(false);
    const out = execFileSync('node', [join(app, 'scripts', 'update.mjs'), '--rollback'], { cwd: app, encoding: 'utf-8', env: GIT_ENV });
    expect(out).toMatch(/rolled back to 1\.0\.0/);
    expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
    expect(read(app, 'package.json')).toContain('"1.0.0"');
  });
});

describe('downloaded folder (tarball)', () => {
  let app, archive;
  beforeEach(() => {
    app = join(tmp, 'app');
    write(app, 'package.json', pkg('1.0.0')); write(app, 'package-lock.json', lock('1.0.0')); write(app, 'build.js', BUILD_JS);
    write(app, 'companion-home/identity/profile.md', 'Sam likes tea');
    write(app, 'home/notes.md', 'my notes');
    write(app, 'sanctum.yaml', 'identity:\n  companion_name: Echo\n');
    write(app, '.env', 'APP_PASSWORD=secret');
    write(app, 'README.md', 'old readme');
    execFileSync('node', ['build.js'], { cwd: app });
    // The release as GitHub would send it: one top folder, tracked files only.
    const src = join(tmp, 'src', 'sanctum-main');
    write(src, 'package.json', pkg('1.1.0')); write(src, 'package-lock.json', lock('1.1.0')); write(src, 'build.js', BUILD_JS);
    write(src, 'companion-home/identity/profile.md', 'TEMPLATE profile'); write(src, 'companion-home/AGENTS.md', 'template agents');
    write(src, 'home/notes.md', 'TEMPLATE notes'); write(src, 'README.md', 'new readme'); write(src, 'sanctum.yaml', 'OVERWRITE'); write(src, 'docs/NEW.md', 'new doc');
    archive = join(tmp, 'release.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', join(tmp, 'src'), 'sanctum-main']);
  });

  it.skipIf(!selfUpdateSupport(tmpdir()).ok)('with agent.cwd inside the app folder, companion-home and the person\'s files are never overwritten', async () => {
    const r = await runUpdate({ root: app, settings: { ...settings, cwd: '.' }, fetchFn: fakeFetch('1.1.0', archive) });
    expect(r).toMatchObject({ from: '1.0.0', to: '1.1.0', mode: 'tarball' });
    expect(read(app, 'companion-home/identity/profile.md')).toBe('Sam likes tea');
    expect(existsSync(join(app, 'companion-home/AGENTS.md'))).toBe(false);
    expect(read(app, 'sanctum.yaml')).not.toContain('OVERWRITE');
    expect(read(app, '.env')).toBe('APP_PASSWORD=secret');
    expect(read(app, 'README.md')).toBe('new readme');
    expect(read(app, 'docs/NEW.md')).toBe('new doc');
    expect(read(app, 'packages/backend/dist/server.js')).toContain('1.1.0');
    expect(read(app, 'node_modules/built.txt')).toBe('1.1.0');
    expect(existsSync(stageDir(app))).toBe(false);
  });

  it.skipIf(!selfUpdateSupport(tmpdir()).ok)('stages into .update-stage and changes nothing in the app until the swap; the swap moves the staged files in and keeps the replaced ones', async () => {
    const plan = await stageUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0', archive) });
    expect(plan).toMatchObject({ staged: true, mode: 'tarball', to: '1.1.0' });
    expect(plan.files).toContain('README.md');
    expect(plan.files).not.toContain('sanctum.yaml');
    expect(read(app, 'README.md')).toBe('old readme');
    expect(existsSync(join(app, 'docs/NEW.md'))).toBe(false);
    expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
    expect(read(app, 'package.json')).toContain('"1.0.0"');
    expect(read(stageDir(app), 'README.md')).toBe('new readme');
    expect(existsSync(join(stageDir(app), 'sanctum.yaml'))).toBe(false); // the protected files are not staged at all
    expect(existsSync(join(stageDir(app), 'companion-home'))).toBe(false);
    await applyStaged({ root: app, plan });
    expect(read(app, 'README.md')).toBe('new readme');
    expect(read(readRollback(app).dir, 'files/README.md')).toBe('old readme');
    expect(read(readRollback(app).dir, 'files/node_modules/built.txt')).toBe('1.0.0');
    expect(existsSync(stageDir(app))).toBe(false);
  });

  it.skipIf(!selfUpdateSupport(tmpdir()).ok)('a failed build in the stage changes nothing', async () => {
    const src = join(tmp, 'src2', 'sanctum-main');
    write(src, 'package.json', pkg('1.1.0')); write(src, 'package-lock.json', lock('1.1.0')); write(src, 'build.js', "console.error('boom'); process.exit(1);");
    const bad = join(tmp, 'bad.tar.gz');
    execFileSync('tar', ['-czf', bad, '-C', join(tmp, 'src2'), 'sanctum-main']);
    const err = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0', bad) }).catch((e) => e);
    expect(err.message).toMatch(/^npm run build failed/);
    expect(read(app, 'package.json')).toContain('"1.0.0"');
    expect(read(app, 'README.md')).toBe('old readme');
    expect(existsSync(stageDir(app))).toBe(false);
  });

  it('a home folder elsewhere inside the app is protected too', async () => {
    expect(protectedPaths(app, './home')).toEqual(expect.arrayContaining(['companion-home', 'home']));
    const plan = archivePlan(join(tmp, 'src', 'sanctum-main'), app, './home');
    expect(plan.files).not.toContain('home/notes.md');
    expect(plan.files).not.toContain('companion-home/AGENTS.md');
    expect(plan.files).toContain('README.md');
  });

  it('a home that is a symlink inside the app is protected: the real folder is what agent.cwd names, and the archive\'s home/ would write through the link', async () => {
    const real = join(tmp, 'elsewhere', 'echo-home');
    write(real, 'notes.md', 'the real notes');
    rmSync(join(app, 'home'), { recursive: true });
    symlinkSync(real, join(app, 'home'), 'dir'); // <app>/home -> <tmp>/elsewhere/echo-home
    expect(protectedPaths(app, real)).toEqual(expect.arrayContaining(['home']));
    const plan = archivePlan(join(tmp, 'src', 'sanctum-main'), app, real);
    expect(plan.files).not.toContain('home/notes.md');
    expect(plan.skipped).toContain('home/notes.md');
    // the other way round: agent.cwd names the link, which resolves outside the app
    expect(protectedPaths(app, './home')).toEqual(expect.arrayContaining(['home']));
    expect(archivePlan(join(tmp, 'src', 'sanctum-main'), app, './home').files).not.toContain('home/notes.md');
  });

  it('a home folder outside the app is not the archive\'s business: companion-home is the template then', () => {
    const plan = archivePlan(join(tmp, 'src', 'sanctum-main'), app, '/somewhere/else');
    expect(plan.files).toContain('companion-home/AGENTS.md');
    expect(plan.files).not.toContain('sanctum.yaml');
  });

  it.skipIf(!selfUpdateSupport(tmpdir()).ok)('rolling back puts the overwritten files back, removes the ones the archive added, and brings node_modules back', async () => {
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0', archive) });
    await runRollback({ root: app });
    expect(read(app, 'README.md')).toBe('old readme');
    expect(existsSync(join(app, 'docs/NEW.md'))).toBe(false);
    expect(read(app, 'package.json')).toContain('"1.0.0"');
    expect(read(app, 'packages/backend/dist/server.js')).toContain('1.0.0');
    expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
  });
});

describe('rollback copy', () => {
  it('a copy-only rollback copy holds the named entries with a manifest, and only the latest is kept', async () => {
    const root = join(tmp, 'app');
    write(root, 'package.json', pkg('1.0.0')); write(root, 'package-lock.json', lock('1.0.0'));
    write(root, 'packages/backend/dist/server.js', 'b'); write(root, 'packages/shared/dist/index.js', 's');
    const m = await makeRollbackCopy({ root, version: '1.0.0', mode: 'git', branch: 'main', sha: 'abc123', entries: ['package.json', 'packages/backend/dist', 'packages/frontend/build'] });
    expect(m.entries.map((e) => e.path)).toEqual(['package.json', 'packages/backend/dist', 'packages/frontend/build']);
    expect(m.entries.find((e) => e.path === 'packages/backend/dist').kind).toBe('dir');
    expect(m.entries.find((e) => e.path === 'packages/frontend/build').kind).toBe('absent');
    expect(m).toMatchObject({ version: '1.0.0', mode: 'git', sha: 'abc123' });
    expect(JSON.parse(readFileSync(join(root, '.update-rollback', '1.0.0', 'manifest.json'), 'utf-8')).entries.length).toBe(3);
    await makeRollbackCopy({ root, version: '1.0.1', mode: 'git', branch: 'main', sha: 'def', entries: ['package.json'] });
    expect(readdirSync(join(root, '.update-rollback'))).toEqual(['1.0.1']);
    clearRollback(root);
    expect(rollbackInfo(root).available).toBe(false);
  });

  it('a swap the process died in the middle of (phase swapping) is put back at boot, a finished one is left alone', async () => {
    const root = join(tmp, 'app');
    write(root, 'packages/backend/dist/server.js', 'NEW'); write(root, 'node_modules/built.txt', 'NEW-MODULES');
    const dir = join(root, '.update-rollback', '1.0.0');
    write(dir, 'files/packages/backend/dist/server.js', 'OLD'); // moved out already; node_modules not yet
    const entries = [{ path: 'packages/backend/dist', kind: 'dir', how: 'moved' }, { path: 'node_modules', kind: 'dir', how: 'moved' }];
    write(dir, 'manifest.json', JSON.stringify({ version: '1.0.0', mode: 'tarball', phase: 'swapping', entries }));
    expect(await recoverInterruptedSwap(root)).toBe(true);
    expect(read(root, 'packages/backend/dist/server.js')).toBe('OLD');
    expect(read(root, 'node_modules/built.txt')).toBe('NEW-MODULES'); // still the original: it had not been moved yet
    expect(existsSync(join(root, '.update-rollback'))).toBe(false);
    write(dir, 'manifest.json', JSON.stringify({ version: '1.0.0', mode: 'tarball', phase: 'swapped', entries }));
    expect(await recoverInterruptedSwap(root)).toBe(false);
  });
});

describe('settings without js-yaml', () => {
  it('miniYaml reads the nested scalars the updater needs', () => {
    expect(miniYaml('updates:\n  repo: "echo/sanctum"   # mine\n  branch: dev\nagent:\n  cwd: ./home\n  other:\n    x: 1\nserver:\n  db_path: ./data/x.db\n# c\n'))
      .toEqual({ updates: { repo: 'echo/sanctum', branch: 'dev' }, agent: { cwd: './home', other: { x: '1' } }, server: { db_path: './data/x.db' } });
  });
  it('a copy of the core with no node_modules beside it (no js-yaml) still reads updates.*, agent.cwd and server.db_path', async () => {
    const lonely = join(tmp, 'lonely');
    mkdirSync(join(lonely, 'scripts'), { recursive: true });
    copyFileSync(join(__dirname, 'updater-core.mjs'), join(lonely, 'scripts', 'updater-core.mjs'));
    copyFileSync(join(__dirname, 'boot-recover.mjs'), join(lonely, 'scripts', 'boot-recover.mjs'));
    write(lonely, 'package.json', pkg('1.0.0').replace('{', '{"repository":"github:echo/sanctum",'));
    write(lonely, 'sanctum.yaml', 'updates:\n  branch: stable\nagent:\n  cwd: ./home\nserver:\n  db_path: ./var/x.db\n');
    const core = await import(pathToFileURL(join(lonely, 'scripts', 'updater-core.mjs')).href);
    expect(await core.readUpdateSettings(lonely)).toMatchObject({ repo: 'echo/sanctum', branch: 'stable', cwd: './home', dbPath: './var/x.db', repoExplicit: false });
  });
});

describe('build children are their own process group', () => {
  it('killProcessGroup (posix) signals the whole group (-pid), falling back to the pid', () => {
    const calls = [];
    expect(killProcessGroup(4242, 'SIGTERM', (...a) => { calls.push(a); }, 'linux')).toBe(true);
    expect(calls).toEqual([[-4242, 'SIGTERM']]);
    const again = [];
    expect(killProcessGroup(4242, 'SIGKILL', (pid, sig) => { again.push([pid, sig]); if (pid < 0) throw new Error('ESRCH'); }, 'linux')).toBe(true);
    expect(again).toEqual([[-4242, 'SIGKILL'], [4242, 'SIGKILL']]);
    expect(killProcessGroup(0)).toBe(false);
  });

  it('killProcessGroup on Windows never sends a negative pid: `taskkill /PID <pid> /T /F`, and process.kill(pid) when that fails', () => {
    const calls = [], tk = [];
    expect(killProcessGroup(4242, 'SIGTERM', (...a) => { calls.push(a); }, 'win32', (pid) => { tk.push(pid); return { status: 0 }; })).toBe(true);
    expect(tk).toEqual([4242]);
    expect(calls).toEqual([]); // taskkill took the tree
    expect(killProcessGroup(4242, 'SIGKILL', (...a) => { calls.push(a); }, 'win32', () => ({ status: 128 }))).toBe(true); // (taskkill found nothing / is missing)
    expect(killProcessGroup(4242, 'SIGKILL', (...a) => { calls.push(a); }, 'win32', () => { throw new Error('ENOENT'); })).toBe(true);
    expect(calls).toEqual([[4242], [4242]]);
    expect(calls.flat().every((n) => n > 0)).toBe(true);
    expect(killProcessGroup(4242, 'SIGKILL', () => { throw new Error('ESRCH'); }, 'win32', () => ({ status: 1 }))).toBe(false);
  });

  it('the default platform is this one: on Windows the real function uses taskkill, elsewhere the group', () => {
    const calls = [];
    killProcessGroup(4242, 'SIGTERM', (...a) => { calls.push(a); }, undefined, () => ({ status: 1 }));
    expect(calls).toEqual(process.platform === 'win32' ? [[4242]] : [[-4242, 'SIGTERM']]);
  });

  it.skipIf(process.platform === 'win32')('aborting a run kills the child AND its grandchildren (the npm -> node -> tsc chain)', async () => {
    const ac = new AbortController();
    const seen = [];
    const done = run('sh', ['-c', 'sleep 60 & echo grandchild:$!; wait'], { log: (l) => seen.push(l), signal: ac.signal });
    for (let i = 0; i < 100 && !seen.some((l) => l.startsWith('grandchild:')); i++) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(seen.find((l) => l.startsWith('grandchild:')).split(':')[1]);
    expect(() => process.kill(pid, 0)).not.toThrow(); // running
    ac.abort();
    await done;
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 20)); }
    expect(() => process.kill(pid, 0)).toThrow(); // gone with the group
  });

  it.skipIf(process.platform === 'win32')('killAllChildren (shutdown) stops every build child the process started', async () => {
    const seen = [];
    const done = run('sh', ['-c', 'sleep 60 & echo gc:$!; wait'], { log: (l) => seen.push(l) });
    for (let i = 0; i < 100 && !seen.some((l) => l.startsWith('gc:')); i++) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(seen[0].split(':')[1]);
    killAllChildren();
    await done;
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 20)); }
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.skipIf(process.platform !== 'linux')('boot cleanup does not kill a pid whose start time differs (a number reused after a reboot), nor a bare pid with no start time', async () => {
    const app = join(tmp, 'app');
    write(app, 'package.json', pkg('1.0.0'));
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    bystander.unref();
    write(stageDir(app), '.pgids', `${bystander.pid} ${Number(procStartTime(bystander.pid)) + 12345}\n${bystander.pid}\n${bystander.pid} -\n`);
    await discardStage(app);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(bystander.pid, 0)).not.toThrow(); // still running
    process.kill(bystander.pid, 'SIGKILL');
    expect(existsSync(stageDir(app))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('a symlinked .update-stage is never followed: discardStage leaves it and what it points at alone, and stageUpdate refuses it', async () => {
    const app = join(tmp, 'app');
    write(app, 'package.json', pkg('1.0.0'));
    const outside = join(tmp, 'outside');
    write(outside, 'precious.txt', 'keep');
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    bystander.unref();
    write(outside, '.pgids', `${bystander.pid} ${procStartTime(bystander.pid)}\n`); // (a pid file a link would have us read)
    symlinkSync(outside, stageDir(app));
    expect(await discardStage(app)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(bystander.pid, 0)).not.toThrow(); // nothing was read through the link
    expect(read(outside, 'precious.txt')).toBe('keep');
    const err = await stageUpdate({ root: app, settings, fetchFn: fakeFetch('9.9.9') }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.message).toMatch(/symbolic link/);
    expect(read(outside, 'precious.txt')).toBe('keep');
    process.kill(bystander.pid, 'SIGKILL');
  });

  it.skipIf(process.platform !== 'linux')('boot cleanup kills a build a SIGKILLed run left running (its group is in the stage\'s .pgids) and removes the stage', async () => {
    const app = join(tmp, 'app');
    write(app, 'package.json', pkg('1.0.0'));
    const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    orphan.unref();
    write(stageDir(app), '.pgids', `${orphan.pid} ${procStartTime(orphan.pid)}\n`); // (pid and start time: a bare pid proves nothing after a reboot)
    expect(() => process.kill(orphan.pid, 0)).not.toThrow();
    expect(await discardStage(app)).toBe(true);
    for (let i = 0; i < 100; i++) { try { process.kill(orphan.pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 20)); }
    expect(() => process.kill(orphan.pid, 0)).toThrow();
    expect(existsSync(stageDir(app))).toBe(false);
  });
});

describe('the reason a failed step gives', () => {
  it('prefers the first error-looking line of the last 60 (npm warnings skipped) and the two after it', () => {
    const lines = ['npm warn deprecated left-pad@1.0.0: no', 'added 10 packages', 'src/a.ts(3,1): error TS2304: Cannot find name x', '  at line 3', 'Found 1 error.', 'npm ERR! code 1', 'npm warn something', 'more noise', 'last'];
    expect(errorTail(lines)).toEqual(['src/a.ts(3,1): error TS2304: Cannot find name x', '  at line 3', 'Found 1 error.']);
  });
  it('an npm warning that mentions "error" is not picked', () => {
    expect(errorTail(['npm warn error handling is deprecated', 'ok', 'fine'])).toEqual(['npm warn error handling is deprecated', 'ok', 'fine']); // (no real error line: the last three)
    expect(errorTail(['npm warn error handling is deprecated', 'a', 'b', 'c', 'Error: ENOENT: no such file', 'x'])).toEqual(['Error: ENOENT: no such file', 'x']);
  });
  it('without an error-looking line: the last three lines; only the last 60 are looked at', () => {
    expect(errorTail(['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd']);
    const old = ['error: at the very start', ...Array.from({ length: 70 }, (_, i) => `line ${i}`)];
    expect(errorTail(old)).toEqual(['line 67', 'line 68', 'line 69']);
  });
});
