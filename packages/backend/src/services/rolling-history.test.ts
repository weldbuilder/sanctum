import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ turns: [] as any[], serve: null as any, fail: false, max: { chars: 24000, turns: 30 } }));
vi.mock('../config.js', () => ({ getSanctumConfig: () => ({ agent: { rolling: { history_max_chars: h.max.chars, history_max_turns: h.max.turns } } }) }));
vi.mock('./rolling-context.js', () => ({
  getRolling: () => ({
    readTurns: async () => { if (h.fail) throw new Error('db gone'); return h.turns; },
    readForServe: async () => h.serve,
    maybeCompact: () => Promise.resolve({}),
  }),
}));
import { assembleRollingHistory, withoutCurrentMessage } from './rolling-history.js';

const t = (id: string, role: 'user' | 'assistant', content: string) => ({ id, role, content, at: '' });

describe('assembleRollingHistory', () => {
  it('serves summary, newest turns, and leaves out the message being answered', async () => {
    h.fail = false; h.max = { chars: 24000, turns: 30 };
    h.turns = [t('1', 'user', 'old u'), t('2', 'assistant', 'old a'), t('3', 'user', 'mid u'), t('4', 'assistant', 'mid a'), t('5', 'user', 'hello there')];
    h.serve = { covered: 2, block: 'SUMMARY', segments: 1, render: (d: number) => `SUMMARY${d ? ` (dropped ${d})` : ''}` };
    const r = await assembleRollingHistory('th', 'hello there', false);
    expect(r.summary).toBe('SUMMARY');
    expect(r.lines).toEqual(['USER: mid u', 'ASSISTANT: mid a']);
    expect(r.notice).toBe('');
    expect(r.rolling).not.toBeNull();
  });
  it('budgets the tail by turns and says how many were left out', async () => {
    h.max = { chars: 24000, turns: 1 };
    const r = await assembleRollingHistory('th', 'hello there', false);
    expect(r.lines).toEqual(['ASSISTANT: mid a']);
    expect(r.notice).toMatch(/^\[1 earlier turn of this thread is not shown here/);
    expect(r.summary).toBe('SUMMARY (dropped 1)');
  });
  it('fails soft: a broken history source yields an honest notice, never a throw', async () => {
    h.fail = true;
    const r = await assembleRollingHistory('th', 'x', false);
    expect(r.rolling).toBeNull();
    expect(r.lines).toEqual([]);
    expect(r.notice).toMatch(/could not be loaded/);
  });
});

describe('withoutCurrentMessage', () => {
  it('drops the unanswered copy of the current message, loosely matched', () => {
    const turns = [t('1', 'user', 'a'), t('2', 'assistant', 'b'), t('3', 'user', 'hi')];
    expect(withoutCurrentMessage(turns, '[tone] hi', false).map((x) => x.id)).toEqual(['1', '2']);
    expect(withoutCurrentMessage(turns, 'hi', true).length).toBe(3); // wakes save no user message
  });
});
