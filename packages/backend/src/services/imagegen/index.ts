// Native image generation (Runware / Replicate, both FLUX). One entry point for the public route,
// the internal route (`res image`) and the workspace MCP tool. The prompt is personal content: it is
// never logged above debug, and an upstream body never leaves the adapters (only a coarse class does).
import { getSanctumConfig } from '../../config.js';
import { envFor } from '../../tenancy/context.js';
import { appWriteEnabled } from '../../middleware/app-write.js';
import { saveFile } from '../files.js';
import { createMessage, updateThreadActivity } from '../db.js';
import { registry } from '../ws.js';
import { createRunwareProvider, RUNWARE_DEFAULT_MODEL } from './runware.js';
import { createReplicateProvider, REPLICATE_DEFAULT_MODEL } from './replicate.js';
import { ImageGenError, type ImageGenProvider, type ImageGenProviderName } from './types.js';

export { ImageGenError } from './types.js';
export type { ImageGenProviderName } from './types.js';

export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export type ImageSize = typeof IMAGE_SIZES[number];
export const MAX_PROMPT_LENGTH = 2000;

const KEY_ENV: Record<ImageGenProviderName, string> = { runware: 'RUNWARE_API_KEY', replicate: 'REPLICATE_API_TOKEN' };
const DEFAULT_MODEL: Record<ImageGenProviderName, string> = { runware: RUNWARE_DEFAULT_MODEL, replicate: REPLICATE_DEFAULT_MODEL };
const PROVIDERS: ImageGenProviderName[] = ['runware', 'replicate'];

export function parseSize(size: string): { width: number; height: number } | null {
  if (!(IMAGE_SIZES as readonly string[]).includes(size)) return null;
  const [w, h] = size.split('x').map(Number);
  return { width: w, height: h };
}

function keyFor(p: ImageGenProviderName): string {
  return (envFor('the image keys')[KEY_ENV[p]] || '').trim();
}

function isProviderName(v: unknown): v is ImageGenProviderName {
  return v === 'runware' || v === 'replicate';
}

export interface ImageGenStatus {
  configured: boolean;
  provider: ImageGenProviderName | null;
  model: string | null;
  providers_with_keys: ImageGenProviderName[];
}

/** What the backend can deliver right now: a provider chosen in config AND its key present. */
export function imagegenStatus(): ImageGenStatus {
  const cfg = getSanctumConfig().imagegen;
  const withKeys = PROVIDERS.filter((p) => keyFor(p));
  const provider = isProviderName(cfg?.provider) ? cfg.provider : null;
  const configured = !!provider && withKeys.includes(provider);
  return {
    configured,
    provider: configured ? provider : null,
    model: configured ? (cfg.model || DEFAULT_MODEL[provider!]) : null,
    providers_with_keys: withKeys,
  };
}

/** True only when the companion may be told it can generate images. */
export function imagegenConfigured(): boolean {
  try { return imagegenStatus().configured; } catch { return false; }
}

/** True when the companion may be OFFERED image generation: configured, and its app writes are on (the internal route and the MCP tool post into the chat, so both sit behind app_write). */
export function imagegenOffered(): boolean {
  return imagegenConfigured() && appWriteEnabled();
}

export class ImageGenNotConfigured extends Error {
  constructor(public readonly detail: string) { super(detail); this.name = 'ImageGenNotConfigured'; }
}

function makeProvider(name: ImageGenProviderName): ImageGenProvider {
  return name === 'runware' ? createRunwareProvider(keyFor(name)) : createReplicateProvider(keyFor(name));
}

export interface GenerateImageOptions {
  prompt: string;
  size?: ImageSize;
  provider?: ImageGenProviderName;
  /** Post a companion image message. Requires threadId. */
  postToChat: boolean;
  threadId?: string;
  signal?: AbortSignal;
}

export interface GenerateImageResult {
  file_id: string;
  url: string;
  provider: ImageGenProviderName;
  model: string;
  ms: number;
  message_id?: string;
}

export async function generateImage(o: GenerateImageOptions): Promise<GenerateImageResult> {
  const cfg = getSanctumConfig().imagegen;
  const providerName = o.provider ?? (isProviderName(cfg?.provider) ? cfg.provider : null);
  if (!providerName) throw new ImageGenNotConfigured('No image provider is set. Set imagegen.provider to "runware" or "replicate" in sanctum.yaml.');
  if (!keyFor(providerName)) throw new ImageGenNotConfigured(`${KEY_ENV[providerName]} is not set in .env.`);
  const dims = parseSize(o.size ?? cfg.size ?? '1024x1024') ?? { width: 1024, height: 1024 };
  // A model configured for one provider is not another provider's model id.
  const model = providerName === cfg.provider && cfg.model ? cfg.model : DEFAULT_MODEL[providerName];

  const started = Date.now();
  console.debug(`[ImageGen] ${providerName} ${model} ${dims.width}x${dims.height} promptChars=${o.prompt.length}`);
  const out = await makeProvider(providerName).generate({
    prompt: o.prompt,
    ...dims,
    model,
    safetyChecker: !!cfg.safety_checker,
    timeoutMs: cfg.timeout_ms || 90000,
    signal: o.signal,
  });
  const ms = Date.now() - started;

  const ext = out.mime === 'image/jpeg' ? 'jpg' : out.mime === 'image/webp' ? 'webp' : 'png';
  const fileMeta = saveFile(out.bytes, `generated-image.${ext}`, out.mime);

  let messageId: string | undefined;
  if (o.postToChat && o.threadId) {
    const now = new Date().toISOString();
    // hooks.ts handleImageToolResult's shape (content=url, contentType 'image', fileId/filename/size/source) plus metadata.attachments, which is what the chat bubble reads, and provider/model/prompt.
    const message = createMessage({
      id: crypto.randomUUID(),
      threadId: o.threadId,
      role: 'companion',
      content: fileMeta.url,
      contentType: 'image',
      metadata: {
        fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'image-gen',
        // What MessageBubble renders (getAttachments -> AttachmentBlock): contentType 'image' + fileId.
        attachments: [{ fileId: fileMeta.fileId, filename: fileMeta.filename, contentType: 'image', url: fileMeta.url, mimeType: fileMeta.mimeType, size: fileMeta.size }],
        provider: providerName, model: out.model, prompt: o.prompt },
      createdAt: now,
    });
    updateThreadActivity(o.threadId, now, true);
    registry.broadcast({ type: 'message', message });
    messageId = message.id;
  }
  console.log(`[ImageGen] ${providerName} ok in ${ms}ms file=${fileMeta.fileId}${messageId ? ' posted' : ''}`);
  return { file_id: fileMeta.fileId, url: fileMeta.url, provider: providerName, model: out.model, ms, ...(messageId ? { message_id: messageId } : {}) };
}

/** The text an agent sees after a successful generation (MCP tool and `res image`). */
export function oneLineResult(r: GenerateImageResult): string {
  return `Image generated and posted (${r.provider}, ${r.model})`;
}

export function isImageGenError(e: unknown): e is ImageGenError { return e instanceof ImageGenError; }
