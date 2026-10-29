import { describe, it, expect } from 'vitest';
import { posix, win32 } from 'node:path';
import { pathInside, samePath, containedRel, expandTildeWith, realOrResolvedWith } from './plugin-paths.js';

// The containment helpers take the path module as an argument, so the Windows rules run on every
// platform here: CI on Linux covers `path.win32` behaviour, not just the Windows runner.
describe('pathInside with path.win32', () => {
  const inside = (child: string, parent: string) => pathInside(win32, child, parent, true);

  it('is true for the parent itself and for anything below it', () => {
    expect(inside('C:\\Plugins', 'C:\\Plugins')).toBe(true);
    expect(inside('C:\\Plugins\\hello', 'C:\\Plugins')).toBe(true);
    expect(inside('C:\\Plugins\\hello\\dsh\\index.mjs', 'C:\\Plugins')).toBe(true);
  });
  it('ignores the case of the path (a drive letter, or a folder spelled differently)', () => {
    expect(inside('c:\\plugins\\Hello', 'C:\\PLUGINS')).toBe(true);
    expect(inside('D:\\a\\sanctum\\plugins\\x', 'd:\\a\\sanctum\\plugins')).toBe(true);
    expect(samePath(win32, 'D:\\A\\Repo', 'd:\\a\\repo', true)).toBe(true);
  });
  it('accepts mixed separators and a trailing one', () => {
    expect(inside('C:/Plugins/hello', 'C:\\Plugins')).toBe(true);
    expect(inside('C:\\Plugins\\hello\\', 'C:/Plugins/')).toBe(true);
    expect(inside('C:\\Plugins\\a/b\\c.mjs', 'C:\\Plugins')).toBe(true);
  });
  it('is false for a sibling that merely shares the prefix', () => {
    expect(inside('C:\\Plugins2\\x', 'C:\\Plugins')).toBe(false);
    expect(inside('C:\\Plugins-evil', 'C:\\Plugins')).toBe(false);
  });
  it('is false for a path that climbs out, and for a parent of the root', () => {
    expect(inside('C:\\Plugins\\..\\evil', 'C:\\Plugins')).toBe(false);
    expect(inside('C:\\Plugins\\a\\..\\..\\b', 'C:\\Plugins')).toBe(false);
    expect(inside('C:\\', 'C:\\Plugins')).toBe(false);
    expect(inside('C:\\Plugins\\a\\..\\b', 'C:\\Plugins')).toBe(true); // collapses to a file still inside
  });
  it('is false across drives, where path.relative answers with an absolute path', () => {
    expect(inside('D:\\Plugins\\x', 'C:\\Plugins')).toBe(false);
    expect(inside('D:\\x', 'C:\\')).toBe(false);
  });
  it('handles UNC paths: the same share is inside, another share is not', () => {
    expect(inside('\\\\srv\\share\\p\\x', '\\\\srv\\share\\p')).toBe(true);
    expect(inside('\\\\srv\\other\\p\\x', '\\\\srv\\share\\p')).toBe(false);
    expect(inside('\\\\SRV\\Share\\p\\x', '\\\\srv\\share\\p')).toBe(true);
  });
  it('a folder whose name starts with two dots is not a climb', () => {
    expect(inside('C:\\Plugins\\..hidden\\x', 'C:\\Plugins')).toBe(true);
  });
});

describe('pathInside with path.posix', () => {
  it('is case sensitive unless told otherwise', () => {
    expect(pathInside(posix, '/srv/Plugins/x', '/srv/plugins', false)).toBe(false);
    expect(pathInside(posix, '/srv/Plugins/x', '/srv/plugins', true)).toBe(true);
    expect(pathInside(posix, '/srv/plugins/x', '/srv/plugins', false)).toBe(true);
    expect(pathInside(posix, '/srv/plugins2', '/srv/plugins', false)).toBe(false);
    expect(pathInside(posix, '/srv/plugins/../x', '/srv/plugins', false)).toBe(false);
  });
});

describe('samePath', () => {
  it('folds case and separators only where asked', () => {
    expect(samePath(win32, 'C:\\a\\B', 'c:/a/b/', true)).toBe(true);
    expect(samePath(win32, 'C:\\a\\B', 'C:\\a\\C', true)).toBe(false);
    expect(samePath(posix, '/a/B', '/a/b', false)).toBe(false);
    expect(samePath(posix, '/a/b/', '/a/b', false)).toBe(true);
  });
});

describe('containedRel: a manifest path stays inside the plugin folder, whichever OS reads it', () => {
  it('accepts plain relative paths in either separator style', () => {
    for (const rel of ['routes.mjs', 'dsh/index.mjs', 'dsh\\index.mjs', './help.md', 'a/b/../c.mjs', '..hidden/x']) expect(containedRel(rel), rel).toBe(true);
  });
  it('rejects absolute paths of both flavours, drive-relative paths and UNC', () => {
    for (const rel of ['/etc/passwd', 'C:\\x', 'c:/x', 'C:x', '\\\\srv\\share\\x', '\\rooted']) expect(containedRel(rel), rel).toBe(false);
  });
  it('rejects traversal with forward OR back slashes, on every platform', () => {
    for (const rel of ['..', '../x', '..\\x', 'a/../../b', 'a\\..\\..\\b', 'a/..\\..\\b', '.', '', 'a/..']) expect(containedRel(rel), rel).toBe(false);
  });
  it('rejects a NUL byte', () => {
    expect(containedRel('a\0b')).toBe(false);
  });
});

describe('expandTildeWith', () => {
  it('expands ~ and ~/x, and on Windows ~\\x too', () => {
    expect(expandTildeWith(win32, 'C:\\Users\\me', '~')).toBe('C:\\Users\\me');
    expect(expandTildeWith(win32, 'C:\\Users\\me', '~/p')).toBe('C:\\Users\\me\\p');
    expect(expandTildeWith(win32, 'C:\\Users\\me', '~\\p\\q')).toBe('C:\\Users\\me\\p\\q');
    expect(expandTildeWith(posix, '/home/me', '~/p')).toBe('/home/me/p');
    expect(expandTildeWith(posix, '/home/me', '~\\p')).toBe('~\\p'); // a backslash is an ordinary name character on posix
    expect(expandTildeWith(win32, 'C:\\Users\\me', '~other\\p')).toBe('~other\\p');
    expect(expandTildeWith(win32, 'C:\\Users\\me', 'D:\\x')).toBe('D:\\x');
  });
});

describe('realOrResolvedWith', () => {
  it('uses the real path when there is one, else the resolved absolute path', () => {
    const real = (p: string) => { if (p === 'C:\\link') return 'C:\\Target'; throw new Error('ENOENT'); };
    expect(realOrResolvedWith(win32, real, 'C:\\link')).toBe('C:\\Target');
    expect(realOrResolvedWith(win32, real, 'C:\\a\\..\\b')).toBe('C:\\b');
  });
});
