// updater-core.mjs — the update steps, shared by `npm run update` (scripts/update.mjs) and the in-app
// updater (packages/backend/src/services/updater.ts). One implementation, so the terminal and the app do
// the same thing, rollback copy included. Plain JS, no dependencies beyond node (js-yaml is read lazily).
//
// The order of an update:
//   checking    read the settings, ask GitHub for the newest version
//   (git)       refuse a dirty tree (the list is the error), refuse a checkout that is not on the update branch
//   fetching    git fetch, or download + unpack the tarball into a temp folder
//   (rollback)  copy what is about to change into <data dir>/update-rollback/<version>/ with a manifest
//   (apply)     git merge --ff-only, or copy the archive's files over the folder (never the companion's home)
//   installing  npm ci --include=dev (npm install only when there is no lockfile)
//   building    npm run build
// A failure after the rollback copy restores it (and `git reset --hard <previous sha>` on a git checkout,
// which is safe because the tree was clean), so the app is left on the old build.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
/** The folder the database lives in (and update-job.json, update-rollback/): the same place the app uses. */
export function dataDirFor(root, dbPath) { return dirname(resolve(root, dbPath || './data/sanctum.db')); }
export function readVersion(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version || '0.0.0'; } catch { return '0.0.0'; }
}
/** { repo, branch, cwd, dbPath } for an install folder. `cwd` is the companion's agent.cwd as written ('.' when unset). */
export async function readUpdateSettings(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const out = { repo: repoFromPackage(pkg), branch: 'main', cwd: '.', dbPath: './data/sanctum.db' };
  for (const name of ['sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const yaml = (await import('js-yaml')).default;
      const cfg = yaml.load(readFileSync(p, 'utf-8')) || {};
      if (cfg.updates?.repo) out.repo = String(cfg.updates.repo);
      if (cfg.updates?.branch) out.branch = String(cfg.updates.branch);
      if (cfg.agent?.cwd) out.cwd = String(cfg.agent.cwd);
      if (cfg.server?.db_path) out.dbPath = String(cfg.server.db_path);
    } catch { /* unreadable yaml: defaults */ }
    break;
  }
  if (process.env.DB_PATH) out.dbPath = process.env.DB_PATH;
  if (process.env.SANCTUM_REPO) out.repo = process.env.SANCTUM_REPO;
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
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
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
/** Run a command, handing each output line to `log`. Resolves with the exit code; never throws for a non-zero exit. */
export function run(cmd, args, { cwd, log = noop, env = process.env } = {}) {
  return new Promise((res) => {
    let child;
    try { child = spawn(cmd, args, { cwd, env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { log(`${cmd}: ${err.message}`); res(127); return; }
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
    child.on('error', (err) => { log(`${cmd}: ${err.message}`); res(127); });
    child.on('close', (code) => { if (buf.trim()) log(buf.trim()); res(code ?? 1); });
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

// ---- the rollback copy ------------------------------------------------------------
export function rollbackRoot(dataDir) { return join(dataDir, 'update-rollback'); }
const FIXED_ENTRIES = ['package.json', 'package-lock.json', 'packages/frontend/build'];
function distEntries(root) {
  const dir = join(root, 'packages');
  try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => `packages/${d.name}/dist`); } catch { return []; }
}
const sha256 = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return ''; } };
const safeName = (v) => String(v).replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';

/** What a rollback copy holds for this folder: package.json, the lockfile, every packages/<x>/dist, the frontend build, and `extra` (the archive's files). */
export function rollbackEntries(root, extra = []) {
  return [...new Set([...FIXED_ENTRIES, ...distEntries(root), ...extra])];
}

/** Copy the entries (paths relative to root) into <dataDir>/update-rollback/<version>/files with a manifest. Only the latest copy is kept. Returns the manifest. */
export function makeRollbackCopy({ root, dataDir, version, mode, branch, sha = null, extra = [], now = () => new Date() }) {
  const base = rollbackRoot(dataDir);
  mkdirSync(base, { recursive: true });
  const staging = join(base, `.new-${process.pid}-${Date.now()}`);
  mkdirSync(join(staging, 'files'), { recursive: true });
  const entries = [];
  for (const rel of rollbackEntries(root, extra)) {
    const src = join(root, rel);
    if (!existsSync(src)) { entries.push({ path: rel, kind: 'absent' }); continue; }
    const isDir = statSync(src).isDirectory();
    const dest = join(staging, 'files', rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    entries.push({ path: rel, kind: isDir ? 'dir' : 'file' });
  }
  const manifest = {
    version, mode, branch, sha, toSha: null, toVersion: null, created_at: now().toISOString(),
    lockfile_sha256: sha256(join(root, 'package-lock.json')), entries,
  };
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const d of readdirSync(base)) if (d !== basename(staging)) rmSync(join(base, d), { recursive: true, force: true });
  renameSync(staging, join(base, safeName(version)));
  return manifest;
}

/** The latest rollback copy, or null: { dir, manifest }. */
export function readRollback(dataDir) {
  const base = rollbackRoot(dataDir);
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
export function updateRollbackManifest(dataDir, patch) {
  const rb = readRollback(dataDir);
  if (!rb) return;
  writeFileSync(join(rb.dir, 'manifest.json'), JSON.stringify({ ...rb.manifest, ...patch }, null, 2));
}
export function clearRollback(dataDir) { rmSync(rollbackRoot(dataDir), { recursive: true, force: true }); }

/** Put the rollback copy back: every entry is replaced by the copy (or removed, if it did not exist then). Files only; git and npm are the caller's. */
export function restoreFiles({ root, dir, manifest }) {
  for (const e of manifest.entries) {
    const target = join(root, e.path);
    rmSync(target, { recursive: true, force: true });
    if (e.kind === 'absent') continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(dir, 'files', e.path), target, { recursive: true, force: true });
  }
}

// ---- dependencies and build ---------------------------------------------------------
async function installDeps(root, log) {
  const lock = existsSync(join(root, 'package-lock.json'));
  if (lock) log('npm ci --include=dev');
  else log('no package-lock.json: falling back to npm install --include=dev');
  const args = lock ? ['ci', '--include=dev', '--no-audit', '--no-fund'] : ['install', '--include=dev', '--no-audit', '--no-fund']; // dev deps build the frontend
  const code = await run('npm', args, { cwd: root, log });
  if (code !== 0) throw new UpdateError(`${lock ? 'npm ci' : 'npm install'} failed (exit ${code})`);
}
async function buildApp(root, log) {
  log('npm run build');
  const code = await run('npm', ['run', 'build'], { cwd: root, log });
  if (code !== 0) throw new UpdateError(`npm run build failed (exit ${code})`);
}

// ---- the tarball path -------------------------------------------------------------
/** The relative paths an archive must never overwrite: the person's own files, and the companion's home when it sits inside the app folder
 *  (companion-home/ is the shipped home, plus an agent.cwd that points at another folder inside the app). */
export function protectedPaths(root, cwd) {
  const out = ['.git', '.env', 'sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml', '.mcp.json', 'data', 'node_modules'];
  const rel = relative(resolve(root), resolve(root, cwd || '.'));
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside) {
    out.push('companion-home');
    if (rel !== '') out.push(rel.split(sep).join('/'));
  }
  return out;
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
    else if (d.isFile()) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}
/** The files an unpacked archive would write over `root`: its own file list (the archive holds tracked files only) minus the protected paths. */
export function archivePlan(extractedDir, root, cwd) {
  const prot = protectedPaths(root, cwd);
  const all = listFiles(extractedDir);
  return { files: all.filter(f => !isProtected(f, prot)), skipped: all.filter(f => isProtected(f, prot)) };
}
export function applyArchive(extractedDir, root, files) {
  for (const rel of files) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(extractedDir, rel), dest, { force: true });
  }
}

// ---- rolling back -------------------------------------------------------------------
/** Is there a rollback copy? { available, version, created_at, mode } */
export function rollbackInfo(dataDir) {
  const rb = readRollback(dataDir);
  if (!rb) return { available: false, version: null, created_at: null, mode: null };
  return { available: true, version: rb.manifest.version, created_at: rb.manifest.created_at, mode: rb.manifest.mode };
}

/** Restore the latest rollback copy: git reset first (a clean tree on the commit the update left, unless `force`), then the files, then node_modules to match the restored lockfile. */
export async function rollbackNow({ root, dataDir, log = noop, force = false, depsTouched = false }) {
  const rb = readRollback(dataDir);
  if (!rb) throw new UpdateError('there is no rollback copy');
  const { manifest } = rb;
  if (manifest.mode === 'git' && manifest.sha) {
    if (!force) {
      const dirty = gitDirty(root);
      if (dirty.length) throw new UpdateError(`This folder has local changes, so it was not rolled back. Commit or discard them, then try again:\n${dirty.join('\n')}`, { dirty });
      if (manifest.toSha && gitHead(root) !== manifest.toSha) throw new UpdateError('This checkout has moved on since the update (new commits), so it was not rolled back.');
    }
    log(`git reset --hard ${manifest.sha.slice(0, 8)}`);
    if (await run('git', ['reset', '--hard', manifest.sha], { cwd: root, log }) !== 0) throw new UpdateError('git reset failed');
  }
  const lockBefore = sha256(join(root, 'package-lock.json'));
  restoreFiles({ root, dir: rb.dir, manifest });
  log(`restored ${manifest.entries.length} items from the ${manifest.version} copy`);
  // node_modules should match the restored lockfile. Best effort: a failure here is logged; the files are already back.
  if (depsTouched || (manifest.lockfile_sha256 && lockBefore !== manifest.lockfile_sha256)) {
    try { await installDeps(root, log); } catch (err) { log(`warning: ${err.message}; run npm ci in the app folder`); }
  }
  return { version: manifest.version, mode: manifest.mode };
}
/** A manual roll back: restores, then forgets the copy. */
export async function runRollback(opts) {
  const r = await rollbackNow({ ...opts, force: false });
  clearRollback(opts.dataDir);
  (opts.log ?? noop)(`rolled back to ${r.version}`);
  return r;
}

// ---- the whole update -------------------------------------------------------------
/**
 * Update an install folder.
 * opts: { root, dataDir, force?, log?, setState?, fetchFn?, settings? }
 * Returns { upToDate:true, current, latest } or { upToDate:false, from, to, mode, sha, toSha }.
 * Throws UpdateError (`restored` says the rollback copy was put back; `dirty` is the list when the tree had local changes).
 */
export async function runUpdate(opts) {
  const { root, dataDir, force = false, log = noop, setState = noop, fetchFn = fetch } = opts;
  setState('checking');
  const settings = opts.settings ?? await readUpdateSettings(root);
  const { repo, branch } = settings;
  const from = readVersion(root);
  log(`you have ${from}`);
  let latest;
  try { latest = await remoteVersion(repo, branch, fetchFn); } catch (err) {
    throw new UpdateError(`could not check GitHub: ${err.message}. No internet? Try again later. If the project on GitHub is private, put GITHUB_TOKEN=<a token with read access> in .env.`);
  }
  if (!force && !isNewer(latest, from)) { log(`newest is ${latest}. You already have it.`); return { upToDate: true, current: from, latest }; }
  log(`newest is ${latest}, updating`);

  const support = selfUpdateSupport(root);
  if (!support.ok) throw new UpdateError(support.reason);
  const mode = support.mode;
  let sha = null;
  let toSha = null;
  let tmp = null;
  let rolledCopy = false;
  let depsTouched = false;

  const restore = async (why) => {
    if (!rolledCopy) return false;
    log(`${why}: putting the previous version back`);
    try { await rollbackNow({ root, dataDir, log, force: true, depsTouched }); clearRollback(dataDir); return true; }
    catch (err) { log(`could not put the previous version back: ${err.message}`); return false; }
  };

  try {
    if (mode === 'git') {
      const dirty = gitDirty(root);
      if (dirty.length) {
        throw new UpdateError(`This folder has local changes, so it was not updated. Commit or discard them, then try again:\n${dirty.join('\n')}`, { dirty });
      }
      const here = gitBranch(root);
      if (here !== branch) throw new UpdateError(`This checkout is on "${here}" but the update branch is "${branch}" (updates.branch). Switch the checkout to ${branch}, or change updates.branch.`);
      sha = gitHead(root);
      setState('fetching');
      log(`git fetch origin ${branch}`);
      if (await run('git', ['fetch', 'origin', branch], { cwd: root, log }) !== 0) throw new UpdateError('git fetch failed');
      makeRollbackCopy({ root, dataDir, version: from, mode, branch, sha });
      rolledCopy = true;
      log(`rollback copy kept (${from}, ${sha.slice(0, 8)})`);
      log(`git merge --ff-only origin/${branch}`);
      if (await run('git', ['merge', '--ff-only', `origin/${branch}`], { cwd: root, log }) !== 0) throw new UpdateError('git merge --ff-only failed: this checkout has commits the branch does not have. Nothing was changed.');
      toSha = gitHead(root);
    } else {
      setState('fetching');
      tmp = mkdtempSync(join(tmpdir(), 'sanctum-update-'));
      log(`downloading ${repo}@${branch}`);
      let file;
      try { file = await downloadTarball(repo, branch, tmp, fetchFn); } catch (err) { throw new UpdateError(`could not download the update: ${err.message}`); }
      const unpack = join(tmp, 'unpacked');
      mkdirSync(unpack);
      if (await run('tar', ['-xzf', file, '-C', unpack], { cwd: tmp, log }) !== 0) throw new UpdateError('could not unpack the download (is `tar` installed?)');
      const top = readdirSync(unpack, { withFileTypes: true }).find(d => d.isDirectory());
      if (!top) throw new UpdateError('the download was empty');
      const extracted = join(unpack, top.name);
      const plan = archivePlan(extracted, root, settings.cwd);
      if (plan.skipped.length) log(`not touching ${plan.skipped.length} file${plan.skipped.length === 1 ? '' : 's'} that belong to you or your companion's home`);
      makeRollbackCopy({ root, dataDir, version: from, mode, branch, extra: plan.files });
      rolledCopy = true;
      log(`rollback copy kept (${from}, ${plan.files.length} files)`);
      log('copying the new files over this folder (your settings and data stay)');
      applyArchive(extracted, root, plan.files);
    }
    setState('installing');
    depsTouched = true;
    await installDeps(root, log);
    setState('building');
    await buildApp(root, log);
  } catch (err) {
    const restored = await restore(err.message);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    throw new UpdateError(err.message, { restored, dirty: err.dirty });
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  const to = readVersion(root);
  if (rolledCopy) updateRollbackManifest(dataDir, { toSha, toVersion: to });
  log(`done: ${from} -> ${to}`);
  return { upToDate: false, from, to, mode, sha, toSha };
}
