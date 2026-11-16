// Image-generation provider contract. Adapters never log the prompt above debug.

export type ImageGenProviderName = 'runware' | 'replicate';

// Dependency-free on purpose: routes/workspace-mcp.ts reads IMAGE_SIZES at load, inside an import cycle that runs through imagegen/index.ts.
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export type ImageSize = typeof IMAGE_SIZES[number];
export const MAX_PROMPT_LENGTH = 2000;

export function parseSize(size: string): { width: number; height: number } | null {
  if (!(IMAGE_SIZES as readonly string[]).includes(size)) return null;
  const [w, h] = size.split('x').map(Number);
  return { width: w, height: h };
}

/** Most references one request carries (a picture is rarely helped by more, and each travels as a data URI). */
export const REFERENCE_MAX_PER_REQUEST = 4;

export interface ImageGenReference {
  bytes: Buffer;
  mime: string;
  /** For debug logs only. */
  name: string;
}

/** A reference as a data URI, which both providers accept inline. */
export function referenceDataUri(r: ImageGenReference): string {
  return `data:${r.mime};base64,${r.bytes.toString('base64')}`;
}

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
  /** Pictures the result should be of. Absent or empty: the request is exactly the text-only one. */
  references?: ImageGenReference[];
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
  | 'auth' | 'billing' | 'rate_limit' | 'content_blocked' | 'bad_request' | 'server' | 'network' | 'timeout';

export class ImageGenError extends Error {
  constructor(public readonly cls: ImageGenErrorClass, public readonly provider: ImageGenProviderName) {
    super(`${provider}: ${cls}`); // never carries an upstream body
    this.name = 'ImageGenError';
  }
}

/** Class from an HTTP status alone. */
export function classFromStatus(status: number): ImageGenErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
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
