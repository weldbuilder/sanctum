// attachmentUtils.ts — pure attachment-resolution logic, extracted from
// Composer.tsx so it can be unit-tested without React/DOM/localStorage.
//
// Why this exists: on mobile the photo-picker can suspend the tab, remounting the
// composer and wiping the React `attachments` state between upload and send — the
// "chip appears then vanishes" bug. The per-thread persisted copy survives that.
// The send path must therefore fall back to the persisted copy when live state is
// empty. resolveEffectiveAttachments encodes exactly that decision, and the
// regression test (Composer.test.ts) locks it so the fallback can never silently
// regress to dropping attachments.

export interface PendingAttachment {
  fileId: string;
  filename: string;
  contentType: 'image' | 'audio' | 'file';
  url: string;
  /** Local preview URL (for images) — revoked on send/remove */
  previewUrl?: string;
}

/** The serializable subset that survives a remount (no blob previewUrl). */
export type PersistedAttachment = Omit<PendingAttachment, 'previewUrl'>;

/**
 * Decide which attachment list to actually send.
 * Live React state wins when present; otherwise fall back to the persisted copy
 * (which survives a mobile photo-picker remount); empty when neither has any.
 */
export function resolveEffectiveAttachments(
  state: PendingAttachment[],
  persisted: PersistedAttachment[],
): PendingAttachment[] {
  if (state.length > 0) return state;
  if (persisted.length > 0) return persisted as PendingAttachment[];
  return [];
}
