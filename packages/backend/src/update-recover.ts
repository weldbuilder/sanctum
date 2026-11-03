// Pre-boot recovery: the FIRST import of server.ts, so it runs before any other module of the app is loaded (an ES module's imports are evaluated in order,
// and this one waits on its recovery before the next starts). It imports nothing of the app, only scripts/updater-core.mjs, which uses node's own modules.
//
// Why it has to be first: a swap that was cut short (kill -9, power cut, the machine going down mid-rename) leaves the folder half new and half old. The code
// that is booting is then the NEW backend running on whatever node_modules came with it, and a migration of the new version may already have run. So before
// anything loads, the manifest in .update-rollback.next (or .update-rollback) is read and a cut-short swap or roll back is finished: the old files renamed back,
// `git reset --hard <manifest sha>` whenever HEAD is not that sha (the merge runs as a child; a kill during it leaves no flag). If that changed anything, this
// process must not go on: the modules it could load are not the ones now on disk. It starts over (re-exec):
//   - run by hand or under a plain shell: a child `node <same arguments>` is spawned with the output shared; its exit code becomes this process's, and a signal sent
//     here (Ctrl+C, kill) is passed on to it. The app that serves is that child, running the restored code.
//   - under a supervisor (pm2's `pm_id`, or SANCTUM_SUPERVISED=1): this process exits with code 75 and the supervisor starts it again.
// The child cannot loop: it is started with SANCTUM_RECOVER_REEXEC=1, and by then there is nothing left to recover.
// `npm run update` runs the same recovery (scripts/update.mjs) before it does anything else, as does `npm start` (scripts/update.mjs --recover).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile, recoverInterruptedSwap } from '../../../scripts/updater-core.mjs';

/** The exit code that asks a supervisor to start the app again after a recovery. */
export const RECOVER_EXIT_CODE = 75;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const restarted = process.env.SANCTUM_RECOVER_REEXEC === '1';
delete process.env.SANCTUM_RECOVER_REEXEC; // (so a later recovery, in this process's own life, may re-exec again)

let changed = false;
try { changed = await recoverInterruptedSwap(root, (line) => console.log(`[update-recover] ${line}`)); }
catch (err) { console.warn('[update-recover] could not check for a cut-short swap:', (err as Error).message); }

if (changed) {
  if (restarted) {
    console.warn('[update-recover] recovered again straight after a restart; carrying on with what is on disk.');
  } else {
    readEnvFile(root); // (SANCTUM_SUPERVISED may be set only in .env)
    if (process.env.pm_id || process.env.SANCTUM_SUPERVISED === '1') {
      console.log(`[update-recover] the previous version is back; exiting ${RECOVER_EXIT_CODE} so the supervisor starts it again.`);
      process.exit(RECOVER_EXIT_CODE);
    }
    console.log('[update-recover] the previous version is back; starting the app again from it.');
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, SANCTUM_RECOVER_REEXEC: '1' } });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
    child.on('error', (err) => { console.error('[update-recover] could not start the app again:', err.message); process.exit(1); });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    await new Promise<never>(() => { /* this process is only the parent now; nothing after this import may load */ });
  }
}
