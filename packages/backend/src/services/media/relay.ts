// How a companion gif or sticker message leaves the web app for another surface. Pure: the senders (Telegram's service, Discord's gated
// send path) take these descriptors, so the mapping is one place. A Discord-native sticker is still refused (discord/send-scan.ts);
// these are pictures.
export interface MediaMessageLike { content_type?: string; contentType?: string; metadata?: Record<string, any> | null }

export type MediaRelay =
  | { kind: 'url'; url: string; name: string }          // a gif: remote, public
  | { kind: 'file'; fileId: string; filename: string; name: string } // a sticker: a stored file, sent as bytes
  | null;

export function mediaRelayOf(m: MediaMessageLike): MediaRelay {
  const type = m.content_type ?? m.contentType;
  const meta = m.metadata ?? {};
  if (type === 'gif') {
    const url = typeof meta.gif_url === 'string' ? meta.gif_url : '';
    return /^https:\/\//i.test(url) ? { kind: 'url', url, name: String(meta.gif_title || meta.query || 'gif') } : null;
  }
  if (type === 'sticker') {
    const a = Array.isArray(meta.attachments) ? meta.attachments[0] : null;
    return a && typeof a.fileId === 'string' ? { kind: 'file', fileId: a.fileId, filename: String(a.filename || 'sticker.png'), name: String(meta.sticker_name || 'sticker') } : null;
  }
  return null;
}

/** Discord: a gif is its URL as the message text (Discord unfurls it); a sticker is a file attachment (its URL is private to the app). */
export function discordPayloadFor(r: NonNullable<MediaRelay>, read: (fileId: string) => Buffer | null): { content?: string; files?: Array<{ attachment: Buffer; name: string }> } | null {
  if (r.kind === 'url') return { content: r.url };
  const bytes = read(r.fileId);
  return bytes ? { files: [{ attachment: bytes, name: r.filename }] } : null;
}

/** Telegram: sendAnimation for a gif, sendPhoto for a sticker. */
export function telegramCallFor(r: NonNullable<MediaRelay>): 'sendAnimation' | 'sendPhoto' {
  return r.kind === 'url' ? 'sendAnimation' : 'sendPhoto';
}
