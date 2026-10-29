import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  addCompanionCommand, beyondTheDoors, CLIMB_ARRIVES, doorsOn, FLOORS, stopCentre, stopsOn, folderIdOf, LANDING, parseCompanions, roomName, skipTo, upstairsOpen,
  type CompanionListing,
} from './hallwayState';

const comp = (id: string, status: 'ready' | 'unavailable' = 'ready'): CompanionListing => ({ id, name: id[0].toUpperCase() + id.slice(1), avatar_url: null, status });
const house = (n: number) => Array.from({ length: n }, (_, i) => comp(`c${i + 1}`));

describe('parseCompanions', () => {
  it('accepts the contract and refuses anything else', () => {
    expect(parseCompanions([{ id: 'ada', name: 'Ada', avatar_url: null, status: 'ready' }])).toEqual([{ id: 'ada', name: 'Ada', avatar_url: null, status: 'ready' }]);
    expect(parseCompanions([{ id: 'ada', name: 'Ada', avatar_url: 5, status: 'weird' }])).toEqual([{ id: 'ada', name: 'Ada', avatar_url: null, status: 'unavailable' }]);
    for (const bad of [null, {}, 'x', [null], [{ id: 1, name: 'a' }], [{ id: 'a' }]]) expect(parseCompanions(bad)).toBeNull();
  });
});

describe('who opens straight in', () => {
  it('one companion, running, opens straight into their room; anything else is the hallway', () => {
    expect(skipTo([comp('ada')])).toBe('/c/ada/');
    expect(skipTo([comp('ada', 'unavailable')])).toBeNull(); // the hallway says why it cannot open
    expect(skipTo([])).toBeNull();
    expect(skipTo(house(2))).toBeNull();
  });
});

describe('the doors', () => {
  it('downstairs holds the first three; the next free door is "+ Add companion"', () => {
    expect(doorsOn(house(1), 'down').map((d) => d.kind)).toEqual(['companion', 'add', 'empty']);
    expect(doorsOn(house(2), 'down')).toEqual([
      { kind: 'companion', companion: comp('c1'), number: 1 }, { kind: 'companion', companion: comp('c2'), number: 2 }, { kind: 'add' },
    ]);
    expect(doorsOn(house(0), 'down').map((d) => d.kind)).toEqual(['add', 'empty', 'empty']);
  });

  it('upstairs holds the fourth to the sixth, and opens once downstairs is full (so the empty room is always reachable)', () => {
    expect(upstairsOpen(house(2))).toBe(false);
    expect(upstairsOpen(house(3))).toBe(true);
    expect(doorsOn(house(3), 'up').map((d) => d.kind)).toEqual(['add', 'empty', 'empty']);
    const up = doorsOn(house(5), 'up');
    expect(up.map((d) => d.kind)).toEqual(['companion', 'companion', 'add']);
    expect(up[0]).toMatchObject({ companion: { id: 'c4' }, number: 4 });
    expect(doorsOn(house(6), 'up').map((d) => d.kind)).toEqual(['companion', 'companion', 'companion']);
  });

  it('a seventh and on are further along the gallery, and no door says "+ Add companion" once all six are taken', () => {
    expect(beyondTheDoors(house(6))).toEqual([]);
    expect(beyondTheDoors(house(8)).map((c) => c.id)).toEqual(['c7', 'c8']);
    expect([...doorsOn(house(8), 'down'), ...doorsOn(house(8), 'up')].some((d) => d.kind === 'add')).toBe(false);
  });

  it('every door sits on the painting, its plaque on the floor below it, and each floor has its art', () => {
    expect(existsSync(join(__dirname, '../../../public', LANDING))).toBe(true); // the climb passes through it
    expect(CLIMB_ARRIVES).toBeGreaterThan(0.5); expect(CLIMB_ARRIVES).toBeLessThan(1);
    for (const f of Object.values(FLOORS)) {
      expect(f.doors).toHaveLength(3);
      expect(existsSync(join(__dirname, '../../../public', f.scene))).toBe(true);
      expect(f.anchorX).toBeGreaterThanOrEqual(0); expect(f.anchorX).toBeLessThanOrEqual(1);
      for (const d of f.doors) {
        expect(d.x - d.width / 2).toBeGreaterThan(0);
        expect(d.x + d.width / 2).toBeLessThan(100);
        expect(d.plaqueTop).toBeGreaterThanOrEqual(d.top + d.height); // never over the door it names
      }
      const xs = f.doors.map((d) => d.x);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs); // left to right, door 1 first
      // each floor's plaques stand in one even row, one size, and never overlap
      expect(new Set(f.doors.map((d) => `${d.plaqueTop}/${d.plaqueWidth}/${d.scale}`)).size).toBe(1);
      for (let k = 1; k < f.doors.length; k++) expect(f.doors[k].x - f.doors[k - 1].x).toBeGreaterThan(f.doors[k].plaqueWidth + 2);
    }
  });
});

describe('the room behind the door', () => {
  it("names the companion's chosen room, and nothing for a skin it does not know or none", () => {
    expect(roomName('ember')).toBe('Ember study');
    expect(roomName('library')).toMatch(/\S/);
    expect(roomName('gone')).toBeNull();
    expect(roomName(null)).toBeNull();
    expect(roomName(undefined)).toBeNull();
  });
});

describe('+ Add companion', () => {
  it('makes a folder name the server accepts from whatever is typed', () => {
    expect(folderIdOf('Wren')).toBe('wren');
    expect(folderIdOf('  Sir Ada the 2nd! ')).toBe('sir-ada-the-2nd');
    expect(folderIdOf('Zoë')).toBe('zoe');
    expect(folderIdOf('--x--')).toBe('x');
    expect(folderIdOf('???')).toBe('');
    const long = folderIdOf('a'.repeat(31) + ' b');
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    expect(long.endsWith('-')).toBe(false);
    for (const t of ['Wren', 'Sir Ada', 'Zoë', 'a-b', '9lives']) expect(folderIdOf(t)).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });
  it('gives the one command that moves them in', () => {
    expect(addCompanionCommand('wren')).toBe('npm run setup -- --tenant wren --create');
    expect(addCompanionCommand('')).toBe('npm run setup -- --tenant <name> --create');
  });
});

describe("a phone's walk along the hall", () => {
  it('stops at each companion and the empty room, skipping doors past it, and carries on past the sixth upstairs', () => {
    expect(stopsOn(house(2), 'down').map((s) => s.key)).toEqual(['c1', 'c2', '+add']);
    expect(stopsOn(house(0), 'down').map((s) => s.key)).toEqual(['+add']);
    expect(stopsOn(house(4), 'up').map((s) => [s.key, s.spot])).toEqual([['c4', 0], ['+add', 1]]);
    expect(stopsOn(house(8), 'up').map((s) => [s.key, s.spot])).toEqual([['c4', 0], ['c5', 1], ['c6', 2], ['c7', null], ['c8', null]]);
  });
  it('centres on the middle of the door, or the far end of the gallery', () => {
    const [first] = stopsOn(house(1), 'down');
    expect(stopCentre('down', first)).toEqual({ x: 46.7, y: 58 });
    expect(stopCentre('up', stopsOn(house(7), 'up')[3]).x).toBeGreaterThan(80);
  });
});
