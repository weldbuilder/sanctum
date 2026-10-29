// Small facts the docs and a script comment must state correctly (verifier lows).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf-8');

describe('docs and comments', () => {
  it('scripts/setup-discord.mjs names plugin-paths.ts as the home of realOrResolved', () => {
    const src = read('scripts', 'setup-discord.mjs');
    expect(src).toMatch(/realOrResolved in packages\/backend\/src\/services\/plugin-paths\.ts/);
    expect(src).not.toMatch(/realOrResolved in packages\/backend\/src\/services\/plugins\.ts/);
  });

  it('DISCORD-PLAN D8 row names the owner block === IN REPLY TO === and the public block [In reply to ...]', () => {
    const row = read('docs', 'DISCORD-PLAN.md').split('\n').find((l) => l.startsWith('| D8 |')) ?? '';
    expect(row).toContain('=== IN REPLY TO ===');
    expect(row).toContain('[In reply to');
  });

  it('the docs say discord.deferMaxAgeMs is no longer a Settings value', () => {
    expect(read('UPGRADE.md')).toMatch(/deferMaxAgeMs[^\n]*(no longer|removed)/);
    expect(read('docs', 'DISCORD-PLAN.md')).toMatch(/deferMaxAgeMs[^\n]*(no longer|removed|Settings)/);
  });

  it('the docs list the accepted attachment kinds and say HTML is not one of them (B3c)', () => {
    const row = read('docs', 'DISCORD-PLAN.md').split('\n').find((l) => l.startsWith('| D4 |')) ?? '';
    expect(row).toMatch(/never HTML/i);
    expect(row).toMatch(/jpeg, png, gif, webp/);
    expect(read('sanctum.example.yaml')).toMatch(/max_mb:[^\n]*never HTML/);
  });
});
