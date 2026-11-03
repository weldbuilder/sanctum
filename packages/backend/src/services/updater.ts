// The in-app updater: one update (or roll back) job at a time, run by the same step functions `npm run update` uses
// (scripts/updater-core.mjs), with its progress kept in <data dir>/update-job.json so it survives the restart it ends with.
//
// The update is STAGED: the new version is fetched, installed and built in <app>/.update-stage/ while the app keeps running untouched.
// Only at restart time, after the turn fence, does one quick swap (a fast-forward and some renames) put it in place, the previous
// node_modules, dist and build going to <app>/.update-rollback/. A crash before the swap changes nothing; the stage is deleted at the next boot.
//
// States: checking, fetching, installing, building, restarting, done, failed, rolled_back. A job that was `restarting` when the process
// went away is `done` (or `rolled_back`, for a roll back) when the next process starts (initUpdater, at boot); one caught earlier is `failed`
// ("did not finish; nothing was changed"). While a job is installing, building or restarting new turns are refused and background runs wait
// (services/update-block.ts).
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
import { backgroundRunsInFlight, setUpdateBlocking } from './update-block.js';
import { bootedTenants, getProcessConfig, runInTenant, tenancyEnabled } from '../tenancy/context.js';
import { householdMode, houseCompanionIds } from '../tenancy/house.js';
import { isInteractiveAgentBusy } from './agent.js';
import { checkForUpdate, clearUpdateCache, type UpdateStatus } from './update-check.js';
import {
  UpdateError, applyStaged, clearRollback, discardStage, killAllChildren, readEnvFile, readUpdateSettings, recoverInterruptedSwap, rollbackInfo, rollbackNow,
  runRollback, selfUpdateSupport, stageUpdate, takeRecoveredMarker, type RollbackInfo, type SelfUpdateSupport, type StagedPlan,
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
  /** The process that last wrote the job (its pid, and the moment it started: a container's pid is the same every time, the start is not). A `restarting` job
   *  written by another process than the one reading it is the predecessor's hand-over; one written by this process is still in progress. */
  pid?: number;
  boot_at?: number;
  log: JobLine[];
}

export class UpdaterError extends Error {
  constructor(public status: number, public code: 'running' | 'turn_running' | 'unsupported' | 'no_rollback', message: string) { super(message); }
}

const ACTIVE: JobState[] = ['checking', 'fetching', 'installing', 'building', 'restarting'];
/** Between these states new turns are refused and background runs wait. */
const BLOCKING: JobState[] = ['installing', 'building', 'restarting'];
/** When this process started (ms), stable for its life: with the pid it names this process. */
const BOOT_AT = Math.round(Date.now() - process.uptime() * 1000);
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
  /** Which process this is (a test stands in another one to play the replacement reading the job file). */
  self(): { pid: number; boot_at: number };
}
function defaultDataDir(): string {
  // The process's own data folder (the one holding sanctum.db, house.db), never a companion's.
  const cfg = tenancyEnabled() ? getProcessConfig() : getSanctumConfig();
  return dirname(cfg.server.db_path);
}
function defaultBusy(): boolean {
  if (backgroundRunsInFlight() > 0) return true; // the author, handoff, digest and summarizer run outside the query queue
  if (!tenancyEnabled()) return isInteractiveAgentBusy();
  return bootedTenants().some((rt) => runInTenant(rt, () => isInteractiveAgentBusy()));
}
const defaultEnv: UpdaterEnv = {
  root: PROJECT_ROOT,
  dataDir: defaultDataDir,
  busy: defaultBusy,
  supervised: () => !!process.env.pm_id || process.env.SANCTUM_SUPERVISED === '1',
  now: () => new Date(),
  self: () => ({ pid: process.pid, boot_at: BOOT_AT }),
};
let env: UpdaterEnv = defaultEnv;
/** Test hook. */
export function _setUpdaterEnv(e: Partial<UpdaterEnv> | null): void {
  env = e ? { ...defaultEnv, ...e } : defaultEnv; job = null; loaded = false; control = null; restartOverrides = {};
  if (trailing) { clearTimeout(trailing); trailing = null; }
  abort = null; bootFinding = null; handedOver = false; setUpdateBlocking(false);
}

// ---- the job and its file ------------------------------------------------------------
let job: UpdateJob | null = null;
let loaded = false;
let lastWrite = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;
let abort: AbortController | null = null;
/** Set once a replacement process (or the supervisor's) has been handed the job file: from then on this process writes nothing more to it, so its last
 *  words ("the replacement answered") cannot land on top of what the new process wrote (`done`). Cleared again if the hand-over fails. */
let handedOver = false;
/** What boot cleanup found (initUpdater): a stage left behind, or a swap that was cut short and put back. */
let bootFinding: { stage: boolean; swap: boolean } | null = null;
const jobFile = () => join(env.dataDir(), 'update-job.json');

function writeJob(): void {
  if (!job || handedOver) return;
  lastWrite = Date.now();
  try {
    mkdirSync(env.dataDir(), { recursive: true });
    const tmp = `${jobFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, jobFile());
  } catch (err) { console.warn('[updater] could not write update-job.json:', (err as Error).message); }
}
/** Write the job file now, synchronously, unless it was handed over. The graceful stop calls this just before process.exit, so lines still waiting for the
 *  once-a-second write are on disk first. */
export function flushUpdateJob(): void {
  if (trailing) { clearTimeout(trailing); trailing = null; }
  writeJob();
}
/** Write the job file now (`force`), or at most once a second with a trailing write, so the file never goes stale behind a quiet log. */
function persist(force = true): void {
  if (!job) return;
  if (force) { if (trailing) { clearTimeout(trailing); trailing = null; } writeJob(); return; }
  const wait = 1000 - (Date.now() - lastWrite);
  if (wait <= 0) { if (trailing) { clearTimeout(trailing); trailing = null; } writeJob(); return; }
  if (trailing) return;
  trailing = setTimeout(() => { trailing = null; writeJob(); }, wait);
  trailing.unref?.();
}

function interruptedText(kind: UpdateJob['kind']): string {
  if (bootFinding?.swap) return `The ${kind === 'rollback' ? 'roll back' : 'update'} did not finish; the previous version was put back.`;
  return kind === 'rollback'
    ? 'The roll back did not finish. The rollback copy is still there; try again, or run: npm run update -- --rollback'
    : 'The update did not finish; nothing was changed.';
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const j = JSON.parse(readFileSync(jobFile(), 'utf-8')) as UpdateJob;
    if (!j || typeof j.state !== 'string') return;
    job = { ...j, dirty: j.dirty ?? null, restart_pending: !!j.restart_pending };
    // `restarting` written by another process than this one (its predecessor), with no stage left and no cut-short swap: the swap finished and this is
    // the process that replaced it. A `restarting` this very process wrote is still in progress, and a job already `done` is never touched.
    const me = env.self();
    const mine = j.pid === me.pid && j.boot_at === me.boot_at;
    if (job.state === 'restarting' && mine) { /* in progress here */ }
    else if (job.state === 'restarting' && !bootFinding?.stage && !bootFinding?.swap) {
      job.state = job.kind === 'rollback' ? 'rolled_back' : 'done';
      job.finished_at = env.now().toISOString();
      addLine(job.kind === 'rollback' ? 'restarted on the previous version' : 'restarted on the new version');
      persist();
    } else if (ACTIVE.includes(job.state)) {
      job.state = 'failed';
      job.error = interruptedText(job.kind);
      job.finished_at = env.now().toISOString();
      persist();
    }
  } catch { /* no job yet */ }
}

/** At boot, before the listener opens: put a cut-short swap back, delete a stage a crash left (and any build it left running), and settle the
 *  job file (`restarting` becomes `done`, with `finished_at` set now; anything earlier becomes `failed`: nothing was changed). */
export async function initUpdater(): Promise<void> {
  loaded = false; job = null;
  const finding = { stage: false, swap: false };
  // (The pre-boot recovery, src/update-recover.ts, has normally put a cut-short swap back already, before this process loaded the app, and left a marker in the
  // stage; the call here is for a swap that was cut short in this very process's life.)
  try { finding.swap = takeRecoveredMarker(env.root); } catch { /* no marker */ }
  try { finding.swap = (await recoverInterruptedSwap(env.root, console.log)) || finding.swap; } catch (err) { console.warn('[updater] could not check for a cut-short swap:', (err as Error).message); }
  try { finding.stage = await discardStage(env.root, console.log); } catch (err) { console.warn('[updater] could not remove the update stage:', (err as Error).message); }
  bootFinding = finding;
  load();
  clearUpdateCache();
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
  job.pid = env.self().pid; job.boot_at = env.self().boot_at;
  setUpdateBlocking(BLOCKING.includes(s));
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
  /** Write the job file now and synchronously (before the listener closes or the process stops). */
  flush?(): void;
  /** True once the next process owns the job file (this one writes nothing more); false again if the hand-over failed. */
  handOver?(on: boolean): void;
}
/** Stop this process in whichever way the mode asks. 'stopping': the process is on its way out (gracefulStop was called). 'failed': the replacement never came up and this process listens again. */
export async function performRestart(d: RestartDeps): Promise<'stopping' | 'failed'> {
  if (d.supervised) {
    d.log('restarting: stopping so the supervisor (pm2 or the like) starts the app again');
    d.flush?.(); // (the last lines are on disk before the stop; the stop itself ends in process.exit)
    d.handOver?.(true);
    await d.ctl.gracefulStop();
    return 'stopping';
  }
  d.log('restarting: closing the listener and starting a replacement');
  d.flush?.();
  await d.ctl.closeListener();
  let child: { exited(): boolean };
  d.handOver?.(true); // (before the replacement exists: it settles the job file at its own boot, and nothing of this process may land on top of that)
  try { child = d.spawnChild(); } catch (err) {
    d.handOver?.(false);
    d.log(`could not start a replacement: ${(err as Error).message}`);
    d.ctl.relisten();
    return 'failed';
  }
  const ok = await d.waitHealthy(d.ctl.healthUrl, d.healthTimeoutMs ?? 60_000, child.exited);
  if (!ok) {
    d.handOver?.(false);
    d.log('the replacement did not answer in time; this process listens again');
    d.ctl.relisten();
    return 'failed';
  }
  d.log('the replacement answered; stopping this process'); // (in memory only: the job file belongs to the replacement now)
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

/** Wait (up to five minutes) for a turn that is still running; true when nothing is. */
async function turnFence(): Promise<boolean> {
  for (let i = 0; i < 150 && env.busy(); i++) {
    if (i === 0) addLine('waiting for the running turn to finish before restarting');
    await new Promise((r) => setTimeout(r, 2000));
  }
  return !env.busy();
}

/** Finish the job: the swap (an update's staged build, or a roll back's copy) and the restart, after the turn fence. `plan` is the staged update. */
async function restartNow(plan?: StagedPlan): Promise<void> {
  if (!job) return;
  const kind = job.kind;
  const doneState: JobState = kind === 'rollback' ? 'rolled_back' : 'done';
  /** The swap itself. Throws UpdateError with the files put back. */
  let noop = false;
  const swap = async (): Promise<void> => {
    if (plan) {
      const r = await applyStaged({ root: env.root, plan, log: addLine });
      if (r.upToDate) noop = true; else if (job) job.to = r.to;
    } else { const r = await runRollback({ root: env.root, log: addLine }); if (job) job.to = r.version; }
  };
  const failSwap = async (err: unknown) => {
    if (!job) return;
    job.error = (err as Error).message;
    if (err instanceof UpdateError) job.dirty = err.dirty ?? null;
    addLine(`failed: ${job.error.split('\n')[0]}`);
    finish('failed');
  };
  if (!control) { // nothing wired (a test, or a harness that is not server.ts): swap now, the person restarts
    try { await swap(); } catch (err) { await failSwap(err); return; }
    if (noop) { addLine(`already on ${job.from}; nothing to restart`); finish('done'); return; }
    job.restart_pending = true;
    addLine('installed. Restart the app to finish.');
    finish(doneState);
    return;
  }
  // A turn may have started while the build ran: give it up to five minutes before deciding. Nothing has changed yet, so giving up is free.
  if (!(await turnFence())) {
    if (plan) await discardStage(env.root, addLine).catch(() => {});
    job.error = 'A conversation turn kept running, so nothing was changed. Try again when it has finished.';
    addLine(`failed: ${job.error}`);
    finish('failed');
    return;
  }
  setState('restarting');
  try { await swap(); } catch (err) { await failSwap(err); return; }
  if (noop) { addLine(`already on ${job.from}; nothing to restart`); finish('done'); return; }
  const result = await performRestart({
    supervised: env.supervised(), ctl: control, spawnChild: spawnReplacement, waitHealthy, log: addLine,
    flush: () => persist(true), handOver: (on) => { handedOver = on; }, ...restartOverrides,
  });
  if (result === 'failed') {
    // The new process would not start: put the previous files back so the next start is the old version, and say so.
    let restored = false;
    if (kind === 'update') {
      try { await rollbackNow({ root: env.root, log: addLine, force: true }); clearRollback(env.root); restored = true; }
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
  setUpdateBlocking(false); // new turns and background runs resume (a failure ends the pause as much as a success)
  clearUpdateCache(); // the installed version may have changed: the next check reads it again
  persist();
}

/** Stop the job's build children (npm, tsc, vite: each its own process group) and any stage work. For shutdown, and for an abort. */
export function stopUpdateWork(): void {
  abort?.abort();
  killAllChildren();
}

// ---- guards -------------------------------------------------------------------------------
function guard(): void {
  load();
  if (jobRunning()) throw new UpdaterError(409, 'running', 'An update is already running.');
  // (There is no "tenant start in flight" state to ask: tenants boot before the listener opens.) A turn running in any companion blocks,
  // and so does a background model run (the author, handoff, digest, summarizer).
  if (env.busy()) throw new UpdaterError(409, 'turn_running', 'A conversation turn or a background run is in progress. Try again when it has finished.');
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
    abort = new AbortController();
    try {
      readEnvFile(env.root);
      const plan = await stageUpdate({
        root: env.root, log: addLine, setState: (s) => setState(s as JobState),
        settings: await readUpdateSettings(env.root), signal: abort.signal,
      });
      if (plan.upToDate) { addLine('nothing to update'); finish('done'); return; }
      if (job) job.to = plan.to;
      await restartNow(plan);
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

/** Start a roll back to the latest rollback copy. The copy is put back at restart time, after the turn fence. Throws UpdaterError. */
export function startRollback(): UpdateJob {
  guard();
  if (!rollbackInfo(env.root).available) throw new UpdaterError(409, 'no_rollback', 'There is no rollback copy.');
  const j = newJob('rollback');
  running = (async () => {
    try {
      setState('installing');
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
  const rb = rollbackInfo(env.root);
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
