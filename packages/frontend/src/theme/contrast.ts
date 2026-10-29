/**
 * Colour maths for the skin palettes: parsing, mixing and WCAG contrast.
 * Pure functions, no DOM — the palette tests and the rendered-contrast script
 * both lean on them.
 */

export interface Rgba { r: number; g: number; b: number; a: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Parse #rgb, #rrggbb, #rrggbbaa, rgb() and rgba(). Returns null on anything else. */
export function parseColor(input: string): Rgba | null {
  const v = (input ?? '').trim().toLowerCase();
  if (v.startsWith('#')) {
    const h = v.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('').map(c => parseInt(c + c, 16));
      return { r, g, b, a: a === undefined ? 1 : a / 255 };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const m = v.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: clamp(+m[1], 0, 255), g: clamp(+m[2], 0, 255), b: clamp(+m[3], 0, 255), a: clamp(a, 0, 1) };
  }
  return null;
}

export function toHex({ r, g, b }: Rgba): string {
  const p = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`.toUpperCase();
}

/** Composite a (possibly translucent) colour over an opaque backdrop. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

/** Linear mix: t=0 gives `a`, t=1 gives `b`. Both must be opaque hex colours. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) throw new Error(`mix: unparseable colour ${a} / ${b}`);
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
    a: 1,
  });
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 2.x contrast ratio between two opaque colours, 1..21. */
export function contrastRatio(fg: string | Rgba, bg: string | Rgba): number {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!f || !b) return NaN;
  const l1 = relativeLuminance(f), l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Round to two places the way the designer's contrast-report.csv does. */
export const round2 = (n: number) => Math.round(n * 100) / 100;

export const TEXT_MIN = 4.5;
export const CONTROL_MIN = 3;
