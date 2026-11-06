// Raw tool → capability, for the Claude PreToolUse hook. null = not gated (nothing is written to receipts for it).
//
//   Bash                                                    shell
//   Write / Edit / MultiEdit / NotebookEdit
//     inside the Sanctum install, and not the companion home  self_code_edit
//     inside agent.cwd (the companion's home)                 ungated
//     anywhere else                                           files_outside_home
//   WebFetch, WebSearch, mcp__browser__*                    web
//   mcp__sanctum-workspace__google, write actions           google_write
//   mcp__*telegram*                                         outward_telegram
//
// When agent.cwd is the install folder itself (the shipped `cwd: "."`), the home and the install are the same folder, so the install's
// code folders stand for "Sanctum's own code" and the rest of the folder is the home.
import { relative, resolve, isAbsolute, sep } from 'node:path';
import type { Capability } from './gate.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const GOOGLE_WRITE_ACTIONS = new Set(['create', 'update', 'delete', 'cancel', 'trash', 'send', 'append', 'add_to_playlist']);
/** Folders of the install that are code, used when the home is the install folder itself. */
export const INSTALL_CODE_DIRS = ['packages', 'tools', 'scripts', 'prompts', 'plugins', 'examples', 'node_modules', '.git', '.claude'];

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

function inside(root: string, p: string): boolean {
  const rel = relative(norm(resolve(root)), norm(resolve(p)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface ToolMapOpts { agentCwd: string; installDir: string }

/** The capability a file write falls under. */
export function fileWriteCapability(filePath: string, o: ToolMapOpts): Capability | null {
  const target = resolve(o.agentCwd, filePath);
  const inHome = inside(o.agentCwd, target);
  const inInstall = inside(o.installDir, target);
  if (inside(o.agentCwd, o.installDir)) {
    // The home holds the whole install (cwd "." or a parent): only the install's code folders are Sanctum's own code.
    if (inInstall) return INSTALL_CODE_DIRS.includes(relative(resolve(o.installDir), target).split(sep)[0]) ? 'self_code_edit' : null;
    return inHome ? null : 'files_outside_home';
  }
  if (inHome) return null; // the companion's own home: never gated
  return inInstall ? 'self_code_edit' : 'files_outside_home';
}

export function toolCapability(tool: string, input: Record<string, unknown> | undefined, o: ToolMapOpts): Capability | null {
  if (tool === 'Bash') return 'shell';
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
