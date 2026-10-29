// The one place that decides whether a `browser` .mcp.json entry (or the argv of mcp-filter.mjs itself) is valid.
// mcp-filter.mjs validates its argv with parseFilterArgs at startup; setup-lib (mergeBrowserMcp) and the
// backend (warnIfBrowserUnfiltered) run the same function over an entry's args, so "the filter would refuse to
// start" and "the wizard/app calls the entry outdated" can never disagree. No dependencies.
import { isAbsolute, posix, win32 } from 'node:path';

export const REQUIRED_BLOCKS = Object.freeze(['browser_run_code_unsafe', 'browser_evaluate']);

/** Parse `--block a,b --workdir <dir> -- <command> [args...]`. Flags count only before `--`. Returns
 *  { ok, blocked: Set, workdir, cmd, problem }; `problem` says what is wrong when ok is false. */
export function parseFilterArgs(argv) {
  const all = Array.isArray(argv) ? argv : [];
  const dd = all.indexOf('--');
  const head = dd < 0 ? all : all.slice(0, dd);
  const cmd = dd < 0 ? [] : all.slice(dd + 1);
  const flag = (name) => { const i = head.indexOf(name); return i >= 0 ? String(head[i + 1] ?? '') : ''; };
  const blocked = new Set(flag('--block').split(',').map((s) => s.trim()).filter(Boolean));
  const workdir = flag('--workdir').trim();
  let problem = '';
  if (!REQUIRED_BLOCKS.every((n) => blocked.has(n))) problem = `--block (before --) must include every one of: ${REQUIRED_BLOCKS.join(', ')}`;
  else if (!workdir) problem = '--workdir <dir> (before --) is required';
  else if (!isAbsolute(workdir)) problem = `--workdir must be an absolute path (got "${workdir}")`;
  else if (!cmd.length) problem = 'a command is required after --';
  return { ok: !problem, blocked, workdir, cmd, problem };
}

const FILTER_NAME = 'mcp-filter.mjs';
/** The last path segment under either separator style, whatever the platform: an entry written on
 *  Windows (C:\\x\\mcp-filter.mjs) is read the same way on Linux, and the other way round. */
const lastSegment = (p) => String(p).split(/[\\/]/).pop();
const isAnyAbsolute = (p) => posix.isAbsolute(p) || win32.isAbsolute(p);
/** `node`, `node.exe`, or an absolute path ending in either. A relative path (`bin/node`) is not trusted. */
function isNodeCommand(c) {
  if (typeof c !== 'string' || !c) return false;
  const base = lastSegment(c).toLowerCase();
  if (base !== 'node' && base !== 'node.exe') return false;
  return !/[\\/]/.test(c) || isAnyAbsolute(c);
}

/** The arguments the filter itself receives, when the entry RUNS mcp-filter.mjs, else null. That is the case
 *  only when the command is node (bare, or an absolute path to node / node.exe) and args[0] is a path whose last
 *  segment is exactly `mcp-filter.mjs`, or when the command itself is such a script. The name appearing anywhere
 *  else (another argument, a flag value, a longer file name, a folder called mcp-filter.mjs, a command that is not
 *  node) does not count: `npx @playwright/mcp --note mcp-filter.mjs` runs Playwright MCP with no filter at all. */
export function filterArgs(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const str = (a) => (typeof a === 'string' ? a : String(a));
  if (typeof entry.command === 'string' && lastSegment(entry.command) === FILTER_NAME) return args.map(str);
  if (isNodeCommand(entry.command) && typeof args[0] === 'string' && lastSegment(args[0]) === FILTER_NAME) return args.slice(1).map(str);
  return null;
}

/** True when a server entry runs through mcp-filter.mjs (see filterArgs). */
export function entryHasFilter(entry) {
  return filterArgs(entry) !== null;
}

/** null when the entry is a valid filtered entry; 'unfiltered' when it does not run through the filter;
 *  'outdated' when it does but its filter arguments fail parseFilterArgs (the filter would exit 2 and the
 *  companion would have no browser tools). */
export function browserEntryProblem(entry) {
  const args = filterArgs(entry);
  if (!args) return 'unfiltered';
  return parseFilterArgs(args).ok ? null : 'outdated';
}
