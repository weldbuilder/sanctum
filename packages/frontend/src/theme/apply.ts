/**
 * The one place that writes appearance to <html>. Two things are written:
 *  - appearance attributes (room, material, readability, room frame, surface decorations), which every
 *    rule in skins.generated.css / skins.css / theme-hedgewitch.css keys off;
 *  - the inline colour/font overrides that apply on top of the material.
 * Nothing else touches either, so a preview, a cancel or a switch always
 * leaves exactly the state the visible document describes.
 */
import { attributesFor, effectiveOverrides, readabilityIssues } from './appearance';
import { TOKEN_KEYS } from './tokens';
import type { AppearanceDoc, TokenOverrides } from './types';
import { defaultDoc } from './appearance';

let visible: AppearanceDoc = defaultDoc();
let legacy: TokenOverrides = {};

/**
 * Overrides that would make the main text unreadable are held back for skin
 * materials, so the editor can never leave the whole app unreadable. The
 * legacy Hedgewitch set is applied as stored: those are existing settings and
 * keep working exactly as before.
 */
export function guardedOverrides(doc: AppearanceDoc, legacySet: TokenOverrides): { applied: TokenOverrides; held: boolean } {
  const wanted = effectiveOverrides(doc, legacySet);
  if (doc.materialId === 'hedgewitch') return { applied: wanted, held: false };
  if (readabilityIssues(doc.materialId, wanted).length === 0) return { applied: wanted, held: false };
  const fonts: TokenOverrides = {};
  for (const [k, v] of Object.entries(wanted)) if (k.startsWith('--font-')) fonts[k] = v;
  return { applied: fonts, held: true };
}

function writeDom(doc: AppearanceDoc, applied: TokenOverrides): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(attributesFor(doc))) root.setAttribute(k, v);
  for (const key of TOKEN_KEYS) root.style.removeProperty(key);
  for (const [key, value] of Object.entries(applied)) if (TOKEN_KEYS.has(key)) root.style.setProperty(key, value);
}

export function render(): void {
  writeDom(visible, guardedOverrides(visible, legacy).applied);
}

/** The document currently on screen: the applied one, or a preview that has not been applied yet. */
export function setVisibleDoc(doc: AppearanceDoc): void {
  visible = doc;
  render();
}

/** The legacy server-synced override set (store/theme.ts owns it). */
export function setLegacyOverrides(overrides: TokenOverrides): void {
  legacy = overrides;
  render();
}

export function getVisibleDoc(): AppearanceDoc { return visible; }
