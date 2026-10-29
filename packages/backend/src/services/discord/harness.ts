// Which harnesses can run the public lane. A public run must have NO tools (docs/DISCORD-PLAN.md: isolated, read-only,
// minimal context). Claude honours `tools: []`; dsh is sealed by its overlay (providers/dsh-exec.ts). `codex exec` cannot
// run without its shell tool, and its read-only mode still reads anything, so the public lane is refused there.

import { activeProvider } from '../providers/index.js';

export function publicHarnessSupported(): boolean {
  return activeProvider() !== 'codex';
}
