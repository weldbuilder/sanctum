// The one precedence rule for a setting, and nothing else (no imports on purpose: config.ts uses it too, and it must stay a leaf).
//
//   default  <  sanctum.yaml  <  .env  <  SQLite
//
// "SQLite" is the `config` KV table plus the typed tables that act as overrides today (auth_preferences, the bot-token rows, google_auth).
// One source sits outside the four, for the Mind only: the companion's .mcp.json entry (`mcp_json`), kept at the place it has always had
// (below everything the person typed, above nothing). See registry.ts for which keys can have it.

export type SettingSource = 'default' | 'yaml' | 'env' | 'db' | 'mcp_json';

/** Lowest first. A later entry beats an earlier one. */
export const PRECEDENCE: readonly SettingSource[] = ['default', 'mcp_json', 'yaml', 'env', 'db'];

export interface Candidate<T = unknown> {
  source: SettingSource;
  value: T;
  /** Which store inside the source ('config:agent.model', 'auth_preferences.preferred_model', ...): for the person reading a GET. */
  via?: string;
}

/** The winner among candidates that exist: the one from the highest source (ties: the later one listed). Undefined when there are none. */
export function pickWinner<T>(candidates: readonly Candidate<T>[]): Candidate<T> | undefined {
  let best: Candidate<T> | undefined;
  let bestRank = -1;
  for (const c of candidates) {
    const rank = PRECEDENCE.indexOf(c.source);
    if (rank >= bestRank) { best = c; bestRank = rank; }
  }
  return best;
}
