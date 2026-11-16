// Raw tool → capability, for the Claude PreToolUse hook. null = not gated (nothing is written to receipts for it).
//
//   Bash                                                    shell, except `res ask ...` / `res help ...` (the ask channel, see askChannelCommand)
//   Write / Edit / MultiEdit / NotebookEdit
//     inside the Sanctum install, and not the companion home  self_code_edit
//     inside agent.cwd (the companion's home)                 ungated
//     anywhere else                                           files_outside_home
//   WebFetch, WebSearch, mcp__browser__*                    web
//   mcp__sanctum-workspace__google, write actions           google_write
//   mcp__*telegram*                                         outward_telegram
//
// When agent.cwd is a separate folder (the wizard's companion-home), everything inside it is the home and the install is self_code_edit.
// When agent.cwd is the install folder itself (the shipped `cwd: "."`) the two are the same folder, so the rule is inverted: HOME is an
// explicit allow-list (HOME_PATHS: the companion's own files) and everything else under the install (package.json, .mcp.json, sanctum.yaml,
// .env, data/, scripts/, docs/ ...) is Sanctum's own code or secrets and is self_code_edit.
// Paths are resolved with realpath (the nearest existing ancestor, so a file that does not exist yet still resolves) BEFORE they are classified:
// a symlink inside the home that points outside it is classified by where it points, not by where it sits.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Capability } from './gate.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const GOOGLE_WRITE_ACTIONS = new Set(['create', 'update', 'delete', 'cancel', 'trash', 'send', 'append', 'add_to_playlist']);
/** Under `cwd "."`: the companion's own files, relative to the install root. Everything else under the install is self_code_edit.
 *  (companion-home/ is the shipped companion-home folder: identity/, journal/, archive/, config/, HANDOFF.md, AGENTS.md, skills.) */
export const HOME_PATHS = ['identity', 'journal', 'archive', 'notes', 'config', 'HANDOFF.md', 'AGENTS.md', 'companion-home', '.claude/skills', '.agents/skills'];

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** realpath of the nearest existing ancestor, with the not-yet-existing tail put back. Falls back to the plain resolved path. */
function realish(p: string, depth = 0): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    try {
      lstatSync(cur);
      try { return norm(join(realpathSync(cur), ...tail.reverse())); }
      catch (e) {
        // A dangling symlink: a write through it creates its target, so classify by the target.
        if (depth < 8 && lstatSync(cur).isSymbolicLink()) return realish(join(resolve(dirname(cur), readlinkSync(cur)), ...tail.reverse()), depth + 1);
        throw e;
      }
    } catch { /* does not exist (or unreadable): fall through to the parent */ }
    const up = dirname(cur);
    if (up === cur) break;
    tail.push(cur.slice(up.length).replace(/^[\\/]+/, ''));
    cur = up;
  }
  return norm(abs);
}

/** `p` is `root` or under it. A leading `..` SEGMENT means outside; a folder that merely starts with two dots (`..foo`) is inside. */
function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
}

/** Is `rel` (a path under the install root) one of the companion's own files? */
function isHomePath(rel: string): boolean {
  const segs = rel.split(sep).map(norm); // targets are already norm()ed (lower-cased on Windows); the list is not
  return HOME_PATHS.some((h) => {
    const hs = h.split('/').map(norm);
    return hs.every((s, i) => segs[i] === s);
  });
}

export interface ToolMapOpts { agentCwd: string; installDir: string }

/** The capability a file write falls under. */
export function fileWriteCapability(filePath: string, o: ToolMapOpts): Capability | null {
  const cwd = realish(o.agentCwd);
  const install = realish(o.installDir);
  const target = realish(resolve(o.agentCwd, filePath));
  const inHome = inside(cwd, target);
  const inInstall = inside(install, target);
  if (inside(cwd, install)) {
    // The home holds the whole install (cwd "." or a parent): only the explicit home list under the install is the companion's.
    if (inInstall) return isHomePath(relative(install, target)) ? null : 'self_code_edit';
    return inHome ? null : 'files_outside_home';
  }
  if (inHome) return null; // the companion's own home: never gated
  return inInstall ? 'self_code_edit' : 'files_outside_home';
}

// ── the ask channel ─────────────────────────────────────────────────────────
// `res ask ...` is how the companion asks for a window, and on Claude it is a Bash call. If Bash (shell) is off, the way to ask for it would be off
// too, so a Bash command that is exactly the res tool with the ask or help verb is not the shell capability. Exactly: the program is `res`, or the
// path of tools/res.mjs, or `node <that path>`; the verb is ask or help; and nothing on the line can chain, substitute or redirect.
// (`res tg`, `res voice`, `res image` etc. are shell like any other command; their outward effect has its own gate at the server.)
const CHAIN = /[;&|`$()<>\n\r\\]/;
const unquote = (t: string) => t.replace(/^(["'])(.*)\1$/, '$2');

export function askChannelCommand(command: unknown, o: ToolMapOpts): boolean {
  if (typeof command !== 'string' || !command.trim() || CHAIN.test(command)) return false;
  const toks = command.trim().split(/\s+/).map(unquote);
  const resPath = realish(join(o.installDir, 'tools', 'res.mjs'));
  const isResFile = (t: string) => /res\.mjs$/.test(t) && realish(resolve(o.agentCwd, t)) === resPath;
  let i = 0;
  if (toks[0] === 'node') { if (!toks[1] || !isResFile(toks[1])) return false; i = 1; }
  else if (toks[0] !== 'res' && !isResFile(toks[0])) return false;
  const verb = toks[i + 1];
  return verb === 'ask' || verb === 'help';
}

export function toolCapability(tool: string, input: Record<string, unknown> | undefined, o: ToolMapOpts): Capability | null {
  if (tool === 'Bash') return askChannelCommand(input?.command, o) ? null : 'shell';
  if (WRITE_TOOLS.has(tool)) {
    const p = input?.file_path ?? input?.notebook_path;
    return typeof p === 'string' && p ? fileWriteCapability(p, o) : null;
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web';
  if (tool.startsWith('mcp__browser__')) return 'web';
  if (tool === 'mcp__sanctum-workspace__google') {
    const action = typeof input?.action === 'string' ? input.action.toLowerCase() : '';
    return GOOGLE_WRITE_ACTIONS.has(action) ? 'google_write' : null;
  }
  if (tool.startsWith('mcp__') && /telegram/i.test(tool)) return 'outward_telegram';
  return null;
}
