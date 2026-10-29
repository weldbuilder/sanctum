import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEXTURES, buildAllTextures } from './textures';
import { MATERIALS, MATERIAL_LIST, PLATES, MATERIAL_TEXTURE_ALPHA_CEILINGS, TEXTURE_ALPHA_CEILING, TEXTURE_ALPHA_MIN, TEXTURE_CONTRAST_MARGIN, materialAssetPaths, plateColor, skinVars, textureWorst, texturedPairs } from './materials';
import { buildSkinsCss } from './skins-css';
import { contrastRatio, parseColor, relativeLuminance, round2, TEXT_MIN } from './contrast';
import * as registry from './materials';
import { ROOMS } from './rooms';
import { MATERIAL_IDS } from './types';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const SKIN_MATERIALS = MATERIAL_LIST.filter(m => m.roles);

describe('generated textures', () => {
  const made = buildAllTextures(room => readFileSync(join(PUBLIC, `skins/${room}/material-tile-v1.svg`), 'utf8'), room => readFileSync(join(PUBLIC, `skins/${room}/edge-ornament-v1.svg`), 'utf8'));

  it('the committed files are exactly what the generator produces (npm run gen:textures -w @sanctum/frontend)', () => {
    // every skin's art is raster, cut from its painting (scripts/skin-art); no material lays a drawn pattern today
    expect(Object.keys(made)).toEqual([]);
    for (const [p, text] of Object.entries(made)) expect(readFileSync(join(PUBLIC, p), 'utf8'), p).toBe(text);
  });

  it('each is a transparent pattern (no base colour), self-contained, with no script or external reference', () => {
    for (const [p, text] of Object.entries(made)) {
      expect(text, p).not.toMatch(/<rect width="256" height="256" fill="#/);
      expect(text, p).not.toMatch(/<script|href=|url\(http|@import|javascript:/i);
      expect(text.length, p).toBeLessThan(20_000);
    }
  });

  it("every mark of a derived texture is drawn in the one ink the material model reasons about", () => {
    for (const m of SKIN_MATERIALS.filter(m => m.texture!.pattern)) {
      const room = m.defaultRoom as keyof typeof TEXTURES;
      expect(m.texture!.pattern!.ink.toUpperCase(), m.id).toBe(TEXTURES[room].ink.toUpperCase());
      const text = made[`skins/${room}/texture-v1.svg`];
      const colours = new Set([...text.matchAll(/#[0-9A-Fa-f]{6}/g)].map(c => c[0].toUpperCase()));
      expect([...colours], m.id).toEqual([TEXTURES[room].ink.toUpperCase()]);
      expect(text).toContain(`<g opacity="${m.texture!.pattern!.alpha}">`);
    }
    for (const m of SKIN_MATERIALS) for (const l of [m.texture!.card, m.texture!.chrome, m.texture!.user].filter(Boolean)) {
      if (l!.url.endsWith('.webp')) expect(l!.extremes, l!.url).toHaveLength(2);
    }
    // the Library's chrome is the oxblood wood of its demo's rail, its ink its lightest grain
    expect(MATERIALS['mounted-paper'].texture!.chrome).toMatchObject({ url: '/skins/library/library-wood.webp', ink: '#3C1C12', extremes: ['#240C00', '#3C1C12'] });
  });
});

describe('texture amplitude (the alpha ceiling)', () => {
  it('no material lays a texture stronger than the ceiling, and none is too faint to see', () => {
    expect(TEXTURE_ALPHA_CEILING).toBe(0.16);
    for (const m of SKIN_MATERIALS) {
      for (const layer of [m.texture!.card, m.texture!.chrome]) {
        expect(layer.alpha, `${m.id} ${layer.url}`).toBeLessThanOrEqual(MATERIAL_TEXTURE_ALPHA_CEILINGS[m.id] ?? TEXTURE_ALPHA_CEILING);
        expect(layer.alpha, `${m.id} ${layer.url}`).toBeGreaterThanOrEqual(TEXTURE_ALPHA_MIN);
      }
      // A drawn (SVG) ornament is laid faint; a painted one carries its strength in its own pixels. Either keeps clear of text.
      if (m.texture!.ornament) { if (m.texture!.ornament.url.endsWith('.svg')) expect(m.texture!.ornament.alpha, m.id).toBeLessThanOrEqual(0.55); expect(m.texture!.ornament.clearance, m.id).toBe(true); }
    }
  });

  it('pins fixed UI-scale substrate repeats separately from local decorative patterns', () => {
    const scales = { 'black-damask': [576, 576], 'mounted-paper': [512, 512], 'midnight-ink': [576, 576], 'botanical-linen': [512, 512], 'indigo-silk': [512, 512], 'smoked-copper': [576, 576] };
    for (const m of SKIN_MATERIALS) {
      expect([m.texture!.card.tilePx, m.texture!.chrome.tilePx], m.id).toEqual(scales[m.id as keyof typeof scales]);
      for (const l of [m.texture!.card, m.texture!.chrome, m.texture!.user].filter(Boolean)) expect(1 - l!.alpha, m.id).toBeGreaterThanOrEqual(1 - (MATERIAL_TEXTURE_ALPHA_CEILINGS[m.id] ?? TEXTURE_ALPHA_CEILING));
    }
    expect(MATERIALS['smoked-copper'].flat!.woodgrain).toBeNull();
    expect(MATERIALS['black-damask'].texture!.pattern).toBeUndefined(); // the damask is in the cloth itself, never a drawn overlay
  });

  it('pins each material to the alpha it was tuned and measured at', () => {
    const a = Object.fromEntries(SKIN_MATERIALS.map(m => [m.id, [m.texture!.card.alpha, m.texture!.chrome.alpha, m.texture!.ornament?.alpha ?? null]]));
    expect(a).toEqual({
      'black-damask': [0.92, 0.92, null], // its damask is the plate, grown from the Vampire mock-up
      'mounted-paper': [0.9, 0.92, null], // its parchment and wood are the plates, grown from the Library mock-up and its demo
      'midnight-ink': [0.92, 0.92, 1], // the cloth is the plate, grown from the Moonlit Cloister painting; its sprig is painted, at full strength
      'botanical-linen': [0.92, 0.92, 1], // its linens are the plates, grown from the Conservatory mock-up; its sprigs are painted
      'indigo-silk': [0.92, 0.92, 1], // its linens are the plates, grown from the Celestial mock-up; its moons are painted
      'smoked-copper': [0.92, 0.92, null], // the leather is the plate: cut from the Ember plate art, bounded by its measured extremes
    });
  });

  it('the stylesheet lays exactly that alpha: the veil over each texture is the plate colour at 1 - alpha', () => {
    const css = buildSkinsCss();
    for (const m of SKIN_MATERIALS) {
      const block = css.split(`:root[data-material="${m.id}"] {`)[1].split('}')[0];
      const v = skinVars(m);
      expect(block).toContain(`--skin-veil-card: ${Math.round((1 - m.texture!.card.alpha) * 1000) / 10}%;`);
      expect(block).toContain(`--skin-veil-chrome: ${Math.round((1 - m.texture!.chrome.alpha) * 1000) / 10}%;`);
      expect(v['--skin-tex-card']).toBe(`url("${m.texture!.card.url}")`);
    }
    // the plate rule composes: solid colour, tile, then the veil, all opaque; never an opacity on the plate
    expect(css).toContain('linear-gradient(color-mix(in srgb, var(--plate-bg) var(--plate-veil), transparent)');
    expect(css).toContain('background-color: var(--plate-bg);');
  });

  it('text on every textured plate reads 4.5:1 (plus a 0.1 margin for antialiasing) on the worst composite (the strongest texture mark), for all six materials', () => {
    const fails: string[] = [];
    for (const m of SKIN_MATERIALS) {
      const pairs = texturedPairs(m);
      expect(pairs.length).toBeGreaterThan(20);
      for (const p of pairs) {
        const c = contrastRatio(p.fg, p.bg);
        if (!(c >= p.min + TEXTURE_CONTRAST_MARGIN)) fails.push(`${m.id}: ${p.id} ${p.fg} on ${p.bg} = ${round2(c)}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it('Ember restores actual leather while keeping its dark typing fields free from ivory parchment', () => {
    const m = MATERIALS['smoked-copper'];
    expect(m.texture!.card.alpha).toBe(0.92);
    expect(m.texture!.chrome.alpha).toBe(0.92);
    expect(m.texture!.user!.alpha).toBe(0.92);
    expect(m.texture!.editor).toBeNull();
    expect(skinVars(m)['--skin-editor-bg']).toBe(m.roles!.input);
    expect(skinVars(m)['--skin-editor-tex']).toBe('none');
    for (const p of texturedPairs(m)) expect(contrastRatio(p.fg, p.bg), p.id).toBeGreaterThanOrEqual(p.min + TEXTURE_CONTRAST_MARGIN);
    expect(texturedPairs(m).map(p => p.id)).not.toContain('editor text on the editor (worst parchment tile pixel)');
  });

  it('the worst composite is a plausible bound: the plate colour moved toward the ink by exactly alpha', () => {
    const m = MATERIALS['black-damask'];
    const worst = textureWorst(plateColor(m.roles!, '--surface-companion'), m.texture!.card);
    expect(worst).not.toBe(m.roles!.companion);
    expect(contrastRatio(m.roles!.companion, worst)).toBeLessThan(1.5);
  });
});

describe('plates', () => {
  const css = buildSkinsCss();

  it('the list covers every primary plate the brief names', () => {
    const sels = PLATES.map(p => p.selector);
    for (const s of ['.message.companion', '.message.user', '.chat-header', '.composer-inner', '.thread-sidebar', '.settings-content-inner', '.settings-subnav',
      '.cdlg-panel', '.home-card', '.login-card', '.search-panel', '.cp-modal', '.nav-rail']) expect(sels, s).toContain(s);
  });

  it('corners are small and never stretched: 22px at most on a plate, smaller on a phone, drawn at a fixed size', () => {
    for (const p of PLATES) {
      expect(p.corner, p.selector).toBeLessThanOrEqual(22);
      expect(p.cornerMobile, p.selector).toBeLessThanOrEqual(p.corner);
      if (p.corner) expect(p.corner, p.selector).toBeGreaterThanOrEqual(18);
      if (p.corner) expect(p.cornerMobile, p.selector).toBeGreaterThanOrEqual(14);
    }
    expect(css).toContain('background-size: var(--plate-corner) var(--plate-corner), var(--plate-corner) var(--plate-corner), var(--plate-corner) var(--plate-corner), var(--plate-corner) var(--plate-corner),');
    expect(css).toContain('--plate-corner: 22px;');
    expect(css).toMatch(/@media \(max-width: 768px\) \{\n  :root\[data-decor="on"\][^\n]*--plate-corner: 18px;/);
  });

  it('every plate rule is gated on decorations being on, so Extra readable and "decorations off" get the plain plates', () => {
    for (const line of css.split('\n').filter(l => /--plate-bg|--plate-corner|--plate-radius/.test(l) && l.includes('{'))) {
      expect(line, line).toMatch(/\[data-(?:surface-)?decor="on"\]/);
    }
    const skinsCss = readFileSync(fileURLToPath(new URL('./skins.css', import.meta.url)), 'utf8');
    expect(skinsCss).toContain(':root[data-decor="on"] .skin-frame { display: block; }');
  });

  it("a plate's frame is its own border or a 1px inset outline in the trim metal, with pointer events untouched", () => {
    expect(css).toContain('border-color: var(--skin-trim)');
    expect(css).toContain('outline: 1px solid var(--skin-trim)');
    expect(css).not.toMatch(/pointer-events:\s*auto/);
  });

  it('the library draws its sidebar and composer as dark chrome with the chrome ink; the dark materials keep the panel', () => {
    expect(css).toContain(':root[data-material="mounted-paper"][data-decor="on"] .thread-sidebar { --plate-bg: var(--surface-chrome);');
    expect(css).toContain(':root[data-material="mounted-paper"][data-decor="on"] .composer-inner { --plate-bg: var(--surface-chrome);');
    expect(css).not.toContain(':root[data-material="black-damask"][data-decor="on"] .thread-sidebar');
  });
});

describe('only the selected room\'s assets load', () => {
  const css = buildSkinsCss();
  const roomOf = (path: string) => path.split('/')[2];

  it('each material block and each room block names files from one room folder only, and never a PNG', () => {
    expect(css).not.toMatch(/\.png/);
    for (const m of SKIN_MATERIALS) {
      const block = css.split(`:root[data-material="${m.id}"] {`)[1].split('\n}')[0];
      const rooms = new Set([...block.matchAll(/url\("(\/skins\/[^"]+)"\)/g)].map(u => roomOf(u[1])));
      expect([...rooms], m.id).toEqual([m.defaultRoom]);
    }
    for (const id of ['salon', 'library', 'cloister', 'conservatory', 'night', 'ember'] as const) {
      const block = css.split(`:root[data-room="${id}"] {`)[1].split('\n}')[0];
      const rooms = new Set([...block.matchAll(/url\("(\/skins\/[^"]+)"\)/g)].map(u => roomOf(u[1])));
      expect([...rooms], id).toEqual([id]);
    }
  });

  it('the plate rules name no file at all: they only read the active material and room through variables', () => {
    const plates = css.split('── plates:')[1].split('── rooms:')[0];
    expect(plates).not.toMatch(/url\("\/skins/);
  });

  it('the leaf etching is a background layer on the plate (no pseudo-element, no stacking context), its strength baked into the file', () => {
    expect(css).not.toMatch(/::before|isolation/); // Home's existing noninteractive ::after hook is material-gated
    expect(css).toContain('var(--skin-orn, none),');
    for (const m of SKIN_MATERIALS) {
      const block = css.split(`:root[data-material="${m.id}"] {`)[1].split('\n}')[0];
      if (m.texture!.ornament) {
        const o = m.texture!.ornament;
        expect(block).toContain(`--skin-orn: url("${o.url}");`);
        if (o.url.endsWith('.svg')) expect(readFileSync(join(PUBLIC, o.url.slice(1)), 'utf8')).toContain(`<g opacity="${o.alpha}">`);
        else expect(readFileSync(join(PUBLIC, o.url.slice(1))).subarray(8, 12).toString('latin1')).toBe('WEBP'); // painted, its own transparency
      } else expect(block).not.toContain('--skin-orn');
    }
  });

  it('bounded ornaments are material-owned for botanical, celestial and cloister treatments, and every texture file a material points at is shipped for its own room', () => {
    expect(SKIN_MATERIALS.filter(m => m.texture!.ornament).map(m => m.id)).toEqual(['midnight-ink', 'botanical-linen', 'indigo-silk']);
    for (const p of materialAssetPaths()) expect(readFileSync(join(PUBLIC, p.slice(1))).length, p).toBeGreaterThan(100);
    for (const id of MATERIAL_IDS.filter(i => i !== 'hedgewitch')) expect(ROOMS[MATERIALS[id].defaultRoom].corners).not.toBeNull();
  });
});


describe('bounded tactile substrates', () => {
  it('Ember uses the leathers cut from its plate art, never the Hedgewitch table or old walnut tiles', () => {
    const m = MATERIALS['smoked-copper'];
    for (const l of [m.texture!.card, m.texture!.chrome]) {
      expect(l.url).toBe('/skins/ember/ember-black-leather.webp');
      expect(l).toMatchObject({ tilePx: 576, alpha: 0.92, extremes: ['#050401', '#252221'] });
    }
    expect(m.texture!.user).toMatchObject({ url: '/skins/ember/ember-navy-leather.webp', tilePx: 576, alpha: 0.92, extremes: ['#041125', '#263349'] });
    expect(m.texture!.composer).toEqual(m.texture!.card); // the input bar is the black leather
    const css = buildSkinsCss();
    for (const line of css.split('\n').filter(l => l.includes('smoked-copper'))) expect(line).not.toContain('/hedgewitch/wood.webp');
    expect(css).toContain('background-blend-mode: normal, normal, normal, normal, normal, normal');
    expect(m.texture!.card.blend).toBeUndefined();
    const colors = registry.textureComposites(m.roles!.companion, m.texture!.card).map(c => parseColor(c)!);
    expect(Math.max(...colors.map(c => c.r)) - Math.min(...colors.map(c => c.r))).toBeGreaterThan(20); // the leather's grain shows
    for (const c of colors) expect(c.r).toBeGreaterThanOrEqual(c.b); // warm black, as the study's panels, never navy
    for (const c of colors) expect(relativeLuminance(c)).toBeLessThan(0.02); // dark leather, not charcoal grey
    const navy = registry.textureComposites(m.roles!.user, m.texture!.user!).map(c => parseColor(c)!);
    for (const c of navy) expect(c.b - c.r).toBeGreaterThan(25); // the "You" plate stays navy at both extremes
  });

  it('models both raster extremes and the opaque missing-image fallback instead of one pretend ink', () => {
    expect(typeof registry.textureComposites).toBe('function');
    const layer = MATERIALS['smoked-copper'].texture!.user!;
    const user = MATERIALS['smoked-copper'].roles!.user;
    const colors = registry.textureComposites(user, layer);
    expect(colors).toHaveLength(3);
    expect(colors).toContain(user);
    for (const color of colors) expect(contrastRatio('#F1E8DA', color)).toBeGreaterThanOrEqual(TEXT_MIN + TEXTURE_CONTRAST_MARGIN);
    const pairs = texturedPairs(MATERIALS['smoked-copper']);
    expect(new Set(pairs.filter(p => p.id.startsWith('user text on user plate')).map(p => p.bg)).size).toBe(3);
  });

  it('bounds the fibrous warm paper and its actual inks, controls and focus with the same safety margin', () => {
    expect(typeof registry.hedgewitchTexturedPairs).toBe('function');
    expect(registry.HEDGEWITCH_SUBSTRATE).toMatchObject({ url: '/hedgewitch/hedgewitch-paper.webp', alpha: 0.9, tilePx: 512, extremes: ['#E2D0B5', '#FFECD6'] });
    expect(registry.HEDGEWITCH_USER_PAPER).toMatchObject({ url: '/hedgewitch/hedgewitch-rose.webp', alpha: 0.9, tilePx: 512, extremes: ['#BD9899', '#EDC9CA'] });
    expect(registry.hedgewitchPaperOf('.message.user')).toBe(registry.HEDGEWITCH_USER_PAPER); // "You" is the painting's dusty rose
    expect(registry.hedgewitchPaperOf('.message.companion')).toBe(registry.HEDGEWITCH_SUBSTRATE);
    const pairs = registry.hedgewitchTexturedPairs();
    expect(pairs.length).toBeGreaterThan(40);
    expect(pairs.filter(p => contrastRatio(p.fg, p.bg) < p.min + TEXTURE_CONTRAST_MARGIN).map(p => p.id)).toEqual([]);
    expect(pairs.some(p => /focus/.test(p.id))).toBe(true);
  });
});


describe('mobile texture delivery', () => {
  it('pins the inspected, same-dimension WebP encodings inside the delivery budget', () => {
    for (const [file, sha] of [['ember-black-leather.webp', '230e9fe650840d7bc94064bb0e75d7145edfac75dc9028c064741e6fa1a42385'], ['ember-navy-leather.webp', 'a01a437b60743a2edc086fbbeefd2b48666c51911509fa310053264824cfb7b5']]) {
      const leather = readFileSync(join(PUBLIC, 'skins/ember', file));
      expect(leather.length, file).toBeLessThanOrEqual(150000);
      expect(createHash('sha256').update(leather).digest('hex'), file).toBe(sha);
    }
    for (const [file, sha] of [['hedgewitch-paper.webp', '9061c64a3f16255864d6db516245ebc378b5102dbd2687cb8a5b5bf8bd84f883'], ['hedgewitch-rose.webp', 'e0b33f8979e5d6d45dca50996fe1e861d6d15267ad4bed81b97b82f073acfcf9']]) {
      const paper = readFileSync(join(PUBLIC, 'hedgewitch', file));
      expect(paper.length, file).toBeLessThanOrEqual(250000);
      expect(createHash('sha256').update(paper).digest('hex'), file).toBe(sha);
    }
  });
});
