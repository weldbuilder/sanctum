import { describe, it, expect, vi } from 'vitest';
vi.mock('./db.js', () => ({ getConfig: vi.fn(), setConfig: vi.fn(), getTodayThread: vi.fn(), createMessage: vi.fn() }));
vi.mock('./rolling-context.js', () => ({ getRolling: vi.fn() }));
import { composeWatchNote } from './rolling-watch.js';

const base = { checkedAt: '', dir: '', threads: [] as any[], totals: { threads: 0, failing: 0, stuck: 0, truncated: 0, segments: 0 } };
const t = (threadId: string, failing: boolean, count = 0) => ({
  threadId, segments: 1, coveredCount: 4, updatedAt: '', failures: failing ? { count, lastAt: '', lastError: 'Summary exceeds 2000 characters' } : null,
  cooldownUntil: null, failing, stuck: false, truncated: 0,
});

describe('composeWatchNote', () => {
  it('says nothing when nothing is failing and no new truncations', () => {
    expect(composeWatchNote({ ...base, threads: [t('a', false)], totals: { ...base.totals, truncated: 2 } }, 2)).toBe('');
  });
  it('names failing threads with their error', () => {
    const note = composeWatchNote({ ...base, threads: [t('velrune', true, 3), t('ok', false)] }, 0);
    expect(note).toMatch(/^\[rolling context check — 1 thread with a failing fold: velrune \(3x: Summary exceeds 2000 characters\)/);
  });
  it('counts truncations only since the last check', () => {
    const note = composeWatchNote({ ...base, totals: { ...base.totals, truncated: 5 } }, 3);
    expect(note).toMatch(/2 summaries had to be shortened/);
  });
});
