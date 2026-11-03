// The in-app updater: the restart sequence with its spawn and health poll stubbed (the test process never restarts), and a whole job on a fake folder.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cleared = vi.hoisted(() => ({ n: 0 }));
vi.mock('./update-check.js', () => ({
  checkForUpdate: async () => ({ version: '1.0.0', latest: '1.1.0', update_available: true, repo: 'echo/sanctum', branch: 'main', checked_at: '2026-11-03T00:00:00.000Z' }),
  clearUpdateCache: () => { cleared.n++; },
}));

import {
  _jobDone, _setRestartOverrides, _setUpdaterEnv, getJob, getSnapshot, initUpdater, performRestart, setRestartControl, startUpdate, UpdaterError, type RestartControl,
} from './updater.js';
import { _resetUpdateBlock, backgroundRunsInFlight, trackBackgroundStart, updateBlocking } from './update-block.js';

const ctlStub = (calls: string[]): RestartControl => ({
  healthUrl: 'http://127.0.0.1:1/api/health',
  closeListener: async () => { calls.push('close'); },
  relisten: () => { calls.push('relisten'); },
  gracefulStop: async () => { calls.push('stop'); },
});

describe('performRestart', () => {
  it('supervised: stops gracefully and lets the supervisor start it again (no listener close, no spawn)', async () => {
    const calls: string[] = [];
    const r = await performRestart({
      supervised: true, ctl: ctlStub(calls), log: (l) => calls.push(`log:${l.split(':')[0]}`),
      spawnChild: () => { calls.push('spawn'); return { exited: () => false }; },
      waitHealthy: async () => { calls.push('wait'); return true; },
    });
    expect(r).toBe('stopping');
    expect(calls).toEqual(['log:restarting', 'stop']);
  });

  it('respawn, the replacement comes up: close the listener, spawn, wait for health, then stop (in that order)', async () => {
    const calls: string[] = [];
    const r = await performRestart({
      supervised: false, ctl: ctlStub(calls), log: () => {},
      spawnChild: () => { calls.push('spawn'); return { exited: () => false }; },
      waitHealthy: async (url, ms) => { calls.push(`wait:${url}:${ms}`); return true; },
    });
    expect(r).toBe('stopping');
    expect(calls).toEqual(['close', 'spawn', 'wait:http://127.0.0.1:1/api/health:60000', 'stop']);
  });

  it('respawn, the replacement never comes up: this process listens again and does not stop', async () => {
    const calls: string[] = [];
    const r = await performRestart({
      supervised: false, ctl: ctlStub(calls), log: () => {}, healthTimeoutMs: 5,
      spawnChild: () => { calls.push('spawn'); return { exited: () => false }; },
      waitHealthy: async () => { calls.push('wait'); return false; },
    });
    expect(r).toBe('failed');
    expect(calls).toEqual(['close', 'spawn', 'wait', 'relisten']);
  });

  it('hands the job file over before the replacement exists, and takes it back if the replacement never answers', async () => {
    const calls: string[] = [];
    const deps = { ctl: ctlStub(calls), log: () => {}, flush: () => calls.push('flush'), handOver: (on: boolean) => calls.push(`handover:${on}`) };
    await performRestart({ ...deps, supervised: false, spawnChild: () => { calls.push('spawn'); return { exited: () => false }; }, waitHealthy: async () => true });
    expect(calls).toEqual(['flush', 'close', 'handover:true', 'spawn', 'stop']);
    calls.length = 0;
    await performRestart({ ...deps, supervised: false, spawnChild: () => { calls.push('spawn'); return { exited: () => false }; }, waitHealthy: async () => false });
    expect(calls).toEqual(['flush', 'close', 'handover:true', 'spawn', 'handover:false', 'relisten']);
    calls.length = 0;
    await performRestart({ ...deps, supervised: true, spawnChild: () => ({ exited: () => false }), waitHealthy: async () => true });
    expect(calls).toEqual(['flush', 'handover:true', 'stop']); // supervised: flushed (synchronously) before the stop
  });

  it('respawn, the spawn itself throws: listen again', async () => {
    const calls: string[] = [];
    const r = await performRestart({
      supervised: false, ctl: ctlStub(calls), log: () => {},
      spawnChild: () => { throw new Error('ENOENT'); }, waitHealthy: async () => true,
    });
    expect(r).toBe('failed');
    expect(calls).toEqual(['close', 'relisten']);
  });
});

// ---- a whole job on a fake folder ------------------------------------------------------------
const BUILD_JS = `
const fs = require('fs'), path = require('path');
const v = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version;
for (const [f, body] of [['packages/backend/dist/server.js', '// backend ' + v], ['packages/frontend/build/index.html', '<p>' + v + '</p>']]) {
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body);
}`;
const lock = (v: string) => JSON.stringify({ name: 'fake', version: v, lockfileVersion: 3, requires: true, packages: { '': { name: 'fake', version: v } } });
const pkg = (v: string) => JSON.stringify({ name: 'fake', version: v, repository: 'github:echo/sanctum', scripts: { build: 'node build.js' } });
const put = (root: string, rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

describe('an update job', () => {
  let tmp: string, root: string, data: string, archive: string, calls: string[];
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'updater-job-'));
    root = join(tmp, 'app'); data = join(root, 'data'); calls = [];
    put(root, 'package.json', pkg('1.0.0')); put(root, 'package-lock.json', lock('1.0.0')); put(root, 'build.js', BUILD_JS);
    execFileSync('node', ['build.js'], { cwd: root });
    const src = join(tmp, 'src', 'sanctum-main');
    put(src, 'package.json', pkg('1.1.0')); put(src, 'package-lock.json', lock('1.1.0')); put(src, 'build.js', BUILD_JS);
    archive = join(tmp, 'r.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', join(tmp, 'src'), 'sanctum-main']);
    vi.stubGlobal('fetch', async (url: string, init?: unknown) => {
      if (String(url).includes('raw.githubusercontent')) return { ok: true, status: 200, text: async () => JSON.stringify({ version: '1.1.0' }) };
      if (String(url).includes('codeload')) return { ok: true, status: 200, arrayBuffer: async () => readFileSync(archive) };
      return realFetch(url, init as RequestInit);
    });
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false, supervised: () => false });
    setRestartControl(ctlStub(calls));
  });
  afterEach(() => { vi.unstubAllGlobals(); _setUpdaterEnv(null); _resetUpdateBlock(); setRestartControl(null); rmSync(tmp, { recursive: true, force: true }); });

  it('replacement never comes up: state failed, the previous files are back, the listener is re-opened, the log says why', async () => {
    _setRestartOverrides({ spawnChild: () => ({ exited: () => false }), waitHealthy: async () => false });
    startUpdate();
    await _jobDone();
    const j = getJob()!;
    expect(j.state).toBe('failed');
    expect(j.error).toMatch(/did not start, so the previous version was put back/);
    expect(calls).toEqual(['close', 'relisten']);
    expect(readFileSync(join(root, 'package.json'), 'utf-8')).toContain('"1.0.0"');
    expect(readFileSync(join(root, 'packages/backend/dist/server.js'), 'utf-8')).toContain('1.0.0');
    expect(j.log.map((l) => l.line).join('\n')).toMatch(/replacement did not answer/);
    expect(JSON.parse(readFileSync(join(data, 'update-job.json'), 'utf-8')).state).toBe('failed');
  });

  it('replacement comes up: restarting is on disk before the stop, and the next process reads it as done', async () => {
    let onDisk = '';
    _setRestartOverrides({ spawnChild: () => ({ exited: () => false }), waitHealthy: async () => true });
    setRestartControl({ ...ctlStub(calls), gracefulStop: async () => { calls.push('stop'); onDisk = JSON.parse(readFileSync(join(data, 'update-job.json'), 'utf-8')).state; } });
    const started = startUpdate();
    expect(started.state).toBe('checking');
    await _jobDone();
    expect(calls).toEqual(['close', 'stop']);
    expect(onDisk).toBe('restarting');
    // the replacement process starts (another pid, another start time): it reads the file
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false, self: () => ({ pid: process.pid + 1, boot_at: 1 }) });
    const next = getJob()!;
    expect(next).toMatchObject({ state: 'done', from: '1.0.0', to: '1.1.0', kind: 'update' });
    expect(next.log.length).toBeGreaterThan(3);
    expect(next.log[0]).toMatchObject({ t: expect.any(String), line: expect.any(String) });
    const snap = await getSnapshot();
    expect(snap.rollback).toMatchObject({ available: true, version: '1.0.0' });
    expect(snap.restart_mode).toBe('respawn');
  });

  it('the old process writes nothing once the replacement exists: the replacement\'s `done` is not overwritten with `restarting`', async () => {
    const file = join(data, 'update-job.json');
    _setRestartOverrides({
      spawnChild: () => ({ exited: () => false }),
      waitHealthy: async () => { // (the replacement boots, settles the job file as done, and only then answers the health poll)
        const j = JSON.parse(readFileSync(file, 'utf-8')); j.state = 'done'; j.finished_at = '2026-11-03T12:00:00.000Z'; writeFileSync(file, JSON.stringify(j));
        return true;
      },
    });
    startUpdate();
    await _jobDone();
    await new Promise((r) => setTimeout(r, 1200)); // (past the once-a-second trailing write)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk.state).toBe('done');
    expect(onDisk.log.map((l: { line: string }) => l.line).join('\n')).not.toMatch(/replacement answered/);
  });

  it('supervised: the swap and restart lines are on disk (flushed synchronously) before the stop', async () => {
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false, supervised: () => true });
    let lines = '';
    setRestartControl({ ...ctlStub(calls), gracefulStop: async () => { calls.push('stop'); lines = JSON.parse(readFileSync(join(data, 'update-job.json'), 'utf-8')).log.map((l: { line: string }) => l.line).join('\n'); } });
    startUpdate();
    await _jobDone();
    expect(lines).toMatch(/swapped in/);
    expect(lines).toMatch(/restarting: stopping so the supervisor/);
  });

  it('a `restarting` job written by this very process is still in progress; one written by another process (the predecessor) is done', async () => {
    const mine = { pid: 4242, boot_at: 777 };
    put(data, 'update-job.json', JSON.stringify({ id: 'x', kind: 'update', state: 'restarting', from: '1.0.0', to: '1.1.0', started_at: 'z', finished_at: null, error: null, ...mine, log: [] }));
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false, self: () => mine });
    await initUpdater();
    expect(getJob()!.state).toBe('restarting');
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false, self: () => ({ pid: 4242, boot_at: 888 }) }); // (same pid, as in a container: another start)
    await initUpdater();
    expect(getJob()!.state).toBe('done');
  });

  it('boot: a stage present with a job already `done` does not mark it failed', async () => {
    mkdirSync(join(root, '.update-stage', 'node_modules'), { recursive: true });
    put(data, 'update-job.json', JSON.stringify({ id: 'x', kind: 'update', state: 'done', from: '1.0.0', to: '1.1.0', started_at: 'z', finished_at: '2026-11-03T12:00:00.000Z', error: null, pid: 1, boot_at: 1, log: [] }));
    await initUpdater();
    expect(existsSync(join(root, '.update-stage'))).toBe(false);
    expect(JSON.parse(readFileSync(join(data, 'update-job.json'), 'utf-8'))).toMatchObject({ state: 'done', error: null });
    expect(getJob()).toMatchObject({ state: 'done', error: null });
  });

  it('boot: a swap the pre-boot recovery already put back (its marker is in the stage) says so, even though nothing is left to recover', async () => {
    mkdirSync(join(root, '.update-stage'), { recursive: true });
    writeFileSync(join(root, '.update-stage', '.recovered'), 'x');
    put(data, 'update-job.json', JSON.stringify({ id: 'x', kind: 'update', state: 'restarting', from: '1.0.0', to: '1.1.0', started_at: 'z', finished_at: null, error: null, log: [] }));
    await initUpdater();
    expect(getJob()).toMatchObject({ state: 'failed', error: 'The update did not finish; the previous version was put back.' });
    expect(existsSync(join(root, '.update-stage'))).toBe(false);
  });

  it('a job caught mid-way by a process exit reads as failed (interrupted) and keeps its log', () => {
    put(data, 'update-job.json', JSON.stringify({ id: 'x', kind: 'update', state: 'building', from: '1.0.0', to: null, started_at: '2026-11-03T00:00:00Z', finished_at: null, error: null, log: [{ t: 'z', line: 'npm run build' }] }));
    const j = getJob()!;
    expect(j.state).toBe('failed');
    expect(j.error).toBe('The update did not finish; nothing was changed.');
    expect(j.log).toHaveLength(1);
  });

  it('supervised: the job stops through gracefulStop only (the supervisor starts it again)', async () => {
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false, supervised: () => true });
    setRestartControl(ctlStub(calls));
    startUpdate();
    await _jobDone();
    expect(calls).toEqual(['stop']);
    expect(existsSync(join(data, 'update-job.json'))).toBe(true);
  });
});

describe('an update job: the pause, the boot check and the failure reason', () => {
  let tmp: string, root: string, data: string, archive: string, calls: string[];
  const realFetch = globalThis.fetch;
  const makeArchive = (build: string) => {
    const src = join(tmp, 'src2', 'sanctum-main');
    put(src, 'package.json', pkg('1.1.0')); put(src, 'package-lock.json', lock('1.1.0')); put(src, 'build.js', build);
    const f = join(tmp, 'r2.tar.gz');
    execFileSync('tar', ['-czf', f, '-C', join(tmp, 'src2'), 'sanctum-main']);
    return f;
  };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'updater-job2-'));
    root = join(tmp, 'app'); data = join(root, 'data'); calls = [];
    put(root, 'package.json', pkg('1.0.0')); put(root, 'package-lock.json', lock('1.0.0')); put(root, 'build.js', BUILD_JS);
    execFileSync('node', ['build.js'], { cwd: root });
    archive = makeArchive(BUILD_JS);
    vi.stubGlobal('fetch', async (url: string, init?: unknown) => {
      if (String(url).includes('raw.githubusercontent')) return { ok: true, status: 200, text: async () => JSON.stringify({ version: '1.1.0' }) };
      if (String(url).includes('codeload')) return { ok: true, status: 200, arrayBuffer: async () => readFileSync(archive) };
      return realFetch(url, init as RequestInit);
    });
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false, supervised: () => false });
    setRestartControl(ctlStub(calls));
    _setRestartOverrides({ spawnChild: () => ({ exited: () => false }), waitHealthy: async () => true });
  });
  afterEach(() => { vi.unstubAllGlobals(); _setUpdaterEnv(null); _resetUpdateBlock(); setRestartControl(null); rmSync(tmp, { recursive: true, force: true }); });

  it('new turns and background runs are paused from installing to the end, and resume when the job fails', async () => {
    archive = makeArchive("console.error('x'); process.exit(1);");
    const seen: Array<[string, boolean]> = [];
    const before = cleared.n;
    startUpdate();
    for (let i = 0; i < 400 && getJob()!.state !== 'failed'; i++) { seen.push([getJob()!.state, updateBlocking()]); await new Promise((r) => setTimeout(r, 25)); }
    await _jobDone();
    expect(getJob()!.state).toBe('failed');
    expect(seen.filter(([s]) => s === 'installing' || s === 'building').every(([, b]) => b)).toBe(true);
    expect(seen.filter(([s]) => s === 'checking' || s === 'fetching').every(([, b]) => !b)).toBe(true);
    expect(updateBlocking()).toBe(false); // resumed on failure
    expect(cleared.n).toBeGreaterThan(before); // and the update check forgets its answer
  });

  it('is blocked until the end on success too (the restart)', async () => {
    let during = false;
    setRestartControl({ ...ctlStub(calls), gracefulStop: async () => { during = updateBlocking(); calls.push('stop'); } });
    startUpdate();
    await _jobDone();
    expect(during).toBe(true);
    expect(getJob()!.state).toBe('restarting');
  });

  it('a background run in flight blocks the start (not only a turn)', async () => {
    const end = trackBackgroundStart();
    expect(backgroundRunsInFlight()).toBe(1);
    // the default busy() counts it; the harness busy() here is a stub, so use the real one
    _setUpdaterEnv({ root, dataDir: () => data, supervised: () => false });
    let err: unknown;
    try { startUpdate(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UpdaterError);
    expect((err as UpdaterError).code).toBe('turn_running');
    end();
    expect(backgroundRunsInFlight()).toBe(0);
  });

  it('a failed step puts the last lines of its output in the error', async () => {
    archive = makeArchive("console.log('compiling'); console.error('TS2304: cannot find name x'); console.error('Found 1 error'); process.exit(2);");
    startUpdate();
    await _jobDone();
    const j = getJob()!;
    expect(j.state).toBe('failed');
    expect(j.error).toMatch(/^npm run build failed \(exit \d+\)/);
    expect(j.error).toContain('TS2304: cannot find name x');
    expect(j.error).toContain('Found 1 error');
    expect(readFileSync(join(root, 'package.json'), 'utf-8')).toContain('"1.0.0"'); // the running folder was never touched
    expect(existsSync(join(root, '.update-stage'))).toBe(false);
  });

  it('boot: a stage left by a crash is deleted and the job is failed "did not finish; nothing was changed"', async () => {
    mkdirSync(join(root, '.update-stage', 'node_modules'), { recursive: true });
    put(data, 'update-job.json', JSON.stringify({ id: 'x', kind: 'update', state: 'building', from: '1.0.0', to: null, started_at: '2026-11-03T00:00:00Z', finished_at: null, error: null, log: [{ t: 'z', line: 'npm run build' }] }));
    await initUpdater();
    expect(existsSync(join(root, '.update-stage'))).toBe(false);
    const j = JSON.parse(readFileSync(join(data, 'update-job.json'), 'utf-8'));
    expect(j.state).toBe('failed');
    expect(j.error).toBe('The update did not finish; nothing was changed.');
    expect(j.finished_at).toEqual(expect.any(String));
    expect(getJob()!.log).toHaveLength(1);
  });

  it('boot: a restarting job becomes done at boot (finished_at set then, on disk), before anything asks', async () => {
    put(data, 'update-job.json', JSON.stringify({ id: 'x', kind: 'update', state: 'restarting', from: '1.0.0', to: '1.1.0', started_at: '2026-11-03T00:00:00Z', finished_at: null, error: null, log: [] }));
    const at = new Date('2026-11-03T12:00:00Z');
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false, now: () => at });
    await initUpdater();
    const onDisk = JSON.parse(readFileSync(join(data, 'update-job.json'), 'utf-8'));
    expect(onDisk).toMatchObject({ state: 'done', finished_at: at.toISOString() });
  });

  it('boot: a swap cut short is put back, and the job says so', async () => {
    put(root, 'packages/backend/dist/server.js', 'NEW');
    const dir = join(root, '.update-rollback', '1.0.0');
    put(dir, 'files/packages/backend/dist/server.js', 'OLD');
    put(dir, 'manifest.json', JSON.stringify({ version: '1.0.0', mode: 'tarball', phase: 'swapping', entries: [{ path: 'packages/backend/dist', kind: 'dir', how: 'moved' }] }));
    put(data, 'update-job.json', JSON.stringify({ id: 'x', kind: 'update', state: 'restarting', from: '1.0.0', to: '1.1.0', started_at: '2026-11-03T00:00:00Z', finished_at: null, error: null, log: [] }));
    await initUpdater();
    expect(readFileSync(join(root, 'packages/backend/dist/server.js'), 'utf-8')).toBe('OLD');
    expect(existsSync(join(root, '.update-rollback'))).toBe(false);
    expect(getJob()).toMatchObject({ state: 'failed', error: 'The update did not finish; the previous version was put back.' });
  });
});
