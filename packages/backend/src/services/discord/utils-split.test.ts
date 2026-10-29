// B3c item 1: the fence chunker cannot be made to amplify. A fence marker is a run of 3 to 16 backticks at the start of a
// line; a longer run is text; the reopen prefix is the marker and a capped language tag; a 4+ fence closes with a closer
// of its own length; and for ANY input the chunk count is at most ceil(len / 900) + 1.
import { describe, it, expect } from 'vitest';
import { splitResponse } from './utils.js';

const CHUNK_BOUND = (len: number) => Math.ceil(len / 900) + 1; // B3d: the break window is the last 900 characters of the budget
const FENCE_LINE = /^ {0,3}(`{3,16})([^`]*)$/;

/** The fence open after `text` by the module's rule (3..16 backticks at line start; a bare line of at least as many closes). */
function openAfter(text: string): string | null {
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    const m = FENCE_LINE.exec(line);
    if (!m) continue;
    if (!cur) cur = m[1];
    else if (!m[2].trim() && m[1].length >= cur.length) cur = null;
  }
  return cur;
}

describe('splitResponse: runs of backticks do not amplify', () => {
  it.each([3, 4, 5, 16, 17, 100, 2500, 7001])('a run of %i backticks is a handful of chunks at most', (n) => {
    const text = '`'.repeat(n);
    const chunks = splitResponse(text);
    expect(chunks.length).toBeLessThanOrEqual(CHUNK_BOUND(n));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join('')).toBe(text);
  });

  it('2,500 backticks (was 603 chunks) and 7,001 (was 5,104)', () => {
    expect(splitResponse('`'.repeat(2500)).length).toBeLessThanOrEqual(3);
    expect(splitResponse('`'.repeat(7001)).length).toBeLessThanOrEqual(5);
  });

  it('a long fence opener line (a 2,000-backtick "fence") is text, and the body after it is not reopened with it', () => {
    const text = '`'.repeat(2000) + '\n' + 'y\n'.repeat(1500) + '`'.repeat(2000);
    const chunks = splitResponse(text);
    expect(chunks.length).toBeLessThanOrEqual(CHUNK_BOUND(text.length));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  });

  it('a reopen prefix is the marker and a capped tag, never a run of the text', () => {
    const tag = 'language'.repeat(10);
    const text = '```' + tag + '\n' + 'code line\n'.repeat(600) + '```';
    const chunks = splitResponse(text);
    expect(chunks.length).toBeLessThanOrEqual(CHUNK_BOUND(text.length));
    for (const c of chunks.slice(1)) expect(c.split('\n')[0].length).toBeLessThanOrEqual(3 + 20);
  });
});

describe('splitResponse: fence markers', () => {
  it('a 4-backtick fence closes with four backticks and reopens with four', () => {
    const text = '````\n' + 'line\n'.repeat(600) + '````\n';
    const chunks = splitResponse(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) expect(c.endsWith('\n````')).toBe(true);
    for (const c of chunks.slice(1)) expect(c.startsWith('````\n')).toBe(true);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
  });

  it('a 4-backtick outer fence holding ``` lines stays open across the cuts', () => {
    const text = '````md\n' + '```js\ninner\n```\n'.repeat(200) + '````\n';
    const chunks = splitResponse(text);
    for (const c of chunks.slice(0, -1)) expect(c.endsWith('\n````')).toBe(true);
    for (const c of chunks.slice(1)) expect(c.startsWith('````md\n')).toBe(true);
  });

  it('three-backtick fences are balanced in every chunk', () => {
    const text = '```js\n' + 'const x = 1;\n'.repeat(300) + '```\nafter';
    const chunks = splitResponse(text);
    for (const c of chunks) expect(openAfter(c)).toBeNull();
    expect(chunks[chunks.length - 1].endsWith('after')).toBe(true);
  });

  it('an inline ``` in the middle of a line is not a fence: nothing is closed or reopened', () => {
    const text = 'see ```' + ' code'.repeat(800) + '``` end';
    const chunks = splitResponse(text);
    expect(chunks.length).toBeLessThanOrEqual(CHUNK_BOUND(text.length));
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
    for (const c of chunks.slice(1)) expect(c).not.toMatch(/^```\n/);
    for (const c of chunks.slice(0, -1)) expect(c.endsWith('\n```')).toBe(false);
  });

  it('CRLF fences split the same way', () => {
    const text = '```js\r\n' + 'let a = 1;\r\n'.repeat(400) + '```\r\n';
    const chunks = splitResponse(text);
    expect(chunks.length).toBeLessThanOrEqual(CHUNK_BOUND(text.length));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
  });
});

// ── the seeded fuzz ───────────────────────────────────────────────────────────
const FUZZ_SEED = 20261019;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

function gen(rnd: () => number): string {
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const word = () => 'abcdefghij'.slice(0, 1 + Math.floor(rnd() * 9));
  const parts: string[] = [];
  const n = 5 + Math.floor(rnd() * 120);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.10) parts.push('\n```' + pick(['', 'js', 'python', 'ts extra', ' spaced']) + '\n');
    else if (r < 0.15) parts.push('\n```\n');
    else if (r < 0.18) parts.push('\n````' + pick(['', 'md']) + '\n');
    else if (r < 0.20) parts.push('\n````\n');
    else if (r < 0.23) parts.push('x ```inline``` y ');
    else if (r < 0.25) parts.push('\r\n```\r\n');
    else if (r < 0.27) parts.push('\r\n');
    else if (r < 0.29) parts.push('q'.repeat(2100 + Math.floor(rnd() * 500)));
    else if (r < 0.32) parts.push('\n' + '`'.repeat(1 + Math.floor(rnd() * 40)) + pick(['', '\n', 'x\n']));
    else if (r < 0.34) parts.push(pick(['\n' + 'w'.repeat(900 + Math.floor(rnd() * 400)) + '\n', 'z'.repeat(1000) + ' ' + 'y'.repeat(900) + ' ']));
    else if (r < 0.45) parts.push('\n');
    else if (r < 0.50) parts.push('\n\n');
    else if (r < 0.55) parts.push('    indented ```\n');
    else { const k = 1 + Math.floor(rnd() * 40); for (let j = 0; j < k; j++) parts.push(word() + ' '); }
  }
  return parts.join('');
}

/** Does the chunk sequence reproduce the text, modulo whitespace at the cuts and the reopen / closer lines the splitter adds? */
function reproduces(text: string, chunks: string[]): boolean {
  const seen = new Set<string>();
  const go = (i: number, cursor: number): boolean => {
    if (i === chunks.length) return text.slice(cursor).trim() === '';
    const key = `${i}:${cursor}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const c = chunks[i];
    const cands = new Set<string>([c]);
    const pre = /^ {0,3}`{3,16}[^\n`]*\n/.exec(c);
    if (pre && i > 0) cands.add(c.slice(pre[0].length));
    for (const x of [...cands]) { const m = /\n`{3,16}$/.exec(x); if (m) cands.add(x.slice(0, m.index)); }
    let j = cursor;
    while (j < text.length && /\s/.test(text[j])) j++;
    for (const body of cands) for (let k = cursor; k <= j; k++) if (text.startsWith(body, k) && go(i + 1, k + body.length)) return true;
    return false;
  };
  return go(0, 0);
}

describe('splitResponse: seeded fuzz', () => {
  it(`1,000 random inputs (seed ${FUZZ_SEED}): no chunk over 2000, at most ceil(len/900)+1 chunks, text reproduced, fences balanced`, () => {
    const rnd = rng(FUZZ_SEED);
    const fails: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const text = gen(rnd);
      const chunks = splitResponse(text);
      const tag = `#${i} len=${text.length} chunks=${chunks.length}`;
      if (chunks.some((c) => c.length > 2000)) fails.push(`${tag}: a chunk over 2000`);
      if (chunks.length > CHUNK_BOUND(text.length)) fails.push(`${tag}: over the bound ${CHUNK_BOUND(text.length)}`);
      if (!reproduces(text, chunks)) fails.push(`${tag}: does not reproduce the text`);
      const inputOpen = openAfter(text) !== null;
      chunks.forEach((c, k) => { if (openAfter(c) !== null && !(inputOpen && k === chunks.length - 1)) fails.push(`${tag}: chunk ${k} ends inside a fence`); });
    }
    expect(fails.slice(0, 5)).toEqual([]);
  });
});
