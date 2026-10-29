import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MATERIALS, MOUNT_BACKING_PX, ORNAMENT_SLOTS, materialAssetPaths, ornamentVariants, materialPairs, materialVars, skinVars, texturedPairs, TEXTURE_CONTRAST_MARGIN } from './materials';
import { contrastRatio, relativeLuminance, parseColor } from './contrast';
import { buildSkinsCss } from './skins-css';

export const RESTORED = ['mounted-paper', 'black-damask', 'botanical-linen', 'indigo-silk', 'midnight-ink'] as const;
const TARGETS = {
  'mounted-paper': ['#FFDA98', '#FFDA98', '#B9834D', '#E6CAA1', '#24190F'],
  'black-damask': ['#101010', '#101010', '#470509', '#191313', '#F4EEE7'],
  'botanical-linen': ['#0B1829', '#284059', '#262E51', '#14273A', '#F1EEE8'],
  'indigo-silk': ['#11172D', '#11172D', '#262145', '#191D36', '#F6EEDA'],
  'midnight-ink': ['#0A162C', '#0A162C', '#2B3B64', '#13223C', '#F4F0EB'],
};

describe('approved remaining material restoration', () => {
  for (const id of RESTORED) {
    it(`${id} keeps its approved opaque Home/companion/user/input palette and explicit active editor pair`, () => {
      const m = MATERIALS[id], r = m.roles!;
      expect([r.panel, r.companion, r.user, r.input, r.text]).toEqual(TARGETS[id]);
      expect(r.editor).toMatchObject({ bg: r.input, text: r.inputText, placeholder: r.placeholder, focus: r.focus });
      expect(m.texture!.editor).toBeNull();
      expect(skinVars(m)['--skin-field-bg']).toBe(r.input);
      expect(materialVars(r)['--surface-user-meta']).toBe(r.userText);
      for (const p of [...materialPairs(r), ...texturedPairs(m)]) expect(contrastRatio(p.fg, p.bg), `${id}: ${p.id}`).toBeGreaterThanOrEqual(p.min + TEXTURE_CONTRAST_MARGIN);
    });
    it(`${id} owns restrained hardware independently of its room and has nonzero tactile grain`, () => {
      const m = MATERIALS[id], t = m.texture!;
      expect(t.relief).toBeDefined();
      // Moonlit Cloister's and the Library's brackets are cut from their paintings, drawn at the size their rims need
      expect([t.relief!.cornerPx, t.relief!.cornerMobilePx]).toEqual(id === 'midnight-ink' ? [32, 28] : id === 'mounted-paper' ? [30, 26] : id === 'black-damask' ? [36, 30] : id === 'botanical-linen' || id === 'indigo-silk' ? [34, 28] : [18, 16]);
      for (const url of Object.values(t.relief!.corners)) expect(url).toContain(`/skins/${m.defaultRoom}/`);
      expect(t.card.alpha).toBeGreaterThan(0);
      expect(t.card.tilePx).toBeGreaterThanOrEqual(192);
      expect(t.card.url).not.toMatch(/texture-v1/); // no restored waves, enlarged flecks or wallpaper as substrate
      const css = buildSkinsCss();
      expect(css).toContain(`:root[data-material="${id}"][data-surface-decor="on"]:not([data-readability="extra"])`);
      for (const url of Object.values(t.relief!.corners)) expect(materialAssetPaths()).toContain(url);
    });
  }
  it('Cloister is the painting\'s own cloth: navy twill and a lighter "You" cloth, at full plate strength over their measured extremes', () => {
    const t = MATERIALS['midnight-ink'].texture!;
    expect(t.card).toMatchObject({ url: '/skins/cloister/cloister-navy-cloth.webp', alpha: 0.92, tilePx: 576, extremes: ['#000418', '#182238'] });
    expect(t.chrome).toEqual(t.card);
    expect(t.user).toMatchObject({ url: '/skins/cloister/cloister-you-cloth.webp', alpha: 0.92, tilePx: 576, extremes: ['#0E1F47', '#38466E'] });
    for (const url of Object.values(t.relief!.corners)) expect(url).toMatch(/^\/skins\/cloister\/cloister-bracket-(tl|tr|br|bl)\.webp$/);
    expect(t.relief!.cornerPx).toBe(32);
  });
  it('Library uses dark tobacco ink, separate bounded burnt edges, and only a slim 2px mount', () => {
    const m = MATERIALS['mounted-paper'], r = m.roles!;
    expect(r.userText).toBe('#24190F');
    expect(r.controlBorder).toBe('#533119');
    expect(r.focus).toBe('#4E2D13');
    expect(relativeLuminance(parseColor(r.link)!)).toBeLessThan(0.05);
    expect(r.focusChrome).toBe('#BA5C3C');
    expect(r.chromeTrim).toBe('#7E3420'); // the wood plates' rim is oxblood, the parchment's stays brass
    expect(r.trim).toBe('#8A643C');
    expect(MOUNT_BACKING_PX).toBe(2);
    expect(m.texture!.edge).toEqual({ ink: '#633918', alpha: 0.58, widthPx: 8 });
    expect(m.texture!.card.tilePx).toBe(512);
    expect(m.texture!.card).toMatchObject({ url: '/skins/library/library-parchment.webp', alpha: 0.9, extremes: ['#E3BC81', '#FFEEBC'] }); // the mock-up's parchment, as the plate
    expect(m.texture!.user).toMatchObject({ url: '/skins/library/library-you.webp', alpha: 0.9, extremes: ['#A37D56', '#E7C39D'] });
    expect(m.texture!.card.blend).toBeUndefined();
  });
  it('Vampire is its mock-up\'s black damask, with a distinct crimson velvet user substrate, and no drawn pattern over either', () => {
    const m = MATERIALS['black-damask'], t = m.texture!;
    expect(parseColor(m.roles!.panel)).toMatchObject({ r: 16, g: 16, b: 16 });
    expect(t.card).toMatchObject({ url: '/skins/salon/velvet-damask.webp', alpha: 0.92, tilePx: 576, extremes: ['#000000', '#232423'] });
    expect(t.pattern).toBeUndefined();
    expect(t.user).toMatchObject({ url: '/skins/salon/velvet-crimson.webp', tilePx: 576, extremes: ['#2A0000', '#66171C'] });
    expect(t.user!.url).not.toBe(t.card.url);
    expect(t.user!.extremes).toHaveLength(2);
    expect(materialAssetPaths()).toContain(t.user!.url);
    expect(skinVars(m)['--skin-tex-user']).toContain('velvet-crimson.webp');
    const pairs = texturedPairs(m).filter(p => p.id.startsWith('user text on user plate'));
    expect(new Set(pairs.map(p => p.bg)).size).toBe(3);
    const c = parseColor(m.roles!.user)!;
    expect(c.r).toBeGreaterThan(c.b * 5);
  });
  it('botanical, celestial and cloister motifs are small, position-owned edge-local art rather than room plants', () => {
    for (const [id, sizePx, mobileSizePx, position] of [
      ['botanical-linen', 72, 48, '100% 100%'], ['indigo-silk', 112, 64, '100% 100%'], ['midnight-ink', 72, 48, '0 100%'],
    ] as const) {
      const o = MATERIALS[id].texture!.ornament!;
      expect(o).toMatchObject({ sizePx, mobileSizePx, position, clearance: true });
      const file = readFileSync(fileURLToPath(new URL(`../../public${o.url}`, import.meta.url)));
      expect(o.alpha).toBeGreaterThanOrEqual(0.4);
      if (o.url.endsWith('.svg')) {
        const art = file.toString('utf8');
        expect(art).not.toMatch(/clipPath|clip-path/);
        expect(art).toContain(`<g opacity="${o.alpha}">`);
      } else {
        // a painted sprig lifted off its cloth: a WebP with its own transparency, square, drawn whole in its reserved corner
        expect(file.subarray(8, 12).toString('latin1')).toBe('WEBP');
        // three painted sprigs, each upright and hanging, in both mirrorings
        const room = { 'midnight-ink': 'cloister', 'botanical-linen': 'conservatory', 'indigo-silk': 'night' }[id as string]!;
        const prefix = { cloister: 'cloister-sprig', conservatory: 'greenhouse-sprig', night: 'celestial-moon' }[room]!;
        expect(o.url).toMatch(new RegExp(`^/skins/${room}/${prefix}-\\w+-(bl|br)\\.webp$`));
        expect(o.variants!.paintings).toEqual(id === 'botanical-linen' ? ['home', 'comp', 'bloom', 'you'] : ['home', 'comp', 'you']);
        expect(!!o.variants!.alternate).toBe(id !== 'midnight-ink'); // the Conservatory's sprigs and Celestial's moons also cross sides
        expect(o.variants!.template).toBe(`/skins/${room}/${prefix}-{painting}-{corner}.webp`);
        if (id === 'midnight-ink') expect(o.variants!.rightPlates).toEqual(['.message.user', '.home-card']);
        const files = materialAssetPaths().filter(u => u.includes(`${prefix}-`));
        for (const url of files) expect(readFileSync(fileURLToPath(new URL(`../../public${url}`, import.meta.url))).subarray(8, 12).toString('latin1'), url).toBe('WEBP');
        expect(files).toHaveLength(o.variants!.paintings.length * 4);
        if (id === 'botanical-linen') {
          // a variant on the plate's other side takes its reserved space with it; slots past the variants repeat them
          const on = `:root[data-material="${id}"][data-surface-decor="on"]:not([data-readability="extra"])`;
          const css = buildSkinsCss(), n = ornamentVariants(o.variants!).length;
          expect(n).toBe(16);
          // the corner cycles every four slots: upright, hanging on the own (right) side, then upright, hanging on the other
          const vs = ornamentVariants(o.variants!);
          expect(vs.slice(0, 4).map(x => [x.flip, x.top])).toEqual([[false, false], [false, true], [true, false], [true, true]]);
          for (let i = 0; i + 2 < vs.length; i++) expect(vs[i].flip, `slot ${i} and ${i + 2} sit on opposite sides`).not.toBe(vs[i + 2].flip);
          for (let i = 0; i + 1 < vs.length; i++) expect(vs[i].top, `slot ${i} and ${i + 1} differ top and bottom`).not.toBe(vs[i + 1].top);
          expect(new Set(vs.map(x => `${x.painting} ${x.flip} ${x.top}`)).size).toBe(vs.length); // every painting meets every corner
          expect(css).toContain(`${on} .message.companion[data-orn="2"] { --skin-orn: var(--skin-orn-2-left); --plate-orn-position: 0 100%; padding-left: calc(1.1rem + var(--material-orn-clearance)); padding-right: 1.1rem; }`);
          expect(css).toContain(`${on} .message.user[data-orn="${n + 1}"] { --skin-orn: var(--skin-orn-1-right); --plate-orn-position: 100% 0; padding-right: calc(1.1rem + var(--material-orn-clearance)); padding-left: 1.1rem; }`);
          expect(css).toContain(`${on} .home-card[data-orn="3"] { --skin-orn: var(--skin-orn-3-upright-left); --plate-orn-position: 0 100%; padding-left: 0.85rem; padding-right: 0.85rem; }`);
          expect(css).not.toContain(`[data-orn="${ORNAMENT_SLOTS}"]`);
        }
      }
    }
  });
});
