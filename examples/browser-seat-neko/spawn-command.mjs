// How mcp-filter.mjs starts the server it wraps. No dependencies.
//
// Never through a shell. `shell: true` (which the filter used on Windows so `npx` would resolve)
// hands the whole command to cmd.exe as ONE string, so an argument with a space in it (the
// absolute --output-dir under "C:\Users\Some Name\...") is split into two, and a metacharacter in
// an argument is cmd.exe's to interpret. The server is started from an argv array instead.
//
// That leaves one Windows problem: `npx` is not an executable there, it is npx.cmd, and since the
// April 2024 security releases Node (18.20.2, 20.12.2, 21.7.3, 22+) refuses to spawn a .cmd or
// .bat without a shell (spawn throws EINVAL). So `npx` is resolved to what the shim runs:
// `node <npm>/bin/npx-cli.js`, found next to the running node.exe, or beside the npx.cmd on PATH
// (nvm-windows, Volta and similar layouts). Other bare names are resolved the way Windows does it:
// each PATH entry in order, each PATHEXT extension in order. A bare name that only exists as a
// .cmd/.bat is returned as that full path; the caller's spawn then fails with a clear error rather
// than splitting arguments.
import { existsSync } from 'node:fs';
import nodePath from 'node:path';

const NPX_CLI = ['node_modules', 'npm', 'bin', 'npx-cli.js'];

const envValue = (env, name) => {
  for (const k of Object.keys(env || {})) if (k.toLowerCase() === name && typeof env[k] === 'string' && env[k]) return env[k];
  return '';
};

/** Resolve `cmd` for spawn() without a shell. Returns { command, args }: `args` go BEFORE the caller's
 *  own arguments (it is [] except for npx on Windows, where it is the path of npx-cli.js).
 *  `opts` (all optional) makes the Windows rules testable anywhere: { platform, pathApi, env, execPath, exists }. */
export function resolveCommand(cmd, opts = {}) {
  const same = { command: cmd, args: [] };
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' || typeof cmd !== 'string' || !cmd) return same;
  const pm = opts.pathApi ?? nodePath.win32;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const execPath = opts.execPath ?? process.execPath;

  const dirs = envValue(env, 'path').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const exts = (envValue(env, 'pathext') || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  // Windows looks in each PATH entry in turn and, in each, tries the extensions in PATHEXT order.
  const find = (name) => {
    for (const d of dirs) for (const e of exts) { const f = pm.join(d, name + e); if (exists(f)) return f; }
    return null;
  };

  const isPath = /[\\/]/.test(cmd);
  const base = pm.basename(cmd).toLowerCase();
  if (!isPath && (base === 'npx' || base === 'npx.cmd')) {
    const shim = find('npx');
    const candidates = [pm.join(pm.dirname(execPath), ...NPX_CLI), ...(shim ? [pm.join(pm.dirname(shim), ...NPX_CLI)] : [])];
    const cli = candidates.find((c) => exists(c));
    if (cli) return { command: execPath, args: [cli] };
    return shim ? { command: shim, args: [] } : same;
  }
  if (isPath || pm.extname(cmd)) return same;
  const found = find(cmd);
  return found ? { command: found, args: [] } : same;
}

/** spawn() options for the wrapped server: its own working directory, stdin/stdout piped to the filter,
 *  stderr passed through. There is no `shell` key, on any platform, and a test keeps it that way. */
export function childSpawnOptions(cwd, _platform = process.platform) {
  return { cwd, stdio: ['pipe', 'pipe', 'inherit'] };
}
