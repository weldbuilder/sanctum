// The harness prompts are built, not hand-edited: prompts/companion-base.md + prompts/tail-<mind>.md, concatenated
// (scripts/build-prompts.mjs, `npm run prompts:build`). This pins the built files to their parts, so an edit to a part
// without a rebuild (or a hand edit to a built file) fails here.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — a plain .mjs script, no types
import { buildPrompts } from '../../../scripts/build-prompts.mjs';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prompts');
const HOME_CONFIG = join(PROMPTS, '..', 'companion-home', 'config');
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

  // The starter home ships all three, so a new home (and a new tenant) gets the harness for whichever mind it runs.
  for (const built of Object.values(BUILT)) {
    it(`companion-home/config/${built} is the built prompts/${built}, byte for byte`, () => {
      expect(readFileSync(join(HOME_CONFIG, built), 'utf8')).toBe(read(built));
    });
  }

  it('companion-home/config/ holds exactly the three built prompts', () => {
    expect(readdirSync(HOME_CONFIG).sort()).toEqual(Object.values(BUILT).sort());
  });

  it('all seven files exist and are non-empty', () => {
    const files = ['companion-base.md', 'tail-claude.md', 'tail-codex.md', 'tail-dsh.md', ...Object.values(BUILT)];
    expect(files).toHaveLength(7);
    for (const f of files) expect(read(f).trim().length, f).toBeGreaterThan(0);
  });
});

describe('buildPrompts', () => {
  const fixture = () => {
    const top = mkdtempSync(join(tmpdir(), 'sanctum-build-prompts-'));
    const promptsDir = join(top, 'prompts');
    mkdirSync(promptsDir);
    writeFileSync(join(promptsDir, 'companion-base.md'), 'BASE one\nBASE two');
    writeFileSync(join(promptsDir, 'tail-claude.md'), '\n# claude tail\n');
    writeFileSync(join(promptsDir, 'tail-codex.md'), '\n\n# codex tail');
    writeFileSync(join(promptsDir, 'tail-dsh.md'), '# dsh tail with no leading blank line\n');
    return { top, promptsDir, homeConfigDir: join(top, 'home', 'config') };
  };
  const at = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');

  it('writes base + tail exactly (nothing added between them), to prompts/ and to the home config folder', () => {
    const f = fixture();
    buildPrompts({ promptsDir: f.promptsDir, homeConfigDir: f.homeConfigDir });
    const want = {
      'companion-claude.md': 'BASE one\nBASE two\n# claude tail\n',
      'codex-base-prompt.md': 'BASE one\nBASE two\n\n# codex tail',
      'dsh-base-prompt.md': 'BASE one\nBASE two# dsh tail with no leading blank line\n',
    };
    for (const [name, text] of Object.entries(want)) {
      expect(at(f.promptsDir, name), `prompts/${name}`).toBe(text);
      expect(at(f.homeConfigDir, name), `home/config/${name}`).toBe(text);
    }
    expect(readdirSync(f.homeConfigDir).sort()).toEqual(Object.keys(want).sort());
  });

  it('returns the paths it wrote, and creates the home config folder when it is missing', () => {
    const f = fixture();
    const written: string[] = buildPrompts({ promptsDir: f.promptsDir, homeConfigDir: f.homeConfigDir });
    expect(written).toHaveLength(6);
    expect(written).toContain(join(f.homeConfigDir, 'companion-claude.md'));
    expect(written).toContain(join(f.promptsDir, 'dsh-base-prompt.md'));
  });

  it('the log line names the folders it really wrote to, not a fixed path', () => {
    const f = fixture();
    const lines: string[] = [];
    buildPrompts({ promptsDir: f.promptsDir, homeConfigDir: f.homeConfigDir, log: (l: string) => lines.push(l) });
    expect(lines).toHaveLength(3);
    for (const l of lines) { expect(l).toMatch(/ to prompts\/ and home\/config\/$/); expect(l).not.toContain('companion-home'); }
    const only: string[] = [];
    buildPrompts({ promptsDir: f.promptsDir, log: (l: string) => only.push(l) });
    for (const l of only) expect(l).toMatch(/ to prompts\/$/);
  });

  it('replaces a stale built file, and without a home config folder writes only prompts/', () => {
    const f = fixture();
    writeFileSync(join(f.promptsDir, 'companion-claude.md'), 'STALE');
    buildPrompts({ promptsDir: f.promptsDir });
    expect(at(f.promptsDir, 'companion-claude.md')).toBe('BASE one\nBASE two\n# claude tail\n');
    expect(readdirSync(join(f.top))).toEqual(['prompts']);
  });
});
