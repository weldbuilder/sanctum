// setup-auth-mode.mjs — the terminal wizard's way to set the auth mode: the app's own service (packages/backend/src/services/auth-preferences.ts),
// run once in a child process, since the wizard is plain JavaScript and the service is TypeScript. The in-app wizard calls the service directly.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wizardDbPath } from './setup-discord.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A setAuthMode(update) for applySetup(opts): throws (the wizard then says so) when the service cannot be run. */
export function terminalSetAuthMode(cfgRoot = root, existing = {}, env = process.env) {
  return (update) => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'packages', 'backend', 'src', 'set-auth-mode.ts'), wizardDbPath(cfgRoot, existing, env.DB_PATH)], {
      input: JSON.stringify(update), encoding: 'utf-8', cwd: root, timeout: 60000,
    });
    if (r.status !== 0) throw new Error(String(r.stderr || r.error?.message || 'the auth service did not run').trim().split('\n').pop());
  };
}
