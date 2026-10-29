import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import crypto from 'crypto';
import { PROJECT_ROOT } from '../config.js';
import { tenantOrNull } from '../tenancy/context.js';
import { companionPath } from '../tenancy/house.js';
import { ownAssertReadable, ownMkdir, ownReadable, ownUnlink, ownWriteFile } from '../tenancy/own-files.js';

/** Where uploads live: <project>/data/files, or <tenant>/data/files in tenant mode. A function, not a constant, so each request reads its own. */
function filesDir(): string {
  const tenant = tenantOrNull('files');
  return tenant ? join(tenant.dataDir, 'files') : join(PROJECT_ROOT, 'data', 'files');
}
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md',
  'text/csv': '.csv', 'application/json': '.json', 'text/html': '.html',
  'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc', 'application/vnd.ms-excel': '.xls',
};

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.webm': 'audio/webm',
  '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.htm': 'text/html',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
};

export interface FileMetadata {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentType: 'image' | 'audio' | 'file';
  url: string;
}

export function getContentTypeFromMime(mimeType: string): 'image' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

export function ensureFilesDir(): void {
  if (!existsSync(filesDir())) ownMkdir(filesDir(), { recursive: true });
}

export function resolveMimeType(originalFilename: string, browserMime: string): string {
  if (browserMime && browserMime !== 'application/octet-stream' && ALLOWED_TYPES[browserMime]) return browserMime;
  const ext = extname(originalFilename).toLowerCase();
  return EXT_TO_MIME[ext] || browserMime;
}

export function saveFile(buffer: Buffer, originalFilename: string, mimeType: string): FileMetadata {
  if (buffer.length > MAX_FILE_SIZE) throw new Error(`File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
  mimeType = resolveMimeType(originalFilename, mimeType);
  if (!ALLOWED_TYPES[mimeType]) throw new Error(`File type ${mimeType} not allowed`);
  ensureFilesDir();
  const fileId = crypto.randomUUID();
  const ext = ALLOWED_TYPES[mimeType];
  ownWriteFile(join(filesDir(), `${fileId}${ext}`), buffer);
  return { fileId, filename: originalFilename, mimeType, size: buffer.length, contentType: getContentTypeFromMime(mimeType), url: companionPath(`/api/files/${fileId}`) };
}

export function getFile(fileId: string): { path: string; mimeType: string; filename: string } | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) return null;
  for (const [mime, ext] of Object.entries(ALLOWED_TYPES)) {
    const filePath = join(filesDir(), `${fileId}${ext}`);
    // data/files is not scanned at boot: a link planted there (to another tenant's database, the app's .env) is never served.
    if (existsSync(filePath) && ownReadable(filePath)) return { path: filePath, mimeType: mime, filename: `${fileId}${ext}` };
  }
  return null;
}

export interface FileListEntry {
  fileId: string; filename: string; mimeType: string; size: number;
  contentType: 'image' | 'audio' | 'file'; createdAt: string;
}

export function deleteFile(fileId: string): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) return false;
  for (const ext of Object.values(ALLOWED_TYPES)) {
    const filePath = join(filesDir(), `${fileId}${ext}`);
    if (existsSync(filePath)) { ownUnlink(filePath); return true; }
  }
  return false;
}

export function listFiles(): FileListEntry[] {
  ensureFilesDir();
  const entries: FileListEntry[] = [];
  const extToMime: Record<string, string> = {};
  for (const [mime, ext] of Object.entries(ALLOWED_TYPES)) extToMime[ext] = mime;
  const uuidRegex = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.\w+)$/i;
  ownAssertReadable(filesDir());
  for (const file of readdirSync(filesDir())) {
    const match = file.match(uuidRegex);
    if (!match) continue;
    const mimeType = extToMime[match[2]] || 'application/octet-stream';
    try {
      if (!ownReadable(join(filesDir(), file))) continue;
      const stat = statSync(join(filesDir(), file));
      entries.push({ fileId: match[1], filename: file, mimeType, size: stat.size, contentType: getContentTypeFromMime(mimeType), createdAt: stat.birthtime.toISOString() });
    } catch {}
  }
  entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return entries;
}

export function saveFileInternal(buffer: Buffer, originalFilename: string): FileMetadata {
  if (buffer.length > MAX_FILE_SIZE) throw new Error(`File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
  ensureFilesDir();
  const ext = extname(originalFilename).toLowerCase();
  const mimeType = EXT_TO_MIME[ext] || 'application/octet-stream';
  const fileId = crypto.randomUUID();
  const storedExt = ALLOWED_TYPES[mimeType] || ext || '.bin';
  ownWriteFile(join(filesDir(), `${fileId}${storedExt}`), buffer);
  return { fileId, filename: originalFilename, mimeType, size: buffer.length, contentType: getContentTypeFromMime(mimeType), url: companionPath(`/api/files/${fileId}`) };
}

export function saveFileFromBase64(base64Data: string, mimeType: string, filename: string): FileMetadata {
  return saveFile(Buffer.from(base64Data, 'base64'), filename, mimeType);
}
