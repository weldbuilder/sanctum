// update.mjs — bring this install up to the newest version with one command:
//
//   npm run update
//
// Works for a folder that was downloaded as a ZIP (no git) and for a git clone.
// Your own files are never touched: sanctum.yaml, .env, data/, the companion's
// home folder and .mcp.json are not part of the download, so nothing overwrites
// them. Files that ARE part of the project (prompts/wake.md, the example files)
// are replaced with the newest copies.
//
// How "newest" is decided: the version in package.json on GitHub. The in-app
// notice uses the same number, so a release is "bump the version, push to main".
//
// Where "GitHub" is: the "repository" line in package.json (one place to
// change if the project moves), or updates.repo / updates.branch in
// sanctum.yaml to override. GITHUB_TOKEN in .env if the project is private.

import { execSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

function say(msg) { console.log(`[update] ${msg}`); }
function fail(msg) { console.error(`[update] ${msg}`); process.exit(1); }

// ---- settings ---------------------------------------------------------------
function readEnvFile() {
  const p = join(root, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
// "owner/name" from package.json's repository line: "github:owner/name",
// "https://github.com/owner/name.git", or { url: ... }.
function repoFromPackage(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = /(?:github:|github\.com[/:])([^/\s]+\/[^/\s#]+?)(?:\.git)?\/?$/.exec(r) || /^([^/\s]+\/[^/\s]+)$/.exec(r);
  return m ? m[1] : '';
}
async function readUpdateSettings() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const out = { repo: repoFromPackage(pkg), branch: 'main' };
  for (const name of ['sanctum.yaml', 'sanctum.yml', 'resonant.yaml', 'resonant.yml']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const yaml = (await import('js-yaml')).default;
      const cfg = yaml.load(readFileSync(p, 'utf-8')) || {};
      if (cfg.updates?.repo) out.repo = String(cfg.updates.repo);
      if (cfg.updates?.branch) out.branch = String(cfg.updates.branch);
    } catch { /* unreadable yaml: defaults */ }
    break;
  }
  if (process.env.SANCTUM_REPO) out.repo = process.env.SANCTUM_REPO;
  if (process.env.SANCTUM_BRANCH) out.branch = process.env.SANCTUM_BRANCH;
  if (!out.repo) fail('no GitHub address: set "repository" in package.json (github:owner/name) or updates.repo in sanctum.yaml');
  return out;
}

// ---- GitHub -----------------------------------------------------------------
function ghHeaders(accept) {
  const h = { 'User-Agent': 'sanctum-mobile-updater', Accept: accept };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}
async function remoteVersion(repo, branch) {
  // Public project: the raw file host, no rate limit, no token. Private, or
  // anything else wrong: the API, which honours GITHUB_TOKEN.
  const tries = [
    { url: `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/package.json`, accept: 'text/plain' },
    { url: `https://api.github.com/repos/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`, accept: 'application/vnd.github.raw+json' },
  ];
  let last = '';
  for (const t of tries) {
    try {
      const res = await fetch(t.url, { headers: ghHeaders(t.accept), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { last = `GitHub answered ${res.status} for ${repo}`; continue; }
      return String(JSON.parse(await res.text()).version || '');
    } catch (err) { last = err.message; }
  }
  throw new Error(last || 'unreachable');
}
function isNewer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
async function downloadTarball(repo, branch, into) {
  const tries = [
    `https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`, // public
    `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(branch)}`,          // private, with GITHUB_TOKEN
  ];
  let last = '';
  for (const url of tries) {
    try {
      const res = await fetch(url, { headers: ghHeaders('application/vnd.github+json'), redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!res.ok) { last = `GitHub answered ${res.status} for the download`; continue; }
      const file = join(into, 'sanctum.tar.gz');
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return file;
    } catch (err) { last = err.message; }
  }
  throw new Error(last || 'unreachable');
}

// ---- the two ways to update ---------------------------------------------------
function haveGit() {
  return existsSync(join(root, '.git')) && spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}
function updateWithGit(branch) {
  const dirty = execSync('git status --porcelain', { cwd: root }).toString().trim();
  if (dirty) {
    fail(`This folder has local changes git would have to overwrite:\n${dirty}\nCommit or discard them (git stash), then run npm run update again.`);
  }
  say(`git pull origin ${branch}`);
  execSync(`git pull --ff-only origin ${branch}`, { cwd: root, stdio: 'inherit' });
}
async function updateWithTarball(repo, branch) {
  const tmp = mkdtempSync(join(tmpdir(), 'sanctum-update-'));
  try {
    say(`downloading ${repo}@${branch}`);
    const file = await downloadTarball(repo, branch, tmp);
    const r = spawnSync('tar', ['-xzf', file, '-C', tmp], { stdio: 'inherit' });
    if (r.status !== 0) fail('could not unpack the download (is `tar` installed?)');
    const extracted = readdirSync(tmp, { withFileTypes: true }).find(d => d.isDirectory());
    if (!extracted) fail('the download was empty');
    say('copying the new files over this folder (your settings and data stay)');
    cpSync(join(tmp, extracted.name), root, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- the Mind ---------------------------------------------------------------
// One line: did the configured Mind answer? The freshly built app does the asking (it reads the same
// settings the app does and runs the watchdog's probe once). Never prompts, never writes, never fails the update.
function mindLine() {
  const entry = join(root, 'packages', 'backend', 'dist', 'mind-check.js');
  if (!existsSync(entry)) return;
  const r = spawnSync(process.execPath, [entry], { cwd: root, encoding: 'utf-8', timeout: 30000, env: process.env });
  const line = String(r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop();
  if (line && /^Mind:/.test(line)) say(line);
}

// ---- main ---------------------------------------------------------------------
readEnvFile();
const { repo, branch } = await readUpdateSettings();
const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version || '0.0.0';
say(`you have ${current}`);

let latest = '';
try {
  latest = await remoteVersion(repo, branch);
} catch (err) {
  fail(`could not check GitHub: ${err.message}.\n` +
    `  - No internet? Try again later.\n` +
    `  - If the project on GitHub is private, put GITHUB_TOKEN=<a token with read access> in .env.\n` +
    `  - Or download the ZIP from GitHub again and copy it over this folder, then: npm install && npm run build`);
}
if (!force && !isNewer(latest, current)) {
  say(`newest is ${latest}. You already have it. (npm run update -- --force reinstalls anyway.)`);
  mindLine();
  process.exit(0);
}
say(`newest is ${latest}, updating`);

try {
  if (haveGit()) updateWithGit(branch);
  else await updateWithTarball(repo, branch);
} catch (err) {
  fail(`update stopped: ${err.message}`);
}

say('installing');
execSync('npm install --include=dev --no-audit --no-fund', { cwd: root, stdio: 'inherit' }); // dev deps build the frontend; NODE_ENV=production would skip them
say('building');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

const now = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
say(`done: ${current} -> ${now}`);
mindLine();
say('Now restart the app: press Ctrl+C in the window where it runs, then:  npm start');
