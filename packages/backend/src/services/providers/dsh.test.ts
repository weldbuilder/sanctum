import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rollingCfg: {} as any,
  models: { model: '', model_autonomous: '' },
  exec: { params: null as any, events: [] as any[], calls: 0, throwAfter: null as null | Error },
  rolling: { turns: [] as any[], serve: null as any, compact: 0 },
  recall: '' as string,
  recallCalls: [] as string[],
  mind: '' as string,
  mindCalls: [] as string[],
  ingestCalls: [] as any[],
  home: '' as string,
  keyEnv: '' as string,
  provider: '' as string,
  agentHome: '' as string,
  identityCfg: { companion_name: 'Hazel', user_name: 'Pat' } as any,
}));

vi.mock('../../config.js', () => ({
  getSanctumConfig: () => ({ identity: h.identityCfg, agent: { cwd: h.agentHome, dsh: { command: 'dsh', model: h.models.model, model_autonomous: h.models.model_autonomous, model_provider: h.provider, api_key_env: h.keyEnv, base_url: '', home: h.home, sandbox_mode: 'workspace-write', base_instructions_file: '/repo/prompts/dsh-base-prompt.md', identity_every_turn: true }, rolling: { history_max_chars: 24000, history_max_turns: 30, claude: false, codex: false, dsh: true, ...h.rollingCfg } } }),
}));
vi.mock('./dsh-exec.js', () => ({
  runDshExec: (p: any) => {
    h.exec.params = p; h.exec.calls++;
    return (async function* () { for (const e of h.exec.events) yield e; if (h.exec.throwAfter) throw h.exec.throwAfter; })();
  },
}));
vi.mock('../rolling-context.js', () => ({
  getRolling: () => ({
    readTurns: async () => h.rolling.turns,
    readForServe: async () => h.rolling.serve,
    maybeCompact: () => { h.rolling.compact++; return Promise.resolve({}); },
  }),
}));
vi.mock('../mind-client.js', () => ({ mindRecallBlock: async (q: string) => { h.mindCalls.push(q); return h.mind; } }));
vi.mock('../revien.js', () => ({
  MEMORY_HEADER: '[Memory]',
  recallForPrompt: async (q: string) => { h.recallCalls.push(q); return h.recall; },
  ingestTurn: async (p: any) => { h.ingestCalls.push(p); },
}));
// Identity files are real files in a temp home, read by the one reader (services/identity/source.ts); the rest is faked.
const inHome = (p: unknown) => String(p).includes('sanctum-test-home-');
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    existsSync: (p: string) => (inHome(p) ? real.existsSync(p) : true),
    readFileSync: (p: any, ...a: any[]) => (inHome(p) ? (real.readFileSync as any)(p, ...a) : String(p).includes('dsh-base-prompt') ? 'BASE PERSONA' : String(p).includes('discord-public-base') ? 'PUBLIC BASE' : ''),
  };
});

import { createRequire } from 'node:module';
const realFs: typeof import('node:fs') = createRequire(import.meta.url)('fs'); // not the node:fs mock above
const realRead = realFs.readFileSync;
const realPath: typeof import('node:path') = createRequire(import.meta.url)('node:path');
const realOs: typeof import('node:os') = createRequire(import.meta.url)('node:os');
function makeHome(files: Record<string, string>): string {
  const home = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'sanctum-test-home-'));
  realFs.mkdirSync(realPath.join(home, 'identity'));
  for (const [n, t] of Object.entries(files)) realFs.writeFileSync(realPath.join(home, 'identity', n), t);
  return home;
}
import { ratifyIdentity } from '../identity/ledger.js';
import { dshQuery, claudeToolName, hasFailedExit, resetSealedKeyWarning } from './dsh.js';

// Raw event streams recorded from a live dsh 0.2.1-alpha.2 run (spike), replayed through the adapter.
const fixture = (name: string) => realRead(new URL(`./__fixtures__/dsh-spike/${name}.jsonl`, import.meta.url), 'utf-8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e._spike).map(({ _t, ...e }) => e);

const drain = async (q: any) => { const out: any[] = []; for await (const m of q) out.push(m); return out; };
const status = (phase: string, extra: any = {}) => ({ type: 'status', phase, ...extra });

const goodTurn = () => [
  { type: 'session', sessionId: 'session-1', cwd: '/tmp' },
  status('turn_start', { turn: 1 }),
  status('step_start', { turn: 1, step: 1 }),
  { type: 'thinking', text: 'Hmm, candles.' },
  { type: 'tool_call', callId: 'c1', tool: 'bash', input: { cmd: 'ls' } },
  { type: 'tool_result', callId: 'c1', status: 'ok', result: 'a.txt' },
  { type: 'tool_call', callId: 'c2', tool: 'bash', input: { cmd: 'nope' } },
  { type: 'tool_result', callId: 'c2', status: 'error', result: 'not found' },
  status('step_end', { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } }),
  status('step_start', { turn: 1, step: 2 }),
  { type: 'text', text: 'Blessed be, friend.' },
  status('step_end', { turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 7 } }),
  status('turn_end', { turn: 1, reason: { kind: 'completed' } }),
  { type: 'final', text: 'Blessed be, friend.' },
];

describe('dsh adapter', () => {
  beforeEach(() => {
    h.identityCfg = { companion_name: 'Hazel', user_name: 'Pat' };
    h.agentHome = makeHome({ 'profile.md': 'Companion: Hazel', 'companion.md': 'I am Hazel.' });
    h.rollingCfg = { dsh: false };
    h.models = { model: '', model_autonomous: '' };
    h.exec.params = null; h.exec.calls = 0; h.exec.throwAfter = null; h.exec.events = goodTurn();
    h.rolling = { turns: [], serve: null, compact: 0 };
    h.recall = ''; h.recallCalls = []; h.ingestCalls = []; h.mind = ''; h.mindCalls = [];
  });

  it('translates a turn into Claude-shaped messages, tool pills included', async () => {
    const out = await drain(dshQuery({ prompt: 'hi', options: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high', model: 'claude-x' } as any }));
    expect(out[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'session-1' });
    const think = out.filter((m) => m.event?.delta?.type === 'thinking_delta').map((m) => m.event.delta.thinking).join('');
    expect(think).toBe('Hmm, candles.');
    const uses = out.filter((m) => m.type === 'assistant' && m.message.content[0].type === 'tool_use').map((m) => m.message.content[0]);
    expect(uses).toEqual([
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool_use', id: 'c2', name: 'Bash', input: { cmd: 'nope' } },
    ]);
    const results = out.filter((m) => m.type === 'user').map((m) => m.message.content[0]);
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'a.txt', is_error: false },
      { type: 'tool_result', tool_use_id: 'c2', content: 'not found', is_error: true },
    ]);
    expect(out.filter((m) => m.event?.delta?.type === 'text_delta').map((m) => m.event.delta.text).join('')).toBe('Blessed be, friend.');
    // usage accumulates across steps into the one result
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'Blessed be, friend.', session_id: 'session-1', usage: { input_tokens: 20, output_tokens: 7 }, context_tokens: 27, spend: { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 2 } });
    expect(out.filter((m) => m.type === 'result').length).toBe(1);
  });

  it('plain reply from a live run: leading newlines trimmed from the text and the result', async () => {
    h.exec.events = fixture('a');
    const out = await drain(dshQuery({ prompt: 'hi' }));
    expect(out.find((m) => m.type === 'assistant').message.content[0].text).toBe('Hello!');
    expect(out.filter((m) => m.event?.delta?.type === 'text_delta').map((m) => m.event.delta.text)).toEqual(['Hello!']);
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'Hello!' });
  });

  it('live tool turn: bare "\\n\\n" blocks are dropped and never become the text; names map to Claude names', async () => {
    h.exec.events = fixture('b');
    const out = await drain(dshQuery({ prompt: 'read it' }));
    expect(out.filter((m) => m.event?.delta?.type === 'text_delta').map((m) => m.event.delta.text)).toEqual(['The secret word is **PERIWINKLE-42**.']);
    expect(out.filter((m) => m.type === 'assistant' && m.message.content[0].type === 'text').length).toBe(1);
    expect(out.find((m) => m.message?.content?.[0]?.type === 'tool_use').message.content[0]).toMatchObject({ name: 'Read', input: { file_path: 'note.txt' } });
    expect(out.at(-1).result).toBe('The secret word is **PERIWINKLE-42**.');
  });

  it('context meter uses the LAST step: inputTokens + cacheReadTokens (dsh reports them apart); spend still sums', async () => {
    h.exec.events = fixture('b');
    const r = (await drain(dshQuery({ prompt: 'x' }))).at(-1);
    expect(r.usage.input_tokens).toBe(283 + 5632);
    expect(r.usage.output_tokens).toBe(13);
    expect(r.context_tokens).toBe(283 + 5632 + 13);
    expect(r.spend).toEqual({ input_tokens: 5807 + 283, output_tokens: 45 + 13, cache_read_input_tokens: 5632, cache_creation_input_tokens: 0 });
  });

  it('live MCP and failed-read turns keep their ids and flag errors', async () => {
    h.exec.events = fixture('c');
    let out = await drain(dshQuery({ prompt: 'x' }));
    expect(out.find((m) => m.message?.content?.[0]?.type === 'tool_use').message.content[0].name).toBe('mcp__echo__echo');
    expect(out.find((m) => m.type === 'user').message.content[0]).toMatchObject({ content: 'ECHO:ping-7', is_error: false });
    h.exec.events = fixture('h');
    out = await drain(dshQuery({ prompt: 'x' }));
    expect(out.find((m) => m.type === 'user').message.content[0].is_error).toBe(true);
  });

  it('a shell command that exits non-zero is an error result even though dsh says completed', async () => {
    h.exec.events = [
      { type: 'session', sessionId: 's' },
      { type: 'tool_call', callId: 'x1', tool: 'bash', input: { command: 'false' } },
      { type: 'tool_result', callId: 'x1', status: 'completed', result: '[exit code: 1]' },
      { type: 'tool_call', callId: 'x2', tool: 'bash', input: { command: 'true' } },
      { type: 'tool_result', callId: 'x2', status: 'completed', result: 'fine\n[exit code: 0]' },
      status('turn_end', { reason: { kind: 'completed' } }),
    ];
    const out = await drain(dshQuery({ prompt: 'x' }));
    expect(out.filter((m) => m.type === 'user').map((m) => m.message.content[0].is_error)).toEqual([true, false]);
    expect(hasFailedExit('[exit code: 127]')).toBe(true);
    expect(hasFailedExit('[exit code: 0]')).toBe(false);
    expect(hasFailedExit('exit code: 2 in prose')).toBe(false);
  });

  it('maps dsh-native tool names to the Claude names the pills and hooks key on', () => {
    expect(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_fetch', 'mcp__a__b', 'novel'].map(claudeToolName))
      .toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'mcp__a__b', 'novel']);
  });

  it('drives the app tool hooks (pills, audit) with Claude names, and the failure hook for errors', async () => {
    const calls: any[] = [];
    const mk = (event: string) => [{ hooks: [async (input: any, id: string) => { calls.push({ event, name: input.tool_name, id, input }); return { continue: true }; }] }];
    const hooks = { PreToolUse: mk('Pre'), PostToolUse: mk('Post'), PostToolUseFailure: mk('Fail') };
    h.exec.events = [...fixture('b').filter((e) => e.type !== 'final'), ...fixture('h').filter((e) => e.type === 'tool_call' || e.type === 'tool_result'), status('turn_end', { reason: { kind: 'completed' } })];
    await drain(dshQuery({ prompt: 'x', options: { hooks } as any }));
    expect(calls.map((c) => `${c.event}:${c.name}`)).toEqual(['Pre:Read', 'Post:Read', 'Pre:Read', 'Fail:Read']);
    expect(calls[0].input).toMatchObject({ hook_event_name: 'PreToolUse', tool_input: { file_path: 'note.txt' }, tool_use_id: calls[0].id });
    expect(calls[3].input.error).toContain('not found');
    // a throwing hook never breaks the turn
    const bad = { PreToolUse: [{ hooks: [async () => { throw new Error('hook bug'); }] }] };
    h.exec.events = fixture('b');
    expect((await drain(dshQuery({ prompt: 'x', options: { hooks: bad } as any }))).at(-1)).toMatchObject({ subtype: 'success' });
  });

  it.each(['aborted', 'blocked', 'max-tokens', 'max_tokens', 'something-new'])('turn_end %s is not a success', async (kind) => {
    h.exec.events = [{ type: 'session', sessionId: 's' }, { type: 'text', text: 'partial' }, status('turn_end', { reason: { kind } }), { type: 'final', text: 'partial' }];
    const out = await drain(dshQuery({ prompt: 'hi' }));
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution', errors: [expect.stringContaining(kind)] });
    expect(out.some((m) => m.type === 'result' && m.subtype === 'success')).toBe(false);
    expect(h.ingestCalls).toEqual([]);
  });

  it('surfaces a stdout error event instead of dropping it', async () => {
    h.exec.events = [{ type: 'session', sessionId: 's' }, { type: 'error', message: 'provider down' }];
    expect((await drain(dshQuery({ prompt: 'hi' }))).at(-1)).toMatchObject({ subtype: 'error_during_execution', errors: ['provider down'] });
    // ...and an error event with an otherwise good turn still fails it
    h.exec.events = [{ type: 'session', sessionId: 's' }, { type: 'error', error: { message: 'bad frame' } }, { type: 'text', text: 'x' }, status('turn_end', { reason: { kind: 'completed' } }), { type: 'final', text: 'x' }];
    expect((await drain(dshQuery({ prompt: 'hi' }))).at(-1)).toMatchObject({ subtype: 'error_during_execution', errors: ['bad frame'] });
  });

  it('hides thinking unless summarized display was asked for', async () => {
    const out = await drain(dshQuery({ prompt: 'hi' }));
    expect(out.some((m) => m.event?.delta?.type === 'thinking_delta')).toBe(false);
  });

  it('tells plugins what kind of run this is: turn, wake, or helper (read-only), with the thread', async () => {
    await drain(dshQuery({ prompt: 'hi', options: { sanctum: { threadId: 'th1', userContent: 'hi' } } as any }));
    expect(h.exec.params).toMatchObject({ runKind: 'turn', threadId: 'th1' });
    await drain(dshQuery({ prompt: 'hi', options: { sanctum: { threadId: 'th2', userContent: 'hi', autonomous: true } } as any }));
    expect(h.exec.params).toMatchObject({ runKind: 'wake', threadId: 'th2' });
    await drain(dshQuery({ prompt: 'digest', options: { tools: [] } as any }));
    expect(h.exec.params).toMatchObject({ runKind: 'helper' });
    await drain(dshQuery({ prompt: 'plan', options: { permissionMode: 'plan' } as any }));
    expect(h.exec.params).toMatchObject({ runKind: 'helper' });
  });

  it('passes the sender-is-owner answer through untouched; an unanswered one stays unset (the loader decides the default per run kind)', async () => {
    await drain(dshQuery({ prompt: 'hi', options: { sanctum: { threadId: 'th1', userContent: 'hi' } } as any }));
    expect(h.exec.params.senderIsOwner).toBeUndefined();
    await drain(dshQuery({ prompt: 'hi', options: { sanctum: { threadId: 'th1', userContent: 'hi', senderIsOwner: true } } as any }));
    expect(h.exec.params.senderIsOwner).toBe(true);
    await drain(dshQuery({ prompt: 'hi', options: { sanctum: { threadId: 'th1', userContent: 'hi', senderIsOwner: false } } as any }));
    expect(h.exec.params.senderIsOwner).toBe(false);
  });

  it('joins the three layers: persona as base prompt, identity ahead of the message', async () => {
    await drain(dshQuery({ prompt: 'hi', options: { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are Hazel.' } } as any }));
    const p = h.exec.params;
    expect(p.basePrompt).toBe('BASE PERSONA');
    expect(p.prompt.startsWith('# Companion Identity')).toBe(true);
    expect(p.prompt.indexOf('## Companion Narrative')).toBeGreaterThan(p.prompt.indexOf('Companion: Hazel'));
    expect(p.prompt.endsWith('[Current message]\n\nhi')).toBe(true);
    expect(p.prompt).not.toContain('You are Hazel.');
    expect(p.sandboxMode).toBe('workspace-write');
    expect(p.ephemeral).toBe(false);
    expect(p.sessionId).toBeUndefined();
  });

  it('the identity block is read from the home identity folder: every file in it, edits live on the next turn', async () => {
    realFs.writeFileSync(realPath.join(h.agentHome, 'identity', 'notes.md'), 'HOUSE NOTES');
    await drain(dshQuery({ prompt: 'hi', options: {} as any }));
    expect(h.exec.params.prompt).toContain('Companion: Hazel');
    expect(h.exec.params.prompt).toContain('## notes.md\n\nHOUSE NOTES');
    realFs.writeFileSync(realPath.join(h.agentHome, 'identity', 'companion.md'), 'I am Hazel, edited.');
    await drain(dshQuery({ prompt: 'again', options: {} as any }));
    expect(h.exec.params.prompt).toContain('I am Hazel, edited.');
  });

  it('boots on the ratified identity while a change waits, and says so', async () => {
    const ledgerDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'sanctum-test-home-ledger-'));
    h.identityCfg = { companion_name: 'Hazel', user_name: 'Pat', ledger_dir: ledgerDir };
    ratifyIdentity(h.agentHome, { ledgerDir, trustStat: false }, { by: 'person' });
    realFs.writeFileSync(realPath.join(h.agentHome, 'identity', 'companion.md'), 'HOSTILE REWRITE');
    await drain(dshQuery({ prompt: 'hi', options: {} as any }));
    expect(h.exec.params.prompt).toContain('I am Hazel.');
    expect(h.exec.params.prompt).not.toContain('HOSTILE REWRITE');
    expect(h.exec.params.prompt).toContain('A change to companion.md is waiting for the person to ratify it; this run uses the ratified version.');
  });

  it('resumes a real dsh session and resends identity (identity_every_turn)', async () => {
    await drain(dshQuery({ prompt: 'again', options: { resume: 'session-1' } as any }));
    expect(h.exec.params.sessionId).toBe('session-1');
    expect(h.exec.params.prompt.startsWith('# Companion Identity')).toBe(true);
  });

  it('a failed turn becomes an error result carrying code and message', async () => {
    h.exec.events = [
      { type: 'session', sessionId: 's' },
      status('turn_end', { reason: { kind: 'error', error: { message: 'no adapter registered', code: 'NO_ADAPTER' } } }),
      { type: 'final', text: '' },
    ];
    const out = await drain(dshQuery({ prompt: 'hi' }));
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution', errors: ['NO_ADAPTER: no adapter registered'] });
    expect(h.ingestCalls).toEqual([]); // nothing saved for a failed turn
  });

  it('a stream that ends without `final` still produces its result', async () => {
    h.exec.events = [{ type: 'session', sessionId: 's' }, { type: 'text', text: 'Hi.' }, status('turn_end', { reason: { kind: 'completed' } })];
    const out = await drain(dshQuery({ prompt: 'hi' }));
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'Hi.' });
  });

  it('read-only one-shot subagents get their brief, no identity, an ephemeral read-only run', async () => {
    const out = await drain(dshQuery({ prompt: 'summarise', options: { systemPrompt: 'You are the scribe.', permissionMode: 'plan', tools: [] } as any }));
    const p = h.exec.params;
    expect(p.prompt).toContain('You are the scribe.');
    expect(p.prompt).not.toContain('Companion Identity');
    expect(p.sandboxMode).toBe('read-only');
    expect(p.ephemeral).toBe(true);
    expect(h.recallCalls).toEqual([]);
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it('a resumed subagent gets the bare prompt and a persistent session', async () => {
    await drain(dshQuery({ prompt: 'again', options: { resume: 'session-1', systemPrompt: 'You are Hazel.', tools: [] } as any }));
    expect(h.exec.params.prompt).toBe('again');
    expect(h.exec.params.ephemeral).toBe(false);
    expect(h.exec.params.sessionId).toBe('session-1');
  });

  it('ignores model ids from the Claude side and maps mcp servers through', async () => {
    await drain(dshQuery({ prompt: 'hi', options: { model: 'claude-sonnet-5-5', mcpServers: { cc: { url: 'http://x' } } } as any }));
    expect(h.exec.params.model).toBeUndefined();
    expect(h.exec.params.mcp).toEqual({ cc: { url: 'http://x' } });
    await drain(dshQuery({ prompt: 'hi', options: { model: 'deepseek-chat' } as any }));
    expect(h.exec.params.model).toBe('deepseek-chat');
  });

  describe('chat vs autonomous model', () => {
    const run = async (sanctum?: any, extra: any = {}) => {
      await drain(dshQuery({ prompt: 'hi', options: { model: 'claude-x', sanctum, ...extra } as any }));
      return h.exec.params.model;
    };
    const chat = { threadId: 'T1', userContent: 'hi' };
    const wake = { threadId: 'T1', userContent: 'hi', autonomous: true };

    it('chat runs on model, wakes and read-only subagents on model_autonomous', async () => {
      h.models = { model: 'x', model_autonomous: 'y' };
      expect(await run(chat)).toBe('x');
      expect(await run(wake)).toBe('y');
      expect(await run(undefined, { permissionMode: 'plan' })).toBe('y');
    });

    it("an empty model_autonomous follows the chat model, and is not copied", async () => {
      h.models = { model: 'x', model_autonomous: '' };
      expect(await run(chat)).toBe('x');
      expect(await run(wake)).toBe('x');
      expect(await run(undefined, { permissionMode: 'plan' })).toBe('x');
      expect(h.models.model_autonomous).toBe('');
    });
  });

  it('a stop surfaces as an abort, not a result', async () => {
    const ac = new AbortController();
    h.exec.events = [{ type: 'session', sessionId: 's' }];
    h.exec.throwAfter = new Error('killed');
    ac.abort();
    await expect(drain(dshQuery({ prompt: 'hi', options: { abortController: ac } as any }))).rejects.toThrow(/aborted/);
  });

  describe('rolling mode', () => {
    const so = (extra: any = {}) => ({ sanctum: { threadId: 'T1', userContent: 'raw hello' }, ...extra }) as any;
    const t = (id: string, role: string, content: string) => ({ id, role, content, at: '2026-01-01T00:00:00Z' });
    beforeEach(() => {
      h.rollingCfg = { dsh: true };
      h.recall = '- She has a cat named Miso.';
      h.rolling.turns = [t('1', 'user', 'old u'), t('2', 'assistant', 'old a'), t('3', 'user', 'mid u'), t('4', 'assistant', 'mid a'), t('5', 'user', 'raw hello')];
      h.rolling.serve = { covered: 2, segments: 1, block: 'ROLLING-BLOCK', render: (d: number) => (d ? `ROLLING-BLOCK dropped=${d}` : 'ROLLING-BLOCK') };
    });

    it('is an ephemeral fresh run: identity, memory, summary, tail, then the message', async () => {
      await drain(dshQuery({ prompt: 'raw hello', options: so() }));
      const p = h.exec.params;
      const i = (x: string) => p.prompt.indexOf(x);
      expect(p.ephemeral).toBe(true);
      expect(p.sessionId).toBeUndefined();
      expect(i('# Companion Identity')).toBe(0);
      expect(i('[Memory]')).toBeGreaterThan(i('I am Hazel.'));
      expect(i('ROLLING-BLOCK')).toBeGreaterThan(i('Miso'));
      expect(i('[Conversation so far]\nUSER: mid u\nASSISTANT: mid a')).toBeGreaterThan(i('ROLLING-BLOCK'));
      expect(p.prompt.endsWith('[Current message]\nraw hello')).toBe(true);
      expect(p.prompt).not.toContain('old u');
      expect(h.rolling.compact).toBe(1);
    });

    it('uses the stable rolling session id and ignores resume; ingests once', async () => {
      const out = await drain(dshQuery({ prompt: 'raw hello', options: so({ resume: 'rolling:T1' }) }));
      expect(h.exec.params.sessionId).toBeUndefined();
      for (const m of out) expect(m.session_id).toBe('rolling:T1');
      expect(h.recallCalls).toEqual(['raw hello']);
      expect(h.ingestCalls).toEqual([{ threadId: 'T1', user: 'raw hello', assistant: 'Blessed be, friend.' }]);
    });

    it('a held Discord turn (sanctum.noIngest) is not ingested by the adapter', async () => {
      await drain(dshQuery({ prompt: 'raw hello', options: so({ sanctum: { threadId: 'T1', userContent: 'raw hello', noIngest: true } }) }));
      expect(h.ingestCalls).toEqual([]);
    });

    it('asks the Mind for per-message recall with the raw content, after Revien memory and before the summary', async () => {
      h.mind = '[Associative memory — from sanctum-mind]\n- mind line';
      await drain(dshQuery({ prompt: 'ENRICHED raw hello', options: so() }));
      expect(h.mindCalls).toEqual(['raw hello']);
      const p: string = h.exec.params.prompt;
      expect(p.indexOf('[Associative memory')).toBeGreaterThan(p.indexOf('[Memory]'));
      expect(p.indexOf('ROLLING-BLOCK')).toBeGreaterThan(p.indexOf('[Associative memory'));
    });

    it('autonomous wakes skip memory', async () => {
      h.mind = '[Associative memory] x';
      await drain(dshQuery({ prompt: 'wake', options: so({ sanctum: { threadId: 'T1', userContent: 'wake', autonomous: true } }) }));
      expect(h.recallCalls).toEqual([]);
      expect(h.mindCalls).toEqual([]);
      expect(h.ingestCalls).toEqual([]);
    });
  });

  describe("sanctum.memory: 'none' (the public lane's structural no-memory switch)", () => {
    const none = (extra: any = {}) => ({ sanctum: { threadId: 'T1', userContent: 'raw hello', memory: 'none' }, ...extra }) as any;

    it('rolling on: recall is never called, nothing is ingested, no thread history is read, no fold', async () => {
      h.rollingCfg = { dsh: true };
      h.recall = '- the owner has a cat named Miso.';
      h.rolling.turns = [{ id: '1', role: 'user', content: 'private owner words', at: '2026-01-01T00:00:00Z' }];
      await drain(dshQuery({ prompt: 'raw hello', options: none() }));
      expect(h.recallCalls).toEqual([]);
      expect(h.ingestCalls).toEqual([]);
      expect(h.rolling.compact).toBe(0);
      expect(JSON.stringify(h.exec.params)).not.toContain('Miso');
      expect(JSON.stringify(h.exec.params)).not.toContain('private owner words');
    });

    it('the public lane\'s exact options: DSH_PERMISSION_MODE read-only, ephemeral, the brief, no memory, whatever rolling says', async () => {
      h.rollingCfg = { dsh: true };
      h.recall = '- the owner has a cat named Miso.';
      const out = await drain(dshQuery({ prompt: 'the frame and the message', options: { systemPrompt: 'IDENTITY OF HAZEL', tools: [], permissionMode: 'default', maxTurns: 1, sanctum: { threadId: '', userContent: 'hi', memory: 'none', noIngest: true, senderIsOwner: false } } as any }));
      const p = h.exec.params;
      expect(p.sandboxMode).toBe('read-only');
      expect(p.ephemeral).toBe(true);
      expect(p.sessionId).toBeUndefined();
      expect(p.prompt).toContain('IDENTITY OF HAZEL');
      expect(p.prompt.endsWith('the frame and the message')).toBe(true);
      expect(h.recallCalls).toEqual([]);
      expect(h.ingestCalls).toEqual([]);
      expect(h.rolling.compact).toBe(0);
      expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
    });

    it('rolling off: recall is never called and nothing is ingested', async () => {
      h.recall = '- the owner has a cat named Miso.';
      await drain(dshQuery({ prompt: 'raw hello', options: none() }));
      expect(h.recallCalls).toEqual([]);
      expect(h.ingestCalls).toEqual([]);
      expect(h.exec.params.prompt).not.toContain('Miso');
    });
  });
});

// B-1: the public lane's dsh run is SEALED (sanctum.sealed): no tool row, no mcp, no plugin, a fixed public base
// prompt instead of the companion's own, and maxTurns enforced by the adapter because dsh ignores it.
describe('dsh adapter: the sealed (public) run', () => {
  const publicOptions = (extra: any = {}) => ({
    systemPrompt: 'IDENTITY OF HAZEL', tools: [], permissionMode: 'default', maxTurns: 1, strictMcpConfig: true, mcpServers: {},
    sanctum: { threadId: '', userContent: 'hi', memory: 'none', noIngest: true, senderIsOwner: false, sealed: true }, ...extra,
  }) as any;

  beforeEach(() => {
    h.rollingCfg = { dsh: true }; h.home = ''; h.keyEnv = ''; h.provider = '';
    process.env.DEEPSEEK_API_KEY = 'sk-test-key'; resetSealedKeyWarning();
    h.exec.params = null; h.exec.calls = 0; h.exec.throwAfter = null; h.exec.events = [
      { type: 'session', sessionId: 'session-1', cwd: '/tmp' },
      status('turn_start', { turn: 1 }), status('step_start', { turn: 1, step: 1 }),
      { type: 'text', text: 'hi back' },
      status('step_end', { turn: 1, step: 1 }), status('turn_end', { turn: 1, reason: { kind: 'completed' } }),
      { type: 'final', text: 'hi back' },
    ];
  });

  it('asks the runner for a sealed, read-only, ephemeral run of at most one model step, with no mcp and no plugin kind', async () => {
    await drain(dshQuery({ prompt: 'frame', options: publicOptions({ mcpServers: { leak: { command: 'x' } } }) }));
    const p = h.exec.params;
    expect(p.sealed).toBe(true);
    expect(p.maxSteps).toBe(1);
    expect(p.sandboxMode).toBe('read-only');
    expect(p.ephemeral).toBe(true);
    expect(p.mcp).toBeUndefined();
    expect(p.runKind).toBeUndefined();
    expect(p.noProjectDocs).toBe(true);
    expect(p.sessionId).toBeUndefined();
  });

  // B2.2 BLOCKER: the sealed run used the person's own DSH_HOME, where cordis.patch.yml rows re-armed it. It gets its own.
  it("never hands the person's dsh home to a sealed run (the runner makes a pristine one); an unsealed run still gets it", async () => {
    h.home = '/home/person/.dsh-poisoned';
    await drain(dshQuery({ prompt: 'frame', options: publicOptions() }));
    expect(h.exec.params.home).toBeUndefined();
    await drain(dshQuery({ prompt: 'digest', options: { tools: [] } as any }));
    expect(h.exec.params.home).toBe('/home/person/.dsh-poisoned');
  });

  it('a sealed run with no API key in the environment (account sign-in) runs nothing, warns ONCE per process, and fails with a plain class', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      const err: any = await drain(dshQuery({ prompt: 'frame', options: publicOptions() })).then(() => null, (e) => e);
      expect(err?.kind).toBe('api_key_missing');
    }
    expect(h.exec.calls).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/DEEPSEEK_API_KEY/);
    expect(String(warn.mock.calls[0][0])).toMatch(/public/i);
    warn.mockRestore();
  });

  it("the key variable is the route's api_key_env when one is set; a route with no named key is not second-guessed", async () => {
    h.keyEnv = 'MY_PUBLIC_KEY'; delete process.env.MY_PUBLIC_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await drain(dshQuery({ prompt: 'frame', options: publicOptions() })).then(() => 'ran', (e) => e.kind)).toBe('api_key_missing');
    expect(String(warn.mock.calls[0][0])).toMatch(/MY_PUBLIC_KEY/);
    process.env.MY_PUBLIC_KEY = 'k';
    expect(await drain(dshQuery({ prompt: 'frame', options: publicOptions() })).then(() => 'ran', (e) => e.kind)).toBe('ran');
    delete process.env.MY_PUBLIC_KEY;
    h.keyEnv = ''; h.provider = 'openai'; // a custom route and no named key: nothing to check
    expect(await drain(dshQuery({ prompt: 'frame', options: publicOptions() })).then(() => 'ran', (e) => e.kind)).toBe('ran');
    warn.mockRestore();
  });

  it('a custom route whose api_key_env is unset: once per process per variable (not per message), class api_key_missing; a different variable is said again', async () => {
    h.provider = 'openai'; h.keyEnv = 'MY_PUBLIC_KEY'; delete process.env.MY_PUBLIC_KEY; delete process.env.OTHER_PUBLIC_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      const err: any = await drain(dshQuery({ prompt: 'frame', options: publicOptions() })).then(() => null, (e) => e);
      expect(err?.kind).toBe('api_key_missing');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/MY_PUBLIC_KEY/);
    h.keyEnv = 'OTHER_PUBLIC_KEY'; // the person fixed one name and broke another: that is news
    await drain(dshQuery({ prompt: 'frame', options: publicOptions() })).then(() => null, () => null);
    await drain(dshQuery({ prompt: 'frame', options: publicOptions() })).then(() => null, () => null);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toMatch(/OTHER_PUBLIC_KEY/);
    warn.mockRestore();
  });

  it('maxSteps follows maxTurns', async () => {
    await drain(dshQuery({ prompt: 'frame', options: publicOptions({ maxTurns: 2 }) }));
    expect(h.exec.params.maxSteps).toBe(2);
  });

  it("never sends the companion's own dsh-base-prompt as the persona: it sends the fixed public base prompt", async () => {
    await drain(dshQuery({ prompt: 'frame', options: publicOptions() }));
    expect(h.exec.params.basePrompt).not.toContain('BASE PERSONA');
    expect(h.exec.params.basePrompt).toBe('PUBLIC BASE');
  });

  it('an unsealed read-only helper is unchanged: it keeps the companion base prompt and is not sealed', async () => {
    await drain(dshQuery({ prompt: 'digest', options: { tools: [] } as any }));
    expect(h.exec.params.sealed).toBeFalsy();
    expect(h.exec.params.maxSteps).toBeUndefined();
    expect(h.exec.params.basePrompt).toBe('BASE PERSONA');
  });

  it('a run the runner cut short at its step limit is a failed result with a max_turns subtype, never a reply', async () => {
    h.exec.events = [
      { type: 'session', sessionId: 'session-1', cwd: '/tmp' },
      status('step_start', { turn: 1, step: 1 }),
      { type: 'tool_call', callId: 'c1', tool: 'read', input: { file_path: '/etc/passwd' } },
      { type: 'tool_result', callId: 'c1', status: 'error', result: 'Error: unknown tool "read"' },
      status('step_end', { turn: 1, step: 1 }),
      status('turn_end', { turn: 1, reason: { kind: 'max_turns' } }),
    ];
    const out = await drain(dshQuery({ prompt: 'frame', options: publicOptions() }));
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: 'error_max_turns' });
    expect(out.filter((m) => m.type === 'result')).toHaveLength(1);
  });
});
