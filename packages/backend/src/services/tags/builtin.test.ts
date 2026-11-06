// builtin.ts: the voice tag steps aside in voice mode, and the module can be the first import of a fresh module graph.
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('tags/builtin import order', () => {
  it('importing tags/builtin.ts FIRST does not hit the IMAGE_SIZES temporal dead zone', async () => {
    vi.resetModules();
    await expect(import('./builtin.js')).resolves.toBeTruthy();
  });
  it('importing imagegen/index.ts FIRST does not either', async () => {
    vi.resetModules();
    await expect(import('../imagegen/index.js')).resolves.toBeTruthy();
  });
});

describe('isVoiceModeActive (ws.ts)', () => {
  beforeEach(() => { vi.resetModules(); });
  it('true only while an open socket for the user has voice mode on', async () => {
    const ws = await import('../ws.js');
    expect(ws.isVoiceModeActive('user')).toBe(false);
    const spy = vi.spyOn(ws.registry, 'getConnectionsForUser');
    spy.mockReturnValue([{ voiceModeEnabled: false }] as any);
    expect(ws.isVoiceModeActive('user')).toBe(false);
    spy.mockReturnValue([{ voiceModeEnabled: false }, { voiceModeEnabled: true }] as any);
    expect(ws.isVoiceModeActive('user')).toBe(true);
    spy.mockRestore();
  });
});
