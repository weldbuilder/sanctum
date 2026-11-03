// The vendored pre-boot recovery (src/boot-recover.ts) unit by unit, on every platform: every state of the manifest, and every way a recovery can fail, in a scratch git repo.
// (The recovery run for real, as `node dist/boot.js` with node_modules moved aside, is boot.test.ts.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLEAN_BOOT_MS, LOOP_MAX, LOOP_WINDOW_MS, MACHINE, MANIFEST_FORMAT, RECOVER_EXIT_CODE, bootRecover, clearLoopCount, isSupervised, noteRecoveryExit, readManifest, recover, reexecArgs,
  restoreFiles, takeRecoveryResult, unsettled, verifyRestored, writeManifest, type Manifest,
} from './boot-recover.js';

const here = dirname(fileURLToPath(import.meta.url));
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Sam', GIT_AUTHOR_EMAIL: 'sam@example.test', GIT_COMMITTER_NAME: 'Sam', GIT_COMMITTER_EMAIL: 'sam@example.test', GIT_CONFIG_GLOBAL: NULL_DEVICE };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();
const put = (root: string, rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf-8');

let app: string, oldSha: string, newSha: string;
const next = () => join(app, '.update-rollback.next');
const main = () => join(app, '.update-rollback');
const copyDir = () => join(next(), '1.0.0');
beforeEach(() => {
  app = mkdtempSync(join(tmpdir(), 'boot-recover-'));
  git(app, 'init', '-q', '-b', 'main');
  writeFileSync(join(app, '.gitignore'), 'node_modules/\ndist/\nbuild/\n.update-stage/\n.update-rollback/\n.update-rollback.next/\n.update-recovery.json\n.update-recover.count\n');
  put(app, 'package.json', '{"name":"fake","version":"1.0.0"}');
  put(app, 'src.txt', 'OLD-SOURCE');
  git(app, 'add', '-A'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'one');
  oldSha = git(app, 'rev-parse', 'HEAD');
  put(app, 'package.json', '{"name":"fake","version":"1.1.0"}');
  put(app, 'src.txt', 'NEW-SOURCE');
  git(app, 'add', '-A'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'two');
  newSha = git(app, 'rev-parse', 'HEAD');
});
afterEach(() => { rmSync(app, { recursive: true, force: true }); });

type Step = 'pending' | 'moved';
/** The folder as a swap cut short leaves it: live node_modules and build are the NEW ones unless the entry's step says the swap had not reached it; the copy holds the old ones for the entries reached. */
function cut(opts: { phase?: string; modules?: Step; build?: Step; extra?: Partial<Manifest>; headNew?: boolean } = {}) {
  const { phase = 'swapping', modules = 'moved', build = 'moved', extra = {}, headNew = true } = opts;
  const live = (rel: string, body: string) => put(app, rel, body);
  const orig = (rel: string, body: string) => put(copyDir(), `files/${rel}`, body);
  if (modules === 'moved') { live('node_modules/built.txt', 'NEW-MODULES'); orig('node_modules/built.txt', 'OLD-MODULES'); } else live('node_modules/built.txt', 'OLD-MODULES');
  if (build === 'moved') { live('packages/frontend/build/id.txt', 'NEW-BUILD'); orig('packages/frontend/build/id.txt', 'OLD-BUILD'); } else live('packages/frontend/build/id.txt', 'OLD-BUILD');
  const entries = [
    { path: 'node_modules', kind: 'dir', how: 'moved', step: modules },
    { path: 'packages/frontend/build', kind: 'dir', how: 'moved', step: build },
  ];
  writeManifest(copyDir(), { version: '1.0.0', mode: 'git', sha: oldSha, toSha: newSha, toVersion: '1.1.0', phase, entries, ...extra } as Manifest);
  if (!headNew) git(app, 'reset', '-q', '--hard', oldSha);
  mkdirSync(join(app, '.update-stage'), { recursive: true });
}
const log: string[] = [];
const rec = (retry = false) => { log.length = 0; return recover(app, { log: (l) => log.push(l), retry }); };
const withoutGit = <T>(fn: () => T): T => {
  const empty = mkdtempSync(join(tmpdir(), 'no-git-'));
  const was = process.env.PATH;
  process.env.PATH = empty;
  try { return fn(); } finally { process.env.PATH = was; rmSync(empty, { recursive: true, force: true }); }
};

describe('the state machine and the manifest', () => {
  it('writes its format and its own description of its states, atomically (no temp file is left)', () => {
    cut();
    const m = JSON.parse(read(copyDir(), 'manifest.json'));
    expect(m.format).toBe(MANIFEST_FORMAT);
    expect(m.machine).toEqual(MACHINE);
    expect(MACHINE).toEqual({ swapping: 'restore', rolling_back: 'restore', swapped: 'adopt', rolled_back: 'discard', recovery_failed: 'hold' });
    expect(readdirSync(copyDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('a manifest with no format field is format 1 (what an older build wrote); a newer format or a bad shape is not understood', () => {
    mkdirSync(copyDir(), { recursive: true });
    writeFileSync(join(copyDir(), 'manifest.json'), JSON.stringify({ phase: 'swapped', entries: [] }));
    expect(readManifest(copyDir()).kind).toBe('ok');
    writeFileSync(join(copyDir(), 'manifest.json'), JSON.stringify({ format: 2, phase: 'swapped', entries: [] }));
    expect(readManifest(copyDir()).kind).toBe('format');
    writeFileSync(join(copyDir(), 'manifest.json'), JSON.stringify({ format: 'x', phase: 'swapped', entries: [] }));
    expect(readManifest(copyDir()).kind).toBe('corrupt');
    writeFileSync(join(copyDir(), 'manifest.json'), JSON.stringify({ phase: 'swapped', entries: [{ path: '../outside', kind: 'dir' }] }));
    expect(readManifest(copyDir())).toMatchObject({ kind: 'corrupt' });
    writeFileSync(join(copyDir(), 'manifest.json'), '{"phase": "swap');
    expect(readManifest(copyDir()).kind).toBe('corrupt');
  });
});

describe('swapping: the previous version is put back', () => {
  it.each([
    ['after the first rename (node_modules moved, the build not yet reached)', 'moved', 'pending'],
    ['after every rename (the phase still says swapping)', 'moved', 'moved'],
    ['nothing renamed yet (HEAD may already be the new commit)', 'pending', 'pending'],
  ] as const)('%s', (_n, modules, build) => {
    cut({ modules, build });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(newSha);
    const r = rec();
    expect(r).toMatchObject({ changed: true, outcome: 'restored', phase: 'swapping' });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(oldSha);
    expect(read(app, 'src.txt')).toBe('OLD-SOURCE');
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES');
    expect(read(app, 'packages/frontend/build/id.txt')).toBe('OLD-BUILD');
    expect(existsSync(next())).toBe(false);
    expect(log.join('\n')).toMatch(/a swap was cut short/);
    expect(takeRecoveryResult(app)).toMatchObject({ outcome: 'restored', phase: 'swapping', toVersion: '1.1.0' });
    expect(takeRecoveryResult(app)).toBe(null); // read once
    expect(rec()).toMatchObject({ changed: false, outcome: 'nothing', detail: '' }); // and a second run finds nothing
    expect(existsSync(join(app, '.update-recovery.json'))).toBe(false); // (nothing found: no result written)
  });

  it('a partial checkout: HEAD already is the manifest sha but the tree is half written; reset and checkout make it clean', () => {
    cut({ headNew: false });
    put(app, 'src.txt', 'HALF-WRITTEN-NEW'); // a power cut during the fast-forward's checkout
    put(app, 'package.json', '{"name":"fake","version":"1.1.0"}');
    expect(git(app, 'rev-parse', 'HEAD')).toBe(oldSha);
    expect(git(app, 'status', '--porcelain')).not.toBe('');
    const r = rec();
    expect(r.outcome).toBe('restored');
    expect(read(app, 'src.txt')).toBe('OLD-SOURCE');
    expect(read(app, 'package.json')).toContain('1.0.0');
    expect(git(app, 'status', '--porcelain')).toBe('');
  });

  it('a recovery that crashes half way is simply run again (each directory is in exactly one place)', () => {
    cut();
    const m = readManifest(copyDir());
    if (m.kind !== 'ok') throw new Error('manifest');
    // run only the first entry's rename by hand, as a crash after it would leave things
    const all = m.manifest.entries;
    m.manifest.entries = [all[0]];
    restoreFiles({ root: app, dir: copyDir(), manifest: m.manifest });
    m.manifest.entries = all; writeManifest(copyDir(), m.manifest); // (the manifest as the crash left it: the first entry marked done)
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES');
    expect(read(copyDir(), 'aside/node_modules/built.txt')).toBe('NEW-MODULES');
    const r = rec();
    expect(r.outcome).toBe('restored');
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES');
    expect(read(app, 'packages/frontend/build/id.txt')).toBe('OLD-BUILD');
  });

  it('rolling_back is finished the same way', () => {
    cut({ phase: 'rolling_back' });
    expect(rec()).toMatchObject({ changed: true, outcome: 'restored', phase: 'rolling_back' });
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES');
  });
});

describe('a manifest that cannot be trusted is never acted on', () => {
  const stateOf = () => ({ stage: existsSync(join(app, '.update-stage')), next: existsSync(copyDir()), live: read(app, 'node_modules/built.txt'), old: read(copyDir(), 'files/node_modules/built.txt'), head: git(app, 'rev-parse', 'HEAD') });
  it('a truncated manifest: nothing is deleted or moved, the copy and the stage stay, and the result says it could not read the state', () => {
    cut();
    const before = stateOf();
    writeFileSync(join(copyDir(), 'manifest.json'), readFileSync(join(copyDir(), 'manifest.json'), 'utf-8').slice(0, 60));
    for (let i = 0; i < 2; i++) { // (and every boot says the same)
      const r = rec();
      expect(r).toMatchObject({ changed: false, outcome: 'refused', detail: 'could not read the update state; nothing was removed' });
      expect(stateOf()).toEqual(before);
      expect(log.join('\n')).toMatch(/npm run update -- --recover/);
      expect(takeRecoveryResult(app)).toMatchObject({ outcome: 'refused' });
    }
  });
  it('a manifest that is not an object, or has no entries, is refused the same way', () => {
    cut();
    for (const body of ['[]', 'null', '"x"', '{"phase":"swapping"}', '']) {
      writeFileSync(join(copyDir(), 'manifest.json'), body);
      expect(rec().outcome).toBe('refused');
      expect(existsSync(join(copyDir(), 'files'))).toBe(true);
    }
  });
  it('a newer manifest format: refused with a clear log; everything stays in place', () => {
    cut({ extra: { format: 2 } as Partial<Manifest> });
    writeFileSync(join(copyDir(), 'manifest.json'), JSON.stringify({ ...JSON.parse(read(copyDir(), 'manifest.json')), format: 2 }));
    const before = stateOf();
    const r = rec();
    expect(r).toMatchObject({ changed: false, outcome: 'refused' });
    expect(r.detail).toMatch(/newer format/);
    expect(log.join('\n')).toMatch(/format 2; this version understands up to 1/);
    expect(stateOf()).toEqual(before);
  });
  it('a state the machine does not know: refused', () => {
    cut({ phase: 'launching' });
    writeFileSync(join(copyDir(), 'manifest.json'), JSON.stringify({ ...JSON.parse(read(copyDir(), 'manifest.json')), machine: undefined }));
    expect(rec()).toMatchObject({ changed: false, outcome: 'refused' });
    expect(read(app, 'node_modules/built.txt')).toBe('NEW-MODULES');
  });
  it('a corrupt manifest in the kept copy (.update-rollback) is refused too, and an empty .update-rollback.next beside it is not removed', () => {
    cut();
    mkdirSync(join(main(), '0.9.0'), { recursive: true });
    writeFileSync(join(main(), '0.9.0', 'manifest.json'), '{');
    const r = rec();
    expect(r.outcome).toBe('refused');
    expect(existsSync(join(main(), '0.9.0', 'manifest.json'))).toBe(true);
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES'); // (the readable copy beside it was still recovered)
  });
  it('a .update-rollback.next with a copy but no manifest at all (the swap never began) is just removed; one with an unreadable manifest is not', () => {
    mkdirSync(join(copyDir(), 'files'), { recursive: true });
    expect(rec()).toMatchObject({ outcome: 'nothing', changed: false });
    expect(existsSync(next())).toBe(false);
    mkdirSync(join(copyDir(), 'files'), { recursive: true });
    writeFileSync(join(copyDir(), 'manifest.json'), 'nope');
    expect(rec().outcome).toBe('refused');
    expect(existsSync(next())).toBe(true);
  });
  it('unsettled() names a copy the updater must not overwrite', () => {
    expect(unsettled(next())).toBe('');
    cut();
    expect(unsettled(next())).toMatch(/earlier update left its files/);
    writeFileSync(join(copyDir(), 'manifest.json'), '{');
    expect(unsettled(next())).toMatch(/cannot be read/);
    writeManifest(copyDir(), { phase: 'swapped', entries: [] });
    expect(unsettled(next())).toBe('');
  });
});

describe('a restore that cannot be done leaves things where they can be recovered from', () => {
  it('git missing: the directories are moved back where possible, nothing is deleted, the copy is kept and marked, and there is no "put back" claim; npm run update -- --recover tries again', () => {
    cut();
    const r = withoutGit(() => rec());
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/git reset --hard/);
    expect(r.detail).not.toMatch(/previous version was put back/);
    expect(r.detail).toMatch(/npm run update -- --recover/);
    expect(existsSync(copyDir())).toBe(true); // kept
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES'); // moved back (a rename, nothing deleted)
    expect(read(copyDir(), 'aside/node_modules/built.txt')).toBe('NEW-MODULES'); // the new one is set aside, not deleted
    expect(JSON.parse(read(copyDir(), 'manifest.json'))).toMatchObject({ phase: 'recovery_failed', restored_from: 'swapping' });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(newSha);
    // a plain boot does not retry (it would reset a tree the person may have edited since): it holds and says why
    const held = rec();
    expect(held).toMatchObject({ outcome: 'failed', changed: false });
    expect(held.detail).toMatch(/git reset --hard/);
    expect(git(app, 'rev-parse', 'HEAD')).toBe(newSha);
    // `--recover` retries, and now it works
    const again = rec(true);
    expect(again).toMatchObject({ outcome: 'restored', changed: true, phase: 'swapping' });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(oldSha);
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES');
    expect(existsSync(next())).toBe(false);
  });
  it('an index.lock held by another git: the reset fails, no directory is lost, the copy is kept', () => {
    cut();
    writeFileSync(join(app, '.git', 'index.lock'), '');
    const r = rec();
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/git reset --hard/);
    expect(existsSync(copyDir())).toBe(true);
    expect(existsSync(join(app, 'node_modules', 'built.txt'))).toBe(true);
    expect(existsSync(join(app, 'packages/frontend/build/id.txt'))).toBe(true);
    rmSync(join(app, '.git', 'index.lock'));
    expect(rec(true).outcome).toBe('restored');
    expect(git(app, 'rev-parse', 'HEAD')).toBe(oldSha);
  });
  it('a copy that lacks one of its directories: the live one is not moved aside, the others are restored, the copy is kept and the missing one is named', () => {
    cut();
    rmSync(join(copyDir(), 'files', 'packages'), { recursive: true }); // the copy lost the build
    const r = rec();
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/lacks packages\/frontend\/build/);
    expect(read(app, 'packages/frontend/build/id.txt')).toBe('NEW-BUILD'); // the live one stayed where it was
    expect(existsSync(join(copyDir(), 'aside', 'packages'))).toBe(false);
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES'); // the present one was restored
    expect(git(app, 'rev-parse', 'HEAD')).toBe(oldSha);
    expect(existsSync(copyDir())).toBe(true);
    expect(JSON.parse(read(copyDir(), 'manifest.json')).phase).toBe('recovery_failed');
  });
  it('a directory the swap had not reached is not "missing": the live (old) one stays and the recovery succeeds', () => {
    cut({ build: 'pending' });
    expect(rec().outcome).toBe('restored');
    expect(read(app, 'packages/frontend/build/id.txt')).toBe('OLD-BUILD');
  });
  it('after a restore, what is still inconsistent is said precisely (here: the lockfile is not the restored version\'s)', () => {
    cut({ extra: { lockfile_sha256: 'deadbeef' } });
    put(app, 'package-lock.json', '{}');
    git(app, 'add', '-f', 'package-lock.json'); git(app, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'lock');
    oldSha = git(app, 'rev-parse', 'HEAD');
    const m = JSON.parse(read(copyDir(), 'manifest.json')); m.sha = oldSha; writeFileSync(join(copyDir(), 'manifest.json'), JSON.stringify(m));
    const r = rec();
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/previous version was put back, but this is inconsistent: package-lock\.json is not the restored version's/);
  });
  it('verifyRestored: HEAD, the directories and the installed modules against the lockfile', () => {
    put(app, 'package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }));
    put(app, 'node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/a': { version: '2.0.0' } } }));
    const m = { phase: 'rolled_back', mode: 'git', sha: oldSha, entries: [{ path: 'node_modules', kind: 'dir', how: 'moved' }, { path: 'dist', kind: 'dir', how: 'moved' }] } as Manifest;
    const out = verifyRestored(app, m);
    expect(out.join('|')).toMatch(/HEAD is .*not/);
    expect(out).toContain('dist is missing');
    expect(out.join('|')).toMatch(/node_modules does not match package-lock\.json \(1 package, e\.g\. node_modules\/a\)/);
  });
});

describe('swapped, rolled_back and the promotion', () => {
  it('a swap that had finished but whose copy was not moved over the previous one: adopted (the new version is running), the old copy replaced', () => {
    mkdirSync(join(main(), '0.9.0'), { recursive: true });
    writeManifest(join(main(), '0.9.0'), { version: '0.9.0', phase: 'swapped', entries: [] });
    cut({ phase: 'swapped' });
    const r = rec();
    expect(r).toMatchObject({ changed: false, outcome: 'adopted', toVersion: '1.1.0', detail: 'restarted on 1.1.0; the stage was cleaned up at boot' });
    expect(existsSync(next())).toBe(false);
    expect(readdirSync(main())).toEqual(['1.0.0']);
    expect(read(app, 'node_modules/built.txt')).toBe('NEW-MODULES'); // nothing was put back
    expect(git(app, 'rev-parse', 'HEAD')).toBe(newSha);
  });
  it('a finished swap already in .update-rollback is just the kept copy: nothing to do, nothing changed', () => {
    mkdirSync(join(main(), '1.0.0'), { recursive: true });
    writeManifest(join(main(), '1.0.0'), { version: '1.0.0', phase: 'swapped', entries: [] });
    expect(rec()).toMatchObject({ outcome: 'nothing', changed: false });
    expect(existsSync(join(main(), '1.0.0', 'manifest.json'))).toBe(true);
  });
  it('rolled_back: only the set-aside copies are left; they are deleted, and the result says the previous version is back (a roll back)', () => {
    mkdirSync(join(main(), '1.0.0', 'aside', 'node_modules'), { recursive: true });
    writeManifest(join(main(), '1.0.0'), { version: '1.0.0', phase: 'rolled_back', restored_from: 'rolling_back', entries: [] });
    const r = rec();
    expect(r).toMatchObject({ changed: false, outcome: 'restored', phase: 'rolling_back' });
    expect(existsSync(main())).toBe(false);
  });
  it('nothing at all to recover: nothing, no result file', () => {
    expect(rec()).toEqual({ changed: false, outcome: 'nothing', detail: '' });
    expect(existsSync(join(app, '.update-recovery.json'))).toBe(false);
  });
});

describe('the supervised loop guard', () => {
  it('allows three recovery exits within ten minutes and refuses the fourth; the window expires; a clean boot clears it', () => {
    const t0 = 1_000_000;
    expect(noteRecoveryExit(app, t0)).toEqual({ allowed: true, count: 1 });
    expect(noteRecoveryExit(app, t0 + 1000)).toEqual({ allowed: true, count: 2 });
    expect(noteRecoveryExit(app, t0 + 2000)).toEqual({ allowed: true, count: 3 });
    expect(LOOP_MAX).toBe(3);
    expect(noteRecoveryExit(app, t0 + 3000)).toEqual({ allowed: false, count: 4 });
    expect(noteRecoveryExit(app, t0 + LOOP_WINDOW_MS + 10_000)).toEqual({ allowed: true, count: 1 }); // (a new window)
    clearLoopCount(app);
    expect(existsSync(join(app, '.update-recover.count'))).toBe(false);
    expect(noteRecoveryExit(app, t0 + 5000)).toEqual({ allowed: true, count: 1 });
  });
  it('isSupervised: pm_id, SANCTUM_SUPERVISED=1, or that line in .env', () => {
    expect(isSupervised(app, {})).toBe(false);
    expect(isSupervised(app, { pm_id: '3' })).toBe(true);
    expect(isSupervised(app, { SANCTUM_SUPERVISED: '1' })).toBe(true);
    expect(isSupervised(app, { SANCTUM_SUPERVISED: '0' })).toBe(false);
    put(app, '.env', '# SANCTUM_SUPERVISED=1\nSANCTUM_SUPERVISED="1"\n');
    expect(isSupervised(app, {})).toBe(true);
  });
});

describe('starting over (bootRecover)', () => {
  const quiet = () => {};
  it('nothing to recover: it just says "booting" and starts nothing', async () => {
    let spawned = 0;
    const how = await bootRecover({ root: app, log: quiet, env: {}, exit: () => { throw new Error('no exit'); }, spawnFn: (() => { spawned++; }) as never });
    expect(how).toBe('booting');
    expect(spawned).toBe(0);
  });
  it('supervised: exits 75 and the count is noted; after three the fourth is refused (it boots as it is, and says "guarded" so the count is kept)', async () => {
    const codes: number[] = [];
    const hows: string[] = [];
    for (let i = 0; i < 4; i++) {
      rmSync(next(), { recursive: true, force: true });
      cut();
      hows.push(await bootRecover({ root: app, log: quiet, env: { SANCTUM_SUPERVISED: '1' }, exit: (c) => { codes.push(c); } }));
    }
    expect(hows).toEqual(['exited', 'exited', 'exited', 'guarded']);
    expect(codes).toEqual([RECOVER_EXIT_CODE, RECOVER_EXIT_CODE, RECOVER_EXIT_CODE]);
    expect(RECOVER_EXIT_CODE).toBe(75);
    expect(CLEAN_BOOT_MS).toBeGreaterThan(0);
  });
  it('unsupervised: the same script is started again without the inspector flags, with the re-exec flag, and this process exits with its code', async () => {
    cut();
    const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const fake = { on: (ev: string, fn: (...a: unknown[]) => void) => { handlers[ev] = fn; return fake; }, kill: () => true };
    const exits: number[] = [];
    const p = bootRecover({
      root: app, log: quiet, env: { KEEP: 'me' }, execPath: '/usr/bin/node', execArgv: ['--inspect=127.0.0.1:9229', '--max-old-space-size=512', '--inspect-port', '9230', '--import', 'tsx'], argv: ['/usr/bin/node', '/app/dist/boot.js', '--flag'],
      exit: (c) => { exits.push(c); }, spawnFn: ((cmd: string, args: string[], o: { env: Record<string, string | undefined> }) => { calls.push({ cmd, args, env: o.env }); return fake; }) as never,
    });
    handlers.exit(7, null);
    expect(await p).toBe('child');
    expect(calls[0].cmd).toBe('/usr/bin/node');
    expect(calls[0].args).toEqual(['--max-old-space-size=512', '--import', 'tsx', '/app/dist/boot.js', '--flag']);
    expect(calls[0].env).toMatchObject({ KEEP: 'me', SANCTUM_RECOVER_REEXEC: '1' });
    expect(exits).toEqual([7]);
    expect(read(app, 'node_modules/built.txt')).toBe('OLD-MODULES');
  });
  it('a child ended by a signal exits 128+signal; one that cannot start exits 1', async () => {
    const run = async (fire: (h: Record<string, (...a: unknown[]) => void>) => void) => {
      cut();
      const h: Record<string, (...a: unknown[]) => void> = {};
      const fake = { on: (ev: string, fn: (...a: unknown[]) => void) => { h[ev] = fn; return fake; }, kill: () => true };
      const exits: number[] = [];
      const p = bootRecover({ root: app, log: quiet, env: {}, exit: (c) => { exits.push(c); }, spawnFn: (() => fake) as never });
      fire(h); await p; rmSync(next(), { recursive: true, force: true });
      return exits;
    };
    expect(await run((h) => h.exit(null, 'SIGTERM'))).toEqual([143]);
    expect(await run((h) => h.error(new Error('ENOENT')))).toEqual([1]);
  });
  it('a recovery straight after a re-exec does not start over again', async () => {
    cut();
    const how = await bootRecover({ root: app, log: quiet, env: { SANCTUM_RECOVER_REEXEC: '1' }, exit: () => { throw new Error('no exit'); } });
    expect(how).toBe('booting');
  });
  it('reexecArgs drops every --inspect* form (and the value of --inspect-port) and keeps the rest', () => {
    expect(reexecArgs(['--inspect', '--inspect-brk=0.0.0.0:1', '--inspect-wait', '--inspect-port=9', '--inspect-port', '9230', '--require', 'x'], ['node', 'a.js', 'b'])).toEqual(['--require', 'x', 'a.js', 'b']);
  });
});

describe('the module is dependency-free, and its plain-JavaScript copy is current', () => {
  it('boot.ts and boot-recover.ts import only node built-ins (and each other)', () => {
    for (const f of ['boot.ts', 'boot-recover.ts']) {
      const src = readFileSync(join(here, f), 'utf-8');
      const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs) expect(s.startsWith('node:') || s === './boot-recover.js', `${f} imports ${s}`).toBe(true);
      expect(src).not.toMatch(/import\(['"][^.n]/);
      expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/updater-core/);
    }
    expect(readFileSync(join(here, 'boot.ts'), 'utf-8')).toMatch(/await import\('\.\/server\.js'\)/);
  });
  it('scripts/boot-recover.mjs is what `node scripts/sync-boot-recover.mjs` writes', () => {
    const r = spawnSync(process.execPath, [join(here, '..', '..', '..', 'scripts', 'sync-boot-recover.mjs'), '--check'], { encoding: 'utf-8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
  it('server.ts no longer imports a recovery (dist/server.js stays importable; dist/boot.js is the entry)', () => {
    const server = readFileSync(join(here, 'server.ts'), 'utf-8');
    expect(server).not.toMatch(/^import\s+'\.\/update-recover/m);
    expect(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')).scripts.start).toBe('node dist/boot.js');
  });
});
