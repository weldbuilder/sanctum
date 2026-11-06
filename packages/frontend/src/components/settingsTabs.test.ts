import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, TABS, tabFromSearch } from './settingsTabs';
import { COMMANDS } from './CommandPalette';

describe('the Settings tab list', () => {
  it('is six tabs plus Status, in this order', () => {
    expect(TABS.map(t => t.label)).toEqual(['you & them', 'mind', 'rhythm', 'channels', 'permissions', 'look', 'status']);
    expect(TABS.map(t => t.id)).toEqual(['you', 'mind', 'rhythm', 'channels', 'permissions', 'look', 'status']);
  });
  it('opens on You & them, and every tab says what is in it', () => {
    expect(DEFAULT_TAB).toBe('you');
    for (const t of TABS) expect(t.sub.length).toBeGreaterThan(5);
  });
  it('keeps the eleven old sections out of the nav', () => {
    for (const old of ['preferences', 'orchestrator', 'registered MCPs', 'skills & status', 'usage & model', 'integrations', 'plugins', 'identity', 'logs', 'appearance']) {
      expect(TABS.map(t => t.label)).not.toContain(old);
    }
  });
  it('the command palette has one settings link per tab, named like the tab, and ?tab= opens it', () => {
    const links = COMMANDS.filter(c => c.group === 'settings');
    expect(links.map(c => c.name.toLowerCase())).toEqual(TABS.map(t => t.label));
    for (const t of TABS) {
      const link = links.find(c => c.name.toLowerCase() === t.label)!;
      expect(tabFromSearch(link.to.slice(link.to.indexOf('?')))).toBe(t.id);
    }
    expect(tabFromSearch('')).toBe(DEFAULT_TAB);
    expect(tabFromSearch('?tab=nope')).toBe(DEFAULT_TAB);
  });
});
