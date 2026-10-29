// B3d item 5: the chunker never splits a surrogate pair, prefers a paragraph break anywhere in the last 900 characters of
// its budget, does not cut through a long URL when it can cut before it, and gives no chunks for blank text.
//
// The chunk bound asserted here is ceil(len / 900) + 1 (it was ceil(len / 1800) + 1 with the narrow window): a chunk but the
// last now takes in at least budget - 900 characters, which is at least 946 for the default limit.
import { describe, it, expect, vi } from 'vitest';
import { splitResponse } from './utils.js';
import { createSender, type SendRuntime } from './send.js';
import { rulesFromText } from './gate.js';

const CHUNK_BOUND = (len: number) => Math.ceil(len / 900) + 1;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('splitResponse: surrogate pairs', () => {
  it.each([
    ['1,000 emoji, no break at all', '😀'.repeat(1000)],
    ['an odd unit then 3,000 emoji', 'a' + '😀'.repeat(3000)],
    ['emoji inside a fence', '```\n' + '😀'.repeat(3000) + '\n```'],
    ['supplementary-plane letters', '𝔸'.repeat(2500)],
    ['a 120-emoji line across the cut', 'word '.repeat(366) + '🎉'.repeat(120) + ' tail'.repeat(300)],
  ])('%s: no chunk starts or ends with a lone surrogate, and the pieces are the text', (_n, text) => {
    const chunks = splitResponse(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(LONE.test(c)).toBe(false);
      expect([...c].length).toBeLessThanOrEqual(2000);
      expect(c.length).toBeLessThanOrEqual(2000);
    }
    if (!text.includes('```')) expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('an input that already holds a lone surrogate is not made worse or looped on', () => {
    const text = '\uD800' + 'x'.repeat(5000) + '\uDC00';
    const chunks = splitResponse(text);
    expect(chunks.join('')).toBe(text);
  });
});

describe('splitResponse: where it cuts', () => {
  it('a paragraph break anywhere in the last 900 characters of the budget is preferred over a later space', () => {
    // The paragraph break is at 1,100: inside the window (about 983 to 1,883), well before the budget's end.
    const text = 'a '.repeat(550) + '\n\n' + 'b '.repeat(1500);
    const chunks = splitResponse(text);
    expect(chunks[0]).toBe('a '.repeat(550));
    expect(chunks[1].startsWith('b b')).toBe(true);
  });

  it('a line break is preferred over a space, and a space over a hard cut', () => {
    const lines = 'c '.repeat(500) + '\n' + 'd '.repeat(1500);
    expect(splitResponse(lines)[0]).toBe('c '.repeat(500));
    const spaced = 'e'.repeat(1000) + ' ' + 'f'.repeat(3000);
    expect(splitResponse(spaced)[0]).toBe('e'.repeat(1000));
  });

  it('a long URL is cut before, not through, when there is something before it', () => {
    const url = 'https://example.com/' + 'a'.repeat(3000);
    const text = 'see the intro text ' + url + ' and after';
    const chunks = splitResponse(text);
    expect(chunks[0]).toBe('see the intro text');
    expect(chunks[1].startsWith('https://example.com/')).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('a long run with no :// is still cut hard, as before', () => {
    const text = 'see the intro text ' + 'a'.repeat(3000);
    const chunks = splitResponse(text);
    expect(chunks[0].startsWith('see the intro text aaa')).toBe(true);
    expect(chunks[0].length).toBeGreaterThan(1800);
  });

  it('a URL that begins the text cannot be cut before: it is cut hard', () => {
    const chunks = splitResponse('https://example.com/' + 'a'.repeat(4000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
  });

  it('blank text gives no chunks', () => {
    expect(splitResponse('')).toEqual([]);
    expect(splitResponse('   \n\t ')).toEqual([]);
    expect(splitResponse(' '.repeat(5000))).toEqual([]);
    expect(splitResponse(' 　')).toEqual([]);
  });
});

// The three prose samples of the verifier's c1-prose probe (same generator, same seed): 4,000 characters, paragraphs of
// 250-450, 500-900 and 120-300 characters. Cut at a space before; at a paragraph break now.
let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const WORDS = 'the quiet morning light settled over the harbour while gulls argued about nothing in particular and I kept thinking about what you said yesterday'.split(' ');
function sentence() { const n = 8 + Math.floor(rnd() * 14); const w = []; for (let i = 0; i < n; i++) w.push(WORDS[Math.floor(rnd() * WORDS.length)]); const s = w.join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; }
function para(target: number) { let p = ''; while (p.length < target) p += (p ? ' ' : '') + sentence(); return p; }
function prose(len: number, paraLen: [number, number]) { const ps: string[] = []; let t = ''; while (t.length < len) { ps.push(para(paraLen[0] + Math.floor(rnd() * (paraLen[1] - paraLen[0])))); t = ps.join('\n\n'); } return t.slice(0, len); }
const samples = [prose(4000, [250, 450]), prose(4000, [500, 900]), prose(4000, [120, 300])];

/** Where each cut falls and what kind of break it is: the text between the end of a chunk and the start of the next. */
function cuts(text: string, chunks: string[]): Array<{ at: number; kind: 'paragraph' | 'line' | 'space' | 'hard' }> {
  const out: Array<{ at: number; kind: 'paragraph' | 'line' | 'space' | 'hard' }> = [];
  let pos = 0;
  for (let i = 0; i < chunks.length - 1; i++) {
    const at = text.indexOf(chunks[i], pos) + chunks[i].length;
    out.push({ at, kind: text.slice(at, at + 2) === '\n\n' ? 'paragraph' : text[at] === '\n' ? 'line' : text[at] === ' ' ? 'space' : 'hard' });
    pos = at;
  }
  return out;
}

describe('splitResponse: realistic prose now cuts at a paragraph break', () => {
  it.each(samples.map((t, i) => [i + 1, t] as const))('prose sample %i', (_i, text) => {
    const chunks = splitResponse(text);
    const found = cuts(text, chunks);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((c) => c.kind)).toEqual(found.map(() => 'paragraph'));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
    expect(chunks.length).toBeLessThanOrEqual(CHUNK_BOUND(text.length));
  });

  it('the cut positions are recorded for the report', () => {
    const where = samples.map((t) => cuts(t, splitResponse(t)).map((c) => `${c.at} ${c.kind}`));
    console.log('B3d prose cuts: ' + JSON.stringify(where));
    expect(where).toHaveLength(3);
  });
});

// ── the seeded fuzz, now with astral text, long URLs and wide whitespace ──────
const FUZZ_SEED = 20261020;
function rng(s0: number) {
  let s = s0 >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}
function gen(r: () => number): string {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const ASTRAL = ['😀', '𝔸', '👍🏽', '🏳️‍🌈', '𠜎', '👨‍👩‍👧'];
  const word = () => (r() < 0.2 ? pick(ASTRAL).repeat(1 + Math.floor(r() * 5)) : 'abcdefghij'.slice(0, 1 + Math.floor(r() * 9)));
  const parts: string[] = [];
  const n = 5 + Math.floor(r() * 120);
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < 0.06) parts.push('\n```' + pick(['', 'js', 'ts extra']) + '\n');
    else if (x < 0.10) parts.push('\n```\n');
    else if (x < 0.13) parts.push(pick(ASTRAL).repeat(300 + Math.floor(r() * 1500)));
    else if (x < 0.16) parts.push(' https://example.com/' + 'u'.repeat(150 + Math.floor(r() * 2500)) + ' ');
    else if (x < 0.18) parts.push('q'.repeat(1900 + Math.floor(r() * 400)));
    else if (x < 0.22) parts.push(' '.repeat(100 + Math.floor(r() * 400)));
    else if (x < 0.34) parts.push('\n');
    else if (x < 0.40) parts.push('\n\n');
    else { const k = 1 + Math.floor(r() * 40); for (let j = 0; j < k; j++) parts.push(word() + ' '); }
  }
  return parts.join('');
}

describe('splitResponse: seeded fuzz (astral, URLs, wide whitespace)', () => {
  it(`1,500 inputs (seed ${FUZZ_SEED}): no lone surrogate, at most 2000 code points, at most ceil(len/900)+1 chunks`, () => {
    const r = rng(FUZZ_SEED);
    const fails: string[] = [];
    let worst = 0;
    for (let i = 0; i < 1500; i++) {
      const text = gen(r);
      const chunks = splitResponse(text);
      const tag = `#${i} len=${text.length} chunks=${chunks.length}`;
      if (chunks.some((c) => c.length > 2000)) fails.push(`${tag}: a chunk over 2000 units`);
      if (chunks.some((c) => [...c].length > 2000)) fails.push(`${tag}: a chunk over 2000 code points`);
      if (!LONE.test(text) && chunks.some((c) => LONE.test(c))) fails.push(`${tag}: a lone surrogate`);
      if (text.length > 1900) {
        worst = Math.max(worst, chunks.length / CHUNK_BOUND(text.length));
        if (chunks.length > CHUNK_BOUND(text.length)) fails.push(`${tag}: over the bound ${CHUNK_BOUND(text.length)}`);
      }
      if (text.trim() !== '' && chunks.some((c) => c.trim() === '')) fails.push(`${tag}: a blank chunk`);
    }
    expect(fails.slice(0, 5)).toEqual([]);
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe('sendGated: blank text', () => {
  it('sends nothing and logs once', async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const rt: SendRuntime = {
      isPaused: () => false, isPublicEnabled: () => true, words: () => rulesFromText('Maple Street\n'), names: () => null,
      log: (event, fields) => { logs.push({ event, fields }); }, chunkDelayMs: 0,
    };
    const channel = { send: vi.fn(async () => ({ id: 'x' })) };
    const r = await createSender(rt)({ kind: 'channel', channel }, '  \n\t ', 'owner');
    expect(r.sent).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.event === 'empty')).toHaveLength(1);
  });
});
