// The in-app updater: one update (or roll back) job at a time, run by the same step functions `npm run update` uses
// (scripts/updater-core.mjs), with its progress kept in <data dir>/update-job.json so it survives the restart it ends with.
//
// States: checking, fetching, installing, building, restarting, done, failed, rolled_back. A job that was `restarting` when the process
// went away is `done` (or `rolled_back`, for a roll back) when the next process starts; one caught earlier is `failed` ("interrupted").
//
// Restart, two modes (docs/CONFIGURATION.md, "Updating"):
//   supervised   `pm_id` (pm2) or SANCTUM_SUPERVISED=1 is in the environment: the app stops gracefully and exits 0; the supervisor starts it again.
//   respawn      anything else: close the listener, start a detached replacement (`node dist/server.js`, same cwd and environment, output in
//                <data dir>/update-restart.log), wait for it to answer /api/health on the same port, then stop and exit. If it never answers,
//                this process listens again and the job is `failed` (the previous version's files are put back).
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT, getSanctumConfig } from '../config.js';
import { bootedTenants, getProcessConfig, runInTenant, tenancyEnabled } from '../tenancy/context.js';
import { householdMode, houseCompanionIds } from '../tenancy/house.js';
import { isInteractiveAgentBusy } from './agent.js';
import { checkForUpdate, type UpdateStatus } from './update-check.js';
import {
  UpdateError, clearRollback, readEnvFile, readUpdateSettings, rollbackInfo, rollbackNow, runRollback, runUpdate, selfUpdateSupport,
  type RollbackInfo, type SelfUpdateSupport,
} from '../../../../scripts/updater-core.mjs';

export type JobState = 'checking' | 'fetching' | 'installing' | 'building' | 'restarting' | 'done' | 'failed' | 'rolled_back';
export interface JobLine { t: string; line: string }
export interface UpdateJob {
  id: string;
  kind: 'update' | 'rollback';
  state: JobState;
  from: string;
  to: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  /** Files of a git checkout that kept the update from running (the list shown to the person). */
  dirty: string[] | null;
  /** The new version is installed but the restart did not happen (a turn kept running); restart the app to finish. */
  restart_pending: boolean;
  log: JobLine[];
}

export class UpdaterError extends Error {
  constructor(public status: number, public code: 'running' | 'turn_running' | 'unsupported' | 'no_rollback', message: string) { super(message); }
}

const ACTIVE: JobState[] = ['checking', 'fetching', 'installing', 'building', 'restarting'];
const MAX_LOG = 400;
const MAX_LINE = 400;

// ---- where things live (a test points these elsewhere) ----------------------------
export interface UpdaterEnv {
  root: string;
  dataDir(): string;
  /** Is a conversation turn running anywhere in this process? */
  busy(): boolean;
  supervised(): boolean;
  now(): Date;
}
function defaultDataDir(): string {
  // The process's own data folder (the one holding sanctum.db, house.db), never a companion's.
  const cfg = tenancyEnabled() ? getProcessConfig() : getSanctumConfig();
  return dirname(cfg.server.db_path);
}
function defaultBusy(): boolean {
  if (!tenancyEnabled()) return isInteractiveAgentBusy();
  return bootedTenants().some((rt) => runInTenant(rt, () => isInteractiveAgentBusy()));
}
const defaultEnv: UpdaterEnv = {
  root: PROJECT_ROOT,
  dataDir: defaultDataDir,
  busy: defaultBusy,
  supervised: () => !!process.env.pm_id || process.env.SANCTUM_SUPERVISED === '1',
  now: () => new Date(),
};
let env: UpdaterEnv = defaultEnv;
/** Test hook. */
export function _setUpdaterEnv(e: Partial<UpdaterEnv> | null): void { env = e ? { ...defaultEnv, ...e } : defaultEnv; job = null; loaded = false; control = null; restartOverrides = {}; }

// ---- the job and its file ------------------------------------------------------------
let job: UpdateJob | null = null;
let loaded = false;
let lastWrite = 0;
const jobFile = () => join(env.dataDir(), 'update-job.json');

function persist(force = true): void {
  if (!job) return;
  const t = Date.now();
  if (!force && t - lastWrite < 1000) return;
  lastWrite = t;
  try {
    mkdirSync(env.dataDir(), { recursive: true });
    const tmp = `${jobFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, jobFile());
  } catch (err) { console.warn('[updater] could not write update-job.json:', (err as Error).message); }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const j = JSON.parse(readFileSync(jobFile(), 'utf-8')) as UpdateJob;
    if (!j || typeof j.state !== 'string') return;
    job = { ...j, dirty: j.dirty ?? null, restart_pending: !!j.restart_pending };
    if (job.state === 'restarting') {
      // The process this job ended with has been replaced: this is the new one.
      job.state = job.kind === 'rollback' ? 'rolled_back' : 'done';
      job.finished_at = env.now().toISOString();
      addLine(job.kind === 'rollback' ? 'restarted on the previous version' : 'restarted on the new version');
      persist();
    } else if (ACTIVE.includes(job.state)) {
      job.state = 'failed';
      job.error = 'The app stopped while this was running. Check the log; a rollback copy may be available.';
      job.finished_at = env.now().toISOString();
      persist();
    }
  } catch { /* no job yet */ }
}

function addLine(line: string): void {
  if (!job) return;
  job.log.push({ t: env.now().toISOString(), line: line.slice(0, MAX_LINE) });
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  persist(false);
}
function setState(s: JobState): void {
  if (!job) return;
  job.state = s;
  persist();
}

export function getJob(): UpdateJob | null { load(); return job; }
export function jobRunning(): boolean { load(); return !!job && ACTIVE.includes(job.state); }

// ---- the restart ----------------------------------------------------------------------
/** What server.ts hands over so the updater can stop and re-open the listener. */
export interface RestartControl {
  /** Stop accepting and drop open connections (websockets included); resolves once the port is free. Services keep running. */
  closeListener(): Promise<void>;
  /** Listen again on the same port (the replacement never came up). */
  relisten(): void;
  /** The full graceful stop (services, channels, databases), ending in process.exit(0). */
  gracefulStop(): Promise<void>;
  /** Where the replacement will answer, e.g. http://127.0.0.1:3099/api/health. */
  healthUrl: string;
}
let control: RestartControl | null = null;
export function setRestartControl(c: RestartControl | null): void { control = c; }
/** Test hook: stand-ins for the spawn and the health poll (the test process must never start a real replacement). */
let restartOverrides: Partial<Pick<RestartDeps, 'spawnChild' | 'waitHealthy' | 'healthTimeoutMs'>> = {};
export function _setRestartOverrides(o: typeof restartOverrides): void { restartOverrides = o; }

export interface RestartDeps {
  supervised: boolean;
  ctl: RestartControl;
  /** Start the replacement; `exited()` says whether it already died. */
  spawnChild(): { exited(): boolean };
  /** Resolves true when `url` answers 200 within `ms`, false when it does not (or when the child died). */
  waitHealthy(url: string, ms: number, childExited: () => boolean): Promise<boolean>;
  log(line: string): void;
  healthTimeoutMs?: number;
}
/** Stop this process in whichever way the mode asks. 'stopping': the process is on its way out (gracefulStop was called). 'failed': the replacement never came up and this process listens again. */
export async function performRestart(d: RestartDeps): Promise<'stopping' | 'failed'> {
  if (d.supervised) {
    d.log('restarting: stopping so the supervisor (pm2 or the like) starts the app again');
    await d.ctl.gracefulStop();
    return 'stopping';
  }
  d.log('restarting: closing the listener and starting a replacement');
  await d.ctl.closeListener();
  let child: { exited(): boolean };
  try { child = d.spawnChild(); } catch (err) {
    d.log(`could not start a replacement: ${(err as Error).message}`);
    d.ctl.relisten();
    return 'failed';
  }
  const ok = await d.waitHealthy(d.ctl.healthUrl, d.healthTimeoutMs ?? 60_000, child.exited);
  if (!ok) {
    d.log('the replacement did not answer in time; this process listens again');
    d.ctl.relisten();
    return 'failed';
  }
  d.log('the replacement answered; stopping this process');
  await d.ctl.gracefulStop();
  return 'stopping';
}

async function waitHealthy(url: string, ms: number, childExited: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (childExited()) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function spawnReplacement(): { exited(): boolean } {
  const entry = join(PROJECT_ROOT, 'packages', 'backend', 'dist', 'server.js');
  const script = existsSync(entry) ? entry : process.argv[1];
  mkdirSync(env.dataDir(), { recursive: true });
  const fd = openSync(join(env.dataDir(), 'update-restart.log'), 'a');
  try {
    const child = spawn(process.execPath, [script], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', fd, fd] });
    let done = false;
    child.on('exit', () => { done = true; });
    child.on('error', () => { done = true; });
    child.unref();
    return { exited: () => done };
  } finally { closeSync(fd); }
}

async function restartNow(): Promise<void> {
  if (!job) return;
  if (!control) { // nothing wired (a test, or a harness that is not server.ts): the files are updated, the person restarts
    job.restart_pending = true;
    addLine('installed. Restart the app to finish.');
    finish(job.kind === 'rollback' ? 'rolled_back' : 'done');
    return;
  }
  // A turn may have started while the build ran: give it up to five minutes before deciding.
  for (let i = 0; i < 150 && env.busy(); i++) {
    if (i === 0) addLine('waiting for the running turn to finish before restarting');
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (env.busy()) {
    job.restart_pending = true;
    addLine('a turn is still running, so the app was not restarted. Restart it when the turn is done.');
    finish(job.kind === 'rollback' ? 'rolled_back' : 'done');
    return;
  }
  setState('restarting');
  const result = await performRestart({
    supervised: env.supervised(), ctl: control, spawnChild: spawnReplacement, waitHealthy, log: addLine, ...restartOverrides,
  });
  if (result === 'failed') {
    // The new process would not start: put the previous files back so the next start is the old version, and say so.
    let restored = false;
    if (job.kind === 'update') {
      try { await rollbackNow({ root: env.root, dataDir: env.dataDir(), log: addLine, force: true, depsTouched: true }); clearRollback(env.dataDir()); restored = true; }
      catch (err) { addLine(`could not put the previous version back: ${(err as Error).message}`); }
    }
    job.error = `The new version did not start${restored ? ', so the previous version was put back' : ''}. The app is still running as it was. See ${join(env.dataDir(), 'update-restart.log')}.`;
    finish('failed');
  }
}

function finish(state: JobState): void {
  if (!job) return;
  job.state = state;
  job.finished_at = env.now().toISOString();
  persist();
}

// ---- guards -------------------------------------------------------------------------------
function guard(): void {
  load();
  if (jobRunning()) throw new UpdaterError(409, 'running', 'An update is already running.');
  // (There is no "tenant start in flight" state to ask: tenants boot before the listener opens.) A turn running in any companion blocks.
  if (env.busy()) throw new UpdaterError(409, 'turn_running', 'A conversation turn is running. Try again when it has finished.');
}
function newJob(kind: UpdateJob['kind']): UpdateJob {
  const from = readFromVersion();
  job = { id: `${Date.now().toString(36)}`, kind, state: 'checking', from, to: null, started_at: env.now().toISOString(), finished_at: null, error: null, dirty: null, restart_pending: false, log: [] };
  persist();
  return job;
}
function readFromVersion(): string {
  try { return JSON.parse(readFileSync(join(env.root, 'package.json'), 'utf-8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

// ---- the jobs -----------------------------------------------------------------------------
/** Start an update. Returns the job at once; it runs in the background. Throws UpdaterError (409 / unsupported). */
export function startUpdate(): UpdateJob {
  guard();
  const support = selfUpdateSupport(env.root);
  if (!support.ok) throw new UpdaterError(409, 'unsupported', support.reason ?? 'This install cannot update itself.');
  const j = newJob('update');
  void executeUpdate();
  return j;
}
let running: Promise<void> | null = null;
/** Resolves when the current job's work (up to the restart decision) is over. A test awaits it. */
export function _jobDone(): Promise<void> { return running ?? Promise.resolve(); }

async function executeUpdate(): Promise<void> {
  running = (async () => {
    try {
      readEnvFile(env.root);
      const dataDir = env.dataDir();
      const result = await runUpdate({
        root: env.root, dataDir, log: addLine, setState: (s) => setState(s as JobState),
        settings: await readUpdateSettings(env.root),
      });
      if (result.upToDate) { addLine('nothing to update'); finish('done'); return; }
      if (job) job.to = result.to;
      await restartNow();
    } catch (err) {
      if (!job) return;
      if (err instanceof UpdateError) { job.error = err.message; job.dirty = err.dirty ?? null; if (err.restored) addLine('the previous version was put back'); }
      else job.error = (err as Error).message;
      addLine(`failed: ${job.error.split('\n')[0]}`);
      finish('failed');
    }
  })();
  await running;
}

/** Start a roll back to the latest rollback copy. Throws UpdaterError. */
export function startRollback(): UpdateJob {
  guard();
  if (!rollbackInfo(env.dataDir()).available) throw new UpdaterError(409, 'no_rollback', 'There is no rollback copy.');
  const j = newJob('rollback');
  running = (async () => {
    try {
      setState('installing');
      const r = await runRollback({ root: env.root, dataDir: env.dataDir(), log: addLine });
      if (job) job.to = r.version;
      await restartNow();
    } catch (err) {
      if (!job) return;
      job.error = (err as Error).message;
      if (err instanceof UpdateError) job.dirty = err.dirty ?? null;
      addLine(`failed: ${job.error.split('\n')[0]}`);
      finish('failed');
    }
  })();
  return j;
}

// ---- what the routes show --------------------------------------------------------------------
export interface UpdateSnapshot extends Omit<UpdateStatus, 'error'> {
  error?: string;
  self_update: SelfUpdateSupport;
  restart_mode: 'supervised' | 'respawn';
  household: boolean;
  companions: number;
  job: UpdateJob | null;
  rollback: Pick<RollbackInfo, 'available' | 'version' | 'created_at'>;
}
export async function getSnapshot(opts: { force?: boolean } = {}): Promise<UpdateSnapshot> {
  load();
  const status = await checkForUpdate({ force: opts.force });
  const rb = rollbackInfo(env.dataDir());
  return {
    ...status,
    self_update: selfUpdateSupport(env.root),
    restart_mode: env.supervised() ? 'supervised' : 'respawn',
    household: householdMode(),
    companions: householdMode() ? houseCompanionIds().length : 1,
    job,
    rollback: { available: rb.available, version: rb.version, created_at: rb.created_at },
  };
}
