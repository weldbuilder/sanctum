// The in-app updater: the restart sequence with its spawn and health poll stubbed (the test process never restarts), and a whole job on a fake folder.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('./update-check.js', () => ({
  checkForUpdate: async () => ({ version: '1.0.0', latest: '1.1.0', update_available: true, repo: 'echo/sanctum', branch: 'main', checked_at: '2026-11-03T00:00:00.000Z' }),
}));

import {
  _jobDone, _setRestartOverrides, _setUpdaterEnv, getJob, getSnapshot, performRestart, setRestartControl, startUpdate, type RestartControl,
} from './updater.js';

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
  afterEach(() => { vi.unstubAllGlobals(); _setUpdaterEnv(null); setRestartControl(null); rmSync(tmp, { recursive: true, force: true }); });

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
    // the replacement process starts: it reads the file
    _setUpdaterEnv({ root, dataDir: () => data, busy: () => false });
    const next = getJob()!;
    expect(next).toMatchObject({ state: 'done', from: '1.0.0', to: '1.1.0', kind: 'update' });
    expect(next.log.length).toBeGreaterThan(3);
    expect(next.log[0]).toMatchObject({ t: expect.any(String), line: expect.any(String) });
    const snap = await getSnapshot();
    expect(snap.rollback).toMatchObject({ available: true, version: '1.0.0' });
    expect(snap.restart_mode).toBe('respawn');
  });

  it('a job caught mid-way by a process exit reads as failed (interrupted) and keeps its log', () => {
    put(data, 'update-job.json', JSON.stringify({ id: 'x', kind: 'update', state: 'building', from: '1.0.0', to: null, started_at: '2026-11-03T00:00:00Z', finished_at: null, error: null, log: [{ t: 'z', line: 'npm run build' }] }));
    const j = getJob()!;
    expect(j.state).toBe('failed');
    expect(j.error).toMatch(/stopped while this was running/);
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
