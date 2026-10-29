import { existsSync } from 'fs';
import { readOwnOrApp } from '../tenancy/own-files.js';
import { join } from 'path';
import type { SanctumConfig } from '../config.js';
import { identityForRun } from '../services/identity/guard.js';
import type { LoadedCompanionIdentity } from './types.js';

export function findLegacyClaudePath(config: SanctumConfig): string | null {
  const candidates = [
    config.agent.claude_md_path,
    join(config.agent.cwd, '.claude/CLAUDE.md'),
    join(config.agent.cwd, 'CLAUDE.md'),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** The companion's identity for the Claude harness and the public Discord lane: the home's identity folder, through the one
 *  reader every harness uses (services/identity/source.ts) and the ratification check (guard.ts: the ratified copy is served while a
 *  change waits). The legacy CLAUDE.md lookup runs only when the home has no identity folder at all.
 *  `harness` names who is asking (recorded when the check notices a change on disk); `pendingLine: false` leaves the "a change is waiting" line out. */
export function loadCompanionIdentity(config: SanctumConfig, opts: { harness?: string; pendingLine?: boolean } = {}): LoadedCompanionIdentity {
  const run = identityForRun(config, { harness: opts.harness ?? 'claude', pendingLine: opts.pendingLine });
  if (run.present) {
    return {
      mode: 'profile',
      text: run.text,
      legacyPrompt: '',
      sourcePaths: { folder: join(config.agent.cwd, 'identity'), files: run.files },
      ...(run.check && { state: run.check.state }),
      ...(run.ratifiedServed && { ratifiedServed: true }),
    };
  }

  const legacyClaudePath = findLegacyClaudePath(config);
  const legacyPrompt = legacyClaudePath ? readOwnOrApp(legacyClaudePath) : '';

  return {
    mode: 'legacy-claude',
    text: '',
    legacyPrompt,
    sourcePaths: {
      ...(legacyClaudePath && { legacyClaude: legacyClaudePath }),
    },
  };
}
