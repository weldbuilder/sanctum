// The list files reload when they change. On Windows a same-size write that keeps the mtime leaves the whole stat stamp
// (mtime, size, ino, ctime) unchanged, so a stat stamp alone serves a stale list. These tests give the sources a
// filesystem whose stat NEVER changes, which is that case on any platform: the content is what must be noticed.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return { ...real, statSync: (p: string, ...rest: any[]) => { const st = (real.statSync as any)(p, ...rest); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000, ino: 7, size: 6 }); } };
});

import { RuleSource } from './gate.js';
import { ExclusionSource } from './lanes.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-stamp-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('a stat stamp that never changes', () => {
  it('RuleSource still sees a same-size edit', () => {
    const p = join(tmp, 'words.txt');
    writeFileSync(p, 'Janie\n');
    const s = new RuleSource({ path: () => p, what: 'word list' });
    expect(s.get()!.rules[0].entry).toBe('Janie');
    writeFileSync(p, 'Jamie\n');
    expect(s.get()!.rules[0].entry).toBe('Jamie');
  });

  it('ExclusionSource still sees a same-size edit', () => {
    const p = join(tmp, 'exclusions.txt');
    writeFileSync(p, 'user:111\n');
    const s = new ExclusionSource({ path: () => p });
    expect([...s.get().users]).toEqual(['111']);
    writeFileSync(p, 'user:222\n');
    expect([...s.get().users]).toEqual(['222']);
  });

  it('an unchanged file is not parsed again (the cached value is the same object)', () => {
    const p = join(tmp, 'same.txt');
    writeFileSync(p, 'user:111\n');
    const s = new ExclusionSource({ path: () => p });
    expect(s.get()).toBe(s.get());
  });
});
