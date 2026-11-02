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
// Edit the base or a tail, then run `npm run prompts:build` and commit all of it.
// To change the copies a home already carries, copy the outputs into
// <home>/config/ (companion-home/config/ ships the codex and dsh ones).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const prompts = join(root, 'prompts');

const OUTPUTS = {
  claude: 'companion-claude.md',
  codex: 'codex-base-prompt.md',
  dsh: 'dsh-base-prompt.md',
};

const base = readFileSync(join(prompts, 'companion-base.md'), 'utf8');

for (const [mind, outName] of Object.entries(OUTPUTS)) {
  const tail = readFileSync(join(prompts, `tail-${mind}.md`), 'utf8');
  writeFileSync(join(prompts, outName), base + tail);
  console.log(`[prompts] wrote prompts/${outName} (companion-base.md + tail-${mind}.md)`);
}
