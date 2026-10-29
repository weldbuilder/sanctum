import { describe, expect, it } from 'vitest';
import { MATERIAL_LIST, MATERIALS, ROLE_ALIASES, SURFACE_ROLE_VARS, materialPairs, materialVars } from './materials';
import { contrastRatio, round2 } from './contrast';
import { MATERIAL_IDS } from './types';
import { readFileSync } from 'node:fs';
import { buildSkinsCss } from './skins-css';
import { MOUNT_PLATES } from './materials';

describe('material registry', () => {
  it('no skin material keeps room on its Home cards for a sprig it never draws, at any width', () => {
    for (const m of MATERIAL_LIST.filter(m => m.roles)) {
      const v = materialVars(m.roles!);
      expect(v['--home-sprig-display'], m.id).toBe('none');
      for (const k of ['--home-sprig-room', '--home-sprig-room-m', '--home-sprig-room-phone', '--home-sprig-room-half']) expect(v[k], `${m.id} ${k}`).toBe('0rem');
    }
  });

  it('has the six skin materials and the legacy one', () => {
    expect(MATERIAL_LIST.map(m => m.id)).toEqual([...MATERIAL_IDS]);
    expect(MATERIALS.hedgewitch.legacy).toBe(true);
    expect(MATERIALS.hedgewitch.roles).toBeNull();
    for (const id of MATERIAL_IDS.filter(i => i !== 'hedgewitch')) expect(MATERIALS[id].roles).not.toBeNull();
  });

  it('every skin material supplies every role as a real colour', () => {
    for (const m of MATERIAL_LIST.filter(m => m.roles)) {
      const vars = materialVars(m.roles!);
      for (const [cssVar, role] of SURFACE_ROLE_VARS) {
        const v = vars[cssVar];
        if (ROLE_ALIASES[cssVar]) {
          // a role with an editable twin points at it, and the twin carries the palette's colour
          expect(v, `${m.id} ${cssVar}`).toBe(`var(${ROLE_ALIASES[cssVar]})`);
          expect(vars[ROLE_ALIASES[cssVar]], `${m.id} ${ROLE_ALIASES[cssVar]}`).toBe(m.roles![role] as string);
        } else {
          expect(v, `${m.id} ${cssVar}`).toMatch(/^#[0-9A-F]{6}$/);
        }
      }
    }
  });

  it('the library keeps a light reading surface with its own dark chrome', () => {
    const r = MATERIALS['mounted-paper'].roles!;
    expect(r.scheme).toBe('light');
    expect(contrastRatio(r.text, r.panel)).toBeGreaterThan(7);
    expect(contrastRatio(r.chromeText, r.chrome)).toBeGreaterThan(7);
    expect(r.focusChrome).toBe('#BA5C3C'); // a deep red copper on the dark wood, not the paper's dark focus ring nor a glaring pale gold
    expect(contrastRatio(r.focusChrome, r.chrome)).toBeGreaterThanOrEqual(3);
    expect(r.focus).not.toBe(r.focusChrome);
  });

  it('every promised pair meets 4.5:1 (text) or 3:1 (controls and focus), for all six materials', () => {
    const fails: string[] = [];
    for (const m of MATERIAL_LIST.filter(m => m.roles)) {
      for (const p of materialPairs(m.roles!)) {
        const ratio = contrastRatio(p.fg, p.bg);
        if (!(ratio >= p.min)) fails.push(`${m.id}: ${p.id} ${p.fg} on ${p.bg} = ${round2(ratio)} < ${p.min}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it("reproduces the designer's contrast-report.csv for the base pairs", () => {
    // Rows are the designer's own opaque pairs; the registry must carry the same colours.
    const csvPath = new URL('./designer-contrast-report.csv', import.meta.url);
    const rows = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
    expect(rows.length).toBe(70);
    for (const [skin, , , fg, bg, ratio, min] of rows) {
      const got = round2(contrastRatio(fg, bg));
      expect(got, `${skin} ${fg} on ${bg}`).toBeCloseTo(Number(ratio), 1);
      expect(got).toBeGreaterThanOrEqual(Number(min));
    }
  });

  it('maps legacy names to the matching pair, so old components read a safe palette', () => {
    const r = MATERIALS['black-damask'].roles!;
    const v = materialVars(r);
    expect(v['--text-primary']).toBe(r.text);
    expect(v['--surface-panel-text']).toBe('var(--text-primary)');
    expect(v['--bg-primary']).toBe(r.panel);
    expect(v['--bg-input']).toBe(r.input);
    expect(v['--lavender-subtle']).toBe(r.user);
    expect(v['--lavender-bright']).toBe(r.userText);
    expect(v['--ink-on-wood']).toBe(r.chromeText);
    expect(v['--wood-1']).toBe(r.chrome);
    expect(v['--color-text-primary']).toBe('var(--text-primary)'); // Tailwind names follow the bare ones
  });

  it('keeps optional editor palettes material-owned instead of falling back to universal parchment', () => {
    const ember = MATERIALS['smoked-copper'];
    expect(ember.roles!.editor!.bg).toBe(ember.roles!.input);
    expect(ember.roles!.editor!.text).toBe(ember.roles!.inputText);
    for (const id of MATERIAL_IDS.filter(id => id !== 'hedgewitch' && id !== 'smoked-copper')) {
      const material = MATERIALS[id];
      expect(material.roles!.editor, id).toMatchObject({ bg: material.roles!.input, text: material.roles!.inputText, focus: material.roles!.focus });
      expect(materialVars(material.roles!)['--bg-input'], id).toBe(material.roles!.input);
    }
  });

  it('a different material gives different text and surface colours throughout', () => {
    const a = materialVars(MATERIALS['black-damask'].roles!), b = materialVars(MATERIALS['mounted-paper'].roles!);
    for (const k of ['--bg-primary', '--text-primary', '--surface-chrome', '--bg-input', '--surface-user']) expect(a[k]).not.toBe(b[k]);
  });
});

describe('mounted plates (the library keeps mounted paper in a dark backing with a brass edge)', () => {
  const css = buildSkinsCss();
  it('only mounted-paper opts in, and its ring is the chrome backing plus a 1px edge in the material\'s own brass', () => {
    expect(MATERIAL_LIST.filter(m => m.mounted).map(m => m.id)).toEqual(['mounted-paper']);
    const ring = css.match(/--skin-mount-ring: ([^;]+);/g)!;
    expect(ring).toHaveLength(1);
    expect(ring[0]).toBe(`--skin-mount-ring: 0 0 0 2px var(--surface-chrome), 0 0 0 3px ${MATERIALS['mounted-paper'].roles!.trim};`);
  });

  it('frames every primary plate, never in Extra readable, and leaves the text surface pair alone', () => {
    for (const sel of ['.message.companion', '.message.user', '.thread-sidebar', '.composer-inner', '.settings-content-inner', '.cdlg-panel']) { // the base list, which the dark-chrome plates then override while decorations are on
      expect(MOUNT_PLATES.map(p => p[0])).toContain(sel);
    }
    for (const [sel] of MOUNT_PLATES) {
      expect(css).toContain(`:root[data-material="mounted-paper"]:not([data-readability="extra"]) ${sel} { box-shadow: var(--skin-mount-ring)`);
    }
    const block = css.split('mounted materials')[1].split('── plates:')[0];
    expect(block).not.toMatch(/background|color:/); // box-shadow and margin only
    expect(block).not.toContain(', none');
  });
});
