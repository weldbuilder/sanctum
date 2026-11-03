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
// and build are kept in <app>/.update-rollback/, and `npm run update -- --rollback` puts them back by hand. --rollback needs nothing
// from the app but node and git, so it works when the app cannot start.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateError, discardStage, killAllChildren, readEnvFile, readUpdateSettings, readVersion, rollbackInfo, runRollback, runUpdate } from './updater-core.mjs';

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
if (result.upToDate) {
  say(`newest is ${result.latest}. You already have it. (npm run update -- --force reinstalls anyway.)`);
  mindLine();
  process.exit(0);
}
say(`done: ${result.from} -> ${readVersion(root)}`);
mindLine();
say('Now restart the app: press Ctrl+C in the window where it runs, then:  npm start');
