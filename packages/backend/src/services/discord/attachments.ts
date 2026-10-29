// Attachments on Discord messages (hole D4).
//
//   owner lane   handed to the existing attachment path: downloaded, saved by files.ts saveFile, and returned as the
//                `images` the agent already knows (a filepath note + Read). Images (jpeg, png, gif, webp), text (txt, md, csv,
//                json), PDF and Word only, never HTML, under
//                discord.attachments.max_mb; anything else is skipped and logged by NAME (never a URL: they carry
//                signatures). Downloads only come from Discord's own hosts, over https.
//   public lane  never reaches this file's download code. attachmentKind() is all it uses, to say what was there.

import { extname } from 'node:path';
import { INVISIBLE, oneLine } from './speaker.js';

export interface DiscordAttachmentLike {
  name?: string | null;
  url: string;
  size?: number | null;
  contentType?: string | null;
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

/** What the owner lane will take: images, and text or documents. Not HTML: a page forwarded from a stranger would be
 *  served inline on the app's own origin, so it is skipped (and logged by name) whatever it is called. */
const ACCEPTED = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const HOSTS = ['cdn.discordapp.com', 'media.discordapp.net', 'cdn.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net'];
const MAX_PER_BATCH = 5;
const FETCH_TIMEOUT_MS = 20_000;

const baseMime = (t: string | null | undefined) => (t ?? '').split(';')[0].trim().toLowerCase();
const extMime = (name: string | null | undefined): string => {
  const ext = extname(name ?? '').toLowerCase();
  return EXT_MIME[ext] ?? '';
};

/** True when the name ends in .html or .htm, trailing dots and whitespace (which a file system drops) not counted. */
const isHtmlName = (name: string | null | undefined): boolean => extMime(String(name ?? '').replace(/[\s.]+$/, '')) === 'text/html';

/** Image, video, audio or file: from the content type Discord gave, else the extension. */
export function attachmentKind(a: Pick<DiscordAttachmentLike, 'name' | 'contentType'>): AttachmentKind {
  const mime = baseMime(a.contentType);
  for (const m of [mime, extMime(a.name)]) {
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
  }
  return 'file';
}

export interface SavedAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentType: 'image' | 'audio' | 'file';
  url: string;
}

export interface FetchedResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  /** When there is a body stream it is read with a counting reader and abandoned past the cap; else arrayBuffer() is all there is. */
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> }; cancel?(): Promise<void> } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AttachmentDeps {
  maxBytes: number;
  /** Defaults to the global fetch with a timeout. */
  fetch?: (url: string) => Promise<FetchedResponse>;
  /** files.ts saveFile. */
  save: (buffer: Buffer, filename: string, mimeType: string) => SavedAttachment;
  log: (line: string) => void;
}

export type SkipReason = 'type' | 'too_large' | 'too_many' | 'untrusted_host' | 'fetch_failed';

const trustedUrl = (u: string): boolean => {
  try {
    const url = new URL(u);
    // https on the default port only (an explicit :443 parses to none), and no credentials in front of the host.
    return url.protocol === 'https:' && url.port === '' && !url.username && !url.password && HOSTS.includes(url.hostname.toLowerCase());
  } catch { return false; }
};

const MAX_NAME = 120;
/** The name handed to save(): one line, no control, bidi or zero-width characters, no path, at most 120 characters with its extension kept. */
export function safeFileName(raw: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  const flat = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').replace(INVISIBLE, '');
  const base = (flat.split(/[\\/]/).pop() ?? '').trim();
  if (!base || /^\.+$/.test(base)) return 'attachment';
  let ext = extname(base);
  if (ext.length > 16) ext = '';
  const stem = base.slice(0, base.length - ext.length);
  return stem.length + ext.length > MAX_NAME ? `${stem.slice(0, MAX_NAME - ext.length)}${ext}` : base;
}

/** The body, or null when it is over `max` bytes. A stream is counted as it is read and abandoned the moment it passes the
 *  cap, so a body that lies about its size never lands in memory; a Content-Length over the cap is refused unread. */
async function readCapped(res: FetchedResponse, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel?.().catch(() => {}); return null; }
  const stream = res.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = stream.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

const defaultFetch = (url: string): Promise<FetchedResponse> => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });

/** Download and save what the owner lane accepts. Never throws: a file that cannot be had is skipped and named. */
export async function ingestOwnerAttachments(list: DiscordAttachmentLike[], deps: AttachmentDeps): Promise<{ saved: SavedAttachment[]; skipped: Array<{ name: string; reason: SkipReason }> }> {
  const saved: SavedAttachment[] = [];
  const skipped: Array<{ name: string; reason: SkipReason }> = [];
  const doFetch = deps.fetch ?? defaultFetch;
  const skip = (name: string, reason: SkipReason) => {
    skipped.push({ name, reason });
    deps.log(`[Discord] attachment not opened: ${name} (${reason})`);
  };

  for (const a of list) {
    const name = oneLine(a.name ?? '', 100) || 'attachment';
    if (saved.length >= MAX_PER_BATCH) { skip(name, 'too_many'); continue; }
    const declared = baseMime(a.contentType);
    const mime = ACCEPTED.has(declared) ? declared : extMime(a.name);
    // HTML is refused however it is labelled: by its content type or by its extension, read on the name as sent AND on the
    // name that would be saved (a zero-width character or a trailing space can hide `.html` from the first and not the second).
    if (declared === 'text/html' || declared === 'application/xhtml+xml' || isHtmlName(a.name) || isHtmlName(safeFileName(a.name)) || !ACCEPTED.has(mime)) { skip(name, 'type'); continue; }
    if (typeof a.size === 'number' && a.size > deps.maxBytes) { skip(name, 'too_large'); continue; }
    if (!trustedUrl(a.url)) { skip(name, 'untrusted_host'); continue; }
    let buffer: Buffer | null;
    try {
      const res = await doFetch(a.url);
      if (!res.ok) throw new Error(`status ${res.status}`);
      buffer = await readCapped(res, deps.maxBytes);
    } catch { skip(name, 'fetch_failed'); continue; }
    if (!buffer) { skip(name, 'too_large'); continue; }
    try { saved.push(deps.save(buffer, safeFileName(a.name), mime)); }
    catch { skip(name, 'fetch_failed'); }
  }
  return { saved, skipped };
}
