/**
 * skyData — graph preparation for the ConstellationView (/mind/observatory).
 *
 * Pure functions, no DOM: takes the wing lane's GraphData contract and turns
 * it into simulation-ready stars and starlight lines. Degree (connection
 * count) is computed over the FULL edge set even when the big-sky guard
 * truncates the render — a star's brightness is its true connectedness,
 * never an artifact of what we chose to draw.
 *
 * Doctrine: read-only wing. Nothing in this file writes anywhere.
 */
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';

// ─── The wing contract (wing lane imports these) ────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  [extra: string]: unknown;
}

export interface GraphEdge {
  from: string;
  to: string;
  type?: string;
  [extra: string]: unknown;
}

export interface GraphCounts {
  nodes?: number;
  edges?: number;
  [extra: string]: unknown;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  at?: string;
  ageMin?: number;
  counts?: GraphCounts;
}

// ─── Sky types ──────────────────────────────────────────────────────────────

/** Which palette family a star belongs to. */
export type StarKind = 'user' | 'person' | 'project' | 'place' | 'concept';

export interface SkyNode extends SimulationNodeDatum {
  id: string;
  name: string;
  kind: string; // the mind's raw kind string, verbatim
  star: StarKind; // our palette family
  degree: number;
  radius: number;
  color: string;
  isUser: boolean;
  origin: GraphNode; // the untouched node from the wire, for onSelectNode
}

export interface SkyLink extends SimulationLinkDatum<SkyNode> {
  type?: string;
}

export interface Sky {
  /** Sorted brightest-first (degree desc) — label budget walks this order. */
  nodes: SkyNode[];
  links: SkyLink[];
  byId: Map<string, SkyNode>;
  neighbors: Map<string, Set<string>>;
  kinds: Set<StarKind>;
  /** Stars withheld by the big-sky guard (0 when everything is drawn). */
  hiddenCount: number;
  totalNodes: number;
  totalEdges: number;
}

// ─── Palette — people warm, concepts cool, the user's own star rose ─────────

export const STAR_COLORS: Record<StarKind, string> = {
  user: '#e88ca6', // one special star
  person: '#e2a963', // warm amber
  project: '#a893c0', // quiet violet
  place: '#8fb08a', // sage
  concept: '#6fb5ad', // cool teal (default)
};

export const STAR_LEGEND: Record<StarKind, string> = {
  user: 'you',
  person: 'people',
  project: 'projects',
  place: 'places',
  concept: 'concepts',
};

// Big-graph guard: past this many stars, start with only the brightest.
export const BIG_SKY_GUARD = 3000;
export const BRIGHTEST_CAP = 1500;

// Names (lower-cased) that identify the user's OWN star — highlighted rose and
// slightly enlarged. Empty by default in the OSS build; populate with the
// configured user's name(s) to light up their star.
const SELF_NAMES = new Set<string>([]);

export function starKindOf(node: GraphNode): StarKind {
  const name = String(node.name ?? '').trim().toLowerCase();
  const id = String(node.id ?? '').trim().toLowerCase();
  if (SELF_NAMES.has(name) || SELF_NAMES.has(id)) return 'user';
  const kind = String(node.kind ?? '').toLowerCase();
  if (/(person|people|human|partner|family|friend|being|companion|pet|sibling)/.test(kind)) return 'person';
  if (/(project|product|tool|build|work)/.test(kind)) return 'project';
  if (/(place|location|home|room|city)/.test(kind)) return 'place';
  return 'concept';
}

// ─── Preparation ────────────────────────────────────────────────────────────

export function prepareSky(data: GraphData, fullSky: boolean): Sky {
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];

  // Dedupe by id (first occurrence wins); drop id-less nodes.
  const seen = new Map<string, GraphNode>();
  for (const n of rawNodes) {
    const id = String(n?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.set(id, n);
  }

  // Degree over the FULL valid edge set — brightness is honest even when
  // the guard hides part of the sky. Self-loops and dangling edges dropped.
  const degree = new Map<string, number>();
  const validEdges: GraphEdge[] = [];
  for (const e of rawEdges) {
    const from = String(e?.from ?? '');
    const to = String(e?.to ?? '');
    if (from === to || !seen.has(from) || !seen.has(to)) continue;
    validEdges.push(e);
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }

  // Big-sky guard: keep the highest-degree stars, honestly counted.
  let kept = [...seen.values()];
  let hiddenCount = 0;
  if (!fullSky && kept.length > BIG_SKY_GUARD) {
    kept.sort(
      (a, b) => (degree.get(String(b.id)) ?? 0) - (degree.get(String(a.id)) ?? 0),
    );
    hiddenCount = kept.length - BRIGHTEST_CAP;
    kept = kept.slice(0, BRIGHTEST_CAP);
  }

  const byId = new Map<string, SkyNode>();
  const kinds = new Set<StarKind>();
  const nodes: SkyNode[] = kept.map(origin => {
    const id = String(origin.id);
    const deg = degree.get(id) ?? 0;
    const star = starKindOf(origin);
    const isUser = star === 'user';
    kinds.add(star);
    const node: SkyNode = {
      id,
      name: String(origin.name ?? id),
      kind: String(origin.kind ?? ''),
      star,
      degree: deg,
      radius: Math.min(9, 1.6 + Math.sqrt(deg) * 0.9) + (isUser ? 1.2 : 0),
      color: STAR_COLORS[star],
      isUser,
      origin,
    };
    byId.set(id, node);
    return node;
  });
  nodes.sort((a, b) => b.degree - a.degree);

  // Links + adjacency among the kept stars only.
  const links: SkyLink[] = [];
  const neighbors = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    let set = neighbors.get(a);
    if (!set) {
      set = new Set();
      neighbors.set(a, set);
    }
    set.add(b);
  };
  for (const e of validEdges) {
    const from = String(e.from);
    const to = String(e.to);
    if (!byId.has(from) || !byId.has(to)) continue;
    links.push({ source: from, target: to, type: e.type ? String(e.type) : undefined });
    touch(from, to);
    touch(to, from);
  }

  return {
    nodes,
    links,
    byId,
    neighbors,
    kinds,
    hiddenCount,
    totalNodes: seen.size,
    totalEdges: validEdges.length,
  };
}
