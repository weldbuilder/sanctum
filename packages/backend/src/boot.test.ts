// packages/backend/boot.mjs run for real (node, no tsx) in a scratch copy of the layout, over a folder a swap was cut short in. What it proves, which a static import of the recovery from server.ts never could:
// with node_modules MOVED ASIDE (so `import 'fake-dep'` in the app cannot even be linked), `node packages/backend/boot.mjs` puts the previous version back first, starts over, and serves the OLD version
// (old HEAD, old build id, old node_modules, old dist); `node dist/server.js` on the same folder cannot start. Re-exec exit codes differ on Windows (a signalled child has no code), so the
// processes are run only where that is the same as on Linux; the recovery itself is unit tested on every platform (boot-recover.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { writeManifest, type Manifest } from './boot-recover.js';


const here = dirname(fileURLToPath(import.meta.url));
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Sam', GIT_AUTHOR_EMAIL: 'sam@example.test', GIT_COMMITTER_NAME: 'Sam', GIT_COMMITTER_EMAIL: 'sam@example.test', GIT_CONFIG_GLOBAL: NULL_DEVICE };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();
const put = (root: string, rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf-8');
/** What `tsc` makes of src/<name>.ts, so the files run here are the compiled ones. */
const compiled = (name: string) => ts.transpileModule(readFileSync(join(here, name), 'utf-8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const repoRoot = join(here, '..', '..', '..');
/** The tracked entry and the vendored recovery it imports: the real files, copied into the scratch app at the same places (both outside every directory a swap moves). */
const BOOT_MJS = readFileSync(join(repoRoot, 'packages', 'backend', 'boot.mjs'), 'utf-8');
const BOOT_RECOVER_MJS = readFileSync(join(repoRoot, 'scripts', 'boot-recover.mjs'), 'utf-8');
/** The stand-in app: it needs a package from node_modules to even link, then reports what it finds on disk. */
const server = (which: string) => `
import { marker } from 'fake-dep';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
console.log('SERVING ' + JSON.stringify({
  server: '${which}', version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim(),
  build: readFileSync(join(root, 'packages/frontend/build/id.txt'), 'utf-8'), modules: marker, reexeced: process.env.SANCTUM_RECOVER_REEXEC ?? null,
}));
process.exit(0);
`;
const fakeDep = (root: string, marker: string) => { put(root, 'node_modules/fake-dep/package.json', '{"name":"fake-dep","type":"module","exports":"./index.js"}'); put(root, 'node_modules/fake-dep/index.js', `export const marker = '${marker}';`); };
const dist = (root: string, which: string) => { put(root, 'packages/backend/dist/server.js', server(which)); };

let app: string, oldSha: string, newSha: string;
const next = () => join(app, '.update-rollback.next', '1.0.0');
beforeEach(() => {
  app = mkdtempSync(join(tmpdir(), 'boot-'));
  put(app, 'packages/backend/package.json', '{"type":"module"}');
  put(app, 'packages/backend/boot.mjs', BOOT_MJS); put(app, 'scripts/boot-recover.mjs', BOOT_RECOVER_MJS); // (tracked, like the real ones)
  git(app, 'init', '-q', '-b', 'main');
  writeFileSync(join(app, '.gitignore'), 'node_modules/\ndist/\nbuild/\n.update-stage/\n.update-rollback/\n.update-rollback.next/\n.update-recovery.json\n.update-recover.count\n');
  put(app, 'package.json', '{"name":"fake","version":"1.0.0"}');
  git(app, 'add', '-A'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'one');
  oldSha = git(app, 'rev-parse', 'HEAD');
  put(app, 'package.json', '{"name":"fake","version":"1.1.0"}');
  git(app, 'add', '-A'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'two');
  newSha = git(app, 'rev-parse', 'HEAD');
});
afterEach(() => { rmSync(app, { recursive: true, force: true }); });

type Point = 'modules-aside' | 'first-rename' | 'dist-and-build' | 'merge-no-manifest' | 'before-merge';
/** The folder as a swap killed at `point` leaves it (HEAD is the NEW commit unless the merge had not run). modules-aside: node_modules renamed into the copy, the staged one not yet in. */
function cutSwap(point: Point) {
  const orig = (rel: string, body: string) => put(next(), `files/${rel}`, body);
  const entries: Manifest['entries'] = [
    { path: 'node_modules', kind: 'dir', how: 'moved', step: 'pending' },
    { path: 'packages/backend/dist', kind: 'dir', how: 'moved', step: 'pending' },
    { path: 'packages/frontend/build', kind: 'dir', how: 'moved', step: 'pending' },
  ];
  const newLive = () => { fakeDep(app, 'NEW-MODULES'); dist(app, 'NEW'); put(app, 'packages/frontend/build/id.txt', 'NEW-BUILD'); };
  const oldLive = () => { fakeDep(app, 'OLD-MODULES'); dist(app, 'OLD'); put(app, 'packages/frontend/build/id.txt', 'OLD-BUILD'); };
  const oldCopy = (what: 'node_modules' | 'dist' | 'build') => {
    if (what === 'node_modules') { fakeDep(next() + '/files', 'OLD-MODULES'); }
    if (what === 'dist') dist(next() + '/files', 'OLD');
    if (what === 'build') orig('packages/frontend/build/id.txt', 'OLD-BUILD');
  };
  if (point === 'modules-aside') { dist(app, 'OLD'); put(app, 'packages/frontend/build/id.txt', 'OLD-BUILD'); oldCopy('node_modules'); } // (no live node_modules at all)
  else if (point === 'first-rename') { newLive(); oldCopy('node_modules'); put(app, 'packages/backend/dist/server.js', server('OLD')); put(app, 'packages/frontend/build/id.txt', 'OLD-BUILD'); entries[0].step = 'moved'; }
  else if (point === 'dist-and-build') { newLive(); oldCopy('node_modules'); oldCopy('dist'); oldCopy('build'); entries.forEach((e) => { e.step = 'moved'; }); }
  else oldLive();
  mkdirSync(next(), { recursive: true });
  writeManifest(next(), { version: '1.0.0', mode: 'git', sha: oldSha, toSha: newSha, toVersion: '1.1.0', phase: 'swapping', merged: false, entries } as Manifest);
  if (point === 'before-merge') git(app, 'reset', '-q', '--hard', oldSha);
  mkdirSync(join(app, '.update-stage'), { recursive: true });
}
const entry = (name: string) => (name === 'boot.mjs' ? join(app, 'packages', 'backend', name) : join(app, 'packages', 'backend', 'dist', name));
const run = (script: string, env: Record<string, string> = {}) => spawnSync(process.execPath, [script], { cwd: app, encoding: 'utf-8', env: { ...process.env, ...env }, timeout: 60_000 });
const served = (out: string) => JSON.parse(/SERVING (.*)/.exec(out)![1]);
const OLD = { server: 'OLD', version: '1.0.0', head: '', build: 'OLD-BUILD', modules: 'OLD-MODULES', reexeced: null };

describe.skipIf(process.platform === 'win32')('node packages/backend/boot.mjs after a swap was cut short', () => {
  it('node_modules moved aside (the app cannot even link): dist/server.js alone cannot start, boot.mjs recovers first and serves the old version', () => {
    cutSwap('modules-aside');
    expect(existsSync(join(app, 'node_modules'))).toBe(false);
    const plain = run(entry('server.js')); // what a static import of the recovery from server.ts left: node links the graph first, so nothing recovers
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toMatch(/Cannot find package 'fake-dep'/);
    expect(existsSync(next())).toBe(true); // (and nothing was touched)

    const r = run(entry('boot.mjs'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[update-recover\] a swap was cut short/);
    expect(r.stdout).toMatch(/starting the app again from them/);
    expect(served(r.stdout)).toEqual({ ...OLD, head: oldSha });
    expect(r.stdout.match(/SERVING/g)).toHaveLength(1); // the first process never got as far as serving: only its re-exec did
    expect(existsSync(join(app, '.update-rollback.next'))).toBe(false);
    expect(JSON.parse(read(app, '.update-recovery.json'))).toMatchObject({ outcome: 'restored', phase: 'swapping' }); // for the updater service to word its job from
    const again = run(entry('boot.mjs')); // the next start finds nothing to do and serves directly
    expect(again.stdout).not.toMatch(/update-recover/);
    expect(served(again.stdout)).toMatchObject({ version: '1.0.0', head: oldSha, reexeced: null });
  });

  it('dist is gone entirely (the window between dist moved into the rollback copy and the staged one moved in): boot.mjs still exists, recovers from the swapping manifest and boots the old version', () => {
    cutSwap('dist-and-build');
    rmSync(join(app, 'packages', 'backend', 'dist'), { recursive: true, force: true }); // (the window itself: nothing under dist, boot.js included, exists)
    expect(existsSync(join(app, 'packages', 'backend', 'dist'))).toBe(false);
    expect(existsSync(entry('boot.mjs'))).toBe(true);
    const r = run(entry('boot.mjs'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[update-recover\] a swap was cut short/);
    expect(served(r.stdout)).toEqual({ ...OLD, head: oldSha });
    expect(existsSync(join(app, '.update-rollback.next'))).toBe(false);
  });

  it.each([
    ['after the first rename', 'first-rename'],
    ['after dist and build are swapped', 'dist-and-build'],
    ['between the merge and the manifest write (HEAD is new, no merged flag)', 'merge-no-manifest'],
    ['before the merge ran', 'before-merge'],
  ] as const)('killed %s: the process that serves is the old version (old HEAD, old build id, old node_modules, old dist)', (_n, point) => {
    cutSwap(point);
    if (point !== 'before-merge') expect(git(app, 'rev-parse', 'HEAD')).toBe(newSha);
    const r = run(entry('boot.mjs'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[update-recover\] a swap was cut short/);
    expect(served(r.stdout)).toEqual({ ...OLD, head: oldSha });
    expect(r.stdout.match(/SERVING/g)).toHaveLength(1);
    expect(existsSync(join(app, '.update-rollback.next'))).toBe(false);
    expect(git(app, 'status', '--porcelain')).toBe('');
  });

  it('under a supervisor it exits 75 after the restore (the supervisor starts it again) and serves nothing itself; the loop guard stops a fourth', () => {
    cutSwap('modules-aside');
    const r = run(entry('boot.mjs'), { SANCTUM_SUPERVISED: '1' });
    expect(r.status).toBe(75);
    expect(r.stdout).not.toMatch(/SERVING/);
    expect(JSON.parse(read(app, '.update-recover.count')).count).toBe(1);
    const second = run(entry('boot.mjs'), { SANCTUM_SUPERVISED: '1' }); // the supervisor's second start
    expect(second.status).toBe(0);
    expect(served(second.stdout)).toMatchObject({ ...OLD, head: oldSha });
    // three more cut swaps in a row: the first two exit 75, the next is refused and the app boots as it is
    const codes: (number | null)[] = [];
    for (let i = 0; i < 3; i++) {
      rmSync(join(app, 'node_modules'), { recursive: true, force: true }); rmSync(join(app, '.update-rollback.next'), { recursive: true, force: true });
      cutSwap('modules-aside');
      const x = run(entry('boot.mjs'), { SANCTUM_SUPERVISED: '1' });
      codes.push(x.status);
      if (x.status !== 75) { expect(x.stdout).toMatch(/recovery number 4 within 10 minutes/); expect(x.stdout).toMatch(/SERVING/); }
    }
    expect(codes).toEqual([75, 75, 0]);
  });

  it('a corrupt manifest: the app still starts, nothing is removed, and it says where to look', () => {
    cutSwap('first-rename');
    writeFileSync(join(next(), 'manifest.json'), '{"phase": "swapp');
    const r = run(entry('boot.mjs'));
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/could not read the update state; nothing was removed/);
    expect(r.stdout).toMatch(/npm run update -- --recover/);
    expect(existsSync(join(next(), 'files', 'node_modules'))).toBe(true);
    expect(existsSync(join(app, '.update-stage'))).toBe(true);
    expect(served(r.stdout)).toMatchObject({ modules: 'NEW-MODULES' }); // (booted on what is there; the job is marked failed from .update-recovery.json)
  });

  it('with nothing to recover it adds nothing: the app just starts', () => {
    fakeDep(app, 'OLD-MODULES'); dist(app, 'OLD'); put(app, 'packages/frontend/build/id.txt', 'OLD-BUILD');
    git(app, 'reset', '-q', '--hard', oldSha);
    const r = run(entry('boot.mjs'));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/update-recover/);
    expect(served(r.stdout)).toEqual({ ...OLD, head: oldSha });
  });
});
