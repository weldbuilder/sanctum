// Image-generation provider contract. Adapters never log the prompt above debug.

export type ImageGenProviderName = 'runware' | 'replicate';

export interface ImageGenRequest {
  prompt: string;
  width: number;
  height: number;
  /** Provider model id; the caller resolves the provider default when config leaves it empty. */
  model: string;
  /** true = ask the provider to run its own safety filter. */
  safetyChecker: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ImageGenResult {
  bytes: Buffer;
  mime: string;
  model: string;
}

export interface ImageGenProvider {
  name: ImageGenProviderName;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

/** Safe, coarse failure classes. These are the only upstream detail that leaves the adapter. */
export type ImageGenErrorClass =
  | 'auth' | 'rate_limit' | 'content_blocked' | 'bad_request' | 'server' | 'network' | 'timeout';

export class ImageGenError extends Error {
  constructor(public readonly cls: ImageGenErrorClass, public readonly provider: ImageGenProviderName) {
    super(`${provider}: ${cls}`); // never carries an upstream body
    this.name = 'ImageGenError';
  }
}

/** Class from an HTTP status alone. */
export function classFromStatus(status: number): ImageGenErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Refine a class from known error strings (code/message fields of an upstream error). The text is inspected, never returned. */
export function classFromText(text: string, fallback: ImageGenErrorClass): ImageGenErrorClass {
  const t = text.toLowerCase();
  if (/nsfw|safety|content[ _-]?(policy|filter|moderation|blocked)|flagged|prohibited|sensitive/.test(t)) return 'content_blocked';
  if (/unauthori[sz]ed|invalid[ _-]?api[ _-]?key|invalid[ _-]?token|authentication|forbidden|missing[ _-]?api[ _-]?key|invalid[ _-]?auth/.test(t)) return 'auth';
  if (/rate[ _-]?limit|too many requests|throttl/.test(t)) return 'rate_limit';
  if (/timeout|timed out/.test(t)) return 'timeout';
  return fallback;
}

/** Fetch with a deadline that also honours the caller's signal. Aborts map to 'timeout', transport errors to 'network'. */
export async function timedFetch(
  provider: ImageGenProviderName,
  url: string,
  init: RequestInit,
  deadline: { timeoutMs: number; signal?: AbortSignal; startedAt: number },
): Promise<Response> {
  const remaining = deadline.timeoutMs - (Date.now() - deadline.startedAt);
  if (remaining <= 0) throw new ImageGenError('timeout', provider);
  const signals = [AbortSignal.timeout(remaining)];
  if (deadline.signal) signals.push(deadline.signal);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new ImageGenError('timeout', provider);
    throw new ImageGenError('network', provider);
  }
}
