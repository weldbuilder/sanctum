/**
 * Appearance model. A *room* is the scenery behind the app; a *material* is a
 * complete colour palette for every surface that carries text. They are chosen
 * independently — each room has a suggested material, but changing the room
 * never touches a text colour, and changing the material replaces the whole
 * palette in one step.
 */

export const ROOM_IDS = ['salon', 'library', 'cloister', 'conservatory', 'night', 'ember', 'hedgewitch'] as const;
export type RoomId = (typeof ROOM_IDS)[number];

export const MATERIAL_IDS = ['black-damask', 'mounted-paper', 'midnight-ink', 'botanical-linen', 'indigo-silk', 'smoked-copper', 'hedgewitch'] as const;
export type MaterialId = (typeof MATERIAL_IDS)[number];

export type Readability = 'standard' | 'extra';
export type Orientation = 'landscape' | 'portrait';

/** One stored override set: a bare CSS variable name -> value (the same keys the legacy editor writes). */
export type TokenOverrides = Record<string, string>;

export interface AppearanceDoc {
  version: 2;
  roomId: RoomId;
  materialId: MaterialId;
  readability: Readability;
  /** Material grain/ornaments plus any available room frame. Ignored in Extra readable. */
  decorations: boolean;
  /** Colour/font customisations, kept per material so switching back restores them.
   *  'hedgewitch' is never stored here: its set is the legacy server-synced overrides. */
  customByMaterial: Partial<Record<MaterialId, TokenOverrides>>;
  revision: number;
}

/** The appearance attributes written to <html>; every skin rule in the CSS keys off these. */
export interface AppearanceAttributes {
  'data-room': RoomId;
  'data-material': MaterialId;
  'data-readability': Readability;
  /** Existing room frame/gutter gate; independent of material ornamentation. */
  'data-decor': 'on' | 'off';
  'data-surface-decor': 'on' | 'off';
}
