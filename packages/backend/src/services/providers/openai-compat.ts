// A plain OpenAI-compatible chat-completions client: POST {base_url}/chat/completions with a Bearer key, two messages, no
// tools, no streaming. Dependency-free and provider-agnostic on purpose: the summarizer uses it now, and a fallback brain can
// reuse it. Anything provider-specific (OpenRouter's HTTP-Referer and X-Title, say) is passed in as `headers` by the caller.
//
// Errors carry only a coarse class (the classes services/imagegen/types.ts uses): never an upstream body, never the key,
// never the prompt. Nothing here logs the prompt or the reply at all.

export type ChatErrorClass = 'auth' | 'rate_limit' | 'billing' | 'bad_request' | 'server' | 'network' | 'timeout';

export class ChatCompletionError extends Error {
  constructor(public readonly cls: ChatErrorClass, public readonly status?: number) {
    super(`openai-compat: ${cls}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ChatCompletionError';
  }
}

export const CHAT_TIMEOUT_MS = 90_000;
export const CHAT_TEMPERATURE = 0.3;

/** Class from an HTTP status alone. */
export function classFromStatus(status: number): ChatErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Refine a class from an upstream error's code or message. The text is inspected, never returned. */
export function classFromText(text: string, fallback: ChatErrorClass): ChatErrorClass {
  const t = text.toLowerCase();
  if (/insufficient[ _-]?(credit|quota|fund)|billing|payment required|out of credits/.test(t)) return 'billing';
  if (/unauthori[sz]ed|invalid[ _-]?api[ _-]?key|invalid[ _-]?token|authentication|forbidden|missing[ _-]?api[ _-]?key|no auth/.test(t)) return 'auth';
  if (/rate[ _-]?limit|too many requests|throttl/.test(t)) return 'rate_limit';
  if (/timeout|timed out/.test(t)) return 'timeout';
  return fallback;
}

export interface ChatCompletionArgs {
  /** e.g. https://openrouter.ai/api/v1 (no trailing /chat/completions). */
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** The caller's own deadline or cancel. An abort from it reads as 'timeout'. */
  signal?: AbortSignal;
  /** Extra request headers (OpenRouter: HTTP-Referer, X-Title). Never Authorization or Content-Type. */
  headers?: Record<string, string>;
  /** Default 90 s. */
  timeoutMs?: number;
}

export interface ChatCompletionResult {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

export async function chatCompletion(a: ChatCompletionArgs): Promise<ChatCompletionResult> {
  const url = `${a.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (a.system) messages.push({ role: 'system', content: a.system });
  messages.push({ role: 'user', content: a.user });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.headers ?? {})) {
    if (/^(authorization|content-type)$/i.test(k) || typeof v !== 'string') continue;
    headers[k] = v;
  }
  headers['Content-Type'] = 'application/json';
  headers.Authorization = `Bearer ${a.apiKey}`;

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, a.timeoutMs ?? CHAT_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  if (a.signal?.aborted) ac.abort(); else a.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST', headers, signal: ac.signal,
        body: JSON.stringify({ model: a.model, messages, max_tokens: a.maxTokens, temperature: CHAT_TEMPERATURE, stream: false }),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (timedOut || a.signal?.aborted || name === 'AbortError' || name === 'TimeoutError') throw new ChatCompletionError('timeout');
      throw new ChatCompletionError('network');
    }
    let raw = '';
    try { raw = await res.text(); } catch { throw new ChatCompletionError(timedOut || a.signal?.aborted ? 'timeout' : 'network'); }
    let json: any = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
    const errText = json?.error ? `${json.error.code ?? ''} ${json.error.type ?? ''} ${json.error.message ?? ''}` : '';
    if (!res.ok) throw new ChatCompletionError(classFromText(errText, classFromStatus(res.status)), res.status);
    // Some gateways answer 200 with an error body.
    if (json?.error) {
      const status = num(json.error.code);
      throw new ChatCompletionError(classFromText(errText, status ? classFromStatus(status) : 'server'), status);
    }
    if (!json || !Array.isArray(json.choices)) throw new ChatCompletionError('server', res.status);
    const text = textOf(json.choices[0]?.message?.content).trim();
    const u = json.usage;
    const usage = u && typeof u === 'object'
      ? { promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens), totalTokens: num(u.total_tokens) }
      : undefined;
    return usage ? { text, usage } : { text };
  } finally {
    clearTimeout(timer);
    a.signal?.removeEventListener('abort', onAbort);
  }
}
