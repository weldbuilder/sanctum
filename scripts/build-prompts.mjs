// build-prompts.mjs — assemble the per-mind harness prompts.
//
// One shared base (prompts/companion-base.md) plus one short tail per mind
// (prompts/tail-<mind>.md), concatenated with nothing in between (the tails
// begin with a blank line). The outputs are what each mind actually loads:
//
//   claude -> prompts/companion-claude.md   (agent.system_prompt_file)
//   codex  -> prompts/codex-base-prompt.md  (agent.codex.base_instructions_file)
//   dsh    -> prompts/dsh-base-prompt.md    (agent.dsh.base_instructions_file)
//
// Each output is also written, byte for byte, to companion-home/config/ under
// the name the home looks for (companion-claude.md, codex-base-prompt.md,
// dsh-base-prompt.md), so the starter home and prompts/ never drift apart.
//
// Edit the base or a tail, then run `npm run prompts:build` and commit all of it.
// A home that already exists keeps the copies it has: to change them, copy the
// outputs into <home>/config/ (or, for Claude, save the frame once in Settings).

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** mind -> the file name of its built prompt (in prompts/ and in <home>/config/). */
export const OUTPUTS = {
  claude: 'companion-claude.md',
  codex: 'codex-base-prompt.md',
  dsh: 'dsh-base-prompt.md',
};

/** Build every mind's prompt from `promptsDir` (companion-base.md + tail-<mind>.md) and write it to `promptsDir` and, when given, `homeConfigDir`.
 *  The tails carry their own leading blank line: nothing is added between base and tail. Returns the paths written. */
export function buildPrompts({ promptsDir, homeConfigDir, log = () => {} }) {
  const base = readFileSync(join(promptsDir, 'companion-base.md'), 'utf8');
  const written = [];
  if (homeConfigDir) mkdirSync(homeConfigDir, { recursive: true });
  // The folders as the log names them: relative to the folder that holds prompts/ (the app root), whichever place they really are.
  const shown = (dir) => (relative(dirname(promptsDir), dir) || '.').split('\\').join('/') + '/';
  for (const [mind, outName] of Object.entries(OUTPUTS)) {
    const tail = readFileSync(join(promptsDir, `tail-${mind}.md`), 'utf8');
    const text = base + tail;
    for (const dir of [promptsDir, homeConfigDir]) {
      if (!dir) continue;
      const out = join(dir, outName);
      writeFileSync(out, text);
      written.push(out);
    }
    log(`[prompts] wrote ${outName} (companion-base.md + tail-${mind}.md) to ${shown(promptsDir)}${homeConfigDir ? ` and ${shown(homeConfigDir)}` : ''}`);
  }
  return written;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  buildPrompts({ promptsDir: join(root, 'prompts'), homeConfigDir: join(root, 'companion-home', 'config'), log: (l) => console.log(l) });
}
