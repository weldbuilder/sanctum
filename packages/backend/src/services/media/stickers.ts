// The sticker library: a row per sticker (migrations/005_stickers.sql) and the picture in the file store (sidecar source 'sticker').
import crypto from 'node:crypto';
import { getDb } from '../db.js';
import { saveFile, deleteFile } from '../files.js';

export const STICKER_MAX_BYTES = 2 * 1024 * 1024;
export const STICKER_NAME_MAX = 40;
export const STICKER_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** How many names the companion is told about before "and N more". */
export const STICKER_LIST_CAP = 20;

export interface Sticker { id: string; name: string; file_id: string; created_at: string }
export class StickerError extends Error { constructor(public readonly code: 'name_required' | 'name_too_long' | 'name_taken' | 'not_image' | 'too_large', msg: string) { super(msg); this.name = 'StickerError'; } }

export function listStickers(): Sticker[] {
  return getDb().prepare('SELECT id, name, file_id, created_at FROM stickers ORDER BY name COLLATE NOCASE').all() as Sticker[];
}
export function countStickers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM stickers').get() as { n: number }).n;
}
export function stickerByName(name: string): Sticker | null {
  return (getDb().prepare('SELECT id, name, file_id, created_at FROM stickers WHERE name = ? COLLATE NOCASE').get(name.trim()) as Sticker | undefined) ?? null;
}
export function stickerById(id: string): Sticker | null {
  return (getDb().prepare('SELECT id, name, file_id, created_at FROM stickers WHERE id = ?').get(id) as Sticker | undefined) ?? null;
}

/** Names shown to the companion: at most `cap`, then "and N more". */
export function stickerNameList(cap = STICKER_LIST_CAP): string {
  const names = listStickers().map((s) => s.name);
  const shown = names.slice(0, cap).join(', ');
  return names.length > cap ? `${shown}, and ${names.length - cap} more` : shown;
}

/** The picture's real type from its first bytes (the browser's claim is not trusted); null when it is not a png, jpg, webp or gif. */
export function sniffImageMime(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function addSticker(name: string, buffer: Buffer, filename: string, mimeType: string): Sticker {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) throw new StickerError('name_required', 'A sticker needs a name');
  if (clean.length > STICKER_NAME_MAX || /[\][:\n]/.test(clean)) throw new StickerError('name_too_long', `A name is up to ${STICKER_NAME_MAX} characters, without brackets or colons`);
  if (buffer.length > STICKER_MAX_BYTES) throw new StickerError('too_large', 'A sticker is 2 MB or smaller');
  const real = sniffImageMime(buffer);
  if (!real || !STICKER_MIMES.includes(real)) throw new StickerError('not_image', 'A sticker is a png, jpg, webp or gif picture');
  mimeType = real;
  if (stickerByName(clean)) throw new StickerError('name_taken', 'A sticker with that name exists');
  const file = saveFile(buffer, filename || `${clean}.png`, mimeType, { source: 'sticker' });
  const row: Sticker = { id: crypto.randomUUID(), name: clean, file_id: file.fileId, created_at: new Date().toISOString() };
  try {
    getDb().prepare('INSERT INTO stickers (id, name, file_id, created_at) VALUES (?, ?, ?, ?)').run(row.id, row.name, row.file_id, row.created_at);
  } catch (e) { deleteFile(file.fileId); throw e; }
  return row;
}

/** Remove the row and its file. False when there is no such sticker. */
export function removeSticker(id: string): boolean {
  const s = stickerById(id);
  if (!s) return false;
  getDb().prepare('DELETE FROM stickers WHERE id = ?').run(id);
  try { deleteFile(s.file_id); } catch { /* the row is gone; an orphan file is listed and can be deleted from the Files tab */ }
  return true;
}
