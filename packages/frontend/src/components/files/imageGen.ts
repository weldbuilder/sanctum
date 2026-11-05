/**
 * Pure helpers for image generation inside the Files page: the one-line reasons and errors,
 * and the reading of GET /api/files?source=image-gen. No React, no fetch; ImageGenPanel and FilesView call these.
 */

export const PROMPT_MAX = 2000;

export interface ImageStatus {
  ok?: boolean;
  configured: boolean;
  offered: boolean;
  reason?: 'not_configured' | 'app_write_off';
  provider?: string;
  model?: string;
  providers_with_keys?: string[];
}

/** Why generation is not on offer, as one plain line; null when it is on offer. */
export function statusReason(s: ImageStatus | null): string | null {
  if (!s || s.offered) return null;
  if (s.reason === 'app_write_off') return 'Companion app writes are off in Settings → permissions';
  return "Image generation isn't set up yet. Ask your companion or see docs/CONFIGURATION.md → imagegen.";
}

export type ProviderDetail = 'auth' | 'rate_limit' | 'content_blocked' | 'billing' | 'bad_request' | 'server' | 'network' | 'timeout';

/** One line for a failed generation. `status` is the HTTP status, `body` the parsed JSON (or null). */
export function generateError(status: number, body: { error?: string; provider?: string; detail?: string } | null): string {
  const provider = body?.provider || 'provider';
  if (status === 504) return 'The provider took too long';
  if (status === 403) return statusReason({ configured: true, offered: false, reason: 'app_write_off' }) as string;
  if (status === 409) return statusReason({ configured: false, offered: false, reason: 'not_configured' }) as string;
  if (status === 400) {
    if (body?.error === 'prompt_required') return 'Write a prompt first';
    if (body?.error === 'prompt_too_long') return `Keep the prompt under ${PROMPT_MAX} characters`;
    if (body?.error === 'bad_size') return 'That size is not available';
  }
  if (status === 429) return 'Rate limited, try again in a minute';
  switch (body?.detail) {
    case 'content_blocked': return 'The provider refused this prompt';
    case 'auth': return 'Provider key was rejected';
    case 'billing': return 'Provider account is out of credit';
    case 'rate_limit': return 'Rate limited, try again in a minute';
    case 'timeout': return 'The provider took too long';
    default: return 'Generation failed';
  }
}

/** Share-to-chat outcome as one line. */
export function shareError(status: number, body?: { error?: string } | null): string {
  if (status === 404) return body?.error === 'file_not_found' ? 'That file is gone' : 'No open chat to share into';
  if (status === 429) return 'Too many at once, try again in a minute';
  return `Could not share to chat (${status})`;
}

export const NO_CHAT_TITLE = 'No open chat to share into';

/** A generated picture as the Files list shows it. */
export interface GeneratedItem {
  id: string;
  name: string;
  url: string;
  size: number;
  createdAt: string;
  prompt: string;
  provider: string;
}

/** Reads the file-store list ({ files: [...] }, or a bare array) keeping the pictures that carry generation meta. */
export function readGenerated(body: unknown, urlOf: (id: string) => string): GeneratedItem[] {
  const raw = Array.isArray(body) ? body : (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(raw)) return [];
  const out: GeneratedItem[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const id = String(r.fileId ?? r.id ?? '');
    if (!id) continue;
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    out.push({
      id,
      name: String(r.filename ?? r.name ?? id),
      url: urlOf(id),
      size: Number(r.size) || 0,
      createdAt: String(meta.createdAt ?? r.createdAt ?? ''),
      prompt: String(meta.prompt ?? ''),
      provider: String(meta.provider ?? ''),
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The prompt cut to one line of at most `max` characters (the full text stays in the title). */
export function clipPrompt(prompt: string, max = 80): string {
  const one = prompt.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
