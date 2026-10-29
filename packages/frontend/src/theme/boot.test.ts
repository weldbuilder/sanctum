import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attributesFor, defaultDoc, MAX_DOC_BYTES, parseDoc } from './appearance';
import { MATERIAL_IDS, ROOM_IDS } from './types';
import { guardedOverrides } from './apply';
import { ROOMS } from './rooms';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const script = html.match(/<script>\s*\(function \(\) \{\s*try \{\s*var raw = localStorage\.getItem\('sanctum\.appearance\.v2'\)[\s\S]*?<\/script>/)![0].replace(/^<script>/, '').replace(/<\/script>$/, '');

/** Run the inline pre-paint script against a stand-in page and return the attributes it set. */
function runBoot(stored: string | null, throws = false): Record<string, string> {
  const attrs: Record<string, string> = {};
  const localStorage = { getItem: () => { if (throws) throw new Error('blocked'); return stored; } };
  const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } };
  new Function('localStorage', 'document', script)(localStorage, document);
  return attrs;
}

describe('pre-paint boot script in index.html', () => {
  it('sets exactly the attributes the document resolves to, for every room, material and mode', () => {
    for (const roomId of ROOM_IDS) for (const materialId of MATERIAL_IDS) for (const readability of ['standard', 'extra']) for (const decorations of [true, false]) {
      const doc = parseDoc({ version: 2, roomId, materialId, readability, decorations });
      expect(runBoot(JSON.stringify(doc)), `${roomId}/${materialId}/${readability}/${decorations}`).toEqual(attributesFor(doc));
    }
  });

  it('uses the matched default material when the stored one is unknown, like parseDoc', () => {
    const got = runBoot(JSON.stringify({ version: 2, roomId: 'night', materialId: 'velvet' }));
    expect(got['data-material']).toBe(ROOMS.night.defaultMaterial);
  });

  it('coerces the Hedgewitch parchment outside the Hedgewitch room, exactly like parseDoc', () => {
    for (const roomId of ROOM_IDS) {
      const stored = JSON.stringify({ version: 2, roomId, materialId: 'hedgewitch' });
      expect(runBoot(stored)['data-material'], roomId).toBe(parseDoc(stored).materialId);
    }
    expect(runBoot(JSON.stringify({ version: 2, roomId: 'night', materialId: 'hedgewitch' }))['data-material']).toBe('indigo-silk');
  });

  it('ignores a stored document longer than the store\'s limit, so nothing paints that the store would then discard', () => {
    const big = JSON.stringify({ version: 2, roomId: 'library', materialId: 'mounted-paper', pad: 'x'.repeat(MAX_DOC_BYTES) });
    expect(big.length).toBeGreaterThan(MAX_DOC_BYTES);
    expect(runBoot(big)).toEqual({});
    expect(parseDoc(big)).toEqual(defaultDoc());
    const ok = JSON.stringify({ version: 2, roomId: 'library', materialId: 'mounted-paper' });
    expect(runBoot(ok)['data-room']).toBe('library');
  });

  it('leaves the default alone for nothing stored, corrupt JSON, a future version or blocked storage', () => {
    expect(runBoot(null)).toEqual({});
    expect(runBoot('{oops')).toEqual({});
    expect(runBoot(JSON.stringify({ version: 3, roomId: 'salon' }))).toEqual({});
    expect(runBoot(null, true)).toEqual({});
    expect(attributesFor(defaultDoc())['data-room']).toBe('hedgewitch');
  });
});

describe('held-back customisations', () => {
  const bad = { '--text-primary': '#101E37', '--font-serif': "'Lora', Georgia, 'Times New Roman', serif" };

  it('a skin never applies colours that would make its text unreadable, but keeps font choices', () => {
    const doc = parseDoc({ version: 2, roomId: 'cloister', materialId: 'midnight-ink', customByMaterial: { 'midnight-ink': bad } });
    const r = guardedOverrides(doc, {});
    expect(r.held).toBe(true);
    expect(r.applied).toEqual({ '--font-serif': bad['--font-serif'] });
  });

  it('readable customisations apply', () => {
    const doc = parseDoc({ version: 2, roomId: 'cloister', materialId: 'midnight-ink', customByMaterial: { 'midnight-ink': { '--text-primary': '#ffffff' } } });
    expect(guardedOverrides(doc, {})).toEqual({ applied: { '--text-primary': '#ffffff' }, held: false });
  });

  it('the classic palette applies its stored overrides as they always were, even unreadable ones', () => {
    const r = guardedOverrides(defaultDoc(), { '--text-primary': '#f3ead7' });
    expect(r).toEqual({ applied: { '--text-primary': '#f3ead7' }, held: false });
  });
});
