/**
 * Room registry. The five artwork rooms are read from the designer's
 * asset-manifest.json (copied verbatim next to this file), so a path, fallback
 * colour or crop position is never typed twice. Hedgewitch is the legacy room
 * (the painted kitchen that shipped before skins) and stays selectable.
 */
import manifest from './asset-manifest.json';
import type { MaterialId, Orientation, RoomId } from './types';
import { ROOM_IDS } from './types';

/** The shell's mobile breakpoint (App.tsx: `@media (max-width: 768px)`). */
export const MOBILE_BREAKPOINT_PX = 768;

export interface SceneAsset {
  /** Preferred format; null when the room has no WebP. */
  webp: string | null;
  /** Fallback for browsers that cannot decode WebP; null when the room has no JPEG. */
  jpeg: string | null;
  /** CSS background-position. */
  position: string;
}

export interface RoomDef {
  id: RoomId;
  name: string;
  defaultMaterial: MaterialId;
  /** Solid colour painted behind (and before) the scene, so a missing image never flashes white. */
  fallback: string;
  landscape: SceneAsset;
  portrait: SceneAsset;
  /** 360x240 preview, lazily shown in the picker. Null for the legacy room. */
  thumbnail: string | null;
  /** Fixed-size metal corners (96px source, drawn at CORNER_CSS_PX). Null = no ornament. */
  corners: { tl: string; tr: string; br: string; bl: string } | null;
  /** True when the pack draws one corner and the other three are that file turned (Ember): the stylesheet carries the turned copies. */
  cornersFlipped: boolean;
  /** The designer's margin tile (a 256px square, or 64px in Ember). Null for the legacy room. */
  tile: string | null;
  /** A legacy room that predates the artwork pack. */
  legacy: boolean;
}

export const CORNER_CSS_PX = manifest.rooms.salon.cornerCssSizePx; // 48
/** The ornament's curve needs this much clear space along each adjoining edge. */
export const CORNER_RESERVE_PX = 24;

type ManifestRoom = (typeof manifest.rooms)['salon'];
const M = manifest.rooms as Record<string, ManifestRoom>;

function fromManifest(id: Exclude<RoomId, 'hedgewitch'>): RoomDef {
  const r = M[id];
  const a = r.assets as Record<string, string>;
  return {
    id,
    name: r.name,
    defaultMaterial: r.defaultMaterial as MaterialId,
    fallback: r.fallback,
    landscape: { webp: a.desktopWebp, jpeg: a.desktopJpeg, position: r.desktopPosition },
    portrait: { webp: a.mobileWebp, jpeg: a.mobileJpeg, position: r.mobilePosition },
    thumbnail: a.thumbnail,
    corners: { tl: a['corner-tl-svg'], tr: a['corner-tr-svg'], br: a['corner-br-svg'], bl: a['corner-bl-svg'] },
    cornersFlipped: a['corner-tl-svg'] === a['corner-tr-svg'],
    tile: a['material-tile-svg'],
    legacy: false,
  };
}

export const ROOMS: Record<RoomId, RoomDef> = {
  salon: fromManifest('salon'),
  library: fromManifest('library'),
  cloister: fromManifest('cloister'),
  conservatory: fromManifest('conservatory'),
  night: fromManifest('night'),
  ember: fromManifest('ember'),
  hedgewitch: {
    id: 'hedgewitch',
    name: 'Hedgewitch kitchen',
    defaultMaterial: 'hedgewitch',
    fallback: '#1b2414',
    landscape: { webp: '/hedgewitch/kitchen.webp', jpeg: null, position: '50% 50%' },
    portrait: { webp: '/hedgewitch/kitchen-small.webp', jpeg: null, position: '50% 50%' },
    thumbnail: null,
    corners: null,
    cornersFlipped: false,
    tile: null,
    legacy: true,
  },
};

export const ROOM_LIST: RoomDef[] = ROOM_IDS.map(id => ROOMS[id]);

export function isRoomId(v: unknown): v is RoomId {
  return typeof v === 'string' && (ROOM_IDS as readonly string[]).includes(v);
}

/** Portrait at or below the shell's 768px breakpoint (the shell swaps to the top bar there), landscape above. */
export function pickOrientation(widthPx: number): Orientation {
  return widthPx <= MOBILE_BREAKPOINT_PX ? 'portrait' : 'landscape';
}

export interface SceneChoice {
  orientation: Orientation;
  /** URL to request first: WebP when the browser can decode it, else the JPEG (or the WebP if that is all there is). */
  url: string;
  webp: string | null;
  jpeg: string | null;
  position: string;
  fallback: string;
  /** CSS size: always `cover`, never stretched. */
  size: 'cover';
}

/** The one scene file a viewport of this width should fetch for this room. Unknown rooms fall back to the legacy room. */
export function sceneFor(roomId: RoomId | string, widthPx: number, canWebp = true): SceneChoice {
  const room = isRoomId(roomId) ? ROOMS[roomId] : ROOMS.hedgewitch;
  const orientation = pickOrientation(widthPx);
  const s = room[orientation];
  const url = (canWebp ? s.webp ?? s.jpeg : s.jpeg ?? s.webp) as string;
  return { orientation, url, webp: s.webp, jpeg: s.jpeg, position: s.position, fallback: room.fallback, size: 'cover' };
}

/** Every public path the registry points at, for the integrity test and the service-worker allowlist. */
export function allRegistryPaths(): string[] {
  const out = new Set<string>();
  for (const r of ROOM_LIST) {
    if (r.legacy) continue;
    for (const s of [r.landscape, r.portrait]) { if (s.webp) out.add(s.webp); if (s.jpeg) out.add(s.jpeg); }
    if (r.thumbnail) out.add(r.thumbnail);
    if (r.corners) Object.values(r.corners).forEach(p => out.add(p));
  }
  return [...out];
}

/**
 * Ember's pack draws one corner (top-left, a 1px curve in the decorative rust, 64px source). The other three are that
 * drawing turned, written into the stylesheet as small data URIs, so the shipped file stays the single source:
 * rooms.test.ts holds this text to the file byte for byte. Kept as text because the stylesheet is generated under node.
 */
export const EMBER_CORNER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M1 48V13Q1 1 13 1H48" fill="none" stroke="#885440" stroke-width="1"/></svg>';

const FLIPS: Record<'tr' | 'br' | 'bl', string> = {
  tr: 'matrix(-1 0 0 1 64 0)',
  br: 'rotate(180 32 32)',
  bl: 'matrix(1 0 0 -1 0 64)',
};

/** A turned copy of the Ember corner as a CSS-ready data URI (the drawing wrapped in one transform; no second shape, no new colour). */
export function flippedCornerDataUri(which: 'tr' | 'br' | 'bl'): string {
  const body = EMBER_CORNER_SVG.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><g transform="${FLIPS[which]}">${body}</g></svg>`;
  return `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23')}`;
}
