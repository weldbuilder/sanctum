/** Deterministic, self-contained SVG patterns derived from a designer tile, should a material ever lay one over its cloth.
 * None does today: every skin's cloth, fittings and ornaments are raster, cut from its painting (scripts/skin-art).
 * `gen:textures` writes any such vectors and the integrity manifest; equality tests prevent drift.
 */

export interface TextureSpec {
  /** Room folder under public/skins that holds the designer tile this is derived from. */
  room: string;
  /** The one ink every mark is drawn in (the strongest colour the texture can put on a panel). */
  ink: string;
  /** Stroke width multiplier: thin 0.4 to 0.7px hairlines vanish once laid at low alpha. */
  widen: number;
  /** Extra marks appended to the derived pattern. */
  extra?: (ink: string) => string;
  /** Optional baked amplitude for a separate decorative pattern layer. */
  alpha?: number;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** Drawn patterns laid over a cloth. None today: Crimson Velvet's damask is grown from its painting (scripts/skin-art). */
export const TEXTURES: Record<string, TextureSpec> = {};

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">';

/** Derive a panel texture from a designer tile's SVG text. */
export function deriveTexture(tileSvg: string, spec: TextureSpec): string {
  let body = tileSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  body = body.replace(/<rect width="256" height="256" fill="#[0-9A-Fa-f]{6}"\/>/, ''); // the base colour goes: the panel supplies it
  // every mark in one ink
  body = body.replace(/#[0-9A-Fa-f]{6}/g, spec.ink);
  // the strongest opacity in the tile becomes 1, the rest keep their ratio
  const ops = [...body.matchAll(/ opacity="([\d.]+)"/g)].map(m => parseFloat(m[1]));
  const max = Math.max(...ops, 0.0001);
  body = body.replace(/ opacity="([\d.]+)"/g, (_m, v) => ` opacity="${f(parseFloat(v) / max)}"`);
  body = body.replace(/stroke-width="([\d.]+)"/g, (_m, v) => `stroke-width="${f(parseFloat(v) * spec.widen)}"`);
  return `${SVG_OPEN}<g opacity="${spec.alpha ?? 1}">${body}${spec.extra ? spec.extra(spec.ink) : ''}</g></svg>\n`;
}


/** Output path (under public/) -> file text, for every generated texture. */
export function buildAllTextures(readTile: (room: string) => string, _readOrnament: (room: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [room, spec] of Object.entries(TEXTURES)) out[`skins/${room}/texture-v1.svg`] = deriveTexture(readTile(spec.room), spec);
  // Every skin's cloth, fittings and ornaments are cut from its painting (scripts/skin-art); nothing is drawn here today.
  return out;
}
