/**
 * Appearance store: room, material, readability and per-material colours.
 *
 * Preview is local and reversible. `preview()` shows a draft on screen without
 * saving it; `apply()` commits the whole document in one step; `cancel()`
 * puts the exact prior document back. Persistence is this browser's
 * localStorage (the legacy colour overrides keep their own server sync in
 * store/theme.ts) and every read and write is guarded, so blocked storage or a
 * corrupt value can never blank the app.
 *
 * The ROOM (the skin) belongs to the companion, not the browser: it is read from
 * /api/identity.skin on load (adoptServerSkin) and written back with PATCH when an
 * applied change moves the room. The browser copy is a cache. A server skin of null
 * (a house that never set one) leaves the browser's own choice in charge.
 */
import { create } from 'zustand';
import {
  APPEARANCE_CACHE_KEY, defaultDoc, docsEqual, parseDoc, sanitizeOverrides, serializeDoc,
} from '../theme/appearance';
import { setVisibleDoc } from '../theme/apply';
import { isRoomId } from '../theme/rooms';
import { withRoomPreset } from '../theme/appearance';
import { patchIdentity } from './identity';
import type { AppearanceDoc, MaterialId, TokenOverrides } from '../theme/types';

function readCache(): AppearanceDoc {
  try {
    const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
    if (!raw) return defaultDoc();
    const doc = parseDoc(raw);
    // Migrate a stored Hedgewitch parchment + other room (allowed by an earlier build): parseDoc has
    // already swapped in the room's own material, so save that and the old pairing never returns.
    if (storedPairingWasCoerced(raw, doc)) writeCache(doc);
    return doc;
  } catch {
    return defaultDoc();
  }
}

function storedPairingWasCoerced(raw: string, doc: AppearanceDoc): boolean {
  try {
    const o = JSON.parse(raw) as { materialId?: unknown };
    return typeof o === 'object' && o !== null && o.materialId === 'hedgewitch' && doc.materialId !== 'hedgewitch';
  } catch { return false; }
}

/** True when the document was saved; false when storage is unavailable (the choice then lasts for this session only). */
function writeCache(doc: AppearanceDoc): boolean {
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, serializeDoc(doc));
    return true;
  } catch {
    return false;
  }
}

/** Write the room to the companion's identity when it differs from what the server holds. Failure leaves the browser copy; the next apply retries. */
function pushSkin(roomId: string): void {
  if (useAppearanceStore.getState().serverSkin === roomId) return;
  void patchIdentity({ skin: roomId }).then(ok => { if (ok) useAppearanceStore.setState({ serverSkin: roomId }); });
}

export type PersistStatus = 'idle' | 'saved' | 'unsaved';

interface AppearanceState {
  applied: AppearanceDoc;
  /** A preview not yet applied; null when nothing is pending. */
  draft: AppearanceDoc | null;
  persist: PersistStatus;
  /** The skin the server holds for this companion (null = never set). */
  serverSkin: string | null;
  /** Take the companion's saved room as the truth. Null leaves the browser's choice alone. */
  adoptServerSkin: (skin: string | null) => void;
  /** Read the cached document and put it on screen. Called once, before first render. */
  loadCache: () => void;
  /** Show this document without saving it. */
  preview: (doc: AppearanceDoc) => void;
  /** Commit the pending preview. Returns whether it was saved to this browser. */
  apply: () => boolean;
  /** Drop the pending preview and restore the applied document exactly. */
  cancel: () => void;
  /** Set or clear one colour/font customisation of a skin material; saved at once, applied live. */
  setCustom: (materialId: MaterialId, key: string, value: string | null) => void;
  /** Remove every colour customisation of one material (keeps room, material, readability). */
  clearCustom: (materialId: MaterialId) => void;
  /** Back to the shipped default: Hedgewitch room and palette, standard readability, no customisations. */
  reset: () => void;
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  applied: defaultDoc(),
  draft: null,
  persist: 'idle',
  serverSkin: null,

  adoptServerSkin(skin) {
    set({ serverSkin: skin });
    const { applied, draft } = get();
    if (!skin || !isRoomId(skin) || skin === applied.roomId) return;
    const next: AppearanceDoc = { ...withRoomPreset(applied, skin), revision: applied.revision + 1 };
    writeCache(next);
    set({ applied: next });
    if (!draft) setVisibleDoc(next);
  },

  loadCache() {
    const doc = readCache();
    set({ applied: doc, draft: null });
    setVisibleDoc(doc);
  },

  preview(doc) {
    const { applied } = get();
    // A preview identical to what is applied is not a pending change.
    if (docsEqual(doc, applied)) { set({ draft: null }); setVisibleDoc(applied); return; }
    set({ draft: doc });
    setVisibleDoc(doc);
  },

  apply() {
    const { draft, applied } = get();
    if (!draft) return true;
    const next: AppearanceDoc = { ...draft, revision: applied.revision + 1 };
    const saved = writeCache(next);
    set({ applied: next, draft: null, persist: saved ? 'saved' : 'unsaved' });
    setVisibleDoc(next);
    pushSkin(next.roomId);
    return saved;
  },

  cancel() {
    const { applied } = get();
    set({ draft: null });
    setVisibleDoc(applied);
  },

  setCustom(materialId, key, value) {
    if (materialId === 'hedgewitch') return; // the legacy palette's colours stay on the server-synced path
    const { applied, draft } = get();
    const base = draft ?? applied;
    const cur: TokenOverrides = { ...(base.customByMaterial[materialId] ?? {}) };
    if (value === null) delete cur[key]; else cur[key] = value;
    const clean = sanitizeOverrides(cur);
    const custom = { ...base.customByMaterial };
    if (Object.keys(clean).length) custom[materialId] = clean; else delete custom[materialId];
    const next = { ...base, customByMaterial: custom };
    if (draft) { set({ draft: next }); setVisibleDoc(next); return; }
    const saved = writeCache({ ...next, revision: applied.revision + 1 });
    const committed = { ...next, revision: applied.revision + 1 };
    set({ applied: committed, persist: saved ? 'saved' : 'unsaved' });
    setVisibleDoc(committed);
  },

  clearCustom(materialId) {
    const { applied, draft } = get();
    const base = draft ?? applied;
    const custom = { ...base.customByMaterial };
    // Colours only: the typefaces the person picked are not what made the appearance unreadable.
    const fonts = Object.fromEntries(Object.entries(custom[materialId] ?? {}).filter(([k]) => k.startsWith('--font-')));
    if (Object.keys(fonts).length) custom[materialId] = fonts; else delete custom[materialId];
    const next = { ...base, customByMaterial: custom };
    if (draft) { set({ draft: next }); setVisibleDoc(next); return; }
    const committed = { ...next, revision: applied.revision + 1 };
    const saved = writeCache(committed);
    set({ applied: committed, persist: saved ? 'saved' : 'unsaved' });
    setVisibleDoc(committed);
  },

  reset() {
    const { applied } = get();
    const next = { ...defaultDoc(), revision: applied.revision + 1 };
    const saved = writeCache(next);
    set({ applied: next, draft: null, persist: saved ? 'saved' : 'unsaved' });
    setVisibleDoc(next);
    pushSkin(next.roomId);
  },
}));
