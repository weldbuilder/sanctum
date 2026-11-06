import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, TABS } from './settingsTabs';

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
});
