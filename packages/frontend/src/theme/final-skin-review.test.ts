/** Final review regressions against live source styles/ancestry and generated CSS.
 * These are cascade/contrast/geometry contracts, not mounted DOM or browser QA. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attributesFor, parseDoc } from './appearance';
import { buildSkinsCss } from './skins-css';
import { contrastRatio, mix } from './contrast';
import { CLEAR_COMPOSER_FIELD, FRAMED_ROUTE_PANELS, HEDGEWITCH_USER_PAPER, MATERIAL_LIST, MATERIALS, hedgewitchTexturedPairs, materialPairs, texturedPairs, textureComposites, type MaterialDef, type TextureLayer } from './materials';
import { sourceCascade, cssPixels, type CssNode } from './css-contract.test-helpers';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const components = Object.fromEntries(['HomeView', 'MessageBubble', 'FilesView', 'CommandCenterView', 'Canvas', 'CanvasList', 'ChatView', 'Composer'].map(name => [name, read(`../components/${name}.tsx`)]));
const styles = (s: string) => [...s.matchAll(/<style>\{`([\s\S]*?)`\}<\/style>/g)].map(m => m[1]).join('\n');
// Home fixture has no optional MCP rows. McpServerRow's pre-existing conditional
// global desktop padding override is intentionally outside this layout fixture.
const declarations = sourceCascade(read('../index.css') + read('../theme-hedgewitch.css') + buildSkinsCss() + read('./skins.css') + Object.entries(components).map(([name, source]) => styles(name === 'HomeView' ? source.slice(0, source.indexOf('export function McpServerRow')) : source)).join('\n'));
const node = (classes: string, parent: CssNode, extra: Partial<CssNode> = {}): CssNode => ({ classes: classes.split(' '), parent, ...extra });
const root = (materialId: MaterialDef['id'], state = {}) => ({ tag: 'html', attrs: { ...attributesFor(parseDoc({ version: 2, roomId: MATERIALS[materialId].defaultRoom, materialId, ...state })) } });
const panel = (r: CssNode, route: string, classes: string) => node(classes, node('app-content', r, { attrs: { 'data-route': route } }));
const actualRouteLayer = (m: MaterialDef, d: Record<string, string>): TextureLayer => {
  const image = d['background-image'];
  const layer = image.includes(m.texture!.chrome.url) && !image.includes(m.texture!.card.url) ? m.texture!.chrome : m.texture!.card;
  const keep = Number(image.match(/#[\da-f]{6}\s+([\d.]+)%/i)![1]);
  return { ...layer, alpha: 1 - keep / 100, blend: d['background-blend-mode']?.endsWith('multiply') ? 'multiply' : undefined };
};

describe('chrome route panels use the substrate their live descendant ink is paired with', () => {
  for (const m of MATERIAL_LIST.filter(m => m.roles)) it(`${m.id}: Files metadata and Command metadata remain readable on actual route texture bounds`, () => {
    for (const state of [{}, { decorations: false }, { readability: 'extra' as const }]) {
      const r = root(m.id, state);
      // Changed on purpose: the Files page was rebuilt (places, recent cards, the folder); every surface on it is one plate.
      const files = node('fl-panel fl-plate', node('fl-scroll', node('fl-root', node('app-content', r, { attrs: { 'data-route': 'files' } }))));
      const command = node('cmd-panel', node('cmd-view', node('app-content', r, { attrs: { 'data-route': 'command' } })));
      for (const [housing, descendant] of [[files, 'fl-meta'], [command, 'cmd-panel-meta']] as const) {
        const d = declarations(housing), ink = declarations(node(descendant, housing)).color;
        const backgrounds = 'decorations' in state || 'readability' in state ? [m.roles!.chrome] : textureComposites(m.roles!.chrome, actualRouteLayer(m, d));
        for (const bg of backgrounds) expect(contrastRatio(ink, bg), `${descendant}: ${ink} on ${bg}`).toBeGreaterThanOrEqual(4.6);
        if (!Object.keys(state).length) {
          // Changed on purpose: a framed route panel (Celestial's Command panels, the owner's choice) wears the Home card's
          // fittings first; under them the veil and texture, and so the ink's composite, are the plain route plate's.
          const framed = (FRAMED_ROUTE_PANELS[m.id] ?? []).includes(housing === command ? '.cmd-panel' : '.fl-plate');
          const corner = `${m.texture!.relief?.cornerPx}px ${m.texture!.relief?.cornerPx}px`;
          expect(d['background-image']).toContain(m.texture!.chrome.url);
          if (framed) for (const c of Object.values(m.texture!.relief!.corners)) expect(d['background-image']).toContain(c);
          expect(d['background-size']).toBe([...(framed ? Array(4).fill(corner) : []), 'auto', `${m.texture!.chrome.tilePx}px ${m.texture!.chrome.tilePx}px`].join(', '));
          expect(actualRouteLayer(m, d).alpha).toBeCloseTo(m.texture!.chrome.alpha, 8);
          expect(d['background-blend-mode'] ?? 'normal, normal').toBe([...(framed ? Array(4).fill('normal') : []), 'normal', m.texture!.chrome.blend ?? 'normal'].join(', '));
        }
      }
    }
  });
  it('Command fields take their material’s own opaque field pair, so their ink reads on the field alone', () => {
    // Changed on purpose: these fields were the Hedgewitch kitchen's translucent moss with a forced cream ink in every
    // skin (olive in Celestial's navy room). They now read the material's settings-field pair, as Settings does, and
    // every one is opaque, so no room texture reaches the ink: the check is the pair itself, in every material.
    for (const each of MATERIAL_LIST.filter(each => each.roles)) {
      const field = declarations(node('cmd-input', node('cmd-panel', node('cmd-view', node('app-content', root(each.id), { attrs: { 'data-route': 'command' } }))), { tag: 'input' }));
      expect(field.background, each.id).toMatch(/^#[\da-f]{6}$/i);
      expect(field.color, each.id).toBe(field['--settings-field-text']);
      expect(contrastRatio(field.color, field.background), `${each.id}: ${field.color} on ${field.background}`).toBeGreaterThanOrEqual(4.6);
    }
    const m = MATERIALS['mounted-paper'], r = root(m.id);
    const housing = node('cmd-panel', node('cmd-view', node('app-content', r, { attrs: { 'data-route': 'command' } })));
    const input = declarations(node('cmd-input', housing, { tag: 'input' }));
    expect(input.background).toBe('#E6CAA1'); // the Library's parchment field
    expect(input.color).toBe('#24190F');      // with its dark ink (the old forced cream would not read on it)
    const canvas = panel(r, 'canvas', 'cve-header');
    const title = declarations(node('cve-title', canvas, { tag: 'input' }));
    expect(title.background).toBe('transparent');
    for (const bg of textureComposites(m.roles!.chrome, actualRouteLayer(m, declarations(canvas)))) expect(contrastRatio(title.color, bg)).toBeGreaterThanOrEqual(4.6);
    // Root material aliases keep their defining pair despite route-local legacy remaps.
    expect(input['--surface-input']).toBe('#E6CAA1');
    expect(input['--surface-input-text']).toBe('#24190F');
  });
});

describe('Home phone cards keep their title room and the complete bottom-local motif', () => {
  // Changed on purpose: the "Welcome home" layout replaced the half-width Today and Notes cards with picture tiles, and on a
  // phone Recent conversation and Reminders stack full width. The same clearance contract now holds for those cards.
  for (const id of ['botanical-linen', 'indigo-silk', 'midnight-ink'] as const) it(`${id}: phone Recent conversation/Reminders stay full width with the whole motif`, () => {
    for (const label of ['Recent conversation', 'Reminders']) expect(components.HomeView).toContain(`<section className="home-card" aria-label="${label}"`);
    for (const width of [320, 390]) {
      const r = root(id), scroll = node('home-scroll', r), grid = node('home-two', scroll), card = node('home-card', grid), title = node('home-card-title', card);
      const s = declarations(scroll, width), g = declarations(grid, width), c = declarations(card, width), t = declarations(title, width);
      expect(g['grid-template-columns']).toBe('1fr');
      const rootPx = cssPixels(declarations(r, width)['font-size']);
      expect(rootPx).toBe(15);
      const cardWidth = width - 2 * cssPixels(declarations(r, width)['--skin-gutter-x']) - cssPixels(s['padding-left']) - cssPixels(s['padding-right']);
      const contentWidth = cardWidth - cssPixels(c['padding-left']) - cssPixels(c['padding-right']);
      expect(cssPixels(t['font-size'])).toBe(15); // no font shrink
      // Conservative bound, as before (a whole em per letter): the longest unbreakable word, "conversation", beside
      // "See all" (allowed five ems). Source geometry, not a measurement of Lora glyphs in a browser.
      expect(contentWidth).toBeGreaterThanOrEqual((12 + 5) * cssPixels(t['font-size']));
      const size = MATERIALS[id].texture!.ornament!.mobileSizePx!;
      expect(c['background-size']).toContain(`auto min(${size}px, calc(100% - 8px))`);
      expect(c['--plate-orn-position']).toBe('100% 100%'); // Moonlit Cloister's Home cards carry their sprigs on the right too
      expect(cssPixels(c['padding-bottom'])).toBeGreaterThanOrEqual(size + 10.5);
      expect(c['pointer-events']).not.toBe('none');
      expect(c['overflow-wrap']).not.toBe('anywhere'); // do not break/shrink the title instead
    }
  });
});

describe('live user descendants have bounded material-owned ink', () => {
  it('Library Delete hover control clears 3.1 on solid/decorated/Extra user surfaces without changing panel error ink', () => {
    expect(components.MessageBubble).toContain('className="msg-action-btn danger"');
    const m = MATERIALS['mounted-paper'];
    for (const state of [{}, { decorations: false }, { readability: 'extra' as const }]) {
      const r = root(m.id, state), message = node('message user', r);
      const d = declarations(node('msg-action-btn danger', message, { tag: 'button', state: 'hover' }));
      expect(d.background).toBe('rgba(220, 140, 120, 0.08)');
      const bounds = Object.keys(state).length ? [m.roles!.user] : textureComposites(m.roles!.user, m.texture!.card);
      expect(Math.min(...bounds.map(bg => contrastRatio(d.color, mix(bg, '#DC8C78', 0.08)))), `${d.color} on worst hover bound`).toBeGreaterThanOrEqual(3.1);
      expect(declarations(r)['--status-error-text']).toBe('#852B20');
    }
    for (const material of MATERIAL_LIST.filter(m => m.roles && m.id !== 'mounted-paper')) {
      const r = root(material.id), message = node('message user', r);
      expect(declarations(node('msg-action-btn danger', message, { state: 'hover' })).color).toBe(material.roles!.error);
    }
    expect(materialPairs(m.roles!).some(p => p.id.includes('danger') && p.min === 3)).toBe(true);
    expect(texturedPairs(m).some(p => p.id.includes('danger') && p.min === 3)).toBe(true);
  });
  it('Hedgewitch live edited metadata is modeled and readable on new paper, including the failed-image fallback', () => {
    expect(components.MessageBubble).toContain('<span className="message-edited">edited</span>');
    for (const state of [{}, { decorations: false }, { readability: 'extra' as const }]) {
      const r = root('hedgewitch', state), edited = node('message-edited', node('message-header', node('message user', r)));
      const ink = declarations(edited).color;
      expect(Math.min(...textureComposites('#CFABAC', HEDGEWITCH_USER_PAPER).map(bg => contrastRatio(ink, bg))), `${ink} on worst paper bound`).toBeGreaterThanOrEqual(4.6);
      expect(hedgewitchTexturedPairs().filter(p => p.id.includes('edited metadata')).map(p => p.fg)).toContain(ink);
      expect(declarations(r)['--text-muted']).toBe('#5d5047'); // the panel's muted ink, one step darker for the painting's warmer paper
    }
  });
});

describe('Hedgewitch surface decoration off removes only the plant reserve', () => {
  for (const width of [320, 1440]) it(`normal on keeps its chosen spacing; decor off/Extra reclaim real Home padding at ${width}px`, () => {
    for (const half of [false, true]) {
      const cardFor = (r: CssNode) => node('home-card', half ? node('home-two', r) : r);
      const on = root('hedgewitch');
      expect(on.attrs['data-decor']).toBe('off'); // room is unframed even with surface decoration on
      expect(on.attrs['data-surface-decor']).toBe('on');
      // On a phone the Home cards no longer sit two abreast ("Welcome home" layout), so a card in the pair keeps the full reserve.
      expect(cssPixels(declarations(cardFor(on), width)['padding-right'])).toBe(width > 768 ? 82.5 : 51);
      for (const state of [{ decorations: false }, { readability: 'extra' as const }]) {
        const r = root('hedgewitch', state), card = cardFor(r);
        expect(declarations({ ...card, pseudo: '::after' }, width).display).toBe('none');
        expect(cssPixels(declarations(card, width)['padding-right'])).toBe(width > 768 ? 18 : 12.75);
        expect(declarations(r, width)['--home-sprig-room']).toBe('0rem');
      }
    }
  });
});


describe('live-source editable field pair contracts (not runtime editor verification)', () => {
  // Every material x mode x field x focus phase, each resolved against the whole stylesheet: seconds, not milliseconds.
  it('targets Home input/textarea, sidebar naming input, and the message composer textarea that actually have JSX', { timeout: 30_000 }, () => {
    expect(components.HomeView).toMatch(/<input\s+className="mc-input"/);
    expect(components.HomeView).toMatch(/<textarea\s+className="mc-input"/);
    expect(components.ChatView).toMatch(/<input\s+ref=\{nameInputRef\}\s+className="thread-name-input"/);
    expect(components.Composer).toMatch(/<textarea\s+ref=\{textareaRef\}\s+className="composer-textarea"/);
    for (const m of MATERIAL_LIST.filter(m => m.roles)) for (const state of [{}, { decorations: false }, { readability: 'extra' as const }]) {
      const r = root(m.id, state);
      for (const [field, housing, tag] of [['mc-input', 'home-card', 'input'], ['mc-input', 'home-card', 'textarea'], ['thread-name-input', 'thread-sidebar', 'input'], ['composer-textarea', 'composer-inner', 'textarea']] as const) {
        const input = node(field, node(housing, r), { tag });
        for (const phase of [undefined, 'focus', 'focus-visible', undefined]) {
          const d = declarations({ ...input, state: phase });
          // Ember's existing off/Extra composer field is transparent over its own
          // opaque dark composer, rather than the decorated inset field colour.
          const transparent = d['background-color'] === 'transparent';
          const bg = transparent ? declarations(input.parent!)['background-color'] : d['background-color'];
          // A one-surface chat bar (the Library's decorated wood) is the chrome, in the chrome's ink.
          const decorated = Object.keys(state).length === 0;
          const onChrome = field === 'composer-textarea' && CLEAR_COMPOSER_FIELD.has(m.id) && decorated;
          expect(bg, `${m.id}/${field}/${phase}`).toBe(onChrome ? m.roles!.chrome : transparent ? m.roles!.composer : m.roles!.input);
          expect(d.color).toBe(onChrome ? m.roles!.chromeText : m.roles!.inputText);
          expect(contrastRatio(d.color, bg)).toBeGreaterThanOrEqual(4.6);
          // A composer with its own leather (Ember's) lifts its placeholder for that leather, where the leather is drawn.
          const leather = !!m.texture?.composer && decorated;
          expect(declarations({ ...input, pseudo: '::placeholder' }).color).toBe(field === 'composer-textarea' ? (onChrome ? m.roles!.chromeMuted : leather ? m.roles!.composerMuted : m.roles!.placeholder) : m.roles!.editor!.placeholder);
        }
      }
    }
  });
});
