// updater-core.mjs — the update steps, shared by `npm run update` (scripts/update.mjs) and the in-app
// updater (packages/backend/src/services/updater.ts). One implementation, so the terminal and the app do
// the same thing, rollback copy included. Plain JS, no dependencies beyond node (js-yaml is read lazily, and a
// missing one falls back to a small reader, so `--rollback` works when the app cannot boot).
//
// The design: the update is STAGED, and nothing in the running folder changes until the stage is fully built.
//
//   stageUpdate   checking    read the settings, ask GitHub for the newest version
//                 (git)       refuse a dirty tree (the list is the error), refuse a checkout that is not on the update branch,
//                             refuse a branch that cannot fast-forward
//                 fetching    git fetch + a git worktree of the target commit in <app>/.update-stage/, or the tarball unpacked there
//                 installing  npm ci --include=dev IN THE STAGE (npm install only when there is no lockfile)
//                 building    npm run build IN THE STAGE
//   applyStaged   (the swap, one quick step, run at restart time after the turn fence)
//                 clean-tree check again (git), `git merge --ff-only` to the staged commit, then rename the stage's node_modules,
//                 packages/*/dist and packages/frontend/build into place, the previous ones going to <app>/.update-rollback.next/ (moved over
//                 the previous .update-rollback/ only once the swap has succeeded);
//                 a downloaded folder also gets its staged tracked files moved over (and the replaced ones copied to the rollback).
//
// A crash, a kill or a failed install or build before the swap leaves the running folder exactly as it was (the stage is
// deleted at the next start). A failure during the swap puts everything back, and a swap cut short is put back by recoverInterruptedSwap before the app
// loads (packages/backend/boot.mjs, whose vendored recovery is scripts/boot-recover.mjs, which this file builds its restore on; also `npm start` and `npm run update`). A rollback moves the previous copies back
// (and `git reset --hard <sha>` on a git checkout), so node_modules comes back with the code.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
// The restore, the manifest and the recovery after a crash are the vendored, dependency-free module (the same rules the app's own packages/backend/boot.mjs follows).
import { MACHINE, MANIFEST_FORMAT, ensureExcluded, readManifest, recover, restoreCopy, restoreFiles, takeRecoveryResult, unsettled, verifyRestored, writeManifest } from './boot-recover.mjs';
export { restoreFiles, takeRecoveryResult, recover as recoverDetailed };

const noop = () => {};

export class UpdateError extends Error {
  constructor(message, { restored = false, dirty } = {}) {
    super(message);
    this.name = 'UpdateError';
    this.restored = restored;
    this.dirty = dirty;
  }
}

// ---- settings ---------------------------------------------------------------
export function readEnvFile(root) {
  const p = join(root, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
/** "owner/name" from package.json's repository line: "github:owner/name", "https://github.com/owner/name.git", or { url }. */
export function repoFromPackage(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = /(?:github:|github\.com[/:])([^/\s]+\/[^/\s#]+?)(?:\.git)?\/?$/.exec(r) || /^([^/\s]+\/[^/\s]+)$/.exec(r);
  return m ? m[1] : '';
}
/** The folder the database lives in (and update-job.json): the same place the app uses. */
export function dataDirFor(root, dbPath) { return dirname(resolve(root, dbPath || './data/sanctum.db')); }
export function readVersion(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

/** A minimal reader for the few nested `key: value` lines the updater needs (updates, agent, server), for when js-yaml is not installed.
 *  Maps by indentation, scalars only (quotes stripped, comments dropped); lists and anything fancier are skipped. */
export function miniYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    let val = m[3].replace(/\s+#.*$/, '').trim();
    if (val === '' || val === '|' || val === '>') { const child = {}; parent[m[2]] = child; stack.push({ indent, obj: child }); continue; }
    val = val.replace(/^(["'])(.*)\1$/, '$2');
    parent[m[2]] = val;
  }
  return root;
}
async function loadYaml(text) {
  try { return (await import('js-yaml')).default.load(text) || {}; } catch { return miniYaml(text); }
}

/** { repo, branch, cwd, dbPath, repoExplicit } for an install folder. `cwd` is the companion's agent.cwd as written ('.' when unset).
 *  `repoExplicit` is true when updates.repo (or SANCTUM_REPO) named the repository, false when it came from package.json. */
export async function readUpdateSettings(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const out = { repo: repoFromPackage(pkg), branch: 'main', cwd: '.', dbPath: './data/sanctum.db', repoExplicit: false };
  for (const name of ['sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const cfg = await loadYaml(readFileSync(p, 'utf-8'));
      if (cfg.updates?.repo) { out.repo = String(cfg.updates.repo); out.repoExplicit = true; }
      if (cfg.updates?.branch) out.branch = String(cfg.updates.branch);
      if (cfg.agent?.cwd) out.cwd = String(cfg.agent.cwd);
      if (cfg.server?.db_path) out.dbPath = String(cfg.server.db_path);
    } catch { /* unreadable yaml: defaults */ }
    break;
  }
  if (process.env.DB_PATH) out.dbPath = process.env.DB_PATH;
  if (process.env.SANCTUM_REPO) { out.repo = process.env.SANCTUM_REPO; out.repoExplicit = true; }
  if (process.env.SANCTUM_BRANCH) out.branch = process.env.SANCTUM_BRANCH;
  if (!out.repo) throw new UpdateError('no GitHub address: set "repository" in package.json (github:owner/name) or updates.repo in sanctum.yaml');
  return out;
}

// ---- GitHub -----------------------------------------------------------------
function ghHeaders(accept) {
  const h = { 'User-Agent': 'sanctum-mobile-updater', Accept: accept };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}
export async function remoteVersion(repo, branch, fetchFn = fetch) {
  const tries = [
    { url: `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/package.json`, accept: 'text/plain' },
    { url: `https://api.github.com/repos/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`, accept: 'application/vnd.github.raw+json' },
  ];
  let last = '';
  for (const t of tries) {
    try {
      const res = await fetchFn(t.url, { headers: ghHeaders(t.accept), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { last = `GitHub answered ${res.status} for ${repo}`; continue; }
      return String(JSON.parse(await res.text()).version || '');
    } catch (err) { last = err.message; }
  }
  throw new Error(last || 'unreachable');
}
export function isNewer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
export async function downloadTarball(repo, branch, into, fetchFn = fetch) {
  const tries = [
    `https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`, // public
    `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(branch)}`,          // private, with GITHUB_TOKEN
  ];
  let last = '';
  for (const url of tries) {
    try {
      const res = await fetchFn(url, { headers: ghHeaders('application/vnd.github+json'), redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!res.ok) { last = `GitHub answered ${res.status} for the download`; continue; }
      const file = join(into, 'sanctum.tar.gz');
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      return file;
    } catch (err) { last = err.message; }
  }
  throw new Error(last || 'unreachable');
}

// ---- what this platform can do ------------------------------------------------
const hasCommand = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
/** 'git' for a git checkout, 'tarball' for a folder with no .git. */
export function installMode(root) { return existsSync(join(root, '.git')) ? 'git' : 'tarball'; }
/** { ok, mode, reason }: can this install update itself? A git checkout needs git; a downloaded folder needs tar. */
export function selfUpdateSupport(root) {
  const mode = installMode(root);
  if (mode === 'git') return hasCommand('git') ? { ok: true, mode } : { ok: false, mode, reason: 'This folder is a git checkout and git is not installed here.' };
  return hasCommand('tar') ? { ok: true, mode } : { ok: false, mode, reason: 'Updating a downloaded folder needs `tar`, which is not installed here.' };
}

// ---- running commands -----------------------------------------------------------
/** The environment a build child gets: ours, minus the npm run-state of whatever started this process (`npm start --workspace=...` leaves
 *  workspace and prefix settings behind that would point `npm ci` at the wrong folder). */
export function childEnv(base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) {
    if (/^npm_(lifecycle|package|command|node|execpath)/i.test(k) || /^npm_config_(local_prefix|workspace|workspaces|include_workspace_root|prefix|global)/i.test(k) || k === 'INIT_CWD') delete env[k];
  }
  // npm's update notifier starts a detached node process (stdio ignored, cwd = the folder npm ran in) that outlives npm: inside .update-stage it would still hold the
  // folder when the swap is done, and on Windows a folder that is some process's working directory cannot be removed. Nothing here needs the notifier, fund or audit.
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false'; env.NPM_CONFIG_FUND = 'false'; env.NPM_CONFIG_AUDIT = 'false';
  return env;
}

const liveGroups = new Set();
/** Signal a child's whole process group (the child is spawned as its own group leader), so npm's node, tsc and vite go with it. `kill`, `platform` and `taskkill` are injectable.
 *  Windows has no negative-pid group signals: `taskkill /PID <pid> /T /F` ends the process and its children, and `process.kill(pid)` is the fallback. */
export function killProcessGroup(pid, signal = 'SIGTERM', kill = process.kill.bind(process), platform = process.platform, taskkill = (p) => spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' })) {
  if (!pid) return false;
  if (platform === 'win32') {
    try { if (taskkill(pid)?.status === 0) return true; } catch { /* no taskkill: fall back */ }
    try { kill(pid); return true; } catch { return false; }
  }
  try { kill(-pid, signal); return true; } catch { /* not a group leader, or gone */ }
  try { kill(pid, signal); return true; } catch { return false; }
}
/** Kill every build child this process started (shutdown). */
export function killAllChildren(signal = 'SIGTERM', kill = process.kill.bind(process)) {
  for (const pid of [...liveGroups]) killProcessGroup(pid, signal, kill);
}

/** Run a command in its own process group, handing each output line to `log`. Resolves with the exit code; never throws for a non-zero exit.
 *  `signal` (an AbortSignal) kills the group; `onSpawn(pid)` says which group it is. */
export function run(cmd, args, { cwd, log = noop, env = childEnv(), signal, onSpawn } = {}) {
  return new Promise((res) => {
    let child;
    try { child = spawn(cmd, args, { cwd, env, shell: process.platform === 'win32', detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { log(`${cmd}: ${err.message}`); res(127); return; }
    const pid = child.pid;
    if (pid) { liveGroups.add(pid); try { onSpawn?.(pid); } catch { /* best effort */ } }
    const stop = () => {
      killProcessGroup(pid, 'SIGTERM');
      setTimeout(() => killProcessGroup(pid, 'SIGKILL'), 3000).unref();
    };
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(buf[i] === '\r' && buf[i + 1] === '\n' ? i + 2 : i + 1);
        if (line) log(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const done = (code) => { liveGroups.delete(pid); signal?.removeEventListener('abort', stop); res(code); };
    child.on('error', (err) => { log(`${cmd}: ${err.message}`); done(127); });
    child.on('close', (code) => { if (buf.trim()) log(buf.trim()); done(code ?? 1); });
  });
}
function gitOut(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
  if (r.status !== 0) throw new UpdateError(`git ${args.join(' ')} failed: ${String(r.stderr || r.stdout).trim()}`);
  return String(r.stdout);
}
/** `git status --porcelain` as a list of lines; nothing is ignored. */
export function gitDirty(root) { return gitOut(root, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean); }
export function gitHead(root) { return gitOut(root, ['rev-parse', 'HEAD']).trim(); }
export function gitBranch(root) { return gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); }
/** "owner/name" of the checkout's `origin` when it is a GitHub address (https or ssh), else ''. */
export function originRepo(root) {
  const r = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf-8' }); // (as written: `remote get-url` applies insteadOf rewrites)
  if (r.status !== 0) return '';
  const m = /github\.com[/:]([^/\s]+\/[^/\s#]+?)(?:\.git)?\/?$/i.exec(String(r.stdout).trim());
  return m ? m[1] : '';
}
/** The repository the version check and the update must both read: a git checkout's code comes from its `origin`. A repository that only
 *  came from package.json follows origin (a fork's clone updates from the fork); one the person named (updates.repo) that is not origin
 *  is refused with the reason. A downloaded folder, or an origin that is not on GitHub, keeps the settings' repository. */
export function resolveRepo(root, { repo, explicit = false }) {
  if (installMode(root) !== 'git') return { repo };
  const origin = originRepo(root);
  if (!origin || origin.toLowerCase() === String(repo).toLowerCase()) return { repo };
  if (explicit) {
    return { repo, error: `updates.repo is "${repo}" but this checkout's origin is "${origin}", so the code would come from a different place than the version check. Set updates.repo to ${origin} (or remove it), or point origin at ${repo}.` };
  }
  return { repo: origin, note: `this checkout's origin is ${origin}, so updates come from there (not ${repo})` };
}

// ---- the stage and the rollback copy -------------------------------------------------
/** Where the new version is built, inside the app folder (so the swap is a rename on one filesystem). */
export function stageDir(root) { return join(root, '.update-stage'); }
/** Where the previous version is kept after a swap, inside the app folder for the same reason. */
export function rollbackRoot(root) { return join(root, '.update-rollback'); }
/** Where a swap in progress writes its copy. The previous `.update-rollback/` is untouched until the swap has fully succeeded, then this is renamed over it. */
export function rollbackNextRoot(root) { return join(root, '.update-rollback.next'); }
const sha256 = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return ''; } };
const safeName = (v) => String(v).replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/** The directories a swap moves, relative to the app: node_modules, packages/<x>/dist, packages/<x>/node_modules and the frontend build,
 *  wherever either the live folder or the stage has them. */
async function swapDirNames(root, stage) {
  const out = new Set();
  for (const base of [root, stage]) {
    if (exists(join(base, 'node_modules'))) out.add('node_modules');
    if (exists(join(base, 'packages', 'frontend', 'build'))) out.add('packages/frontend/build');
    let pk = [];
    try { pk = await readdir(join(base, 'packages'), { withFileTypes: true }); } catch { /* no packages */ }
    for (const d of pk) {
      if (!d.isDirectory()) continue;
      for (const sub of ['dist', 'node_modules']) if (exists(join(base, 'packages', d.name, sub))) out.add(`packages/${d.name}/${sub}`);
    }
  }
  return [...out].sort();
}


/** The latest rollback copy this version can act on, or null: { dir, manifest }. Read with the same validated reader boot recovery uses: a manifest in a newer format, one that cannot be
 *  parsed or is not shaped like a manifest, or one in a state this code does not know is NOT a rollback copy here (see rollbackProblem for why). */
export function readRollback(root) { return scanRollback(root).found; }
/** Why a rollback copy exists but is not offered ('' when there is none, or it is fine): a sentence naming the folder and the reason. */
export function rollbackProblem(root) { return scanRollback(root).problem; }
function scanRollback(root) {
  const base = rollbackRoot(root);
  let problem = '';
  let list = [];
  try { list = readdirSync(base, { withFileTypes: true }); } catch { return { found: null, problem }; }
  for (const d of list) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dir = join(base, d.name);
    const r = readManifest(dir);
    if (r.kind === 'none') continue;
    if (r.kind !== 'ok') { problem ||= `the rollback copy in ${dir} cannot be used by this version (${r.reason})`; continue; }
    if (!Object.hasOwn(r.manifest.machine ?? MACHINE, r.manifest.phase)) { problem ||= `the rollback copy in ${dir} is in a state this version does not know (${r.manifest.phase})`; continue; }
    return { found: { dir, manifest: r.manifest }, problem: '' };
  }
  return { found: null, problem };
}
/** The copy a swap must not overwrite: an unsettled or unreadable one in .update-rollback.next OR in .update-rollback (a recovery_failed copy, or one this version cannot read, is the only
 *  record of the previous files). '' when none. */
export function heldCopy(root) { return unsettled(rollbackNextRoot(root)) || unsettled(rollbackRoot(root)); }
export function updateRollbackManifest(root, patch) {
  const rb = readRollback(root);
  if (!rb) return;
  writeManifest(rb.dir, { ...rb.manifest, ...patch });
}
export function clearRollback(root) { rmSync(rollbackRoot(root), { recursive: true, force: true }); }
/** Is there a rollback copy? { available, version, created_at, mode } */
export function rollbackInfo(root) {
  const rb = readRollback(root);
  if (!rb) return { available: false, version: null, created_at: null, mode: null };
  return { available: true, version: rb.manifest.version, created_at: rb.manifest.created_at, mode: rb.manifest.mode };
}

/** A copy-only rollback copy of `entries` (paths relative to root): each is COPIED into <app>/.update-rollback/<version>/files with a manifest.
 *  The swap itself moves directories instead (applyStaged); this is for a folder that is changed in place. Only the latest copy is kept. */
export async function makeRollbackCopy({ root, version, mode, branch, sha = null, entries: names = [], now = () => new Date() }) {
  const base = rollbackRoot(root);
  await rm(base, { recursive: true, force: true });
  const dir = join(base, safeName(version));
  await mkdir(join(dir, 'files'), { recursive: true });
  const entries = [];
  for (const rel of names) {
    const src = join(root, rel);
    if (!exists(src)) { entries.push({ path: rel, kind: 'absent' }); continue; }
    const dest = join(dir, 'files', rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true, force: true });
    entries.push({ path: rel, kind: lstatSync(src).isDirectory() ? 'dir' : 'file', how: 'copied' });
  }
  const manifest = { format: MANIFEST_FORMAT, version, mode, branch, sha, toSha: null, toVersion: null, created_at: now().toISOString(), lockfile_sha256: sha256(join(root, 'package-lock.json')), phase: 'swapped', entries: entries.map((e) => ({ ...e, step: 'moved' })) };
  writeManifest(dir, manifest);
  return manifest;
}

// ---- dependencies and build ---------------------------------------------------------
/** The line that says why a step failed: from the last 60 lines, the first that looks like an error (npm warnings skipped) and the two after it, else the last three lines. */
export function errorTail(lines) {
  const recent = lines.slice(-60);
  const at = recent.findIndex((l) => !/^npm warn/i.test(l) && /\berror\b|ERR!|TS\d{4}|Error:/i.test(l));
  return at >= 0 ? recent.slice(at, at + 3) : recent.slice(-3);
}
/** A log that also remembers the last lines, so a failed step can say why in the error itself. */
function tailLog(log) {
  const lines = [];
  return { log: (l) => { log(l); if (String(l).trim()) { lines.push(String(l).trim()); if (lines.length > 60) lines.shift(); } }, tail: () => errorTail(lines) };
}
const withTail = (message, tail) => (tail.length ? `${message}:\n${tail.join('\n')}` : message);

async function installDeps(dir, log, opts = {}) {
  const lock = existsSync(join(dir, 'package-lock.json'));
  if (lock) log('npm ci --include=dev');
  else log('no package-lock.json: falling back to npm install --include=dev');
  const args = lock ? ['ci', '--include=dev', '--no-audit', '--no-fund'] : ['install', '--include=dev', '--no-audit', '--no-fund']; // dev deps build the frontend
  const t = tailLog(log);
  const code = await run('npm', args, { cwd: dir, log: t.log, signal: opts.signal, onSpawn: opts.onSpawn });
  if (code !== 0) throw new UpdateError(withTail(`${lock ? 'npm ci' : 'npm install'} failed (exit ${code})`, t.tail()));
}
async function buildApp(dir, log, opts = {}) {
  log('npm run build');
  const t = tailLog(log);
  const code = await run('npm', ['run', 'build'], { cwd: dir, log: t.log, signal: opts.signal, onSpawn: opts.onSpawn });
  if (code !== 0) throw new UpdateError(withTail(`npm run build failed (exit ${code})`, t.tail()));
}

// ---- the tarball path -------------------------------------------------------------
const realOrLexical = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (base, p) => { const rel = relative(base, p); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

/** The relative paths an archive must never overwrite: the person's own files, and the companion's home when it sits inside the app folder
 *  (companion-home/ is the shipped home, plus an agent.cwd that points at another folder inside the app). Paths are compared after
 *  realpath, so a home that is a symlink inside the app (or reached through one) is protected too. */
export function protectedPaths(root, cwd) {
  const out = ['.git', '.env', 'sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml', '.mcp.json', 'data', 'node_modules', '.update-stage', '.update-rollback', '.update-rollback.next', '.update-recovery.json', '.update-recover.count'];
  const realRoot = realOrLexical(root);
  const lexical = resolve(root, cwd || '.');
  const realCwd = realOrLexical(lexical);
  const inside = (base) => within(resolve(root), base) || within(realRoot, base);
  if (inside(lexical) || inside(realCwd)) {
    out.push('companion-home');
    for (const [base, ref] of [[resolve(root), lexical], [realRoot, realCwd]]) {
      const rel = relative(base, ref);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) out.push(rel.split(sep).join('/'));
    }
  } else if (realCwd === realRoot) out.push('companion-home');
  // A top-level entry of the app that is a link into the home (the home itself, or a folder inside it) is the home too.
  try {
    for (const d of readdirSync(resolve(root), { withFileTypes: true })) {
      if (!d.isSymbolicLink()) continue;
      const target = realOrLexical(join(root, d.name));
      if (within(realCwd, target) && realCwd !== realRoot) out.push(d.name);
    }
  } catch { /* unreadable root: the rest still applies */ }
  return [...new Set(out)];
}
export function isProtected(rel, prot) {
  const r = rel.split(sep).join('/');
  return prot.some(p => r === p || r.startsWith(`${p}/`));
}
function listFiles(dir, base = dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...listFiles(p, base));
    else if (d.isFile() || d.isSymbolicLink()) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}
/** Would writing `rel` under the app land inside the companion's home (through a link in the app)? */
function landsInHome(root, rel, realCwd) {
  if (!realCwd || realCwd === realOrLexical(root)) return false;
  let p = dirname(join(root, rel));
  while (!exists(p) && p !== dirname(p)) p = dirname(p);
  return within(realCwd, realOrLexical(p));
}
/** The files an unpacked archive would write over `root`: its own file list (the archive holds tracked files only) minus the protected paths
 *  and anything that would be written through a link into the companion's home. */
export function archivePlan(extractedDir, root, cwd) {
  const prot = protectedPaths(root, cwd);
  const realCwd = realOrLexical(resolve(root, cwd || '.'));
  const all = listFiles(extractedDir);
  const skip = (f) => isProtected(f, prot) || landsInHome(root, f, realCwd);
  return { files: all.filter(f => !skip(f)), skipped: all.filter(skip) };
}

// ---- the stage: cleaning up, and recovering from a crash ---------------------------------
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The start time of a process (field 22 of /proc/<pid>/stat, in clock ticks since boot), or '' when it cannot be read (no /proc, or the process is gone).
 *  A pid alone proves nothing after a reboot: another program may hold the number. The pid and its start time together name one process. */
export function procStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || ''; // (the name in field 2 may hold spaces and brackets: count from the last bracket)
  } catch { return ''; }
}
const hasProc = () => existsSync('/proc/self/stat');
/** A recorded `<pid> <start time>` line: still that same process, and really an npm/node/tsc/vite one. Without /proc nothing can be proven, so nothing is killed. */
function looksLikeBuildChild(line) {
  const [pidText, start] = line.trim().split(/\s+/);
  const pid = parseInt(pidText, 10);
  if (!(pid > 1) || !start || start === '-' || !hasProc() || !pidAlive(pid)) return 0;
  if (procStartTime(pid) !== start) return 0;
  try { return /npm|node|tsc|vite/i.test(readFileSync(`/proc/${pid}/cmdline`, 'utf-8')) ? pid : 0; } catch { return 0; }
}
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
/** Where a removal that did not finish says so: written inside the stage, so it is gone with it. */
export const STAGE_LEFT_MARKER = '.stage-left-behind';
const gitAsync = (root, args) => new Promise((res) => { execFile('git', args, { cwd: root, windowsHide: true }, (err) => res(!err)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Delete the stage (stopping build children a killed run left behind) and forget its worktree. Returns true when there was one. NEVER throws for a stage that cannot be removed:
 *  a leftover stage must not fail a swap that completed (or the clean-up of one that failed). Order: stop leftover build children; `git worktree remove --force` (releases git's own
 *  locks; run from the app root, never from inside the stage, and awaited); then the removal with a bounded retry (`budgetMs`, `retryDelayMs`; `rmFn` is injectable). When it still
 *  fails the reason is logged, a marker is left inside the stage and the stage is removed at the next boot (initUpdater calls this again, with the longer default budget).
 *  A stage that is a symbolic link is never followed, read or deleted through: it is left alone (stageUpdate refuses it). */
export async function discardStage(root, log = noop, { rmFn = rm, budgetMs = process.platform === 'win32' ? 5000 : 0, retryDelayMs = process.platform === 'win32' ? 250 : 100 } = {}) {
  const stage = stageDir(root);
  if (isLink(stage)) { log('.update-stage is a symbolic link; it is not followed and was left alone'); return false; }
  const had = exists(stage);
  if (had) {
    try {
      for (const l of readFileSync(join(stage, '.pgids'), 'utf-8').split(/\r?\n/)) {
        const pid = looksLikeBuildChild(l);
        if (pid) { log(`stopping a build left over from an update that did not finish (${pid})`); killProcessGroup(pid, 'SIGKILL'); }
      }
    } catch { /* no pid list */ }
    if (installMode(root) === 'git') await gitAsync(root, ['worktree', 'remove', '--force', stage]); // (best effort: not a registered worktree, or already gone, is fine)
  }
  // (async rm: a stage holds a whole node_modules, and a synchronous removal would stall the running app.) On Windows files may be held for a moment (git, an indexer, antivirus).
  let failure = null;
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try { await rmFn(stage, { recursive: true, force: true }); failure = null; break; } catch (err) { failure = err; }
    const more = budgetMs > 0 ? Date.now() - t0 + retryDelayMs <= budgetMs : attempt < 3;
    if (!more) break;
    await sleep(retryDelayMs);
  }
  if (installMode(root) === 'git') spawnSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore', windowsHide: true }); // (cwd is the app root, never the stage)
  if (failure && exists(stage)) {
    log(`stage left behind; it is removed at the next boot (${failure.code ?? failure.message})`);
    try { mkdirSync(stage, { recursive: true }); writeFileSync(join(stage, STAGE_LEFT_MARKER), `${new Date().toISOString()} ${failure.code ?? failure.message}\n`); } catch { /* the marker is a courtesy */ }
  }
  return had;
}

/** The pre-boot recovery (packages/backend/boot.mjs runs the same code, vendored in scripts/boot-recover.mjs / packages/backend/src/boot-recover.ts, before anything of the app loads; `npm start`
 *  and `npm run update` run it first too). A swap or a roll back that was cut short is finished from its manifest, by the rules in that file's header: swapping / rolling_back
 *  are put back (git reset --hard and checkout always, the directories renamed back, the copy removed), a swap that had finished in .update-rollback.next is adopted, a manifest
 *  that cannot be read is never acted on. Returns true when the code or the files on disk changed (the caller must then start over, so what runs is what was restored).
 *  `recoverDetailed` (exported above) returns the whole result; it is also written to <app>/.update-recovery.json for the updater service to word its job from. */
export async function recoverInterruptedSwap(root, log = noop) {
  return recover(root, { log }).changed;
}
/** `--recover`: also retries a copy an earlier recovery marked `recovery_failed`. */
export async function recoverRetry(root, log = noop) {
  return recover(root, { log, retry: true });
}

// ---- staging an update ----------------------------------------------------------------
/**
 * Build the new version in <app>/.update-stage/ without touching the running folder.
 * opts: { root, force?, log?, setState?, fetchFn?, settings?, signal? }
 * Returns { upToDate:true, current, latest } or a plan { upToDate:false, staged:true, from, to, mode, sha, toSha, branch, files } for applyStaged.
 * Throws UpdateError (nothing was changed; the stage is already gone).
 */
export async function stageUpdate(opts) {
  const { root, force = false, log = noop, setState = noop, fetchFn = fetch, signal } = opts;
  setState('checking');
  const settings = opts.settings ?? await readUpdateSettings(root);
  const { branch } = settings;
  let repo = settings.repo;
  const from = readVersion(root);
  log(`you have ${from}`);
  const picked = resolveRepo(root, { repo, explicit: settings.repoExplicit ?? false });
  if (picked.error) throw new UpdateError(picked.error);
  if (picked.note) log(picked.note);
  repo = picked.repo;
  let latest;
  try { latest = await remoteVersion(repo, branch, fetchFn); } catch (err) {
    throw new UpdateError(`could not check GitHub: ${err.message}. No internet? Try again later. If the project on GitHub is private, put GITHUB_TOKEN=<a token with read access> in .env.`);
  }
  if (!force && !isNewer(latest, from)) { log(`newest is ${latest}. You already have it.`); return { upToDate: true, current: from, latest }; }
  log(`newest is ${latest}, updating`);

  const support = selfUpdateSupport(root);
  if (!support.ok) throw new UpdateError(support.reason);
  const held = heldCopy(root); // (refuse before building anything: the swap would delete the held copy)
  if (held) throw new UpdateError(`${held}, so nothing was changed. Run: npm run update -- --recover`);
  const mode = support.mode;
  const stage = stageDir(root);
  let tmp = null;
  const plan = { upToDate: false, staged: true, from, to: from, mode, sha: null, toSha: null, branch, files: [] };
  const spawnOpts = {
    signal,
    onSpawn: (pid) => { try { appendFileSync(join(stage, '.pgids'), `${pid} ${procStartTime(pid) || '-'}\n`); } catch { /* the stage may be gone */ } },
  };
  if (isLink(stage)) throw new UpdateError('.update-stage is a symbolic link, which the updater never follows. Remove it (rm .update-stage) and try again. Nothing was changed.');

  try {
    await discardStage(root, log); // (left by a run that did not finish)
    if (exists(stageDir(root))) throw new UpdateError('A leftover .update-stage from an earlier update could not be removed yet (something still holds it). It is removed at the next start; or delete the .update-stage folder, then try again. Nothing was changed.');
    if (mode === 'git') {
      const dirty = gitDirty(root);
      if (dirty.length) {
        throw new UpdateError(`This folder has local changes, so it was not updated. Commit or discard them, then try again:\n${dirty.join('\n')}`, { dirty });
      }
      const here = gitBranch(root);
      if (here !== branch) throw new UpdateError(`This checkout is on "${here}" but the update branch is "${branch}" (updates.branch). Switch the checkout to ${branch}, or change updates.branch.`);
      plan.sha = gitHead(root);
      setState('fetching');
      log(`git fetch origin ${branch}`);
      if (await run('git', ['fetch', 'origin', branch], { cwd: root, log, signal }) !== 0) throw new UpdateError('git fetch failed');
      plan.toSha = gitOut(root, ['rev-parse', `origin/${branch}`]).trim();
      if (spawnSync('git', ['merge-base', '--is-ancestor', plan.sha, plan.toSha], { cwd: root }).status !== 0) {
        throw new UpdateError('git merge --ff-only would fail: this checkout has commits the branch does not have. Nothing was changed.');
      }
      if (plan.toSha === plan.sha && !isNewer(latest, from)) {
        await discardStage(root, log).catch(() => {});
        log(`already on ${from}`);
        return { upToDate: true, current: from, latest, already: true };
      }
      ensureExcluded(root);
      log(`building ${plan.toSha.slice(0, 8)} in .update-stage (the running app is untouched)`);
      if (await run('git', ['worktree', 'add', '--detach', stage, plan.toSha], { cwd: root, log, signal }) !== 0) throw new UpdateError('could not create the build folder (git worktree add failed)');
    } else {
      setState('fetching');
      tmp = mkdtempSync(join(tmpdir(), 'sanctum-update-'));
      log(`downloading ${repo}@${branch}`);
      let file;
      try { file = await downloadTarball(repo, branch, tmp, fetchFn); } catch (err) { throw new UpdateError(`could not download the update: ${err.message}`); }
      mkdirSync(stage, { recursive: true });
      if (await run('tar', ['-xzf', file, '-C', stage, '--strip-components=1'], { cwd: tmp, log, signal }) !== 0) throw new UpdateError('could not unpack the download (is `tar` installed?)');
      if (!readdirSync(stage).length) throw new UpdateError('the download was empty');
      const prot = protectedPaths(root, settings.cwd);
      const planned = archivePlan(stage, root, settings.cwd);
      if (planned.skipped.length) log(`not touching ${planned.skipped.length} file${planned.skipped.length === 1 ? '' : 's'} that belong to you or your companion's home`);
      for (const f of planned.skipped) await rm(join(stage, f), { force: true });
      for (const p of prot) await rm(join(stage, p), { recursive: true, force: true });
      plan.files = planned.files;
    }
    setState('installing');
    await installDeps(stage, log, spawnOpts);
    setState('building');
    await buildApp(stage, log, spawnOpts);
    if (signal?.aborted) throw new UpdateError('the update was stopped');
    plan.to = readVersion(stage);
    log(`built ${plan.to} in .update-stage; nothing in the running app has changed yet`);
  } catch (err) {
    await discardStage(root, log).catch(() => {});
    throw err instanceof UpdateError ? err : new UpdateError(err.message);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return plan;
}

/** After a swap the stage is removed within this budget; what is still held is left for the next boot (a test or the update would otherwise wait on antivirus). */
const LEFTOVER_BUDGET_MS = process.platform === 'win32' ? 1500 : 0;
// ---- the swap ---------------------------------------------------------------------------
/**
 * Put a staged build in place. Quick: a git fast-forward, then renames. The previous node_modules, dist and build directories are moved into
 * <app>/.update-rollback/<version>/ (a downloaded folder's replaced files are copied there). Throws UpdateError after putting everything back.
 * opts: { root, plan, log? }. Returns { upToDate:false, from, to, mode, sha, toSha }.
 */
export async function applyStaged({ root, plan, log = noop, stageRemoval = {} }) {
  const { mode, from, sha, branch } = plan;
  const stage = stageDir(root);
  if (!exists(stage)) throw new UpdateError('the staged update is gone; nothing was changed');
  if (mode === 'git') {
    const dirty = gitDirty(root);
    if (dirty.length) throw new UpdateError(`This folder has local changes, so it was not updated. Commit or discard them, then try again:\n${dirty.join('\n')}`, { dirty });
    if (gitHead(root) !== sha) throw new UpdateError('This checkout moved on while the update was built (new commits), so it was not updated. Nothing was changed.');
  }
  if (mode === 'git' && plan.toSha === sha && !isNewer(plan.to, from)) { // nothing to swap: same commit, version not newer
    await discardStage(root, log, { budgetMs: LEFTOVER_BUDGET_MS, ...stageRemoval }).catch(() => {});
    log(`already on ${from}`);
    return { upToDate: true, current: from, latest: plan.to, already: true };
  }
  // The new copy is written beside the previous one (.update-rollback.next); the previous one is deleted only once the swap has fully succeeded.
  const base = rollbackNextRoot(root);
  const held = heldCopy(root); // (never delete the only copy of the directories an earlier cut-short update moved aside)
  if (held) throw new UpdateError(`${held}, so nothing was changed. Run: npm run update -- --recover`);
  await rm(base, { recursive: true, force: true });
  const dir = join(base, safeName(from));
  await mkdir(join(dir, 'files'), { recursive: true });
  const dirs = await swapDirNames(root, stage);
  const entries = dirs.map(p => ({ path: p, kind: exists(join(root, p)) ? 'dir' : 'absent', how: 'moved', step: 'pending' }));
  for (const rel of plan.files) entries.push(exists(join(root, rel)) ? { path: rel, kind: 'file', how: 'copied', step: 'pending' } : { path: rel, kind: 'absent' });
  const manifest = {
    format: MANIFEST_FORMAT, version: from, mode, branch, sha, toSha: plan.toSha, toVersion: plan.to, created_at: new Date().toISOString(),
    lockfile_sha256: sha256(join(root, 'package-lock.json')), phase: 'swapping', merged: false, entries,
  };
  writeManifest(dir, manifest);
  try {
    for (const e of entries) { // the files this will replace, copied (before anything moves)
      if (e.how !== 'copied') continue;
      const dest = join(dir, 'files', e.path);
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(root, e.path), dest, { force: true });
    }
    if (mode === 'git') {
      log(`git merge --ff-only ${plan.toSha.slice(0, 8)}`);
      if (await run('git', ['merge', '--ff-only', plan.toSha], { cwd: root, log }) !== 0) throw new UpdateError('git merge --ff-only failed: this checkout has commits the branch does not have. Nothing was changed.');
      manifest.merged = true;
      writeManifest(dir, manifest);
    }
    for (const e of entries) {
      if (e.how !== 'moved') continue;
      const live = join(root, e.path);
      if (e.kind === 'dir') { await mkdir(dirname(join(dir, 'files', e.path)), { recursive: true }); await rename(live, join(dir, 'files', e.path)); }
      const staged = join(stage, e.path);
      if (exists(staged)) { await mkdir(dirname(live), { recursive: true }); await rename(staged, live); }
      e.step = 'moved'; // (written down: a recovery can tell a directory the swap never reached from one that was lost)
      writeManifest(dir, manifest);
    }
    if (mode === 'tarball') {
      for (const rel of plan.files) {
        const live = join(root, rel);
        await mkdir(dirname(live), { recursive: true });
        await rename(join(stage, rel), live);
      }
    }
    for (const e of entries) if (e.step) e.step = 'moved';
    manifest.phase = 'swapped';
    writeManifest(dir, manifest);
    await rm(rollbackRoot(root), { recursive: true, force: true });
    await rename(base, rollbackRoot(root));
  } catch (err) {
    log(`the swap failed (${err.message}): putting the previous version back`);
    let restored = false;
    try {
      manifest.phase = 'rolling_back';
      writeManifest(dir, manifest);
      const r = restoreCopy({ root, dir, manifest, log });
      if (r.ok) {
        await rm(base, { recursive: true, force: true }); // (the previous .update-rollback was never touched, so it is still the rollback copy)
        const problems = verifyRestored(root, manifest);
        restored = problems.length === 0;
        if (!restored) log(`the previous version was put back, but this is inconsistent: ${problems.join('; ')}`);
      } else log(`could not put the previous version back: ${r.detail}. The copy was kept in .update-rollback.next; run: npm run update -- --recover`);
    } catch (e2) { log(`could not put the previous version back: ${e2.message}`); }
    await discardStage(root, log, { budgetMs: LEFTOVER_BUDGET_MS, ...stageRemoval }).catch(() => {});
    throw new UpdateError(err.message, { restored, dirty: err.dirty });
  }
  await discardStage(root, log, { budgetMs: LEFTOVER_BUDGET_MS, ...stageRemoval }).catch(() => {});
  log(`swapped in ${readVersion(root)}; the previous version is kept in .update-rollback`);
  return { upToDate: false, from, to: readVersion(root), mode, sha, toSha: plan.toSha };
}

// ---- rolling back -------------------------------------------------------------------
/** Restore the latest rollback copy: git reset first (a clean tree on the commit the update left, unless `force`), then the moved directories and copied
 *  files, then, only if node_modules did not come back with them, an install to match the restored lockfile. */
export async function rollbackNow({ root, log = noop, force = false }) {
  const rb = readRollback(root);
  if (!rb) throw new UpdateError(rollbackProblem(root) ? `${rollbackProblem(root)}, so it was not touched. Run: npm run update -- --recover` : 'there is no rollback copy');
  const { manifest } = rb;
  const lockBefore = sha256(join(root, 'package-lock.json')); // (before the reset: that is the lockfile the current node_modules was installed from)
  if (manifest.mode === 'git' && manifest.sha) {
    if (!force) {
      const dirty = gitDirty(root);
      if (dirty.length) throw new UpdateError(`This folder has local changes, so it was not rolled back. Commit or discard them, then try again:\n${dirty.join('\n')}`, { dirty });
      if (manifest.toSha && gitHead(root) !== manifest.toSha) throw new UpdateError('This checkout has moved on since the update (new commits), so it was not rolled back.');
    }
  }
  const before = manifest.phase;
  manifest.phase = 'rolling_back';
  writeManifest(rb.dir, manifest);
  log(manifest.mode === 'git' && manifest.sha ? `git reset --hard ${manifest.sha.slice(0, 8)}, then the moved directories back` : 'putting the moved directories and files back');
  const r = restoreCopy({ root, dir: rb.dir, manifest, log, gitFirst: true });
  if (!r.ok) {
    if (!r.touched) { manifest.phase = before; delete manifest.failure; delete manifest.restored_from; writeManifest(rb.dir, manifest); } // (nothing was touched: the copy must not look like a roll back under way)
    throw new UpdateError(`${r.detail}. ${r.touched ? 'The copy was kept; run: npm run update -- --recover' : 'Nothing was changed.'}`);
  }
  await rm(join(rb.dir, 'aside'), { recursive: true, force: true });
  const problems = verifyRestored(root, manifest);
  if (problems.length) log(`warning: ${problems.join('; ')}`);
  log(`restored ${manifest.entries.length} items from the ${manifest.version} copy`);
  const modules = manifest.entries.find(e => e.path === 'node_modules');
  const modulesBack = !!modules && modules.kind !== 'absent' && existsSync(join(root, 'node_modules'));
  const lockChanged = !!manifest.lockfile_sha256 && lockBefore !== manifest.lockfile_sha256;
  if (!modulesBack && lockChanged) {
    // Best effort: a failure here is logged; the files are already back.
    try { await installDeps(root, log); } catch (err) { log(`warning: ${err.message}; run npm ci in the app folder`); }
  }
  return { version: manifest.version, mode: manifest.mode };
}
/** A manual roll back: restores, then forgets the copy. */
export async function runRollback(opts) {
  const r = await rollbackNow({ ...opts, force: false });
  clearRollback(opts.root);
  (opts.log ?? noop)(`rolled back to ${r.version}`);
  return r;
}

// ---- the whole update -------------------------------------------------------------
/**
 * Update an install folder: stage, then swap at once (`npm run update`). The in-app updater calls stageUpdate and applyStaged itself so the swap
 * can wait for the restart.
 * Returns { upToDate:true, current, latest } or { upToDate:false, from, to, mode, sha, toSha }.
 */
export async function runUpdate(opts) {
  const plan = await stageUpdate(opts);
  if (plan.upToDate) return plan;
  try { return await applyStaged({ root: opts.root, plan, log: opts.log }); }
  catch (err) { await discardStage(opts.root).catch(() => {}); throw err; }
}
