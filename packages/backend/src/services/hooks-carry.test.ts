import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('the daily handoff carry line', () => {
  it('reads "You carried from yesterday:" (first person, to the companion)', () => {
    const src = readFileSync(fileURLToPath(new URL('./hooks.ts', import.meta.url)), 'utf8');
    expect(src).toContain('parts.push(`**You carried from yesterday:** ${carry}`)');
    expect(src).not.toMatch(/\*\*(She|He|They) carried from yesterday/);
  });
});
