// The reference library: a row per picture (migrations/006_references.sql) and the picture in the file store (sidecar source 'reference').
// A reference makes a generated picture OF someone or something; `self` marks the companion's own look.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getDb } from '../db.js';
import { saveFile, deleteFile, getFile } from '../files.js';
import { sniffImageMime } from './stickers.js';

/** Replicate advises data URIs under 1 MB, and references travel as data URIs. */
export const REFERENCE_MAX_BYTES = 1_000_000;
export const REFERENCE_NAME_MAX = 40;
export const REFERENCE_NOTE_MAX = 200;
export const REFERENCE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
export const REFERENCE_MAX_COUNT = 12;
export const REFERENCE_SELF_MAX = 4;
/** How many names the companion is told about before "and N more". */
export const REFERENCE_LIST_CAP = 20;

export interface Reference { id: string; name: string; file_id: string; self: boolean; note: string; created_at: string }
export type ReferenceErrorCode = 'name_required' | 'name_too_long' | 'name_invalid' | 'name_taken' | 'note_too_long' | 'not_image' | 'too_large' | 'self_limit' | 'library_full' | 'not_found';
export class ReferenceError extends Error { constructor(public readonly code: ReferenceErrorCode, msg: string) { super(msg); this.name = 'ReferenceError'; } }

interface Row { id: string; name: string; file_id: string; self: number; note: string; created_at: string }
const COLS = 'id, name, file_id, self, note, created_at';
const shape = (r: Row): Reference => ({ id: r.id, name: r.name, file_id: r.file_id, self: r.self === 1, note: r.note, created_at: r.created_at });
const shapeOpt = (r: Row | undefined): Reference | null => (r ? shape(r) : null);

export function listReferences(): Reference[] {
  return (getDb().prepare(`SELECT ${COLS} FROM "references" ORDER BY name COLLATE NOCASE`).all() as Row[]).map(shape);
}
export function countReferences(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM "references"').get() as { n: number }).n;
}
export function referenceByName(name: string): Reference | null {
  return shapeOpt(getDb().prepare(`SELECT ${COLS} FROM "references" WHERE name = ? COLLATE NOCASE`).get(name.trim()) as Row | undefined);
}
export function referenceById(id: string): Reference | null {
  return shapeOpt(getDb().prepare(`SELECT ${COLS} FROM "references" WHERE id = ?`).get(id) as Row | undefined);
}
/** The companion's own pictures, in the order they were added. */
export function selfReferences(): Reference[] {
  return (getDb().prepare(`SELECT ${COLS} FROM "references" WHERE self = 1 ORDER BY created_at, rowid`).all() as Row[]).map(shape);
}
function countSelf(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM "references" WHERE self = 1').get() as { n: number }).n;
}

/** Names shown to the companion: at most `cap`, then "and N more"; the companion's own are marked `Echo (you)`. */
export function referenceNameList(cap = REFERENCE_LIST_CAP): string {
  const refs = listReferences();
  const shown = refs.slice(0, cap).map((r) => (r.self ? `${r.name} (you)` : r.name)).join(', ');
  return refs.length > cap ? `${shown}, and ${refs.length - cap} more` : shown;
}

/** The stored picture's bytes and type, or null when the file is gone. */
export function readReferenceBytes(ref: Reference): { bytes: Buffer; mime: string } | null {
  const f = getFile(ref.file_id);
  if (!f) return null;
  try { return { bytes: readFileSync(f.path), mime: f.mimeType }; } catch { return null; }
}

function cleanNote(note: string | undefined): string {
  const n = (note ?? '').replace(/\s+/g, ' ').trim();
  if (n.length > REFERENCE_NOTE_MAX) throw new ReferenceError('note_too_long', `A note is up to ${REFERENCE_NOTE_MAX} characters`);
  return n;
}

export interface AddReferenceInput { name: string; self?: boolean; note?: string; buffer: Buffer; filename: string; mime: string }

export function addReference(i: AddReferenceInput): Reference {
  const clean = i.name.replace(/\s+/g, ' ').trim();
  if (!clean) throw new ReferenceError('name_required', 'A reference needs a name');
  if (i.name !== i.name.trim()) throw new ReferenceError('name_invalid', 'A name does not start or end with a space');
  if (i.name.length > REFERENCE_NAME_MAX) throw new ReferenceError('name_too_long', `A name is up to ${REFERENCE_NAME_MAX} characters`);
  if (/[\][:,|\r\n]/.test(i.name)) throw new ReferenceError('name_invalid', 'A name has no brackets, colons, commas or bars');
  const note = cleanNote(i.note);
  if (i.buffer.length > REFERENCE_MAX_BYTES) throw new ReferenceError('too_large', 'A reference is 1 MB or smaller');
  const real = sniffImageMime(i.buffer);
  if (!real || !REFERENCE_MIMES.includes(real)) throw new ReferenceError('not_image', 'A reference is a png, jpg or webp picture');
  if (countReferences() >= REFERENCE_MAX_COUNT) throw new ReferenceError('library_full', `The library holds up to ${REFERENCE_MAX_COUNT} references`);
  const self = !!i.self;
  if (self && countSelf() >= REFERENCE_SELF_MAX) throw new ReferenceError('self_limit', `Up to ${REFERENCE_SELF_MAX} references can show your companion`);
  if (referenceByName(clean)) throw new ReferenceError('name_taken', 'A reference with that name exists');
  const file = saveFile(i.buffer, i.filename || `${clean}.png`, real, { source: 'reference' });
  const row: Reference = { id: crypto.randomUUID(), name: clean, file_id: file.fileId, self, note, created_at: new Date().toISOString() };
  try {
    getDb().prepare('INSERT INTO "references" (id, name, file_id, self, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.file_id, self ? 1 : 0, row.note, row.created_at);
  } catch (e) { deleteFile(file.fileId); throw e; }
  return row;
}

/** Change the self mark and/or the note. Throws not_found, self_limit or note_too_long. */
export function updateReference(id: string, patch: { self?: boolean; note?: string }): Reference {
  const cur = referenceById(id);
  if (!cur) throw new ReferenceError('not_found', 'No such reference');
  const self = patch.self === undefined ? cur.self : patch.self;
  const note = patch.note === undefined ? cur.note : cleanNote(patch.note);
  if (self && !cur.self && countSelf() >= REFERENCE_SELF_MAX) throw new ReferenceError('self_limit', `Up to ${REFERENCE_SELF_MAX} references can show your companion`);
  getDb().prepare('UPDATE "references" SET self = ?, note = ? WHERE id = ?').run(self ? 1 : 0, note, id);
  return { ...cur, self, note };
}

/** Remove the row and its file. False when there is no such reference. */
export function removeReference(id: string): boolean {
  const r = referenceById(id);
  if (!r) return false;
  getDb().prepare('DELETE FROM "references" WHERE id = ?').run(id);
  try { deleteFile(r.file_id); } catch { /* the row is gone; an orphan file is listed and can be deleted from the Files tab */ }
  return true;
}
