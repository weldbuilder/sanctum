/** Integration of the real appearance/boot attributes with generated CSS declarations.
 * This deliberately evaluates matching rules and inherited custom properties, rather
 * than accepting a selector's mere presence. It is not a browser/rendering substitute. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attributesFor, defaultDoc, parseDoc } from './appearance';
import { setVisibleDoc } from './apply';
import { buildSkinsCss } from './skins-css';
import type { AppearanceDoc } from './types';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const home = read('../components/HomeView.tsx');
const bubble = read('../components/MessageBubble.tsx');
const descendants = [...bubble.matchAll(/\.(?:message-edited|ie-cancel(?::hover)?|inline-edit-ta(?::focus)?) \{[^}]+\}/g)].map(m => m[0]).join('\n');
const chat = read('../components/ChatView.tsx');
const sidebarControls = [...chat.matchAll(/\.(?:thread-sidebar-header|thread-collapse-btn|thread-new-btn|thread-more-btn)(?::hover)? \{[^}]+\}/g)].map(m => m[0]).join('\n');
const footerRules = [...bubble.matchAll(/\.(?:ral-row|msg-action-row|msg-action-btn|ral-btn|bubble-ts) \{[^}]+\}/g)].map(m => m[0]).join('\n');
const css = postcss.parse(footerRules + descendants + sidebarControls + read('../theme-hedgewitch.css') + buildSkinsCss() + read('./skins.css')
  + home.match(/\.home-card::after \{[^}]+\}/)![0]);

// Supported selector subset: the exact root-attribute + class/:is selectors used by these layers.
// PostCSS supplies actual rule/declaration order. Matching handles :not and :is instead of
// assuming that every rule mentioning a texture is active for the emitted document.
function rootMatches(selector: string, attrs: Record<string, string>): boolean {
  const attribute = (s: string) => {
    const m = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(s)!;
    return m[2] === undefined ? m[1] in attrs : attrs[m[1]] === m[2];
  };
  let no = false;
  const positive = selector.replace(/:not\((\[[^\]]+\])\)/g, (_s, a) => { if (attribute(a)) no = true; return ''; });
  return !no && [...positive.matchAll(/\[[^\]]+\]/g)].every(m => attribute(m[0]));
}
function targetMatches(s: string, target: string): boolean {
  if (s.includes('>')) return false;
  if (s === ':focus-visible' && target.endsWith(':focus-visible')) return true;
  const state = target.match(/:focus-visible|:focus|:hover/)?.[0] ?? '';
  if (/:focus|:hover/.test(s) && (!state || !s.includes(state))) return false;
  s = s.replace(/:focus-visible|:focus|:hover/g, '');
  target = target.replace(/:focus-visible|:focus|:hover/g, '');
  const pseudo = s.match(/::[\w-]+/)?.[0] ?? '';
  if (pseudo !== (target.match(/::[\w-]+/)?.[0] ?? '')) return false;
  const classes = target.replace(pseudo, '').split('.').filter(Boolean);
  const alternatives = s.replace(pseudo, '').replace(/^:is\((.*)\)$/, '$1').split(',');
  return alternatives.some(a => {
    // an attribute in the rule (an ornament slot) must be in the target too
    if ([...a.matchAll(/\[[^\]]+\]/g)].some(m => !target.includes(m[0]))) return false;
    const required = [...a.matchAll(/\.([\w-]+)/g)];
    return required.length ? required.every(m => classes.includes(m[1])) : a.trim() === target;
  });
}
function declarations(attrs: Record<string, string>, target: string, width = 1440): Record<string, string> {
  const inherited: Record<string, [number, string]> = {}, local: Record<string, [number, string]> = {};
  css.walkRules(rule => {
    // Evaluate the actual generated mobile reductions without pretending to render glyphs.
    if (rule.parent?.type === 'atrule') {
      const a = rule.parent as postcss.AtRule;
      const max = a.params.match(/^\(max-width: (\d+)px\)$/);
      if (a.name !== 'media' || !max || width > Number(max[1])) return;
    }
    for (const selector of rule.selectors) {
      const m = /^(:root(?:(?:\[[^\]]+\])|(?::not\([^)]*\)))*)\s*(.*)$/.exec(selector);
      const root = m?.[1] ?? '', tail = m?.[2] ?? selector;
      if (root && !rootMatches(root, attrs)) continue;
      if (tail && !targetMatches(tail, target)) continue;
      const rootOnly = !!root && !tail;
      const store = rootOnly ? inherited : local;
      const specificity = (root ? 1 + [...root.matchAll(/\[/g)].length : 0) + Math.max(0, ...tail.replace(/^:is\((.*)\)$/, '$1').split(',').map(a => [...a.matchAll(/\.[\w-]+/g)].length));
      rule.walkDecls(d => {
        if (rootOnly && !d.prop.startsWith('--')) return;
        if (!store[d.prop] || specificity >= store[d.prop][0]) store[d.prop] = [specificity, d.value];
      });
    }
  });
  const parent = /^\.(?:thread-sidebar-header|thread-collapse-btn|thread-new-btn|thread-more-btn)/.test(target) ? '.thread-sidebar' : /^\.(?:message-edited|ie-cancel|inline-edit-ta)/.test(target) ? '.message.user' : target.startsWith('.thread-name-input') ? '.thread-sidebar' : target.startsWith('.composer-textarea') ? '.composer-inner' : target.startsWith('.mc-input') ? '.home-card' : null;
  // Inputs inherit remaps from their actual housing, not just root palette tokens.
  const parentVars = parent ? Object.fromEntries(Object.entries(declarations(attrs, parent, width)).filter(([k]) => k.startsWith('--'))) : {};
  const all = { ...Object.fromEntries(Object.entries(inherited).map(([k, v]) => [k, v[1]])), ...parentVars, ...Object.fromEntries(Object.entries(local).map(([k, v]) => [k, v[1]])) };
  const resolve = (v: string, depth = 0): string => {
    if (depth > 12) return v;
    const next = v.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_s, k, fallback) => resolve(all[k] ?? fallback ?? '', depth + 1));
    return next === v ? v : resolve(next, depth + 1); // resolve outer var after a nested fallback
  };
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, resolve(v)]));
}
function applied(doc: AppearanceDoc): Record<string, string> {
  const attrs: Record<string, string> = {};
  vi.stubGlobal('document', { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; }, style: { removeProperty() {}, setProperty() {} } } });
  setVisibleDoc(doc);
  return attrs;
}
function firstPaint(doc: AppearanceDoc): Record<string, string> {
  const attrs: Record<string, string> = {};
  const script = read('../../index.html').match(/<script>\s*([\s\S]*?)<\/script>/)![1];
  new Function('localStorage', 'document', script)({ getItem: () => JSON.stringify(doc) }, { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } });
  return attrs;
}
afterEach(() => vi.unstubAllGlobals());

describe('surface decoration and room frame eligibility', () => {
  it('the uncached implicit Hedgewitch default paints paper/plants before hydration but no frame/gutter', () => {
    expect(declarations({}, '.home-card')['background-image'] ?? '').toContain('/hedgewitch/hedgewitch-paper.webp');
    expect(declarations({}, '.home-card::after').display).toBe('block');
    expect(declarations({}, '.skin-frame').display).toBe('none');
    expect(declarations({}, '.app-shell')['--skin-gutter-x']).toBeUndefined();
  });
  for (const materialId of ['hedgewitch', 'smoked-copper'] as const) {
    const doc = parseDoc({ version: 2, roomId: 'hedgewitch', materialId, decorations: true });
    it(`${materialId} actually paints its substrate in the kitchen, before and after hydration, without frame/gutters`, () => {
      for (const attrs of [firstPaint(doc), applied(doc)]) {
        expect(attrs).toEqual(attributesFor(doc));
        const card = declarations(attrs, '.home-card');
        expect(card['background-image'] ?? '').toContain(materialId === 'hedgewitch' ? '/hedgewitch/hedgewitch-paper.webp' : '/skins/ember/ember-navy-leather.webp'); // Ember's Home cards are navy
        expect(card['background-color']).toMatch(/^#[0-9a-f]{6}$/i);
        if (materialId === 'smoked-copper') {
          expect(declarations(attrs, '.cmd-panel')['background-image'] ?? '').toContain('/skins/ember/ember-black-leather.webp');
          expect(card['background-origin']).toBe('border-box');
          expect(declarations(attrs, '.settings-content-inner')['background-image'] ?? '').toContain('/skins/ember/ember-black-leather.webp');
          expect(declarations(attrs, '.composer-inner')['background-image'] ?? '').toContain('/skins/ember/ember-black-leather.webp');
          expect(declarations(attrs, '.composer-textarea')['background-color']).toBe('transparent'); // the black bar is the field: no inset, never ivory
          expect(declarations(attrs, '.composer-textarea').color).toBe('#F1E8DA');
        }
        expect(declarations(attrs, '.home-card::after').display).toBe(materialId === 'hedgewitch' ? 'block' : 'none');
        expect(declarations(attrs, '.skin-frame').display).toBe('none');
        expect(declarations(attrs, '.app-shell')['--skin-gutter-x']).toBeUndefined();
      }
    });
    it(`${materialId} removes substrate/hardware/plants with decorations off or Extra readable, without adding a frame`, () => {
      for (const state of [{ decorations: false }, { readability: 'extra' as const }]) {
        const attrs = applied({ ...doc, ...state });
        expect(declarations(attrs, '.home-card')['background-image'] ?? '').not.toMatch(/hedgewitch-paper|-leather|ember-fitting/);
        expect(declarations(attrs, '.home-card::after').display).toBe('none');
        expect(declarations(attrs, '.skin-frame').display).toBe('none');
        expect(declarations(attrs, '.app-shell')['--skin-gutter-x']).toBeUndefined();
      }
    });
  }
  it('repeated room/material switches retain each material surface while only the room frame eligibility changes', () => {
    for (let repeat = 0; repeat < 2; repeat++) for (const roomId of ['ember', 'hedgewitch', 'night'] as const) {
      const attrs = applied(parseDoc({ version: 2, roomId, materialId: 'smoked-copper', decorations: true }));
      const card = declarations(attrs, '.home-card');
      expect(card['background-image'] ?? '').toContain('/skins/ember/ember-navy-leather.webp');
      expect(card['background-image'] ?? '').toContain('/skins/ember/ember-fitting-tl.webp');
      expect(declarations(attrs, '.skin-frame').display).toBe('none'); // the outer frame is off by default on every width
      expect(declarations({ ...attrs, 'data-outer-frame': 'on' }, '.skin-frame').display).toBe(roomId === 'hedgewitch' ? 'none' : 'block'); // with it on, the room decides
    }
    const attrs = applied(defaultDoc());
    expect(declarations(attrs, '.home-card')['background-image'] ?? '').toContain('/hedgewitch/hedgewitch-paper.webp');
    expect(declarations(attrs, '.home-card::after').display).toBe('block');
  });
});

// The old room-frame gate must not hide material layers in the unframed kitchen.
import { CLEAR_COMPOSER_FIELD, MATERIALS, textureComposites } from './materials';
import { contrastRatio } from './contrast';
import { ROOM_IDS } from './types';
const restored = ['mounted-paper', 'black-damask', 'botanical-linen', 'indigo-silk', 'midnight-ink'] as const;
describe('restored materials across every room', () => {
  for (const materialId of restored) {
    it(`${materialId}: boot/runtime retain substrate, fittings, bounded motif and input in all seven rooms`, { timeout: 30_000 }, () => {
      const m = MATERIALS[materialId];
      for (const roomId of ROOM_IDS) {
        const doc = parseDoc({ version: 2, roomId, materialId, decorations: true });
        for (const attrs of [firstPaint(doc), applied(doc)]) {
          expect(attrs).toEqual(attributesFor(doc));
          for (const target of ['.home-card', '.message.companion', '.message.user', '.thread-sidebar', '.composer-inner']) {
            const d = declarations(attrs, target);
            // the "You" plate and the material's accent plates (Moonlit Cloister's Home cards) wear the user substrate
            const accent = m.accents.includes(target) && m.accentSubstrate === 'companion' ? m.texture!.companion : undefined;
            const layer = accent ?? (target === '.message.user' || m.accents.includes(target) ? m.texture!.user ?? m.texture!.card : target === '.message.companion' && m.texture!.companion ? m.texture!.companion : materialId === 'mounted-paper' && ['.thread-sidebar', '.composer-inner'].includes(target) ? m.texture!.chrome : m.texture!.card);
            expect(d['background-image'], `${materialId}/${roomId}/${target}`).toContain(layer.url);
            expect(d['background-image']).toContain(m.texture!.relief!.corners.tl);
            expect(d['background-origin']).toBe('border-box');
          }
          for (const field of ['.composer-textarea', '.mc-input', '.thread-name-input']) {
            const d = declarations(attrs, field);
            // a one-surface chat bar (the Library's wood): the field is clear on the bar, in the chrome's ink
            const clear = field === '.composer-textarea' && CLEAR_COMPOSER_FIELD.has(materialId);
            expect(d['background-color'] ?? d.background, `${materialId}/${roomId}/${field}`).toBe(clear ? 'transparent' : m.roles!.input);
            expect(d.color).toBe(clear ? m.roles!.chromeText : m.roles!.inputText);
            if (field !== '.composer-textarea') expect(d.border).toContain(m.roles!.controlBorder);
            expect(d['--control-border']).toBe(m.roles!.controlBorder);
            expect(d['caret-color']).toBe(clear ? m.roles!.chromeText : m.roles!.inputText);
            expect(declarations(attrs, field + '::placeholder').color).toBe(clear ? m.roles!.chromeMuted : m.roles!.placeholder);
            if (clear) expect(declarations(attrs, '.composer-inner')['background-image']).toContain(m.texture!.chrome.url);
            if (field !== '.composer-textarea') {
              expect(declarations(attrs, field + ':focus').outline).toContain(m.roles!.focus);
              expect(declarations(attrs, field + ':focus-visible').outline).toContain(m.roles!.focus);
              expect(declarations(attrs, field).color).toBe(m.roles!.inputText); // blur retains same pair
            }
          }
          const user = declarations(attrs, '.message.user');
          if (materialId === 'black-damask') expect(user['background-image']).not.toMatch(/damask-cloth|texture-v1/);
          expect(declarations(attrs, '.skin-frame').display).toBe('none'); // the outer frame is off by default on every width
      expect(declarations({ ...attrs, 'data-outer-frame': 'on' }, '.skin-frame').display).toBe(roomId === 'hedgewitch' ? 'none' : 'block'); // with it on, the room decides
          if (roomId === 'hedgewitch') expect(declarations(attrs, '.app-shell')['--skin-gutter-x']).toBeUndefined();
        }
      }
    });
    it(`${materialId}: fixed substrate scale and edge-local art remain bounded at 320/390/1440 CSS px`, () => {
      const attrs = applied(parseDoc({ version: 2, roomId: 'hedgewitch', materialId }));
      const t = MATERIALS[materialId].texture!;
      for (const width of [320, 390, 1440]) {
        const d = declarations(attrs, '.message.companion', width);
        expect(d['--plate-corner']).toBe(`${width <= 768 ? t.relief!.cornerMobilePx : t.relief!.cornerPx}px`);
        expect(d['--plate-tex-size']).toBe(`${t.card.tilePx}px ${t.card.tilePx}px`);
        expect(d['--plate-orn-size']).toBe(t.ornament ? `${width <= 768 ? t.ornament.mobileSizePx : t.ornament.sizePx}px` : '0px');
        expect(d['background-repeat']).toContain('no-repeat');
        expect(d.padding).toBeUndefined(); // no blanket padding reset; only the ornament side can reserve local space
      }
    });
    it(`${materialId}: decorations off/Extra readable remove all artwork without changing input pair`, () => {
      for (const roomId of ROOM_IDS) for (const state of [{ decorations: false }, { readability: 'extra' as const }]) {
        const attrs = applied(parseDoc({ version: 2, roomId, materialId, ...state }));
        expect(declarations(attrs, '.home-card')['background-image'] ?? '').not.toMatch(/webp|fitting|sprig|crescent/);
        for (const field of ['.composer-textarea', '.mc-input', '.thread-name-input']) {
          const d = declarations(attrs, field);
          expect(d['background-color'] ?? d.background).toBe(MATERIALS[materialId].roles!.input);
          expect(d.color).toBe(MATERIALS[materialId].roles!.inputText);
        }
      }
    });
  }
});


describe('reviewed motif clearance and Library user descendants', () => {
  // message-edited has live JSX. ie-cancel / inline-edit-ta are dormant stylesheet
  // selectors only: these checks do not verify a mounted/runtime message editor.
  it('Library live edited label plus dormant Cancel/inline-edit CSS contracts keep their distinct ink/surface pairs', () => {
    const m = MATERIALS['mounted-paper'];
    for (const roomId of ROOM_IDS) for (const state of [{}, { decorations: false }, { readability: 'extra' as const }]) {
      const attrs = applied(parseDoc({ version: 2, roomId, materialId: 'mounted-paper', ...state }));
      for (const target of ['.message-edited', '.ie-cancel', '.ie-cancel:hover']) {
        const d = declarations(attrs, target);
        expect(d.color, target).toBe(m.roles!.userText);
        for (const bg of textureComposites(m.roles!.user, m.texture!.card)) expect(contrastRatio(d.color, bg), target + ' on ' + bg).toBeGreaterThanOrEqual(4.6);
      }
      const editor = declarations(attrs, '.inline-edit-ta');
      expect(editor.background).toBe(m.roles!.code);
      expect(editor.color).toBe(m.roles!.text);
    }
  });
  it('Ember live edited label plus dormant Cancel/inline-edit CSS contracts retain their existing distinct pairs', () => {
    const m = MATERIALS['smoked-copper'];
    for (const roomId of ROOM_IDS) for (const state of [{}, { decorations: false }, { readability: 'extra' as const }]) {
      const attrs = applied(parseDoc({ version: 2, roomId, materialId: 'smoked-copper', ...state }));
      for (const target of ['.message-edited', '.ie-cancel', '.ie-cancel:hover']) {
        const d = declarations(attrs, target);
        expect(d.color, target).toBe(m.roles!.userText);
        for (const bg of textureComposites(m.roles!.user, m.texture!.card)) expect(contrastRatio(d.color, bg)).toBeGreaterThanOrEqual(4.6);
      }
      expect(declarations(attrs, '.inline-edit-ta').background).toBe(m.roles!.code);
      expect(declarations(attrs, '.inline-edit-ta').color).toBe(m.roles!.text);
    }
  });
  for (const materialId of ['botanical-linen', 'indigo-silk', 'midnight-ink'] as const) {
    // walks every generated rule (24 ornament slots per plate) for 3 widths x every room: seconds, more on a Windows runner
    it(`${materialId} reserves the full recognizable motif footprint outside long text, metadata/edit controls, sidebar controls and focus at 320/390/1440`, { timeout: 30_000 }, () => {
      const o = MATERIALS[materialId].texture!.ornament!;
      const ownSide = o.position!.startsWith('0 ') ? 'left' : 'right';
      // painted variants put some plates' art (and their clearance) on the right
      const sideOf = (target: string) => o.variants?.rightPlates.includes(target) ? 'right' : ownSide;
      for (const width of [320, 390, 1440]) for (const roomId of ROOM_IDS) {
        const attrs = applied(parseDoc({ version: 2, roomId, materialId }));
        const size = width <= 768 ? o.mobileSizePx! : o.sizePx;
        for (const target of ['.home-card', '.message.companion', '.message.user', '.thread-sidebar']) {
          const d = declarations(attrs, target, width);
          expect(d['--material-orn-clearance']).toBe(`${size}px`);
          // A phone's Home cards and the chat list reserve the motif below their content (keeping the full width for text);
          // everything else beside it.
          if ((target === '.home-card' && width <= 768) || target === '.thread-sidebar') expect(d['padding-bottom'], target).toContain(`${size}px`);
          else expect(d[`padding-${sideOf(target)}`], target).toContain(`${size}px`);
          expect(d['background-size']).toContain(`auto min(${size}px, calc(100% - 8px))`); // never taller than the plate
          expect(d.overflow).not.toBe('clip');
          expect(d['font-size']).toBeUndefined();
        }
        for (const control of ['.thread-collapse-btn', '.thread-new-btn', '.thread-more-btn']) {
          const focused = declarations(attrs, control + ':focus-visible', width);
          expect(focused.outline, control).toContain(MATERIALS[materialId].roles!.focus);
          expect(focused['pointer-events']).not.toBe('none');
          expect(focused.width).toMatch(/rem$/);
        }
        expect(declarations(attrs, '.thread-sidebar', width)['padding-bottom']).toContain('8px'); // more than the 2/3px keyboard focus stroke
        expect(declarations(attrs, '.message.companion', width)['overflow-wrap']).toBe('anywhere');
        expect(declarations(attrs, '.message-header', width)['flex-wrap']).toBe('wrap');
        expect(declarations(attrs, '.message-role', width)['max-width']).toBe('100%');
        for (const state of [{ decorations: false }, { readability: 'extra' as const }]) {
          const off = applied(parseDoc({ version: 2, roomId, materialId, ...state }));
          for (const target of ['.home-card', '.message.companion', '.message.user']) expect(declarations(off, target, width)[`padding-${sideOf(target)}`] ?? '').not.toContain(`${size}px`);
          expect(declarations(off, '.thread-sidebar', width)['padding-bottom'] ?? '').not.toContain(`${size}px`);
        }
      }
    });
  }
});


describe('ornament-clearance responsive message footer contract', () => {
  it('uses the real six-action companion footer, read-aloud control and date/time DOM without dropping controls', () => {
    const actions = bubble.slice(bubble.indexOf('function MessageActionRow'), bubble.indexOf('function formatTime'));
    expect(actions.match(/<button\b/g)).toHaveLength(6);
    for (const label of ['Reply', 'Add reaction', 'Copy message', 'Save to canvas', 'Regenerate response', 'Delete message']) expect(actions).toContain(`aria-label="${label}"`);
    const footer = bubble.slice(bubble.indexOf('<div className="ral-row">'), bubble.indexOf('<style>{`', bubble.indexOf('<div className="ral-row">')));
    expect(footer).toContain('<MessageActionRow');
    expect(footer).toContain('<ReadAloudButton');
    expect(footer).toContain('className="bubble-ts"');
  });
  for (const materialId of ['botanical-linen', 'indigo-silk', 'midnight-ink'] as const) {
    it(`${materialId} allows footer/actions/date to wrap within reduced width, retaining control size/focus and original off/Extra behavior`, () => {
      for (const roomId of ROOM_IDS) for (const width of [320, 390, 1440]) {
        const attrs = applied(parseDoc({ version: 2, roomId, materialId }));
        for (const row of ['.ral-row', '.msg-action-row']) {
          const d = declarations(attrs, row, width);
          expect(d.display).toBe('flex');
          expect(d['flex-wrap']).toBe('wrap');
          expect(d['min-width']).toBe('0');
          expect(d['max-width']).toBe('100%');
          expect(d.overflow).not.toBe('hidden');
        }
        expect(declarations(attrs, '.msg-action-row', width).flex).toBe('1 1 auto');
        const date = declarations(attrs, '.bubble-ts', width);
        expect(date['white-space']).toBe('normal');
        expect(date['overflow-wrap']).toBe('anywhere');
        expect(date['max-width']).toBe('100%');
        expect(date['min-width']).toBe('0');
        for (const control of ['.msg-action-btn', '.ral-btn']) {
          const d = declarations(attrs, control + ':focus-visible', width);
          expect(d.width).toBe('1.5rem');
          expect(d.height).toBe('1.5rem');
          expect(d['flex-shrink']).toBe('0');
          expect(d.outline).toContain(MATERIALS[materialId].roles!.focus);
          expect(d.display).toBe('inline-flex');
        }
        for (const state of [{ decorations: false }, { readability: 'extra' as const }]) {
          const off = applied(parseDoc({ version: 2, roomId, materialId, ...state }));
          for (const row of ['.ral-row', '.msg-action-row']) expect(declarations(off, row, width)['flex-wrap'] ?? 'nowrap').toBe('nowrap');
          expect(declarations(off, '.msg-action-row', width).flex).toBe('1');
          expect(declarations(off, '.bubble-ts', width)['white-space']).toBe('nowrap');
        }
      }
    });
  }
});
