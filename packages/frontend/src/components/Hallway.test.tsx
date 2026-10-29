import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FloorView, PhoneHall, type FloorViewProps } from './Hallway';
import type { CompanionListing } from './hallway/hallwayState';

const ada: CompanionListing = { id: 'ada', name: 'Ada', avatar_url: '/c/ada/api/identity/avatar', status: 'ready' };
const bea: CompanionListing = { id: 'bea', name: 'Bea', avatar_url: null, status: 'ready' };
const cal: CompanionListing = { id: 'cal', name: 'cal', avatar_url: null, status: 'unavailable' };

const view = (over: Partial<FloorViewProps> = {}) => renderToStaticMarkup(
  <FloorView list={[ada, bea, cal]} floor="down" rooms={{ ada: 'Ember study', bea: null }} lit={null} openingId={null}
    onLight={() => undefined} onOpen={() => undefined} onAdd={() => undefined} {...over} />,
);

describe('a floor of the hallway', () => {
  it('a running companion has a plaque with its name, its room, and a link into it', () => {
    const html = view();
    expect(html).toContain('<b class="hw-name">Ada</b>');
    expect(html).toContain('<span class="hw-room">Ember study</span>');
    expect(html).toMatch(/<a class="hw-btn hw-btn--main" href="\/c\/ada\/" aria-label="Open Ada&#x27;s room"[^>]*>Open room<\/a>/);
    expect(html).toContain('href="/c/bea/"');
    expect(html).toContain('<span class="hw-room">Their own room</span>'); // a companion that never chose a room
    expect(html).toMatch(/<img src="[^"]*\/c\/ada\/api\/identity\/avatar" alt=""\/>/); // (after the backend's address in dev)
    expect(html).toContain('<span class="hw-initial">B</span>');
  });

  it('an unavailable companion is dimmed, has no way in, and its door does not light', () => {
    const html = view({ lit: 'cal' });
    expect(html).not.toContain('href="/c/cal/"');
    expect(html).toContain('hw-plaque hw-plaque--away');
    expect(html).toContain('The Sanctum window says why.');
    expect(html.match(/class="hw-door"/g)).toHaveLength(2); // Ada's and Bea's doors only
    expect(html).not.toContain('data-lit');
  });

  it('lights the chosen door and its plaque, on either floor, and opens it', () => {
    expect(view({ lit: 'bea' }).match(/<div class="hw-door"[^>]*data-lit=""/g)).toHaveLength(1);
    expect(view({ lit: 'bea' }).match(/<li class="hw-plaque"[^>]*data-lit=""/g)).toHaveLength(1);
    const many = Array.from({ length: 5 }, (_, i): CompanionListing => ({ id: `c${i + 1}`, name: `C${i + 1}`, avatar_url: null, status: 'ready' }));
    const up = view({ list: many, floor: 'up', rooms: {}, lit: 'c4', openingId: null });
    expect(up.match(/<div class="hw-door"[^>]*data-lit=""/g)).toHaveLength(1);
    expect(up.match(/<li class="hw-plaque"[^>]*data-lit=""/g)).toHaveLength(1);
    const opening = view({ openingId: 'ada' });
    expect(opening).toContain('data-open=""');
    expect(opening).toContain('aria-disabled="true"');
  });

  it('the next free door is "+ Add companion", on whichever floor it falls', () => {
    expect(view({ list: [ada, bea] })).toContain('+ Add companion');
    expect(view()).not.toContain('+ Add companion'); // downstairs is full
    expect(view({ floor: 'up' })).toContain('+ Add companion');
  });

  it('upstairs holds the fourth to the sixth, and the rest further along the gallery', () => {
    const many = Array.from({ length: 7 }, (_, i): CompanionListing => ({ id: `c${i + 1}`, name: `C${i + 1}`, avatar_url: null, status: 'ready' }));
    const up = view({ list: many, floor: 'up', rooms: {} });
    for (const id of ['c4', 'c5', 'c6', 'c7']) expect(up).toContain(`href="/c/${id}/"`);
    expect(up).not.toContain('href="/c/c1/"');
    expect(up).toContain('Further along the gallery');
    expect(view({ list: many, rooms: {} })).not.toContain('Further along the gallery');
  });
});

describe("a phone's walk along the hall", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i): CompanionListing => ({ id: `c${i + 1}`, name: `C${i + 1}`, avatar_url: null, status: 'ready' }));
  const walk = (over: Partial<Parameters<typeof PhoneHall>[0]> = {}) => renderToStaticMarkup(
    <PhoneHall list={[ada, bea, cal]} floor="down" rooms={{ ada: 'Ember study' }} canClimb={false} arriveAtEnd={false} openingId={null}
      onOpen={() => undefined} onAdd={() => undefined} onFloor={() => undefined} {...over} />,
  );

  it('faces the first door: lit, its plaque in front with a way in, a dot for each door and a step to the next', () => {
    const html = walk();
    expect(html.match(/class="hw-door"[^>]*data-lit=""/g)).toHaveLength(1);
    expect(html).toContain('<b class="hw-name">Ada</b>');
    expect(html).toContain('href="/c/ada/"');
    expect(html).not.toContain('href="/c/bea/"'); // one plaque at a time
    expect(html.match(/class="hp-dot"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Next door: Bea"');
    expect(html).not.toContain('hp-step--prev');
  });

  it('carries on up the stairs past the last door downstairs, and down them before the first upstairs', () => {
    const end = walk({ list: many(4), canClimb: true, arriveAtEnd: true });
    expect(end).toContain('href="/c/c3/"');
    expect(end).toContain('>Upstairs ↑</button>');
    const up = walk({ list: many(4), floor: 'up', canClimb: true });
    expect(up).toContain('href="/c/c4/"');
    expect(up).toContain('>↓ Downstairs</button>');
    expect(up).toContain('aria-label="Next door: an empty room"');
  });

  it('an unavailable companion has no way in and its door stays dark; the empty room offers "+ Add companion"', () => {
    const away = walk({ list: [cal, ada] });
    expect(away).toContain('The Sanctum window says why.');
    expect(away).not.toMatch(/class="hw-door hp-door--away"[^>]*data-lit/);
    expect(walk({ list: [], floor: 'down' })).toContain('+ Add companion');
  });
});
