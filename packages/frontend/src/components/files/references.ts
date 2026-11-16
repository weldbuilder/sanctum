/** Pure helpers for the References chip in Files and the chips in the Generate panel. No React, no fetch. */

/** A reference travels to the provider inline, so the backend holds each to 1 MB (REFERENCE_MAX_BYTES in services/media/references.ts). */
export const REFERENCE_MAX_BYTES = 1_000_000;
export const REFERENCE_NAME_MAX = 40;
export const REFERENCE_NOTE_MAX = 200;
/** Most references one picture carries (REFERENCE_MAX_PER_REQUEST in services/imagegen/types.ts). */
export const REFERENCE_PICK_MAX = 4;

export const REFERENCE_HINT = 'PNG, JPEG or WebP up to 1 MB. Mark the ones that show your companion; those are used for selfies.';

export interface ReferenceItem { id: string; name: string; self: boolean; note: string; fileId: string; url: string; createdAt: string }

export function readReferences(body: unknown): ReferenceItem[] {
  const raw = (body as { references?: unknown } | null)?.references;
  if (!Array.isArray(raw)) return [];
  const out: ReferenceItem[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (typeof r?.id !== 'string' || typeof r?.fileId !== 'string') continue;
    out.push({ id: r.id, name: String(r.name ?? ''), self: r.self === true, note: String(r.note ?? ''), fileId: r.fileId, url: String(r.url ?? ''), createdAt: String(r.createdAt ?? '') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Checked before the upload leaves the browser; null when the draft is fine. */
export function referenceDraftProblem(name: string, file: { size: number; type: string } | null): string | null {
  if (!name.trim()) return 'Give the reference a name';
  if (/[[\]:,|]/.test(name)) return 'A name has no brackets, colons, commas or bars';
  if (!file) return 'Choose a picture';
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return 'A reference is a PNG, JPEG or WebP picture';
  if (file.size > REFERENCE_MAX_BYTES) return 'A reference is 1 MB or smaller';
  return null;
}

/** One line for a failed add, edit or delete. */
export function referenceError(status: number, body?: { error?: string; message?: string } | null): string {
  if (status === 403) return 'Companion app writes are off in Settings → permissions';
  if (status === 413) return 'A reference is 1 MB or smaller';
  if (status === 409) {
    if (body?.error === 'self_limit') return 'Up to four references can show your companion';
    if (body?.error === 'library_full') return 'The library holds up to twelve references';
    return 'A reference with that name exists';
  }
  if (status === 400 && body?.message) return body.message;
  return `Could not save the reference (${status})`;
}

/** The chip's words: your own pictures are marked. */
export function referenceChipLabel(r: Pick<ReferenceItem, 'name' | 'self'>): string {
  return r.self ? `${r.name} (you)` : r.name;
}

/** The names a request would carry: your own first when "As you" is on, then the ones picked, once each, at most four. */
export function chosenReferences(refs: ReferenceItem[], picked: string[], asSelf: boolean): string[] {
  const names: string[] = [];
  const add = (n: string) => { if (!names.includes(n) && names.length < REFERENCE_PICK_MAX) names.push(n); };
  if (asSelf) for (const r of refs) if (r.self) add(r.name);
  for (const n of picked) add(n);
  return names;
}

/** The body of POST /api/images/generate from the Generate panel: the picked names that still exist (the library may have changed), and "As you" only when one is marked. */
export function generateBody(prompt: string, refs: ReferenceItem[], picked: string[], asSelf: boolean): { prompt: string; post_to_chat: false; references: string[]; as_self: boolean } {
  const known = new Set(refs.map(r => r.name));
  return {
    prompt: prompt.trim(),
    post_to_chat: false,
    references: picked.filter(n => known.has(n)).slice(0, REFERENCE_PICK_MAX),
    as_self: asSelf && refs.some(r => r.self),
  };
}
