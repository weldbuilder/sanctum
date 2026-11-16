// set-config.mjs: the two edits install.sh makes to sanctum.yaml, with the same yaml writer the setup wizard and PUT /api/preferences use.
//
//   node scripts/hosting/set-config.mjs [--root <app folder>] [--origin <https://...>]... [--default-cwd <folder>]
//
//   --origin       add to cors.origins (once; the others stay). The address a browser opens the app from has to be listed or the live
//                  connection is refused.
//   --default-cwd  set agent.cwd to this folder only when the file does not name one (unset, "" or "."), so the wizard offers it.
//
// js-yaml writes the file back, so comments inside it are lost (the wizard does the same); the leading block of # lines is kept.
// A missing sanctum.yaml is created. Nothing here reads or prints a secret.
import { createRequire } from 'node:module';
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** `text` (a sanctum.yaml, or '') with the edits applied. `opts`: { origins: string[], defaultCwd?: string }. Throws a one-line Error for yaml that is not a mapping. */
export function editConfig(text, opts = {}) {
  const yaml = require('js-yaml');
  const src = String(text || '');
  const header = [];
  for (const line of src.split('\n')) { if (line.startsWith('#')) header.push(line); else break; }
  let cfg = {};
  try { cfg = yaml.load(src) ?? {}; } catch (e) { throw new Error(`sanctum.yaml does not parse (${String(e?.reason || 'yaml error')}); fix it, then run this again`); }
  if (!isMap(cfg)) throw new Error('sanctum.yaml is not a mapping of keys; fix it, then run this again');
  const origins = (opts.origins || []).map((o) => String(o).replace(/\/+$/, ''));
  for (const o of origins) if (!/^https?:\/\/[^\s/]+$/.test(o)) throw new Error(`"${o}" is not an origin (like https://box.example.net, with no path)`);
  if (origins.length) {
    const have = Array.isArray(cfg.cors?.origins) ? cfg.cors.origins.map(String) : [];
    cfg.cors = { ...(isMap(cfg.cors) ? cfg.cors : {}), origins: [...have, ...origins.filter((o) => !have.includes(o))] };
  }
  if (opts.defaultCwd) {
    const cwd = isMap(cfg.agent) ? cfg.agent.cwd : undefined;
    if (typeof cwd !== 'string' || !cwd.trim() || cwd.trim() === '.') cfg.agent = { ...(isMap(cfg.agent) ? cfg.agent : {}), cwd: opts.defaultCwd };
  }
  const head = header.length ? `${header.join('\n')}\n` : '# sanctum.yaml, written by the Sanctum installer. Every key has a default; see sanctum.example.yaml for the whole surface.\n';
  return head + yaml.dump(cfg, { lineWidth: -1, quotingType: '"', forceQuotes: true });
}

/** The command line: { root, origins, defaultCwd } or { error }. */
export function parseArgs(args, here) {
  const out = { root: here, origins: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root' && args[i + 1] !== undefined) out.root = resolve(args[++i]);
    else if (a === '--origin' && args[i + 1] !== undefined) out.origins.push(args[++i]);
    else if (a === '--default-cwd' && args[i + 1] !== undefined) out.defaultCwd = args[++i];
    else return { error: `Unknown option ${a}. Usage: node scripts/hosting/set-config.mjs [--root <folder>] [--origin <https://...>]... [--default-cwd <folder>]` };
  }
  return out;
}

/** Edit `<root>/sanctum.yaml` in place (a temp file, then a rename). Returns the path. */
export function applyToFile(root, opts) {
  const file = join(root, 'sanctum.yaml');
  const had = existsSync(file);
  const next = editConfig(had ? readFileSync(file, 'utf-8') : '', opts);
  const mode = had ? statSync(file).mode & 0o777 : 0o644;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  if (args.error) { console.error(args.error); process.exit(2); }
  try { console.log(`Updated ${applyToFile(args.root, { origins: args.origins, defaultCwd: args.defaultCwd })}`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
