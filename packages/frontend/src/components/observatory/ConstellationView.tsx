/**
 * ConstellationView — /mind/observatory, the whole mind at once.
 *
 * The vision: "the whole mind at once… zoomable and connected." A canvas
 * force-directed constellation: dark obsidian ground, stars sized by degree,
 * colored by kind (people warm, concepts cool, the user's own star rose),
 * edges as faint starlight that brightens around whatever you touch.
 *
 * DOCTRINE (observatory wing, v1): read-only. Instruments, not a scalpel —
 * this component fetches once through the prop it's given and never writes
 * anywhere. The mind key never reaches this file; `fetchGraph` is a backend
 * proxy call owned by the wing lane.
 *
 * CONTRACT (wing lane imports `ConstellationView` lazily; default export
 * also provided):
 *   props {
 *     fetchGraph: () => Promise<GraphData>;          // required
 *     onSelectNode?: (node: GraphNode) => void;      // optional, no coupling
 *   }
 *   GraphData = { nodes:[{id,name,kind,...}], edges:[{from,to,type,...}],
 *                 at?, ageMin?, counts? }  — full shapes in skyData.ts
 *
 * Rendering: d3-force simulation + hand canvas renderer (no SVG — thousands
 * of stars stay interactive). Zoom (wheel + pinch), pan (drag), node drag,
 * hover highlight w/ neighbor focus, click → side card, search → fly-to.
 * Reduced motion: the sim settles off-screen and the sky renders frozen.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from 'd3-force';
import {
  BRIGHTEST_CAP,
  STAR_COLORS,
  STAR_LEGEND,
  prepareSky,
  type GraphData,
  type GraphNode,
  type Sky,
  type SkyLink,
  type SkyNode,
  type StarKind,
} from './skyData';

export type { GraphData, GraphNode, GraphEdge } from './skyData';

export interface ConstellationViewProps {
  /** Backend-proxied fetch — the mind key stays server-side. */
  fetchGraph: () => Promise<GraphData>;
  /**
   * Optional: fired when a star is clicked (receives the untouched wire
   * node). The wing may route it to the region browser; when absent, the
   * side card simply shows the hint. No hard coupling.
   */
  onSelectNode?: (node: GraphNode) => void;
}

// ─── Sky constants ──────────────────────────────────────────────────────────

const GROUND = '#0c0b09'; // the house's own dark
const TAU = Math.PI * 2;
const MIN_K = 0.05;
const MAX_K = 14;
const LABEL_FADE_START = 1.1; // zoom where labels begin to breathe in
const LABEL_FADE_FULL = 2.2; // zoom where they're fully awake
const LABEL_BUDGET = 220; // most labels drawn per frame (brightest first)
const CLICK_SLOP = 4; // px of movement before a press stops being a click
const STALE_MIN = 120; // >2h = the corner says so (the hooks.ts idiom)

const EDGE_BASE = 'rgba(226, 219, 208, 0.055)';
const EDGE_DIM = 'rgba(226, 219, 208, 0.016)';
const EDGE_LIT = 'rgba(228, 186, 130, 0.42)';

interface Transform {
  x: number;
  y: number;
  k: number;
}

interface Speck {
  x: number;
  y: number;
  r: number;
  a: number;
}

interface Gesture {
  mode: 'pan' | 'node' | 'pinch' | null;
  dragNode: SkyNode | null;
  reheated: boolean;
  moved: boolean;
  downX: number;
  downY: number;
  lastX: number;
  lastY: number;
  pinchDist: number;
}

type Status = 'loading' | 'ready' | 'empty' | 'error' | 'unavailable';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Deterministic PRNG for the background specks — same sky every night. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ageLabel(data: GraphData | null): { label: string; stale: boolean } | null {
  if (!data) return null;
  let mins: number | null = null;
  if (typeof data.ageMin === 'number' && Number.isFinite(data.ageMin) && data.ageMin >= 0) {
    mins = data.ageMin;
  } else if (data.at) {
    const t = Date.parse(data.at);
    if (Number.isFinite(t)) {
      const m = (Date.now() - t) / 60_000;
      if (m >= 0) mins = m;
    }
  }
  if (mins === null) return null;
  const label =
    mins < 1 ? 'just now' : mins < 60 ? `${Math.round(mins)}m old` : `${(mins / 60).toFixed(1)}h old`;
  return { label, stale: mins > STALE_MIN };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ConstellationView({ fetchGraph, onSelectNode }: ConstellationViewProps) {
  const [status, setStatus] = useState<Status>('loading');
  const [sky, setSky] = useState<Sky | null>(null);
  const [selected, setSelected] = useState<SkyNode | null>(null);
  const [query, setQuery] = useState('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const graphRef = useRef<GraphData | null>(null);
  const skyRef = useRef<Sky | null>(null);
  const simRef = useRef<Simulation<SkyNode, SkyLink> | null>(null);
  const tRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const specksRef = useRef<Speck[]>([]);
  const hoverRef = useRef<SkyNode | null>(null);
  const selectedRef = useRef<SkyNode | null>(null);
  const userMovedRef = useRef(false);
  const reducedRef = useRef(false);
  const fullSkyRef = useRef(false);
  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;

  const rafPending = useRef(false);
  const flyAnim = useRef(0);
  const renderRef = useRef<() => void>(() => {});

  const requestRender = useCallback(() => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      renderRef.current();
    });
  }, []);

  // ── Draw — reads refs only; reassigned fresh every render ──
  const draw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { w, h, dpr } = sizeRef.current;
    if (!w || !h) return;
    const { x: tx, y: ty, k } = tRef.current;
    const currentSky = skyRef.current;

    // Ground — obsidian with a breath of warmth at the center.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, w, h);
    const vignette = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.72);
    vignette.addColorStop(0, 'rgba(36, 28, 20, 0.32)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    // Distant specks — fixed screen-space dust; depth without motion.
    ctx.fillStyle = 'rgb(226, 219, 208)';
    for (const s of specksRef.current) {
      ctx.globalAlpha = s.a;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    if (!currentSky) return;

    const hover = hoverRef.current;
    const focus = hover ?? selectedRef.current;
    let focusSet: Set<string> | null = null;
    if (focus) {
      focusSet = new Set(currentSky.neighbors.get(focus.id) ?? []);
      focusSet.add(focus.id);
    }

    // World space.
    ctx.translate(tx, ty);
    ctx.scale(k, k);
    const wx0 = -tx / k;
    const wy0 = -ty / k;
    const wx1 = (w - tx) / k;
    const wy1 = (h - ty) / k;

    // Starlight lines — one batched path for the quiet ones, one for the lit.
    const lw = 1 / k;
    const basePath = new Path2D();
    const litPath = new Path2D();
    for (const l of currentSky.links) {
      const s = l.source as SkyNode;
      const t = l.target as SkyNode;
      const sx = s.x ?? 0;
      const sy = s.y ?? 0;
      const ex = t.x ?? 0;
      const ey = t.y ?? 0;
      if (
        Math.max(sx, ex) < wx0 ||
        Math.min(sx, ex) > wx1 ||
        Math.max(sy, ey) < wy0 ||
        Math.min(sy, ey) > wy1
      ) {
        continue;
      }
      const lit = focus !== null && (s.id === focus.id || t.id === focus.id);
      (lit ? litPath : basePath).moveTo(sx, sy);
      (lit ? litPath : basePath).lineTo(ex, ey);
    }
    ctx.lineWidth = lw;
    ctx.strokeStyle = focusSet ? EDGE_DIM : EDGE_BASE;
    ctx.stroke(basePath);
    if (focusSet) {
      ctx.lineWidth = lw * 1.5;
      ctx.strokeStyle = EDGE_LIT;
      ctx.stroke(litPath);
    }

    // Stars — halo then core; the rest dims while something is in focus.
    for (const n of currentSky.nodes) {
      const nx = n.x ?? 0;
      const ny = n.y ?? 0;
      if (nx < wx0 - 24 || nx > wx1 + 24 || ny < wy0 - 24 || ny > wy1 + 24) continue;
      const inFocus = !focusSet || focusSet.has(n.id);
      const alpha = inFocus ? 1 : 0.14;
      ctx.fillStyle = n.color;
      if (n.radius * k > 1.1) {
        ctx.globalAlpha = alpha * (n.isUser ? 0.22 : 0.09);
        ctx.beginPath();
        ctx.arc(nx, ny, n.radius * (n.isUser ? 3 : 2.2), 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(nx, ny, n.radius, 0, TAU);
      ctx.fill();
      if (focus && n.id === focus.id) {
        ctx.strokeStyle = 'rgba(240, 234, 222, 0.7)';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(nx, ny, n.radius + 3 / k, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Labels — screen space; hidden far out, fading in as you come closer.
    // Brightest-first within the frame, budgeted; hover/selected always show.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '11px ui-monospace, "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    const zoomAlpha = clamp((k - LABEL_FADE_START) / (LABEL_FADE_FULL - LABEL_FADE_START), 0, 1);
    if (zoomAlpha > 0.02) {
      let budget = LABEL_BUDGET;
      for (const n of currentSky.nodes) {
        if (budget <= 0) break;
        const nx = n.x ?? 0;
        const ny = n.y ?? 0;
        if (nx < wx0 || nx > wx1 || ny < wy0 || ny > wy1) continue;
        const inFocus = !focusSet || focusSet.has(n.id);
        ctx.fillStyle = `rgba(226, 219, 208, ${(zoomAlpha * (inFocus ? 0.72 : 0.1)).toFixed(3)})`;
        ctx.fillText(n.name, nx * k + tx + n.radius * k + 5, ny * k + ty);
        budget--;
      }
    }
    for (const n of [selectedRef.current, hover]) {
      if (!n) continue;
      const sx = (n.x ?? 0) * k + tx + n.radius * k + 6;
      const sy = (n.y ?? 0) * k + ty;
      const tw = ctx.measureText(n.name).width;
      ctx.fillStyle = 'rgba(12, 11, 9, 0.82)';
      ctx.fillRect(sx - 3, sy - 9, tw + 6, 18);
      ctx.fillStyle = 'rgba(240, 234, 222, 0.95)';
      ctx.fillText(n.name, sx, sy);
    }
  };
  renderRef.current = draw;

  // ── Camera helpers ──
  const zoomAround = useCallback((px: number, py: number, factor: number) => {
    const t = tRef.current;
    const k2 = clamp(t.k * factor, MIN_K, MAX_K);
    const real = k2 / t.k;
    if (real === 1) return;
    t.x = px - (px - t.x) * real;
    t.y = py - (py - t.y) * real;
    t.k = k2;
    userMovedRef.current = true;
  }, []);

  const fitToView = useCallback(() => {
    const currentSky = skyRef.current;
    const { w, h } = sizeRef.current;
    if (!currentSky || currentSky.nodes.length === 0 || !w || !h) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of currentSky.nodes) {
      const nx = n.x ?? 0;
      const ny = n.y ?? 0;
      if (nx < x0) x0 = nx;
      if (nx > x1) x1 = nx;
      if (ny < y0) y0 = ny;
      if (ny > y1) y1 = ny;
    }
    const pad = 70;
    const k = clamp(
      Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0)),
      MIN_K,
      2.5,
    );
    tRef.current = { k, x: w / 2 - (k * (x0 + x1)) / 2, y: h / 2 - (k * (y0 + y1)) / 2 };
  }, []);

  const flyTo = useCallback(
    (n: SkyNode) => {
      const { w, h } = sizeRef.current;
      const from = { ...tRef.current };
      const k2 = Math.max(from.k, 2.6);
      const target = { k: k2, x: w / 2 - k2 * (n.x ?? 0), y: h / 2 - k2 * (n.y ?? 0) };
      userMovedRef.current = true;
      cancelAnimationFrame(flyAnim.current);
      if (reducedRef.current) {
        tRef.current = target;
        requestRender();
        return;
      }
      const t0 = performance.now();
      const dur = 650;
      const step = (now: number) => {
        const p = clamp((now - t0) / dur, 0, 1);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        tRef.current = {
          k: from.k + (target.k - from.k) * e,
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
        };
        requestRender();
        if (p < 1) flyAnim.current = requestAnimationFrame(step);
      };
      flyAnim.current = requestAnimationFrame(step);
    },
    [requestRender],
  );

  const select = useCallback(
    (n: SkyNode | null) => {
      selectedRef.current = n;
      setSelected(n);
      if (n) onSelectRef.current?.(n.origin);
      requestRender();
    },
    [requestRender],
  );

  // ── Fetch ──
  const load = useCallback(async () => {
    setStatus('loading');
    setSky(null);
    select(null);
    try {
      const data = await fetchGraph();
      graphRef.current = data ?? null;
      if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) {
        setStatus('empty');
        return;
      }
      setSky(prepareSky(data, fullSkyRef.current));
      setStatus('ready');
    } catch (err) {
      // A fetcher that says the wing has no backend in this version (unavailable) gets one quiet line, not a retry.
      setStatus((err as { unavailable?: boolean } | null)?.unavailable ? 'unavailable' : 'error');
    }
  }, [fetchGraph, select]);

  useEffect(() => {
    reducedRef.current =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    void load();
  }, [load]);

  const loadFullSky = useCallback(() => {
    fullSkyRef.current = true;
    const data = graphRef.current;
    if (!data) return;
    userMovedRef.current = false;
    select(null);
    setSky(prepareSky(data, true));
  }, [select]);

  // ── Simulation — rebuilt whenever the sky changes ──
  useEffect(() => {
    skyRef.current = sky;
    hoverRef.current = null;
    simRef.current?.stop();
    simRef.current = null;
    if (!sky) {
      requestRender();
      return;
    }

    const sim = forceSimulation<SkyNode>(sky.nodes)
      .force(
        'link',
        forceLink<SkyNode, SkyLink>(sky.links)
          .id(d => d.id)
          .distance(32)
          .strength(l => {
            const s = l.source as SkyNode;
            const t = l.target as SkyNode;
            return 1 / Math.min(8, Math.max(1, Math.min(s.degree, t.degree)));
          }),
      )
      .force('charge', forceManyBody<SkyNode>().strength(-42).theta(0.9).distanceMax(600))
      .force('x', forceX<SkyNode>(0).strength(0.04))
      .force('y', forceY<SkyNode>(0).strength(0.04))
      .force('collide', forceCollide<SkyNode>(n => n.radius + 1.5).iterations(1))
      .alphaDecay(0.035);
    simRef.current = sim;
    fitToView(); // frame the phyllotaxis seed so the settle is watchable

    let settleRaf = 0;
    if (reducedRef.current) {
      // Reduced motion: no drift on screen — settle silently, render frozen.
      sim.stop();
      requestRender(); // show the seeded sky immediately; honest, not blank
      const settle = () => {
        let i = 0;
        while (sim.alpha() > sim.alphaMin() && i < 40) {
          sim.tick();
          i++;
        }
        if (sim.alpha() > sim.alphaMin()) {
          settleRaf = requestAnimationFrame(settle);
        } else {
          if (!userMovedRef.current) fitToView();
          requestRender();
        }
      };
      settleRaf = requestAnimationFrame(settle);
    } else {
      sim.on('tick', requestRender);
      sim.on('end', () => {
        if (!userMovedRef.current) fitToView();
        requestRender();
      });
    }

    return () => {
      cancelAnimationFrame(settleRaf);
      sim.stop();
    };
  }, [sky, fitToView, requestRender]);

  // ── Canvas sizing (DPR-aware) ──
  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const rand = mulberry32(0x510e57a5);
      const count = clamp(Math.round((w * h) / 9000), 80, 320);
      const specks: Speck[] = [];
      for (let i = 0; i < count; i++) {
        specks.push({
          x: rand() * w,
          y: rand() * h,
          r: rand() < 0.85 ? 1 : 1.5,
          a: 0.035 + rand() * 0.09,
        });
      }
      specksRef.current = specks;
      requestRender();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [requestRender]);

  // ── Pointer + wheel interaction (registered once; reads refs) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pointers = new Map<number, { x: number; y: number }>();
    const g: Gesture = {
      mode: null,
      dragNode: null,
      reheated: false,
      moved: false,
      downX: 0,
      downY: 0,
      lastX: 0,
      lastY: 0,
      pinchDist: 0,
    };

    const toWorld = (px: number, py: number) => {
      const { x, y, k } = tRef.current;
      return { wx: (px - x) / k, wy: (py - y) / k };
    };

    const findNode = (px: number, py: number): SkyNode | null => {
      const sim = simRef.current;
      if (!sim) return null;
      const { wx, wy } = toWorld(px, py);
      return sim.find(wx, wy, 12 / tRef.current.k + 4) ?? null;
    };

    const setHover = (n: SkyNode | null) => {
      if (hoverRef.current === n) return;
      hoverRef.current = n;
      canvas.style.cursor = n ? 'pointer' : 'grab';
      requestRender();
    };

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      cancelAnimationFrame(flyAnim.current);
      if (pointers.size === 2) {
        // Second finger lands: whatever we were doing becomes a pinch.
        if (g.dragNode) {
          g.dragNode.fx = null;
          g.dragNode.fy = null;
          g.dragNode = null;
        }
        const [p1, p2] = [...pointers.values()];
        g.mode = 'pinch';
        g.pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        g.lastX = (p1.x + p2.x) / 2;
        g.lastY = (p1.y + p2.y) / 2;
        g.moved = true;
        return;
      }
      const hit = findNode(e.offsetX, e.offsetY);
      g.mode = hit ? 'node' : 'pan';
      g.dragNode = hit;
      g.reheated = false;
      g.moved = false;
      g.downX = e.offsetX;
      g.downY = e.offsetY;
      g.lastX = e.offsetX;
      g.lastY = e.offsetY;
      if (!hit) canvas.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pointers.size === 0) {
        // Nothing pressed: hover.
        setHover(findNode(e.offsetX, e.offsetY));
        return;
      }
      const entry = pointers.get(e.pointerId);
      if (!entry) return;
      entry.x = e.offsetX;
      entry.y = e.offsetY;

      if (g.mode === 'pinch' && pointers.size === 2) {
        const [p1, p2] = [...pointers.values()];
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        if (g.pinchDist > 0 && dist > 0) zoomAround(midX, midY, dist / g.pinchDist);
        tRef.current.x += midX - g.lastX;
        tRef.current.y += midY - g.lastY;
        g.pinchDist = dist;
        g.lastX = midX;
        g.lastY = midY;
        requestRender();
        return;
      }

      if (!g.moved && Math.hypot(e.offsetX - g.downX, e.offsetY - g.downY) > CLICK_SLOP) {
        g.moved = true;
      }

      if (g.mode === 'node' && g.dragNode) {
        if (!g.moved) return;
        const { wx, wy } = toWorld(e.offsetX, e.offsetY);
        if (reducedRef.current) {
          // Frozen sky: move just this star — no reheat, no drift.
          g.dragNode.x = wx;
          g.dragNode.y = wy;
        } else {
          g.dragNode.fx = wx;
          g.dragNode.fy = wy;
          if (!g.reheated) {
            g.reheated = true;
            simRef.current?.alphaTarget(0.12).restart();
          }
        }
        requestRender();
        return;
      }

      if (g.mode === 'pan') {
        tRef.current.x += e.offsetX - g.lastX;
        tRef.current.y += e.offsetY - g.lastY;
        g.lastX = e.offsetX;
        g.lastY = e.offsetY;
        if (g.moved) userMovedRef.current = true;
        requestRender();
      }
    };

    const endPointer = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);

      if (g.mode === 'pinch') {
        if (pointers.size === 1) {
          const [p] = [...pointers.values()];
          g.mode = 'pan';
          g.lastX = p.x;
          g.lastY = p.y;
        } else if (pointers.size === 0) {
          g.mode = null;
        }
        return;
      }

      if (g.mode === 'node' && g.dragNode) {
        const node = g.dragNode;
        node.fx = null;
        node.fy = null;
        if (g.reheated) simRef.current?.alphaTarget(0);
        if (!g.moved) select(node);
        g.dragNode = null;
      } else if (g.mode === 'pan' && !g.moved) {
        select(null); // a quiet tap on empty sky closes the card
      }
      g.mode = null;
      canvas.style.cursor = hoverRef.current ? 'pointer' : 'grab';
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAround(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0016));
      requestRender();
    };

    const onLeave = () => setHover(null);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endPointer);
      canvas.removeEventListener('pointercancel', endPointer);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [requestRender, select, zoomAround]);

  useEffect(() => () => cancelAnimationFrame(flyAnim.current), []);

  // ── Search ──
  const matches = useMemo(() => {
    if (!sky) return [];
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return sky.nodes
      .filter(n => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .slice(0, 8);
  }, [sky, query]);

  const pickMatch = useCallback(
    (n: SkyNode) => {
      setQuery('');
      select(n);
      flyTo(n);
    },
    [select, flyTo],
  );

  // ── Honesty corner ──
  const age = ageLabel(graphRef.current);
  const shownNodes = sky?.nodes.length ?? 0;
  const totalNodes = graphRef.current?.counts?.nodes ?? sky?.totalNodes ?? 0;
  const shownEdges = sky?.links.length ?? 0;
  const legendKinds: StarKind[] = sky
    ? (['user', 'person', 'concept', 'project', 'place'] as StarKind[]).filter(k => sky.kinds.has(k))
    : [];

  return (
    <div className="cv-root" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="cv-canvas"
        aria-label="the constellation — every star a memory-holder, every line a relation"
      />

      {/* ── Search ── */}
      {status === 'ready' && (
        <div className="cv-search">
          <input
            className="cv-search-input"
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="find a star…"
            spellCheck={false}
            aria-label="find a star"
          />
          {matches.length > 0 && (
            <ul className="cv-search-results" role="listbox">
              {matches.map(n => (
                <li key={n.id}>
                  <button type="button" className="cv-search-hit" onClick={() => pickMatch(n)}>
                    <span className="cv-dot" style={{ background: n.color }} />
                    <span className="cv-hit-name">{n.name}</span>
                    <span className="cv-hit-kind">{n.kind || n.star}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Side card — read-only: name, kind, degree, a doorway hint ── */}
      {selected && (
        <aside className="cv-card" aria-label={selected.name}>
          <button
            type="button"
            className="cv-card-close"
            onClick={() => select(null)}
            aria-label="close"
          >
            ×
          </button>
          <div className="cv-card-name">
            <span className="cv-dot cv-dot-lg" style={{ background: selected.color }} />
            {selected.name}
          </div>
          <div className="cv-card-meta">
            {selected.kind || selected.star}
            {' · '}
            {selected.degree} connection{selected.degree === 1 ? '' : 's'}
          </div>
          <div className="cv-card-hint">open in the region browser →</div>
        </aside>
      )}

      {/* ── Big-sky guard — honest about what's withheld ── */}
      {status === 'ready' && sky && sky.hiddenCount > 0 && (
        <div className="cv-guard">
          brightest {BRIGHTEST_CAP.toLocaleString()} of {sky.totalNodes.toLocaleString()} stars —{' '}
          {sky.hiddenCount.toLocaleString()} dimmer ones withheld{' '}
          <button type="button" className="cv-guard-btn" onClick={loadFullSky}>
            load the full sky
          </button>
        </div>
      )}

      {/* ── Honesty corner: counts + data age ── */}
      {status === 'ready' && sky && (
        <div className="cv-corner">
          {shownNodes.toLocaleString()}
          {totalNodes > shownNodes ? ` of ${totalNodes.toLocaleString()}` : ''} stars ·{' '}
          {shownEdges.toLocaleString()} lines
          {age && (
            <span className={`cv-age${age.stale ? ' stale' : ''}`}>
              {' · '}
              {age.label}
              {age.stale && ' · stale'}
            </span>
          )}
        </div>
      )}

      {/* ── Legend — only the kinds actually in this sky ── */}
      {status === 'ready' && legendKinds.length > 1 && (
        <div className="cv-legend">
          {legendKinds.map(k => (
            <span className="cv-legend-item" key={k}>
              <span className="cv-dot" style={{ background: STAR_COLORS[k] }} />
              {STAR_LEGEND[k]}
            </span>
          ))}
        </div>
      )}

      {/* ── Loading / empty / error ── */}
      {status === 'loading' && (
        <div className="cv-state">
          <div className="cv-pulse" />
        </div>
      )}
      {status === 'unavailable' && (
        <div className="cv-state">
          <div className="cv-empty">
            <div className="cv-empty-sub">not available in this version</div>
          </div>
        </div>
      )}
      {(status === 'empty' || status === 'error') && (
        <div className="cv-state">
          <div className="cv-empty">
            <div className="cv-empty-title">no sky tonight</div>
            <div className="cv-empty-sub">
              {status === 'empty'
                ? 'the mind reported nothing to chart yet.'
                : 'the window would not open — the graph could not be fetched.'}
            </div>
            <button type="button" className="cv-retry" onClick={() => void load()}>
              look again
            </button>
          </div>
        </div>
      )}

      <style>{`
        .cv-root {
          position: relative;
          width: 100%;
          height: clamp(24rem, 72vh, 48rem);
          overflow: hidden;
          background: ${GROUND};
          border-radius: 0.5rem;
          border: 1px solid rgba(232, 224, 208, 0.08);
        }
        .cv-canvas { display: block; width: 100%; height: 100%; }

        .cv-dot {
          display: inline-block;
          width: 0.4rem; height: 0.4rem;
          border-radius: 50%;
          flex: none;
        }
        .cv-dot-lg { width: 0.55rem; height: 0.55rem; }

        /* ── Search ── */
        .cv-search {
          position: absolute;
          top: 0.75rem; left: 0.75rem;
          width: min(16rem, calc(100% - 1.5rem));
          z-index: 3;
        }
        .cv-search-input {
          width: 100%;
          background: rgba(20, 16, 12, 0.78);
          border: 1px solid rgba(232, 224, 208, 0.12);
          border-radius: 0.375rem;
          padding: 0.4rem 0.65rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.72rem;
          color: var(--text-primary, #e2dbd0);
          outline: none;
        }
        .cv-search-input::placeholder { color: var(--text-muted, #6a6258); font-style: italic; }
        .cv-search-input:focus { border-color: rgba(201, 168, 124, 0.45); }
        .cv-search-results {
          list-style: none;
          margin: 0.3rem 0 0; padding: 0.25rem;
          background: rgba(16, 13, 10, 0.94);
          border: 1px solid rgba(232, 224, 208, 0.1);
          border-radius: 0.375rem;
          max-height: 16rem;
          overflow-y: auto;
        }
        .cv-search-hit {
          display: flex; align-items: center; gap: 0.5rem;
          width: 100%;
          background: none; border: none; cursor: pointer;
          padding: 0.35rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.78rem;
          color: rgba(232, 224, 208, 0.8);
          text-align: left;
        }
        .cv-search-hit:hover { background: rgba(232, 224, 208, 0.07); }
        .cv-hit-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cv-hit-kind {
          margin-left: auto;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.58rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
          flex: none;
        }

        /* ── Side card ── */
        .cv-card {
          position: absolute;
          top: 0.75rem; right: 0.75rem;
          width: min(15rem, calc(100% - 1.5rem));
          z-index: 3;
          background: rgba(16, 13, 10, 0.92);
          border: 1px solid rgba(232, 224, 208, 0.12);
          border-radius: 0.5rem;
          padding: 0.8rem 0.95rem 0.85rem;
        }
        .cv-card-close {
          position: absolute;
          top: 0.3rem; right: 0.45rem;
          background: none; border: none; cursor: pointer;
          color: var(--text-muted, #6a6258);
          font-size: 1rem; line-height: 1;
          padding: 0.15rem;
        }
        .cv-card-close:hover { color: var(--text-primary, #e2dbd0); }
        .cv-card-name {
          display: flex; align-items: center; gap: 0.45rem;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1.05rem;
          color: var(--text-primary, #e2dbd0);
          padding-right: 1rem;
          overflow-wrap: anywhere;
        }
        .cv-card-meta {
          margin-top: 0.3rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.66rem;
          letter-spacing: 0.05em;
          color: rgba(232, 224, 208, 0.55);
        }
        .cv-card-hint {
          margin-top: 0.55rem;
          font-style: italic;
          font-size: 0.72rem;
          color: var(--amber, #c9a87c);
          opacity: 0.75;
        }

        /* ── Guard + corner + legend ── */
        .cv-guard {
          position: absolute;
          bottom: 2.4rem; left: 50%;
          transform: translateX(-50%);
          z-index: 3;
          background: rgba(16, 13, 10, 0.9);
          border: 1px solid rgba(224, 168, 96, 0.22);
          border-radius: 0.375rem;
          padding: 0.35rem 0.7rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.64rem;
          color: rgba(224, 168, 96, 0.85);
          white-space: nowrap;
          max-width: calc(100% - 1.5rem);
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .cv-guard-btn {
          background: none;
          border: 1px solid rgba(224, 168, 96, 0.35);
          border-radius: 0.25rem;
          padding: 0.1rem 0.45rem;
          margin-left: 0.35rem;
          font: inherit;
          color: rgba(224, 168, 96, 0.95);
          cursor: pointer;
        }
        .cv-guard-btn:hover { background: rgba(224, 168, 96, 0.1); }
        .cv-corner {
          position: absolute;
          bottom: 0.6rem; left: 0.75rem;
          z-index: 2;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.62rem;
          letter-spacing: 0.05em;
          color: rgba(232, 224, 208, 0.42);
          pointer-events: none;
        }
        .cv-age.stale { color: #d4a843; }
        .cv-legend {
          position: absolute;
          bottom: 0.6rem; right: 0.75rem;
          z-index: 2;
          display: flex; gap: 0.7rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6rem;
          letter-spacing: 0.05em;
          color: rgba(232, 224, 208, 0.45);
          pointer-events: none;
        }
        .cv-legend-item { display: inline-flex; align-items: center; gap: 0.3rem; }

        /* ── States ── */
        .cv-state {
          position: absolute;
          inset: 0;
          z-index: 2;
          display: flex; align-items: center; justify-content: center;
        }
        .cv-pulse {
          width: 0.375rem; height: 0.375rem; border-radius: 50%;
          background: var(--amber-dim, #a08960);
          animation: cv-pulse 1.4s ease-in-out infinite;
        }
        @keyframes cv-pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50%      { opacity: 1;   transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .cv-pulse { animation: none; opacity: 0.7; }
        }
        .cv-empty { text-align: center; max-width: 20rem; padding: 1rem; }
        .cv-empty-title {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1.15rem;
          color: rgba(232, 224, 208, 0.7);
        }
        .cv-empty-sub {
          margin-top: 0.4rem;
          font-style: italic;
          font-size: 0.78rem;
          color: var(--text-muted, #6a6258);
        }
        .cv-retry {
          margin-top: 0.8rem;
          background: none;
          border: 1px solid rgba(232, 224, 208, 0.18);
          border-radius: 0.3rem;
          padding: 0.3rem 0.8rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.66rem;
          letter-spacing: 0.08em;
          color: rgba(232, 224, 208, 0.6);
          cursor: pointer;
        }
        .cv-retry:hover { border-color: rgba(201, 168, 124, 0.45); color: var(--text-primary, #e2dbd0); }

        @media (max-width: 600px) {
          .cv-card { top: auto; bottom: 3.4rem; right: 0.75rem; }
          .cv-legend { display: none; }
        }
      `}</style>
    </div>
  );
}

export default ConstellationView;
