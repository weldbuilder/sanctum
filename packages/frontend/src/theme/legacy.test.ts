/**
 * An install that predates skins has only the old theme cache (`sanctum.themeOverrides`, a flat map of
 * token -> value) and no appearance document. These tests feed that stored shape through the two real
 * stores, in the order main.tsx loads them, against a stand-in page, and check what lands on <html>.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThemeStore } from '../store/theme';
import { useAppearanceStore } from '../store/appearance';
import { APPEARANCE_CACHE_KEY, defaultDoc, withMaterial, withRoom } from './appearance';
import { setLegacyOverrides, setVisibleDoc } from './apply';

const OLD_SHAPE = {
  '--text-primary': '#112233',
  '--bg-primary': '#ffeedd',
  '--amber': '#884400',
  '--font-serif': "'Playfair Display', Georgia, serif",
  '--not-a-token': 'red',
};

let store: Record<string, string>;
let attrs: Record<string, string>;
let inline: Record<string, string>;

function install(opts: { blocked?: boolean } = {}) {
  store = {};
  attrs = {};
  inline = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => { if (opts.blocked) throw new Error('blocked'); return k in store ? store[k] : null; },
    setItem: (k: string, v: string) => { if (opts.blocked) throw new Error('blocked'); store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
      style: { setProperty: (k: string, v: string) => { inline[k] = v; }, removeProperty: (k: string) => { delete inline[k]; } },
    },
  });
}

/** What main.tsx does at start-up. */
function boot() {
  useThemeStore.getState().loadCache();
  useAppearanceStore.getState().loadCache();
}

beforeEach(() => {
  install();
  setLegacyOverrides({});
  setVisibleDoc(defaultDoc());
  useThemeStore.setState({ overrides: {}, loaded: false });
  useAppearanceStore.setState({ applied: defaultDoc(), draft: null, persist: 'idle' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('an install from before skins', () => {
  it('opens in the Hedgewitch room and palette with its saved colours and fonts applied, as before', () => {
    store['sanctum.themeOverrides'] = JSON.stringify(OLD_SHAPE);
    boot();
    expect(attrs).toEqual({ 'data-room': 'hedgewitch', 'data-material': 'hedgewitch', 'data-readability': 'standard', 'data-decor': 'off', 'data-surface-decor': 'on' });
    expect(inline).toEqual({
      '--text-primary': '#112233', '--bg-primary': '#ffeedd', '--amber': '#884400', '--font-serif': "'Playfair Display', Georgia, serif",
    });
    expect(useAppearanceStore.getState().applied).toEqual(defaultDoc());
  });

  it('writes no appearance document just by loading, and the old cache is left as it was', () => {
    store['sanctum.themeOverrides'] = JSON.stringify(OLD_SHAPE);
    boot();
    expect(APPEARANCE_CACHE_KEY in store).toBe(false);
    expect(JSON.parse(store['sanctum.themeOverrides'])).toEqual(OLD_SHAPE);
  });

  it('with nothing stored at all, applies the plain Hedgewitch default and no inline colours', () => {
    boot();
    expect(attrs['data-room']).toBe('hedgewitch');
    expect(attrs['data-material']).toBe('hedgewitch');
    expect(inline).toEqual({});
  });

  it('a corrupt old cache or blocked storage leaves the default in place and does not throw', () => {
    store['sanctum.themeOverrides'] = '{not json';
    expect(boot).not.toThrow();
    expect(inline).toEqual({});
    install({ blocked: true });
    expect(boot).not.toThrow();
    expect(attrs['data-room']).toBe('hedgewitch');
  });

  it('leaving the Hedgewitch room swaps the parchment for the new room\'s material and sets the saved colours aside; cancelling brings them back', () => {
    store['sanctum.themeOverrides'] = JSON.stringify(OLD_SHAPE);
    boot();
    const a = useAppearanceStore.getState();
    a.preview(withRoom(a.applied, 'night'));
    expect(attrs['data-room']).toBe('night');
    expect(attrs['data-material']).toBe('indigo-silk'); // the translucent parchment is Hedgewitch-room only
    expect(inline['--text-primary']).toBeUndefined();
    a.preview(withMaterial(withRoom(a.applied, 'night'), 'indigo-silk'));
    expect(attrs['data-material']).toBe('indigo-silk');
    expect(inline['--text-primary']).toBeUndefined();
    expect(inline['--bg-primary']).toBeUndefined();
    a.cancel();
    expect(attrs['data-room']).toBe('hedgewitch');
    expect(inline['--text-primary']).toBe('#112233');
    expect(store['sanctum.themeOverrides']).toBe(JSON.stringify(OLD_SHAPE));
  });

  it('reset returns to the Hedgewitch room and palette without touching the old colour cache', () => {
    store['sanctum.themeOverrides'] = JSON.stringify(OLD_SHAPE);
    boot();
    const a = useAppearanceStore.getState();
    a.preview(withMaterial(withRoom(a.applied, 'salon'), 'black-damask'));
    expect(a.apply()).toBe(true);
    expect(attrs['data-room']).toBe('salon');
    useAppearanceStore.getState().reset();
    expect(attrs['data-room']).toBe('hedgewitch');
    expect(attrs['data-material']).toBe('hedgewitch');
    expect(inline['--text-primary']).toBe('#112233');
    expect(JSON.parse(store['sanctum.themeOverrides'])).toEqual(OLD_SHAPE);
  });
});

describe('Restore readable appearance', () => {
  it('removes the custom colours of the material and keeps its typefaces', () => {
    const a = useAppearanceStore.getState();
    a.setCustom('midnight-ink', '--text-primary', '#101E37');
    a.setCustom('midnight-ink', '--font-body', "'Lora', Georgia, 'Times New Roman', serif");
    expect(Object.keys(useAppearanceStore.getState().applied.customByMaterial['midnight-ink'] ?? {}).sort()).toEqual(['--font-body', '--text-primary']);
    useAppearanceStore.getState().clearCustom('midnight-ink');
    expect(useAppearanceStore.getState().applied.customByMaterial['midnight-ink']).toEqual({ '--font-body': "'Lora', Georgia, 'Times New Roman', serif" });
    useAppearanceStore.getState().clearCustom('midnight-ink'); // nothing but fonts left: still kept
    expect(useAppearanceStore.getState().applied.customByMaterial['midnight-ink']).toEqual({ '--font-body': "'Lora', Georgia, 'Times New Roman', serif" });
  });
});

describe('migration of a stored Hedgewitch parchment on another room', () => {
  it('opens as the room\'s own material and saves that, so the pairing does not come back', () => {
    install();
    store[APPEARANCE_CACHE_KEY] = JSON.stringify({ version: 2, roomId: 'night', materialId: 'hedgewitch', readability: 'standard', decorations: true, customByMaterial: {}, revision: 4 });
    useAppearanceStore.getState().loadCache();
    expect(attrs['data-material']).toBe('indigo-silk');
    expect(attrs['data-room']).toBe('night');
    expect(JSON.parse(store[APPEARANCE_CACHE_KEY]).materialId).toBe('indigo-silk');
    vi.unstubAllGlobals();
  });
});
