// The shelf's rules: what a name may be, what counts as inside shared/ (written and real), how an upload avoids replacing a
// file, and which files are recent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freeName, realInside, recentFiles, safeName, sameEntry, taken } from './shared-files.js';

const secret = (n: string) => /^\.env|\.db$|\.ya?ml$/i.test(n);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shelf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('safeName', () => {
  it('takes an ordinary name, trimmed, accents and spaces kept', () => {
    expect(safeName('  Garden sketch.png ', secret)).toBe('Garden sketch.png');
    expect(safeName('Café notes (draft).md', secret)).toBe('Café notes (draft).md');
  });
  it.each(['', '.', '..', '.hidden', 'a/b', 'a\\b', 'x\u0000y', 'tab\there', 'con:name', 'what?', 'trailing.', 'dots. .', 'x'.repeat(181), 'app.yaml', '.env'])(
    'refuses %j', (bad) => { expect(safeName(bad, secret)).toBeNull(); },
  );
  it('refuses what is not a string', () => { expect(safeName(undefined, secret)).toBeNull(); expect(safeName(42, secret)).toBeNull(); });
});

describe('freeName', () => {
  it('keeps a free name, and numbers a taken one before its extension', () => {
    expect(freeName(dir, 'a.png')).toBe('a.png');
    writeFileSync(join(dir, 'a.png'), 'x');
    expect(freeName(dir, 'a.png')).toBe('a (2).png');
    writeFileSync(join(dir, 'a (2).png'), 'x');
    expect(freeName(dir, 'a.png')).toBe('a (3).png');
    mkdirSync(join(dir, 'Notes'));
    expect(freeName(dir, 'Notes')).toBe('Notes (2)');
  });
});

describe('taken and sameEntry', () => {
  it('a dangling link is taken, so a new name steps past it instead of writing through it', () => {
    try { symlinkSync(join(dir, 'gone', 'away.txt'), join(dir, 'upload.txt')); } catch { return; } // (no link rights on this machine)
    expect(taken(join(dir, 'upload.txt'))).toBe(true);
    expect(freeName(dir, 'upload.txt')).toBe('upload (2).txt');
  });
  it('one entry is the same entry; two files are not', () => {
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    expect(sameEntry(join(dir, 'a.txt'), join(dir, 'a.txt'))).toBe(true);
    expect(sameEntry(join(dir, 'a.txt'), join(dir, 'b.txt'))).toBe(false);
    expect(sameEntry(join(dir, 'a.txt'), join(dir, 'none.txt'))).toBe(false);
  });
});

describe('realInside', () => {
  it('is true under the shelf, false beside it or above it', () => {
    const shelf = join(dir, 'shared');
    mkdirSync(shelf);
    expect(realInside(shelf, join(shelf, 'a', 'b.txt'))).toBe(true);
    expect(realInside(shelf, shelf)).toBe(true);
    expect(realInside(shelf, shelf, false)).toBe(false);
    expect(realInside(shelf, join(dir, 'shared-other', 'x'))).toBe(false);
    expect(realInside(shelf, join(shelf, '..', 'x'))).toBe(false);
  });
  it('a link inside the shelf that points out of it is outside', () => {
    const shelf = join(dir, 'shared');
    const outside = join(dir, 'outside');
    mkdirSync(shelf); mkdirSync(outside);
    try { symlinkSync(outside, join(shelf, 'door'), 'junction'); } catch { return; } // (no link rights on this machine)
    expect(realInside(shelf, join(shelf, 'door'))).toBe(false);
    expect(realInside(shelf, join(shelf, 'door', 'new.txt'))).toBe(false);
  });
});

describe('recentFiles', () => {
  it('lists files newest first, a couple of folders down, without hidden entries, build output or secrets', () => {
    const at = (p: string, minutesAgo: number) => { writeFileSync(p, 'x'); const t = new Date(Date.now() - minutesAgo * 60_000); utimesSync(p, t, t); };
    mkdirSync(join(dir, 'Writing', 'Drafts'), { recursive: true });
    mkdirSync(join(dir, 'Writing', 'Drafts', 'Old', 'Older'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, '.git'));
    at(join(dir, 'top.md'), 30);
    at(join(dir, 'Writing', 'chapter.md'), 5);
    at(join(dir, 'Writing', 'Drafts', 'draft.md'), 10);
    at(join(dir, 'Writing', 'Drafts', 'Old', 'Older', 'deep.md'), 1); // three folders down: past the depth
    at(join(dir, 'node_modules', 'pkg.js'), 0);
    at(join(dir, '.git', 'HEAD'), 0);
    at(join(dir, '.hidden.md'), 0);
    at(join(dir, 'house.db'), 0);
    expect(recentFiles([dir], secret).map(f => f.name)).toEqual(['chapter.md', 'draft.md', 'top.md']);
    expect(recentFiles([dir], secret, 2).map(f => f.name)).toEqual(['chapter.md', 'draft.md']);
  });
  it('a file under two given roots (the shelf is inside the home) is listed once', () => {
    mkdirSync(join(dir, 'shared'));
    writeFileSync(join(dir, 'shared', 'a.txt'), 'x');
    expect(recentFiles([join(dir, 'shared'), dir], secret).map(f => f.name)).toEqual(['a.txt']);
  });
});
