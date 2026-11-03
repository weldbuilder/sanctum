// The identity block Codex and dsh put in the system slot (after the harness base), read from the home's identity folder
// through the one reader (source.ts). The framing is what both harnesses always sent: "# Companion
// Identity" (profile.md), "## Companion Narrative" (companion.md), and now any other file in the folder.
import { getSanctumConfig } from '../../config.js';
import { fillIdentityNames } from '../../identity/render.js';
import { identityForRun } from './guard.js';
import { identityFolder } from './source.js';

const warnedNoIdentity = new Set<string>();

/** The identity text for a run on `harness` ('codex', 'dsh'), or '' (with one warning per harness) when the home has none.
 *  The ratified copy is what is served while a change waits (guard.ts). */
export function identityBlock(harness: string): string {
  const cfg = getSanctumConfig();
  const run = identityForRun(cfg, { harness });
  if (!run.text) {
    if (!warnedNoIdentity.has(harness)) {
      warnedNoIdentity.add(harness);
      console.warn(`[${harness}] no identity files in ${identityFolder(cfg.agent.cwd)} (profile.md / companion.md): running without an identity block`);
    }
    return '';
  }
  return cfg.identity ? fillIdentityNames(run.text, cfg.identity) : run.text;
}

export function resetIdentityBlockWarnings(): void { warnedNoIdentity.clear(); }
