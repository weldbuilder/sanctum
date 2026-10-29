/**
 * Mantelpiece / Ember: the sixth room (`ember`) and its material (`smoked-copper`). Approved black/navy surfaces, ivory ink and copper controls are recorded in
 * ember-tokens.json; the contrast report is recomputed from those restoration choices.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import tokens from './ember-tokens.json';
import { BASE_PALETTES, EDITOR_FIELDS, FLAT, MATERIALS, PLATES, materialPairs, materialVars, skinVars, texturedPairs } from './materials';
import { ROOMS, ROOM_LIST } from './rooms';
import { MATERIAL_IDS, ROOM_IDS } from './types';
import { attributesFor, coerceMaterial, defaultDoc, materialAllowedWithRoom, panelPalette, parseDoc, serializeDoc, showsDecorations, withMaterial, withRoom, withRoomPreset } from './appearance';
import { buildSkinsCss } from './skins-css';
import { contrastRatio, parseColor, relativeLuminance, round2, CONTROL_MIN, TEXT_MIN } from './contrast';

const m = MATERIALS['smoked-copper'];
const r = m.roles!;
const t = tokens.color;
const css = buildSkinsCss();
const block = (sel: string) => css.split(`${sel} {`)[1].split('\n}')[0];

describe('Ember is registered', () => {
  it('as the room ember with the material smoked-copper, in the order the pickers and the boot script list them', () => {
    expect(ROOM_IDS).toContain('ember');
    expect(MATERIAL_IDS).toContain('smoked-copper');
    expect(ROOM_IDS.indexOf('ember')).toBe(ROOM_IDS.indexOf('hedgewitch') - 1);
    expect(ROOMS.ember.defaultMaterial).toBe('smoked-copper');
    expect(m.defaultRoom).toBe('ember');
    expect(m.label).toBe('Smoked copper');
    expect(m.scheme).toBe('dark');
    expect(m.legacy).toBe(false);
    expect(ROOM_LIST.map(x => x.id)).toEqual([...ROOM_IDS]);
  });
});

describe('the approved Ember palette', () => {
  it('exports its chosen leather surfaces and ivory/copper roles to the app', () => {
    expect(r.chrome).toBe(t.page);
    expect(r.panel).toBe(t.card);
    expect(r.input).toBe(t.input);
    expect(r.panelRaised).toBe(t.raised);
    expect(r.text).toBe(t.text);
    expect(r.secondary).toBe(t.textSecondary);
    expect(r.link).toBe(t.copperText);
    expect(r.controlBorder).toBe(t.copperText);
    expect(r.focus).toBe(t.focus);
    expect(r.error).toBe(t.errorText);
    expect(r.success).toBe(t.successText);
    expect(r.button).toBe(tokens.roles.selected);
    expect(r.buttonText).toBe(tokens.roles.selectedText);
    expect(r.buttonText).toBe(t.page); // page ink on the copper fill, never ivory
  });

  it('owns a navy leather user bubble and composer, a dark field, popover and chrome with ivory text', () => {
    const R = tokens.roles;
    expect([r.companion, r.companionText]).toEqual([R.companion, R.companionText]);
    expect([r.user, r.userText]).toEqual([R.user, R.userText]);
    expect([r.composer, r.input, r.inputText]).toEqual([R.composer, R.input, R.inputText]);
    expect([r.popover, r.popoverText]).toEqual([R.popover, R.popoverText]);
    expect([r.chrome, r.chromeText]).toEqual([R.chrome, R.chromeText]);
    expect(r.sidebar).toBe(R.chrome); // the chat list is chrome
    expect(r.controlBorder).toBe(R.controlBorder);
    expect(r.focus).toBe(R.focusRing);
  });

  it('the decorative rust and divider are the frame and the quiet edge, and are in no text or control pair', () => {
    expect(r.frame).toBe(t.rustDecorative);
    expect(r.divider).toBe(t.dividerDecorative);
    const used = new Set<string>();
    for (const p of [...materialPairs(r), ...texturedPairs(m)]) { used.add(p.fg.toUpperCase()); used.add(p.bg.toUpperCase()); }
    expect(used.has(t.rustDecorative.toUpperCase())).toBe(false);
    expect(used.has(t.dividerDecorative.toUpperCase())).toBe(false);
    // and neither is a control boundary or a focus colour
    for (const v of [r.controlBorder, r.focus, r.focusChrome, r.button]) {
      expect(v.toUpperCase()).not.toBe(t.rustDecorative.toUpperCase());
      expect(v.toUpperCase()).not.toBe(t.dividerDecorative.toUpperCase());
    }
    // the pack's own two rejections stay rejections: they fail 3:1 on the leather's lightest grain, which is why they are ornament only
    expect(contrastRatio(t.rustDecorative, t.leatherLight)).toBeLessThan(CONTROL_MIN);
    expect(contrastRatio(t.dividerDecorative, t.leatherLight)).toBeLessThan(CONTROL_MIN);
    expect(t.leatherLight).toBe(m.texture!.card.extremes![1]);
  });

  it('the restoration contrast report covers the five dark surfaces and the composer, and keeps the two decorative rejections', () => {
    const rows = readFileSync(fileURLToPath(new URL('./ember-contrast-report.csv', import.meta.url)), 'utf8').trim().split('\n').slice(1).map(l => l.trim().split(','));
    expect(rows).toHaveLength(46);
    let pass = 0, reject = 0;
    for (const [id, fg, bg, ratio, min, result] of rows) {
      expect(round2(contrastRatio(fg, bg)), id).toBeCloseTo(Number(ratio), 1);
      if (result === 'PASS') { pass++; expect(contrastRatio(fg, bg), id).toBeGreaterThanOrEqual(Number(min)); } else { reject++; expect(id).toMatch(/^REJECT/); expect(contrastRatio(fg, bg), id).toBeLessThan(Number(min)); }
    }
    expect([pass, reject]).toEqual([44, 2]);
    // every reported colour belongs to the material, including its input/editor pairs
    const known = new Set([...Object.values(r), ...Object.values(r.editor!), ...Object.values(t)].filter(v => typeof v === 'string').map(v => v.toUpperCase()));
    for (const [id, fg, bg] of rows) { expect(known.has(fg.toUpperCase()), `${id} ${fg}`).toBe(true); expect(known.has(bg.toUpperCase()), `${id} ${bg}`).toBe(true); }
  });

  it('every promised pair on every surface meets 4.5:1 (text) or 3:1 (controls, focus), and the user bubble is told from the companion card by its navy leather as well as its copper edge', () => {
    const fails = materialPairs(r).filter(p => !(contrastRatio(p.fg, p.bg) >= p.min)).map(p => `${p.id} ${round2(contrastRatio(p.fg, p.bg))}`);
    expect(fails).toEqual([]);
    expect(materialPairs(r).length).toBeGreaterThan(60);
    // both bubbles keep the full-strength copper edge (step 4); the "You" plate is also navy leather against the black one
    const [you, them] = [parseColor(r.user)!, parseColor(r.companion)!];
    expect(you.b - you.r).toBeGreaterThan(30);
    expect(Math.abs(them.r - them.b)).toBeLessThan(16);
    expect(css).toContain('--plate-bg: var(--surface-user)');
    expect(css).not.toContain('border-color: var(--skin-trim-quiet)'); // no plate is on the quiet line any more
    expect(m.flat!.quiet).toEqual([]);
    expect(skinVars(m)['--skin-trim-quiet']).toBe(t.dividerDecorative);
    expect(skinVars(m)['--skin-trim']).toBe(t.copperText);
  });

  it('a selected control is copper with page ink, never ivory', () => {
    const v = materialVars(r);
    expect(v['--control-selected-bg']).toBe(t.copperText);
    expect(v['--control-selected-text']).toBe(t.page);
    expect(v['--control-primary-text']).toBe(t.page);
    expect(contrastRatio(v['--control-selected-text'], v['--control-selected-bg'])).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(t.text, t.copperText)).toBeLessThan(TEXT_MIN); // ivory on copper would fail, which is the rule
  });

  it('focus is the tokens\' 2px ring in #D9AB8D', () => {
    expect(tokens.focus).toMatchObject({ widthPx: 2, offsetPx: 3, blurPx: 0 });
    expect(materialVars(r)['--focus-ring']).toBe('#D9AB8D');
    expect(materialVars(r)['--focus-ring-chrome']).toBe('#D9AB8D');
    expect(panelPalette('smoked-copper').focus).toBe('#D9AB8D');
  });

  it('the shipped palette is exactly what BASE_PALETTES holds, with no stray keys', () => {
    expect(Object.keys(BASE_PALETTES['smoked-copper']).sort()).toEqual(['button', 'buttonText', 'chrome', 'chromeOnButton', 'chromeText', 'companion', 'composer', 'controlBorder', 'divider', 'editor', 'error', 'focus', 'frame', 'input', 'link', 'muted', 'panel', 'raised', 'secondary', 'sidebar', 'success', 'text', 'trim', 'user', 'userText']);
  });
});

describe('Ember inputs belong to the dark material, not an ivory fallback', () => {
  const luminance = (color: string) => relativeLuminance(parseColor(color)!);

  it('renders dark blue charcoal input surfaces with ivory ink, a black leather composer and a navy leather user bubble', () => {
    const vars = { ...materialVars(r), ...skinVars(m) };
    expect(vars['--composer-bg']).toBe(t.composer); // the composer is the black leather bar; the field inside it is clear, never ivory
    expect(t.composer).toBe(t.card);
    expect(luminance(vars['--composer-bg'])).toBeLessThan(0.02);
    for (const key of ['--bg-input', '--settings-field-bg', '--skin-field-bg', '--skin-editor-bg']) {
      const color = parseColor(vars[key])!;
      expect(luminance(vars[key]), key).toBeLessThan(0.08);
      expect(color.b, `${key} is blue charcoal, not walnut`).toBeGreaterThan(color.r);
    }
    const user = parseColor(vars['--surface-user'])!;
    expect(user.b).toBeGreaterThan(user.g); // navy, as in the approved study
    expect(user.g).toBeGreaterThan(user.r);
    expect(luminance(vars['--surface-user'])).toBeLessThan(0.08);
    for (const key of ['--text-primary', '--skin-field-text', '--skin-editor-text']) {
      const ink = parseColor(vars[key])!;
      expect(luminance(vars[key]), key).toBeGreaterThan(0.7);
      expect(ink.r, `${key} is warm ivory ink`).toBeGreaterThan(ink.b);
    }
  });

  it('uses Ember\'s own readable editor surface, placeholder and focus rather than a paper default', () => {
    expect(r.editor).toMatchObject({ bg: r.input, text: r.inputText, placeholder: r.secondary, focus: r.focus });
    expect(contrastRatio(r.editor!.text, r.editor!.bg)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(r.editor!.placeholder, r.editor!.bg)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(r.editor!.focus, r.editor!.bg)).toBeGreaterThanOrEqual(CONTROL_MIN);
    expect(MATERIAL_IDS.filter(id => MATERIALS[id].roles?.editor)).toEqual(MATERIAL_IDS.filter(id => id !== 'hedgewitch'));
  });

  it('emits the dark editor pair without painting the old opaque ivory parchment tile over it', () => {
    const vars = skinVars(m);
    expect(vars['--skin-editor-bg']).toBe(r.input);
    expect(vars['--skin-editor-text']).toBe(r.inputText);
    expect(vars['--skin-editor-tex']).toBe('none');
    expect(m.texture!.editor).toBeNull();
    const materialBlock = block(':root[data-material="smoked-copper"]');
    expect(materialBlock).toContain(`--skin-editor-bg: ${r.input};`);
    expect(materialBlock).toContain('--skin-editor-tex: none;');
    expect(materialBlock).not.toContain('/skins/ember/ember-parchment-tile.svg');
  });

  it('keeps Home and rename fields dark at rest and after focus/blur, without overriding the composer with an editor palette', () => {
    expect([...EDITOR_FIELDS]).toEqual(['.mc-input', '.thread-name-input']);
    const selector = ':root[data-material="smoked-copper"] :is(.mc-input, .thread-name-input)';
    const atRest = block(selector);
    expect(atRest).toContain('background-color: var(--skin-editor-bg)');
    expect(atRest).toContain('color: var(--skin-editor-text)');
    expect(atRest).toContain('caret-color: var(--skin-editor-text)');
    const focus = css.split('\n').find(line => line.startsWith(`${selector}:focus,`))!;
    expect(focus).toContain('outline: 2px solid var(--skin-editor-focus)');
    expect(focus).not.toMatch(/[;{]\s*(?:background(?:-color|-image)?|color)\s*:/);
    // Focus only changes the boundary/ring; blur therefore retains the same dark base pair.
    for (const line of css.split('\n').filter(line => line.includes('--skin-editor-') && line.includes('{'))) {
      expect(line).toContain(':is(.mc-input, .thread-name-input)');
      expect(line).not.toContain('.composer-textarea');
    }
    expect(css).toContain('.composer-textarea { background: var(--skin-field-bg); color: var(--skin-field-text);');
  });

  it('retains its opaque editor pair with decorations off or Extra readable on', () => {
    const editor = css.split('\n').find(line => line.includes('background-color: var(--skin-editor-bg)'))!;
    expect(editor).toContain(':root[data-material="smoked-copper"]');
    expect(editor).not.toMatch(/data-decor|data-readability/);
    expect(skinVars(m)['--skin-editor-tex']).toBe('none');
  });
});

describe('restrained leather plates', () => {
  const ON = ':root[data-material="smoked-copper"][data-surface-decor="on"]:not([data-readability="extra"])';
  const flat = css.split('/* ── smoked-copper: flat plates')[1].split('/* ──')[0];

  it('draws nearly square cards with fine leather and separate worked copper fittings, and rounds only the bubbles and the input bar', () => {
    expect(FLAT['smoked-copper']!.radius).toBe(tokens.card.radiusPx);
    expect(tokens.card.radiusPx).toBeLessThanOrEqual(4);
    expect(FLAT['smoked-copper']!.soft).toEqual({ radius: tokens.card.bubbleRadiusPx, selectors: ['.message.companion', '.message.user', '.composer-inner'] });
    expect(flat).toContain(`${ON} :is(.message.companion, .message.user, .composer-inner) { --plate-radius: 8px; --plate-corner: 0px;`);
    // after the phone-size fitting rule, so the bubbles stay free of fittings at every width
    expect(flat.indexOf('--plate-corner: 0px; box-shadow')).toBeGreaterThan(flat.indexOf('@media (max-width: 768px)'));
    expect(m.chipRadius).toBe(tokens.card.chipRadiusPx);
    // Home's companion chip (in the banner's corner) replaced its name row and Open chat button; it keeps the chip radius.
    expect(css).toMatch(/:root\[data-material="smoked-copper"\]:not\(\[data-readability="extra"\]\) :is\([^)]*\.home-hero-chip[^)]*\) \{ border-radius: 4px; \}/);
    expect(tokens.card.edgePx).toBe(1);
    expect(flat).toContain('var(--skin-fitting-tl, none)');
    expect(flat).toContain('var(--plate-tex, none)');
    expect(flat).toContain('box-shadow: var(--skin-plate-relief)');
    expect(flat).toContain('--plate-radius: 3px;');
    expect(flat).not.toContain('var(--skin-orn'); // no botanical motif is mixed into leather
    expect(m.texture!.ornament).toBeNull();
  });

  it('every flat rule is gated on decorations being on and Extra readable being off, and beats the generic plate rule on specificity', () => {
    for (const line of flat.split('\n').filter(l => /--plate|background-image|border-color|skin-ring|skin-line/.test(l) && !l.includes('.mc-input') && !l.includes('.cdlg-amber'))) expect(line, line).toContain(ON); // the editor and the confirm button are not plates, and are readable in every mode
  });

  it('the confirm dialog\'s amber button is the selected fill (page ink on copper) in every mode, so the hard-coded wash under the copper link never decides its contrast', () => {
    expect(FLAT['smoked-copper']!.primary).toEqual(['.cdlg-amber']);
    expect(css).toContain(':root[data-material="smoked-copper"] .cdlg-amber { background: var(--control-primary-bg); color: var(--control-primary-text);');
    expect(css).toContain(':root[data-material="smoked-copper"] .cdlg-amber:hover { background: var(--control-primary-hover); color: var(--control-primary-text);');
    expect(contrastRatio(r.buttonText, r.buttonHover)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('the composer is a black leather bar with a clear field, the Home cards are navy, the chat list and header are the page colour', () => {
    expect(flat).toContain(`${ON} .composer-inner { --plate-bg: var(--composer-bg);`);
    expect(flat).toContain(`${ON} .composer-inner { --plate-tex: var(--skin-tex-composer);`);
    expect(flat).toContain(`${ON} .composer-textarea { background-color: transparent; box-shadow: none; }`);
    expect(flat).toContain(`${ON} .composer-textarea::placeholder { color: var(--composer-muted); }`);
    expect(skinVars(m)['--skin-tex-composer']).toBe('url("/skins/ember/ember-black-leather.webp")');
    expect(materialVars(r)['--composer-muted']).toBe(tokens.roles.composerPlaceholder);
    expect(flat).toContain(`${ON} :is(.home-card) { --plate-bg: var(--surface-user); --plate-tex: var(--skin-tex-user);`);
    expect(skinVars(m)['--skin-tex-user']).toBe('url("/skins/ember/ember-navy-leather.webp")');
    expect(materialVars(r)['--card-bg']).toBe(t.card);
    expect(materialVars(r)['--sidebar-bg']).toBe(t.page);
    expect(materialVars(r)['--surface-chrome']).toBe(t.page);
    expect(materialVars(r)['--composer-bg']).toBe(t.composer);
    expect(skinVars(m)['--skin-field-bg']).toBe(t.input);
  });

  it('the window frame has separate copper edge relief, no scene wash or walnut tile', () => {
    expect(flat).toContain(`${ON} .skin-ring-wash, ${ON} .skin-ring-tile { display: none; }`);
    expect(flat).toContain(`${ON} .skin-line { inset: 0; border-color: var(--skin-frame); box-shadow: var(--skin-frame-relief); }`);
    expect(skinVars(m)['--skin-frame']).toBe(t.rustDecorative);
    const room = block(':root[data-room="ember"]');
    expect(room).toContain('--skin-corner-tl: url("/skins/ember/ember-copper-corner.svg");');
    for (const w of ['tr', 'br', 'bl']) expect(room).toMatch(new RegExp(`--skin-corner-${w}: url\\("data:image/svg\\+xml,%3Csvg`));
  });

  it('only the flat material is flat; the five earlier materials keep their corners, textures and shadows', () => {
    expect(Object.keys(FLAT)).toEqual(['smoked-copper']);
    expect(MATERIAL_IDS.filter(id => MATERIALS[id].flat)).toEqual(['smoked-copper']);
    expect(css).not.toContain(':root[data-material="black-damask"][data-decor="on"]:not([data-readability="extra"]) :is(');
    expect(css).toContain('background-image: var(--skin-corner-tl, none)');
  });
});

describe('Ember with any room, and any material in the Ember room', () => {
  it('is allowed with every room: its pairs are independent of the scenery, because every plate is opaque', () => {
    for (const room of ROOM_IDS) expect(materialAllowedWithRoom(room, 'smoked-copper'), room).toBe(room !== 'hedgewitch' ? true : true);
    for (const room of ROOM_IDS.filter(id => id !== 'hedgewitch')) for (const mat of MATERIAL_IDS.filter(id => id !== 'hedgewitch')) {
      const d = parseDoc(serializeDoc(withMaterial(withRoom(defaultDoc(), room), mat)));
      expect([d.roomId, d.materialId]).toEqual([room, mat]);
      expect(showsDecorations(d)).toBe(true);
    }
  });

  it('the Hedgewitch parchment is still Hedgewitch-room only, so choosing Ember swaps it out', () => {
    expect(materialAllowedWithRoom('ember', 'hedgewitch')).toBe(false);
    expect(coerceMaterial('ember', 'hedgewitch')).toBe('smoked-copper');
    expect(withRoom(defaultDoc(), 'ember')).toMatchObject({ roomId: 'ember', materialId: 'smoked-copper' });
    expect(withRoomPreset(defaultDoc(), 'ember')).toMatchObject({ roomId: 'ember', materialId: 'smoked-copper' });
    expect(withMaterial(withRoomPreset(defaultDoc(), 'ember'), 'hedgewitch').materialId).toBe('smoked-copper');
  });

  it('the attributes the stylesheet keys off are the room and the material, decorations on', () => {
    expect(attributesFor(parseDoc({ version: 2, roomId: 'ember', materialId: 'smoked-copper' }))).toEqual({ 'data-room': 'ember', 'data-material': 'smoked-copper', 'data-readability': 'standard', 'data-decor': 'on', 'data-surface-decor': 'on' });
  });

  it('a stored document from before Ember still parses unchanged, and an unknown id still falls back', () => {
    const old = { version: 2, roomId: 'night', materialId: 'indigo-silk', readability: 'extra', decorations: false, customByMaterial: { 'indigo-silk': { '--text-primary': '#ffffff' } }, revision: 7 };
    expect(parseDoc(JSON.stringify(old))).toEqual(old);
    expect(parseDoc({ version: 2, roomId: 'ember', materialId: 'velvet' }).materialId).toBe('smoked-copper');
    expect(parseDoc({ version: 2, roomId: 'embers', materialId: 'smoked-copper' }).roomId).toBe('hedgewitch');
    expect(parseDoc({ version: 2, roomId: 'ember', materialId: 'smoked-copper', customByMaterial: { 'smoked-copper': { '--text-primary': '#ffffff', '--evil': 'red' } } }).customByMaterial).toEqual({ 'smoked-copper': { '--text-primary': '#ffffff' } });
  });
});

describe('only the Ember room\'s files are asked for when Ember is chosen', () => {
  it('the material block names Ember files only, the room rule names Ember files only, and no other room\'s rule names an Ember file', () => {
    const files = (s: string) => [...s.matchAll(/url\("(\/skins\/[^"]+)"\)/g)].map(u => u[1]);
    for (const f of files(block(':root[data-material="smoked-copper"]'))) expect(f).toMatch(/^\/skins\/ember\/ember-/);
    for (const f of files(block(':root[data-room="ember"]'))) expect(f).toMatch(/^\/skins\/ember\/ember-/);
    for (const id of ['salon', 'library', 'cloister', 'conservatory', 'night']) for (const f of files(block(`:root[data-room="${id}"]`))) expect(f).not.toContain('/ember/');
    expect(files(block(':root[data-room="ember"]'))).toContain('/skins/ember/ember-copper-corner.svg');
  });
});

describe('Ember leather under cards', () => {
  it('has no wrong-room wood layer, and card/chrome scale never depends on panel dimensions', () => {
    expect(m.flat!.woodgrain).toBeNull();
    expect(m.texture!.card.url).toBe('/skins/ember/ember-black-leather.webp');
    expect(skinVars(m)['--skin-tex-card-size']).toBe('576px 576px');
    expect(skinVars(m)['--skin-tex-chrome-size']).toBe('576px 576px');
    expect(skinVars(m)['--skin-tex-user-size']).toBe('576px 576px');
    expect(css.split('\n').filter(l => l.includes('smoked-copper')).join('\n')).not.toContain('/hedgewitch/wood.webp');
  });
});
