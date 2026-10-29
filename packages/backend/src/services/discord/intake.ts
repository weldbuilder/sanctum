// The app's one exclusions source: intake reads it for every public message and the status route
// reports its state, so both see the same file.

import { ExclusionSource, type ExclusionsStatus } from './lanes.js';
import { getDiscordPaths } from './paths.js';

export const exclusionSource = new ExclusionSource({ path: () => getDiscordPaths().exclusionsFile });

/** loaded, or failed with a kind (missing / malformed / refused / unreadable). Never a path. */
export function exclusionsStatus(): ExclusionsStatus {
  return exclusionSource.status();
}
