// The update steps (scripts/updater-core.mjs) against a fake repo in a temp folder: no network (GitHub is a stub), no real app.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UpdateError, applyStaged, archivePlan, clearRollback, discardStage, killAllChildren, killProcessGroup, makeRollbackCopy, miniYaml, protectedPaths, readRollback,
  recoverInterruptedSwap, resolveRepo, rollbackInfo, run, runRollback, runUpdate, selfUpdateSupport, stageDir, stageUpdate,
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

let tmp;
const settings = { repo: 'echo/sanctum', branch: 'main', cwd: '.', dbPath: './data/sanctum.db' };
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'updater-core-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

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

  it('a clean tree updates through the stage, records the previous sha, builds, and keeps the previous node_modules and builds in .update-rollback', async () => {
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

  it('nothing in the running folder changes until the swap: not HEAD, node_modules, dist, build, the lockfile, or git status', async () => {
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

  it('the swap checks the tree again: a file edited while the build ran refuses it, with the list, and nothing moves', async () => {
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

  it('the swap refuses a checkout that moved on while the build ran', async () => {
    release('1.1.0');
    const plan = await stageUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'mine.txt', 'x'); git(app, 'add', 'mine.txt'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'my own commit');
    const err = await applyStaged({ root: app, plan }).catch((e) => e);
    expect(err.message).toMatch(/moved on while the update was built/);
    expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
  });

  it('says so when the release has no lockfile and falls back to npm install', async () => {
    release('1.1.0');
    git(origin, 'rm', '-q', 'package-lock.json'); git(origin, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'drop the lockfile');
    const lines = [];
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0'), log: (l) => lines.push(l) });
    expect(lines.some((l) => /no package-lock\.json: falling back to npm install/.test(l))).toBe(true);
  });

  it('a dirty tree is refused with the list, and nothing changes', async () => {
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

  it('a failed build leaves the running folder exactly as it was (nothing to restore), deletes the stage, and says why', async () => {
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

  it('a stage a killed run left behind is deleted by the next run (and by discardStage at boot), worktree entry included', async () => {
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

  it('a branch other than updates.branch is refused', async () => {
    git(app, 'checkout', '-q', '-b', 'mine');
    const err = await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') }).catch((e) => e);
    expect(err.message).toMatch(/on "mine" but the update branch is "main"/);
  });

  it('nothing to do when already newest', async () => {
    expect(await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.0.0') })).toMatchObject({ upToDate: true });
  });

  it('roll back resets to the recorded sha, moves node_modules, dist and build back, and forgets the copy; a dirty tree refuses', async () => {
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

  it('roll back reinstalls when the previous node_modules is not in the copy and the lockfile changed (the lockfile is read before the reset)', async () => {
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    const rb = readRollback(app);
    rmSync(join(rb.dir, 'files', 'node_modules'), { recursive: true });
    const lines = [];
    await runRollback({ root: app, log: (l) => lines.push(l) });
    expect(read(app, 'package-lock.json')).toContain('"1.0.0"');
    expect(lines.some((l) => l.includes('npm ci'))).toBe(true);
  });

  it('a failed restart puts the previous version back (rollbackNow with force), node_modules included', async () => {
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'during.txt', 'x'); // (a force rollback does not mind: the restart failed, put it back)
    const { rollbackNow } = await import('./updater-core.mjs');
    await rollbackNow({ root: app, force: true });
    expect(read(app, 'node_modules/built.txt')).toBe('1.0.0');
  });

  describe('which repository', () => {
    it('follows origin when only package.json named the repository (a fork\'s clone updates from the fork); refuses when updates.repo disagrees', async () => {
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

  it('the CLI roll back needs nothing from the app: it runs in a copy with no node_modules at all (no js-yaml), and puts the previous version back', async () => {
    release('1.1.0');
    await runUpdate({ root: app, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'sanctum.yaml', 'updates:\n  branch: main\nagent:\n  cwd: ./home\n');
    git(app, 'add', 'sanctum.yaml'); // (the tracked tree stays clean for the reset)
    git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local settings');
    // a rollback refuses a checkout that moved on, so start from the state the update left: reset the settings commit away
    git(app, 'reset', '-q', '--hard', 'HEAD~1');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    for (const f of ['update.mjs', 'updater-core.mjs']) copyFileSync(join(__dirname, f), join(app, 'scripts', f));
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
    write(lonely, 'package.json', pkg('1.0.0').replace('{', '{"repository":"github:echo/sanctum",'));
    write(lonely, 'sanctum.yaml', 'updates:\n  branch: stable\nagent:\n  cwd: ./home\nserver:\n  db_path: ./var/x.db\n');
    const core = await import(pathToFileURL(join(lonely, 'scripts', 'updater-core.mjs')).href);
    expect(await core.readUpdateSettings(lonely)).toMatchObject({ repo: 'echo/sanctum', branch: 'stable', cwd: './home', dbPath: './var/x.db', repoExplicit: false });
  });
});

describe('build children are their own process group', () => {
  it('killProcessGroup signals the whole group (-pid), falling back to the pid', () => {
    const calls = [];
    expect(killProcessGroup(4242, 'SIGTERM', (...a) => { calls.push(a); })).toBe(true);
    expect(calls).toEqual([[-4242, 'SIGTERM']]);
    const again = [];
    expect(killProcessGroup(4242, 'SIGKILL', (pid, sig) => { again.push([pid, sig]); if (pid < 0) throw new Error('ESRCH'); })).toBe(true);
    expect(again).toEqual([[-4242, 'SIGKILL'], [4242, 'SIGKILL']]);
    expect(killProcessGroup(0)).toBe(false);
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

  it.skipIf(process.platform !== 'linux')('boot cleanup kills a build a SIGKILLed run left running (its group is in the stage\'s .pgids) and removes the stage', async () => {
    const app = join(tmp, 'app');
    write(app, 'package.json', pkg('1.0.0'));
    const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    orphan.unref();
    write(stageDir(app), '.pgids', `${orphan.pid}\n`);
    expect(() => process.kill(orphan.pid, 0)).not.toThrow();
    expect(await discardStage(app)).toBe(true);
    for (let i = 0; i < 100; i++) { try { process.kill(orphan.pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 20)); }
    expect(() => process.kill(orphan.pid, 0)).toThrow();
    expect(existsSync(stageDir(app))).toBe(false);
  });
});
