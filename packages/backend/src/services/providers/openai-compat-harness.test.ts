import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  fb: {} as any,
  voice: false, image: 'none', cc: false,
  ingests: [] as any[], compacts: 0,
  env: { FK: 'sk-fallback' } as Record<string, string>,
}));

vi.mock('../../config.js', () => ({
  getSanctumConfig: () => ({
    identity: { companion_name: 'Echo', user_name: 'Sam' },
    agent: { cwd: '/nonexistent-home', fallback: h.fb },
    voice: { enabled: h.voice }, imagegen: { provider: h.image }, command_center: { enabled: h.cc },
    server: { host: '127.0.0.1', port: 3099 },
  }),
  internalBaseUrl: () => 'http://127.0.0.1:3099',
}));
vi.mock('../../tenancy/child.js', () => ({ childRunBase: () => h.env }));
vi.mock('../../tenancy/own-files.js', () => ({ readOwnOrApp: () => 'BASE PROMPT' }));
vi.mock('../../middleware/internal-token.js', () => ({ getInternalToken: () => 'tok-internal' }));
vi.mock('../identity/block.js', () => ({ identityBlock: () => 'IDENTITY BLOCK' }));
vi.mock('../rolling-history.js', () => ({
  assembleRollingHistory: async () => ({ summary: 'SUMMARY', notice: '', lines: ['Sam: earlier'], rolling: { maybeCompact: async () => { h.compacts++; } }, turns: 1, segments: 0 }),
  conversationBlock: (lines: string[]) => (lines.length ? `[Conversation so far]\n${lines.join('\n')}` : ''),
  splitContextBlock: (prompt: string, ctx?: string) => (!ctx || !prompt.startsWith(ctx) ? { context: '', message: prompt } : { context: ctx, message: prompt.slice(ctx.length).replace(/^\n+/, '') }),
}));
vi.mock('../revien.js', () => ({ MEMORY_HEADER: '[memory]', recallForPrompt: async () => 'a recalled thing', ingestTurn: async (p: any) => { h.ingests.push(p); } }));
vi.mock('../mind-client.js', () => ({ mindRecallBlock: async () => '' }));

import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import { openaiCompatQuery, execViaInternalRoute, harnessLine, resetFallbackToolState, toolsDegraded } from './openai-compat-harness.js';
import { FALLBACK_TOOLS, offeredTools } from './openai-compat-tools.js';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const say = (content: string) => ok({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
const call = (id: string, name: string, args: unknown, content = '') =>
  ok({ choices: [{ message: { role: 'assistant', content, tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 200, completion_tokens: 20 } });

const sanctum = { threadId: 't1', userContent: 'set a timer', contextBlock: '[Context]\nenv\n[/Context]' };
async function drain(q: any) { const out: any[] = []; for await (const m of q) out.push(m); return out; }
function run(extra: Record<string, unknown> = {}, deps: any = { exec: async () => ({ content: '{"ok":true}', isError: false }) }, prompt = '[Context]\nenv\n[/Context]\n\nset a timer') {
  return openaiCompatQuery({ prompt, options: { sanctum, abortController: new AbortController(), ...extra } as any }, deps);
}
const bodies = (f: any) => f.mock.calls.map((c: any[]) => JSON.parse(c[1].body));

beforeEach(() => {
  resetFallbackToolState();
  h.fb = { provider: 'openai-compat', mode: 'auto', model: 'vendor/model-x', base_url: 'https://llm.example.test/v1', api_key_env: 'FK', max_tool_turns: 8, unhealthy_minutes: 10 };
  h.voice = false; h.image = 'none'; h.cc = false; h.ingests = []; h.compacts = 0; h.env = { FK: 'sk-fallback' };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the tool loop', () => {
  it('a tool_call is executed, its result is appended as a role:tool message, and the next round answers', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(call('call_1', 'timer', { action: 'create', label: 'tea', fire_at: '+10m' }, 'Setting it.'))
      .mockResolvedValueOnce(say('Done: tea in ten minutes.'));
    vi.stubGlobal('fetch', f);
    const exec = vi.fn(async () => ({ content: '{"success":true,"id":"tm1"}', isError: false }));
    const q: any = run({}, { exec });
    const out = await drain(q);

    expect(exec).toHaveBeenCalledTimes(1);
    const [tool, args, ctx] = exec.mock.calls[0] as any[];
    expect(tool.name).toBe('timer');
    expect(args).toEqual({ action: 'create', label: 'tea', fire_at: '+10m' });
    expect(ctx).toMatchObject({ threadId: 't1' });

    const [r1, r2] = bodies(f);
    expect(r1.tools.map((t: any) => t.function.name)).toContain('timer');
    expect(r1.tool_choice).toBe('auto');
    expect(r2.messages.at(-2)).toMatchObject({ role: 'assistant', content: 'Setting it.', tool_calls: [{ id: 'call_1', function: { name: 'timer' } }] });
    expect(r2.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"success":true,"id":"tm1"}' });
    expect(q.meta).toMatchObject({ toolsOffered: expect.any(Number), toolsRun: 1, degraded: false });
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'Done: tea in ten minutes.' });
  });

  it('emits what agent.ts consumes: init, text stream blocks, tool_use, tool_result, assistant, result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(call('c1', 'touch', { target: 'last', emoji: '❤️' }, 'On it.')).mockResolvedValueOnce(say('Reacted.')));
    const out = await drain(run());
    const types = out.map((m) => m.type + (m.event ? `:${m.event.type}` : ''));
    expect(types[0]).toBe('system');
    expect(out[0]).toMatchObject({ subtype: 'init', model: 'vendor/model-x' });
    expect(types).toContain('stream_event:content_block_delta');
    expect(out.find((m) => m.type === 'stream_event' && m.event.delta)?.event.delta).toEqual({ type: 'text_delta', text: 'On it.' });
    const toolUse = out.find((m) => m.type === 'assistant' && m.message.content.some((b: any) => b.type === 'tool_use'));
    expect(toolUse.message.content.find((b: any) => b.type === 'tool_use')).toEqual({ type: 'tool_use', id: 'c1', name: 'mcp__sanctum__touch', input: { target: 'last', emoji: '❤️' } });
    const tr = out.find((m) => m.type === 'user');
    expect(tr.message.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}', is_error: false });
    const res = out.at(-1);
    expect(res).toMatchObject({ type: 'result', subtype: 'success', result: 'Reacted.' });
    expect(res.usage).toMatchObject({ input_tokens: 100, output_tokens: 10 });
    expect(res.spend).toMatchObject({ input_tokens: 300, output_tokens: 30 });
    // the session id is never a real one: agent.ts would overwrite the thread's resumable session with it
    expect(out.every((m) => !m.session_id)).toBe(true);
  });

  it('fires the PreToolUse and PostToolUse hooks (tool pills and the audit log) under the MCP-style name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(call('c1', 'meal', { action: 'log', at: 'now' })).mockResolvedValueOnce(say('Logged.')));
    const seen: any[] = [];
    const hook = (name: string) => [{ hooks: [async (i: any, id: string) => { seen.push([name, i.tool_name, id, i.tool_input, i.tool_response]); return {}; }] }];
    await drain(run({ hooks: { PreToolUse: hook('pre'), PostToolUse: hook('post'), PostToolUseFailure: hook('fail') } }));
    expect(seen.map((s) => s.slice(0, 3))).toEqual([['pre', 'mcp__sanctum__meal', 'c1'], ['post', 'mcp__sanctum__meal', 'c1']]);
    expect(seen[0][3]).toEqual({ action: 'log', at: 'now' });
    expect(seen[1][4]).toBe('{"ok":true}');
  });

  it('a PreToolUse deny is enforced: the tool does not run and the model is told', async () => {
    const f = vi.fn().mockResolvedValueOnce(call('c1', 'share', { path: '/etc/passwd' })).mockResolvedValueOnce(say('I could not.'));
    vi.stubGlobal('fetch', f);
    const exec = vi.fn();
    const deny = [{ hooks: [async () => ({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'outside the workspace' } })] }];
    const q: any = run({ hooks: { PreToolUse: deny } }, { exec });
    await drain(q);
    expect(exec).not.toHaveBeenCalled();
    expect(bodies(f)[1].messages.at(-1).content).toContain('outside the workspace');
    expect(q.meta.toolsRun).toBe(0);
  });

  it('a failing tool is reported as an error result and the loop goes on', async () => {
    const f = vi.fn().mockResolvedValueOnce(call('c1', 'timer', { action: 'list' })).mockResolvedValueOnce(say('It failed.'));
    vi.stubGlobal('fetch', f);
    const out = await drain(run({}, { exec: async () => ({ content: 'Error: timer → HTTP 403 {"error":"app writes are off"}', isError: true }) }));
    expect(out.find((m) => m.type === 'user').message.content[0].is_error).toBe(true);
    expect(out.at(-1).result).toBe('It failed.');
  });

  it('bad arguments from the model never reach a route', async () => {
    const f = vi.fn().mockResolvedValueOnce(call('c1', 'timer', '{not json')).mockResolvedValueOnce(call('c2', 'nosuchtool', {})).mockResolvedValueOnce(say('ok'));
    vi.stubGlobal('fetch', f);
    const exec = vi.fn();
    const out = await drain(run({}, { exec }));
    expect(exec).not.toHaveBeenCalled();
    const results = out.filter((m) => m.type === 'user').map((m) => m.message.content[0].content);
    expect(results[0]).toContain('not valid JSON');
    expect(results[1]).toContain('not an available tool');
  });

  it('stops after max_tool_turns rounds and asks once more without tools', async () => {
    h.fb.max_tool_turns = 2;
    const f = vi.fn(async () => (f.mock.calls.length <= 2 ? call(`c${f.mock.calls.length}`, 'timer', { action: 'list' }) : say('Here is where I got to.')));
    vi.stubGlobal('fetch', f);
    const exec = vi.fn(async () => ({ content: 'ok', isError: false }));
    const out = await drain(run({}, { exec }));
    expect(exec).toHaveBeenCalledTimes(2);
    const b = bodies(f);
    expect(b).toHaveLength(3);
    expect(b[2].tools).toBeUndefined();
    expect(out.at(-1)).toMatchObject({ subtype: 'success', result: 'Here is where I got to.' });
  });
});

describe('the tool set', () => {
  it('is the sixteen res verbs that have an internal route; voice, image and cc only when set up', () => {
    const all = FALLBACK_TOOLS.map((t) => t.name);
    expect(all).toEqual(['ask', 'meal', 'cc', 'share', 'canvas', 'timer', 'touch', 'impulse', 'watch', 'search', 'context', 'note', 'voice', 'image', 'schedule', 'pulse']);
    expect(offeredTools({ voice: false, image: false, cc: false }).map((t) => t.name)).not.toEqual(expect.arrayContaining(['voice']));
    expect(offeredTools({ voice: false, image: false, cc: false }).map((t) => t.name)).toEqual(all.filter((n) => !['cc', 'voice', 'image'].includes(n)));
    expect(offeredTools({ voice: true, image: true, cc: true }).map((t) => t.name)).toEqual(all);
  });

  it('honours disabledTools (by name or by MCP-style name), disallowedTools and disabledServers', async () => {
    const f = vi.fn().mockImplementation(async () => say('hi'));
    vi.stubGlobal('fetch', f);
    await drain(openaiCompatQuery({ prompt: 'p', options: { sanctum: { ...sanctum, disabledTools: ['timer', 'mcp__sanctum__watch'] }, disallowedTools: ['search'], abortController: new AbortController() } as any }, {}));
    const names = bodies(f)[0].tools.map((t: any) => t.function.name);
    expect(names).not.toContain('timer');
    expect(names).not.toContain('watch');
    expect(names).not.toContain('search');
    expect(names).toContain('meal');

    f.mockClear();
    await drain(openaiCompatQuery({ prompt: 'p', options: { sanctum: { ...sanctum, disabledServers: ['sanctum'] }, abortController: new AbortController() } as any }, {}));
    expect(bodies(f)[0].tools).toBeUndefined();
    expect(bodies(f)[0].messages[0].content).toContain('No tools are available this turn');
  });

  it('every tool maps to one route and refuses arguments it cannot use', () => {
    const ctx = { threadId: 't1', namespace: 'companion' };
    const route = (n: string, a: any) => (FALLBACK_TOOLS.find((t) => t.name === n)!.request(a, ctx) as any);
    expect(route('timer', { action: 'create', label: 'x', fire_at: '+5m' })).toMatchObject({ route: 'timer', body: { action: 'create', threadId: 't1' } });
    expect(route('timer', { action: 'create' })).toHaveProperty('error');
    expect(route('impulse', { action: 'create', label: 'l', conditions: [{ type: 'agent_free' }] })).toMatchObject({ route: 'trigger', body: { kind: 'impulse' } });
    expect(route('watch', { action: 'create', label: 'l', conditions: [] })).toHaveProperty('error');
    expect(route('note', { text: 'hi' })).toMatchObject({ route: 'context', body: { namespace: 'companion', field: 'note', value: 'hi' } });
    expect(route('pulse', { action: 'frequency', minutes: 3 })).toHaveProperty('error');
    expect(route('schedule', { action: 'create', label: 'Morning check', cron_expr: '0 9 * * *' })).toMatchObject({ route: 'orchestrator', body: { wakeType: 'morning_check' } });
    expect(route('canvas', { action: 'create', title: 't', content: 'c' })).toMatchObject({ route: 'canvas', body: { contentType: 'markdown' } });
    expect(route('search', { query: 'tea' })).toMatchObject({ route: 'search-semantic' });
    expect(route('ask', { what: 'delete it?' })).toMatchObject({ route: 'approvals', timeoutMs: 630000 });
  });
});

describe('the system prompt tells the truth about this turn', () => {
  it('states the harness, the model, and exactly the tools offered', async () => {
    const f = vi.fn().mockImplementation(async () => say('hi'));
    vi.stubGlobal('fetch', f);
    await drain(run());
    const sys = bodies(f)[0].messages[0].content as string;
    const names = bodies(f)[0].tools.map((t: any) => t.function.name).join(', ');
    expect(sys).toContain('BASE PROMPT');
    expect(sys).toContain('IDENTITY BLOCK');
    expect(sys).toContain(`[Harness] This turn runs on the fallback brain (openai-compat, model vendor/model-x), not the primary harness. Tools available this turn (13): ${names}.`);
    expect(sys).toContain('if you did not call one, you did not do it');
    expect(sys).toContain('You cannot see images');
    expect(sys).not.toMatch(/You have MCP tools/i);
  });

  it('harnessLine on a tool-less run says so and never offers tools', () => {
    for (const why of ['degraded', 'read_only', 'none_configured', undefined] as const) {
      const line = harnessLine({ model: 'm', tools: [], noToolsWhy: why });
      expect(line).toContain('No tools are available this turn');
      expect(line).not.toContain('Tools available');
      expect(line).toContain('do not say you have tools');
    }
    expect(harnessLine({ model: 'm', tools: [], noToolsWhy: 'degraded' })).toContain('does not support function calling');
  });

  it('carries the thread: orientation, memory, summary, the tail, then the current message', async () => {
    const f = vi.fn().mockImplementation(async () => say('hi'));
    vi.stubGlobal('fetch', f);
    await drain(run());
    const user = bodies(f)[0].messages[1].content as string;
    expect(user.indexOf('[Context]')).toBeLessThan(user.indexOf('a recalled thing'));
    expect(user.indexOf('a recalled thing')).toBeLessThan(user.indexOf('SUMMARY'));
    expect(user.indexOf('SUMMARY')).toBeLessThan(user.indexOf('Sam: earlier'));
    expect(user.indexOf('Sam: earlier')).toBeLessThan(user.indexOf('[Current message]\nset a timer'));
  });

  it('sends no image_url part: an attachment is only the note in the message', async () => {
    const f = vi.fn().mockImplementation(async () => say('hi'));
    vi.stubGlobal('fetch', f);
    await drain(run({}, {}, '[Context]\nenv\n[/Context]\n\nlook\n\n[Attachment: /data/uploads/cat.png — read it]'));
    const m = bodies(f)[0].messages;
    expect(typeof m[1].content).toBe('string');
    expect(JSON.stringify(m)).not.toContain('image_url');
  });
});

describe('degrading when the endpoint refuses tools', () => {
  const refusal = () => ok({ error: { code: 400, message: 'tools is not supported for this model' } }, 400);

  it('retries the same round without tools, ONE warning, flag set, prompt corrected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(say('I can only talk.'));
    vi.stubGlobal('fetch', f);
    const q: any = run();
    const out = await drain(q);
    const [first, second] = bodies(f);
    expect(first.tools).toBeDefined();
    expect(second.tools).toBeUndefined();
    expect(second.messages[0].content).toContain('No tools are available this turn (this model or endpoint does not support function calling)');
    expect(out.at(-1)).toMatchObject({ subtype: 'success', result: 'I can only talk.' });
    expect(q.meta).toMatchObject({ degraded: true, toolsOffered: 0, toolsRun: 0 });
    expect(toolsDegraded('https://llm.example.test/v1', 'vendor/model-x')).toBe(true);

    // the next turn does not even ask; and the warning is not repeated
    f.mockClear(); f.mockResolvedValueOnce(say('again'));
    const q2: any = run();
    await drain(q2);
    expect(bodies(f)[0].tools).toBeUndefined();
    expect(q2.meta.degraded).toBe(true);
    const warnings = warn.mock.calls.filter((c) => String(c[0]).includes('WITHOUT tools'));
    expect(warnings).toHaveLength(1);
  });

  it('a 400 that is not about tools is an error, not a degrade', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ error: { code: 400, message: 'max_tokens is too large' } }, 400)));
    await expect(drain(run())).rejects.toMatchObject({ cls: 'bad_request' });
    expect(toolsDegraded()).toBe(false);
  });

  it('OpenRouter\'s supported_parameters is respected: a model without `tools` is never sent them', async () => {
    h.fb.base_url = 'https://openrouter.ai/api/v1';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn(async (url: string) => (String(url).endsWith('/models')
      ? ok({ data: [{ id: 'vendor/model-x', supported_parameters: ['temperature', 'max_tokens'] }] })
      : say('talk only')));
    vi.stubGlobal('fetch', f);
    const q: any = run();
    await drain(q);
    const chat = f.mock.calls.filter((c) => !String(c[0]).endsWith('/models'));
    expect(chat).toHaveLength(1);
    expect(JSON.parse((chat[0] as any)[1].body).tools).toBeUndefined();
    expect(q.meta).toMatchObject({ degraded: true, toolsOffered: 0 });
  });

  it('a model listed with `tools` gets them', async () => {
    h.fb.base_url = 'https://openrouter.ai/api/v1';
    const f = vi.fn(async (url: string) => (String(url).endsWith('/models') ? ok({ data: [{ id: 'vendor/model-x', supported_parameters: ['tools', 'max_tokens'] }] }) : say('ok')));
    vi.stubGlobal('fetch', f);
    await drain(run());
    const chat = f.mock.calls.find((c) => !String(c[0]).endsWith('/models')) as any;
    expect(JSON.parse(chat[1].body).tools.length).toBeGreaterThan(0);
  });
});

describe('configuration failures are classed so the router can move on', () => {
  it('a missing key is api_key_missing (AUTH); missing endpoint or model is a plain error', async () => {
    h.env = {};
    await expect(drain(run())).rejects.toMatchObject({ kind: 'api_key_missing' });
    h.env = { FK: 'k' }; h.fb.base_url = '';
    await expect(drain(run())).rejects.toThrow('agent.fallback.base_url');
    h.fb.base_url = 'http://x'; h.fb.model = '';
    await expect(drain(run())).rejects.toThrow('agent.fallback.model');
  });

  it('an auth failure from the endpoint carries the class the router reads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ error: { message: 'Invalid API key' } }, 401)));
    await expect(drain(run())).rejects.toMatchObject({ cls: 'auth', status: 401 });
  });

  it('a stop ends the turn as an AbortError', async () => {
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => { init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); })));
    const q = openaiCompatQuery({ prompt: 'p', options: { sanctum, abortController: ac } as any }, {});
    const p = drain(q);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });
});

describe('memory and read-only runs', () => {
  it('hands the exchange to memory after a reply, folds history, and never on a held or memory:none turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => say('reply')));
    await drain(run());
    expect(h.ingests).toEqual([{ threadId: 't1', user: 'set a timer', assistant: 'reply' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.compacts).toBe(1);
    h.ingests = [];
    await drain(run({ sanctum: { ...sanctum, noIngest: true } }));
    await drain(run({ sanctum: { ...sanctum, memory: 'none' } }));
    expect(h.ingests).toEqual([]);
  });

  it('a read-only run is offered no tools and says so', async () => {
    const f = vi.fn().mockImplementation(async () => say('summary'));
    vi.stubGlobal('fetch', f);
    await drain(run({ permissionMode: 'plan', systemPrompt: 'TASK BRIEF' }));
    const b = bodies(f)[0];
    expect(b.tools).toBeUndefined();
    expect(b.messages[0].content).toContain('TASK BRIEF');
    expect(b.messages[0].content).toContain('read-only run');
  });
});

describe('the default executor is the same request `res` would make', () => {
  const tool = (n: string) => FALLBACK_TOOLS.find((t) => t.name === n)!;
  const ctx = { threadId: 't1', namespace: 'companion' };

  it('POSTs /api/internal/<route> over loopback with the internal token and the JSON body', async () => {
    const f = vi.fn(async () => ok({ success: true }));
    vi.stubGlobal('fetch', f);
    const r = await execViaInternalRoute(tool('touch'), { target: 'last', emoji: '❤️' }, ctx);
    expect(r).toEqual({ content: '{"success":true}', isError: false });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3099/api/internal/react');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-internal-token']).toBe('tok-internal');
    expect(JSON.parse(init.body as string)).toEqual({ target: 'last', emoji: '❤️', threadId: 't1' });
  });

  it('an HTTP error (the write gate says 403) comes back as an error result, with the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: 'app writes are off (agent.app_write)' }, 403)));
    const r = await execViaInternalRoute(tool('meal'), { action: 'log' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('HTTP 403');
    expect(r.content).toContain('agent.app_write');
  });

  it('an unreachable app is an error result, not a thrown error; bad arguments never make a request', async () => {
    const f = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    vi.stubGlobal('fetch', f);
    expect((await execViaInternalRoute(tool('pulse'), { action: 'status' }, ctx)).content).toContain('could not reach the app');
    f.mockClear();
    expect((await execViaInternalRoute(tool('timer'), { action: 'create' }, ctx)).isError).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('cuts a very long result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(20000))));
    const r = await execViaInternalRoute(tool('search'), { query: 'q' }, ctx);
    expect(r.content.length).toBeLessThan(6200);
    expect(r.content).toContain('[cut:');
  });
});
