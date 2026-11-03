// The update steps (scripts/updater-core.mjs) against a fake repo in a temp folder: no network (GitHub is a stub), no real app.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  UpdateError, archivePlan, clearRollback, makeRollbackCopy, protectedPaths, readRollback, rollbackInfo, runRollback, runUpdate, selfUpdateSupport,
} from './updater-core.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Sam', GIT_AUTHOR_EMAIL: 'sam@example.test', GIT_COMMITTER_NAME: 'Sam', GIT_COMMITTER_EMAIL: 'sam@example.test', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();

const BUILD_JS = `
const fs = require('fs'), path = require('path');
if (fs.existsSync('FAIL_BUILD')) { console.error('boom: the build is broken'); process.exit(1); }
const v = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version;
for (const [f, body] of [['packages/backend/dist/server.js', '// backend ' + v], ['packages/shared/dist/index.js', '// shared ' + v], ['packages/frontend/build/index.html', '<p>' + v + '</p>']]) {
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
  let origin, app, data;
  function release(v, extra = {}) {
    write(origin, 'package.json', pkg(v)); write(origin, 'package-lock.json', lock(v)); write(origin, 'build.js', BUILD_JS);
    for (const [k, body] of Object.entries(extra)) write(origin, k, body);
    git(origin, 'add', '-A'); git(origin, '-c', 'commit.gpgsign=false', 'commit', '-m', `release ${v}`);
  }
  beforeEach(() => {
    origin = join(tmp, 'origin'); app = join(tmp, 'app'); data = join(app, 'data');
    mkdirSync(origin);
    git(origin, 'init', '-b', 'main');
    write(origin, '.gitignore', 'dist/\nbuild/\nnode_modules/\ndata/\n');
    release('1.0.0');
    git(tmp, 'clone', '-q', origin, app);
    execFileSync('node', ['build.js'], { cwd: app }); // the installed build
  });

  it('a clean tree updates, records the previous sha, builds, and keeps a rollback copy', async () => {
    const before = git(app, 'rev-parse', 'HEAD');
    release('1.1.0');
    const states = [], lines = [];
    const r = await runUpdate({ root: app, dataDir: data, settings, fetchFn: fakeFetch('1.1.0'), setState: (s) => states.push(s), log: (l) => lines.push(l) });
    expect(r).toMatchObject({ upToDate: false, from: '1.0.0', to: '1.1.0', mode: 'git', sha: before });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(r.toSha);
    expect(states).toEqual(['checking', 'fetching', 'installing', 'building']);
    expect(read(app, 'packages/backend/dist/server.js')).toContain('1.1.0');
    expect(lines.some((l) => l.includes('npm ci'))).toBe(true);
    const info = rollbackInfo(data);
    expect(info).toMatchObject({ available: true, version: '1.0.0', mode: 'git' });
    expect(readRollback(data).manifest).toMatchObject({ sha: before, toSha: r.toSha, toVersion: '1.1.0' });
  });

  it('says so when the release has no lockfile and falls back to npm install', async () => {
    release('1.1.0');
    git(origin, 'rm', '-q', 'package-lock.json'); git(origin, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'drop the lockfile');
    const lines = [];
    await runUpdate({ root: app, dataDir: data, settings, fetchFn: fakeFetch('1.1.0'), log: (l) => lines.push(l) });
    expect(lines.some((l) => /no package-lock\.json: falling back to npm install/.test(l))).toBe(true);
  });

  it('a dirty tree is refused with the list, and nothing changes', async () => {
    release('1.1.0');
    write(app, 'notes.txt', 'mine'); write(app, 'build.js', BUILD_JS + '\n// edited');
    const before = git(app, 'rev-parse', 'HEAD');
    const err = await runUpdate({ root: app, dataDir: data, settings, fetchFn: fakeFetch('1.1.0') }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.dirty).toEqual(expect.arrayContaining(['?? notes.txt', ' M build.js']));
    expect(err.message).toContain('notes.txt');
    expect(git(app, 'rev-parse', 'HEAD')).toBe(before);
    expect(read(app, 'notes.txt')).toBe('mine');
    expect(existsSync(join(data, 'update-rollback'))).toBe(false);
  });

  it('a failed build puts dist, build, the lockfile and the commit back', async () => {
    const before = git(app, 'rev-parse', 'HEAD');
    const dist = read(app, 'packages/backend/dist/server.js'), page = read(app, 'packages/frontend/build/index.html'), lockBefore = read(app, 'package-lock.json');
    release('1.1.0', { FAIL_BUILD: 'x' });
    const lines = [];
    const err = await runUpdate({ root: app, dataDir: data, settings, fetchFn: fakeFetch('1.1.0'), log: (l) => lines.push(l) }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.restored).toBe(true);
    expect(err.message).toMatch(/npm run build failed/);
    expect(lines.some((l) => l.includes('boom'))).toBe(true);
    expect(git(app, 'rev-parse', 'HEAD')).toBe(before);
    expect(read(app, 'packages/backend/dist/server.js')).toBe(dist);
    expect(read(app, 'packages/frontend/build/index.html')).toBe(page);
    expect(read(app, 'package-lock.json')).toBe(lockBefore);
    expect(read(app, 'package.json')).toContain('"1.0.0"');
    expect(existsSync(join(app, 'FAIL_BUILD'))).toBe(false);
  });

  it('a branch other than updates.branch is refused', async () => {
    git(app, 'checkout', '-q', '-b', 'mine');
    const err = await runUpdate({ root: app, dataDir: data, settings, fetchFn: fakeFetch('1.1.0') }).catch((e) => e);
    expect(err.message).toMatch(/on "mine" but the update branch is "main"/);
  });

  it('nothing to do when already newest', async () => {
    expect(await runUpdate({ root: app, dataDir: data, settings, fetchFn: fakeFetch('1.0.0') })).toMatchObject({ upToDate: true });
  });

  it('roll back resets to the recorded sha, restores the files, and forgets the copy; a dirty tree refuses', async () => {
    const before = git(app, 'rev-parse', 'HEAD');
    release('1.1.0');
    await runUpdate({ root: app, dataDir: data, settings, fetchFn: fakeFetch('1.1.0') });
    write(app, 'scratch.txt', 'x');
    const refused = await runRollback({ root: app, dataDir: data }).catch((e) => e);
    expect(refused.message).toMatch(/local changes/);
    rmSync(join(app, 'scratch.txt'));
    const r = await runRollback({ root: app, dataDir: data });
    expect(r.version).toBe('1.0.0');
    expect(git(app, 'rev-parse', 'HEAD')).toBe(before);
    expect(read(app, 'packages/backend/dist/server.js')).toContain('1.0.0');
    expect(rollbackInfo(data).available).toBe(false);
  });
});

describe('downloaded folder (tarball)', () => {
  let app, data, archive;
  beforeEach(() => {
    app = join(tmp, 'app'); data = join(app, 'data');
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
    const r = await runUpdate({ root: app, dataDir: data, settings: { ...settings, cwd: '.' }, fetchFn: fakeFetch('1.1.0', archive) });
    expect(r).toMatchObject({ from: '1.0.0', to: '1.1.0', mode: 'tarball' });
    expect(read(app, 'companion-home/identity/profile.md')).toBe('Sam likes tea');
    expect(existsSync(join(app, 'companion-home/AGENTS.md'))).toBe(false);
    expect(read(app, 'sanctum.yaml')).not.toContain('OVERWRITE');
    expect(read(app, '.env')).toBe('APP_PASSWORD=secret');
    expect(read(app, 'README.md')).toBe('new readme');
    expect(read(app, 'docs/NEW.md')).toBe('new doc');
    expect(read(app, 'packages/backend/dist/server.js')).toContain('1.1.0');
  });

  it('a home folder elsewhere inside the app is protected too', async () => {
    expect(protectedPaths(app, './home')).toEqual(expect.arrayContaining(['companion-home', 'home']));
    const plan = archivePlan(join(tmp, 'src', 'sanctum-main'), app, './home');
    expect(plan.files).not.toContain('home/notes.md');
    expect(plan.files).not.toContain('companion-home/AGENTS.md');
    expect(plan.files).toContain('README.md');
  });

  it('a home folder outside the app is not the archive\'s business: companion-home is the template then', () => {
    const plan = archivePlan(join(tmp, 'src', 'sanctum-main'), app, '/somewhere/else');
    expect(plan.files).toContain('companion-home/AGENTS.md');
    expect(plan.files).not.toContain('sanctum.yaml');
  });

  it.skipIf(!selfUpdateSupport(tmpdir()).ok)('rolling back puts the overwritten files back and removes the ones the archive added', async () => {
    await runUpdate({ root: app, dataDir: data, settings, fetchFn: fakeFetch('1.1.0', archive) });
    await runRollback({ root: app, dataDir: data });
    expect(read(app, 'README.md')).toBe('old readme');
    expect(existsSync(join(app, 'docs/NEW.md'))).toBe(false);
    expect(read(app, 'package.json')).toContain('"1.0.0"');
    expect(read(app, 'packages/backend/dist/server.js')).toContain('1.0.0');
  });
});

describe('rollback copy', () => {
  it('holds package.json, the lockfile, every dist and the frontend build, with a manifest, and only the latest is kept', () => {
    const root = join(tmp, 'app'), data = join(tmp, 'data');
    write(root, 'package.json', pkg('1.0.0')); write(root, 'package-lock.json', lock('1.0.0'));
    write(root, 'packages/backend/dist/server.js', 'b'); write(root, 'packages/shared/dist/index.js', 's'); write(root, 'packages/frontend/build/index.html', 'f');
    const m = makeRollbackCopy({ root, dataDir: data, version: '1.0.0', mode: 'git', branch: 'main', sha: 'abc123' });
    const paths = m.entries.map((e) => e.path).sort();
    expect(paths).toEqual(['package-lock.json', 'package.json', 'packages/backend/dist', 'packages/frontend/build', 'packages/frontend/dist', 'packages/shared/dist']); // (the frontend has no dist: recorded as absent)
    expect(m.entries.find((e) => e.path === 'packages/backend/dist').kind).toBe('dir');
    expect(m).toMatchObject({ version: '1.0.0', mode: 'git', sha: 'abc123' });
    expect(JSON.parse(readFileSync(join(data, 'update-rollback', '1.0.0', 'manifest.json'), 'utf-8')).entries.length).toBe(m.entries.length);
    expect(read(join(data, 'update-rollback', '1.0.0', 'files'), 'packages/shared/dist/index.js')).toBe('s');
    makeRollbackCopy({ root, dataDir: data, version: '1.0.1', mode: 'git', branch: 'main', sha: 'def' });
    expect(readdirSync(join(data, 'update-rollback'))).toEqual(['1.0.1']);
    clearRollback(data);
    expect(rollbackInfo(data).available).toBe(false);
  });
});
