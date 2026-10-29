import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    hooks: { context_injection: false, safe_write_prefixes: [], workspace_root: '', vault_path: '', extra_write_paths: [] },
    agent: { cwd: '/home/user/companion', mcp_json_path: '' },
    integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } },
  }),
  PROJECT_ROOT: '/tmp/test',
}));
vi.mock('./db.js', () => ({
  getMessages: vi.fn().mockReturnValue([]),
  getConfig: vi.fn().mockReturnValue(null),
  setConfig: vi.fn(),
  getActiveTriggers: vi.fn().mockReturnValue([]),
  createMessage: vi.fn(),
  updateThreadActivity: vi.fn(),
}));
vi.mock('./audit.js', () => ({ logToolUse: vi.fn() }));
vi.mock('./files.js', () => ({ saveFile: vi.fn(), saveFileFromBase64: vi.fn(), saveFileInternal: vi.fn(), getContentTypeFromMime: vi.fn() }));

const mind = vi.hoisted(() => ({ recall: [] as string[], wake: 0, block: 'BLOCK' }));
vi.mock('./mind-client.js', () => ({
  MIN_RECALL_QUERY: 10,
  mindRecallBlock: async (q: string) => { mind.recall.push(q); return mind.block; },
  mindWakeBlock: async () => { mind.wake++; return mind.block; },
}));

import { createHooks, prefetchMindContext, type HookContext } from './hooks.js';

const ctx = (over: Partial<HookContext> = {}): HookContext => ({
  threadId: 't', threadName: 'n', threadType: 'daily', streamMsgId: 's', isAutonomous: false,
  registry: {} as any, sessionId: null, platform: 'web', toolInsertions: [], getTextLength: () => 0, ...over,
});
const submit = async (c: HookContext, prompt: string) => {
  const hooks = createHooks(c) as any;
  return hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt }, undefined, { signal: new AbortController().signal });
};

beforeEach(() => { mind.recall = []; mind.wake = 0; mind.block = 'BLOCK'; });

describe('Mind recall in the UserPromptSubmit hook', () => {
  it('adds the Mind client block for an ordinary message', async () => {
    const out = await submit(ctx(), 'what do you remember about the relay?');
    expect(mind.recall).toEqual(['what do you remember about the relay?']);
    expect(out.hookSpecificOutput.additionalContext).toBe('BLOCK');
  });
  it('asks nothing for an autonomous wake, a short prompt, or a turn with memory off (the public lane)', async () => {
    await submit(ctx({ isAutonomous: true }), 'a long enough autonomous prompt');
    await submit(ctx(), 'short');
    await submit(ctx({ noMemory: true }), 'a long enough public lane message');
    expect(mind.recall).toEqual([]);
  });
  it('adds nothing when the Mind has nothing to say', async () => {
    mind.block = '';
    const out = await submit(ctx(), 'something else entirely, a new question');
    expect(out).toEqual({ continue: true });
  });
});

describe('prefetchMindContext', () => {
  it('is the Mind client wake block', async () => {
    expect(await prefetchMindContext()).toBe('BLOCK');
    expect(mind.wake).toBe(1);
  });
});

describe('the recall query is the person message, not the enriched prompt', () => {
  const orientation = '[Context]\n[Orientation: tools, skills, vault ...]\n\n[Wake]\nidentity cores...\n[/Context]';
  it('first message with orientation: the raw message is the query', async () => {
    const msg = 'first message: how is my sister doing?';
    await submit(ctx({ userContent: msg }), `${orientation}\n\n${msg}`);
    expect(mind.recall).toEqual([msg]);
  });
  it('a later message: the raw message is the query', async () => {
    const msg = 'a later message about the garden plans';
    await submit(ctx({ userContent: msg }), `[Context]\nnow: Tuesday\n[/Context]\n\n${msg}`);
    expect(mind.recall).toEqual([msg]);
  });
  it('a 2-character message makes no call even though the enriched prompt is long', async () => {
    await submit(ctx({ userContent: 'ok' }), `${orientation}\n\nok`);
    expect(mind.recall).toEqual([]);
  });
  it('without the raw message, strips the [Context] block (and the rolling history framing)', async () => {
    await submit(ctx(), `${orientation}\n\nfallback message with no raw value`);
    await submit(ctx(), `[Context]\nx\n[/Context]\n\n[Conversation so far]\nA: hi\n\n[Current message]\nfallback rolling message here`);
    expect(mind.recall).toEqual(['fallback message with no raw value', 'fallback rolling message here']);
  });
});

describe('the 10 s recall cache never serves or is filled by a noMemory turn', () => {
  it('a private turn cached recall is not served to a noMemory turn with the same text', async () => {
    const msg = 'tell me what you remember about my sister please';
    const priv = await submit(ctx({ userContent: msg }), msg);
    expect(priv.hookSpecificOutput.additionalContext).toBe('BLOCK');
    const pub = await submit(ctx({ noMemory: true, platform: 'discord', userContent: msg }), msg);
    expect(pub).toEqual({ continue: true });
    expect(mind.recall).toEqual([msg]);
  });
  it('a noMemory turn leaves nothing in the cache for the next private turn to hit', async () => {
    const msg = 'a different long message for the cache check';
    await submit(ctx({ noMemory: true, userContent: msg }), msg);
    await submit(ctx({ userContent: msg }), msg);
    expect(mind.recall).toEqual([msg]);
  });
});
