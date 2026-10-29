/**
 * The appearance document: which room, which material, readability mode, and
 * per-material customisations. Everything here is pure — parsing a stored
 * value, choosing a room or material, mapping a document to the attributes
 * the CSS keys off, and working out which overrides apply — so it can be
 * tested without a DOM.
 */
import { FONT_CHOICES, THEME_TOKENS, TOKEN_KEYS } from './tokens';
import { contrastRatio, parseColor, TEXT_MIN } from './contrast';
import { ROOMS, isRoomId } from './rooms';
import { MATERIALS, isMaterialId, materialVars } from './materials';
import { MATERIAL_IDS } from './types';
import type { AppearanceAttributes, AppearanceDoc, MaterialId, Readability, RoomId, TokenOverrides } from './types';

export const APPEARANCE_CACHE_KEY = 'sanctum.appearance.v2';
export const APPEARANCE_VERSION = 2;
/** A stored document larger than this is ignored rather than parsed. */
export const MAX_DOC_BYTES = 16_000;
const MAX_VALUE_LEN = 300;

/** What an install with no stored document looks like: the Hedgewitch room and palette that shipped before skins. */
export function defaultDoc(): AppearanceDoc {
  return { version: 2, roomId: 'hedgewitch', materialId: 'hedgewitch', readability: 'standard', decorations: true, customByMaterial: {}, revision: 0 };
}

const FONT_VALUES = new Set(Object.values(FONT_CHOICES).flat().map(o => o.value));
const COLOR_KEYS = new Set(THEME_TOKENS.filter(t => t.kind === 'color').map(t => t.key));

/** Accept a colour override only if it is a plain, parseable colour; a font only if it is one of the listed stacks. */
export function isSafeTokenValue(key: string, value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LEN) return false;
  if (COLOR_KEYS.has(key)) return parseColor(value) !== null;
  return FONT_VALUES.has(value);
}

/** The legacy server-synced set, as it has always been read: known token keys with non-empty values (the server caps them at 300 characters). */
export function legacyOverrides(raw: unknown): TokenOverrides {
  const out: TokenOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (TOKEN_KEYS.has(k) && typeof v === 'string' && v.length > 0 && v.length <= MAX_VALUE_LEN) out[k] = v;
  }
  return out;
}

export function sanitizeOverrides(raw: unknown): TokenOverrides {
  const out: TokenOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (TOKEN_KEYS.has(k) && isSafeTokenValue(k, v)) out[k] = v;
  }
  return out;
}

/**
 * The legacy Hedgewitch parchment is translucent glass drawn for the Hedgewitch kitchen only, so it
 * is offered, stored and booted only with that room. With any other room the room's own opaque
 * material stands in. Kept in step with the inline boot script in index.html (boot.test.ts).
 */
export function materialAllowedWithRoom(roomId: RoomId, materialId: MaterialId): boolean {
  return materialId !== 'hedgewitch' || roomId === 'hedgewitch';
}

export function coerceMaterial(roomId: RoomId, materialId: MaterialId): MaterialId {
  return materialAllowedWithRoom(roomId, materialId) ? materialId : ROOMS[roomId].defaultMaterial;
}

/**
 * Turn whatever was stored into a valid document. Corrupt JSON, a missing
 * field, an unknown id or a future version never throws and never yields an
 * unreadable combination: it falls back field by field, and a future version
 * falls back wholesale to the default.
 */
export function parseDoc(raw: unknown): AppearanceDoc {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_DOC_BYTES) return defaultDoc();
    try { v = JSON.parse(raw); } catch { return defaultDoc(); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return defaultDoc();
  const o = v as Record<string, unknown>;
  if (o.version !== APPEARANCE_VERSION) return defaultDoc();
  const roomId: RoomId = isRoomId(o.roomId) ? o.roomId : 'hedgewitch';
  const materialId: MaterialId = coerceMaterial(roomId, isMaterialId(o.materialId) ? o.materialId : ROOMS[roomId].defaultMaterial);
  const custom: AppearanceDoc['customByMaterial'] = {};
  if (o.customByMaterial && typeof o.customByMaterial === 'object' && !Array.isArray(o.customByMaterial)) {
    for (const [id, set] of Object.entries(o.customByMaterial as Record<string, unknown>)) {
      if (isMaterialId(id) && id !== 'hedgewitch') {
        const clean = sanitizeOverrides(set);
        if (Object.keys(clean).length) custom[id] = clean;
      }
    }
  }
  return {
    version: 2,
    roomId,
    materialId,
    readability: o.readability === 'extra' ? 'extra' : 'standard',
    decorations: o.decorations !== false,
    customByMaterial: custom,
    revision: typeof o.revision === 'number' && Number.isFinite(o.revision) && o.revision >= 0 ? Math.floor(o.revision) : 0,
  };
}

export function serializeDoc(doc: AppearanceDoc): string {
  return JSON.stringify(doc);
}

export function docsEqual(a: AppearanceDoc, b: AppearanceDoc): boolean {
  return serializeDoc({ ...a, revision: 0 }) === serializeDoc({ ...b, revision: 0 });
}

/** Change the background only. Text colours are untouched, except that leaving the Hedgewitch room swaps the Hedgewitch parchment for the new room's own material. */
export function withRoom(doc: AppearanceDoc, roomId: RoomId): AppearanceDoc {
  return isRoomId(roomId) ? { ...doc, roomId, materialId: coerceMaterial(roomId, doc.materialId) } : doc;
}

/** Change the material only: the whole palette changes, the room stays. The Hedgewitch parchment is refused for any other room. */
export function withMaterial(doc: AppearanceDoc, materialId: MaterialId): AppearanceDoc {
  return isMaterialId(materialId) && materialAllowedWithRoom(doc.roomId, materialId) ? { ...doc, materialId } : doc;
}

/** "Use this room's suggested material": room and its matched default material together. */
export function withRoomPreset(doc: AppearanceDoc, roomId: RoomId): AppearanceDoc {
  if (!isRoomId(roomId)) return doc;
  return { ...doc, roomId, materialId: ROOMS[roomId].defaultMaterial };
}

export function withReadability(doc: AppearanceDoc, readability: Readability): AppearanceDoc {
  return { ...doc, readability };
}

export function isExtraReadable(doc: Pick<AppearanceDoc, 'readability'>): boolean {
  return doc.readability === 'extra';
}

/** Whether the frame layer (corners, trim line, gutter texture) should draw. Never in Extra readable; never for a room with no corner art. */
export function showsDecorations(doc: AppearanceDoc): boolean {
  return doc.decorations && !isExtraReadable(doc) && ROOMS[doc.roomId].corners !== null;
}

/** Material grain/ornaments do not depend on whether the selected room has corner art. */
export function showsSurfaceDecorations(doc: AppearanceDoc): boolean {
  return doc.decorations && !isExtraReadable(doc);
}

export function attributesFor(doc: AppearanceDoc): AppearanceAttributes {
  return {
    'data-room': doc.roomId,
    'data-material': doc.materialId,
    'data-readability': doc.readability,
    'data-decor': showsDecorations(doc) ? 'on' : 'off',
    'data-surface-decor': showsSurfaceDecorations(doc) ? 'on' : 'off',
  };
}

/**
 * The inline overrides that should be on <html> for this document.
 * - Hedgewitch: the legacy, server-synced set (existing users' settings keep working untouched).
 * - A skin material: only that material's own customisations; legacy overrides are not
 *   carried over, so old light-paper text colours can never land on a dark skin.
 * - Extra readable: colour overrides are dropped (the material's safe palette stands); font choices stay.
 */
export function effectiveOverrides(doc: AppearanceDoc, legacy: TokenOverrides): TokenOverrides {
  const src = doc.materialId === 'hedgewitch' ? legacyOverrides(legacy) : sanitizeOverrides(doc.customByMaterial[doc.materialId] ?? {});
  if (!isExtraReadable(doc)) return src;
  const out: TokenOverrides = {};
  for (const [k, v] of Object.entries(src)) if (!COLOR_KEYS.has(k)) out[k] = v;
  return out;
}

/** The values the Hedgewitch stylesheet gives the editable colour tokens (theme-hedgewitch.css). */
export const HEDGEWITCH_BASE: Record<string, string> = {
  '--bg-primary': '#f3ead7', '--bg-secondary': '#efe4cc', '--bg-input': '#faf4e5',
  '--text-primary': '#2c231f', '--text-secondary': '#54483f', '--text-muted': '#5d5047',
  '--border': 'rgba(70, 48, 30, 0.16)',
  '--amber': '#6d5b93', '--amber-bright': '#57477a',
  '--lavender': '#6d5b93', '--lavender-bright': '#3b2f52',
  '--gold': '#9a7b34', '--status-active': '#5d8a5a',
};

/** Every skin and the classic palette share one set of typefaces (skins change materials, not fonts). */
export const FONT_BASE: Record<string, string> = {
  '--font-serif': "'Lora', Georgia, 'Times New Roman', serif",
  '--font-body': "'Lora', Georgia, 'Times New Roman', serif",
  '--font-mono': "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
};

/** The value a token really has right now for this material, before any override (what the editor should show). */
export function baseTokenValue(materialId: MaterialId, key: string): string {
  const m = MATERIALS[materialId];
  const fromMaterial = m.roles ? materialVars(m.roles)[key] : HEDGEWITCH_BASE[key];
  if (fromMaterial) return fromMaterial;
  if (FONT_BASE[key]) return FONT_BASE[key];
  return THEME_TOKENS.find(t => t.key === key)?.fallback ?? '';
}

export interface ReadabilityIssue { id: string; fg: string; bg: string; ratio: number; min: number }

// Every foreground the editor can change, against every surface it lands on. The surfaces without an editable
// twin (--surface-user, --surface-companion) are read from the material, so a changed foreground is still judged
// against the card it is drawn on: "Your accent, bright" is the text of your own messages (ROLE_ALIASES).
const EDITOR_PAIRS: Array<[id: string, fg: string, bg: string]> = [
  ['primary text on background', '--text-primary', '--bg-primary'],
  ['secondary text on background', '--text-secondary', '--bg-primary'],
  ['muted text on background', '--text-muted', '--bg-primary'],
  ['primary text on secondary background', '--text-primary', '--bg-secondary'],
  ['primary text on input fields', '--text-primary', '--bg-input'],
  ['your text on your messages', '--lavender-bright', '--surface-user'],
  ['companion text on its messages', '--text-primary', '--surface-companion'],
  ['secondary text on companion messages', '--text-secondary', '--surface-companion'],
  ['links on companion messages', '--amber', '--surface-companion'],
  ['links on background', '--amber', '--bg-primary'],
];

/** Flag any of the main text/background pairs that fall under 4.5:1 once the overrides are applied. Opaque colours only; anything else is skipped. */
export function readabilityIssues(materialId: MaterialId, overrides: TokenOverrides): ReadabilityIssue[] {
  const val = (k: string) => overrides[k] ?? baseTokenValue(materialId, k);
  const out: ReadabilityIssue[] = [];
  for (const [id, fk, bk] of EDITOR_PAIRS) {
    // Only judge pairs the person actually touched; the shipped palettes are tested on their own.
    if (!(fk in overrides) && !(bk in overrides)) continue;
    const fg = val(fk), bg = val(bk);
    const f = parseColor(fg), b = parseColor(bg);
    if (!f || !b || f.a < 1 || b.a < 1) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio < TEXT_MIN) out.push({ id, fg, bg, ratio, min: TEXT_MIN });
  }
  return out;
}

// ─── The Appearance panel's own safe palette ────────────────────────────────────
// Whatever colours a person has customised, the panel that edits them must stay
// readable. It declares its own opaque pairs (from the material, or fixed ones
// for the classic palette) and reads only those, so a bad custom value can show
// up in the sample and in the rest of the app, never in the panel itself.

export interface PanelPalette {
  bg: string; text: string; text2: string; muted: string;
  field: string; fieldText: string; border: string;
  accent: string; button: string; buttonText: string; focus: string;
  error: string; success: string; warning: string;
}

/** Opaque stand-in for the classic Hedgewitch settings glass (dark, cream ink). */
export const HEDGEWITCH_PANEL: PanelPalette = {
  bg: '#26201F', text: '#EFE4D0', text2: '#DCCFB8', muted: '#C2B39C',
  field: '#2B3322', fieldText: '#F3EAD7', border: '#9B8F7C',
  accent: '#D9CFF0', button: '#6D5B93', buttonText: '#FFFFFF', focus: '#E6DAC3',
  error: '#E8A698', success: '#7CC496', warning: '#E0B95A',
};

/** The "Restore readable appearance" button: a fixed black-on-cream pair that never inherits anything. */
export const RESTORE_BUTTON = { bg: '#FAF3E4', text: '#2C231F', border: '#2C231F' } as const;

export function panelPalette(materialId: MaterialId): PanelPalette {
  const r = MATERIALS[materialId].roles;
  if (!r) return HEDGEWITCH_PANEL;
  return {
    bg: r.panel, text: r.text, text2: r.secondary, muted: r.muted,
    field: r.input, fieldText: r.inputText, border: r.controlBorder,
    accent: r.link, button: r.button, buttonText: r.buttonText, focus: r.focus,
    error: r.error, success: r.success, warning: r.warning,
  };
}

/** Inline custom properties for the panel's wrapper: they shadow anything set on <html>. */
export function panelScopeVars(materialId: MaterialId): Record<string, string> {
  const p = panelPalette(materialId);
  return {
    '--ap-bg': p.bg, '--ap-text': p.text, '--ap-text-2': p.text2, '--ap-muted': p.muted,
    '--ap-field': p.field, '--ap-field-text': p.fieldText, '--ap-border': p.border,
    '--ap-accent': p.accent, '--ap-button': p.button, '--ap-button-text': p.buttonText, '--ap-focus': p.focus,
    '--ap-error': p.error, '--ap-success': p.success, '--ap-warning': p.warning,
    // the shared primitives read these names
    '--text-primary': p.text, '--text-secondary': p.text2, '--text-muted': p.muted,
    '--settings-ink': p.text, '--settings-ink-2': p.text2, '--settings-ink-3': p.muted,
    '--bg-input': p.field, '--settings-field-bg': p.field, '--settings-field-text': p.fieldText, '--settings-field-border': p.border,
    '--field-border': p.border, '--amber': p.accent, '--amber-bright': p.accent, '--link': p.accent, '--focus-ring': p.focus,
    '--status-error-text': p.error, '--status-success-text': p.success, '--status-warning-text': p.warning,
    '--settings-hairline': p.border, '--settings-disabled-bg': p.field, '--settings-disabled-text': p.muted,
    '--toggle-off-bg': p.field, '--toggle-off-border': p.border, '--toggle-off-thumb': p.muted,
    '--toggle-on-bg': p.button, '--toggle-on-border': p.border, '--toggle-on-thumb': p.buttonText,
    '--btn-border-muted': p.border, '--btn-border-muted-hover': p.text, '--btn-border-primary': p.border,
  };
}
