// Native image generation (Runware / Replicate, both FLUX). One entry point for the public route,
// the internal route (`res image`) and the workspace MCP tool. The prompt is personal content: it is
// never logged above debug, and an upstream body never leaves the adapters (only a coarse class does).
import { getSanctumConfig } from '../../config.js';
import { envFor } from '../../tenancy/context.js';
import { appWriteEnabled } from '../../middleware/app-write.js';
import { saveFile } from '../files.js';
import { createMessage, updateThreadActivity } from '../db.js';
import { registry } from '../ws.js';
import { createRunwareProvider, RUNWARE_DEFAULT_MODEL, RUNWARE_DEFAULT_REFERENCE_MODEL } from './runware.js';
import { createReplicateProvider, REPLICATE_DEFAULT_MODEL, REPLICATE_DEFAULT_REFERENCE_MODEL } from './replicate.js';
import { countReferences, selfReferences, referenceByName, readReferenceBytes, REFERENCE_SELF_MAX, type Reference } from '../media/references.js';
import { ImageGenError, parseSize, REFERENCE_MAX_PER_REQUEST, type ImageGenReference, type ImageGenProvider, type ImageGenProviderName, type ImageSize } from './types.js';

export { ImageGenError } from './types.js';
export type { ImageGenProviderName } from './types.js';

export { IMAGE_SIZES, MAX_PROMPT_LENGTH, parseSize } from './types.js';
export type { ImageSize } from './types.js';

const KEY_ENV: Record<ImageGenProviderName, string> = { runware: 'RUNWARE_API_KEY', replicate: 'REPLICATE_API_TOKEN' };
const DEFAULT_MODEL: Record<ImageGenProviderName, string> = { runware: RUNWARE_DEFAULT_MODEL, replicate: REPLICATE_DEFAULT_MODEL };
/** The model a picture with references uses when imagegen.reference_model is empty. Text-only models ignore reference images. */
export const DEFAULT_REFERENCE_MODEL: Record<ImageGenProviderName, string> = { runware: RUNWARE_DEFAULT_REFERENCE_MODEL, replicate: REPLICATE_DEFAULT_REFERENCE_MODEL };
const PROVIDERS: ImageGenProviderName[] = ['runware', 'replicate'];

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
  /** Pictures in the reference library, and how many of them show the companion. */
  references: number;
  self_references: number;
  /** The model a picture with references uses (null while not configured). */
  reference_model: string | null;
}

function referenceCounts(): { references: number; self_references: number } {
  try { return { references: countReferences(), self_references: selfReferences().length }; } catch { return { references: 0, self_references: 0 }; }
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
    ...referenceCounts(),
    reference_model: configured ? (cfg.reference_model || DEFAULT_REFERENCE_MODEL[provider!]) : null,
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

/** Why pictures are or are not offered: `offered`; `not_configured` (no provider, or its key is missing); `app_write_off` (configured, but agent.app_write is off). */
export type ImagegenReason = 'offered' | 'not_configured' | 'app_write_off';
export function imagegenStatusReason(): ImagegenReason {
  if (!imagegenConfigured()) return 'not_configured';
  return appWriteEnabled() ? 'offered' : 'app_write_off';
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
  /** Names from the reference library (any case). Unknown names are skipped and reported back in `unknown_references`. */
  references?: string[];
  /** Draw the companion: its own references come first, whatever else is named. */
  asSelf?: boolean;
  /** Recorded on the posted message (`metadata.triggered_by`): 'tag' for an inline [image:] in a reply. */
  triggeredBy?: 'tag';
  signal?: AbortSignal;
}

export interface GenerateImageResult {
  file_id: string;
  url: string;
  provider: ImageGenProviderName;
  model: string;
  ms: number;
  message_id?: string;
  /** Names of the references actually used, and those asked for that the library does not hold. */
  references: string[];
  unknown_references: string[];
  as_self: boolean;
}

/** Self references first (when asked, up to REFERENCE_SELF_MAX), then the named ones; de-duplicated, capped at REFERENCE_MAX_PER_REQUEST. */
export function resolveReferences(names: string[] | undefined, asSelf: boolean): { used: Array<{ ref: Reference; bytes: Buffer; mime: string }>; unknown: string[]; asSelf: boolean } {
  const used: Array<{ ref: Reference; bytes: Buffer; mime: string }> = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  let selfUsed = false;
  const take = (ref: Reference): boolean => {
    if (seen.has(ref.id)) return true;
    if (used.length >= REFERENCE_MAX_PER_REQUEST) return false;
    const file = readReferenceBytes(ref);
    if (!file) { console.debug(`[ImageGen] reference "${ref.name}" has no file; skipped`); return false; }
    seen.add(ref.id);
    used.push({ ref, ...file });
    return true;
  };
  if (asSelf) for (const r of selfReferences().slice(0, REFERENCE_SELF_MAX)) if (take(r)) selfUsed = true;
  for (const raw of names ?? []) {
    const ref = referenceByName(raw);
    if (!ref) { console.debug(`[ImageGen] unknown reference "${String(raw).slice(0, 40)}"; skipped`); unknown.push(raw); continue; }
    take(ref);
  }
  return { used, unknown, asSelf: selfUsed };
}

export async function generateImage(o: GenerateImageOptions): Promise<GenerateImageResult> {
  const cfg = getSanctumConfig().imagegen;
  const providerName = o.provider ?? (isProviderName(cfg?.provider) ? cfg.provider : null);
  if (!providerName) throw new ImageGenNotConfigured('No image provider is set. Set imagegen.provider to "runware" or "replicate" in sanctum.yaml.');
  if (!keyFor(providerName)) throw new ImageGenNotConfigured(`${KEY_ENV[providerName]} is not set in .env.`);
  const dims = parseSize(o.size ?? cfg.size ?? '1024x1024') ?? { width: 1024, height: 1024 };
  const { used, unknown, asSelf } = resolveReferences(o.references, !!o.asSelf);
  // A model configured for one provider is not another provider's model id. Pictures with references use the reference model (cfg.model is the text-only one).
  const ours = providerName === cfg.provider;
  const model = used.length
    ? (ours && cfg.reference_model ? cfg.reference_model : DEFAULT_REFERENCE_MODEL[providerName])
    : (ours && cfg.model ? cfg.model : DEFAULT_MODEL[providerName]);
  const refNames = used.map((u) => u.ref.name);

  const started = Date.now();
  console.debug(`[ImageGen] ${providerName} ${model} ${dims.width}x${dims.height} promptChars=${o.prompt.length}${used.length ? ` references=${refNames.join('|')}${asSelf ? ' self' : ''}` : ''}`);
  const out = await makeProvider(providerName).generate({
    prompt: o.prompt,
    ...dims,
    model,
    safetyChecker: !!cfg.safety_checker,
    timeoutMs: cfg.timeout_ms || 90000,
    signal: o.signal,
    ...(used.length ? { references: used.map((u): ImageGenReference => ({ bytes: u.bytes, mime: u.mime, name: u.ref.name })) } : {}),
  });
  const ms = Date.now() - started;

  const ext = out.mime === 'image/jpeg' ? 'jpg' : out.mime === 'image/webp' ? 'webp' : 'png';
  const fileMeta = saveFile(out.bytes, `generated-image.${ext}`, out.mime, { source: 'image-gen', prompt: o.prompt, provider: providerName, model: out.model });

  let messageId: string | undefined;
  if (o.postToChat && o.threadId) {
    const now = new Date().toISOString();
    // hooks.ts handleImageToolResult's shape (contentType 'image', fileId/filename/size/source) plus metadata.attachments, which is what the chat bubble reads, and provider/model/prompt.
    const message = createMessage({
      id: crypto.randomUUID(),
      threadId: o.threadId,
      role: 'companion',
      // Empty on purpose: the bubble renders any non-empty content as text under the image (api.ts /internal/share warns the same).
      content: '',
      contentType: 'image',
      metadata: {
        fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'image-gen',
        // What MessageBubble renders (getAttachments -> AttachmentBlock): contentType 'image' + fileId.
        attachments: [{ fileId: fileMeta.fileId, filename: fileMeta.filename, contentType: 'image', url: fileMeta.url, mimeType: fileMeta.mimeType, size: fileMeta.size }],
        provider: providerName, model: out.model, prompt: o.prompt, ...(used.length ? { references: refNames, as_self: asSelf } : {}), ...(o.triggeredBy ? { triggered_by: o.triggeredBy } : {}) },
      createdAt: now,
    });
    updateThreadActivity(o.threadId, now, true);
    registry.broadcast({ type: 'message', message });
    messageId = message.id;
  }
  console.log(`[ImageGen] ${providerName} ok in ${ms}ms file=${fileMeta.fileId}${messageId ? ' posted' : ''}`);
  return { file_id: fileMeta.fileId, url: fileMeta.url, provider: providerName, model: out.model, ms, ...(messageId ? { message_id: messageId } : {}), references: refNames, unknown_references: unknown, as_self: asSelf };
}

/** The text an agent sees after a successful generation (MCP tool and `res image`). */
export function oneLineResult(r: GenerateImageResult): string {
  const skipped = r.unknown_references?.length ? ` Not in your references, skipped: ${r.unknown_references.join(', ')}.` : '';
  return `Image generated and posted (${r.provider}, ${r.model})${skipped}`;
}

export function isImageGenError(e: unknown): e is ImageGenError { return e instanceof ImageGenError; }
