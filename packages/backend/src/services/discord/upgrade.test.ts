// Verifier item 10: a user on the old `discord: { enabled, owner_user_id }` block has no lists, so the
// gate fails closed and every reply is blocked. That stays. What changes: at start(), a missing words
// file is logged loudly and ONE system line in the daily thread names the fix.
import { describe, it, expect, vi } from 'vitest';
import { announceMissingWords, MISSING_WORDS_NOTICE } from './upgrade.js';

function fakes(over: { status?: any; stamp?: string | null } = {}) {
  const warn = vi.fn();
  const posted: Array<{ threadId: string; text: string }> = [];
  let stamp: string | null = over.stamp ?? null;
  return {
    warn,
    posted,
    run: () => announceMissingWords({
      inspect: () => over.status ?? { status: { state: 'failed', kind: 'missing' }, message: 'cannot read the word list at /x/words.txt (ENOENT)' },
      warn,
      dailyThreadId: () => 'daily-2026-10-19',
      post: (threadId, text) => { posted.push({ threadId, text }); },
      getStamp: () => stamp,
      setStamp: (v) => { stamp = v; },
    }),
  };
}

describe('announceMissingWords', () => {
  it('logs loudly and posts one system line to the daily thread naming npm run setup', () => {
    const f = fakes();
    expect(f.run()).toBe(true);
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(String(f.warn.mock.calls[0][0])).toMatch(/npm run setup/);
    expect(String(f.warn.mock.calls[0][0])).toMatch(/blocked/i);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0].threadId).toBe('daily-2026-10-19');
    expect(f.posted[0].text).toBe(MISSING_WORDS_NOTICE);
    expect(MISSING_WORDS_NOTICE).toMatch(/npm run setup/);
    expect(MISSING_WORDS_NOTICE).toMatch(/nothing is sent|blocked/i);
  });
  it('posts ONE line per day: a second start the same day logs again but does not post again', () => {
    const f = fakes();
    f.run();
    f.run();
    expect(f.posted).toHaveLength(1);
    expect(f.warn).toHaveBeenCalledTimes(2);
  });
  it('does nothing when the words list is loaded', () => {
    const f = fakes({ status: { status: { state: 'loaded', entries: 9 } } });
    expect(f.run()).toBe(false);
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.posted).toEqual([]);
  });
  it('only the missing case: an empty or malformed list is reported by the boot log and the block notices', () => {
    for (const kind of ['empty', 'malformed', 'refused']) {
      const f = fakes({ status: { status: { state: 'failed', kind }, message: 'x' } });
      expect(f.run()).toBe(false);
      expect(f.posted).toEqual([]);
    }
  });
  it('the line carries no path', () => {
    expect(MISSING_WORDS_NOTICE).not.toMatch(/\/|\\/);
  });
});
