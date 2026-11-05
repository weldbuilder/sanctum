import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletion, ChatCompletionError, classFromStatus, classFromText } from './openai-compat.js';

const base = { baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-test-123', model: 'vendor/model-x', system: 'SYS', user: 'USR', maxTokens: 777 };
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('chatCompletion request', () => {
  it('POSTs {base}/chat/completions with a Bearer key, two messages, max_tokens, temperature 0.3 and no tools', async () => {
    const f = vi.fn(async () => ok({ choices: [{ message: { content: ' the account ' } }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }));
    vi.stubGlobal('fetch', f);
    const out = await chatCompletion({ ...base, headers: { 'HTTP-Referer': 'https://example.test', 'X-Title': 'Sanctum', Authorization: 'evil' } });
    expect(out).toEqual({ text: 'the account', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer sk-test-123');
    expect(h['HTTP-Referer']).toBe('https://example.test');
    expect(h['X-Title']).toBe('Sanctum');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: 'vendor/model-x', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }], max_tokens: 777, temperature: 0.3, stream: false });
    expect(body.tools).toBeUndefined();
  });

  it('sends no optional headers unless the caller passes them', async () => {
    const f = vi.fn(async () => ok({ choices: [{ message: { content: 'x' } }] }));
    vi.stubGlobal('fetch', f);
    await chatCompletion(base);
    const h = (f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(Object.keys(h).sort()).toEqual(['Authorization', 'Content-Type']);
  });

  it('never logs the prompt', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    vi.stubGlobal('fetch', vi.fn(async () => ok({ choices: [{ message: { content: 'reply' } }] })));
    await chatCompletion({ ...base, user: 'SECRET-TRANSCRIPT' });
    for (const s of spies) { expect(JSON.stringify(s.mock.calls)).not.toContain('SECRET-TRANSCRIPT'); s.mockRestore(); }
  });
});

describe('chatCompletion errors', () => {
  const cls = async (res: () => Response | Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(async () => res()));
    try { await chatCompletion(base); } catch (e) { expect(e).toBeInstanceOf(ChatCompletionError); return (e as ChatCompletionError).cls; }
    return 'none';
  };
  it('classifies by status', async () => {
    expect(await cls(() => ok({}, 401))).toBe('auth');
    expect(await cls(() => ok({}, 403))).toBe('auth');
    expect(await cls(() => ok({}, 402))).toBe('billing');
    expect(await cls(() => ok({}, 429))).toBe('rate_limit');
    expect(await cls(() => ok({}, 400))).toBe('bad_request');
    expect(await cls(() => ok({}, 503))).toBe('server');
    expect(await cls(() => ok({}, 504))).toBe('timeout');
  });
  it('refines by the upstream error text and handles a 200 with an error body, without echoing the text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: { code: 200, message: 'Insufficient credits: add more' } })));
    const e = (await chatCompletion(base).catch((x) => x)) as ChatCompletionError;
    expect(e.cls).toBe('billing');
    expect(e.message).not.toMatch(/Insufficient/);
    expect(classFromText('Rate limit exceeded', 'bad_request')).toBe('rate_limit');
    expect(classFromStatus(418)).toBe('bad_request');
  });
  it('a transport failure is network; an unusable body is server', async () => {
    expect(await cls(() => { throw new TypeError('fetch failed'); })).toBe('network');
    expect(await cls(() => new Response('<html>', { status: 200 }))).toBe('server');
  });
  it('the 90 s deadline and the caller\'s signal both read as timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const p = chatCompletion(base).catch((x) => x as ChatCompletionError) as unknown as Promise<ChatCompletionError>;
    await vi.advanceTimersByTimeAsync(89_000);
    let settled = false; p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await p).cls).toBe('timeout');
    vi.useRealTimers();
    const ac = new AbortController();
    const q = chatCompletion({ ...base, signal: ac.signal }).catch((x) => x as ChatCompletionError) as unknown as Promise<ChatCompletionError>;
    ac.abort();
    expect((await q).cls).toBe('timeout');
  });
});
