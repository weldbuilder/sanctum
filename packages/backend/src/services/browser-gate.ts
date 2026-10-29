import { existsSync } from 'node:fs';
import { readOwnText } from '../tenancy/own-files.js';
import type { SanctumConfig } from '../config.js';
// Shared with mcp-filter.mjs and scripts/setup-lib.mjs; same relative path from src/services and dist/services.
import { browserEntryProblem } from '../../../../examples/browser-seat-neko/entry-check.mjs';

type Cfg = Pick<SanctumConfig, 'integrations' | 'agent'>;

/** The `browser` server entry of the project's `.mcp.json` (the path agent.ts loads): `found` is false when the
 *  file is missing, unreadable or has no such server. Never throws. */
function readBrowserEntry(cfg: Cfg): { found: boolean; entry?: unknown; path?: string } {
  const p = cfg.agent?.mcp_json_path;
  if (!p || !existsSync(p)) return { found: false };
  try {
    const servers = JSON.parse(readOwnText(p))?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !Object.prototype.hasOwnProperty.call(servers, 'browser')) return { found: false };
    return { found: true, entry: servers.browser, path: p };
  } catch {
    return { found: false };
  }
}

/** Whether the companion has browser tools or a viewer: `integrations.browser_url` is set, or the
 *  project's `.mcp.json` (the path agent.ts loads) has a server named `browser`. The second case
 *  is a person who added the entry by hand. Never throws. */
export function browserToolsConfigured(cfg: Cfg): boolean {
  if (cfg.integrations?.browser_url) return true;
  return readBrowserEntry(cfg).found;
}

/** Call once at startup. An `outdated` entry (filter present, arguments the filter refuses) is warned about too. A `browser` entry in `.mcp.json` that does not run through mcp-filter.mjs hands the
 *  companion browser_run_code_unsafe (code in the Playwright server process, outside the sandbox) and
 *  browser_evaluate (page JS), so say so. Returns whether it warned. Never throws. */
export function warnIfBrowserUnfiltered(cfg: Cfg, warn: (msg: string) => void = (m) => console.warn(m)): boolean {
  const { found, entry, path } = readBrowserEntry(cfg);
  if (!found) return false;
  const problem = browserEntryProblem(entry);
  if (!problem) return false;
  if (problem === 'outdated') {
    warn(`[browser] ${path} has an outdated "browser" entry: it runs mcp-filter.mjs, but the filter's arguments are invalid (needs --block with browser_run_code_unsafe and browser_evaluate, and an absolute --workdir, both before "--"), so the filter exits 2 and the companion has no browser tools. Run \`npm run setup\` to replace it, or see examples/browser-seat-neko/README.md.`);
    return true;
  }
  warn(`[browser] ${path} has a "browser" entry with no filter (mcp-filter.mjs): the companion can run arbitrary code through browser_run_code_unsafe and browser_evaluate. Run \`npm run setup\` to replace it with the filtered entry, or see examples/browser-seat-neko/README.md.`);
  return true;
}
