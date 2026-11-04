// Image generation routes. Public: POST /images/generate, GET /images/status (mounted in api.ts behind session auth).
// Internal: POST /internal/image (loopback token), same body and response; `res image` and the workspace MCP tool call it.
import { Router, type Request, type Response } from 'express';
import { appWriteGate } from '../middleware/app-write.js';
import { getSanctumConfig } from '../config.js';
import { ensureDailyThread, getThread } from '../services/db.js';
import { registry } from '../services/ws.js';
import {
  generateImage, imagegenStatus, isImageGenError, parseSize, ImageGenNotConfigured,
  MAX_PROMPT_LENGTH, type ImageGenProviderName, type ImageSize,
} from '../services/imagegen/index.js';

type ThreadResolution = { ok: true; threadId: string } | { ok: false; status: number; error: string };
export type ThreadResolver = (explicit: unknown) => ThreadResolution;

/** Public default: the named thread, else today's daily thread. */
export const resolveThreadForImage: ThreadResolver = (explicit) => {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    if (typeof explicit !== 'string' || !getThread(explicit)) return { ok: false, status: 404, error: 'thread_not_found' };
    return { ok: true, threadId: explicit };
  }
  const { thread, justCreated } = ensureDailyThread();
  if (justCreated) registry.broadcast({ type: 'thread_created', thread });
  return { ok: true, threadId: thread.id };
};

export function imageGenerateHandler(resolveThread: ThreadResolver = resolveThreadForImage) {
  return async (req: Request, res: Response): Promise<void> => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
    if (!prompt) { res.status(400).json({ ok: false, error: 'prompt_required' }); return; }
    if (prompt.length > MAX_PROMPT_LENGTH) { res.status(400).json({ ok: false, error: 'prompt_too_long' }); return; }
    const size = (b.size ?? getSanctumConfig().imagegen?.size ?? '1024x1024') as string;
    if (typeof size !== 'string' || !parseSize(size)) { res.status(400).json({ ok: false, error: 'bad_size' }); return; }
    const provider = b.provider === 'runware' || b.provider === 'replicate' ? (b.provider as ImageGenProviderName) : undefined;
    const postToChat = b.post_to_chat !== false;

    let threadId: string | undefined;
    if (postToChat) {
      const t = resolveThread(b.thread_id ?? b.threadId);
      if (!t.ok) { res.status(t.status).json({ ok: false, error: t.error }); return; }
      threadId = t.threadId;
    }

    // Abort the upstream call if the caller goes away.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const out = await generateImage({ prompt, size: size as ImageSize, provider, postToChat, threadId, signal: ac.signal });
      res.json({ ok: true, ...out });
    } catch (e) {
      if (e instanceof ImageGenNotConfigured) { res.status(409).json({ ok: false, error: 'imagegen_not_configured', detail: e.detail }); return; }
      if (isImageGenError(e)) {
        if (e.cls === 'timeout') { res.status(504).json({ ok: false, error: 'provider_timeout', provider: e.provider }); return; }
        console.warn(`[ImageGen] ${e.provider} failed: ${e.cls}`);
        res.status(502).json({ ok: false, error: 'provider_error', provider: e.provider, detail: e.cls });
        return;
      }
      // Local failure (file save etc.): never echo the message, it may carry paths.
      console.error('[ImageGen] local failure:', e instanceof Error ? e.name : 'error');
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  };
}

export function imageStatusHandler(_req: Request, res: Response): void {
  res.json({ ok: true, ...imagegenStatus() });
}

/** Public router, mounted at /api/images after session auth. */
export const imagesRouter = Router();
imagesRouter.get('/status', imageStatusHandler);
imagesRouter.post('/generate', appWriteGate, imageGenerateHandler());
