#!/usr/bin/env node
// setup-proof.mjs — drive the real `npm run setup` CLI through a pseudo-terminal, scenario by scenario,
// and record what it printed and every file it wrote. Run it on two checkouts and compare the results:
//
//   node scripts/setup-proof.mjs run <checkout> <out folder> [scenario names...]
//   node scripts/setup-proof.mjs compare <out A> <out B>
//   node scripts/setup-proof.mjs golden <out folder> <fixtures folder>   (normalized transcript + file digests)
//
// Developer tool, Linux and macOS only (it needs a pty, which python3 gives it). The scenarios are in
// scripts/__fixtures__/setup/scenarios.mjs; scripts/setup-walk.test.mjs replays them in-process on POSIX systems (Linux and macOS: the recording holds POSIX paths and modes; it is skipped on Windows).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { answersFor, appFixture, fileText, normalize, scenarios } from './__fixtures__/setup/scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SBX = process.env.SETUP_PROOF_SBX || '/var/tmp/setup-proof-sbx';
const require = createRequire(import.meta.url);

const norm = (text, sbx = SBX) => normalize(text, sbx);

function walk(dir, out = []) {
  for (const it of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, it.name);
    if (it.name === 'node_modules') continue;
    if (it.isDirectory()) walk(p, out); else if (it.isFile()) out.push(p);
  }
  return out;
}
function walkDirs(dir, out = []) {
  for (const it of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, it.name);
    if (it.name === 'node_modules' || !it.isDirectory()) continue;
    out.push(p);
    walkDirs(p, out);
  }
  return out;
}
const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function build(sc, tree) {
  rmSync(SBX, { recursive: true, force: true });
  mkdirSync(join(SBX, 'home'), { recursive: true });
  mkdirSync(join(SBX, 'bin'), { recursive: true });
  const app = join(SBX, 'app');
  // Only what the wizard runs from (its scripts and the browser entry check it imports); the app's own files, the starter
  // template and the shipped plugin are fixed text, so a recording does not move when the real ones change.
  mkdirSync(join(app, 'examples'), { recursive: true });
  cpSync(join(tree, 'scripts'), join(app, 'scripts'), { recursive: true, filter: (s) => !/__fixtures__/.test(s) });
  cpSync(join(tree, 'examples', 'browser-seat-neko'), join(app, 'examples', 'browser-seat-neko'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{ "name": "sandbox" }\n');
  symlinkSync(join(tree, 'node_modules'), join(app, 'node_modules'));
  appFixture(fs, path, app);
  if (sc.extraPlugin) {
    const d = join(app, 'plugins', sc.extraPlugin);
    mkdirSync(join(d, 'dsh'), { recursive: true });
    writeFileSync(join(d, 'sanctum.plugin.json'), JSON.stringify({ id: sc.extraPlugin, name: `The ${sc.extraPlugin} plugin` }));
    writeFileSync(join(d, 'dsh', 'index.mjs'), `export default '${sc.extraPlugin}';\n`);
  }
  for (const [rel, text] of Object.entries(sc.beforeRun || {})) writeFileSync(join(SBX, rel), fileText(text, SBX));
  if (sc.codex) { writeFileSync(join(SBX, 'bin', 'codex'), '#!/bin/sh\necho codex-cli 0.0.0\n'); chmodSync(join(SBX, 'bin', 'codex'), 0o755); }
  for (const [rel, text] of Object.entries(sc.files || {})) {
    const p = join(SBX, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, fileText(text, SBX));
  }
  for (const [rel, rows] of Object.entries(sc.db || {})) {
    const p = join(SBX, rel);
    mkdirSync(dirname(p), { recursive: true });
    const Database = require(join(tree, 'node_modules', 'better-sqlite3'));
    const db = new Database(p);
    db.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
    for (const [k, v] of Object.entries(rows)) db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(k, v);
    db.close();
  }
}

function snapshotBefore() {
  const m = new Map();
  for (const p of walk(SBX)) m.set(p, digest(p));
  m.dirs = new Set(walkDirs(SBX));
  return m;
}
function snapshotAfter(before) {
  const files = {};
  for (const p of walk(SBX)) {
    if (before.get(p) === digest(p)) continue;
    const rel = norm(relative(SBX, p).replaceAll('\\', '/'));
    const mode = (statSync(p).mode & 0o777).toString(8);
    files[rel] = { mode, text: norm(readFileSync(p, 'utf-8')) };
  }
  return files;
}

// A checkout that has phases asks only the first-run questions by default: SETUP_PROOF_ARGS=--all makes it ask them all, as the original did
// (the recordings of the original are of that); a scenario with a `phase` of its own passes the flag for it.
const phaseArgs = (sc) => (sc.phase ? (sc.phase === 'one' ? [] : [`--${sc.phase}`]) : (process.env.SETUP_PROOF_ARGS || '').split(' ').filter(Boolean));

function runPty(answers, outDir, label, { tenant, create, phase } = {}) {
  const preload = join(here, '__fixtures__', 'setup', 'deterministic.mjs');
  const job = {
    cmd: [process.execPath, '--import', preload, join(SBX, 'app', 'scripts', 'setup.mjs'), ...phaseArgs({ phase }), ...(tenant ? ['--tenant', tenant, ...(create ? ['--create'] : [])] : [])],
    cwd: join(SBX, 'app'),
    env: { PATH: `${join(SBX, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(SBX, 'home'), USERPROFILE: join(SBX, 'home'), TZ: 'UTC', LANG: 'C.UTF-8', TERM: 'xterm' },
    answers,
    out: join(outDir, `${label}.raw`),
  };
  writeFileSync(join(outDir, `${label}.job.json`), JSON.stringify(job));
  const r = spawnSync('python3', [join(here, 'setup-pty.py'), join(outDir, `${label}.job.json`)], { encoding: 'utf-8' });
  const raw = existsSync(job.out) ? readFileSync(job.out, 'utf-8') : '';
  rmSync(job.out, { force: true });
  rmSync(join(outDir, `${label}.job.json`), { force: true });
  return { raw, status: (r.stdout || '').trim() || r.stderr, ok: r.status === 0 };
}

function runOne(sc, tree, outDir) {
  build(sc, tree);
  const before = snapshotBefore();
  mkdirSync(outDir, { recursive: true });
  const first = runPty(answersFor(sc, SBX), outDir, 'first', sc);
  let raw = first.raw;
  let ok = first.ok;
  let status = first.status;
  if (sc.again && ok) {
    for (const [rel, text] of Object.entries(sc.again.files || {})) writeFileSync(join(SBX, rel), fileText(text, SBX));
    const second = runPty(answersFor(sc.again, SBX), outDir, 'second', sc);
    raw += '\n=== the same setup, run again ===\n' + second.raw;
    ok = second.ok;
    status = second.status;
  }
  writeFileSync(join(outDir, 'transcript.txt'), norm(raw));
  writeFileSync(join(outDir, 'files.json'), JSON.stringify(snapshotAfter(before), null, 2) + '\n');
  // The folders the wizard created, and whether each is owner-only (a browser-out folder or a Discord private folder must be).
  const dirs = {};
  for (const p of walkDirs(SBX)) if (!before.dirs.has(p)) dirs[norm(relative(SBX, p).replaceAll('\\', '/'))] = { mode: (statSync(p).mode & 0o777).toString(8) };
  writeFileSync(join(outDir, 'dirs.json'), JSON.stringify(dirs, null, 2) + '\n');
  return { status, ok };
}

const [cmd, a, b, ...rest] = process.argv.slice(2);
if (cmd === 'run') {
  const tree = resolve(a);
  const names = rest;
  let bad = 0;
  for (const sc of scenarios) {
    if (names.length && !names.includes(sc.name)) continue;
    const r = runOne(sc, tree, join(resolve(b), sc.name));
    if (!r.ok) bad++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${sc.name} ${r.status}`);
  }
  process.exit(bad ? 1 : 0);
} else if (cmd === 'compare') {
  let diffs = 0;
  for (const sc of scenarios) {
    const A = join(resolve(a), sc.name);
    const B = join(resolve(b), sc.name);
    if (!existsSync(A) || !existsSync(B)) continue;
    // A .env the wizard creates is owner-only on this branch (0600); the original made it with the umask. That one mode is the only allowed difference.
    const files = (d) => { const j = JSON.parse(readFileSync(join(d, 'files.json'), 'utf-8')); return j; };
    const fa = files(A);
    const fb = files(B);
    let envMode = false;
    if (fa['app/.env'] && fb['app/.env'] && fa['app/.env'].mode !== fb['app/.env'].mode && fb['app/.env'].mode === '600') { fb['app/.env'].mode = fa['app/.env'].mode; envMode = true; }
    const dirsOf = (d) => (existsSync(join(d, 'dirs.json')) ? readFileSync(join(d, 'dirs.json'), 'utf-8') : '{}\n');
    const same = readFileSync(join(A, 'transcript.txt'), 'utf-8') === readFileSync(join(B, 'transcript.txt'), 'utf-8')
      && JSON.stringify(fa) === JSON.stringify(fb) && dirsOf(A) === dirsOf(B);
    if (!same) { diffs++; console.log(`DIFF ${sc.name}`); } else console.log(`same ${sc.name}${envMode ? ' (.env created 0600)' : ''}`);
  }
  process.exit(diffs ? 1 : 0);
} else if (cmd === 'golden') {
  const out = resolve(b);
  mkdirSync(out, { recursive: true });
  for (const sc of scenarios) {
    const A = join(resolve(a), sc.name);
    if (!existsSync(A)) continue;
    writeFileSync(join(out, `${sc.name}.transcript.txt`), readFileSync(join(A, 'transcript.txt')));
    const files = JSON.parse(readFileSync(join(A, 'files.json'), 'utf-8'));
    const summary = {};
    // `private`: nobody but the owner can read it (the ledger, the Discord lists); the other modes follow the umask.
    for (const [rel, f] of Object.entries(files)) summary[rel] = { private: (parseInt(f.mode, 8) & 0o077) === 0, sha256: createHash('sha256').update(f.text).digest('hex'), bytes: Buffer.byteLength(f.text) };
    writeFileSync(join(out, `${sc.name}.files.json`), JSON.stringify(summary, null, 2) + '\n');
    // Created folders, as owner-only or not (written only when the scenario creates some).
    const dirsFile = join(resolve(a), sc.name, 'dirs.json');
    const dirs = existsSync(dirsFile) ? JSON.parse(readFileSync(dirsFile, 'utf-8')) : {};
    const dsum = Object.fromEntries(Object.entries(dirs).map(([rel, d]) => [rel, { private: (parseInt(d.mode, 8) & 0o077) === 0 }]));
    if (Object.keys(dsum).length) writeFileSync(join(out, `${sc.name}.dirs.json`), JSON.stringify(dsum, null, 2) + '\n');
  }
} else {
  console.error('usage: setup-proof.mjs run <checkout> <out> [names...] | compare <outA> <outB> | golden <out> <fixtures>');
  process.exit(2);
}
