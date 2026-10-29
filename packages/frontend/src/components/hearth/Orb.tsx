/**
 * Orb — the shared gradient orb. Extracted from HomeView's mantelpiece orb
 * construction (core/highlight/edge custom props, ::before swirl 24s,
 * ::after breath halo) into a reusable primitive.
 *
 * Gradient spec (Iris, /command v2):
 *   — CORE stays the dominant color. Identity, non-negotiable legibility.
 *   — BLEND takes the OUTER light: the breath-halo radial + the outer
 *     box-shadow glow render in the blend color, and the blend tints the
 *     inner swirl at ~0.4 alpha.
 *   — blend dim/black = VIGNETTE: darkened outer edge stop + reduced halo.
 *     Never a glow.
 *   — no blend = the current, quieter self-glow.
 *
 * State changes crossfade ~2.4s via @property-registered <color> custom
 * props (the six --orb-* vars interpolate on class change). Browsers without
 * registered-property support get an opacity-crossfade fallback. The global
 * prefers-reduced-motion kill (index.css) zeroes both transition and
 * animation durations = instant swap.
 *
 * Size presets:
 *   mantel  140px — full shape vocabulary (sphere/crescent/pulse/cluster/
 *                   ember/spire/halo/fracture)
 *   waiting  56px ┐
 *   band     40px ├ shapes collapse to sphere/ember;
 *   ember    32px ┘ fracture renders as tremor+dim
 *
 * Class root is `horb` (hearth orb) — deliberately NOT `orb`, so this never
 * collides with HomeView's still-mounted inline styles until Lane C rewires
 * the consumers.
 */
import React, { useEffect, useRef, useState } from 'react';

export type OrbColor =
  | 'amber' | 'lavender' | 'teal' | 'deep-red' | 'dim'
  | 'gold' | 'rose' | 'violet' | 'white' | 'black';
export type OrbShape =
  | 'sphere' | 'crescent' | 'pulse' | 'cluster' | 'ember' | 'spire' | 'halo' | 'fracture';
export type OrbMotion =
  | 'slow-drift' | 'hold-steady' | 'fast-flicker' | 'surge' | 'tremor';
export type OrbIntensity = 'dull' | 'normal' | 'bright' | 'neon';
export type OrbSize = 'mantel' | 'waiting' | 'band' | 'ember';

export interface OrbProps {
  /** Dominant color — the core's identity. Unknown strings fall back to amber. */
  color: OrbColor | (string & {});
  /** Second color — takes the outer light (halo + glow) and tints the swirl.
   *  'dim' | 'black' render as a vignette instead. Absent = quiet self-glow. */
  blend?: OrbColor | (string & {});
  shape?: OrbShape | (string & {});
  motion?: OrbMotion | (string & {});
  intensity?: OrbIntensity | (string & {});
  size: OrbSize;
  className?: string;
}

const KNOWN_COLORS = new Set<string>([
  'amber', 'lavender', 'teal', 'deep-red', 'dim', 'gold', 'rose', 'violet', 'white', 'black',
]);
const SMALL_SHAPES = new Set<string>(['sphere', 'ember']);

// Registered custom properties interpolate as colors → the 2.4s crossfade.
// Browsers without CSS.registerProperty/@property get the opacity fallback.
const supportsRegisteredProps =
  typeof window !== 'undefined' && 'CSSPropertyRule' in window;

export function Orb({
  color,
  blend,
  shape,
  motion,
  intensity,
  size,
  className,
}: OrbProps) {
  const safeColor = KNOWN_COLORS.has(color) ? color : 'amber';
  const safeBlend = blend && KNOWN_COLORS.has(blend) ? blend : undefined;

  // Collapse the shape vocabulary at small sizes.
  let effShape = shape || 'sphere';
  let effMotion = motion || '';
  let effIntensity = intensity || 'normal';
  if (size !== 'mantel') {
    if (effShape === 'fracture') {
      // fracture renders as tremor+dim below mantel size
      effShape = 'sphere';
      effMotion = 'tremor';
      if (effIntensity === 'normal') effIntensity = 'dull';
    } else if (!SMALL_SHAPES.has(effShape)) {
      effShape = 'sphere';
    }
  }

  // Opacity-crossfade fallback for browsers without registered properties.
  const [xfade, setXfade] = useState(false);
  const prev = useRef({ color: safeColor, blend: safeBlend });
  useEffect(() => {
    if (prev.current.color === safeColor && prev.current.blend === safeBlend) return;
    prev.current = { color: safeColor, blend: safeBlend };
    if (supportsRegisteredProps) return;
    if (typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setXfade(true);
    const t = setTimeout(() => setXfade(false), 2400);
    return () => clearTimeout(t);
  }, [safeColor, safeBlend]);

  const cls = [
    'horb',
    `horb-size-${size}`,
    `is-${safeColor}`,
    safeBlend ? `blend-${safeBlend}` : '',
    `shape-${effShape}`,
    effMotion ? `motion-${effMotion}` : '',
    `intensity-${effIntensity}`,
    xfade ? 'horb-xfade' : '',
    className || '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} aria-hidden="true">
      {/* The painted glass orb is the body (the .horb background). Over it: its own light, turning slowly both ways
          inside the rim so the ribbon seems to flow; then the companion's colour; then a glint crossing the glass. */}
      <span className="horb-flow" />
      <span className="horb-flow horb-flow-back" />
      <span className="horb-tint" />
      <span className="horb-glint" />
      <style>{`
        /* ── Registered color props — these are what crossfades interpolate ── */
        @property --orb-highlight {
          syntax: '<color>'; inherits: true; initial-value: rgba(255, 220, 160, 0.7);
        }
        @property --orb-core {
          syntax: '<color>'; inherits: true; initial-value: #d89b3a;
        }
        @property --orb-edge {
          syntax: '<color>'; inherits: true; initial-value: rgba(90, 58, 14, 0.55);
        }
        @property --orb-glow {
          syntax: '<color>'; inherits: true; initial-value: rgba(216, 155, 58, 0.45);
        }
        @property --orb-outer {
          syntax: '<color>'; inherits: true; initial-value: rgba(216, 155, 58, 0.45);
        }
        @property --orb-swirl {
          syntax: '<color>'; inherits: true; initial-value: transparent;
        }

        /* ── Orb base ── the painted glass orb (house art), its glow in the outer light */
        .horb {
          position: relative;
          width: var(--orb-d);
          height: var(--orb-d);
          border-radius: 50%;
          background: url(/house/orb-glass-v1.webp) center / 100% 100% no-repeat;
          box-shadow:
            0 0 calc(var(--orb-d) * 0.286) calc(var(--orb-d) * 0.057) var(--orb-outer),
            0 0 calc(var(--orb-d) * 0.686) calc(var(--orb-d) * 0.229) var(--orb-outer);
          animation: horb-breathe 6s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) infinite;
          will-change: transform, opacity;
          transition:
            --orb-highlight 2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)),
            --orb-core      2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)),
            --orb-edge      2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)),
            --orb-glow      2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)),
            --orb-outer     2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)),
            --orb-swirl     2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));

          /* Default (amber, no blend = quiet self-glow) */
          --orb-highlight: rgba(255, 220, 160, 0.7);
          --orb-core: #d89b3a;
          --orb-edge: rgba(90, 58, 14, 0.55);
          --orb-glow: rgba(216, 155, 58, 0.45);
          --orb-outer: rgba(216, 155, 58, 0.45);
          --orb-swirl: transparent;
        }

        /* ── Size presets ── */
        .horb-size-mantel  { --orb-d: 140px; }
        .horb-size-waiting { --orb-d: 56px; }
        .horb-size-band    { --orb-d: 40px; }
        .horb-size-ember   { --orb-d: 32px; }

        /* Opacity-crossfade fallback (no registered-property support) */
        .horb.horb-xfade { animation: horb-breathe 6s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) infinite, horb-xfade 2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)); }
        @keyframes horb-xfade {
          0%   { opacity: 1; }
          35%  { opacity: 0.45; }
          100% { opacity: 1; }
        }

        /* Inner swirl — the blend colour (~0.4 alpha via the blend tables below), turning very slowly in the glass.
           With no blend it is transparent: the painting's own light carries the life. */
        .horb::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background:
            radial-gradient(circle at 30% 25%, var(--orb-swirl) 0%, transparent 52%),
            radial-gradient(circle at 70% 75%, var(--orb-swirl) 0%, transparent 55%);
          mix-blend-mode: screen;
          opacity: 0.55;
          animation: horb-swirl 24s linear infinite;
          z-index: 2;
        }

        /* The ribbon's flow: the painting's own light, masked inside the rim, turning one way and (mirrored, slower,
           fainter) the other. The rim and the glass reflections in the base stay still, so the light moves inside. */
        .horb-flow {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: url(/house/orb-glass-v1.webp) center / 100% 100% no-repeat;
          -webkit-mask-image: radial-gradient(circle, #000 0%, #000 46%, transparent 70%);
          mask-image: radial-gradient(circle, #000 0%, #000 46%, transparent 70%);
          mix-blend-mode: screen;
          opacity: 0.42;
          animation: horb-flow 28s linear infinite;
          pointer-events: none;
          z-index: 1;
        }
        .horb-flow-back { opacity: 0.24; animation: horb-flow-back 41s linear infinite; }
        @keyframes horb-flow      { from { transform: rotate(0deg); }               to { transform: rotate(360deg); } }
        @keyframes horb-flow-back { from { transform: scaleX(-1) rotate(0deg); }    to { transform: scaleX(-1) rotate(-360deg); } }

        /* The companion's colour, laid over the glass and its light as hue (luminance stays the painting's), held to
           the orb by the painting's own outline. Amber, gold and white sit close to the painting's warm light. */
        .horb-tint {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: var(--orb-core);
          -webkit-mask: url(/house/orb-glass-v1.webp) center / 100% 100% no-repeat;
          mask: url(/house/orb-glass-v1.webp) center / 100% 100% no-repeat;
          mix-blend-mode: var(--orb-tint-mode, color);
          opacity: var(--orb-tint, 0.55);
          transition: opacity 2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));
          pointer-events: none;
          z-index: 3;
        }

        /* A glint crossing the glass now and then. */
        .horb-glint {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          overflow: hidden;
          background: linear-gradient(115deg, transparent 38%, rgba(255, 250, 240, 0.55) 50%, transparent 62%) no-repeat;
          background-size: 260% 100%;
          background-position: 160% 0;
          mix-blend-mode: screen;
          opacity: 0.7;
          animation: horb-glint 9s ease-in-out infinite;
          pointer-events: none;
          z-index: 4;
        }
        @keyframes horb-glint {
          0%, 55%   { background-position: 160% 0; }
          85%, 100% { background-position: -60% 0; }
        }

        /* Outer breath halo — counterpoint to orb scale. Runs in the OUTER
           light color (--orb-outer): the blend when present, self-glow when not. */
        .horb::after {
          content: '';
          position: absolute;
          inset: calc(var(--orb-d) * -0.229);
          border-radius: 50%;
          background: radial-gradient(circle, var(--orb-outer) 0%, transparent 60%);
          opacity: 0.55;
          animation: horb-halo 6s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) infinite;
          pointer-events: none;
          z-index: -1;
        }

        @keyframes horb-breathe {
          0%, 100% { transform: scale(0.97); opacity: 0.94; }
          50%       { transform: scale(1.03); opacity: 1; }
        }
        @keyframes horb-halo {
          0%, 100% { transform: scale(1.08); opacity: 0.7; }
          50%       { transform: scale(0.92); opacity: 0.45; }
        }
        @keyframes horb-swirl {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }

        /* ── Color variants ── core identity + quiet self-glow default */
        .horb.is-amber {
          --orb-highlight: rgba(255, 220, 160, 0.7);
          --orb-core: #d89b3a;
          --orb-edge: rgba(90, 58, 14, 0.55);
          --orb-glow: rgba(216, 155, 58, 0.45);
          --orb-outer: rgba(216, 155, 58, 0.45);
        }
        .horb.is-lavender {
          --orb-highlight: rgba(220, 200, 240, 0.55);
          --orb-core: #a893c0;
          --orb-edge: #4a3e5e;
          --orb-glow: rgba(168, 147, 192, 0.45);
          --orb-outer: rgba(168, 147, 192, 0.45);
        }
        .horb.is-teal {
          --orb-highlight: rgba(180, 240, 230, 0.55);
          --orb-core: #5eaba5;
          --orb-edge: #1e4a47;
          --orb-glow: rgba(94, 171, 165, 0.45);
          --orb-outer: rgba(94, 171, 165, 0.45);
        }
        .horb.is-deep-red {
          --orb-highlight: rgba(255, 110, 110, 0.55);
          --orb-core: #b8324a;
          --orb-edge: #4a0a14;
          --orb-glow: rgba(184, 50, 74, 0.55);
          --orb-outer: rgba(184, 50, 74, 0.55);
        }
        .horb.is-dim {
          --orb-highlight: rgba(200, 200, 220, 0.20);
          --orb-core: #3a3a45;
          --orb-edge: #1a1a22;
          --orb-glow: rgba(60, 60, 80, 0.30);
          --orb-outer: rgba(60, 60, 80, 0.30);
          animation-duration: 9s;
        }
        /* champagne gold — paler + cooler than amber */
        .horb.is-gold {
          --orb-highlight: rgba(240, 220, 170, 0.75);
          --orb-core: #c4a872;
          --orb-edge: rgba(110, 88, 40, 0.55);
          --orb-glow: rgba(196, 168, 114, 0.48);
          --orb-outer: rgba(196, 168, 114, 0.48);
        }
        /* rose — warm pink */
        .horb.is-rose {
          --orb-highlight: rgba(255, 195, 210, 0.62);
          --orb-core: #c97a8f;
          --orb-edge: rgba(92, 32, 48, 0.55);
          --orb-glow: rgba(201, 122, 143, 0.50);
          --orb-outer: rgba(201, 122, 143, 0.50);
        }
        /* violet — deeper + bluer than lavender */
        .horb.is-violet {
          --orb-highlight: rgba(214, 184, 248, 0.60);
          --orb-core: #8a5cc0;
          --orb-edge: rgba(52, 26, 84, 0.55);
          --orb-glow: rgba(138, 92, 192, 0.50);
          --orb-outer: rgba(138, 92, 192, 0.50);
        }
        /* white — near-pure light */
        .horb.is-white {
          --orb-highlight: rgba(255, 255, 255, 0.88);
          --orb-core: #e8e4dc;
          --orb-edge: rgba(150, 145, 138, 0.50);
          --orb-glow: rgba(232, 228, 220, 0.42);
          --orb-outer: rgba(232, 228, 220, 0.42);
        }
        /* black — cold void, faint edge glow */
        .horb.is-black {
          --orb-highlight: rgba(120, 120, 145, 0.28);
          --orb-core: #17171c;
          --orb-edge: #08080b;
          --orb-glow: rgba(44, 44, 60, 0.42);
          --orb-outer: rgba(44, 44, 60, 0.42);
        }

        /* How strongly the colour tints the painted glass. Its light is already a warm amber-white, so amber, gold
           and white barely touch it; the cool and red colours take it over; dim and black darken it (multiply). */
        .horb.is-amber    { --orb-tint: 0.22; }
        .horb.is-gold     { --orb-tint: 0.32; }
        .horb.is-white    { --orb-tint: 0; }
        .horb.is-lavender,
        .horb.is-teal,
        .horb.is-rose     { --orb-tint: 0.62; }
        .horb.is-violet,
        .horb.is-deep-red { --orb-tint: 0.68; }
        .horb.is-dim      { --orb-tint: 0.55; --orb-tint-mode: multiply; }
        .horb.is-black    { --orb-tint: 0.78; --orb-tint-mode: multiply; }

        /* ── Blend variants ── the second color takes the OUTER light
           (halo + outer glow via --orb-outer) and tints the inner swirl
           at ~0.4 alpha (via --orb-swirl). Core identity untouched. */
        .horb.blend-amber    { --orb-outer: rgba(216, 155,  58, 0.42); --orb-swirl: rgba(216, 155,  58, 0.40); }
        .horb.blend-lavender { --orb-outer: rgba(168, 147, 192, 0.42); --orb-swirl: rgba(168, 147, 192, 0.40); }
        .horb.blend-teal     { --orb-outer: rgba( 94, 171, 165, 0.42); --orb-swirl: rgba( 94, 171, 165, 0.40); }
        .horb.blend-deep-red { --orb-outer: rgba(184,  50,  74, 0.48); --orb-swirl: rgba(184,  50,  74, 0.40); }
        .horb.blend-gold     { --orb-outer: rgba(196, 168, 114, 0.45); --orb-swirl: rgba(196, 168, 114, 0.40); }
        .horb.blend-rose     { --orb-outer: rgba(201, 122, 143, 0.45); --orb-swirl: rgba(201, 122, 143, 0.40); }
        .horb.blend-violet   { --orb-outer: rgba(138,  92, 192, 0.45); --orb-swirl: rgba(138,  92, 192, 0.40); }
        .horb.blend-white    { --orb-outer: rgba(232, 228, 220, 0.38); --orb-swirl: rgba(232, 228, 220, 0.40); }

        /* dim / black blends = VIGNETTE — darkened outer edge stop, reduced
           halo, dark (non-luminous) outer shadow. Never a glow. */
        .horb.blend-dim {
          --orb-edge: rgba(18, 18, 26, 0.85);
          --orb-outer: rgba(8, 8, 12, 0.50);
          --orb-swirl: rgba(40, 40, 55, 0.40);
        }
        .horb.blend-black {
          --orb-edge: rgba(6, 6, 9, 0.92);
          --orb-outer: rgba(2, 2, 4, 0.55);
          --orb-swirl: rgba(10, 10, 16, 0.45);
        }
        .horb.blend-dim::after,
        .horb.blend-black::after { opacity: 0.22; }
        /* The vignette on the painted glass: the edge darkened in its stop, and no glint (never a glow). */
        .horb.blend-dim .horb-glint,
        .horb.blend-black .horb-glint {
          background: radial-gradient(circle, transparent 50%, var(--orb-edge) 100%);
          background-size: 100% 100%;
          mix-blend-mode: normal;
          opacity: 1;
          animation: none;
        }

        /* ── Motion variants ── */
        .horb.motion-slow-drift {
          animation: horb-breathe 9s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) infinite;
        }
        .horb.motion-slow-drift::after {
          animation: horb-halo 9s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) infinite;
        }
        .horb.motion-surge {
          animation: horb-surge 5s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) infinite;
        }
        @keyframes horb-surge {
          0%, 100% { transform: scale(0.94); opacity: 0.85; }
          60%       { transform: scale(1.12); opacity: 1; }
        }
        .horb.motion-fast-flicker {
          animation: horb-flicker 3.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) infinite;
        }
        @keyframes horb-flicker {
          0%, 100% { transform: scale(1);    opacity: 1;    filter: brightness(1); }
          25%       { transform: scale(0.98); opacity: 0.85; filter: brightness(0.92); }
          55%       { transform: scale(1.02); opacity: 1;    filter: brightness(1.08); }
          78%       { transform: scale(0.99); opacity: 0.92; filter: brightness(0.96); }
        }
        .horb.motion-tremor {
          animation: horb-tremor 1.2s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) infinite;
        }
        @keyframes horb-tremor {
          0%, 100% { transform: translate(0,    0)    scale(1); }
          25%       { transform: translate(-1.5px,  1px) scale(0.99); }
          50%       { transform: translate( 1.5px, -1px) scale(1.01); }
          75%       { transform: translate(-1px,  -1px) scale(0.995); }
        }
        .horb.motion-hold-steady {
          animation: none;
        }
        .horb.motion-hold-steady.horb-xfade {
          animation: horb-xfade 2.4s var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));
        }
        .horb.motion-hold-steady::after {
          animation: none;
          opacity: 0.45;
        }
        .horb.motion-hold-steady.blend-dim::after,
        .horb.motion-hold-steady.blend-black::after { opacity: 0.22; }
        /* The light inside follows the motion: still when holding steady, quicker when flickering or surging. */
        .horb.motion-hold-steady::before,
        .horb.motion-hold-steady .horb-flow,
        .horb.motion-hold-steady .horb-glint { animation: none; }
        .horb.motion-fast-flicker .horb-flow      { animation-duration: 12s; }
        .horb.motion-fast-flicker .horb-flow-back { animation-duration: 17s; }
        .horb.motion-surge .horb-flow             { animation-duration: 18s; }
        .horb.motion-surge .horb-flow-back        { animation-duration: 26s; }

        /* ── Intensity variants ── (dull | normal | bright | neon)
           normal is the base; the others scale glow spread + brightness.
           All outer shadows run in --orb-outer so blends carry through. */
        .horb.intensity-dull {
          filter: brightness(0.82) saturate(0.85);
          box-shadow:
            0 0 calc(var(--orb-d) * 0.171) calc(var(--orb-d) * 0.029) var(--orb-outer),
            0 0 calc(var(--orb-d) * 0.4)   calc(var(--orb-d) * 0.114) var(--orb-outer);
        }
        .horb.intensity-bright {
          filter: brightness(1.14) saturate(1.08);
          box-shadow:
            0 0 calc(var(--orb-d) * 0.371) calc(var(--orb-d) * 0.086) var(--orb-outer),
            0 0 calc(var(--orb-d) * 0.857) calc(var(--orb-d) * 0.314) var(--orb-outer);
        }
        .horb.intensity-neon {
          filter: brightness(1.3) saturate(1.35);
          box-shadow:
            0 0 calc(var(--orb-d) * 0.429) calc(var(--orb-d) * 0.114) var(--orb-outer),
            0 0 var(--orb-d)               calc(var(--orb-d) * 0.4)   var(--orb-outer),
            0 0 calc(var(--orb-d) * 0.029) calc(var(--orb-d) * 0.007) var(--orb-highlight);
        }
        .horb.intensity-neon::after { opacity: 0.85; }
        .horb.intensity-neon.blend-dim::after,
        .horb.intensity-neon.blend-black::after { opacity: 0.3; }

        /* ── Shape variants ── (sphere is the default circle above)
           Full vocabulary renders at mantel size only; the component collapses
           shapes to sphere/ember below mantel, so fixed-px geometry here is
           mantel-scaled by construction (ember is calc-scaled — all sizes). */

        /* crescent — moon-sliver, partial/waning. */
        .horb.shape-crescent {
          mask-image: radial-gradient(circle at 69% 50%, transparent 40%, black 42%);
          -webkit-mask-image: radial-gradient(circle at 69% 50%, transparent 40%, black 42%);
        }

        /* pulse — active, heartbeat. Halo becomes an expanding ring. */
        .horb.shape-pulse::after {
          inset: 0;
          background: transparent;
          border-radius: 50%;
          border: 1.5px solid var(--orb-core);
          box-shadow: 0 0 6px 2px var(--orb-outer);
          animation: horb-pulse-ring 2.5s ease-out infinite;
          opacity: 0;
          z-index: 2;
        }
        @keyframes horb-pulse-ring {
          0%   { transform: scale(1.0); opacity: 0.72; }
          100% { transform: scale(2.5); opacity: 0; }
        }

        /* cluster — many-threaded, scattered. */
        .horb.shape-cluster {
          width: 80px;
          height: 80px;
        }
        .horb.shape-cluster::before {
          content: '';
          position: absolute;
          inset: unset;
          top: -28px;
          right: -22px;
          left: auto;
          bottom: auto;
          width: 46px;
          height: 46px;
          border-radius: 50%;
          background: radial-gradient(circle, var(--orb-highlight) 0%, var(--orb-core) 62%, transparent 100%);
          box-shadow: 0 0 14px 4px var(--orb-outer);
          mix-blend-mode: normal;
          opacity: 0.82;
          transform: none;
          animation: horb-breathe 7.5s ease-in-out infinite reverse;
        }
        .horb.shape-cluster::after {
          content: '';
          position: absolute;
          inset: unset;
          top: auto;
          right: auto;
          bottom: -20px;
          left: -26px;
          width: 34px;
          height: 34px;
          border-radius: 50%;
          background: radial-gradient(circle, var(--orb-highlight) 0%, var(--orb-core) 62%, transparent 100%);
          box-shadow: 0 0 10px 3px var(--orb-outer);
          opacity: 0.62;
          z-index: 1;
          animation: horb-breathe 9s ease-in-out infinite;
        }

        /* ember — low coal, live flicker at edges. Calc-scaled: all sizes. */
        .horb.shape-ember {
          width: calc(var(--orb-d) * 1.057);
          height: calc(var(--orb-d) * 0.8);
          border-radius: 50% 50% 46% 46% / 54% 54% 46% 46%;
          animation: horb-ember 4s ease-in-out infinite;
        }
        @keyframes horb-ember {
          0%, 100% { transform: scaleX(1.05) scaleY(0.93); filter: brightness(0.86) saturate(0.90); }
          28%       { transform: scaleX(1.02) scaleY(0.97); filter: brightness(0.93) saturate(0.98); }
          58%       { transform: scaleX(1.07) scaleY(0.91); filter: brightness(0.80) saturate(0.85); }
          82%       { transform: scaleX(1.03) scaleY(0.95); filter: brightness(0.90) saturate(0.93); }
        }

        /* spire — focused, reaching upward, teardrop-flame. */
        .horb.shape-spire {
          width: 82px;
          height: 164px;
          border-radius: 42% 42% 50% 50% / 38% 38% 62% 62%;
          animation: horb-spire 5s ease-in-out infinite;
        }
        .horb.shape-spire::before {
          border-radius: 42% 42% 50% 50% / 38% 38% 62% 62%;
        }
        @keyframes horb-spire {
          0%, 100% { transform: scaleX(1.00) scaleY(1.00); }
          38%       { transform: scaleX(0.94) scaleY(1.04); }
          72%       { transform: scaleX(1.05) scaleY(0.97); }
        }

        /* halo — open, held, ring-shaped. */
        .horb.shape-halo {
          background: transparent;
          border: 13px solid var(--orb-core);
          box-shadow:
            0 0 28px 8px var(--orb-outer),
            0 0 6px 1px var(--orb-core),
            inset 0 0 18px 5px var(--orb-outer);
        }
        .horb.shape-halo::before {
          display: none;
        }
        /* The ring is the core colour itself: no glass inside it. */
        .horb.shape-halo .horb-flow,
        .horb.shape-halo .horb-tint,
        .horb.shape-halo .horb-glint { display: none; }

        /* In a shape that is not round (the coal, the flame) the painted glass keeps its proportions: it covers. */
        .horb.shape-ember, .horb.shape-spire { background-size: cover; }
        .horb.shape-ember .horb-flow, .horb.shape-spire .horb-flow { background-size: cover; border-radius: inherit; }
        .horb.shape-ember .horb-tint, .horb.shape-spire .horb-tint { -webkit-mask-size: cover; mask-size: cover; border-radius: inherit; }
        .horb.shape-ember .horb-glint, .horb.shape-spire .horb-glint { border-radius: inherit; }

        /* fracture — strained, broken, fissured. (Mantel only; collapses to
           sphere + tremor + dull below.) */
        .horb.shape-fracture {
          clip-path: polygon(
            50% 0%,
            65% 5%,   74% 1%,
            90% 16%,
            97% 32%,  91% 36%,
            100% 52%,
            90% 66%,  94% 73%,
            76% 90%,
            50% 100%,
            26% 90%,  14% 76%,
            20% 68%,
            0% 52%,
            9% 36%,   3% 30%,
            18% 14%,
            38% 3%,   44% 7%
          );
          animation: horb-fracture 8s ease-in-out infinite;
        }
        @keyframes horb-fracture {
          0%, 100% {
            clip-path: polygon(
              50% 0%,
              65% 5%,   74% 1%,
              90% 16%,
              97% 32%,  91% 36%,
              100% 52%,
              90% 66%,  94% 73%,
              76% 90%,
              50% 100%,
              26% 90%,  14% 76%,
              20% 68%,
              0% 52%,
              9% 36%,   3% 30%,
              18% 14%,
              38% 3%,   44% 7%
            );
            transform: scale(0.97);
          }
          50% {
            clip-path: polygon(
              50% 2%,
              63% 4%,   76% 0%,
              92% 14%,
              96% 34%,  89% 38%,
              100% 50%,
              92% 64%,  96% 75%,
              74% 92%,
              50% 98%,
              28% 92%,  12% 78%,
              18% 70%,
              0% 50%,
              11% 34%,  4% 28%,
              20% 12%,
              40% 4%,   42% 9%
            );
            transform: scale(1.03);
          }
        }

        /* ── Reduced motion — the global kill (index.css) zeroes all animation
           + transition durations, making state changes instant. Shape-specific
           keyframes additionally cut here so static frames rest well. ── */
        @media (prefers-reduced-motion: reduce) {
          .horb.shape-ember    { animation: none; }
          .horb.shape-spire    { animation: none; }
          .horb.shape-fracture { animation: none; }
          .horb.shape-pulse::after { animation: none; opacity: 0.5; transform: scale(1.9); }
          .horb.shape-cluster::before,
          .horb.shape-cluster::after { animation: none; }
        }
      `}</style>
    </div>
  );
}

export default Orb;
