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
//                 packages/*/dist and packages/frontend/build into place, the previous ones going to <app>/.update-rollback/;
//                 a downloaded folder also gets its staged tracked files moved over (and the replaced ones copied to the rollback).
//
// A crash, a kill or a failed install or build before the swap leaves the running folder exactly as it was (the stage is
// deleted at the next start). A failure during the swap puts everything back. A rollback moves the previous copies back
// (and `git reset --hard <sha>` on a git checkout), so node_modules comes back with the code.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  return env;
}

const liveGroups = new Set();
/** Signal a child's whole process group (the child is spawned as its own group leader), so npm's node, tsc and vite go with it. `kill` is injectable. */
export function killProcessGroup(pid, signal = 'SIGTERM', kill = process.kill.bind(process)) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); return true; } catch { return false; }
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
    try { child = spawn(cmd, args, { cwd, env, shell: process.platform === 'win32', detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
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

/** Keep the two folders out of `git status` on checkouts whose .gitignore predates them (this checkout's own exclude file; never tracked). */
function ensureExcluded(root) {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf-8' });
    if (r.status !== 0) return;
    const file = resolve(root, String(r.stdout).trim());
    const have = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    const add = ['.update-stage/', '.update-rollback/', '.update-rollback.next/'].filter(p => !have.split(/\r?\n/).includes(p));
    if (!add.length) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  } catch { /* the .gitignore is the main route */ }
}

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

async function writeManifest(dir, manifest) { await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2)); }

/** The latest rollback copy, or null: { dir, manifest }. */
export function readRollback(root) {
  const base = rollbackRoot(root);
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(base, d.name, 'manifest.json'), 'utf-8'));
      if (manifest && Array.isArray(manifest.entries)) return { dir: join(base, d.name), manifest };
    } catch { /* not a copy */ }
  }
  return null;
}
export function updateRollbackManifest(root, patch) {
  const rb = readRollback(root);
  if (!rb) return;
  writeFileSync(join(rb.dir, 'manifest.json'), JSON.stringify({ ...rb.manifest, ...patch }, null, 2));
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
  const manifest = { version, mode, branch, sha, toSha: null, toVersion: null, created_at: now().toISOString(), lockfile_sha256: sha256(join(root, 'package-lock.json')), phase: 'swapped', entries };
  await writeManifest(dir, manifest);
  return manifest;
}

/** Put the rollback copy back, crash-safely: for every directory the copy holds, the CURRENT one is first renamed aside (<copy>/aside/...), then the old
 *  one is renamed back, so at every instant each is in exactly one place and a second run (the pre-boot recovery after a crash) simply carries on. An entry that
 *  did not exist then is moved aside too. A copied file is copied back over the live one. An entry whose copy is not there (the swap stopped before it, or it was
 *  put back already) is left alone. Files only; git and npm are the caller's, and so is deleting `aside` (beginRestore / finishRestore). */
export async function restoreFiles({ root, dir, manifest }) {
  const aside = join(dir, 'aside');
  for (const e of manifest.entries) {
    const target = join(root, e.path);
    const asideP = join(aside, e.path);
    if (e.kind === 'absent' || e.gone) { // (`gone`: the copy of a finished swap lacks it, so the live one is the new version's)
      if (!exists(target)) continue;
      if (e.how === 'moved') {
        await mkdir(dirname(asideP), { recursive: true });
        if (exists(asideP)) await rm(target, { recursive: true, force: true }); else await rename(target, asideP);
      } else await rm(target, { recursive: true, force: true });
      continue;
    }
    const src = join(dir, 'files', e.path);
    if (!exists(src)) continue;
    if (e.how === 'moved') {
      if (exists(target)) {
        await mkdir(dirname(asideP), { recursive: true });
        if (exists(asideP)) await rm(target, { recursive: true, force: true }); else await rename(target, asideP);
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(src, target);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await cp(src, target, { recursive: true, force: true });
    }
  }
}
/** The manifest says a restore is under way (the pre-boot recovery finishes one it finds), before anything is touched. */
async function beginRestore(dir, manifest) {
  // From a finished swap, a directory the copy does not hold was not there before: the live one is the new version's and goes aside. (Marked now, once,
  // so a second run after a crash does not take a directory it has already put back for one of these.)
  if (manifest.phase === 'swapped') for (const e of manifest.entries) if (e.how === 'moved' && e.kind !== 'absent' && !exists(join(dir, 'files', e.path))) e.gone = true;
  manifest.phase = 'rolling_back';
  await writeManifest(dir, manifest);
}
/** The restore is complete: write that down, and only then delete the copies that were set aside. */
async function finishRestore(dir, manifest) {
  manifest.phase = 'rolled_back';
  await writeManifest(dir, manifest);
  await rm(join(dir, 'aside'), { recursive: true, force: true });
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
  const out = ['.git', '.env', 'sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml', '.mcp.json', 'data', 'node_modules', '.update-stage', '.update-rollback', '.update-rollback.next'];
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
/** Delete the stage (stopping build children a killed run left behind) and forget its worktree. Returns true when there was one.
 *  A stage that is a symbolic link is never followed, read or deleted through: it is left alone (stageUpdate refuses it). */
export async function discardStage(root, log = noop) {
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
  }
  // (async rm: a stage holds a whole node_modules, and a synchronous removal would stall the running app. `git worktree prune` then forgets it.)
  await rm(stage, { recursive: true, force: true, maxRetries: 3 });
  if (installMode(root) === 'git') spawnSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' });
  return had;
}

const RECOVERED = '.recovered';
/** Did the pre-boot recovery put a swap back? Reads (and consumes the marker in) the stage; the updater service asks at boot to word the job's error. */
export function takeRecoveredMarker(root) {
  const p = join(stageDir(root), RECOVERED);
  if (isLink(stageDir(root))) return false;
  const had = existsSync(p);
  if (had) { try { rmSync(p, { force: true }); } catch { /* the stage is deleted next anyway */ } }
  return had;
}
function headOf(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' });
  return r.status === 0 ? String(r.stdout).trim() : '';
}
/** Every copy under a rollback folder that has a manifest: [{ dir, manifest }]. */
function copiesIn(base) {
  const out = [];
  let list = [];
  try { list = readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    try { out.push({ dir: join(base, d.name), manifest: JSON.parse(readFileSync(join(base, d.name, 'manifest.json'), 'utf-8')) }); } catch { /* not a copy */ }
  }
  return out;
}

/** The pre-boot recovery (packages/backend/src/update-recover.ts runs it before anything of the app loads; `npm run update` runs it first too). A swap or a roll back
 *  that was cut short is finished from its manifest:
 *    swapping / rolling_back   the files are put back (each current directory renamed aside, the old one renamed back), and on a git checkout `git reset --hard <sha>`
 *                              whenever HEAD is not the manifest's sha (the merge runs as a child; a kill during it leaves no flag). The copy is then removed.
 *    rolled_back               only the set-aside copies were left to delete.
 *    swapped, in .update-rollback.next   the swap had succeeded; the new copy is moved over the previous one.
 *  A swap writes its copy to .update-rollback.next, so the previous .update-rollback is still whole when the swap is put back.
 *  Returns true when the code or the files on disk changed (the caller must then start over, so what runs is what was restored). */
export async function recoverInterruptedSwap(root, log = noop) {
  const next = rollbackNextRoot(root);
  const main = rollbackRoot(root);
  let changed = false;
  for (const base of [next, main]) {
    for (const { dir, manifest } of copiesIn(base)) {
      const phase = manifest.phase;
      if (phase === 'swapping' || phase === 'rolling_back') {
        log(phase === 'swapping' ? 'a swap was cut short: putting the previous version back' : 'a roll back was cut short: finishing it');
        if (manifest.mode === 'git' && manifest.sha && headOf(root) !== manifest.sha) {
          const r = spawnSync('git', ['reset', '--hard', manifest.sha], { cwd: root, stdio: 'ignore' });
          if (r.status !== 0) log(`warning: git reset --hard ${String(manifest.sha).slice(0, 8)} failed`);
        }
        await restoreFiles({ root, dir, manifest });
        await rm(base, { recursive: true, force: true });
        changed = true;
      } else if (phase === 'rolled_back') {
        await rm(base, { recursive: true, force: true }); // (a roll back consumes its copy)
      }
    }
  }
  // A swap that was written down as complete but not yet moved over the previous copy.
  if (exists(next)) {
    const done = copiesIn(next).find((c) => c.manifest.phase === 'swapped');
    if (done) {
      log('finishing a swap: keeping its rollback copy');
      await rm(main, { recursive: true, force: true });
      renameSync(next, main);
    } else await rm(next, { recursive: true, force: true }); // (no usable manifest: the swap never began)
  }
  if (changed && !isLink(stageDir(root))) {
    try { mkdirSync(stageDir(root), { recursive: true }); writeFileSync(join(stageDir(root), RECOVERED), new Date().toISOString()); } catch { /* the log line says it */ }
  }
  return changed;
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

// ---- the swap ---------------------------------------------------------------------------
/**
 * Put a staged build in place. Quick: a git fast-forward, then renames. The previous node_modules, dist and build directories are moved into
 * <app>/.update-rollback/<version>/ (a downloaded folder's replaced files are copied there). Throws UpdateError after putting everything back.
 * opts: { root, plan, log? }. Returns { upToDate:false, from, to, mode, sha, toSha }.
 */
export async function applyStaged({ root, plan, log = noop }) {
  const { mode, from, sha, branch } = plan;
  const stage = stageDir(root);
  if (!exists(stage)) throw new UpdateError('the staged update is gone; nothing was changed');
  if (mode === 'git') {
    const dirty = gitDirty(root);
    if (dirty.length) throw new UpdateError(`This folder has local changes, so it was not updated. Commit or discard them, then try again:\n${dirty.join('\n')}`, { dirty });
    if (gitHead(root) !== sha) throw new UpdateError('This checkout moved on while the update was built (new commits), so it was not updated. Nothing was changed.');
  }
  if (mode === 'git' && plan.toSha === sha && !isNewer(plan.to, from)) { // nothing to swap: same commit, version not newer
    await discardStage(root, log).catch(() => {});
    log(`already on ${from}`);
    return { upToDate: true, current: from, latest: plan.to, already: true };
  }
  // The new copy is written beside the previous one (.update-rollback.next); the previous one is deleted only once the swap has fully succeeded.
  const base = rollbackNextRoot(root);
  await rm(base, { recursive: true, force: true });
  const dir = join(base, safeName(from));
  await mkdir(join(dir, 'files'), { recursive: true });
  const dirs = await swapDirNames(root, stage);
  const entries = dirs.map(p => ({ path: p, kind: exists(join(root, p)) ? 'dir' : 'absent', how: 'moved' }));
  for (const rel of plan.files) entries.push(exists(join(root, rel)) ? { path: rel, kind: 'file', how: 'copied' } : { path: rel, kind: 'absent' });
  const manifest = {
    version: from, mode, branch, sha, toSha: plan.toSha, toVersion: plan.to, created_at: new Date().toISOString(),
    lockfile_sha256: sha256(join(root, 'package-lock.json')), phase: 'swapping', merged: false, entries,
  };
  await writeManifest(dir, manifest);
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
      await writeManifest(dir, manifest);
    }
    for (const e of entries) {
      if (e.how !== 'moved') continue;
      const live = join(root, e.path);
      if (e.kind === 'dir') { await mkdir(dirname(join(dir, 'files', e.path)), { recursive: true }); await rename(live, join(dir, 'files', e.path)); }
      const staged = join(stage, e.path);
      if (exists(staged)) { await mkdir(dirname(live), { recursive: true }); await rename(staged, live); }
    }
    if (mode === 'tarball') {
      for (const rel of plan.files) {
        const live = join(root, rel);
        await mkdir(dirname(live), { recursive: true });
        await rename(join(stage, rel), live);
      }
    }
    manifest.phase = 'swapped';
    await writeManifest(dir, manifest);
    await rm(rollbackRoot(root), { recursive: true, force: true });
    await rename(base, rollbackRoot(root));
  } catch (err) {
    log(`the swap failed (${err.message}): putting the previous version back`);
    let restored = false;
    try {
      await beginRestore(dir, manifest);
      if (mode === 'git' && gitHead(root) !== sha) await run('git', ['reset', '--hard', sha], { cwd: root, log });
      await restoreFiles({ root, dir, manifest });
      await finishRestore(dir, manifest);
      await rm(base, { recursive: true, force: true }); // (the previous .update-rollback was never touched, so it is still the rollback copy)
      restored = true;
    } catch (e2) { log(`could not put the previous version back: ${e2.message}`); }
    await discardStage(root, log).catch(() => {});
    throw new UpdateError(err.message, { restored, dirty: err.dirty });
  }
  await discardStage(root, log).catch(() => {});
  log(`swapped in ${readVersion(root)}; the previous version is kept in .update-rollback`);
  return { upToDate: false, from, to: readVersion(root), mode, sha, toSha: plan.toSha };
}

// ---- rolling back -------------------------------------------------------------------
/** Restore the latest rollback copy: git reset first (a clean tree on the commit the update left, unless `force`), then the moved directories and copied
 *  files, then, only if node_modules did not come back with them, an install to match the restored lockfile. */
export async function rollbackNow({ root, log = noop, force = false }) {
  const rb = readRollback(root);
  if (!rb) throw new UpdateError('there is no rollback copy');
  const { manifest } = rb;
  const lockBefore = sha256(join(root, 'package-lock.json')); // (before the reset: that is the lockfile the current node_modules was installed from)
  if (manifest.mode === 'git' && manifest.sha) {
    if (!force) {
      const dirty = gitDirty(root);
      if (dirty.length) throw new UpdateError(`This folder has local changes, so it was not rolled back. Commit or discard them, then try again:\n${dirty.join('\n')}`, { dirty });
      if (manifest.toSha && gitHead(root) !== manifest.toSha) throw new UpdateError('This checkout has moved on since the update (new commits), so it was not rolled back.');
    }
    const before = manifest.phase;
    await beginRestore(rb.dir, manifest);
    log(`git reset --hard ${manifest.sha.slice(0, 8)}`);
    if (await run('git', ['reset', '--hard', manifest.sha], { cwd: root, log }) !== 0) {
      manifest.phase = before; await writeManifest(rb.dir, manifest); // (nothing was touched: the copy must not look like a roll back under way)
      throw new UpdateError('git reset failed');
    }
  } else await beginRestore(rb.dir, manifest);
  await restoreFiles({ root, dir: rb.dir, manifest });
  await finishRestore(rb.dir, manifest);
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
