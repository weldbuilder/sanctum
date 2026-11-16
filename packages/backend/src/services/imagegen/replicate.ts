import { ImageGenError, classFromStatus, classFromText, referenceDataUri, timedFetch, type ImageGenProvider, type ImageGenRequest, type ImageGenResult } from './types.js';

export const REPLICATE_BASE = 'https://api.replicate.com/v1';
export const REPLICATE_DEFAULT_MODEL = 'black-forest-labs/flux-schnell';
/** The model references use when none is configured: FLUX.1 Kontext [pro], one reference image. */
export const REPLICATE_DEFAULT_REFERENCE_MODEL = 'black-forest-labs/flux-kontext-pro';
const POLL_MS = 1500;

/** Closest Replicate FLUX aspect ratio for a size. */
export function aspectRatioFor(width: number, height: number): string {
  if (width === height) return '1:1';
  return height > width ? '2:3' : '3:2';
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

/** The poll URL is sent with the bearer token, so it must be https on Replicate's own API host. */
function isReplicateApiUrl(u: string): boolean {
  try { const p = new URL(u); return p.protocol === 'https:' && p.hostname === 'api.replicate.com'; } catch { return false; }
}

function outputUrl(output: unknown): string | null {
  const v = Array.isArray(output) ? output[0] : output;
  return typeof v === 'string' && /^https:\/\//.test(v) ? v : null;
}

/** The `input` object. Without references it is exactly the text-only one. With them: flux-2 models take `input_images` (an array),
 *  every other model takes `input_image` (the FIRST reference; the rest are dropped). Kontext and flux-2 have no safety-checker or
 *  num_outputs field, so those two are left out for them. */
function buildInput(req: ImageGenRequest, model: string): Record<string, unknown> {
  const aspect_ratio = aspectRatioFor(req.width, req.height);
  const refs = req.references ?? [];
  if (!refs.length) {
    return { prompt: req.prompt, aspect_ratio, output_format: 'png', num_outputs: 1, disable_safety_checker: !req.safetyChecker };
  }
  const uris = refs.map(referenceDataUri);
  const own = /flux-2|kontext/i.test(model);
  if (/flux-2/i.test(model)) return { prompt: req.prompt, input_images: uris, aspect_ratio, output_format: 'png' };
  if (refs.length > 1) console.debug(`[ImageGen] replicate ${model} takes one reference; dropped: ${refs.slice(1).map((r) => r.name).join(', ')}`);
  return own
    ? { prompt: req.prompt, input_image: uris[0], aspect_ratio, output_format: 'png' }
    : { prompt: req.prompt, input_image: uris[0], aspect_ratio, output_format: 'png', num_outputs: 1, disable_safety_checker: !req.safetyChecker };
}

export function createReplicateProvider(token: string, opts: { pollMs?: number } = {}): ImageGenProvider {
  const pollMs = opts.pollMs ?? POLL_MS;
  return {
    name: 'replicate',
    async generate(req: ImageGenRequest): Promise<ImageGenResult> {
      const startedAt = Date.now();
      const model = req.model || REPLICATE_DEFAULT_MODEL;
      if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(model)) throw new ImageGenError('bad_request', 'replicate');
      const deadline = { timeoutMs: req.timeoutMs, signal: req.signal, startedAt };
      const auth = { Authorization: `Bearer ${token}` };

      const classify = async (res: Response, json: any) => {
        const text = `${json?.title ?? ''} ${json?.detail ?? ''} ${json?.error ?? ''}`;
        return new ImageGenError(classFromText(text, classFromStatus(res.status)), 'replicate');
      };

      const res = await timedFetch('replicate', `${REPLICATE_BASE}/models/${model}/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'wait', ...auth },
        body: JSON.stringify({ input: buildInput(req, model) }),
      }, deadline);
      let pred: any = null;
      try { pred = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok) throw await classify(res, pred);

      // Prefer: wait may return before the prediction finishes; poll urls.get.
      const getUrl: string | undefined = pred?.urls?.get;
      while (pred?.status !== 'succeeded') {
        if (pred?.status === 'failed' || pred?.status === 'canceled') {
          throw new ImageGenError(classFromText(String(pred?.error ?? ''), 'server'), 'replicate');
        }
        // The poll carries the bearer token: only ever follow it to Replicate's own API host.
        if (!getUrl || !isReplicateApiUrl(getUrl)) throw new ImageGenError('server', 'replicate');
        try { await sleep(pollMs, req.signal); } catch { throw new ImageGenError('timeout', 'replicate'); }
        const pr = await timedFetch('replicate', getUrl, { headers: auth }, deadline);
        let next: any = null;
        try { next = await pr.json(); } catch { /* non-JSON */ }
        if (!pr.ok) throw await classify(pr, next);
        pred = next;
      }

      const url = outputUrl(pred.output);
      if (!url) throw new ImageGenError('server', 'replicate');
      const dl = await timedFetch('replicate', url, {}, deadline); // delivery URL: no auth header
      if (!dl.ok) throw new ImageGenError(classFromStatus(dl.status), 'replicate');
      const bytes = Buffer.from(await dl.arrayBuffer());
      const mime = (dl.headers.get('content-type') || 'image/png').split(';')[0].trim();
      return { bytes, mime: mime.startsWith('image/') ? mime : 'image/png', model };
    },
  };
}
