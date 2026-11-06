import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSummary, summarizerEngine, summarySystem, type SummaryDeps } from './index.js';
import { resolveSummarizer, resetSummarizerWarnings, looksSmallTier, warnIfSmallSummarizer, checkSummarizerConfig, SMALL_MODEL_WARNING, type ResolvedSummarizer } from './config.js';
import { fenceTranscript, placeBudgetRules } from '../rolling-context.js';
import { buildCompactionPrompt } from '../rolling/theora-rolling-context.js';

const R = (over: Partial<ResolvedSummarizer>): ResolvedSummarizer => ({
  provider: 'claude', model: 'big-model', route: '', baseUrl: '', apiKeyEnv: 'SUMMARIZER_API_KEY', maxOutputTokens: 2000, headers: {}, aliased: false, ...over,
});
const IDENTITY = '## Who you are (short)\nYou are Echo. You are writing for yourself, about your life with Sam.';
const INSTRUCTION = 'You are Echo. Write in the first person.';
const USER = 'Budget: 1200 chars\n\n<transcript>\nUSER: hi\n</transcript>';

function stubs(r: ResolvedSummarizer, env: Record<string, string> = {}) {
  const calls: Record<string, any[]> = { claude: [], codex: [], dsh: [], chat: [] };
  const deps: Partial<SummaryDeps> = {
    identity: async () => IDENTITY,
    resolve: () => r,
    dir: () => '/tmp/rolling-x',
    env: () => env as NodeJS.ProcessEnv,
    auth: () => {},
    materialize: (t) => { calls.codexBase = [t]; return '/tmp/base.md'; },
    claude: (async (o: any) => { calls.claude.push(o); return 'claude account'; }) as any,
    chat: (async (o: any) => { calls.chat.push(o); return { text: 'chat account' }; }) as any,
    dsh: (async (o: any) => { calls.dsh.push(o); return { text: 'dsh account' }; }) as any,
    codex: (async function* (o: any) { calls.codex.push(o); yield { type: 'item.completed', item: { type: 'agent_message', text: 'codex account' } }; }) as any,
  };
  return { calls, deps };
}
const ARGS = { kind: 'rolling' as const, system: INSTRUCTION, user: USER };
vi.mock('../../tenancy/own-files.js', async (orig) => ({ ...(await orig() as object), ownMkdirAsync: async () => {} }));

describe('runSummary dispatch', () => {
  it('applies the person\'s auth choice before a harness run, and not for the plain chat client', async () => {
    const auth = vi.fn();
    const h = stubs(R({ provider: 'claude', model: 'claude-x' }));
    await runSummary(ARGS, { ...h.deps, auth });
    expect(auth).toHaveBeenCalledTimes(1);
    const c = stubs(R({ provider: 'openai-compat', model: 'm', baseUrl: 'https://x.test/v1' }), { SUMMARIZER_API_KEY: 'k' });
    await runSummary(ARGS, { ...c.deps, auth });
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it('claude: the SDK side-run with identity + instruction in the system slot and the transcript as the user message', async () => {
    const { calls, deps } = stubs(R({ provider: 'claude', model: 'claude-x' }));
    expect(await runSummary(ARGS, deps)).toBe('claude account');
    const c = calls.claude[0];
    expect(c.system).toBe(summarySystem(IDENTITY, INSTRUCTION));
    expect(c.system).toContain('You are Echo. You are writing for yourself');
    expect(c.system).toContain(INSTRUCTION);
    expect(c.user).toBe(USER);
    expect(c.system).not.toContain('<transcript>');
    expect(c.user).not.toContain('Who you are');
    expect(c).toMatchObject({ cwd: '/tmp/rolling-x', model: 'claude-x' });
    expect(calls.chat.length + calls.codex.length + calls.dsh.length).toBe(0);
  });
  it('codex: read-only, offline, no harness memory, no AGENTS.md, the system slot is the base file', async () => {
    const { calls, deps } = stubs(R({ provider: 'codex', model: 'gpt-x', route: 'myroute' }));
    expect(await runSummary(ARGS, deps)).toBe('codex account');
    expect(calls.codexBase[0]).toBe(summarySystem(IDENTITY, INSTRUCTION));
    expect(calls.codex[0]).toMatchObject({ prompt: USER, sandboxMode: 'read-only', networkAccess: false, harnessMemory: false, noProjectDocs: true, baseFile: '/tmp/base.md', model: 'gpt-x', modelProvider: 'myroute', cwd: '/tmp/rolling-x' });
  });
  it('dsh: the system slot is the base prompt text', async () => {
    const { calls, deps } = stubs(R({ provider: 'dsh', model: 'ds-x' }));
    expect(await runSummary(ARGS, deps)).toBe('dsh account');
    expect(calls.dsh[0]).toMatchObject({ prompt: USER, basePrompt: summarySystem(IDENTITY, INSTRUCTION), dir: '/tmp/rolling-x', model: 'ds-x' });
  });
  it('openai-compat: the key comes from the named env var, headers and max tokens from config', async () => {
    const { calls, deps } = stubs(R({ provider: 'openai-compat', model: 'deepseek/x', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'MY_KEY', headers: { 'X-Title': 'S' }, maxOutputTokens: 1500 }), { MY_KEY: 'sk-1' });
    expect(await runSummary(ARGS, deps)).toBe('chat account');
    expect(calls.chat[0]).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-1', model: 'deepseek/x', system: summarySystem(IDENTITY, INSTRUCTION), user: USER, maxTokens: 1500, headers: { 'X-Title': 'S' } });
    expect((await runSummary({ ...ARGS, maxTokens: 300 }, deps)) && calls.chat[1].maxTokens).toBe(300);
  });
  it('openai-compat refuses a missing base_url, model or key, before any request', async () => {
    const mk = (over: Partial<ResolvedSummarizer>, env = { SUMMARIZER_API_KEY: 'k' }) => stubs(R({ provider: 'openai-compat', model: 'm', baseUrl: 'https://x/v1', ...over }), env);
    await expect(runSummary(ARGS, mk({ baseUrl: '' }).deps)).rejects.toThrow(/base_url/);
    await expect(runSummary(ARGS, mk({ model: '' }).deps)).rejects.toThrow(/model/);
    const nokey = mk({}, {} as any);
    await expect(runSummary(ARGS, nokey.deps)).rejects.toThrow(/SUMMARIZER_API_KEY/);
    expect(nokey.calls.chat.length).toBe(0);
  });
  it('the engine label names the client and model', () => {
    expect(summarizerEngine(R({ provider: 'claude', model: 'c' }))).toBe('claude:c');
    expect(summarizerEngine(R({ provider: 'openai-compat', model: 'm' }))).toBe('openai-compat:m');
    expect(summarizerEngine(R({ provider: 'codex' }))).toBe('codex');
  });
  it('the budget rules sit before the fenced transcript in the user message (the guards ride along unchanged)', async () => {
    const { calls, deps } = stubs(R({ provider: 'claude' }));
    const prompt = fenceTranscript(placeBudgetRules(buildCompactionPrompt([], [{ id: 'a', role: 'user', content: 'hello' }], { user: 'Sam' }), 'aim for 1200 characters'));
    await runSummary({ ...ARGS, user: prompt }, deps);
    const u = calls.claude[0].user as string;
    expect(u.indexOf('Budget (housekeeping')).toBeLessThan(u.indexOf('<transcript>'));
    expect(u).toContain('<transcript>\nUSER: hello\n</transcript>');
  });
});

describe('resolveSummarizer: provider, model and the deprecated aliases', () => {
  beforeEach(() => resetSummarizerWarnings());
  const cfg = (agent: any) => ({ agent: { model: 'chat-model', model_autonomous: 'auto-model', rolling: {}, codex: { model: 'cx', model_autonomous: '', model_provider: 'cxroute' }, dsh: { model: 'ds', model_autonomous: '' }, ...agent } }) as any;
  it('empty = the chat harness and its autonomous model', () => {
    expect(resolveSummarizer(cfg({}), 'claude')).toMatchObject({ provider: 'claude', model: 'auto-model' });
    expect(resolveSummarizer(cfg({}), 'codex')).toMatchObject({ provider: 'codex', model: 'cx', route: 'cxroute' });
    expect(resolveSummarizer(cfg({}), 'dsh')).toMatchObject({ provider: 'dsh', model: 'ds' });
  });
  it('agent.summarizer wins; a non-claude model on the claude summarizer falls back to the chat model', () => {
    const r = resolveSummarizer(cfg({ summarizer: { provider: 'openai-compat', model: 'deepseek/x', base_url: 'https://o/v1', max_output_tokens: 900 } }), 'claude');
    expect(r).toMatchObject({ provider: 'openai-compat', model: 'deepseek/x', baseUrl: 'https://o/v1', maxOutputTokens: 900, apiKeyEnv: 'SUMMARIZER_API_KEY' });
    expect(resolveSummarizer(cfg({ summarizer: { model: 'gpt-5-whatever' } }), 'claude', () => {}).model).toBe('auto-model');
  });
  it('rolling.model / rolling.model_provider are aliases while summarizer is empty, with one deprecation warning each', () => {
    const warn = vi.fn();
    const c = cfg({ rolling: { model: 'old-model', model_provider: 'dsh' } });
    const r = resolveSummarizer(c, 'claude', warn);
    expect(r).toMatchObject({ provider: 'dsh', model: 'old-model', aliased: true });
    resolveSummarizer(c, 'claude', warn);
    expect(warn.mock.calls.map((x) => x[0])).toEqual([
      '[config] agent.rolling.model is deprecated, use agent.summarizer.model',
      '[config] agent.rolling.model_provider is deprecated, use agent.summarizer.provider',
    ]);
    const w2 = vi.fn();
    expect(resolveSummarizer(cfg({ rolling: { model: 'old' }, summarizer: { model: 'claude-new' } }), 'claude', w2).model).toBe('claude-new');
    expect(w2).not.toHaveBeenCalled();
  });
  it('a leftover non-claude alias on the claude summarizer falls back to the chat model, with one warning', () => {
    const warn = vi.fn();
    const c = cfg({ rolling: { model: 'gpt-5-mini' } });
    expect(resolveSummarizer(c, 'claude', warn).model).toBe(resolveSummarizer(cfg({}), 'claude', () => {}).model);
    resolveSummarizer(c, 'claude', warn);
    expect(warn.mock.calls.filter((x) => /not a Claude model/.test(x[0]))).toHaveLength(1);
    expect(resolveSummarizer(cfg({ rolling: { model: 'claude-opus-x' } }), 'claude', () => {}).model).toBe('claude-opus-x');
  });
  it('an explicit openai-compat provider keeps a non-claude model', () => {
    const warn = vi.fn();
    const r = resolveSummarizer(cfg({ rolling: { model: 'gpt-5-mini' }, summarizer: { provider: 'openai-compat' } }), 'claude', warn);
    expect(r).toMatchObject({ provider: 'openai-compat', model: 'gpt-5-mini' });
    expect(warn.mock.calls.filter((x) => /not a Claude model/.test(x[0]))).toHaveLength(0);
  });
  it('openai-compat with no model is refused at boot with a line naming the key, once', () => {
    const warn = vi.fn();
    const c = cfg({ summarizer: { provider: 'openai-compat', base_url: 'https://x/v1' } });
    expect(resolveSummarizer(c, 'claude', () => {}).model).toBe('');
    expect(checkSummarizerConfig(c, 'claude', '', warn)).toHaveLength(1);
    checkSummarizerConfig(c, 'claude', '', warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('agent.summarizer.model');
    expect(checkSummarizerConfig(cfg({ summarizer: { provider: 'openai-compat', base_url: 'https://x/v1', model: 'm/x' } }), 'claude', '', warn)).toEqual([]);
    expect(checkSummarizerConfig(cfg({}), 'claude', '', warn)).toEqual([]);
  });
  it('a rolling.model_provider that is a route name stays a route of the chat harness', () => {
    expect(resolveSummarizer(cfg({ rolling: { model_provider: 'openrouter' } }), 'codex', () => {})).toMatchObject({ provider: 'codex', route: 'openrouter' });
  });
});

describe('the small-model startup warning', () => {
  beforeEach(() => resetSummarizerWarnings());
  it('matches small-tier names and leaves capable ones (and "gemini") alone', () => {
    for (const m of ['claude-haiku-5-5', 'gpt-5-mini', 'o4-mini', 'gemma-2-small', 'flash-lite', 'gpt-5-nano', 'llama-3.1-8b-instruct', 'qwen2.5-7B']) expect(looksSmallTier(m), m).toBe(true);
    for (const m of ['claude-sonnet-5-5', 'deepseek/deepseek-chat-v3', 'gemini-2.5-pro', 'llama-3.1-70b', 'gpt-5']) expect(looksSmallTier(m), m).toBe(false);
  });
  it('warns once with the docs pointer, for a tenant too', () => {
    const warn = vi.fn();
    const c = { agent: { model: 'claude-sonnet-5-5', model_autonomous: '', rolling: {}, summarizer: { model: 'claude-mini-thing' } } } as any;
    expect(warnIfSmallSummarizer(c, 'claude', '', warn)).toBe(true);
    expect(warn.mock.calls[0][0]).toContain(SMALL_MODEL_WARNING);
    expect(SMALL_MODEL_WARNING).toBe("summarizer model looks small-tier; it writes the companion's own memory and will flatten the voice; see docs/CONFIGURATION.md → summarizer");
    warnIfSmallSummarizer(c, 'claude', 'tenant echo', warn);
    expect(warn.mock.calls[1][0]).toContain('tenant echo');
    expect(warnIfSmallSummarizer({ ...c, agent: { ...c.agent, summarizer: { model: 'big' } } }, 'claude', '', warn)).toBe(false);
  });
  it('warns once per (tenant, model); another tenant or model warns again; minimax is not small-tier', () => {
    const warn = vi.fn();
    const c = { agent: { model: 'claude-sonnet-5-5', model_autonomous: '', rolling: {}, summarizer: { model: 'claude-mini-thing' } } } as any;
    expect(warnIfSmallSummarizer(c, 'claude', 'tenant echo', warn)).toBe(true);
    expect(warnIfSmallSummarizer(c, 'claude', 'tenant echo', warn)).toBe(false);
    expect(warnIfSmallSummarizer(c, 'claude', 'tenant sam', warn)).toBe(true);
    expect(warnIfSmallSummarizer({ ...c, agent: { ...c.agent, summarizer: { model: 'claude-other-mini' } } }, 'claude', 'tenant echo', warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(looksSmallTier('minimax-m1')).toBe(false);
    expect(looksSmallTier('gpt-5-mini')).toBe(true);
  });
  it('also warns when the model is the chat model and that one is small', () => {
    const warn = vi.fn();
    expect(warnIfSmallSummarizer({ agent: { model: 'claude-haiku-5-5', model_autonomous: '', rolling: {} } } as any, 'claude', '', warn)).toBe(true);
  });
});
