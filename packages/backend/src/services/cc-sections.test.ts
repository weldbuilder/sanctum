// The Command Center's per-section visibility: every section defaults on, a stored false hides it (data untouched), and the
// page's own Automations panel is a section like the rest.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('./db.js', () => ({
  getDb: () => { throw new Error('not used'); },
  getConfig: (k: string) => store.get(k) ?? null,
  setConfig: (k: string, v: string) => { store.set(k, v); },
}));

import { CC_SECTION_KEYS, getSections, setSections } from './cc.js';

describe('Command Center sections', () => {
  beforeEach(() => store.clear());

  it('lists the page panels with the data sections', () => {
    expect([...CC_SECTION_KEYS]).toEqual(['cycle', 'care', 'routines', 'wins', 'countdowns', 'automations']);
  });

  it('defaults every section on, and a malformed row too', () => {
    expect(Object.values(getSections()).every(Boolean)).toBe(true);
    store.set('cc.sections', '{not json');
    expect(Object.values(getSections()).every(Boolean)).toBe(true);
  });

  it('hides only what is set false, and keeps it across reads', () => {
    expect(setSections({ automations: false })).toMatchObject({ automations: false, care: true });
    expect(getSections()).toMatchObject({ automations: false, care: true });
    expect(setSections({ automations: true, wins: false })).toMatchObject({ automations: true, wins: false });
  });

  it('a row written before the Automations panel existed still reads it as on', () => {
    store.set('cc.sections', JSON.stringify({ cycle: false, care: true, routines: true, wins: true, countdowns: true }));
    expect(getSections()).toMatchObject({ cycle: false, automations: true });
  });
});
