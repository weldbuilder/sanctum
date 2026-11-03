import { describe, it, expect } from 'vitest';
import { buildSegments } from './agent.js';

const tool = (id: string, textOffset: number) => ({ textOffset, toolId: id, toolName: 'Read' });

describe('buildSegments narration', () => {
  it('moves text that precedes a tool call into a narration block and keeps only the final text', () => {
    const a = 'Let me check the files.';
    const b = '\n\nLet me also check the tools.';
    const reply = '\n\nI found one thing: a notes folder.';
    const full = a + b + reply;
    const t1 = a.length;
    const t2 = a.length + b.length;
    const segs = buildSegments(full, [tool('1', t1), tool('2', t2)], [
      { textOffset: 0, endOffset: t1, content: a, summary: a, narration: true },
      { textOffset: t1 + 2, endOffset: t2, content: b.trim(), summary: b.trim(), narration: true },
    ]);
    expect(segs.map(s => s.type)).toEqual(['thinking', 'tool', 'thinking', 'tool', 'text']);
    expect(segs.filter(s => s.type === 'thinking').every(s => (s as any).narration)).toBe(true);
    const texts = segs.filter(s => s.type === 'text').map(s => (s as any).content.trim());
    expect(texts).toEqual(['I found one thing: a notes folder.']);
  });

  it('leaves a turn with no tools untouched', () => {
    expect(buildSegments('just a reply', [], [])).toEqual([]);
  });
});
