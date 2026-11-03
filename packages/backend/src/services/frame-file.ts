// Which file carries the Claude frame (the lean operating prompt that replaces the claude_code preset). The same rule Codex and dsh use for
// their base prompts: the copy in the home wins, then the file named by agent.system_prompt_file, then nothing (the preset).
//
//   1. <agent.cwd>/config/companion-claude.md, if it exists
//   2. agent.system_prompt_file, if it is non-empty and exists
//   3. none: the claude_code preset
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const FRAME_FILE_NAME = 'companion-claude.md';

/** Where a home keeps its own copy of the frame. */
export const homeFramePath = (cwd: string): string => join(cwd, 'config', FRAME_FILE_NAME);

export type FrameSource = 'home' | 'configured' | 'none';

export function resolveFrameFile(cwd: string, configured: string): { path: string; source: FrameSource } {
  const home = homeFramePath(cwd);
  if (existsSync(home)) return { path: home, source: 'home' };
  if (configured && existsSync(configured)) return { path: configured, source: 'configured' };
  return { path: '', source: 'none' };
}
