import { describe, expect, it } from 'vitest';
import manifest from './asset-manifest.json';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CORNER_CSS_PX, EMBER_CORNER_SVG, MOBILE_BREAKPOINT_PX, ROOMS, ROOM_LIST, allRegistryPaths, flippedCornerDataUri, pickOrientation, sceneFor } from './rooms';
import { MATERIALS } from './materials';
import { ROOM_IDS } from './types';

describe('room registry', () => {
  it('has the six artwork rooms plus the legacy kitchen, each with a matched default material', () => {
    expect(ROOM_LIST.map(r => r.id)).toEqual([...ROOM_IDS]);
    expect(ROOMS.salon.defaultMaterial).toBe('black-damask');
    expect(ROOMS.library.defaultMaterial).toBe('mounted-paper');
    expect(ROOMS.cloister.defaultMaterial).toBe('midnight-ink');
    expect(ROOMS.conservatory.defaultMaterial).toBe('botanical-linen');
    expect(ROOMS.night.defaultMaterial).toBe('indigo-silk');
    expect(ROOMS.ember.defaultMaterial).toBe('smoked-copper');
    expect(ROOMS.hedgewitch.defaultMaterial).toBe('hedgewitch');
    for (const r of ROOM_LIST) expect(MATERIALS[r.defaultMaterial].defaultRoom).toBe(r.id);
  });

  it('keeps the manifest fallback colour of every room so a missing image never flashes white', () => {
    const m = manifest.rooms as Record<string, { fallback: string }>;
    for (const id of ['salon', 'library', 'cloister', 'conservatory', 'night', 'ember']) expect(ROOMS[id as keyof typeof ROOMS].fallback).toBe(m[id].fallback);
    for (const r of ROOM_LIST) expect(r.fallback).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('takes crop positions from the manifest: landscape 50% 50%, portrait 50% 0%; Ember anchors left-bottom (0% 100%) on both, as its artwork notes say', () => {
    for (const r of ROOM_LIST.filter(r => !r.legacy && r.id !== 'ember')) {
      expect(r.landscape.position).toBe('50% 50%');
      expect(r.portrait.position).toBe('50% 0%');
    }
    // The study is composed for the centre in both orientations (its portrait is its own crop: shelves, chesterfield, the city window).
    expect(ROOMS.ember.landscape.position).toBe('50% 50%');
    expect(ROOMS.ember.portrait.position).toBe('50% 50%');
  });

  it('Ember: its own folder, the ember-* names, the pack\'s fallback colour, a separate portrait composition and one corner file', () => {
    const e = ROOMS.ember;
    expect(e.name).toBe('Ember study');
    expect(e.fallback).toBe('#211B18');
    expect([e.landscape.webp, e.landscape.jpeg, e.portrait.webp, e.portrait.jpeg, e.thumbnail]).toEqual([
      '/skins/ember/ember-study-desktop-v2.webp', '/skins/ember/ember-study-desktop-v2.jpg', '/skins/ember/ember-study-mobile-v2.webp', '/skins/ember/ember-study-mobile-v2.jpg', '/skins/ember/ember-study-thumbnail-v2.webp',
    ]);
    expect(e.landscape.webp).not.toBe(e.portrait.webp);
    expect(new Set(Object.values(e.corners!)).size).toBe(1);
    expect(e.cornersFlipped).toBe(true);
    expect(ROOM_LIST.filter(r => r.cornersFlipped).map(r => r.id)).toEqual(['ember']);
    for (const p of allRegistryPaths().filter(p => p.startsWith('/skins/ember/'))) expect(p).not.toMatch(/walnut/); // one naming set, no aliases
  });

  it('the other three Ember corners are the shipped corner turned, and the text they are made from is the shipped file', () => {
    const file = readFileSync(fileURLToPath(new URL('../../public/skins/ember/ember-copper-corner.svg', import.meta.url)), 'utf8');
    expect(EMBER_CORNER_SVG).toBe(file);
    for (const w of ['tr', 'br', 'bl'] as const) {
      const uri = decodeURIComponent(flippedCornerDataUri(w).replace('data:image/svg+xml,', ''));
      expect(uri).toContain("<g transform=");
      expect(uri).toContain('d="M1 48V13Q1 1 13 1H48"'.replace(/"/g, "'"));
      expect(uri.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|<script|<image/);
    }
  });

  it('draws corners at 48 CSS px', () => {
    expect(CORNER_CSS_PX).toBe(48);
  });
});

describe('orientation', () => {
  it('is portrait at and below the shell breakpoint, landscape above it', () => {
    expect(MOBILE_BREAKPOINT_PX).toBe(768);
    expect(pickOrientation(320)).toBe('portrait');
    expect(pickOrientation(390)).toBe('portrait');
    expect(pickOrientation(767)).toBe('portrait');
    expect(pickOrientation(768)).toBe('portrait'); // the shell swaps to the top bar at max-width: 768px
    expect(pickOrientation(769)).toBe('landscape');
    expect(pickOrientation(1280)).toBe('landscape');
  });
});

describe('scene selection from the manifest', () => {
  it('returns one file: the room, the viewport orientation, WebP first', () => {
    const phone = sceneFor('library', 390);
    expect(phone.orientation).toBe('portrait');
    expect(phone.url).toBe('/skins/library/mobile-v1.webp');
    expect(phone.position).toBe('50% 0%');
    expect(phone.size).toBe('cover');
    const desk = sceneFor('night', 1280);
    expect(desk.url).toBe('/skins/night/desktop-v1.webp');
    expect(desk.position).toBe('50% 50%');
  });

  it('falls back to the JPEG when WebP is not decodable', () => {
    expect(sceneFor('cloister', 1280, false).url).toBe('/skins/cloister/desktop-v1.jpg');
    expect(sceneFor('cloister', 390, false).url).toBe('/skins/cloister/mobile-v1.jpg');
  });

  it('treats an unknown room as the legacy kitchen rather than failing', () => {
    expect(sceneFor('not-a-room', 1280).url).toBe('/hedgewitch/kitchen.webp');
  });

  it('only ever points at paths the manifest lists', () => {
    const listed = new Set(manifest.files.map(f => f.path.replace(/^public/, '')));
    for (const p of allRegistryPaths()) expect(listed.has(p), p).toBe(true);
  });
});
