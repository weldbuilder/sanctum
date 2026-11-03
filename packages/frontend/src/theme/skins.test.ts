import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from './asset-manifest.json';
import { buildSkinsCss } from './skins-css';
import { ROOM_LIST, allRegistryPaths } from './rooms';
import { materialAssetPaths } from './materials';
import { contrastRatio, mix, TEXT_MIN } from './contrast';

const FRONTEND = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('artwork files', () => {
  it('every file under public/skins matches the manifest SHA-256 and size, and nothing extra is shipped', () => {
    const onDisk = walk(join(FRONTEND, 'public/skins')).map(p => 'public/' + p.slice(join(FRONTEND, 'public/').length).split('\\').join('/')).sort();
    const listed = manifest.files.map(f => f.path).sort();
    expect(onDisk).toEqual(listed);
    for (const f of manifest.files) {
      const buf = readFileSync(join(FRONTEND, f.path));
      expect(buf.length, `${f.path} size`).toBe(f.bytes);
      expect(createHash('sha256').update(buf).digest('hex'), `${f.path} sha256`).toBe(f.sha256);
    }
  });

  it('ships only what the app references: every manifest file is a scene, thumbnail, corner SVG or material tile the registry or generator points at', () => {
    const OPTIONAL: string[] = ['/skins/cloister/edge-ornament-v1.svg', '/skins/conservatory/edge-ornament-v1.svg', // the pack's leaf etching: the input scripts/gen-skin-textures.ts redraws as leaf-v1.svg
      '/skins/ember/ember-edge-sprig.svg', '/skins/ember/ember-charcoal-tile.svg', '/skins/ember/ember-walnut-tile.svg',
      '/skins/ember/ember-parchment-tile.svg']; // Ember's optional pack art: the sprig is not drawn, and opaque ivory paper is not the approved dark input surface.
    const referenced = new Set<string>([...allRegistryPaths(), ...materialAssetPaths(), ...ROOM_LIST.filter(r => !r.legacy).map(r => r.tile!)]);
    const css = buildSkinsCss();
    for (const path of referenced) if (path.endsWith('.svg') && /tile|texture|leather|edge-ornament/.test(path)) expect(css, path).toContain(path);
    const listed = manifest.files.map(f => '/' + f.path.replace(/^public\//, ''));
    expect(listed.filter(p => !referenced.has(p) && !OPTIONAL.includes(p))).toEqual([]);
    expect([...referenced].filter(p => !listed.includes(p))).toEqual([]);
    // and the manifest's own room entries name nothing that is not shipped
    for (const room of Object.values(manifest.rooms)) for (const p of Object.values(room.assets as Record<string, string>)) expect(listed, p).toContain(p);
  });

  it('does not ship the previews, mockups, source notes or gallery', () => {
    for (const bad of ['previews', 'reference-mockups', 'source-notes', 'gallery.html']) {
      expect(existsSync(join(FRONTEND, 'public', bad))).toBe(false);
      expect(existsSync(join(FRONTEND, 'public/skins', bad))).toBe(false);
    }
  });

  it('stays within the designer budgets: WebP scenes 500KB / 250KB, thumbnails 30KB', () => {
    const size = (p: string) => statSync(join(FRONTEND, 'public', p)).size;
    for (const r of ROOM_LIST.filter(r => !r.legacy)) {
      expect(size(r.landscape.webp!)).toBeLessThan(500_000);
      expect(size(r.portrait.webp!)).toBeLessThan(250_000);
      expect(size(r.thumbnail!)).toBeLessThan(30_000);
    }
  });
});

describe('Ember artwork', () => {
  // The pack's own assets-manifest.json: path -> [bytes, sha256]. The repo manifest must carry exactly these, and the files must match.
  // Its scenes (a bare walnut plank) were retired for the study below; the pack's SVGs ship unchanged.
  const PACK: Record<string, [number, string]> = {
    'ember-copper-corner.svg': [167, '611836cc68a243912033131699da0384af6afb61b906d37a6ff33867aa5e97c5'],
    'ember-edge-sprig.svg': [955, '289951d0031bfb29b3bd01b04200fda8e45fdbdb5ba1fd49439c0ca9eec8dcef'],
    'ember-charcoal-tile.svg': [400, 'a6ec3cb0da233e389d3a002bce7c30a498582c74337265ffe0d1b63f8ca9859b'],
    'ember-parchment-tile.svg': [400, '47acea20ffd80570140b50bb829098880f2811cf56d27b62c98896f279e82fd2'],
    'ember-walnut-tile.svg': [400, 'd26c599c1436ac23b1fcef027cdcf633c6b59b1762397e77780af98dd99ecc00'],
  };
  // The approved scene: the lamp-lit study with the city window. New names (-v2), because the service worker keeps /skins/ files by name.
  const STUDY = ['ember-study-desktop-v2.webp', 'ember-study-desktop-v2.jpg', 'ember-study-mobile-v2.webp', 'ember-study-mobile-v2.jpg', 'ember-study-thumbnail-v2.webp'];
  const entry = (name: string) => manifest.files.find(f => f.path === `public/skins/ember/${name}`);

  it('carries the pack\'s bytes and SHA-256 for every file it came with, under one naming set (no ember-walnut-* aliases), plus the study scenes and their thumbnail', () => {
    for (const [name, [bytes, sha]] of Object.entries(PACK)) {
      expect(entry(name), name).toMatchObject({ bytes, sha256: sha });
      const buf = readFileSync(join(FRONTEND, 'public/skins/ember', name));
      expect(buf.length, name).toBe(bytes);
      expect(createHash('sha256').update(buf).digest('hex'), name).toBe(sha);
    }
    const names = readdirSync(join(FRONTEND, 'public/skins/ember')).sort();
    expect(names).toEqual([...Object.keys(PACK), ...STUDY, 'ember-black-leather.webp', 'ember-navy-leather.webp', ...['tl', 'tr', 'br', 'bl'].map(c => `ember-fitting-${c}.webp`)].sort());
    expect(names.filter(n => /walnut-(desktop|mobile)|^ember-(desktop|mobile|thumbnail)\./.test(n))).toEqual([]); // neither the walnut aliases nor the retired plank
  });

  it('the scenes are the sizes the pack states and a separate portrait composition, inside the budgets (desktop 500KB, mobile 250KB, thumbnail 30KB)', () => {
    const dims = (name: string): [number, number] => {
      const b = readFileSync(join(FRONTEND, 'public/skins/ember', name));
      if (name.endsWith('.webp')) return [(b.readUInt16LE(26) & 0x3fff), (b.readUInt16LE(28) & 0x3fff)]; // a lossy (VP8) frame header
      let i = 2; // JPEG: walk the markers to the first SOF
      while (i < b.length) { const m = b[i + 1]; const len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + len; }
      throw new Error('no SOF');
    };
    expect(dims('ember-study-desktop-v2.webp')).toEqual([1536, 1024]);
    expect(dims('ember-study-desktop-v2.jpg')).toEqual([1536, 1024]);
    expect(dims('ember-study-mobile-v2.webp')).toEqual([1024, 1536]);
    expect(dims('ember-study-mobile-v2.jpg')).toEqual([1024, 1536]);
    expect(dims('ember-study-thumbnail-v2.webp')).toEqual([360, 240]);
    expect(entry('ember-study-desktop-v2.webp')!.bytes).toBeLessThanOrEqual(500_000);
    expect(entry('ember-study-desktop-v2.jpg')!.bytes).toBeLessThanOrEqual(500_000);
    expect(entry('ember-study-mobile-v2.webp')!.bytes).toBeLessThanOrEqual(250_000);
    expect(entry('ember-study-mobile-v2.jpg')!.bytes).toBeLessThanOrEqual(250_000);
    expect(entry('ember-study-thumbnail-v2.webp')!.bytes).toBeLessThanOrEqual(30_000);
    expect(entry('ember-study-desktop-v2.webp')!.sha256).not.toBe(entry('ember-study-mobile-v2.webp')!.sha256);
  });

  it('the shipped SVGs are self-contained: no script, no external reference, no embedded image, no font', () => {
    for (const name of Object.keys(PACK).filter(n => n.endsWith('.svg'))) {
      expect(readFileSync(join(FRONTEND, 'public/skins/ember', name), 'utf8'), name).not.toMatch(/<script|href=|url\(http|@import|javascript:|<image|font-family/i);
    }
  });

  it('the orb is not shipped (the Mantel home layout is not part of the skin)', () => {
    expect(manifest.files.filter(f => /orb/i.test(f.path))).toEqual([]);
  });
});

describe('generated stylesheet', () => {
  it('a plate drawn in the chrome re-points the popover backgrounds with the ink, so a menu opened inside it is never light on light', () => {
    const css = buildSkinsCss();
    const rules = css.split('\n').filter(l => l.includes('--text-secondary: var(--surface-chrome-text)'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).toContain('--bg-secondary: var(--surface-chrome-deep)');
      expect(rule).toContain('--bg-surface: var(--surface-chrome-deep)');
      expect(rule).toContain('--surface-popover: var(--surface-chrome-deep)');
      expect(rule).toContain('--surface-popover-text: var(--surface-chrome-text)');
      expect(rule).toContain('--status-error-text: var(--status-error-chrome)');
      expect(rule).toContain('--surface-input: var(--surface-chrome-deep)');
    }
  });

  const css = buildSkinsCss();

  it('is up to date (run: npm run gen:skins -w @sanctum/frontend)', () => {
    const committed = readFileSync(join(FRONTEND, 'src/theme/skins.generated.css'), 'utf8');
    expect(committed).toBe(css);
  });

  it('points each scene at its manifest file, covers it, and never lists a scene outside a room rule', () => {
    for (const r of ROOM_LIST.filter(r => !r.legacy)) {
      expect(css).toContain(`url("${r.landscape.jpeg}")`);
      expect(css).toContain(`type("image/webp")`);
      expect(css).toContain(`url("${r.portrait.webp}") type("image/webp")`);
      expect(css).toContain(`--skin-room-fallback: ${r.fallback};`);
    }
    // portrait only inside the shell breakpoint media query
    const mediaStart = css.indexOf('@media (max-width: 768px)');
    expect(mediaStart).toBeGreaterThan(0);
    expect(css.slice(0, mediaStart)).not.toMatch(/mobile-v1|ember-study-mobile/);
    expect(css.slice(mediaStart)).toContain('mobile-v1');
    expect(css.slice(mediaStart)).toContain('ember-study-mobile-v2');
    // Ember's study is centred on both orientations (its portrait is its own crop); the rest keep their centre / top
    const ember = css.split(':root[data-room="ember"] {').filter(p => p.split('}')[0].includes('--skin-room-position'));
    expect(ember).toHaveLength(2); // landscape rule, then the one inside the media query
    for (const p of ember) expect(p.split('}')[0]).toContain('--skin-room-position: 50% 50%;');
    // The room rules every room shares. Changed on purpose: the painting is shown whole (zoomed out to fit, contain) over the
    // same painting covering, blurred, behind it, instead of covering and cropping; both no-repeat, at the room's own position.
    const body = readFileSync(join(FRONTEND, 'src/theme/skins.css'), 'utf8').split('/* ── focus')[0];
    expect(body).toMatch(/body::after \{[^}]*background-size: cover;/); // changed on purpose: the room is full-bleed on desktop too (was contain)
    expect(body).not.toMatch(/background-size: contain/);
    expect(body).toMatch(/@media \(max-width: 768px\) \{\s*body::after \{ background-size: cover; \}/); // a phone fills its screen
    expect(body).toMatch(/body::before \{[^}]*background-size: cover;[^}]*filter: blur\(/);
    expect(body).toContain('background-repeat: no-repeat;');
    expect(body).toContain('background-position: var(--skin-room-position, 50% 50%);');
  });

  it('has no preload and no stretching (a size of 100% 100% would stretch art; a corner is only ever positioned there)', () => {
    expect(css).not.toMatch(/preload/i);
    expect(css).not.toMatch(/background-size:[^;]*100% 100%/);
    expect(css).not.toMatch(/\/\s*100% 100%/);
  });
});

describe('stylesheet rules for Extra readable and the frame', () => {
  const skins = readFileSync(join(FRONTEND, 'src/theme/skins.css'), 'utf8');
  const settings = readFileSync(join(FRONTEND, 'src/components/SettingsView.tsx'), 'utf8');

  it('Extra readable removes the settings sub-nav blur (the component reads a variable that Extra sets to none)', () => {
    expect(settings).toContain('backdrop-filter: var(--settings-subnav-blur, blur(18px) saturate(1.15));');
    expect(settings).not.toMatch(/backdrop-filter: blur\(18px\)/);
    expect(skins).toMatch(/:root\[data-readability="extra"\] \{[^}]*--settings-subnav-blur: none;/);
  });

  it('Extra readable gives the composer (focus-within) the same 3px ring as every focused control', () => {
    expect(skins).toContain(':root[data-readability="extra"] :focus-visible { outline-width: 3px; }');
    expect(skins).toContain(':root[data-readability="extra"] .composer-inner:focus-within { outline-width: 3px; }');
  });

  it('drops the outer app-shell frame on every width, phone included (insets 0, frame hidden, shell edge to edge) unless data-outer-frame="on"', () => {
    // top level, outside any media query, so it holds at phone widths and for Ember too
    const topLevel = skins.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    expect(topLevel).toContain(':root[data-decor="on"]:not([data-outer-frame="on"]) .skin-frame { display: none; }');
    expect(topLevel).toContain(':root[data-decor="on"]:not([data-outer-frame="on"]) .app-shell { padding: 0; }');
    expect(topLevel).toMatch(/--skin-inset-x: 0px;[^}]*--skin-inset-top: 0px;[^}]*--skin-inset-bottom: 0px;/);
    expect(skins).toContain(':root[data-decor="on"][data-outer-frame="on"] .mobile-topbar { padding-top: 0.5rem; }');
    expect(skins).toContain('max(var(--skin-gutter-y), env(safe-area-inset-top, 0px))'); // the framed shell padding stays
  });

  it('sets a desktop frame into the room, except Ember, whose full-window frame instead holds the rail set into it', () => {
    const desktop = skins.split('@media (min-width: 769px) {').slice(1).map(b => b.split('\n}\n')[0]).join('\n');
    expect(desktop).toContain(':root[data-decor="on"]:not([data-room="ember"]) .skin-frame {');
    expect(desktop).toContain('inset: var(--skin-inset-top) var(--skin-inset-x) var(--skin-inset-bottom);');
    expect(desktop).not.toMatch(/:root\[data-decor="on"\] \.skin-frame/); // never every room
    expect(desktop).toContain(':root[data-decor="on"][data-room="ember"] .app-shell { padding: 3px; }');
    expect(desktop).toContain(':root[data-decor="on"][data-room="ember"] .app-content { padding: 21px 21px 21px 0; }');
  });

  it('keeps the 24px corner reserve on mobile: the only narrower gutter is below 360px, where the corners are dropped', () => {
    expect(skins).toContain('--skin-gutter-x: 24px;');
    const narrow = [...skins.matchAll(/@media \(max-width: (\d+)px\)[^{]*\{[^}]*--skin-gutter-x: (\d+)px/g)];
    expect(narrow.map(m => [m[1], m[2]])).toEqual([['359', '8']]);
    expect(skins).toMatch(/@media \(max-width: 359px\) \{[\s\S]*?\.skin-corner \{ display: none; \}/);
  });
});

describe('classic Hedgewitch text that measured under 4.5:1', () => {
  const css = readFileSync(join(FRONTEND, 'src/theme-hedgewitch.css'), 'utf8');
  const v = (name: string) => css.match(new RegExp(`${name}: (#[0-9a-fA-F]{6});`))![1];
  // the translucent bubbles (0.86) over the darkest part of the kitchen, the worst case measured on screen
  const scene = '#101a0e';

  it('the user-bubble timestamp reads 4.5:1 on its bubble even over the darkest scene', () => {
    expect(contrastRatio(v('--surface-user-meta'), mix('#dcd5ee', scene, 0.14))).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('companion links, the confirm button and the empty home line read a darker ink from the palette', () => {
    expect(css).toContain('.message.companion .prose a');
    expect(contrastRatio(v('--amber-bright'), mix('#faf4e4', scene, 0.14))).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(v('--amber-bright'), mix('#efe4cc', '#c9a87c', 0.12))).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(v('--text-secondary'), '#e6d9bd')).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(css).toMatch(/\.cdlg-amber[^{]*\{ color: var\(--amber-bright\); \}/);
    expect(css).toMatch(/\.home-empty[^{]*\{ color: var\(--text-secondary\); \}/);
  });
});


describe('approved material decor, independent of scenery', () => {
  const css = buildSkinsCss();
  const home = readFileSync(join(FRONTEND, 'src/components/HomeView.tsx'), 'utf8');
  const hedge = readFileSync(join(FRONTEND, 'src/theme-hedgewitch.css'), 'utf8');
  const emberOn = ':root[data-material="smoked-copper"][data-surface-decor="on"]:not([data-readability="extra"])';
  const hedgeOn = ':root[data-material="hedgewitch"][data-surface-decor="on"]:not([data-readability="extra"])';

  it('uses the selected copper fittings rather than room corners on Ember surfaces and the window frame', () => {
    expect(css).toContain(`${emberOn} { --skin-corner-tl: var(--skin-fitting-tl);`);
    expect(css).toContain('--skin-fitting-tl: url("/skins/ember/ember-fitting-tl.webp")');
    expect(css).toContain('--skin-plate-relief:');
    expect(css).toContain('--skin-frame-relief:');
    expect(css).toContain('--skin-corner-size: 32px;');
    expect(css).toContain(`${emberOn} .home-card::after { display: none; }`);
    // the bracket cut from the plate art: transparent where the leather shows, so it sits on either leather
    const fitting = readFileSync(join(FRONTEND, 'public/skins/ember/ember-fitting-tl.webp'));
    expect(fitting.subarray(0, 4).toString()).toBe('RIFF');
    expect(fitting.subarray(8, 12).toString()).toBe('WEBP');

  });

  it('leaves Home DOM and sizing alone; material-gated botanicals never become global plants', () => {
    expect(home).toContain('background-image: var(--home-sprig-lavender, none)');
    expect(home).not.toMatch(/background-image: url\(\/hedgewitch\/sprig-/);
    expect(home).toContain('pointer-events: none;');
    expect(home).toContain('min-width: 0;');
    expect(css).toContain(`${hedgeOn} { --home-sprig-display: block; }`);
    expect(hedge).toContain('--home-sprig-lavender: url(/hedgewitch/sprig-lavender.webp)');
  });

  it('gates new grain, fittings, paper and plants on decorations and standard readability', () => {
    const lines = css.split('\n').filter(l => l.includes('{') && /--paper-bg:|skin-plate-relief\)|home-sprig-display: block|--skin-corner-tl: var/.test(l));
    expect(lines.length).toBeGreaterThan(6);
    for (const line of lines) expect(line).toMatch(/(?:\[data-surface-decor="on"\]|:not\(\[data-surface-decor\]\)):not\(\[data-readability="extra"\]\)/);
    expect(hedge).toContain('--home-sprig-display: none;');
    expect(hedge).toContain('--surface-companion: #faf4e4;');
    expect(hedge).toContain('--surface-user: #CFABAC;');
  });
});

describe('Hedgewitch desktop rail wears its solid wood, like its phone drawer', () => {
  const skins = readFileSync(join(FRONTEND, 'src/theme/skins.css'), 'utf8');
  const hedge = readFileSync(join(FRONTEND, 'src/theme-hedgewitch.css'), 'utf8');
  const wood = (name: string) => hedge.match(new RegExp(`${name}: ([^;]+);`))![1];

  it('the rail rule paints the same wood the drawer paints, in the desktop block, and only for Hedgewitch', () => {
    const rule = skins.match(/:root\[data-material="hedgewitch"\] \.nav-rail \{([^}]*)\}/);
    expect(rule, 'a Hedgewitch-only .nav-rail rule').not.toBeNull();
    expect(rule![1]).toContain('background: var(--chrome-rail-bg) !important');
    // the drawer paints --chrome-bar-bg; the rail's wood must be that same surface
    expect(wood('--chrome-rail-bg')).toBe(wood('--chrome-bar-bg'));
    expect(wood('--chrome-rail-bg')).toContain('url(/hedgewitch/wood.webp)');
    expect(skins.indexOf(rule![0])).toBeGreaterThan(skins.indexOf('@media (min-width: 769px)'));
    // it sits after the generic translucent fill so it wins, and no other skin is named
    expect(skins.indexOf(rule![0])).toBeGreaterThan(skins.indexOf(':root .nav-rail {'));
    expect(skins.match(/data-material="[a-z-]+"\] \.nav-rail \{/g)).toEqual(['data-material="hedgewitch"] .nav-rail {']);
    expect(skins).toMatch(/:root \.nav-rail \{[^}]*background-image: none !important/);
  });

  it('the rail ink reads 4.6:1 on the wood\u2019s lightest pixel under the lightest end of its veil', () => {
    // wood.webp's lightest pixel (#B88266), under the veil's lighter end (rgba(40,24,14,.35))
    const lightest = mix('#B88266', '#28180E', 0.35);
    const ink = skins.match(/:root\[data-material="hedgewitch"\] \.nav-rail \.navlink, [^{]*\{ color: (#[0-9a-f]{6}); \}/i)![1];
    expect(contrastRatio(ink, lightest), `${ink} on ${lightest}`).toBeGreaterThanOrEqual(TEXT_MIN + 0.1);
    // the hover wash and the active item's plate (the selected wash) over the wood keep the same gate
    const wash = (rgba: string) => {
      const m = rgba.match(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/)!;
      return mix(lightest, '#' + [1, 2, 3].map(k => Number(m[k]).toString(16).padStart(2, '0')).join(''), Number(m[4]));
    };
    for (const plate of [wash(wood('--surface-chrome-selected')), wash('rgba(239, 228, 208, 0.10)')]) {
      expect(contrastRatio(ink, plate), `${ink} on ${plate}`).toBeGreaterThanOrEqual(TEXT_MIN + 0.1);
    }
  });
});
