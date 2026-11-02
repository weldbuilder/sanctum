// The harness prompts are built, not hand-edited: prompts/companion-base.md + prompts/tail-<mind>.md, concatenated
// (scripts/build-prompts.mjs, `npm run prompts:build`). This pins the built files to their parts, so an edit to a part
// without a rebuild (or a hand edit to a built file) fails here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prompts');
const read = (name: string): string => readFileSync(join(PROMPTS, name), 'utf8');

const BUILT = {
  claude: 'companion-claude.md',
  codex: 'codex-base-prompt.md',
  dsh: 'dsh-base-prompt.md',
} as const;

describe('the built harness prompts', () => {
  for (const [mind, built] of Object.entries(BUILT)) {
    it(`prompts/${built} is companion-base.md + tail-${mind}.md, byte for byte`, () => {
      expect(read(built)).toBe(read('companion-base.md') + read(`tail-${mind}.md`));
    });
  }

  it('all seven files exist and are non-empty', () => {
    const files = ['companion-base.md', 'tail-claude.md', 'tail-codex.md', 'tail-dsh.md', ...Object.values(BUILT)];
    expect(files).toHaveLength(7);
    for (const f of files) expect(read(f).trim().length, f).toBeGreaterThan(0);
  });
});
