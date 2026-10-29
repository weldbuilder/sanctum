// The Files page's shelf and its views over the companion's folders.
//
// `shared/` in the companion's home (agent.cwd) is the one place both of them write. What the companion writes there is
// posted to the chat (hooks.ts handleSharedFileWrite); what the person uploads, makes, renames or deletes from the Files
// page lands there and nowhere else. Every other folder the page shows (the browse roots) is read-only to it.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { getSanctumConfig } from '../config.js';
import { ownReadDir, ownStat } from '../tenancy/own-files.js';

export const SHARED_DIR_NAME = 'shared';

/** The shelf: shared/ in the companion's home. */
export function sharedRoot(): string {
  return resolve(getSanctumConfig().agent.cwd, SHARED_DIR_NAME);
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** True when `target` is under `root` (or is `root`, when `allowRoot`), judged twice: on the path as written, and on the
 *  real path of its nearest existing ancestor, so a link inside the shelf that points out of it is outside. */
export function realInside(root: string, target: string, allowRoot = true): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (!within(t, r) || (!allowRoot && t === r)) return false;
  let probe = t;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) return false;
    probe = up;
  }
  let realRoot = r;
  try { realRoot = realpathSync(r); } catch { /* the shelf is not made yet: only its own path can be inside */ }
  let real: string;
  try { real = realpathSync(probe); } catch { return false; }
  return within(real, realRoot);
}

const MAX_NAME = 180;

/** A file or folder name the shelf takes: one segment of at most 180 characters, no leading dot, no separators, control
 *  or Windows-reserved characters, no trailing dot or space, and not a name the file browser hides as a secret. */
export function safeName(raw: unknown, isSecret: (name: string) => boolean): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim();
  if (!name || name.length > MAX_NAME || name.startsWith('.')) return null;
  // (an explicit character list: a range written with its control characters would be unreadable here)
  if (/[/\\<>:"|?*]/.test(name) || [...name].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null;
  if (/[. ]$/.test(name)) return null;
  if (isSecret(name)) return null;
  return name;
}

/** True when anything is at `path`: a link counts even when what it points to is gone (existsSync follows it, so a dangling
 *  link would read as free, and a write to it would land wherever it points). */
export function taken(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** True when `a` and `b` name one entry on disk, as a name differing only in case does on a filesystem that ignores case. */
export function sameEntry(a: string, b: string): boolean {
  try {
    const x = lstatSync(a, { bigint: true }), y = lstatSync(b, { bigint: true });
    return x.dev === y.dev && x.ino === y.ino;
  } catch { return false; }
}

/** `name` if `dir` has nothing by it, else "name (2).ext", "name (3).ext"…: an upload never replaces a file. */
export function freeName(dir: string, name: string): string {
  if (!taken(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken(join(dir, candidate))) return candidate;
  }
  throw new Error('No free name left for this file');
}

/** The image types the page shows as pictures (no SVG: it can carry script). */
export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
};

export interface RecentFile { name: string; path: string; size: number; mtime: string }

/** Folders a recent-files walk never enters: tool and build output, not anyone's files. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__']);

/** The newest files under `roots`, at most `depth` folders down, hidden entries and build output skipped and secret names
 *  left out; at most `budget` entries are looked at in all, so a huge folder cannot stall the page. */
export function recentFiles(roots: string[], isSecret: (name: string) => boolean, limit = 12, depth = 2, budget = 4000): RecentFile[] {
  const found = new Map<string, RecentFile>();
  let looked = 0;
  const walk = (dir: string, level: number) => {
    let entries;
    try { entries = ownReadDir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (++looked > budget) return;
      if (d.name.startsWith('.')) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (level < depth && !SKIP_DIRS.has(d.name)) walk(full, level + 1);
        continue;
      }
      if (!d.isFile() || isSecret(d.name) || found.has(full)) continue;
      try {
        const st = ownStat(full);
        found.set(full, { name: d.name, path: full, size: st.size, mtime: st.mtime.toISOString() });
      } catch { /* gone or unreadable: not recent */ }
    }
  };
  for (const root of roots) if (looked <= budget) walk(resolve(root), 0);
  return [...found.values()].sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, limit);
}
