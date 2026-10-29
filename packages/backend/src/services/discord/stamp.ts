// What tells a list file has changed: a hash of its bytes. A stat stamp (mtime, size, inode, ctime) misses a same-size
// write that keeps the mtime on Windows, where a stale list would then be served. The lists are a few kilobytes and are
// read once per message at most, so hashing them every time costs nothing worth saving.

import { createHash } from 'node:crypto';
import { readOwnOrApp } from '../../tenancy/own-files.js';

export function contentStamp(path: string): string {
  return createHash('sha256').update(readOwnOrApp(path, null)).digest('hex');
}
