// setup-auth-mode.mjs — the terminal wizard's way to set the auth mode: the app's own service (packages/backend/src/services/auth-preferences.ts),
// run once in a child process, since the wizard is plain JavaScript and the service is TypeScript. The in-app wizard calls the service directly.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wizardDbPath } from './setup-discord.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The first stderr line that names an Error, else the whole stderr trimmed to 300 characters (the last line is only the Node version). */
function failureText(r) {
  const err = String(r.stderr || '').trim();
  if (!err) return r.error?.message || 'the auth service did not run';
  const lines = err.split('\n'); // a thrown Error prints its source line first, then `Error: message`
  return (lines.find((l) => /^\w*Error\b/.test(l.trim())) || lines.find((l) => /Error/.test(l)))?.trim().slice(0, 300) || err.slice(0, 300);
}

/** A setAuthMode(update) for applySetup(opts): throws (the wizard then says so) when the service cannot be run. */
export function terminalSetAuthMode(cfgRoot = root, existing = {}, env = process.env) {
  // `cfg` is the config the wizard just loaded/wrote, so server.db_path from sanctum.yaml is honoured.
  return (update, cfg) => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'packages', 'backend', 'src', 'set-auth-mode.ts'), wizardDbPath(cfgRoot, cfg ?? existing, env.DB_PATH)], {
      input: JSON.stringify(update), encoding: 'utf-8', cwd: root, timeout: 60000,
    });
    if (r.status !== 0) throw new Error(failureText(r));
  };
}
