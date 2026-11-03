// The pre-boot recovery (src/update-recover.ts), run for real as the first import of a stand-in server in a scratch copy of the layout, over a folder a swap was
// cut short in. The process that SERVES (the stand-in prints what it sees at the moment it starts serving) must be the OLD version: the old HEAD, the old build id
// and the old node_modules, and never the new ones, for each place the swap can be killed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
/** tsx from the nearest node_modules above the repository (a worktree has none of its own). */
function findTsx(): string {
  for (let d = repoRoot; ; d = dirname(d)) {
    const p = join(d, 'node_modules', '.bin', 'tsx');
    if (existsSync(p)) return p;
    if (dirname(d) === d) throw new Error('tsx not found');
  }
}
const tsx = findTsx();
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Sam', GIT_AUTHOR_EMAIL: 'sam@example.test', GIT_COMMITTER_NAME: 'Sam', GIT_COMMITTER_EMAIL: 'sam@example.test', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();
const put = (root: string, rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf-8');

// What the stand-in "server" does after its first import: report what is on disk when it would start serving.
const SERVER = `
import './update-recover.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
console.log('SERVING ' + JSON.stringify({
  version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version, head,
  buildId: readFileSync(join(root, 'packages/frontend/build/build-id.txt'), 'utf-8'),
  modules: readFileSync(join(root, 'node_modules/built.txt'), 'utf-8'), reexeced: process.env.SANCTUM_RECOVER_REEXEC ?? null,
}));
`;

let app: string, oldSha: string, newSha: string;
beforeEach(() => {
  app = mkdtempSync(join(tmpdir(), 'update-recover-'));
  mkdirSync(join(app, 'packages', 'backend', 'src'), { recursive: true });
  mkdirSync(join(app, 'scripts'), { recursive: true });
  copyFileSync(join(here, 'update-recover.ts'), join(app, 'packages', 'backend', 'src', 'update-recover.ts'));
  copyFileSync(join(repoRoot, 'scripts', 'updater-core.mjs'), join(app, 'scripts', 'updater-core.mjs'));
  writeFileSync(join(app, 'packages', 'backend', 'src', 'server.ts'), SERVER);
  writeFileSync(join(app, 'packages', 'backend', 'package.json'), '{"type":"module"}');
  git(app, 'init', '-q', '-b', 'main');
  writeFileSync(join(app, '.gitignore'), 'node_modules/\ndist/\nbuild/\n.update-stage/\n.update-rollback/\n.update-rollback.next/\n');
  put(app, 'package.json', '{"name":"fake","version":"1.0.0"}');
  git(app, 'add', '-A'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'one');
  oldSha = git(app, 'rev-parse', 'HEAD');
  put(app, 'package.json', '{"name":"fake","version":"1.1.0"}');
  git(app, 'add', '-A'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'two');
  newSha = git(app, 'rev-parse', 'HEAD');
});
afterEach(() => { rmSync(app, { recursive: true, force: true }); });

/** The folder as a swap killed at `point` leaves it. HEAD is the NEW commit unless the merge had not run. */
function cutSwap(point: 'first-rename' | 'dist-and-build' | 'merge-no-manifest' | 'before-merge') {
  const dir = join(app, '.update-rollback.next', '1.0.0');
  const entries = [
    { path: 'node_modules', kind: 'dir', how: 'moved' },
    { path: 'packages/frontend/build', kind: 'dir', how: 'moved' },
  ];
  const orig = (rel: string, body: string) => put(dir, `files/${rel}`, body);
  const live = (rel: string, body: string) => put(app, rel, body);
  if (point === 'first-rename') {
    live('node_modules/built.txt', 'NEW-MODULES'); orig('node_modules/built.txt', 'OLD-MODULES');
    live('packages/frontend/build/build-id.txt', 'OLD-BUILD'); // not yet moved
  } else if (point === 'dist-and-build') {
    live('node_modules/built.txt', 'NEW-MODULES'); orig('node_modules/built.txt', 'OLD-MODULES');
    live('packages/frontend/build/build-id.txt', 'NEW-BUILD'); orig('packages/frontend/build/build-id.txt', 'OLD-BUILD');
  } else {
    live('node_modules/built.txt', 'OLD-MODULES'); live('packages/frontend/build/build-id.txt', 'OLD-BUILD'); // nothing renamed
  }
  put(dir, 'manifest.json', JSON.stringify({ version: '1.0.0', mode: 'git', sha: oldSha, toSha: newSha, phase: 'swapping', merged: false, entries }));
  if (point === 'before-merge') git(app, 'reset', '-q', '--hard', oldSha);
  mkdirSync(join(app, '.update-stage'), { recursive: true });
}
const serve = (env: Record<string, string> = {}) => spawnSync(tsx, [join(app, 'packages', 'backend', 'src', 'server.ts')], { cwd: app, encoding: 'utf-8', env: { ...process.env, ...env }, timeout: 60_000 });
const served = (out: string) => JSON.parse(/SERVING (.*)/.exec(out)![1]);

describe('the pre-boot recovery', () => {
  it.each([
    ['after the first rename', 'first-rename'],
    ['after dist and build are swapped', 'dist-and-build'],
    ['between the merge and the manifest write (HEAD is new; the manifest has no merged flag)', 'merge-no-manifest'],
    ['before the merge ran', 'before-merge'],
  ] as const)('killed %s: the process that serves is the old version (old HEAD, old build id, old node_modules)', (_n, point) => {
    cutSwap(point);
    if (point !== 'before-merge') expect(git(app, 'rev-parse', 'HEAD')).toBe(newSha); // the cut left the NEW code checked out
    const r = serve();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[update-recover\] a swap was cut short/);
    expect(r.stdout).toMatch(/starting the app again from it/);
    expect(served(r.stdout)).toEqual({ version: '1.0.0', head: oldSha, buildId: 'OLD-BUILD', modules: 'OLD-MODULES', reexeced: null }); // (the child clears the re-exec flag at start; the two log lines above show it was the re-exec that served)
    expect(r.stdout.match(/SERVING/g)).toHaveLength(1); // the first process never got as far as serving: only its re-exec did
    expect(existsSync(join(app, '.update-rollback.next'))).toBe(false);
    // and the next start finds nothing to do and serves directly
    const again = serve();
    expect(again.stdout).not.toMatch(/update-recover/);
    expect(served(again.stdout)).toMatchObject({ version: '1.0.0', head: oldSha, reexeced: null });
  });

  it('under a supervisor it exits 75 after the restore (so pm2 starts it again) and serves nothing itself', () => {
    cutSwap('first-rename');
    const r = serve({ SANCTUM_SUPERVISED: '1' });
    expect(r.status).toBe(75);
    expect(r.stdout).not.toMatch(/SERVING/);
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES');
    expect(git(app, 'rev-parse', 'HEAD')).toBe(oldSha);
    const next = serve({ SANCTUM_SUPERVISED: '1' }); // the supervisor's second start
    expect(next.status).toBe(0);
    expect(served(next.stdout)).toMatchObject({ version: '1.0.0', head: oldSha });
  });

  it('with nothing to recover it adds nothing: the server just starts', () => {
    put(app, 'node_modules/built.txt', 'OLD-MODULES'); put(app, 'packages/frontend/build/build-id.txt', 'OLD-BUILD');
    git(app, 'reset', '-q', '--hard', oldSha);
    const r = serve();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/update-recover/);
    expect(served(r.stdout)).toMatchObject({ version: '1.0.0', reexeced: null });
  });
});
