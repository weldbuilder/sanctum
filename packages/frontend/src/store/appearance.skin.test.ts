import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
vi.stubGlobal('document', undefined);

import { useAppearanceStore } from './appearance';
import { defaultDoc } from '../theme/appearance';

describe('skin belongs to the companion', () => {
  beforeEach(() => { store.clear(); useAppearanceStore.setState({ applied: defaultDoc(), draft: null, serverSkin: null }); });
  it('adopts the server skin and caches it', () => {
    useAppearanceStore.getState().adoptServerSkin('ember');
    expect(useAppearanceStore.getState().applied.roomId).toBe('ember');
    expect(JSON.parse(store.get('sanctum.appearance.v2')!).roomId).toBe('ember');
  });
  it('a null server skin leaves the browser choice alone', () => {
    useAppearanceStore.getState().adoptServerSkin(null);
    expect(useAppearanceStore.getState().applied.roomId).toBe('hedgewitch');
  });
  it('ignores an unknown skin id', () => {
    useAppearanceStore.getState().adoptServerSkin('nonsense');
    expect(useAppearanceStore.getState().applied.roomId).toBe('hedgewitch');
  });
});
