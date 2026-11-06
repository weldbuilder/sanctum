// The fallback brain as agent.ts sees it: the router's fallover is announced in the thread and to the apps, the failure class is
// shown, and an autonomous turn that ran on the fallback with ZERO tools is a skip, not a "done".
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  created: [] as any[],
  broadcasts: [] as any[],
  kv: {} as Record<string, string>,
  primary: { throws: null as null | Error, text: 'primary reply' },
  fallback: { text: 'fallback reply', meta: { toolsOffered: 3, toolsRun: 0, degraded: false } as any, usedOptions: null as any },
  mode: 'auto' as 'off' | 'auto' | 'always',
  provider: 'claude',
}));

vi.mock('./providers/index.js', () => ({
  activeProvider: () => h.provider,
  AbortError: class AbortError extends Error {},
  listSessions: async () => [],
  query: () => {
    const it = (async function* () {
      if (h.primary.throws) throw h.primary.throws;
      yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: h.primary.text }] } };
      yield { type: 'result', subtype: 'success', session_id: 's1' };
    })();
    return Object.assign(it, { mcpServerStatus: async () => [], interrupt: async () => {} });
  },
}));
vi.mock('./providers/openai-compat-harness.js', () => ({
  openaiCompatQuery: (p: any) => {
    h.fallback.usedOptions = p.options;
    const meta = { ...h.fallback.meta };
    const it = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: '' };
      yield { type: 'stream_event', session_id: '', event: { type: 'content_block_start', content_block: { type: 'text' } } };
      yield { type: 'stream_event', session_id: '', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: h.fallback.text } } };
      yield { type: 'stream_event', session_id: '', event: { type: 'content_block_stop' } };
      yield { type: 'assistant', session_id: '', message: { content: [{ type: 'text', text: h.fallback.text }] } };
      yield { type: 'result', subtype: 'success', session_id: '', result: h.fallback.text };
    })();
    return Object.assign(it, { meta, mcpServerStatus: async () => [], interrupt: async () => {} });
  },
}));
vi.mock('./plugins.js', () => ({ senderIsOwnerFor: () => true }));
vi.mock('./rolling-context.js', () => ({
  getRolling: () => ({ maybeCompact: async () => {}, readTurns: async () => [] }),
  rollingEnabledForActiveProvider: () => true,
}));
vi.mock('./rolling-history.js', async (orig) => ({ ...(await orig<typeof import('./rolling-history.js')>()), assembleRollingHistory: async () => ({ summary: '', notice: '', lines: [], turns: 0, segments: 0 }) }));
vi.mock('../middleware/internal-token.js', () => ({ getInternalToken: () => 't' }));
vi.mock('./revien.js', () => ({ MEMORY_HEADER: '[memory]', recallForPrompt: async () => '', ingestTurn: async () => {} }));
vi.mock('./files.js', () => ({ getFile: () => null }));
vi.mock('./db.js', () => ({
  createMessage: (m: any) => { h.created.push(m); return { ...m, thread_id: m.threadId, created_at: m.createdAt }; },
  updateThreadSession: () => {},
  getThread: () => ({ id: 't1', name: 'T', type: 'named', current_session_id: null, model: null, effort: null, show_thinking: false }),
  updateThreadActivity: () => {},
  createSessionRecord: () => {},
  endSessionRecord: () => {},
  setConfig: (k: string, v: string) => { h.kv[k] = v; },
  getConfig: (k: string) => h.kv[k] ?? null,
}));
vi.mock('./ws.js', () => ({ registry: { broadcast: (m: any) => { h.broadcasts.push(m); } } }));
vi.mock('./hooks.js', () => ({
  createHooks: () => ({}),
  buildOrientationContext: async () => '',
  prefetchMindContext: async () => '',
  maybeSnapshotTone: () => {},
}));
vi.mock('../tenancy/child.js', async (orig) => ({ ...(await orig<typeof import('../tenancy/child.js')>()), childRunBase: () => ({ FK: 'sk-fb' }) }));
vi.mock('../config.js', () => ({
  getSanctumConfig: () => ({
    identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' },
    agent: {
      cwd: '/nonexistent-agent-cwd', model: 'm', model_autonomous: 'm', claude_md_path: '', mcp_json_path: '/nonexistent/.mcp.json', system_prompt_file: '', app_write: false, auto_compact: false, harness_memory: false,
      fallback: { provider: 'openai-compat', mode: h.mode, model: 'fb-model', base_url: 'http://llm.test/v1', api_key_env: 'FK', max_tool_turns: 8, unhealthy_minutes: 10 },
    },
    command_center: { enabled: false },
    server: { host: '127.0.0.1', port: 1 },
    hooks: {},
  }),
  internalBaseUrl: () => 'http://127.0.0.1:1',
}));
vi.mock('../identity/load.js', () => ({ loadCompanionIdentity: () => ({}) }));
vi.mock('../identity/render.js', () => ({ describeIdentitySource: () => 'test', renderIdentityPrompt: () => '', fillIdentityNames: (s: string) => s }));
vi.mock('./auth-preferences.js', () => ({ applyAuthToEnv: () => {}, effectiveModel: (_k: string, d: string) => d, getAuthPreferences: () => ({}) }));
vi.mock('./usage-log.js', () => ({ recordUsage: () => {} }));

import { AgentService, AutonomousSkipped } from './agent.js';

const companion = () => h.created.filter((m) => m.role === 'companion');
const lines = () => h.created.filter((m) => m.role === 'system' && m.metadata?.kind === 'brain_notice');
const brainMsgs = () => h.broadcasts.filter((b) => b.type === 'brain_changed');
const thread = { name: 'T', type: 'named' as const };

beforeEach(() => {
  h.created = []; h.broadcasts = []; h.kv = {}; h.mode = 'auto'; h.provider = 'claude';
  h.primary = { throws: null, text: 'primary reply' };
  h.fallback = { text: 'fallback reply', meta: { toolsOffered: 3, toolsRun: 0, degraded: false }, usedOptions: null };
});

describe('fallover is announced, once, in the thread and to the apps', () => {
  it('a signed-out primary: the fallback answers, one system line names the class, brain_changed is broadcast, status keys are set', async () => {
    h.primary.throws = new Error('Invalid API key · Please run /login');
    const out = await new AgentService().processMessage('t1', 'hello', thread, { platform: 'web' });
    expect(out).toBe('fallback reply');
    expect(companion()[0].content).toBe('fallback reply');
    expect(lines().map((m) => m.content)).toEqual(['running on the fallback brain (AUTH)']);
    expect(brainMsgs()).toEqual([{ type: 'brain_changed', active: 'fallback', class: 'AUTH', model: 'fb-model' }]);
    expect(h.kv.brain_active).toBe('fallback');
    expect(h.kv.brain_last_error).toBe('AUTH');
    // the adapter's option reaches the fallback even though the primary is Claude (which never sees it)
    expect(h.fallback.usedOptions.sanctum).toMatchObject({ threadId: 't1', userContent: 'hello' });
  });

  it('a second turn stays quiet while it stays there; when the primary is healthy again, "primary brain back" once', async () => {
    h.primary.throws = new Error('429 Too Many Requests');
    const agent = new AgentService();
    await agent.processMessage('t1', 'one', thread, { platform: 'web' });
    await agent.processMessage('t1', 'two', thread, { platform: 'web' });
    expect(lines()).toHaveLength(1);
    h.primary.throws = null;
    h.kv['brain.primary_unhealthy_until'] = ''; // the window has passed
    const out = await agent.processMessage('t1', 'three', thread, { platform: 'web' });
    expect(out).toBe('primary reply');
    expect(lines().map((m) => m.content)).toEqual(['running on the fallback brain (RATE_LIMIT)', 'primary brain back']);
    expect(brainMsgs().map((b) => b.active)).toEqual(['fallback', 'primary']);
    expect(h.kv.brain_active).toBe('primary');
  });

  it('mode always: fallback first, the line says so', async () => {
    h.mode = 'always';
    await new AgentService().processMessage('t1', 'hi', thread, { platform: 'web' });
    expect(lines().map((m) => m.content)).toEqual(['running on the fallback brain (always)']);
  });

  it('mode off: the primary alone; a failure is the primary\'s, with its class in the error line', async () => {
    h.mode = 'off';
    h.primary.throws = new Error('Credit balance is too low');
    const out = await new AgentService().processMessage('t1', 'hi', thread, { platform: 'web' });
    expect(out).toContain('[Agent error: Credit balance is too low (class: CREDIT)]');
    expect(lines()).toEqual([]);
    expect(h.fallback.usedOptions).toBeNull();
  });

  it('a failure with no class reads as before', async () => {
    h.mode = 'off';
    h.primary.throws = new Error('something odd');
    expect(await new AgentService().processMessage('t1', 'hi', thread, { platform: 'web' })).toBe('[Agent error: something odd]');
  });
});

describe('honesty guard: an autonomous turn that ran on the fallback with zero tools is a skip', () => {
  const tick = (agent = new AgentService()) => agent.processAutonomous('t1', '[Timer fired] "tea"');

  it('no reply is stored or sent, the caller sees a skip (never a "done"), the thread gets one line', async () => {
    h.mode = 'always';
    h.fallback.text = 'Done! I set the timer and logged your meal.';
    await expect(tick()).rejects.toBeInstanceOf(AutonomousSkipped);
    expect(companion()).toEqual([]);
    const l = lines().map((m) => m.content);
    expect(l.some((c) => c.startsWith('skipped an autonomous turn'))).toBe(true);
    expect(l.find((c) => c.startsWith('skipped'))).toContain('no tool was called');
    expect(h.broadcasts.some((b) => b.type === 'generation_stopped')).toBe(true);
  });

  it('on a fallback with no function calling the reason says so', async () => {
    h.mode = 'always';
    h.fallback.meta = { toolsOffered: 0, toolsRun: 0, degraded: true };
    await expect(tick()).rejects.toThrow('the fallback model has no tools this turn');
  });

  it('the same turn with a tool actually run is kept', async () => {
    h.mode = 'always';
    h.fallback.meta = { toolsOffered: 3, toolsRun: 1, degraded: false };
    h.fallback.text = 'Set it.';
    expect(await tick()).toBe('Set it.');
    expect(companion()).toHaveLength(1);
  });

  it('a PULSE_OK on the fallback is not a claim, so it is not a skip', async () => {
    h.mode = 'always';
    h.fallback.text = 'PULSE_OK';
    expect(await tick()).toBe('PULSE_OK');
  });

  it('the primary brain is not held to this: its autonomous turn with no tools is its own business', async () => {
    h.mode = 'off';
    expect(await tick()).toBe('primary reply');
  });

  it('an interactive turn on the fallback with no tools is just a conversation', async () => {
    h.mode = 'always';
    expect(await new AgentService().processMessage('t1', 'hi', thread, { platform: 'web' })).toBe('fallback reply');
    expect(companion()).toHaveLength(1);
  });
});
