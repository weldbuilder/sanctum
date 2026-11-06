import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('the daily handoff carry line', () => {
  const src = readFileSync(fileURLToPath(new URL('./hooks.ts', import.meta.url)), 'utf8');
  const handoff = readFileSync(fileURLToPath(new URL('./handoff.ts', import.meta.url)), 'utf8');

  it('reads "You carried from yesterday (DATE):" (first person, to the companion, dated)', () => {
    expect(src).toContain('parts.push(carryLine(carry))');
    expect(handoff).toContain('`**You carried from yesterday (${c.from}):** ${c.carry}`');
    expect(`${src}${handoff}`).not.toMatch(/\*\*(She|He|They) carried from yesterday/);
  });

  it('the house block in orientation says it is the companion\'s own outlook', () => {
    const outlook = readFileSync(fileURLToPath(new URL('./outlook.ts', import.meta.url)), 'utf8');
    expect(outlook).toContain("HOUSE_OUTLOOK_HEADER = '[House Outlook: your own outlook, as you wrote it");
    expect(src).toContain('HOUSE_OUTLOOK_HEADER.length');
    expect(src).not.toContain("'[House Outlook]'");
  });
});
