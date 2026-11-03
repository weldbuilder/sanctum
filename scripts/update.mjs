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
//
// The steps live in scripts/updater-core.mjs, the same module the in-app "Update and
// restart" uses: a git checkout with local changes is refused (the list is shown), a
// update is built in <app>/.update-stage/ first (the running folder is untouched until that has built), the previous node_modules, dist
// and build are kept in <app>/.update-rollback/, and `npm run update -- --rollback` puts them back by hand (a copy is written as .update-rollback.next and replaces the previous one only once the swap succeeded). --rollback needs nothing
// from the app but node and git, so it works when the app cannot start.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateError, discardStage, killAllChildren, readEnvFile, readUpdateSettings, readVersion, recoverDetailed, rollbackInfo, runRollback, runUpdate } from './updater-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

function say(msg) { console.log(`[update] ${msg}`); }
function fail(msg) { console.error(`[update] ${msg}`); process.exit(1); }

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
readEnvFile(root);
// First of all: a swap or a roll back that an earlier run was cut short in (kill, power cut) is finished from its manifest, so this run starts from a whole folder.
// `--recover` does only that. `npm start` runs it as `--recover --boot` before the app (it works when packages/backend/dist is missing, which a swap cut short can cause, and it
// never fails the start: dist/boot.js runs the same recovery and the app's update job says what was found). A plain `--recover` also retries a recovery an earlier attempt could not
// finish (git missing, a lock file) and exits 1 when it still cannot; `--boot` does not retry.
const recoverOnly = process.argv.includes('--recover');
const booting = process.argv.includes('--boot');
let recovered = null;
try {
  recovered = recoverDetailed(root, { log: say, retry: recoverOnly && !booting });
  if (recovered.outcome === 'restored') say('the files an interrupted update had changed are back as they were.');
  else if (recovered.outcome === 'adopted') say('an update that had finished was settled: its rollback copy is kept.');
  else if (recovered.outcome === 'failed' || recovered.outcome === 'refused') say(`recovery: ${recovered.detail}`);
} catch (err) { say(`could not check for an interrupted update: ${err.message}`); }
if (recoverOnly) {
  if (!booting && recovered?.outcome === 'nothing') say('nothing to recover.');
  process.exit(!booting && (recovered?.outcome === 'failed' || recovered?.outcome === 'refused') ? 1 : 0);
}
// Ctrl+C stops the npm/tsc/vite children too (they are their own process groups) and deletes the stage: nothing in the app was changed.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAllChildren(); discardStage(root).finally(() => process.exit(130)); });
if (process.argv.includes('--rollback')) {
  // Nothing here reads the settings or the app: the copy and its manifest are all it needs.
  if (!rollbackInfo(root).available) fail('there is no rollback copy (one is kept each time an update runs).');
  try { await runRollback({ root, log: say }); } catch (err) { fail(err.message); }
  mindLine();
  say('Now restart the app: press Ctrl+C in the window where it runs, then:  npm start');
  process.exit(0);
}

let settings;
try { settings = await readUpdateSettings(root); } catch (err) { fail(err.message); }

let result;
try {
  result = await runUpdate({ root, force, settings, log: say });
} catch (err) {
  if (err instanceof UpdateError) {
    fail(`update stopped: ${err.message}\n[update] ${err.restored ? 'The previous version was put back.' : 'Nothing in the app was changed.'}\n` +
      '  - Or download the ZIP from GitHub again and copy it over this folder, then: npm install && npm run build');
  }
  throw err;
}
if (result.upToDate && result.already) {
  say(`already on ${result.current}: this checkout is on the newest commit, so nothing was rebuilt.`);
  mindLine();
  process.exit(0);
}
if (result.upToDate) {
  say(`newest is ${result.latest}. You already have it. (npm run update -- --force reinstalls anyway.)`);
  mindLine();
  process.exit(0);
}
say(`done: ${result.from} -> ${readVersion(root)}`);
mindLine();
say('Now restart the app: press Ctrl+C in the window where it runs, then:  npm start');
