// D13: fence-aware chunking. A reply over 2000 characters is split so an open ``` fence is closed at the end of a
// chunk and reopened (with its language tag) at the start of the next, and no word is cut where it can be avoided.
import { describe, it, expect } from 'vitest';
import { splitResponse } from './utils.js';

const HARD = 2000;
const SOFT = 1900;

/** Fence lines (``` with an optional tag) removed, whitespace collapsed: what the reader sees as content. */
const content = (s: string) => s.split('\n').filter((l) => !/^ {0,3}`{3,}[\w-]*\s*$/.test(l)).join(' ').split(/\s+/).filter(Boolean);
const fenceLines = (s: string) => s.split('\n').filter((l) => /^ {0,3}`{3,}/.test(l)).length;

const codeLines = (n: number) => Array.from({ length: n }, (_, i) => `  const value${i} = compute(${i}, 'argument-${i}'); // line ${i}`).join('\n');

describe('splitResponse: plain text', () => {
  it('leaves a short reply alone', () => {
    expect(splitResponse('hello there')).toEqual(['hello there']);
  });

  it('never cuts a word and keeps every chunk under the soft limit', () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = splitResponse(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SOFT);
    expect(chunks.join(' ').split(/\s+/)).toEqual(words);
  });
});

describe('splitResponse: fences', () => {
  it('closes an open fence at the chunk end and reopens it, with its tag, in the next (5000-character block)', () => {
    const body = codeLines(100).slice(0, 5000);
    const text = `Here is the code:\n\`\`\`ts\n${body}\n\`\`\`\nHope that helps.`;
    expect(text.length).toBeGreaterThan(5000);
    const chunks = splitResponse(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SOFT);
      expect(fenceLines(c) % 2).toBe(0); // every chunk's fences are balanced
    }
    for (const c of chunks.slice(1, -1)) {
      expect(c.startsWith('```ts\n')).toBe(true);
      expect(c.endsWith('\n```')).toBe(true);
    }
    expect(chunks[0].endsWith('\n```')).toBe(true);
    expect(chunks[chunks.length - 1].startsWith('```ts\n')).toBe(true);
    expect(chunks[chunks.length - 1].endsWith('Hope that helps.')).toBe(true);
    // Nothing lost, nothing cut mid-token.
    expect(content(chunks.join('\n'))).toEqual(content(text));
  });

  it('keeps the indentation of code that continues in the next chunk', () => {
    const text = `\`\`\`py\n${Array.from({ length: 120 }, (_, i) => `    indented_${i} = ${i}`).join('\n')}\n\`\`\``;
    const chunks = splitResponse(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(1)) {
      const [first, second] = c.split('\n');
      expect(first).toBe('```py');
      expect(second.startsWith('    indented_')).toBe(true);
    }
  });

  it('handles mixed prose and several blocks, tagging each block as its own', () => {
    const prose = (n: number) => Array.from({ length: n }, (_, i) => `sentence${i} goes on and on`).join('. ');
    const text = [prose(60), '```js\n' + codeLines(40) + '\n```', prose(80), '```\n' + codeLines(45) + '\n```', prose(20)].join('\n\n');
    const chunks = splitResponse(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SOFT);
      expect(fenceLines(c) % 2).toBe(0);
    }
    expect(content(chunks.join('\n'))).toEqual(content(text));
    // A chunk that continues the untagged block reopens it untagged, never with the earlier block's tag.
    const second = chunks.filter((c) => /^```\n/.test(c));
    expect(second.length).toBeGreaterThan(0);
    for (const c of chunks.filter((c) => c.includes('line 4') && !c.includes('```js'))) expect(c).not.toMatch(/^```js/);
  });

  it('does not treat inline backticks or a closed fence as open', () => {
    const text = 'use `code` here. ' + 'filler '.repeat(400) + '\n```\nshort\n```\n' + 'tail '.repeat(100);
    const chunks = splitResponse(text);
    for (const c of chunks) expect(fenceLines(c) % 2).toBe(0);
    expect(chunks.every((c) => !c.endsWith('```') || c.includes('short'))).toBe(true);
  });

  it('never exceeds Discord\'s 2000 even when a line has no break at all', () => {
    const text = '```txt\n' + 'x'.repeat(5000) + '\n```';
    const chunks = splitResponse(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(HARD);
      expect(fenceLines(c) % 2).toBe(0);
    }
    expect(chunks.join('').replace(/`{3}(txt)?\n?/g, '').replace(/\n/g, '')).toBe('x'.repeat(5000));
  });

  it('leaves a fence the model never closed open at the very end only', () => {
    const text = '```sh\n' + codeLines(60);
    const chunks = splitResponse(text);
    for (const c of chunks.slice(0, -1)) expect(c.endsWith('\n```')).toBe(true);
    expect(fenceLines(chunks[chunks.length - 1]) % 2).toBe(1);
  });

  it('does not leave an empty fenced block when the cut falls right before the closing fence', () => {
    for (let pad = 0; pad < 200; pad++) {
      const text = '```ts\n' + 'a'.repeat(pad) + '\n' + codeLines(32) + '\n```\ntail words here that follow';
      for (const c of splitResponse(text)) expect(c).not.toMatch(/```[\w-]*\n```/);
    }
  });
});
