// google_write: every Google write helper passes through requireWriteClient, which asks the consent gate beside the scope check.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ reached: 0 }));
vi.mock('./embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('./vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../config.js', () => ({ getSanctumConfig: () => ({ identity: { timezone: 'UTC' }, server: { db_path: ':memory:' }, agent: { cwd: '/tmp/home' } }), PROJECT_ROOT: '/tmp/test' }));
vi.mock('./google-auth.js', () => ({
  accountForApp: () => 'acct@example.test',
  isScopeGranted: () => true,
  isWriteScopeGranted: () => true,
  getClientForApp: async () => { h.reached++; throw new Error('the client was reached'); },
  GoogleAppNotBoundError: class extends Error {},
}));

import * as g from './google.js';
import { initDb, getDb } from './db.js';
import { ConsentDeniedError, grant, setMode, turnOff } from './consent/gate.js';

const writes: Array<[string, () => Promise<unknown>]> = [
  ['createCalendarEvent', () => g.createCalendarEvent({ summary: 'x', start: '2026-11-07T10:00:00Z', end: '2026-11-07T11:00:00Z' } as any)],
  ['updateCalendarEvent', () => g.updateCalendarEvent({ id: 'e' } as any)],
  ['cancelCalendarEvent', () => g.cancelCalendarEvent('e')],
  ['createTask', () => g.createTask({ title: 'x' } as any)],
  ['updateTask', () => g.updateTask({ id: 't' } as any)],
  ['deleteTask', () => g.deleteTask({ id: 't' })],
  ['createGmailDraft', () => g.createGmailDraft({ to: 'a@example.test', subject: 's', body: 'b' } as any)],
  ['trashGmailMessage', () => g.trashGmailMessage('m')],
  ['createDocument', () => g.createDocument({ title: 'x' })],
  ['updateDocument', () => g.updateDocument({ documentId: 'd', text: 'x' } as any)],
  ['updateSheetValues', () => g.updateSheetValues({ spreadsheetId: 's', range: 'A1', values: [['x']] } as any)],
  ['appendSheetValues', () => g.appendSheetValues({ spreadsheetId: 's', range: 'A1', values: [['x']] } as any)],
  ['createYouTubePlaylist', () => g.createYouTubePlaylist({ title: 'x' } as any)],
  ['addToYouTubePlaylist', () => g.addToYouTubePlaylist({ playlistId: 'p', videoId: 'v' } as any)],
];

beforeEach(() => { initDb(':memory:'); h.reached = 0; vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('Google write helpers and google_write', () => {
  for (const [name, run] of writes) {
    it(`${name}: refused when off (the client is never reached); passes the gate when on`, async () => {
      turnOff('google_write');
      await expect(run()).rejects.toBeInstanceOf(ConsentDeniedError);
      await expect(run()).rejects.toThrow('Google write access is turned off (Settings → Permissions).');
      expect(h.reached).toBe(0);
      grant('google_write', 30);
      await expect(run()).rejects.toThrow('the client was reached');
      expect(h.reached).toBe(1);
    });
  }
  it('guard mode: refused until granted; reads are never gated', async () => {
    setMode('guard');
    await expect(g.createTask({ title: 'x' } as any)).rejects.toBeInstanceOf(ConsentDeniedError);
    await expect(g.listOpenTasks({})).rejects.toThrow('the client was reached'); // a read: past the gate with no grant
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM consent_receipts WHERE capability = 'google_write' AND outcome = 'denied'").get()).toEqual({ n: 1 });
  });
  it('the workspace tool turns the refusal into a sentence with the way to ask', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../routes/workspace-mcp.ts', import.meta.url), 'utf8');
    expect(src).toContain("if (err instanceof ConsentDeniedError) return `${err.message} To ask for a window: res ask ${err.capability} <minutes>.`;");
  });
});
