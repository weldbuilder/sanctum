/** Pure helpers for the Stickers chip in Files: reading GET /api/stickers and the one-line errors. No React, no fetch. */

export const STICKER_MAX_BYTES = 2 * 1024 * 1024;
export const STICKER_NAME_MAX = 40;

export interface StickerItem { id: string; name: string; fileId: string; url: string; createdAt: string }

export function readStickers(body: unknown): StickerItem[] {
  const raw = (body as { stickers?: unknown } | null)?.stickers;
  if (!Array.isArray(raw)) return [];
  const out: StickerItem[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (typeof r?.id !== 'string' || typeof r?.fileId !== 'string') continue;
    out.push({ id: r.id, name: String(r.name ?? ''), fileId: r.fileId, url: String(r.url ?? ''), createdAt: String(r.createdAt ?? '') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Checked before the upload leaves the browser; null when the pair is fine. */
export function stickerDraftProblem(name: string, file: { size: number; type: string } | null): string | null {
  if (!name.trim()) return 'Give the sticker a name';
  if (!file) return 'Choose a picture';
  if (!file.type.startsWith('image/')) return 'A sticker is a picture';
  if (file.size > STICKER_MAX_BYTES) return 'A sticker is 2 MB or smaller';
  return null;
}

/** One line for a failed upload or delete. */
export function stickerError(status: number, body?: { error?: string; message?: string } | null): string {
  if (status === 409) return 'A sticker with that name exists';
  if (status === 413) return 'A sticker is 2 MB or smaller';
  if (status === 403) return 'Companion app writes are off in Settings → permissions';
  if (status === 400 && body?.message) return body.message;
  return `Could not save the sticker (${status})`;
}
