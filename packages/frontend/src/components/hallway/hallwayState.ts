// The hallway's logic with no React in it: the companion list it is drawn from, which door each companion has, where those doors are on the
// painted scenes, and the one command that moves a new companion in. Hallway.tsx draws it.
//
// The house has two floors. Downstairs (the foyer with three doors under the gallery) holds companions 1-3; upstairs (the gallery itself) holds
// companions 4-6. Each painted door is a companion's door, so the positions below are measured on the art, in percent of the whole scene.

import { isRoomId, ROOMS } from '../../theme/rooms';

/** One entry of GET /api/companions (docs/MULTI-TENANT.md, "Household mode"). */
export interface CompanionListing { id: string; name: string; avatar_url: string | null; status: 'ready' | 'unavailable' }

/** The answer of GET /api/companions, or null for anything that is not one. */
export function parseCompanions(raw: unknown): CompanionListing[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CompanionListing[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') return null;
    const r = c as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
    out.push({ id: r.id, name: r.name, avatar_url: typeof r.avatar_url === 'string' ? r.avatar_url : null, status: r.status === 'ready' ? 'ready' : 'unavailable' });
  }
  return out;
}

/** With exactly one companion, and that one running, there is nothing to choose: the house opens straight into their room. */
export function skipTo(list: CompanionListing[]): string | null {
  return list.length === 1 && list[0].status === 'ready' ? `/c/${list[0].id}/` : null;
}

export type Floor = 'down' | 'up';
export const DOORS_PER_FLOOR = 3;
export const HOUSE_DOORS = DOORS_PER_FLOOR * 2;

/** A door on the art: its centre across, its top and height, its width, and where its plaque sits on the floor in front of it (all % of the scene).
 *  `scale` sizes a floor's plaques (the gallery's are a little smaller). */
export interface DoorSpot { x: number; top: number; height: number; width: number; plaqueTop: number; plaqueWidth: number; scale: number }

export interface FloorArt {
  scene: string; title: string; doors: DoorSpot[];
  /** Where a window narrower than the painting crops it from (0 keeps the left edge, 1 the right): away from the doors. */
  anchorX: number;
}

export const FLOORS: Record<Floor, FloorArt> = {
  down: {
    scene: '/house/hallway-downstairs-v1.webp',
    title: 'The house',
    doors: [
      { x: 46.7, top: 42, height: 32, width: 9.5, plaqueTop: 76, plaqueWidth: 14, scale: 1 },
      { x: 64.6, top: 42, height: 32, width: 9.5, plaqueTop: 76, plaqueWidth: 14, scale: 1 },
      { x: 83.5, top: 42, height: 32, width: 9.5, plaqueTop: 76, plaqueWidth: 14, scale: 1 },
    ],
    anchorX: 0.75, // the doors are right of centre; the staircase side gives way
  },
  up: {
    // The gallery, painted square-on: three doors in a row, a railing either side.
    scene: '/house/hallway-gallery-v1.webp',
    title: 'Upstairs',
    doors: [
      { x: 31.1, top: 22.5, height: 47.6, width: 9.8, plaqueTop: 73, plaqueWidth: 14, scale: 1 },
      { x: 50.7, top: 22, height: 48.1, width: 9.8, plaqueTop: 73, plaqueWidth: 14, scale: 1 },
      { x: 72.2, top: 22.5, height: 47.6, width: 9.8, plaqueTop: 73, plaqueWidth: 14, scale: 1 },
    ],
    anchorX: 0.5,
  },
};

/** The landing: the gallery seen at an angle from the top of the stairs. Never a floor of its own; the climb between the floors passes through it. */
export const LANDING = '/house/hallway-landing-v1.webp';
/** How long the climb between the floors takes. */
export const CLIMB_MS = 1700;
/** The point of the climb where the destination floor is fully in view (and takes over from the climb), as a fraction of it. */
export const CLIMB_ARRIVES = 0.84;

/** What stands at one door: a companion, the empty room the next one would move into, or nothing yet. */
export type DoorOccupant = { kind: 'companion'; companion: CompanionListing; number: number } | { kind: 'add' } | { kind: 'empty' };

/** The floor a companion's door is on (the first three downstairs, the next three upstairs); past the sixth, the gallery's far end. */
export function floorOfIndex(i: number): Floor { return i < DOORS_PER_FLOOR ? 'down' : 'up'; }

/** The three doors of a floor, in order. The next free door in the house (on whichever floor it falls) is the "+ Add companion" one. */
export function doorsOn(list: CompanionListing[], floor: Floor): DoorOccupant[] {
  const first = floor === 'down' ? 0 : DOORS_PER_FLOOR;
  return Array.from({ length: DOORS_PER_FLOOR }, (_, k): DoorOccupant => {
    const i = first + k;
    if (i < list.length) return { kind: 'companion', companion: list[i], number: i + 1 };
    if (i === list.length) return { kind: 'add' };
    return { kind: 'empty' };
  });
}

/** Companions past the sixth door: listed at the far end of the gallery, upstairs. */
export const beyondTheDoors = (list: CompanionListing[]): CompanionListing[] => list.slice(HOUSE_DOORS);

/** One stop on a phone's walk along a floor: a companion's door, the empty room, or (past the sixth) the gallery's far end, where there is no door. */
export interface Stop { key: string; occupant: Exclude<DoorOccupant, { kind: 'empty' }>; spot: number | null }

/** The stops along a floor, in walking order. A phone faces one at a time; the walk carries on up (or down) the stairs at either end. */
export function stopsOn(list: CompanionListing[], floor: Floor): Stop[] {
  const stops: Stop[] = [];
  doorsOn(list, floor).forEach((o, k) => {
    if (o.kind === 'companion') stops.push({ key: o.companion.id, occupant: o, spot: k });
    else if (o.kind === 'add') stops.push({ key: '+add', occupant: o, spot: k });
  });
  if (floor === 'up') beyondTheDoors(list).forEach((c, i) => stops.push({ key: c.id, occupant: { kind: 'companion', companion: c, number: HOUSE_DOORS + 1 + i }, spot: null }));
  return stops;
}

/** Where the phone's camera centres for a stop (% of the scene): the middle of its door, or the far end of the gallery. */
export function stopCentre(floor: Floor, stop: Stop): { x: number; y: number } {
  if (stop.spot === null) return { x: 86, y: 45 };
  const d = FLOORS[floor].doors[stop.spot];
  return { x: d.x, y: d.top + d.height / 2 };
}

/** Upstairs opens once downstairs is full: then it holds the fourth companion, or the empty room the fourth would move into. */
export const upstairsOpen = (list: CompanionListing[]): boolean => list.length >= DOORS_PER_FLOOR;

/** The room behind a companion's door: the name of the skin it chose (GET /c/<id>/api/identity `skin`), or null when it never chose one. */
export function roomName(skin: unknown): string | null {
  return isRoomId(skin) ? ROOMS[skin].name : null;
}

/** A companion's folder name, from whatever the person types: what the server accepts as an id (a-z, 0-9, dashes, up to 32, not starting with a dash). */
export function folderIdOf(typed: string): string {
  return typed.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
}

/** The command that moves a new companion in (docs/MULTI-TENANT.md, "Adding a tenant: the wizard"). */
export const addCompanionCommand = (id: string): string => `npm run setup -- --tenant ${id || '<name>'} --create`;
