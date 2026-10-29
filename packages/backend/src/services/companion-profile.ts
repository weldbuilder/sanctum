// The companion's profile record: the two identity fields the person can change from the app, `avatar_url` and `skin`.
// Both live in the config KV (per tenant, like cc.sections), under 'identity.avatar_url' and 'identity.skin'.
// Uploaded pictures live in <data>/avatars (<tenant>/data/avatars in tenant mode) and are served by
// GET /api/identity/avatar/:name, which resolves the folder from the request's tenant.
import crypto from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { getConfig, setConfig } from './db.js';
import { PROJECT_ROOT } from '../config.js';
import { tenantOrNull } from '../tenancy/context.js';
import { companionPath, plainPath } from '../tenancy/house.js';
import { ownMkdir, ownReadable, ownWriteFile } from '../tenancy/own-files.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const KEY_AVATAR = 'identity.avatar_url';
const KEY_SKIN = 'identity.skin';

export const AVATAR_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
export const UPLOAD_NAME = /^[0-9a-f]{32}\.(png|jpg|webp|svg)$/;
const UPLOAD_URL = /^\/api\/identity\/avatar\/[0-9a-f]{32}\.(png|jpg|webp|svg)(\?v=\d+)?$/;
const BUNDLED_URL = /^\/avatars\/0[1-6]\.svg$/;
const SKIN_ID = /^[a-z][a-z0-9-]{0,31}$/;

function avatarsDir(): string {
  const t = tenantOrNull('avatars');
  return t ? join(t.dataDir, 'avatars') : join(PROJECT_ROOT, 'data', 'avatars');
}

export function getStoredAvatarUrl(): string | null {
  const v = getConfig(KEY_AVATAR);
  return v && (v === '/logo.png' || BUNDLED_URL.test(v) || UPLOAD_URL.test(v)) ? v : null;
}
export function getSkin(): string | null {
  const v = getConfig(KEY_SKIN);
  return v && SKIN_ID.test(v) ? v : null;
}

/** Apply a PATCH body. Returns an error string for the first bad field, else null (nothing is written on error). */
export function patchProfile(input: Record<string, unknown>): string | null {
  // Household mode: the browser sends back the prefixed URL the server issued; what is checked and stored is the plain form.
  const body = typeof input.avatar_url === 'string' ? { ...input, avatar_url: plainPath(input.avatar_url) } : input;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (has('avatar_url')) {
    const v = body.avatar_url;
    if (v !== null && v !== '' && !(typeof v === 'string' && (v === '/logo.png' || BUNDLED_URL.test(v) || UPLOAD_URL.test(v)))) {
      return 'avatar_url must be null, /logo.png, one of /avatars/01.svg..06.svg, or a URL returned by POST /api/identity/avatar';
    }
    if (typeof v === 'string' && v.startsWith('/api/identity/avatar/') && !ownReadable(join(avatarsDir(), v.slice('/api/identity/avatar/'.length).split('?')[0]))) {
      return 'that uploaded avatar does not exist';
    }
  }
  if (has('skin') && body.skin !== null && !(typeof body.skin === 'string' && SKIN_ID.test(body.skin))) return 'skin must be null or a skin id such as "ember"';
  if (has('avatar_url')) setConfig(KEY_AVATAR, typeof body.avatar_url === 'string' ? body.avatar_url : '');
  if (has('skin')) setConfig(KEY_SKIN, typeof body.skin === 'string' ? body.skin : '');
  return null;
}

/** Check the bytes really are the claimed type. Returns the extension or an error. */
export function sniffAvatar(buf: Buffer): { ext: string } | { error: string } {
  if (buf.length === 0) return { error: 'empty file' };
  if (buf.length > AVATAR_MAX_BYTES) return { error: 'avatar must be 2 MB or smaller' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp' };
  const head = buf.subarray(0, 2048).toString('utf8');
  if (/<svg[\s>]/i.test(head)) {
    const text = buf.toString('utf8');
    // Tag names may carry a namespace prefix (<svg:script>). href/src/xlink:href may only point inside the document (#id) or at a data: image.
    if (/<[\w-]*:?(script|foreignObject|iframe|embed|object)[\s>\/]|\son\w+\s*=|javascript:|<!ENTITY|<\?xml-stylesheet/i.test(text)) return { error: 'svg may not contain scripts or embedded content' };
    if (/\b(?:xlink:)?(?:href|src)\s*=\s*(?:["'](?!#|data:image\/)|(?!["']|#|data:image\/))/i.test(text)) return { error: 'svg may not reference external resources' };
    return { ext: 'svg' };
  }
  return { error: 'avatar must be a png, jpg, webp or svg image' };
}

export function saveAvatar(buf: Buffer, ext: string): string {
  const dir = avatarsDir();
  if (!existsSync(dir)) ownMkdir(dir, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  ownWriteFile(join(dir, name), buf);
  return companionPath(`/api/identity/avatar/${name}?v=${Date.now()}`);
}

export function avatarFile(name: string): { path: string; mime: string } | null {
  if (!UPLOAD_NAME.test(name)) return null;
  const path = join(avatarsDir(), name);
  if (!existsSync(path) || !ownReadable(path)) return null;
  return { path, mime: EXT_MIME[name.split('.')[1]] };
}

