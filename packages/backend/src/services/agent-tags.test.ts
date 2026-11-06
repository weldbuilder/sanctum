// Verifier item 8: a Discord reply the gate withholds is NOT saved as a companion message and NOT
// handed to memory, and the retry note never reaches memory. The agent runs the turn, then hands the
// reply back HELD; the Discord module commits it only after the gated send. The web path is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  reply: 'the reply',
  created: [] as any[],
  ingested: [] as any[],
  broadcasts: [] as any[],
  pushes: [] as any[],
  toneSnaps: 0,
  provider: 'claude',
  options: null as any,
  rolling: true,
  recalls: [] as string[],
  prefetches: 0,
  histories: 0,
  queryThrows: null as null | Error,
  events: null as null | any[],
  gate: null as null | Promise<void>,
  imageOffered: true,
  voiceEnabled: true,
  images: [] as any[],
  voices: [] as any[],
  tts: true,
  imageThrows: false,
  voiceMode: false,
}));

vi.mock('./providers/index.js', () => ({
  activeProvider: () => h.provider,
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: (p: any) => {
    h.options = p.options;
    const events = h.events ?? [{ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: h.reply }] } }, { type: 'result', session_id: 's1' }];
    const it = (async function* () { if (h.gate) await h.gate; if (h.queryThrows) throw h.queryThrows; for (const e of events) { if ((e as any).__throw) throw new Error('boom'); yield e; } })();
    return Object.assign(it, { mcpServerStatus: async () => [], interrupt: async () => {}, close: () => {} });
  },
}));
vi.mock('./plugins.js', () => ({ senderIsOwnerFor: () => true }));
vi.mock('./rolling-context.js', () => ({
  getRolling: () => ({ maybeCompact: async () => {}, readTurns: async () => [] }),
  rollingEnabledForActiveProvider: () => h.rolling,
}));
vi.mock('./rolling-history.js', async (orig) => ({ ...(await orig<typeof import('./rolling-history.js')>()), assembleRollingHistory: async () => { h.histories++; return ({ summary: '', notice: '', lines: [], turns: 0, segments: 0 }); } }));
vi.mock('../middleware/internal-token.js', () => ({ getInternalToken: () => 't' }));
vi.mock('./revien.js', () => ({
  MEMORY_HEADER: '[memory]',
  recallForPrompt: async (q: string) => { h.recalls.push(q); return ''; },
  ingestTurn: async (p: any) => { h.ingested.push(p); },
}));
vi.mock('./files.js', () => ({ getFile: () => null }));
vi.mock('./db.js', () => ({
  createMessage: (m: any) => { h.created.push(m); return { ...m, thread_id: m.threadId, created_at: m.createdAt }; },
  updateThreadSession: () => {},
  getThread: () => ({ id: 't1', name: 'T', type: 'named', current_session_id: null, model: null, effort: null, show_thinking: false }),
  updateThreadActivity: () => {},
  createSessionRecord: () => {},
  endSessionRecord: () => {},
  setConfig: () => {},
  getConfig: () => null,
}));
vi.mock('./ws.js', () => ({
  registry: { broadcast: (m: any) => { h.broadcasts.push(m); } },
  isVoiceModeActive: () => h.voiceMode,
  getVoiceService: () => ({ canTTS: h.tts, generateTTSForMessage: async (text: string, threadId: string, opts: any) => { h.voices.push({ text, threadId, opts }); return { messageId: 'v', fileId: 'f' }; } }),
}));
vi.mock('./imagegen/index.js', () => ({
  imagegenOffered: () => h.imageOffered,
  generateImage: async (o: any) => { h.images.push(o); if (h.imageThrows) throw new Error('secret prompt text'); return {}; },
}));
vi.mock('./hooks.js', () => ({
  createHooks: () => ({}),
  buildOrientationContext: async () => '',
  prefetchMindContext: async () => { h.prefetches++; return ''; },
  maybeSnapshotTone: () => { h.toneSnaps++; },
}));
vi.mock('../config.js', () => ({
  getSanctumConfig: () => ({
    identity: { companion_name: 'Echo', user_name: 'Pat', timezone: 'UTC' },
    agent: { cwd: '/nonexistent-agent-cwd', model: 'm', model_autonomous: 'm', claude_md_path: '', mcp_json_path: '/nonexistent/.mcp.json', system_prompt_file: '', app_write: false, auto_compact: false, harness_memory: false },
    command_center: { enabled: false },
    server: { host: '127.0.0.1', port: 1 },
    hooks: {},
    voice: { enabled: h.voiceEnabled },
  }),
  internalBaseUrl: () => 'http://127.0.0.1:1',
}));
vi.mock('../identity/load.js', () => ({ loadCompanionIdentity: () => ({}) }));
vi.mock('../identity/render.js', () => ({ describeIdentitySource: () => 'test', renderIdentityPrompt: () => '', fillIdentityNames: (s: string) => s }));
vi.mock('./auth-preferences.js', () => ({ applyAuthToEnv: () => {}, effectiveModel: (_k: string, d: string) => d, getAuthPreferences: () => ({}) }));
vi.mock('./usage-log.js', () => ({ recordUsage: () => {} }));

import { AgentService } from './agent.js';

const companionMessages = () => h.created.filter((m) => m.role === 'companion');
const settle = () => new Promise((r) => setTimeout(r, 10));
const say = (text: string) => { h.events = [{ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text }] } }, { type: 'result', session_id: 's1' }]; };
const turn = (opts: Record<string, unknown> = { platform: 'web' }, autonomous = false) => {
  const agent = new AgentService();
  return autonomous
    ? agent.processAutonomous('t1', 'wake')
    : agent.processMessage('t1', 'hi', { name: 'T', type: 'named' }, opts as any);
};

beforeEach(() => {
  h.created = []; h.broadcasts = []; h.ingested = []; h.pushes = []; h.options = null; h.events = null; h.gate = null; h.queryThrows = null;
  h.provider = 'claude'; h.rolling = true; h.images = []; h.voices = []; h.imageOffered = true; h.voiceEnabled = true; h.tts = true; h.imageThrows = false; h.voiceMode = false;
});

describe('inline tags in a reply', () => {
  it('stores the clean text, runs the image once with the prompt and thread, after stream_end', async () => {
    say("Here you go [image: a fox in snow] and that's all");
    const out = await turn();
    expect(out).toBe("Here you go and that's all");
    expect(companionMessages()).toHaveLength(1);
    expect(companionMessages()[0].content).toBe("Here you go and that's all");
    const end = h.broadcasts.find((b) => b.type === 'stream_end');
    expect(end.final.content).toBe("Here you go and that's all");
    await settle();
    expect(h.images).toEqual([expect.objectContaining({ prompt: 'a fox in snow', threadId: 't1', postToChat: true, triggeredBy: 'tag' })]);
    expect(h.images).toHaveLength(1);
  });

  it('the live stream never carries the tag, only the clean text', async () => {
    h.events = [
      { type: 'stream_event', session_id: 's1', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      ...['Here ', 'you go [ima', 'ge: a c', 'at] and', ' done'].map((t) => ({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })),
      { type: 'stream_event', session_id: 's1', event: { type: 'content_block_stop' } },
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Here you go [image: a cat] and done' }] } },
      { type: 'result', session_id: 's1' },
    ];
    await turn();
    const tokens = h.broadcasts.filter((b) => b.type === 'stream_token').map((b) => b.token);
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(t).not.toMatch(/\[|image|cat\]/);
    expect(tokens[tokens.length - 1]).toBe('Here you go and done');
  });

  it('a failing action neither blocks the turn nor changes the stored text, and its prompt is not logged', async () => {
    say('A [image: secret prompt text] B');
    h.imageThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await turn();
    expect(out).toBe('A B');
    expect(companionMessages()[0].content).toBe('A B');
    await settle();
    expect(h.images).toHaveLength(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret prompt');
    warn.mockRestore();
  });

  it('three images: only two run; the third is stripped', async () => {
    say('[image: a] one [image: b] two [image: c] three');
    expect(await turn()).toBe('one two three');
    await settle();
    expect(h.images.map((i) => i.prompt)).toEqual(['a', 'b']);
  });

  it('[voice] at the start: stored text is clean, voice note made from the clean text with the emotion, no second transcript', async () => {
    say('[voice:calm] Good night, love.');
    expect(await turn()).toBe('Good night, love.');
    expect(companionMessages()[0].content).toBe('Good night, love.');
    await settle();
    expect(h.voices).toEqual([{ text: 'Good night, love.', threadId: 't1', opts: { emotion: 'calm', transcript: false } }]);
  });

  it('an emotion the voice path does not have is a plain voice note; a mid-text [voice] is stripped and not run', async () => {
    say('[voice:furious] Hello');
    await turn();
    await settle();
    expect(h.voices[0].opts.emotion).toBeUndefined();
    h.voices = [];
    say('Hello [voice] there');
    expect(await turn()).toBe('Hello there');
    await settle();
    expect(h.voices).toEqual([]);
  });

  it('capability off: tags are stripped and nothing runs', async () => {
    h.imageOffered = false; h.voiceEnabled = false;
    say('[voice] Hi [image: a fox] there');
    expect(await turn()).toBe('Hi there');
    await settle();
    expect(h.images).toEqual([]);
    expect(h.voices).toEqual([]);
  });

  it('a reply that is only a tag that will run: no blank companion message; stream_end still fires with an empty final', async () => {
    say('[image: a lamp]');
    expect(await turn()).toBe('');
    expect(companionMessages()).toHaveLength(0);
    const end = h.broadcasts.find((b) => b.type === 'stream_end');
    expect(end).toBeTruthy();
    expect(end.final).toBe('');
    await settle();
    expect(h.images).toHaveLength(1);
  });

  it('a reply that is only a tag that will NOT run (not offered): stored as [No response]', async () => {
    h.imageOffered = false;
    say('[image: a lamp]');
    await turn();
    expect(companionMessages().map((m) => m.content)).toEqual(['[No response]']);
    expect(h.broadcasts.find((b) => b.type === 'stream_end').final.content).toBe('[No response]');
    await settle();
    expect(h.images).toEqual([]);
  });

  it('a bare [voice] with no text, or a gated platform, is also [No response]', async () => {
    say('[voice]');
    await turn();
    expect(companionMessages().map((m) => m.content)).toEqual(['[No response]']);
    h.created = [];
    say('[image: a lamp]');
    await turn({ platform: 'telegram' });
    expect(companionMessages().map((m) => m.content)).toEqual(['[No response]']);
  });

  it('a Telegram turn stores clean text and runs nothing', async () => {
    say('Hello [image: x] there [voice]');
    expect(await turn({ platform: 'telegram' })).toBe('Hello there');
    expect(companionMessages()[0].content).toBe('Hello there');
    await settle();
    expect(h.images).toEqual([]);
    expect(h.voices).toEqual([]);
  });

  it('[voice] speaks the reply after the narration, not the narration', async () => {
    h.events = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Let me check' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: '[voice] Here it is' }] } },
      { type: 'result', session_id: 's1' },
    ];
    await turn();
    await settle();
    expect(h.voices).toEqual([{ text: 'Here it is', threadId: 't1', opts: { emotion: undefined, transcript: false } }]);
  });

  it('a tag in the narration is stripped but never run', async () => {
    h.events = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Checking [image: a cat]' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'result', session_id: 's1' },
    ];
    await turn();
    await settle();
    expect(h.images).toEqual([]);
    expect(companionMessages()[0].content).not.toContain('[image');
  });

  it('a partial reply that then errors runs no tags', async () => {
    h.events = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Almost [image: a fox]' }] } },
      { __throw: true },
    ];
    await turn();
    await settle();
    expect(h.images).toEqual([]);
  });

  it('voice mode already speaks the reply: [voice] makes no second voice note', async () => {
    h.voiceMode = true;
    say('[voice] Good night.');
    expect(await turn()).toBe('Good night.');
    await settle();
    expect(h.voices).toEqual([]);
  });

  it('PULSE_OK, autonomous or not: stripped, never run', async () => {
    say('PULSE_OK [image: a fox]');
    await turn({ platform: 'web' }, true);
    await settle();
    expect(h.images).toEqual([]);
  });

  it('an autonomous wake that does speak runs its tags', async () => {
    say('Thinking of you [image: a window at dusk]');
    await turn({ platform: 'web' }, true);
    await settle();
    expect(h.images).toHaveLength(1);
  });

  it('a held (Discord) turn is stripped but never acted on', async () => {
    say('Hi [image: a fox] [voice]');
    let heldText = '';
    await turn({ platform: 'discord', senderIsOwner: true, hold: { userText: 'hi', ingest: true, onHeld: (r: any) => { heldText = r.text; r.commit(); } } });
    await settle();
    expect(heldText).toBe('Hi');
    expect(h.images).toEqual([]);
    expect(h.voices).toEqual([]);
  });

  it('the Codex and dsh harnesses go through the same path', async () => {
    for (const provider of ['codex', 'dsh']) {
      h.provider = provider; h.images = []; h.created = [];
      say('Look [image: a fox in snow] here');
      expect(await turn()).toBe('Look here');
      expect(companionMessages()[0].content).toBe('Look here');
      await settle();
      expect(h.images).toHaveLength(1);
    }
  });
});
