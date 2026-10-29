import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_CACHE_KEY, attributesFor, baseTokenValue, defaultDoc, docsEqual, effectiveOverrides, isExtraReadable, isSafeTokenValue,
  coerceMaterial, materialAllowedWithRoom, panelPalette, panelScopeVars, parseDoc, readabilityIssues, RESTORE_BUTTON, sanitizeOverrides, serializeDoc, showsDecorations, withMaterial, withReadability, withRoom, withRoomPreset,
} from './appearance';
import { ROOMS } from './rooms';
import { materialVars, MATERIALS } from './materials';
import { contrastRatio } from './contrast';
import { MATERIAL_IDS, ROOM_IDS } from './types';
import { FONT_CHOICES } from './tokens';

describe('defaults and legacy mapping', () => {
  it('an install with nothing stored is the legacy Hedgewitch room and palette, standard readability', () => {
    const d = parseDoc(null);
    expect(d).toEqual(defaultDoc());
    expect(d.roomId).toBe('hedgewitch');
    expect(d.materialId).toBe('hedgewitch');
    expect(d.readability).toBe('standard');
    expect(APPEARANCE_CACHE_KEY).toBe('sanctum.appearance.v2');
  });

  it('legacy server overrides apply under the Hedgewitch material and are left out under a skin', () => {
    const legacy = { '--text-primary': '#112233', '--bg-primary': '#ffeedd' };
    expect(effectiveOverrides(defaultDoc(), legacy)).toEqual(legacy);
    const skin = withMaterial(defaultDoc(), 'midnight-ink');
    expect(effectiveOverrides(skin, legacy)).toEqual({}); // old light-paper colours never land on a dark skin
    // and they come back untouched when the person returns to Hedgewitch
    expect(effectiveOverrides(withMaterial(skin, 'hedgewitch'), legacy)).toEqual(legacy);
  });

  it('keeps customisations per material', () => {
    const doc = parseDoc({ version: 2, roomId: 'library', materialId: 'mounted-paper', customByMaterial: { 'mounted-paper': { '--text-primary': '#202020' }, 'indigo-silk': { '--text-primary': '#eeeeee' } } });
    expect(effectiveOverrides(doc, {})).toEqual({ '--text-primary': '#202020' });
    expect(effectiveOverrides(withMaterial(doc, 'indigo-silk'), {})).toEqual({ '--text-primary': '#eeeeee' });
  });
});

describe('legacy overrides are read as they always were', () => {
  it('keeps any non-empty value for a known token (not only hex), and drops unknown keys', () => {
    const d = defaultDoc();
    expect(effectiveOverrides(d, { '--bg-primary': 'hsl(30 40% 90%)', '--nope': '#fff', '--amber': '' })).toEqual({ '--bg-primary': 'hsl(30 40% 90%)' });
  });
});

describe('room and material are independent', () => {
  const start = parseDoc({ version: 2, roomId: 'salon', materialId: 'black-damask' });

  it('changing the room alone never changes the material, so text colours stay', () => {
    for (const room of ['library', 'cloister', 'conservatory', 'night', 'hedgewitch'] as const) {
      const next = withRoom(start, room);
      expect(next.roomId).toBe(room);
      expect(next.materialId).toBe(start.materialId);
      expect(materialVars(MATERIALS[next.materialId].roles!)['--text-primary']).toBe(materialVars(MATERIALS[start.materialId].roles!)['--text-primary']);
    }
  });

  it('changing the material alone keeps the room and selects the full palette', () => {
    const next = withMaterial(start, 'mounted-paper');
    expect(next.roomId).toBe('salon');
    expect(next.materialId).toBe('mounted-paper');
  });

  it('switches away from and back to Ember without leaking paper into its input/editor pair', () => {
    const ember = parseDoc({ version: 2, roomId: 'ember', materialId: 'smoked-copper' });
    let current = ember;
    for (const material of ['mounted-paper', 'midnight-ink', 'black-damask'] as const) {
      current = withMaterial(current, material);
      expect(current.roomId).toBe('ember');
      expect(materialVars(MATERIALS[current.materialId].roles!)['--bg-input']).toBe(MATERIALS[material].roles!.input);
      current = parseDoc(serializeDoc(withMaterial(current, 'smoked-copper')));
      const roles = MATERIALS[current.materialId].roles!;
      expect(current.roomId).toBe('ember');
      expect(roles.editor!.bg).toBe(roles.input);
      expect(roles.editor!.text).toBe(roles.inputText);
      expect(readabilityIssues(current.materialId, {})).toEqual([]);
    }
    for (const roomId of ROOM_IDS) {
      current = withRoom(current, roomId);
      expect(current.materialId).toBe('smoked-copper');
      expect(materialVars(MATERIALS[current.materialId].roles!)['--bg-input']).toBe(MATERIALS['smoked-copper'].roles!.input);
    }
  });

  it("choosing a room's preset sets its matched material too", () => {
    expect(withRoomPreset(start, 'library').materialId).toBe('mounted-paper');
    expect(withRoomPreset(start, 'night')).toMatchObject({ roomId: 'night', materialId: 'indigo-silk' });
  });

  it('all 25 room and material pairings are accepted as documents', () => {
    const rooms = ['salon', 'library', 'cloister', 'conservatory', 'night'] as const;
    const mats = ['black-damask', 'mounted-paper', 'midnight-ink', 'botanical-linen', 'indigo-silk'] as const;
    let n = 0;
    for (const r of rooms) for (const m of mats) {
      const d = parseDoc(serializeDoc(withMaterial(withRoom(defaultDoc(), r), m)));
      expect(d.roomId).toBe(r); expect(d.materialId).toBe(m); n++;
    }
    expect(n).toBe(25);
  });

  it('ignores unknown ids instead of applying them', () => {
    expect(withRoom(start, 'nope' as never)).toBe(start);
    expect(withMaterial(start, 'nope' as never)).toBe(start);
  });
});

describe('Extra readable', () => {
  const doc = parseDoc({ version: 2, roomId: 'library', materialId: 'mounted-paper', decorations: true });

  it('is a flag on the document and turns every decoration off', () => {
    expect(isExtraReadable(doc)).toBe(false);
    expect(showsDecorations(doc)).toBe(true);
    expect(attributesFor(doc)['data-decor']).toBe('on');
    const extra = withReadability(doc, 'extra');
    expect(isExtraReadable(extra)).toBe(true);
    expect(showsDecorations(extra)).toBe(false);
    expect(attributesFor(extra)).toEqual({ 'data-room': 'library', 'data-material': 'mounted-paper', 'data-readability': 'extra', 'data-decor': 'off', 'data-surface-decor': 'off' });
  });

  it('persists: it survives a serialise and parse round trip', () => {
    expect(parseDoc(serializeDoc(withReadability(doc, 'extra'))).readability).toBe('extra');
  });

  it('drops colour overrides (the safe palette stands) but keeps font choices', () => {
    const font = FONT_CHOICES['--font-serif'][1].value;
    const d = withReadability(parseDoc({ version: 2, roomId: 'salon', materialId: 'black-damask', customByMaterial: { 'black-damask': { '--text-primary': '#010101', '--font-serif': font } } }), 'extra');
    expect(effectiveOverrides(d, {})).toEqual({ '--font-serif': font });
  });

  it('the legacy kitchen has no corner art, so decorations are off there regardless', () => {
    expect(ROOMS.hedgewitch.corners).toBeNull();
    expect(showsDecorations(defaultDoc())).toBe(false);
    expect(showsDecorations({ ...doc, decorations: false })).toBe(false);
  });
});

describe('stored data is untrusted', () => {
  it('survives corrupt JSON, wrong types, a future version and oversized blobs', () => {
    expect(parseDoc('{not json')).toEqual(defaultDoc());
    expect(parseDoc('[]')).toEqual(defaultDoc());
    expect(parseDoc(42)).toEqual(defaultDoc());
    expect(parseDoc({ version: 3, roomId: 'salon', materialId: 'black-damask' })).toEqual(defaultDoc());
    expect(parseDoc('x'.repeat(20_000))).toEqual(defaultDoc());
  });

  it('falls back field by field: an unknown room becomes the kitchen, an unknown material the room default', () => {
    expect(parseDoc({ version: 2, roomId: 'ballroom', materialId: 'black-damask' }).roomId).toBe('hedgewitch');
    expect(parseDoc({ version: 2, roomId: 'night', materialId: 'velvet' }).materialId).toBe('indigo-silk');
    expect(parseDoc({ version: 2, roomId: 'night', materialId: 'indigo-silk', readability: 'loud' }).readability).toBe('standard');
  });

  it('accepts only plain colours and listed fonts as overrides; no urls, no css', () => {
    expect(isSafeTokenValue('--amber', '#abcdef')).toBe(true);
    expect(isSafeTokenValue('--amber', 'rgba(1, 2, 3, 0.5)')).toBe(true);
    expect(isSafeTokenValue('--amber', 'url(https://evil.example/x)')).toBe(false);
    expect(isSafeTokenValue('--amber', 'red; background: url(x)')).toBe(false);
    expect(isSafeTokenValue('--font-body', 'Comic Sans')).toBe(false);
    expect(isSafeTokenValue('--font-body', FONT_CHOICES['--font-body'][0].value)).toBe(true);
    expect(sanitizeOverrides({ '--amber': '#fff', '--not-a-token': '#000', '--text-primary': 'url(x)' })).toEqual({ '--amber': '#fff' });
  });

  it('never stores customisations for the legacy material in the document', () => {
    const d = parseDoc({ version: 2, roomId: 'hedgewitch', materialId: 'hedgewitch', customByMaterial: { hedgewitch: { '--amber': '#fff' } } });
    expect(d.customByMaterial).toEqual({});
  });

  it('compares documents ignoring the revision counter', () => {
    const a = defaultDoc();
    expect(docsEqual(a, { ...a, revision: 7 })).toBe(true);
    expect(docsEqual(a, withRoom(a, 'salon'))).toBe(false);
  });
});

describe('editor readability', () => {
  it('shows the value the material really has, not the old dark default', () => {
    expect(baseTokenValue('hedgewitch', '--bg-primary')).toBe('#f3ead7');
    expect(baseTokenValue('midnight-ink', '--bg-primary')).toBe('#0A162C');
    expect(baseTokenValue('midnight-ink', '--font-serif')).toContain('Lora');
  });

  it('flags a pair the person made unreadable, and stays quiet about untouched palettes', () => {
    expect(readabilityIssues('midnight-ink', {})).toEqual([]);
    const bad = readabilityIssues('midnight-ink', { '--text-primary': '#101E37' });
    expect(bad.map(i => i.id)).toContain('primary text on background');
    expect(bad[0].ratio).toBeLessThan(4.5);
  });

  it('judges every editable foreground against the card it lands on, not only the page background', () => {
    const userCard = baseTokenValue('midnight-ink', '--surface-user');
    expect(userCard).toMatch(/^#/);
    // "Your accent, bright" is the text of your own messages: set to the card colour, it must be flagged.
    const yours = readabilityIssues('midnight-ink', { '--lavender-bright': userCard });
    expect(yours.map(i => i.id)).toContain('your text on your messages');
    const companionCard = baseTokenValue('midnight-ink', '--surface-companion');
    const links = readabilityIssues('midnight-ink', { '--amber': companionCard });
    expect(links.map(i => i.id)).toContain('links on companion messages');
    const secondary = readabilityIssues('midnight-ink', { '--text-secondary': companionCard });
    expect(secondary.map(i => i.id)).toContain('secondary text on companion messages');
  });
});

describe('the Appearance panel stays readable whatever is customised', () => {
  it('declares an opaque, passing palette for every material, independent of anything on <html>', () => {
    for (const id of MATERIAL_IDS) {
      const p = panelPalette(id);
      const pairs: Array<[string, string, string, number]> = [
        ['text', p.text, p.bg, 4.5], ['text2', p.text2, p.bg, 4.5], ['muted', p.muted, p.bg, 4.5],
        ['field text', p.fieldText, p.field, 4.5], ['accent', p.accent, p.bg, 4.5], ['button text', p.buttonText, p.button, 4.5],
        ['error', p.error, p.bg, 4.5], ['success', p.success, p.bg, 4.5], ['warning', p.warning, p.bg, 4.5],
        ['field border', p.border, p.bg, 3], ['focus ring', p.focus, p.bg, 3], ['focus on field', p.focus, p.field, 3],
      ];
      for (const [name, fg, bg, min] of pairs) expect(contrastRatio(fg, bg), `${id} ${name}`).toBeGreaterThanOrEqual(min);
      const vars = panelScopeVars(id);
      for (const k of ['--text-primary', '--text-secondary', '--text-muted', '--bg-input', '--amber', '--focus-ring']) expect(vars[k], `${id} ${k}`).toBeTruthy();
    }
  });

  it('the restore button is a fixed black-on-cream pair, far above 4.5:1', () => {
    expect(contrastRatio(RESTORE_BUTTON.text, RESTORE_BUTTON.bg)).toBeGreaterThan(12);
    expect(contrastRatio(RESTORE_BUTTON.border, RESTORE_BUTTON.bg)).toBeGreaterThan(12);
  });
});

describe('the Hedgewitch parchment belongs to the Hedgewitch room', () => {
  it('parseDoc swaps it for the room\'s own material in every other room, and keeps it in the Hedgewitch room', () => {
    for (const roomId of ROOM_IDS) {
      const d = parseDoc({ version: 2, roomId, materialId: 'hedgewitch' });
      expect(d.materialId, roomId).toBe(roomId === 'hedgewitch' ? 'hedgewitch' : ROOMS[roomId].defaultMaterial);
    }
  });

  it('withRoom leaves the parchment behind when the room changes, and withMaterial refuses it outside its room', () => {
    expect(withRoom(defaultDoc(), 'night').materialId).toBe('indigo-silk');
    expect(withRoom(withMaterial(defaultDoc(), 'midnight-ink'), 'salon').materialId).toBe('midnight-ink');
    const night = withRoomPreset(defaultDoc(), 'night');
    expect(withMaterial(night, 'hedgewitch')).toBe(night);
    expect(withMaterial(defaultDoc(), 'black-damask').materialId).toBe('black-damask');
  });

  it('only the Hedgewitch room is offered the parchment', () => {
    for (const roomId of ROOM_IDS) expect(materialAllowedWithRoom(roomId, 'hedgewitch')).toBe(roomId === 'hedgewitch');
    expect(coerceMaterial('library', 'hedgewitch')).toBe('mounted-paper');
    expect(coerceMaterial('library', 'midnight-ink')).toBe('midnight-ink');
  });
});
